#if SELFTEST
import AVFoundation
import AppKit
import WebKit

/// Test build only (swiftc -D SELFTEST): drives the real interface with a script and records what
/// the native side sees. Never part of the app people download.
///   SQC_SELFTEST  path of the JavaScript test script
///   SQC_VIDEOS / SQC_SUBS  folders to use (allowed without the folder picker)
///   SQC_RESULT    where to write the results (JSON)
enum SelfTest {
    static var env: [String: String] { ProcessInfo.processInfo.environment }
    static func install(into ucc: WKUserContentController) {
        guard let p = env["SQC_SELFTEST"], let js = try? String(contentsOfFile: p) else { return }
        let v = env["SQC_VIDEOS"] ?? "", s = env["SQC_SUBS"] ?? ""
        for f in [v, s] where !f.isEmpty { Access.allowFolder(f) }
        let cfg = (try? JSONSerialization.data(withJSONObject: ["videos": v, "subs": s])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        ucc.addUserScript(WKUserScript(source: "window.__selftest = \(cfg);\n" + js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        Log.write("selftest", "installed")
    }
    static func finish(_ json: String) {
        if let out = env["SQC_RESULT"] { try? json.write(toFile: out, atomically: true, encoding: .utf8) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
    }
}

/// Counts the distinct video frames AVFoundation actually delivers while playing: if decoding can't keep
/// up, fewer frames arrive than the frame rate says.
final class FrameCounter {
    private var output: AVPlayerItemVideoOutput?
    private var timer: Timer?
    private(set) var frames = 0
    private var lastPTS = CMTime.invalid
    private var since = CACurrentMediaTime()
    private var maxGap = 0.0, lastFrameAt = 0.0

    func attach(_ item: AVPlayerItem) {
        let o = AVPlayerItemVideoOutput(pixelBufferAttributes: nil)
        item.add(o)
        output = o
        timer?.invalidate()
        timer = Timer(timeInterval: 1.0 / 240, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer!, forMode: .common)
        reset()
    }
    private func poll() {
        guard let o = output else { return }
        let t = o.itemTime(forHostTime: CACurrentMediaTime())
        guard o.hasNewPixelBuffer(forItemTime: t) else { return }
        var disp = CMTime.invalid
        if o.copyPixelBuffer(forItemTime: t, itemTimeForDisplay: &disp) != nil, disp != lastPTS {
            lastPTS = disp; frames += 1
            let now = CACurrentMediaTime()
            if lastFrameAt > 0 { maxGap = max(maxGap, now - lastFrameAt) }
            lastFrameAt = now
        }
    }
    func reset() { frames = 0; since = CACurrentMediaTime(); maxGap = 0; lastFrameAt = 0 }
    func stats() -> [String: Any] {
        let el = CACurrentMediaTime() - since
        return ["frames": frames, "seconds": el, "fps": el > 0 ? Double(frames) / el : 0, "maxFrameGapMs": maxGap * 1000]
    }
}
#endif
