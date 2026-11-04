import AppKit
import WebKit
import AVFoundation

/// The window's content: the native video picture at the bottom, the web page (the whole
/// interface) on top. The page is see-through over the stage, so the picture shows through
/// exactly where the page's video element is.
final class MainView: NSView {
    static let panelColor = NSColor(srgbRed: 0x11 / 255.0, green: 0x12 / 255.0, blue: 0x15 / 255.0, alpha: 1)   // --panel
    static let stageColor = NSColor(srgbRed: 0x07 / 255.0, green: 0x07 / 255.0, blue: 0x08 / 255.0, alpha: 1)   // stage grey

    let playerHost = NSView()
    let navGuard = NavigationGuard()
    let video = VideoController()
    var webView: DropWebView!
    var bridge: Bridge!

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = MainView.panelColor.cgColor

        playerHost.wantsLayer = true
        playerHost.layer?.backgroundColor = MainView.stageColor.cgColor
        playerHost.layer?.addSublayer(video.layer)
        playerHost.isHidden = true
        addSubview(playerHost)

        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.mediaTypesRequiringUserActionForPlayback = []
        bridge = Bridge(view: self)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "native")
        let store = Settings.allJSON()
        config.userContentController.addUserScript(WKUserScript(source: "window.__nativeStore = \(store);", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #if SELFTEST
        SelfTest.install(into: config.userContentController)
        #endif

        webView = DropWebView(frame: bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.setValue(false, forKey: "drawsBackground")
        webView.navigationDelegate = navGuard
        webView.uiDelegate = navGuard
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        webView.onDrop = { [weak self] items in
            for it in items {   // dropping something on the window counts as choosing it
                guard let p = it["path"] as? String else { continue }
                if (it["isDir"] as? Bool) == true { Access.allowFolder(p) } else { Access.allowFile(p) }
            }
            self?.bridge.emit("drop", ["items": items])
        }
        addSubview(webView)
        video.bridge = bridge
        setFrameSize(frame.size)   // apply the zoom for the starting size
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The interface is designed for 1640 x 840 points. In a smaller window the whole page is zoomed out
    /// (fonts, controls, player), down to 80%; bigger windows stay at 100% and the page uses the space.
    static let designSize = NSSize(width: 1640, height: 840)
    static let minZoom: CGFloat = 0.8
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        let z = max(MainView.minZoom, min(1, newSize.width / MainView.designSize.width, newSize.height / MainView.designSize.height))
        if let w = webView, abs(w.pageZoom - z) > 0.001 { w.pageZoom = z }
    }

    private var networkBlocked = false
    func load() {
        guard let url = Bundle.main.url(forResource: "index", withExtension: "html") else {
            Log.write("error", "index.html missing from the app bundle"); return
        }
        let go = { [weak self] in self?.webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        if networkBlocked { _ = go(); return }
        // Safety net: the interface never needs the internet, so every web request is blocked.
        // (WebKit's rule syntax has no "a|b": one rule per scheme.)
        let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]"#
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "no-network", encodedContentRuleList: rules) { [weak self] list, error in
            guard let self = self else { return }
            if let list = list { self.webView.configuration.userContentController.add(list); self.networkBlocked = true }
            else { Log.write("error", "Network block rules failed: \(error?.localizedDescription ?? "?")") }
            _ = go()
        }
    }
    func reload() { video.unload(); playerHost.isHidden = true; load() }

    /// Called by the page whenever the stage or video element moves or resizes.
    func layoutPlayer(visible: Bool, stage: [Double]?, videoRect: [Double]?) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        defer { CATransaction.commit() }
        guard visible, let st = stage, st.count == 4, let vr = videoRect, vr.count == 4 else { playerHost.isHidden = true; return }
        // The page measures in its own (zoomed) units: convert to points.
        let z = Double(webView.pageZoom)
        let s = st.map { $0 * z }, v = vr.map { $0 * z }
        playerHost.frame = NSRect(x: s[0], y: s[1], width: s[2], height: s[3])
        // playerHost is not flipped: convert the video's top-left based rect.
        let x = v[0] - s[0], yTop = v[1] - s[1]
        video.layer.frame = CGRect(x: x, y: s[3] - yTop - v[3], width: v[2], height: v[3])
        playerHost.isHidden = false
    }
}

/// Lets folders and files be dropped onto the window from Finder (the page can't see file paths).
final class DropWebView: WKWebView {
    var onDrop: (([[String: Any]]) -> Void)?

    private func fileURLs(_ info: NSDraggingInfo) -> [URL] {
        (info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingEntered(sender) : .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        fileURLs(sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = fileURLs(sender)
        if urls.isEmpty { return super.performDragOperation(sender) }
        let items: [[String: Any]] = urls.map { url in
            var isDir: ObjCBool = false
            FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
            var d = FileInfo.describe(url) ?? ["name": url.lastPathComponent, "path": url.path, "size": 0, "mtime": 0]
            d["isDir"] = isDir.boolValue
            return d
        }
        onDrop?(items)
        return true
    }
}
