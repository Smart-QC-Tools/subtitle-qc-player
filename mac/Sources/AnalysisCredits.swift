import AVFoundation
import Vision

/// Opening credits (see IDEAS.md). One pass from the start of the video:
///  1. Coarse scan, one frame every `coarseStepSeconds`, with Vision's fast text reader. Text on a frame is
///     grouped into blocks (lines that sit together); a block seen on consecutive frames in the same place is
///     one card. Text that stays for more than `staticMaxSeconds` (a logo, a burnt-in timecode) isn't a card.
///  2. Stops `afterDirectedSeconds` after a "Directed by" card, or at `searchMinutes`.
///  3. Each card is read once more, carefully, to get its text; it is then a credit (credit vocabulary, or a
///     name next to other credits), a main title (large, centred), or other on-screen text (a caption).
///  4. Every card's in and out are found to the frame by bisection between the coarse frames.
///  Credits less than `joinGapSeconds` apart form one run. Confirmed = a "Directed by" card was found.
extension AnalysisJob {
    final class TextCard {
        var box: CGRect                 // top-left origin, 0…1 of the picture
        var lines: [CGRect]
        var first: Double, last: Double // frames where it was seen
        var before: Double?             // the coarse frame before (without it), nil = it was there from the start
        var after: Double?              // the coarse frame after (without it), nil = still there at the end of the scan
        var fastText: [String] = []
        var text = "", lineTexts: [String] = [], kind = "text"
        var tin = 0.0, tout = 0.0
        init(box: CGRect, lines: [CGRect], at: Double, before: Double?) { self.box = box; self.lines = lines; first = at; last = at; self.before = before }
    }
    struct TextBlock { var box: CGRect; var lines: [CGRect]; var text: String; var lineH: CGFloat }

    func runCredits() async throws -> [String: Any] {
        let t0 = Date()
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let duration = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw fail("No video track found.") }
        let nominal = Double(try await track.load(.nominalFrameRate))
        let fd = nominal > 1 ? 1 / nominal : 1.0 / 24
        guard duration.isFinite, duration > 0 else { throw fail("The length of this video can't be read.") }

        let step = max(0.25, setting("coarseStepSeconds", 1))
        let joinGap = setting("joinGapSeconds", 30), afterDirected = setting("afterDirectedSeconds", 60)
        let staticMax = setting("staticMaxSeconds", 20), minSeconds = setting("minCardSeconds", 0.5)
        var scanEnd = min(duration, setting("searchMinutes", 20) * 60)
        let fullEnd = scanEnd

        // Coarse frames: the nearest frame at or a little after each time (quick on long-GOP files).
        let coarse = AVAssetImageGenerator(asset: asset)
        coarse.appliesPreferredTrackTransform = true
        coarse.maximumSize = CGSize(width: 1280, height: 720)
        coarse.requestedTimeToleranceBefore = .zero
        coarse.requestedTimeToleranceAfter = CMTime(seconds: step * 0.4, preferredTimescale: 600)
        // Exact frames, for the in and out points.
        let exact = AVAssetImageGenerator(asset: asset)
        exact.appliesPreferredTrackTransform = true
        exact.maximumSize = CGSize(width: 1280, height: 720)
        exact.requestedTimeToleranceBefore = .zero
        exact.requestedTimeToleranceAfter = .zero
        // The careful read of each card: full size.
        let full = AVAssetImageGenerator(asset: asset)
        full.appliesPreferredTrackTransform = true
        full.requestedTimeToleranceBefore = .zero
        full.requestedTimeToleranceAfter = .zero

        var active: [TextCard] = [], cards: [TextCard] = []
        var t = 0.0, prevAt: Double? = nil, samples = 0, directedSeen = false
        var lastProgress = Date.distantPast
        while t < scanEnd {
            if isCancelled { throw CancellationError() }
            guard let got = try? await coarse.image(at: CMTime(seconds: t, preferredTimescale: 600)) else { t += step; continue }
            let img = got.image
            var at = got.actualTime.seconds
            if !at.isFinite { at = t }
            if let p = prevAt, at <= p + fd * 0.5 { t += step; continue }   // the same frame again
            samples += 1
            let blocks = AnalysisJob.textBlocks(img, level: .fast)
            var still: [TextCard] = []
            var used = Set<Int>()
            for c in active {
                if let k = blocks.indices.first(where: { !used.contains($0) && AnalysisJob.sameCard(c.box, blocks[$0].box) }) {
                    used.insert(k)
                    c.last = at; c.fastText.append(blocks[k].text)
                    c.box = blocks[k].box; c.lines = blocks[k].lines
                    still.append(c)
                } else { c.after = at; cards.append(c) }
            }
            for k in blocks.indices where !used.contains(k) {
                let c = TextCard(box: blocks[k].box, lines: blocks[k].lines, at: at, before: prevAt)
                c.fastText.append(blocks[k].text)
                still.append(c)
                if !directedSeen && AnalysisJob.isDirectedBy(blocks[k].text) {
                    // "Directed by" ends the credits: look a little further for stragglers, then stop.
                    directedSeen = true
                    scanEnd = min(fullEnd, at + afterDirected)
                }
            }
            active = still
            prevAt = at
            if Date().timeIntervalSince(lastProgress) > 0.25 {
                lastProgress = Date()
                post(["type": "progress", "p": max(0, min(0.8, at / scanEnd * 0.8))])
            }
            t = at + step
        }
        cards.append(contentsOf: active)   // still on screen where the scan stopped (after = nil)
        // Logos, burnt-in timecode and the like stay for much longer than a card.
        cards = cards.filter { $0.last - $0.first <= staticMax }

