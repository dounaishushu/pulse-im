import SwiftUI
import UIKit
import ImageIO
import CryptoKit

enum AvatarImageProcessor {
    static func prepare(_ source: Data, maximumPixel: Int = 1024) async throws -> Data {
        let task = Task.detached(priority: .userInitiated) { () throws -> Data in
            try Task.checkCancellation()
            guard !source.isEmpty, source.count <= 40 * 1024 * 1024,
                  let reader = CGImageSourceCreateWithData(source as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let thumbnail = CGImageSourceCreateThumbnailAtIndex(reader, 0, [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceThumbnailMaxPixelSize: maximumPixel,
                    kCGImageSourceShouldCacheImmediately: true
                  ] as CFDictionary) else { throw APIClientError.server("无法读取这张照片，请重新选择图片") }
            let image = UIImage(cgImage: thumbnail)
            let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
            let normalized = UIGraphicsImageRenderer(size: image.size, format: format).image { context in
                UIColor.white.setFill(); context.fill(CGRect(origin: .zero, size: image.size))
                image.draw(in: CGRect(origin: .zero, size: image.size))
            }
            for quality in [CGFloat(0.85), 0.7, 0.55, 0.4] {
                try Task.checkCancellation()
                if let encoded = normalized.jpegData(compressionQuality: quality), !encoded.isEmpty, encoded.count <= 1024 * 1024 { return encoded }
            }
            throw APIClientError.server("照片处理失败，请选择其他图片后重试")
        }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}

/// Only downsampled thumbnails are persisted; raw tokens and URLs never become filenames.
private actor AvatarDiskCache {
    static let shared = AvatarDiskCache()
    private var generation = 0
    private var directory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("pulse-avatar-thumbnails-v1", isDirectory: true)
    }

    func read(_ key: String, generation expected: Int) -> Data? {
        guard generation == expected, let directory else { return nil }
        let path = directory.appendingPathComponent(key + ".jpg")
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path.path),
              let size = (attributes[.size] as? NSNumber)?.intValue, size > 0, size <= 1024 * 1024,
              let modified = attributes[.modificationDate] as? Date, modified > Date().addingTimeInterval(-30 * 86400),
              let data = try? Data(contentsOf: path) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: path.path)
        return data
    }

    func write(_ data: Data, key: String, generation expected: Int) {
        guard generation == expected, data.count <= 1024 * 1024, var directory else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
            try data.write(to: directory.appendingPathComponent(key + ".jpg"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            prune(directory)
        } catch { /* Cache failure must never turn a verified profile save into failure. */ }
    }

    func clear(generation next: Int) {
        guard next > generation else { return }
        generation = next
        if let directory { try? FileManager.default.removeItem(at: directory) }
    }

    private func prune(_ directory: URL) {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else { return }
        let rows = files.filter { $0.pathExtension == "jpg" }.compactMap { url -> (URL, Int, Date)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
        }.sorted { $0.2 > $1.2 }
        var total = 0
        for (index, row) in rows.enumerated() {
            total += row.1
            if index >= 160 || total > 16 * 1024 * 1024 || row.2 < Date().addingTimeInterval(-30 * 86400) {
                try? FileManager.default.removeItem(at: row.0)
            }
        }
    }
}

@MainActor final class AvatarImageCache: ObservableObject {
    static let shared = AvatarImageCache()
    private struct Pending {
        let id: UUID
        var requestURL: URL
        let task: Task<UIImage?, Never>
        var readers: Set<UUID>
    }
    private let images = NSCache<NSString, UIImage>()
    private var pending: [String: Pending] = [:]
    private let downloads = AvatarLoadGate()
    // A large group's thumbnails must not evict the current account's avatar.
    private var profileKey: String?
    private var profileImage: UIImage?
    @Published private(set) var generation = 0
    private init() { images.totalCostLimit = 8 * 1024 * 1024; images.countLimit = 80 }

