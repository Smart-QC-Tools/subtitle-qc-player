import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var mainView: MainView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        Log.write("info", "Launched \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] ?? "?") (build \(Bundle.main.infoDictionary?["CFBundleVersion"] ?? "?")) on macOS \(ProcessInfo.processInfo.operatingSystemVersionString)")
        buildMenu()

        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1512, height: 900)
        // First launch: the design size (1640 x 840), or as much of the screen as allows.
        let size = NSSize(width: min(MainView.designSize.width, screen.width * 0.96), height: min(MainView.designSize.height, screen.height * 0.96))
        let rect = NSRect(x: screen.midX - size.width / 2, y: screen.midY - size.height / 2, width: size.width, height: size.height)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Subtitle QC Player"
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = MainView.panelColor
        window.contentMinSize = NSSize(width: MainView.designSize.width * MainView.minZoom, height: MainView.designSize.height * MainView.minZoom)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("SubtitleQCMainWindow2")   // (new name: everyone starts once at the new default size)

        mainView = MainView(frame: NSRect(origin: .zero, size: rect.size))
        window.contentView = mainView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        mainView.load()
        window.makeFirstResponder(mainView.webView)   // keyboard shortcuts work straight away
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - Menu (the Edit menu is what makes ⌘C / ⌘V / ⌘A work in text fields)
    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Subtitle QC Player", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Subtitle QC Player", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Subtitle QC Player", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        view.addItem(.separator())
        view.addItem(withTitle: "Reload", action: #selector(reloadPage(_:)), keyEquivalent: "r").target = self
        viewItem.submenu = view

        let windowItem = NSMenuItem(); main.addItem(windowItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowItem.submenu = win
        NSApp.windowsMenu = win

        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "Show Log File", action: #selector(showLog(_:)), keyEquivalent: "").target = self
        helpItem.submenu = help

        NSApp.mainMenu = main
    }

    @objc func reloadPage(_ sender: Any?) { mainView.reload() }
    @objc func showLog(_ sender: Any?) { NSWorkspace.shared.activateFileViewerSelecting([Log.fileURL]) }
}
