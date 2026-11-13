import Foundation
import CryptoKit

enum IOSChatImageCachePolicy {
    /// Preview parameters only apply to our signed upload format, never to arbitrary image links.
    static func previewURL(_ url: URL) -> URL {
        let preview = GoV2MediaURLs.preview(url)
        if preview != url { return preview }
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""), parts.host != nil,
              parts.user == nil, parts.password == nil else { return url }
        let query = parts.queryItems ?? []
        guard ["media_expires", "media_signature", "media_session", "media_kind"].allSatisfy({ name in
            query.contains { $0.name == name && !($0.value ?? "").isEmpty }
        }) else { return url }
        let path = parts.path.hasSuffix("/media") ? query.first { $0.name == "path" }?.value ?? ""
            : parts.path.components(separatedBy: "/storage/").dropFirst().joined(separator: "/storage/")
        guard path.range(of: #"^uploads/\d{4}/(?:0[1-9]|1[0-2])/[a-f0-9]{32}\.(?:jpg|jpeg|png|gif|webp)$"#, options: .regularExpression) != nil else { return url }
        parts.queryItems = query.filter { $0.name != "media_preview" } + [URLQueryItem(name: "media_preview", value: "640")]
        return parts.url ?? url
    }

    static let maximumImageBytes = 32 * 1024 * 1024
    static let maximumDiskBytes = 160 * 1024 * 1024
    static let maximumFiles = 160
    static let maximumAge: TimeInterval = 7 * 86400

    /// Renewed expiry/signature may reuse content, but grants for another session may not.
    static func key(namespace: String, url: URL) -> String {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let query = parts?.queryItems ?? []
        let grant = ["media_expires", "media_signature", "media_session", "media_kind"]
        let complete = grant.allSatisfy { name in query.contains { $0.name == name && !($0.value ?? "").isEmpty } }
        let filtered = query.filter { !complete || !["media_expires", "media_signature"].contains($0.name) }
            .sorted { $0.name == $1.name ? ($0.value ?? "") < ($1.value ?? "") : $0.name < $1.name }
        parts?.queryItems = filtered.isEmpty ? nil : filtered; parts?.fragment = nil
        let identity = namespace + "\0" + (parts?.string ?? url.absoluteString)
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func validKey(_ key: String) -> Bool {
        key.count == 64 && key.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

/// Compressed originals only. Actor serializes pruning/clear with disk access.
actor IOSChatImageDiskCache {
    static let shared = IOSChatImageDiskCache()
    private var generation = 0
    private let directory: URL?
    init(directory: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
        .appendingPathComponent("pulse-chat-images-v1", isDirectory: true)) { self.directory = directory }

    func read(_ key: String, generation expected: Int, now: Date = Date()) -> Data? {
        guard expected == generation, IOSChatImageCachePolicy.validKey(key), let directory else { return nil }
        let path = directory.appendingPathComponent(key + ".image")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path.path),
              let size = (attributes[.size] as? NSNumber)?.intValue, size > 0, size <= IOSChatImageCachePolicy.maximumImageBytes,
              let modified = attributes[.modificationDate] as? Date,
              now.timeIntervalSince(modified) >= 0, now.timeIntervalSince(modified) <= IOSChatImageCachePolicy.maximumAge,
              let data = try? Data(contentsOf: path), data.count == size else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: path.path)
        return data
    }
    func write(_ data: Data, key: String, generation expected: Int, now: Date = Date()) throws {
        guard expected == generation else { throw CancellationError() }
        guard IOSChatImageCachePolicy.validKey(key), !data.isEmpty, data.count <= IOSChatImageCachePolicy.maximumImageBytes,
              var directory else { throw CocoaError(.fileWriteInvalidFileName) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var values = URLResourceValues(); values.isExcludedFromBackup = true; try directory.setResourceValues(values)
        let path = directory.appendingPathComponent(key + ".image")
        try data.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: path.path)
        prune(now: now)
    }
    func remove(_ key: String, generation expected: Int) {
        guard generation == expected, IOSChatImageCachePolicy.validKey(key), let directory else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(key + ".image"))
    }
    func clear(generation next: Int) {
        guard next > generation else { return }
        generation = next
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }
    private func prune(now: Date) {
        guard let directory, let files = try? FileManager.default.contentsOfDirectory(at: directory,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey], options: [.skipsHiddenFiles]) else { return }
        let rows = files.filter { $0.pathExtension == "image" }.compactMap { path -> (URL, Int, Date)? in
            guard let value = try? path.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
            return (path, value.fileSize ?? 0, value.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
        var bytes = 0
        for (index, row) in rows.enumerated() {
            bytes += row.1
            if index >= IOSChatImageCachePolicy.maximumFiles || bytes > IOSChatImageCachePolicy.maximumDiskBytes
                || now.timeIntervalSince(row.2) > IOSChatImageCachePolicy.maximumAge {
                try? FileManager.default.removeItem(at: row.0)
            }
        }
    }
}