        // Read each card carefully, in the middle of where it was seen.
        for (i, c) in cards.enumerated() {
            if isCancelled { throw CancellationError() }
            let mid = AnalysisJob.frameTime(((c.first + c.last) / 2 / fd).rounded(.down), fd)
            if let got = try? await full.image(at: CMTime(seconds: mid + fd / 2, preferredTimescale: 60000)) {
                c.lineTexts = AnalysisJob.readText(got.image, in: c.box.insetBy(dx: -0.03, dy: -0.03))
            }
            if c.lineTexts.isEmpty { c.lineTexts = c.fastText.max(by: { $0.count < $1.count })?.components(separatedBy: "\n") ?? [] }
            c.text = c.lineTexts.joined(separator: " / ")
            post(["type": "progress", "p": 0.8 + 0.05 * Double(i + 1) / Double(max(1, cards.count))])
        }
        cards = cards.filter { $0.text.filter { $0.isLetter }.count >= 2 }
        AnalysisJob.classify(cards, joinGap: joinGap)

        // In and out to the frame: the first frame with the card and the first one after it.
        for (i, c) in cards.enumerated() {
            if isCancelled { throw CancellationError() }
            let present: (Double) async -> Bool = { n in
                guard let got = try? await exact.image(at: CMTime(seconds: AnalysisJob.frameTime(n, fd) + fd / 2, preferredTimescale: 60000)) else { return false }
                return AnalysisJob.hasText(got.image, in: c.box.insetBy(dx: -0.02, dy: -0.02))
            }
            var hi = (c.first / fd).rounded(), lo = c.before.map { ($0 / fd).rounded() } ?? -1
            while hi - lo > 1 { let mid = ((lo + hi) / 2).rounded(.down); if await present(mid) { hi = mid } else { lo = mid } }
            c.tin = AnalysisJob.frameTime(hi, fd)
            lo = (c.last / fd).rounded()
            var hiOut = c.after.map { ($0 / fd).rounded() } ?? ((scanEnd / fd).rounded(.down) + 1)
            while hiOut - lo > 1 { let mid = ((lo + hiOut) / 2).rounded(.down); if await present(mid) { lo = mid } else { hiOut = mid } }
            c.tout = min(duration, AnalysisJob.frameTime(hiOut, fd))
            post(["type": "progress", "p": 0.85 + 0.14 * Double(i + 1) / Double(max(1, cards.count))])
        }
        // Shorter than half a second: a misread, not a card.
        cards = cards.filter { $0.tout - $0.tin >= minSeconds }
        cards.sort { $0.tin < $1.tin }

