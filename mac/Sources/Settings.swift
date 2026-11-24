import Foundation

/// The page's settings (remembered offsets, folders, preferences …) kept in the app's defaults.
enum Settings {
    private static let key = "webStore"
    private static var dict: [String: String] = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]

    static func allJSON() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: dict), let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
    static func get(_ k: String) -> String? { dict[k] }
    static func set(_ k: String, _ v: String) { dict[k] = v; UserDefaults.standard.set(dict, forKey: key) }
    static func remove(_ k: String) { dict.removeValue(forKey: k); UserDefaults.standard.set(dict, forKey: key) }
}

enum FileInfo {
    static func describe(_ url: URL) -> [String: Any]? {
        guard let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .isPackageKey, .fileSizeKey, .contentModificationDateKey]) else { return nil }
        return [
            "name": url.lastPathComponent,
            "path": url.path,
            "size": v.fileSize ?? 0,
            "mtime": ((v.contentModificationDate ?? Date()).timeIntervalSince1970 * 1000).rounded(),
            "isFile": v.isRegularFile ?? false,
            "isDir": (v.isDirectory ?? false) && !(v.isPackage ?? false),
        ]
    }
}