    static func scope(_ client: APIClient) -> String { client.endpointIdentity + "|" + client.webSocketToken }
    static func key(_ url: URL, client: APIClient) -> String { scope(client) + "|" + AvatarURLIdentity.cacheKey(url) }
    private static func diskKey(_ url: URL, client: APIClient) -> String {
        SHA256.hash(data: Data((client.avatarCacheNamespace + "|" + AvatarURLIdentity.cacheKey(url)).utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
    func cached(_ key: String) -> UIImage? {
        if profileKey == key, let profileImage { return profileImage }
        return images.object(forKey: key as NSString)
    }

    private func current(_ client: APIClient, generation expected: Int) -> Bool {
        generation == expected && Self.scope(APIClient.shared) == Self.scope(client)
    }

    func load(_ url: URL, client: APIClient) async -> UIImage? {
        let key = Self.key(url, client: client), epoch = generation
        guard !Task.isCancelled, current(client, generation: epoch) else { return nil }
        if let image = cached(key) { return image }
        let reader = UUID()
        let transfer: Pending
        if var existing = pending[key] {
            existing.requestURL = AvatarURLIdentity.newestGrant(current: existing.requestURL, incoming: url)
            existing.readers.insert(reader); pending[key] = existing; transfer = existing
        } else {
            let transferID = UUID()
            transfer = Pending(id: transferID, requestURL: url, task: Task {
                await self.fetchThumbnail(url, key: key, transferID: transferID, client: client, generation: epoch)
            }, readers: [reader])
            pending[key] = transfer
        }
        return await withTaskCancellationHandler {
            defer { releaseReader(reader, key: key, transferID: transfer.id) }
            let image = await transfer.task.value
            guard !Task.isCancelled, current(client, generation: epoch) else { return nil }
            if let image { store(image, key: key) }
            return cached(key) ?? image
        } onCancel: {
            Task { @MainActor in self.releaseReader(reader, key: key, transferID: transfer.id) }
        }
    }

    private func releaseReader(_ reader: UUID, key: String, transferID: UUID) {
        guard var transfer = pending[key], transfer.id == transferID else { return }
        transfer.readers.remove(reader)
        if transfer.readers.isEmpty { pending[key] = nil; transfer.task.cancel() }
        else { pending[key] = transfer }
    }

    private func fetchThumbnail(_ url: URL, key: String, transferID: UUID, client: APIClient, generation epoch: Int) async -> UIImage? {
        let diskKey = Self.diskKey(url, client: client)
        if let data = await AvatarDiskCache.shared.read(diskKey, generation: epoch),
           !Task.isCancelled, current(client, generation: epoch),
           let image = UIImage(data: data), image.size.width > 0, image.size.height > 0 { return image }
        for attempt in 0..<3 {
            var requestURL = url
            do {
                let lease = try await downloads.acquire()
                defer { downloads.release(lease) }
                try Task.checkCancellation()
                guard current(client, generation: epoch), let transfer = pending[key], transfer.id == transferID else { return nil }
                requestURL = transfer.requestURL
                let data = try await client.downloadAvatar(requestURL)
                let thumbnail = try await AvatarImageProcessor.prepare(data, maximumPixel: 256)
                try Task.checkCancellation()
                guard current(client, generation: epoch),
                      let image = UIImage(data: thumbnail) else { return nil }
                await AvatarDiskCache.shared.write(thumbnail, key: diskKey, generation: epoch)
                return image
            } catch {
                guard !Task.isCancelled, current(client, generation: epoch), attempt < 2 else { return nil }
                // All readers share a renewed request, including readers that
                // first joined using the now-expired grant.
                if let transfer = pending[key], transfer.id == transferID, transfer.requestURL != requestURL { continue }
                guard AvatarDownloadFailure.canRetry(error) else { return nil }
                do { try await Task.sleep(nanoseconds: UInt64(attempt + 1) * 750_000_000) }
                catch { return nil }
            }
        }
        return nil
    }

    /// Seed synchronously before publishing the verified new profile to SwiftUI.
    func seed(_ data: Data, rawURL: String?, client: APIClient) {
        guard let rawURL, let url = client.mediaURL(rawURL), let image = UIImage(data: data),
              Self.scope(APIClient.shared) == Self.scope(client) else { return }
        let ratio = min(1, 256 / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * ratio), height: max(1, image.size.height * ratio))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        let memoryKey = Self.key(url, client: client)
        profileKey = memoryKey; profileImage = thumbnail
        store(thumbnail, key: memoryKey)
        if let bytes = thumbnail.jpegData(compressionQuality: 0.85) {
            let key = Self.diskKey(url, client: client), epoch = generation
            Task { await AvatarDiskCache.shared.write(bytes, key: key, generation: epoch) }
        }
    }

    func prefetch(_ rawURL: String?, client: APIClient) {
        let epoch = generation
        guard current(client, generation: epoch) else { return }
        guard let rawURL, let url = client.mediaURL(rawURL) else { profileKey = nil; profileImage = nil; return }
        let key = Self.key(url, client: client)
        if profileKey != key { profileImage = nil }
        profileKey = key
        Task {
            guard let image = await load(url, client: client), current(client, generation: epoch), profileKey == key else { return }
            profileImage = image
        }
    }

    func clear() {
        generation += 1
        pending.values.forEach { $0.task.cancel() }; pending.removeAll(); images.removeAllObjects()
        profileKey = nil; profileImage = nil
        let epoch = generation
        Task { await AvatarDiskCache.shared.clear(generation: epoch) }
    }

    private func store(_ image: UIImage, key: String) {
        images.setObject(image, forKey: key as NSString, cost: Int(image.size.width * image.size.height) * 4)
    }
}

@MainActor struct StableAvatarImage: View {
    let url: URL
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject private var cache = AvatarImageCache.shared
    @State private var image: UIImage?
    @State private var imageKey = ""
    @State private var imageGeneration = -1
    private struct LoadIdentity: Hashable {
        let key: String
        let generation: Int
        let requestURL: String
        let active: Bool
    }

    var body: some View {
        let client = APIClient.shared.captureSession()
        let key = AvatarImageCache.key(url, client: client)
        let generation = cache.generation
        let active = scenePhase == .active
        // A Group containing only an absent image resolves to no view, so its
        // task may never start on a cold cache. Keep the loader mounted and use
        // the avatar's proposed size even before the thumbnail is available.
        Color.clear.overlay {
            if let displayed = cache.cached(key) ?? (imageKey == key && imageGeneration == generation ? image : nil) {
                Image(uiImage: displayed).resizable().scaledToFill()
            }
        }.task(id: LoadIdentity(key: key, generation: generation, requestURL: url.absoluteString, active: active)) {
            guard active else { return }
            // Retain the displayed thumbnail before suspension, even if NSCache
            // evicts it while a large group's other avatars are being loaded.
            if let cached = cache.cached(key) { image = cached; imageKey = key; imageGeneration = generation }
            let loaded = await cache.load(url, client: client)
            guard !Task.isCancelled, cache.generation == generation, AvatarImageCache.key(url, client: APIClient.shared) == key else { return }
            if let loaded { image = loaded; imageKey = key; imageGeneration = generation }
        }
    }
}
