import AVFoundation
import AppKit
import WebKit

/// Video analysis: a batch job over whole files, separate from playback (see web/src/analysis.js).
/// One job = one analysis type on one video. Reports progress, then the result, as "analysis" events.
///
/// Blacks: every frame is decoded once (in order, as fast as the Mac can) and counts as black when at
/// least `pictureShare` of the picture is at or below `pixelLevel` (10% above video black, like ffmpeg's
/// blackdetect). Runs of black frames of `minSeconds` or more are kept, frame-exact. For each one the
/// sound level across it is measured: a commercial black is silent, a black inside a scene usually isn't.
///
/// Opening credits: see AnalysisCredits.swift.
final class AnalysisJob {
    let id: Int
    let path: String
    let type: String
    let settings: [String: Any]
    private let send: ([String: Any]) -> Void
    private var cancelled = false
    private let lock = NSLock()

    init(id: Int, path: String, type: String, settings: [String: Any], send: @escaping ([String: Any]) -> Void) {
        self.id = id; self.path = path; self.type = type; self.settings = settings; self.send = send
    }

    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    func post(_ msg: [String: Any]) {
        var m = msg; m["id"] = id
        DispatchQueue.main.async { [send] in send(m) }
    }
    func fail(_ message: String) -> NSError {
        NSError(domain: "analysis", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    func setting(_ key: String, _ fallback: Double) -> Double {
        (settings[key] as? NSNumber)?.doubleValue ?? fallback
    }

    func start(done: @escaping () -> Void) {
        // Below playback in priority: QC in the main window stays smooth while a queue runs.
        Task.detached(priority: .utility) { [self] in
            do {
                let result: [String: Any]
                switch self.type {
                case "blacks": result = try await self.runBlacks()
                case "credits": result = try await self.runCredits()
                default: throw self.fail("This analysis isn't available yet.")
                }
                if self.isCancelled { self.post(["type": "cancelled"]) } else { self.post(["type": "done", "result": result]) }
            } catch {
                if self.isCancelled { self.post(["type": "cancelled"]) }
                else { self.post(["type": "error", "message": error.localizedDescription]) }
            }
            DispatchQueue.main.async { done() }
        }
    }

    // MARK: - blacks

    private func runBlacks() async throws -> [String: Any] {
        let t0 = Date()
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let duration = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw fail("No video track found.") }
        let nominal = Double(try await track.load(.nominalFrameRate))
        let frameDur = nominal > 1 ? 1 / nominal : 1.0 / 24

        let share = setting("pictureShare", 0.98), minSeconds = setting("minSeconds", 0.25), silenceDb = setting("silenceDb", -50)
        // 8-bit video range: black is 16, white 235.
        let limit = UInt8(max(0, min(255, (16 + setting("pixelLevel", 0.10) * 219).rounded())))

        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ])
        out.alwaysCopiesSampleData = false
        guard reader.canAdd(out) else { throw fail("This video can't be decoded for analysis.") }
        reader.add(out)
        guard reader.startReading() else { throw reader.error ?? fail("Can't read the video.") }

        var frames: [(t: Double, black: Bool)] = []
        if duration.isFinite && duration > 0 { frames.reserveCapacity(Int(duration * max(24, nominal)) + 64) }
        var lastProgress = Date.distantPast
        while let sb = out.copyNextSampleBuffer() {
            if isCancelled { reader.cancelReading(); throw CancellationError() }
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
            let t = CMSampleBufferGetPresentationTimeStamp(sb).seconds
            guard t.isFinite else { continue }
            frames.append((t, AnalysisJob.isBlack(pb, limit: limit, share: share)))
            if Date().timeIntervalSince(lastProgress) > 0.25, duration > 0 {
                lastProgress = Date()
                post(["type": "progress", "p": max(0, min(0.99, t / duration))])
            }
        }
        if reader.status == .failed { throw reader.error ?? fail("Reading the video failed.") }
        if frames.isEmpty { throw fail("No picture could be read from this video.") }
        frames.sort { $0.t < $1.t }   // presentation order, whatever order the decoder handed them over in
        let end = duration.isFinite && duration > 0 ? duration : frames[frames.count - 1].t + frameDur