        let credits = cards.filter { $0.kind == "credit" }
        var runs: [(tin: Double, tout: Double, n: Int)] = []
        for c in credits {
            if let last = runs.last, c.tin - last.tout <= joinGap { runs[runs.count - 1].tout = max(last.tout, c.tout); runs[runs.count - 1].n += 1 }
            else { runs.append((c.tin, c.tout, 1)) }
        }
        let directed = credits.last(where: { AnalysisJob.isDirectedBy($0.text) })
        let box = { (r: CGRect) -> [Double] in [self.r3(Double(r.minX)), self.r3(Double(r.minY)), self.r3(Double(r.width)), self.r3(Double(r.height))] }
        post(["type": "progress", "p": 1.0])
        return [
            "confirmed": directed != nil,
            "directedBy": directed.map { ["in": r3($0.tin), "out": r3($0.tout), "text": $0.text] as [String: Any] } ?? NSNull(),
            "runs": runs.map { ["in": r3($0.tin), "out": r3($0.tout), "cards": $0.n] },
            "cards": cards.map { c in [
                "in": r3(c.tin), "out": r3(c.tout), "text": c.text, "lines": c.lineTexts, "kind": c.kind,
                "box": box(c.box), "boxes": c.lines.map(box),
            ] as [String: Any] },
            "scannedTo": r3(scanEnd), "samples": samples, "fps": r3(nominal),
            "seconds": (Date().timeIntervalSince(t0) * 10).rounded() / 10,
        ]
    }

    static func frameTime(_ n: Double, _ fd: Double) -> Double { max(0, n) * fd }

    /// At least one real-looking word: three letters or more with a vowel (any letter outside the Latin
    /// alphabets counts, so other scripts aren't thrown out).
    static func hasWord(_ s: String) -> Bool {
        let vowels = Set("aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ")
        var run = 0, vowel = false
        for ch in s.lowercased() + " " {
            if ch.isLetter {
                run += 1
                if vowels.contains(ch) || (ch.unicodeScalars.first?.value ?? 0) > 0x24F { vowel = true }
            } else {
                if run >= 3 && vowel { return true }
                run = 0; vowel = false
            }
        }
        return false
    }

    // MARK: - reading text

    private static func observations(_ img: CGImage, level: VNRequestTextRecognitionLevel, roi: CGRect? = nil) -> [VNRecognizedTextObservation] {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = level
        req.usesLanguageCorrection = false   // names
        if let r = roi {
            // Vision's region: bottom-left origin; ours: top-left.
            let v = CGRect(x: r.minX, y: 1 - r.maxY, width: r.width, height: r.height).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
            if v.isNull || v.width <= 0 || v.height <= 0 { return [] }
            req.regionOfInterest = v
        }
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        do { try handler.perform([req]) } catch { return [] }
        return req.results ?? []
    }

    /// The text on a frame, grouped into blocks of lines that belong together (a role and a name, say).
    static func textBlocks(_ img: CGImage, level: VNRequestTextRecognitionLevel) -> [TextBlock] {
        let tc = try? NSRegularExpression(pattern: #"^\s*\d{1,2}[:;.]\d{2}[:;.]\d{2}[:;.]\d{2}\s*$"#)
        var lines: [(box: CGRect, text: String)] = []
        for o in observations(img, level: level) {
            guard let cand = o.topCandidates(1).first, cand.confidence >= 0.3 else { continue }
            let s = cand.string.trimmingCharacters(in: .whitespaces)
            if !AnalysisJob.hasWord(s) { continue }   // pattern noise read as "rr", "TfT" …
            if let tc = tc, tc.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil { continue }
            let b = o.boundingBox
            let box = CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height)
            if box.height < 0.018 { continue }   // too small for a credit (a logo's small print …)
            lines.append((box, s))
        }
        lines.sort { $0.box.minY < $1.box.minY }
        var blocks: [TextBlock] = []
        for l in lines {
            let k = blocks.lastIndex { b in
                let lh = max(b.lineH, l.box.height)
                let gap = l.box.minY - b.box.maxY
                let sameRow = min(b.box.maxY, l.box.maxY) - max(b.box.minY, l.box.minY) > lh * 0.5
                let hGap = max(b.box.minX, l.box.minX) - min(b.box.maxX, l.box.maxX)
                if sameRow { return hGap < 0.08 }
                let aligned = hGap < 0 || abs(b.box.minX - l.box.minX) < 0.04 || abs(b.box.maxX - l.box.maxX) < 0.04 || abs(b.box.midX - l.box.midX) < 0.04
                return gap > -lh * 0.5 && gap < lh * 1.6 && aligned
            }
            if let k = k {
                blocks[k].box = blocks[k].box.union(l.box)
                blocks[k].lines.append(l.box)
                blocks[k].text += "\n" + l.text
                blocks[k].lineH = max(blocks[k].lineH, l.box.height)
            } else {
                blocks.append(TextBlock(box: l.box, lines: [l.box], text: l.text, lineH: l.box.height))
            }
        }
        return blocks
    }

    /// The careful read of one card: its lines, top to bottom.
    static func readText(_ img: CGImage, in box: CGRect) -> [String] {
        observations(img, level: .accurate, roi: box)
            .compactMap { o -> (CGFloat, String)? in
                guard let c = o.topCandidates(1).first, c.confidence >= 0.3 else { return nil }
                let s = c.string.trimmingCharacters(in: .whitespaces)
                return s.isEmpty ? nil : (o.boundingBox.midY, s)
            }
            .sorted { $0.0 > $1.0 }
            .map { $0.1 }
    }

    /// Is there (still) text where the card is?
    static func hasText(_ img: CGImage, in box: CGRect) -> Bool {
        observations(img, level: .fast, roi: box).contains { o in
            guard let c = o.topCandidates(1).first else { return false }
            return c.confidence >= 0.3 && c.string.filter { $0.isLetter }.count >= 2
        }
    }

    static func sameCard(_ a: CGRect, _ b: CGRect) -> Bool {
        let i = a.intersection(b)
        if i.isNull { return false }
        let inter = i.width * i.height, uni = a.width * a.height + b.width * b.height - inter
        return uni > 0 && inter / uni > 0.3
    }

    // MARK: - what a card is

    private static let roles = [
        "starring", "also starring", "guest starring", "special guest star", "special guest stars", "special guest starring",
        "co-starring", "featuring", "introducing", "casting", "casting by", "music", "music by", "original music by", "original music",
        "composer", "score by", "music supervisor", "edited by", "editor", "film editor", "editors",
        "production designer", "production design by", "art director", "director of photography", "cinematography by",
        "photographed by", "costume designer", "costumes by", "costume design by", "produced by", "producer", "producers",
        "co-producer", "co-producers", "executive producer", "executive producers", "co-executive producer",
        "co-executive producers", "supervising producer", "supervising producers", "consulting producer", "consulting producers",
        "associate producer", "associate producers", "line producer", "created by", "developed by", "developed for television by",
        "based on", "based on the novel by", "based on the book by", "written by", "teleplay by", "story by", "screenplay by",
        "written and directed by", "written & directed by", "directed by", "director", "visual effects", "visual effects supervisor",
        "stunt coordinator", "main title design", "title design", "makeup", "hair", "sound", "sound mixer", "re-recording mixer",
    ]
    private static let wholeLineOnly: Set<String> = ["with", "and", "and with", "director", "makeup", "hair", "sound", "music", "casting"]
    private static let directedRx = try? NSRegularExpression(pattern: #"\b(directed\s+by|r[ée]alis[ée]e?\s+par|regie|dirigid[oa]\s+por|dirett[oa]\s+da|regia\s+di|realizad[oa]\s+por|regisseur)\b|^director$"#, options: [.caseInsensitive])
    private static let timeWords: Set<String> = ["earlier", "later", "ago", "year", "years", "month", "months", "week", "weeks", "day", "days",
        "hour", "hours", "minute", "minutes", "morning", "night", "evening", "afternoon", "today", "tonight", "yesterday", "tomorrow",
        "present", "meanwhile", "previously", "part", "chapter", "episode", "act", "end", "am", "pm", "a.m.", "p.m."]

    static func isDirectedBy(_ text: String) -> Bool {
        for line in text.components(separatedBy: CharacterSet(charactersIn: "\n/")) {
            let s = line.trimmingCharacters(in: .whitespaces)
            if let rx = directedRx, rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil { return true }
        }
        return false
    }
    static func hasRole(_ lines: [String]) -> Bool {
        for line in lines {
            let s = line.lowercased().trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: ":.,")))
            for r in roles {
                if s == r { return true }
                if !wholeLineOnly.contains(r), s.hasPrefix(r + " ") { return true }
            }
        }
        return false
    }
    /// Names: a few words of letters, no digits, nothing that says when or where.
    static func looksLikeNames(_ lines: [String]) -> Bool {
        guard !lines.isEmpty, lines.count <= 4 else { return false }
        for line in lines {
            if line.contains(where: { $0.isNumber }) { return false }
            let words = line.split(whereSeparator: { $0 == " " || $0 == "," || $0 == "&" }).map(String.init)
            if words.isEmpty || words.count > 8 { return false }
            for w in words {
                let lw = w.lowercased()
                if timeWords.contains(lw) { return false }
                if !w.allSatisfy({ $0.isLetter || "'’.-".contains($0) }) { return false }
            }
            if !words.contains(where: { $0.first?.isUppercase == true }) { return false }
        }
        return true
    }
    /// credit | title | text. Credits: credit vocabulary, or names within joinGap of other credits.
    static func classify(_ cards: [TextCard], joinGap: Double) {
        for c in cards {
            if isDirectedBy(c.text) || hasRole(c.lineTexts) { c.kind = "credit"; continue }
            let tallest = c.lines.map { $0.height }.max() ?? c.box.height
            if abs(c.box.midX - 0.5) < 0.1 && tallest >= 0.06 { c.kind = "title"; continue }
            c.kind = looksLikeNames(c.lineTexts) ? "name" : "text"
        }
        // names next to credits are credits too ("ELENA MARCH" on its own)
        var changed = true
        while changed {
            changed = false
            for c in cards where c.kind == "name" {
                if cards.contains(where: { $0.kind == "credit" && min(abs($0.first - c.last), abs(c.first - $0.last)) <= joinGap }) { c.kind = "credit"; changed = true }
            }
        }
        for c in cards where c.kind == "name" { c.kind = "text" }
    }
}
