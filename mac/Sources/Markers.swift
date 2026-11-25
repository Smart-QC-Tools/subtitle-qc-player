import Foundation

/// Video markers files (VideoMarkers/<video name>.markers.json, written by Video Analysis): reading them for the QC
/// page (1.0.0 and 1.1.0) and writing them (1.1.0). Shared by both versions.
/// Results ("markers") files: "<video file name>.markers.json" in a visible VideoMarkers folder, beside the
/// delivery folder (Encodes / QC_PASS / QC_FAIL) or inside the videos' folder: the page works out which
/// (Markers.markersPathFor), so they travel with the season and any Mac (or the web version) can read them.
enum MarkersFiles {
    static let dirName = "VideoMarkers"
    static let suffix = ".markers.json"

    /// The markers files in these VideoMarkers folders and, with `around` (a videos folder), in the ones near it:
    /// in it, beside it and beside its parent, and in their neighbours (Proxies/VideoMarkers for Encodes, say).
    static func read(dirs: [String], around: String) -> [[String: String]] {
        var cand: [String] = dirs
        if !around.isEmpty {
            let fm = FileManager.default
            var base = around
            for _ in 0..<3 {
                cand.append((base as NSString).appendingPathComponent(dirName))
                if let subs = try? fm.contentsOfDirectory(atPath: base) {
                    for s in subs where !s.hasPrefix(".") && s != dirName {
                        cand.append(((base as NSString).appendingPathComponent(s) as NSString).appendingPathComponent(dirName))
                    }
                }
                base = (base as NSString).deletingLastPathComponent
                if base.isEmpty || base == "/" { break }
            }
        }
        var seen = Set<String>(), out: [[String: String]] = []
        for d in cand {
            let c = Access.canonical(d)
            guard !seen.contains(c) else { continue }
            seen.insert(c)
            guard Access.isMarkersAllowed(c),
                  let items = try? FileManager.default.contentsOfDirectory(at: URL(fileURLWithPath: c, isDirectory: true), includingPropertiesForKeys: [.fileSizeKey], options: [.skipsHiddenFiles]) else { continue }
            for u in items where u.lastPathComponent.lowercased().hasSuffix(suffix) {
                let size = (try? u.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                if size > 0, size < 50_000_000, let s = try? String(contentsOf: u, encoding: .utf8) { out.append(["dir": c, "json": s]) }
            }
        }
        return out
    }

    /// Returns nil when written, or the reason it couldn't be.
    static func write(dir: String, fileName: String, json: String) -> String? {
        let name = (fileName as NSString).lastPathComponent
        guard name.lowercased().hasSuffix(suffix), name.count > suffix.count else { return "Bad file name." }
        guard Access.isMarkersAllowed(dir) else { return "Not allowed here: choose the videos' folder first." }
        let url = URL(fileURLWithPath: dir, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            try json.write(to: url.appendingPathComponent(name), atomically: true, encoding: .utf8)
            return nil
        } catch {
            Log.write("error", "Video markers not saved for \(name): \(error.localizedDescription)")
            return error.localizedDescription
        }
    }
}
