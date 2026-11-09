import Foundation
import CryptoKit

/// Stable private media files; the network downloader still enforces origin, size and redirects.
actor IOSLocalMediaCache {
    static let shared = IOSLocalMediaCache()
    private struct Entry: Codable { let size: Int64; let checksum: String; let owner: String; let name: String }
    private var generation = 0
    private var pending: [String: Task<URL, Error>] = [:]
    private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    private func directory() throws -> URL {
        let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("local-media-v1", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]); return root
    }
    private func identity(_ url: URL) -> String {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        parts.queryItems = parts.queryItems?.filter { !["media_signature", "media_expires"].contains($0.name) }.sorted { ($0.name, $0.value ?? "") < ($1.name, $1.value ?? "") }; parts.fragment = nil
        return parts.url?.absoluteString ?? url.absoluteString
    }
    private func checksum(_ file: URL) throws -> String {
        let input = try FileHandle(forReadingFrom: file); defer { try? input.close() }; var digest = SHA256()
        while let data = try input.read(upToCount: 65536), !data.isEmpty { digest.update(data: data) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    func file(client: APIClient, raw: String, name: String, maximumBytes: Int64, loader: @escaping () async throws -> URL) async throws -> URL {
        guard let url = client.mediaURL(raw) else { throw APIClientError.invalidResponse }
        let owner = hash(Data(client.avatarCacheNamespace.utf8)), key = hash(Data((owner + "|" + identity(url)).utf8)), root = try directory()
        let metaURL = root.appendingPathComponent(key + ".json")
        if let data = try? Data(contentsOf: metaURL), let entry = try? JSONDecoder().decode(Entry.self, from: data), entry.owner == owner, entry.size > 0, entry.size <= maximumBytes,
           entry.name.hasPrefix(key + "."), !entry.name.contains("/"), !entry.name.contains("\\") {
            let file = root.appendingPathComponent(entry.name)
            let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
            if size == entry.size, (try? checksum(file)) == entry.checksum { try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: metaURL.path); try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path); return file }
        }
        if let task = pending[key] { let file = try await task.value; try Task.checkCancellation(); return file }
        guard pending.count < 4 else { throw APIClientError.server("附件正在下载，请稍后重试") }
        let expected = generation
        let task = Task<URL, Error> {
            let temporary = try await loader()
            defer { APIClient.removeDownloadedMedia(at: temporary) }
            try Task.checkCancellation()
            return try self.commit(temporary, key: key, owner: owner, root: root, name: name, maximumBytes: maximumBytes, expected: expected)
        }
        pending[key] = task
        do { let file = try await task.value; pending[key] = nil; try Task.checkCancellation(); return file }
        catch { pending[key] = nil; throw error }
    }
    private func commit(_ temporary: URL, key: String, owner: String, root: URL, name: String, maximumBytes: Int64, expected: Int) throws -> URL {
        guard generation == expected else { throw CancellationError() }
        let size = Int64(try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
        guard size > 0, size <= min(maximumBytes, 100 * 1024 * 1024) else { throw APIClientError.server("附件大小超出限制") }
        let ext = (name as NSString).pathExtension.lowercased(), safeExtension = ext.range(of: "^[a-z0-9]{1,8}$", options: .regularExpression) == nil ? "bin" : ext
        let filename = key + "." + safeExtension, file = root.appendingPathComponent(filename)
        let entry = Entry(size: size, checksum: try checksum(temporary), owner: owner, name: filename)
        try? FileManager.default.removeItem(at: file); try FileManager.default.moveItem(at: temporary, to: file)
        try JSONEncoder().encode(entry).write(to: root.appendingPathComponent(key + ".json"), options: .atomic)
        prune(root, keep: filename); return file
    }
    private func prune(_ root: URL, keep: String) {
        let fm = FileManager.default
        let rows = ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []).filter { $0.pathExtension == "json" }.sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
        var bytes: Int64 = 0; var entries: [(URL, Entry)] = []
        for meta in rows { if let data = try? Data(contentsOf: meta), let entry = try? JSONDecoder().decode(Entry.self, from: data) { bytes += entry.size; entries.append((meta, entry)) } }
        var count = entries.count
        for (meta, entry) in entries where entry.name != keep && (bytes > 1024 * 1024 * 1024 || count > 500) {
            guard !entry.name.contains("/"), !entry.name.contains("\\") else { continue }
            try? fm.removeItem(at: root.appendingPathComponent(entry.name)); try? fm.removeItem(at: meta); bytes -= entry.size; count -= 1
        }
    }
    func clear() { generation += 1; pending.values.forEach { $0.cancel() }; pending = [:]; if let root = try? directory() { for file in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] { try? FileManager.default.removeItem(at: file) } } }
    func cancel() { generation += 1; pending.values.forEach { $0.cancel() }; pending = [:] }
}
