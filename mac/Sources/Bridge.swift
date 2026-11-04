import AppKit
import WebKit

/// Messages from the page (window.webkit.messageHandlers.native.postMessage) and events back to it.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var view: MainView?
    private var waveJobs: [Int: WaveformJob] = [:]

    init(view: MainView) { self.view = view }

    // MARK: - page → app
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { replyHandler(nil, "bad message"); return }
        let str = { (k: String) -> String in body[k] as? String ?? "" }
        let num = { (k: String) -> Double in (body[k] as? NSNumber)?.doubleValue ?? 0 }

        switch cmd {
        case "log":
            Log.write(str("level"), str("msg")); replyHandler(true, nil)

        case "storeSet": Settings.set(str("key"), str("value")); replyHandler(true, nil)
        case "storeDel": Settings.remove(str("key")); replyHandler(true, nil)

        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
            panel.prompt = "Select"
            panel.message = str("kind") == "subs" ? "Select the subtitles folder" : "Select the videos folder"
            let start = str("start")
            if !start.isEmpty {
                let u = URL(fileURLWithPath: start)
                panel.directoryURL = FileManager.default.fileExists(atPath: start) ? u : u.deletingLastPathComponent()
            }
            let finish = { (r: NSApplication.ModalResponse) in
                if r == .OK, let p = panel.url?.path { Access.allowFolder(p); replyHandler(p, nil) } else { replyHandler(NSNull(), nil) }
            }
            if let win = view?.window { panel.beginSheetModal(for: win, completionHandler: finish) } else { finish(panel.runModal()) }

        case "listFolder":
            let path = str("path")
            guard Access.isAllowed(path) else { replyHandler(nil, "Not allowed: choose this folder first."); return }
            DispatchQueue.global(qos: .userInitiated).async {
                let url = URL(fileURLWithPath: path, isDirectory: true)
                let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey], options: [.skipsHiddenFiles])
                DispatchQueue.main.async {
                    guard let items = items else { replyHandler(nil, "Can't read the folder “\(path)”."); return }
                    let files = items.compactMap { FileInfo.describe($0) }.filter { ($0["isFile"] as? Bool) == true }
                    replyHandler(files, nil)
                }
            }

        case "read":
            let path = str("path"), start = UInt64(max(0, num("start"))), end = UInt64(max(0, num("end")))
            guard Access.isAllowed(path) else { replyHandler(nil, "Not allowed: “\(path)” isn't in a chosen folder."); return }
            DispatchQueue.global(qos: .userInitiated).async {
                var result: String? = nil
                if let h = FileHandle(forReadingAtPath: path) {
                    do {
                        try h.seek(toOffset: start)
                        let data = try h.read(upToCount: Int(end > start ? end - start : 0)) ?? Data()
                        result = data.base64EncodedString()
                    } catch { result = nil }
                    try? h.close()
                }
                DispatchQueue.main.async {
                    if let r = result { replyHandler(r, nil) } else { replyHandler(nil, "Can't read “\(path)”.") }
                }
            }

        case "layout":
            let visible = body["visible"] as? Bool ?? false
            let stage = (body["stage"] as? [NSNumber])?.map { $0.doubleValue }
            let vid = (body["video"] as? [NSNumber])?.map { $0.doubleValue }
            view?.layoutPlayer(visible: visible, stage: stage, videoRect: vid)
            replyHandler(true, nil)

        case "videoLoad":
            guard Access.isAllowed(str("path")) else { replyHandler(nil, "Not allowed"); return }
            view?.video.load(path: str("path"), id: Int(num("id"))); replyHandler(true, nil)
        case "videoUnload": view?.video.unload(); replyHandler(true, nil)
        case "videoPlay": view?.video.play(rate: num("rate")); replyHandler(true, nil)
        case "videoPause": view?.video.pause(); replyHandler(true, nil)
        case "videoRate": view?.video.setRate(num("rate")); replyHandler(true, nil)
        case "videoSeek": view?.video.seek(num("t"), fast: body["fast"] as? Bool ?? false, seq: Int(num("seq"))); replyHandler(true, nil)
        case "videoVolume": view?.video.setVolume(num("volume"), muted: body["muted"] as? Bool ?? false); replyHandler(true, nil)

        case "waveStart":
            let id = Int(num("id"))
            guard Access.isAllowed(str("path")) else { replyHandler(nil, "Not allowed"); return }
            var prefs: [Int: [Int]] = [:]
            if let p = body["prefs"] as? [String: Any] {
                for (k, v) in p { if let n = Int(k), let arr = v as? [NSNumber] { prefs[n] = arr.map { $0.intValue } } }
            }
            let job = WaveformJob(id: id, path: str("path"), prefs: prefs) { [weak self] msg in self?.emit("wave", msg) }
            waveJobs[id] = job
            job.start { [weak self] in self?.waveJobs.removeValue(forKey: id) }
            replyHandler(true, nil)
        case "waveCancel":
            let id = Int(num("id"))
            waveJobs[id]?.cancel(); waveJobs.removeValue(forKey: id)
            replyHandler(true, nil)

        #if SELFTEST
        case "selftestStats":
            guard let v = view?.video else { replyHandler(nil, "no video"); return }
            var d = v.testStats()
            if let mv = view {
                d["zoom"] = Double(mv.webView.pageZoom)
                let f = mv.playerHost.convert(v.layer.frame, to: mv)   // video layer in window points (top-left origin)
                d["layer"] = [f.origin.x, f.origin.y, f.size.width, f.size.height].map { Double($0) }
                d["window"] = [Double(mv.bounds.width), Double(mv.bounds.height)]
            }
            if body["reset"] as? Bool == true { v.frameCounter.reset() }
            replyHandler(d, nil)
        case "selftestDone":
            SelfTest.finish(str("json")); replyHandler(true, nil)
        #endif
        default:
            replyHandler(nil, "unknown command \(cmd)")
        }
    }

    // MARK: - app → page
    func emit(_ type: String, _ payload: [String: Any]) {
        let run = { [weak self] in
            guard let web = self?.view?.webView,
                  let data = try? JSONSerialization.data(withJSONObject: payload),
                  let json = String(data: data, encoding: .utf8) else { return }
            web.evaluateJavaScript("window.__nativeEvent && window.__nativeEvent(\"\(type)\", \(json));", completionHandler: nil)
        }
        if Thread.isMainThread { run() } else { DispatchQueue.main.async(execute: run) }
    }
}
