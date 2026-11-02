import AVFoundation

/// Builds the waveform for the timeline natively (much faster than in the page): per 10 ms,
/// the peak and RMS of the chosen audio channels. Sends the same messages as the page's own
/// background worker: info, peaks, progress, done, error.
final class WaveformJob {
    static let rate = 100.0   // buckets per second (PEAK_RATE in the page)

    let id: Int
    let path: String
    let prefs: [Int: [Int]]
    private let send: ([String: Any]) -> Void
    private var cancelled = false
    private let lock = NSLock()

    init(id: Int, path: String, prefs: [Int: [Int]], send: @escaping ([String: Any]) -> Void) {
        self.id = id; self.path = path; self.prefs = prefs; self.send = send
    }

    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    private var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

    private func post(_ msg: [String: Any]) {
        var m = msg; m["id"] = id
        DispatchQueue.main.async { [send] in send(m) }
    }

    func start(done: @escaping () -> Void) {
        // Lower priority than playback: on a busy or network drive the picture and sound come first.
        Task.detached(priority: .utility) { [self] in
            do { try await self.run() }
            catch { if !self.isCancelled { self.post(["type": "error", "message": error.localizedDescription]) } }
            DispatchQueue.main.async { done() }
        }
    }

    private func fourcc(_ code: FourCharCode) -> String {
        let bytes = [UInt8((code >> 24) & 0xff), UInt8((code >> 16) & 0xff), UInt8((code >> 8) & 0xff), UInt8(code & 0xff)]
        return String(bytes: bytes, encoding: .ascii)?.trimmingCharacters(in: .whitespaces) ?? "?"
    }

    private func run() async throws {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let duration = try await asset.load(.duration).seconds
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        if tracks.isEmpty { throw NSError(domain: "wave", code: 1, userInfo: [NSLocalizedDescriptionKey: "No audio track found."]) }

        // Global channel list across all audio tracks (track order, then channel order).
        var channels: [(track: Int, ch: Int)] = []
        var codecs: [String] = []
        for (ti, t) in tracks.enumerated() {
            let fds = try await t.load(.formatDescriptions)
            var n = 1
            if let fd = fds.first {
                if let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee { n = max(1, Int(asbd.mChannelsPerFrame)) }
                codecs.append(fourcc(CMFormatDescriptionGetMediaSubType(fd)))
            }
            for c in 0..<n { channels.append((ti, c)) }
        }
        let total = channels.count
        var picks = (prefs[total] ?? []).filter { $0 >= 0 && $0 < total }
        if picks.isEmpty { picks = total == 1 ? [0] : total == 2 ? [0, 1] : [2] }
        post(["type": "info", "duration": duration.finiteOr(0), "total": total, "tracks": tracks.count, "sel": picks, "codec": codecs.joined(separator: ", ")])

        let count = Int((duration * WaveformJob.rate).rounded(.up)) + 1
        var peaks = [Float](repeating: 0, count: count)
        var sumsq = [Double](repeating: 0, count: count)
        var counts = [UInt32](repeating: 0, count: count)
        var pendStart = Int.max, pendEnd = -1
        var lastPost = Date.distantPast, lastProgress = Date.distantPast

        func flush(force: Bool) {
            if !force && Date().timeIntervalSince(lastPost) < 0.4 { return }
            lastPost = Date()
            guard pendEnd >= pendStart else { return }
            let a = pendStart, b = pendEnd + 1
            var rms = [Float](repeating: 0, count: b - a)
            for i in a..<b { rms[i - a] = counts[i] > 0 ? Float((sumsq[i] / Double(counts[i])).squareRoot()) : 0 }
            let pk = Array(peaks[a..<b])
            let pData = pk.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
            let rData = rms.withUnsafeBufferPointer { Data(buffer: $0) }.base64EncodedString()
            post(["type": "peaks", "start": a, "data": pData, "rms": rData])
            pendStart = Int.max; pendEnd = -1
        }

        // Group the picked channels per track; read all those tracks in a single pass over the file
        // (one reader, outputs taken in turn), so a file with many mono tracks isn't read many times.
        var byTrack: [Int: [Int]] = [:]
        for g in picks { byTrack[channels[g].track, default: []].append(channels[g].ch) }
        let order = byTrack.keys.sorted()
        let reader = try AVAssetReader(asset: asset)
        var outs: [(out: AVAssetReaderTrackOutput, chans: [Int], pts: Double, done: Bool)] = []
        for ti in order {
            let out = AVAssetReaderTrackOutput(track: tracks[ti], outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            out.alwaysCopiesSampleData = false
            reader.add(out)
            outs.append((out, byTrack[ti]!, 0, false))
        }
        guard reader.startReading() else { throw reader.error ?? NSError(domain: "wave", code: 2, userInfo: [NSLocalizedDescriptionKey: "Can't read the audio."]) }
        var buf = [Float]()
        while true {
            if isCancelled { reader.cancelReading(); return }
            // the output that is furthest behind goes next, so the tracks advance together
            guard let k = outs.indices.filter({ !outs[$0].done }).min(by: { outs[$0].pts < outs[$1].pts }) else { break }
            guard let sb = outs[k].out.copyNextSampleBuffer() else { outs[k].done = true; continue }
            let chans = outs[k].chans
            guard let block = CMSampleBufferGetDataBuffer(sb), let fd = CMSampleBufferGetFormatDescription(sb),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fd)?.pointee else { continue }
            let nch = max(1, Int(asbd.mChannelsPerFrame)), sr = asbd.mSampleRate > 0 ? asbd.mSampleRate : 48000
            let len = CMBlockBufferGetDataLength(block)
            let floats = len / 4
            if buf.count < floats { buf = [Float](repeating: 0, count: floats) }
            buf.withUnsafeMutableBytes { raw in _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: floats * 4, destination: raw.baseAddress!) }
            let pts = CMSampleBufferGetPresentationTimeStamp(sb).seconds.finiteOr(0)
            let frames = floats / nch
            outs[k].pts = pts + Double(frames) / sr
            let base = pts * WaveformJob.rate, step = WaveformJob.rate / sr
            buf.withUnsafeBufferPointer { p in
                for f in 0..<frames {
                    let i = Int(base + Double(f) * step)
                    if i < 0 || i >= count { continue }
                    let o = f * nch
                    for c in chans where c < nch {
                        let x = p[o + c], a = abs(x)
                        if a > peaks[i] { peaks[i] = a }
                        sumsq[i] += Double(x) * Double(x); counts[i] += 1
                    }
                    if i < pendStart { pendStart = i }
                    if i > pendEnd { pendEnd = i }
                }
            }
            flush(force: false)
            if Date().timeIntervalSince(lastProgress) > 0.25, duration > 0 {
                lastProgress = Date()
                let behind = outs.filter { !$0.done }.map { $0.pts }.min() ?? duration
                post(["type": "progress", "p": min(1, behind / duration)])
            }
        }
        if reader.status == .failed { throw reader.error ?? NSError(domain: "wave", code: 3, userInfo: [NSLocalizedDescriptionKey: "Reading the audio failed."]) }
        flush(force: true)
        post(["type": "done"])
    }
}