        // Runs of black frames: in = the first black frame, out = the first frame after it.
        var runs: [(tin: Double, tout: Double, n: Int)] = []
        var i = 0
        while i < frames.count {
            if !frames[i].black { i += 1; continue }
            var j = i
            while j + 1 < frames.count && frames[j + 1].black { j += 1 }
            let tin = frames[i].t
            let tout = j + 1 < frames.count ? frames[j + 1].t : max(frames[j].t + frameDur, end)
            if tout - tin >= minSeconds - 0.0005 { runs.append((tin, tout, j - i + 1)) }
            i = j + 1
        }

        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        var items: [[String: Any]] = []
        for r in runs {
            if isCancelled { throw CancellationError() }
            var item: [String: Any] = ["in": r3(r.tin), "out": r3(r.tout), "frames": r.n]
            var audio = "none"
            if !audioTracks.isEmpty {
                // The middle half of the black: the picture is "black" for the last frames of a fade out and
                // the first of a fade in, while the sound is still on its way down or up. A commercial black is
                // silent at its core; a black inside a scene has sound all the way through.
                let len = r.tout - r.tin
                let pad = len > frameDur * 4 ? len / 4 : min(frameDur, len / 4)
                if let db = audioLevel(asset: asset, tracks: audioTracks, from: r.tin + pad, to: r.tout - pad) {
                    item["level"] = (db * 10).rounded() / 10
                    audio = db <= silenceDb ? "silent" : "sound"
                }
            }
            item["audio"] = audio
            // What it most likely is: the head or tail of the file, a commercial black (silent), or a
            // black inside a scene (the sound carries on).
            if r.tin <= frames[0].t + frameDur * 0.5 { item["kind"] = "start" }
            else if r.tout >= end - frameDur * 1.5 { item["kind"] = "end" }
            else if audio == "sound" { continue }   // a black inside a scene (the sound carries on): not a break
            else { item["kind"] = "commercial" }
            items.append(item)
        }
        post(["type": "progress", "p": 1.0])
        return ["items": items, "frameCount": frames.count, "fps": r3(nominal), "seconds": (Date().timeIntervalSince(t0) * 10).rounded() / 10]
    }

    func r3(_ x: Double) -> Double { (x * 1000).rounded() / 1000 }

    /// Black when at most (1 - share) of the sampled pixels are brighter than `limit`. Samples about every
    /// 8th pixel each way (some 30,000 per HD frame), and stops at once on a frame that clearly isn't black.
    static func isBlack(_ pb: CVPixelBuffer, limit: UInt8, share: Double) -> Bool {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard CVPixelBufferGetPlaneCount(pb) >= 1, let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) else { return false }
        let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0)
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
        guard w > 0, h > 0 else { return false }
        let step = max(1, min(w, h) / 135)
        let cols = (w + step - 1) / step, rows = (h + step - 1) / step
        let allowed = Int(Double(cols * rows) * (1 - share))
        let p = base.assumingMemoryBound(to: UInt8.self)
        var bright = 0
        var y = 0
        while y < h {
            let row = p + y * stride
            var x = 0
            while x < w {
                if row[x] > limit {
                    bright += 1
                    if bright > allowed { return false }
                }
                x += step
            }
            y += step
        }
        return true
    }

    /// The loudest channel's RMS level in dBFS between two times, over every audio track (files with
    /// one mono track per channel included). nil if the sound can't be read.
    private func audioLevel(asset: AVAsset, tracks: [AVAssetTrack], from a: Double, to b: Double) -> Double? {
        guard b > a else { return nil }
        var loudest: Double? = nil
        for track in tracks {
            guard let reader = try? AVAssetReader(asset: asset) else { continue }
            let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            out.alwaysCopiesSampleData = false
            guard reader.canAdd(out) else { continue }
            reader.add(out)
            // A little extra on both sides: compressed sound comes in blocks; the exact range is cut below.
            let lead = 0.1
            reader.timeRange = CMTimeRange(start: CMTime(seconds: max(0, a - lead), preferredTimescale: 48000),
                                           duration: CMTime(seconds: (b - a) + lead * 2, preferredTimescale: 48000))
            guard reader.startReading() else { continue }
            var sumsq: [Double] = [], counts: [Int] = []
            var buf = [Float]()
            while let sb = out.copyNextSampleBuffer() {
                guard let block = CMSampleBufferGetDataBuffer(sb), let fd = CMSampleBufferGetFormatDescription(sb),
                      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee else { continue }
                let nch = max(1, Int(asbd.mChannelsPerFrame)), sr = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
                let floats = CMBlockBufferGetDataLength(block) / 4
                if floats == 0 { continue }
                if buf.count < floats { buf = [Float](repeating: 0, count: floats) }
                let status = buf.withUnsafeMutableBytes { raw in CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: floats * 4, destination: raw.baseAddress!) }
                if status != kCMBlockBufferNoErr { continue }
                if sumsq.count < nch { sumsq += [Double](repeating: 0, count: nch - sumsq.count); counts += [Int](repeating: 0, count: nch - counts.count) }
                let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds
                if !pts.isFinite { continue }
                let n = floats / nch
                // frames of this buffer that fall inside [a, b)
                let first = max(0, Int(((a - pts) * sr).rounded(.up))), last = min(n, Int(((b - pts) * sr).rounded(.down)))
                if last <= first { continue }
                buf.withUnsafeBufferPointer { p in
                    for f in first..<last {
                        let o = f * nch
                        for c in 0..<nch { let x = Double(p[o + c]); sumsq[c] += x * x }
                    }
                }
                for c in 0..<nch { counts[c] += last - first }
            }
            for c in 0..<sumsq.count where counts[c] > 0 {
                let rms = (sumsq[c] / Double(counts[c])).squareRoot()
                let db = rms > 0 ? max(-120, 20 * log10(rms)) : -120
                loudest = max(loudest ?? -120, db)
            }
        }
        return loudest
    }
}

