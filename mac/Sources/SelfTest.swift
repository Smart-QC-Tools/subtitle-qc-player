#if SELFTEST
import AVFoundation
import AppKit
import WebKit

/// Test build only (swiftc -D SELFTEST): drives the real interface with a script and records what
/// the native side sees. Never part of the app people download.
///   SQC_SELFTEST  path of the JavaScript test script
///   SQC_VIDEOS / SQC_SUBS  folders to use (allowed without the folder picker)
///   SQC_RESULT    where to write the results (JSON)
///   SQC_ANALYSIS  folder of videos for the analysis test: also opens the Video Analysis window on it and
///                 presses Start there (what it shows goes to the log)
///   SQC_ONLY      "analysis": skip the playback tests
enum SelfTest {
    static var env: [String: String] { ProcessInfo.processInfo.environment }
    static func install(into ucc: WKUserContentController) {
        guard let p = env["SQC_SELFTEST"], let js = try? String(contentsOfFile: p) else { return }
        let v = env["SQC_VIDEOS"] ?? "", s = env["SQC_SUBS"] ?? "", a = env["SQC_ANALYSIS"] ?? ""
        for f in [v, s, a] where !f.isEmpty { Access.allowFolder(f) }
        let cfg = (try? JSONSerialization.data(withJSONObject: ["videos": v, "subs": s, "analysis": a, "only": env["SQC_ONLY"] ?? ""])).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        ucc.addUserScript(WKUserScript(source: "window.__selftest = \(cfg);\n" + js, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        Log.write("selftest", "installed")
    }
    /// The Video Analysis window, driven from outside: open it on the test folder, press Start, and log
    /// what the window says whenever that changes.
    static func afterLaunch() {
        guard let a = env["SQC_ANALYSIS"], !a.isEmpty, env["SQC_ONLY"] != "basic" else { return }
        Settings.set("ana:folder", a)
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
            AnalysisWindow.shared.show()
            Log.write("selftest", "analysis window opened")
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                AnalysisWindow.shared.webView?.evaluateJavaScript("document.getElementById('anaStart').click(); 'clicked'") { r, e in
                    Log.write("selftest", "analysis window: Start \(r ?? "nil") \(e?.localizedDescription ?? "")")
                }
            }
            var last = ""
            let timer = Timer(timeInterval: 1.5, repeats: true) { _ in
                let js = "JSON.stringify({title: document.title, folder: (document.getElementById('anaFolder')||{}).textContent, sum: (document.getElementById('anaSum')||{}).textContent, rows: [...document.querySelectorAll('#anaBody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())})"
                AnalysisWindow.shared.webView?.evaluateJavaScript(js) { r, _ in
                    guard let s = r as? String, s != last else { return }
                    last = s
                    Log.write("selftest", "analysis window (\(AnalysisWindow.shared.window?.title ?? "")): \(s)")
                }
            }
            RunLoop.main.add(timer, forMode: .common)
        }
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
