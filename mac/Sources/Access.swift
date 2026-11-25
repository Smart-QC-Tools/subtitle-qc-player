import Foundation

/// Which files the interface may open. Only folders the user chose (Choose… or dropped on the
/// window) and files dropped on the window; everything else on the Mac is off limits to the page.
/// The list is kept by the app itself, so the page can't add to it. Later write features (fixing
/// subtitles, moving files) will use the same boundary.
enum Access {
    private static let key = "allowedFolders"
    private static var roots: [String] = UserDefaults.standard.stringArray(forKey: key) ?? []
    private static var files = Set<String>()

    static func canonical(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    }
    static func allowFolder(_ path: String) {
        let c = canonical(path)
        roots.removeAll { $0 == c }
        roots.insert(c, at: 0)
        roots = Array(roots.prefix(40))
        UserDefaults.standard.set(roots, forKey: key)
    }
    static func allowFile(_ path: String) { files.insert(canonical(path)) }

    /// A VideoMarkers folder the page may read and write: inside a chosen folder, or near one: under a folder up to
    /// 3 levels above a chosen folder, at most 2 levels down from there (results sit beside the delivery folder, e.g.
    /// Digital/VideoMarkers for Digital/Encodes/QC_PASS, and Digital/Proxies/VideoMarkers is a neighbour).
    static func isMarkersAllowed(_ dir: String) -> Bool {
        let c = canonical(dir)
        guard (c as NSString).lastPathComponent == "VideoMarkers" else { return false }
        let parent = (c as NSString).deletingLastPathComponent
        if isAllowed(parent) { return true }
        for r in roots {
            var a = r
            for _ in 0..<3 {
                a = (a as NSString).deletingLastPathComponent
                if a.isEmpty || a == "/" { break }
                if parent == a { return true }
                if parent.hasPrefix(a + "/") && parent.dropFirst(a.count + 1).split(separator: "/").count <= 2 { return true }
            }
        }
        return false
    }

    static func isAllowed(_ path: String) -> Bool {
        guard !path.isEmpty else { return false }
        let c = canonical(path)
        if files.contains(c) { return true }
        return roots.contains { r in c == r || c.hasPrefix(r == "/" ? "/" : r + "/") }
    }
}