/// Results files: "Subtitle QC Data/<video file name>.analysis.json" next to the videos, so they travel
/// with the folder and any Mac (or the web version) can read them.
enum AnalysisFiles {
    static let dirName = "Subtitle QC Data"
    static let suffix = ".analysis.json"

    static func readAll(folder: String) -> [String] {
        let dir = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(dirName, isDirectory: true)
        guard let items = try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles]) else { return [] }
        var out: [String] = []
        for u in items where u.lastPathComponent.lowercased().hasSuffix(suffix) {
            let size = (try? u.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
            if size > 0, size < 50_000_000, let s = try? String(contentsOf: u, encoding: .utf8) { out.append(s) }
        }
        return out
    }

    /// Returns nil when written, or the reason it couldn't be.
    static func write(folder: String, videoName: String, json: String) -> String? {
        let name = (videoName as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != ".." else { return "Bad file name." }
        let dir = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(dirName, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try json.write(to: dir.appendingPathComponent(name + suffix), atomically: true, encoding: .utf8)
            return nil
        } catch {
            Log.write("error", "Analysis results not saved for \(name): \(error.localizedDescription)")
            return error.localizedDescription
        }
    }
}

/// The Video Analysis window (Window ▸ Video Analysis): its own window with the same page in
/// "analysis" mode, so a queue can run while QC carries on in the main window.
final class AnalysisWindow: NSObject, NSWindowDelegate {
    static let shared = AnalysisWindow()
    private(set) var window: NSWindow?
    private(set) var webView: DropWebView?
    private var bridge: Bridge?
    private let navGuard = NavigationGuard()
    private var running = false
    private var activity: NSObjectProtocol?

    func show() {
        if window == nil { build() } else { bridge?.emit("analysisShow", [:]) }
        window?.makeKeyAndOrderFront(nil)
    }

    private func build() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1512, height: 900)
        let size = NSSize(width: min(1080, screen.width * 0.9), height: min(660, screen.height * 0.9))
        let rect = NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
        let win = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        win.title = "Video Analysis"
        win.appearance = NSAppearance(named: .darkAqua)
        win.backgroundColor = MainView.panelColor
        win.contentMinSize = NSSize(width: 820, height: 420)
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.setFrameAutosaveName("SubtitleQCAnalysisWindow")

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        let b = Bridge(view: nil)
        config.userContentController.addScriptMessageHandler(b, contentWorld: .page, name: "native")
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__nativeStore = \(Settings.allJSON()); window.__analysisWindow = true;",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = DropWebView(frame: NSRect(origin: .zero, size: rect.size), configuration: config)
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")
        web.navigationDelegate = navGuard
        web.uiDelegate = navGuard
        #if SELFTEST
        if #available(macOS 13.3, *) { web.isInspectable = true }   // test builds only
        #endif
        web.onDrop = { [weak b] items in
            for it in items {
                guard let p = it["path"] as? String else { continue }
                if (it["isDir"] as? Bool) == true { Access.allowFolder(p) } else { Access.allowFile(p) }
            }
            b?.emit("drop", ["items": items])
        }
        b.webView = web
        win.contentView = web
        bridge = b; webView = web; window = win

        guard let url = Bundle.main.url(forResource: "index", withExtension: "html") else {
            Log.write("error", "index.html missing from the app bundle"); return
        }
        MainView.blockNetwork(web) { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        win.makeFirstResponder(web)
    }

    func reload() { webView?.reload() }

    /// From the page: a queue started or finished, and what the window's title should say.
    func setBusy(running: Bool, keepAwake: Bool, title: String) {
        self.running = running
        window?.title = title.isEmpty ? "Video Analysis" : title
        if let a = activity { ProcessInfo.processInfo.endActivity(a); activity = nil }
        if running {
            // Never slowed down in the background; with "keep awake", the Mac doesn't go to sleep either
            // (the display still can).
            let options: ProcessInfo.ActivityOptions = keepAwake ? [.userInitiated] : [.userInitiatedAllowingIdleSystemSleep]
            activity = ProcessInfo.processInfo.beginActivity(options: options, reason: "Analysing videos")
        }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard running else { return true }
        let alert = NSAlert()
        alert.messageText = "The analysis is still running."
        alert.informativeText = "Closing the window stops it. Videos that are already finished keep their results."
        alert.addButton(withTitle: "Keep Running")
        alert.addButton(withTitle: "Stop and Close")
        alert.beginSheetModal(for: sender) { [weak self] r in
            guard r == .alertSecondButtonReturn else { return }
            self?.bridge?.emit("analysisStop", [:])
            self?.setBusy(running: false, keepAwake: false, title: "")
            sender.close()
        }
        return false
    }
}
