import AVFoundation
import AppKit

/// Plays the selected video with AVFoundation (ProRes, H.264, HEVC …) and keeps the page's
/// stand-in <video> element up to date: metadata, time, play/pause, seeks.
final class VideoController: NSObject {
    let player = AVPlayer()
    let layer = AVPlayerLayer()
    weak var bridge: Bridge?

    private var item: AVPlayerItem?
    private var loadId = 0
    private var statusObs: NSKeyValueObservation?
    private var rateObs: NSKeyValueObservation?
    private var timeObs: Any?
    private var endObs: NSObjectProtocol?
    private var seekBusy = false
    private var pendingSeek: Double?
    private var lastPaused = true
    #if SELFTEST
    let frameCounter = FrameCounter()
    func testStats() -> [String: Any] {
        var d: [String: Any] = ["t": now, "rate": Double(player.rate), "timeControl": player.timeControlStatus.rawValue,
                                "waiting": player.reasonForWaitingToPlay?.rawValue ?? "", "status": item?.status.rawValue ?? -1,
                                "errorLog": item?.errorLog()?.events.count ?? 0]
        if let e = item?.errorLog()?.events.last { d["lastError"] = "\(e.errorStatusCode) \(e.errorComment ?? "")" }
        if let a = item?.accessLog()?.events.last { d["dropped"] = a.numberOfDroppedVideoFrames; d["stalls"] = a.numberOfStalls }
        d["delivered"] = frameCounter.stats()
        return d
    }
    #endif

    override init() {
        super.init()
        layer.player = player
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = NSColor.black.cgColor
        player.actionAtItemEnd = .pause
        player.automaticallyWaitsToMinimizeStalling = false
        rateObs = player.observe(\.rate, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async { self?.rateChanged() }
        }
        timeObs = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            guard let self = self, self.player.rate != 0, !self.seekBusy else { return }
            self.bridge?.emit("videoTime", ["t": max(0, t.seconds.finiteOr(0)), "rate": Double(self.player.rate)])
        }
    }

    private var now: Double { max(0, player.currentTime().seconds.finiteOr(0)) }

    func load(path: String, id: Int) {
        unload()
        loadId = id
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.isReadableFile(atPath: path) else {
            bridge?.emit("videoError", ["id": id, "message": "The file can't be read."]); return
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let it = AVPlayerItem(asset: asset)
        it.audioTimePitchAlgorithm = .timeDomain
        item = it
        #if SELFTEST
        frameCounter.attach(it)
        #endif
        statusObs = it.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async { self?.statusChanged(it, asset: asset, id: id) }
        }
        endObs = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: it, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            self.lastPaused = true
            self.bridge?.emit("videoState", ["paused": true, "ended": true, "t": self.now, "rate": 0])
        }
        player.replaceCurrentItem(with: it)
        Log.write("info", "Opened video \(url.lastPathComponent)")
    }

    private func statusChanged(_ it: AVPlayerItem, asset: AVURLAsset, id: Int) {
        guard id == loadId, it === item else { return }
        switch it.status {
        case .readyToPlay:
            let duration = it.duration.seconds.finiteOr(0), canReverse = it.canPlayReverse, canFastReverse = it.canPlayFastReverse
            Task {
                var size = CGSize.zero
                if let tracks = try? await asset.loadTracks(withMediaType: .video), let track = tracks.first,
                   let geo = try? await track.load(.naturalSize, .preferredTransform) {
                    let s = geo.0.applying(geo.1); size = CGSize(width: abs(s.width), height: abs(s.height))
                }
                let w = Double(size.width), h = Double(size.height)
                DispatchQueue.main.async { [weak self] in
                    guard let self = self, id == self.loadId else { return }
                    self.bridge?.emit("videoMeta", ["id": id, "duration": duration, "width": w, "height": h, "canReverse": canReverse, "canFastReverse": canFastReverse])
                }
            }
        case .failed:
            let msg = it.error?.localizedDescription ?? "The file could not be played."
            Log.write("error", "Video failed: \(msg)")
            bridge?.emit("videoError", ["id": id, "message": msg])
        default: break
        }
    }

    private func rateChanged() {
        let paused = player.rate == 0
        if paused != lastPaused {
            lastPaused = paused
            bridge?.emit("videoState", ["paused": paused, "t": now, "rate": Double(player.rate)])
        }
    }

    func unload() {
        statusObs = nil
        if let e = endObs { NotificationCenter.default.removeObserver(e); endObs = nil }
        player.pause()
        player.replaceCurrentItem(with: nil)
        item = nil; seekBusy = false; pendingSeek = nil; lastPaused = true
    }

    func play(rate: Double) {
        guard item != nil else { return }
        lastPaused = false
        player.rate = Float(rate == 0 ? 1 : rate)
    }
    func pause() {
        lastPaused = true; player.pause()
        bridge?.emit("videoState", ["paused": true, "t": now, "rate": 0])   // the page learns the exact stop position
    }
    func setRate(_ rate: Double) { if player.rate != 0 { player.rate = Float(rate) } }
    func setVolume(_ v: Double, muted: Bool) { player.volume = Float(v); player.isMuted = muted }

    /// Frame-exact seeks (or, with fast, the nearest earlier keyframe, for shuttling). While one is
    /// running, only the latest request is kept (smooth scrubbing).
    private var pendingFast = false
    func seek(_ t: Double, fast: Bool = false) {
        guard item != nil else { return }
        if seekBusy { pendingSeek = t; pendingFast = fast; return }
        seekBusy = true
        let before = fast ? CMTime(seconds: 3, preferredTimescale: 600) : .zero
        player.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600_000), toleranceBefore: before, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.seekBusy = false
                if let next = self.pendingSeek { self.pendingSeek = nil; self.seek(next, fast: self.pendingFast); return }
                self.bridge?.emit("videoSeeked", ["t": self.now])
            }
        }
    }
}

extension Double {
    func finiteOr(_ v: Double) -> Double { isFinite ? self : v }
}
