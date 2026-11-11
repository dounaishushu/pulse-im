import SwiftUI
import UIKit
import ImageIO
import AVFoundation

/// Shared by chat bubbles, gallery pages and image sharing. Original bytes are
/// bounded on disk; display images are downsampled off the main thread.
@MainActor final class IOSChatImageCache: ObservableObject {
    static let shared = IOSChatImageCache()
    private final class Pending<Value> {
        let id = UUID()
        let task: Task<Value, Error>
        var consumers = Set<UUID>()
        init(task: Task<Value, Error>) { self.task = task }
    }
    private let images = NSCache<NSString, UIImage>()
    private var transfers: [String: Pending<Data>] = [:]
    private var renders: [String: Pending<UIImage>] = [:]
    private var posters: [String: Pending<UIImage>] = [:]
    @Published private(set) var generation = 0
    private init() { images.totalCostLimit = 48 * 1024 * 1024; images.countLimit = 60 }
    static func scope(_ client: APIClient) -> String { client.endpointIdentity + "|" + client.webSocketToken }
    static func key(_ url: URL, client: APIClient) -> String {
        IOSChatImageCachePolicy.key(namespace: client.avatarCacheNamespace, url: url)
    }
    private func current(_ client: APIClient, epoch: Int) -> Bool {
        generation == epoch && Self.scope(APIClient.shared) == Self.scope(client)
    }
    private func memoryKey(_ url: URL, client: APIClient, pixel: Int) -> NSString {
        (Self.scope(client) + "|" + Self.key(url, client: client) + "|" + String(pixel)) as NSString
    }
    func cached(_ url: URL, client: APIClient) -> UIImage? {
        guard Self.scope(APIClient.shared) == Self.scope(client) else { return nil }
        return images.object(forKey: memoryKey(url, client: client, pixel: 2560))
            ?? images.object(forKey: memoryKey(url, client: client, pixel: 640))
    }
    func cachedPreview(_ url: URL, client: APIClient) -> UIImage? {
        cached(url, client: client) ?? cached(IOSChatImageCachePolicy.previewURL(url), client: client)
    }
    func loadPreview(_ url: URL, client: APIClient) async throws -> UIImage {
        if let original = cached(url, client: client) { return original }
        return try await load(IOSChatImageCachePolicy.previewURL(url), client: client, maximumPixel: 640)
    }
    /// Each visible view holds its own subscription. Leaving the last view cancels
    /// the actual URLSession download; leaving one of two views preserves the other.
    private func consume<Value>(_ pending: Pending<Value>, release: @escaping @MainActor () -> Void) async throws -> Value {
        let consumer = UUID(); pending.consumers.insert(consumer)
        @MainActor func finish() {
            guard pending.consumers.remove(consumer) != nil else { return }
            if pending.consumers.isEmpty { pending.task.cancel(); release() }
        }
        return try await withTaskCancellationHandler {
            defer { finish() }
            let result = try await pending.task.value
            try Task.checkCancellation(); return result
        } onCancel: { Task { @MainActor in finish() } }
    }
    func load(_ url: URL, client: APIClient, maximumPixel: Int) async throws -> UIImage {
        let pixel = maximumPixel <= 640 ? 640 : 2560, epoch = generation
        guard current(client, epoch: epoch) else { throw CancellationError() }
        let memoryKey = memoryKey(url, client: client, pixel: pixel)
        if let image = images.object(forKey: memoryKey)
            ?? images.object(forKey: self.memoryKey(url, client: client, pixel: 2560)) { return image }
        let renderKey = memoryKey as String
        let pending = renders[renderKey] ?? Pending(task: Task<UIImage, Error> {
            let data = try await self.original(url, client: client)
            let decode = Task.detached(priority: .userInitiated) { () throws -> UIImage in
                try Task.checkCancellation()
                guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: pixel,
                        kCGImageSourceShouldCacheImmediately: true
                      ] as CFDictionary) else { throw IOSChatMediaFailure.invalidImage }
                return UIImage(cgImage: cg)
            }
            return try await withTaskCancellationHandler { try await decode.value } onCancel: { decode.cancel() }
        })
        renders[renderKey] = pending
        let image: UIImage
        do { image = try await consume(pending) { if self.renders[renderKey]?.id == pending.id { self.renders[renderKey] = nil } } }
        catch {
            if current(client, epoch: epoch), !(error is CancellationError) {
                await IOSChatImageDiskCache.shared.remove(Self.key(url, client: client), generation: epoch)
            }
            throw error
        }
        guard current(client, epoch: epoch) else { throw CancellationError() }
        images.setObject(image, forKey: memoryKey, cost: (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0))
        try Task.checkCancellation(); return image
    }
    private func original(_ url: URL, client: APIClient) async throws -> Data {
        let epoch = generation, key = Self.key(url, client: client), scope = Self.scope(client)
        guard current(client, epoch: epoch) else { throw CancellationError() }
        let transferKey = scope + "|" + key
        let pending = transfers[transferKey] ?? Pending(task: Task<Data, Error> {
            if let data = await IOSChatImageDiskCache.shared.read(key, generation: epoch) { return data }
            let file = try await client.downloadMedia(url.absoluteString, fileName: "图片", maximumBytes: Int64(IOSChatImageCachePolicy.maximumImageBytes))
            defer { APIClient.removeDownloadedMedia(at: file) }
            let data = try await Task.detached(priority: .userInitiated) { () throws -> Data in
                let data = try Data(contentsOf: file)
                guard !data.isEmpty, data.count <= IOSChatImageCachePolicy.maximumImageBytes,
                      let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                      CGImageSourceGetCount(source) > 0 else { throw IOSChatMediaFailure.invalidImage }
                return data
            }.value
            try Task.checkCancellation()
            guard self.current(client, epoch: epoch) else { throw CancellationError() }
            // A full cache or a failed disk write must not prevent displaying a downloaded photo.
            try? await IOSChatImageDiskCache.shared.write(data, key: key, generation: epoch)
            return data
        })
        transfers[transferKey] = pending
        let data = try await consume(pending) { if self.transfers[transferKey]?.id == pending.id { self.transfers[transferKey] = nil } }
        try Task.checkCancellation()
        guard current(client, epoch: epoch) else { throw CancellationError() }; return data
    }
    /// A fresh message authorization remains the caller's responsibility.
    func export(_ url: URL, name: String, client: APIClient) async throws -> URL {
        let epoch = generation, data = try await original(url, client: client)
        guard current(client, epoch: epoch) else { throw CancellationError() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-media-\(UUID().uuidString)", isDirectory: true)
        let clean = (name.replacingOccurrences(of: "\\", with: "_") as NSString).lastPathComponent
            .components(separatedBy: .controlCharacters).joined().prefix(180)
        let file = directory.appendingPathComponent(clean.isEmpty || clean == "." || clean == ".." ? "图片.jpg" : String(clean))
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            try await Task.detached(priority: .userInitiated) {
                try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }.value
            try Task.checkCancellation()
            guard current(client, epoch: epoch) else { throw CancellationError() }; return file
        } catch { APIClient.removeDownloadedMedia(at: file); throw error }
    }
    private func posterKey(_ url: URL, client: APIClient) -> String {
        IOSChatImageCachePolicy.key(namespace: client.avatarCacheNamespace + "|video-poster-v1", url: url)
    }
    func cachedVideoPoster(_ url: URL, client: APIClient) -> UIImage? {
        guard Self.scope(APIClient.shared) == Self.scope(client) else { return nil }
        return images.object(forKey: (Self.scope(client) + "|poster|" + posterKey(url, client: client)) as NSString)
    }
    /// Legacy videos without a supplied cover use a cancellable first-frame read.
    /// Only the signed asset URL goes to AVFoundation; no bearer header is forwarded.
    func loadVideoPoster(_ url: URL, client: APIClient) async throws -> UIImage {
        let epoch = generation, diskKey = posterKey(url, client: client)
        let key = Self.scope(client) + "|poster|" + diskKey
        guard current(client, epoch: epoch) else { throw CancellationError() }
        if let image = cachedVideoPoster(url, client: client) { return image }
        let pending = posters[key] ?? Pending(task: Task<UIImage, Error> {
            if let data = await IOSChatImageDiskCache.shared.read(diskKey, generation: epoch), let image = UIImage(data: data) { return image }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true; generator.maximumSize = CGSize(width: 640, height: 640)
            let image = try await withThrowingTaskGroup(of: UIImage.self) { group in
                group.addTask {
                    try await withTaskCancellationHandler {
                        let result = try await generator.image(at: .zero)
                        return UIImage(cgImage: result.image)
                    } onCancel: { generator.cancelAllCGImageGeneration() }
                }
                group.addTask { try await Task.sleep(nanoseconds: 20_000_000_000); throw URLError(.timedOut) }
                defer { group.cancelAll() }
                guard let image = try await group.next() else { throw CancellationError() }; return image
            }
            try Task.checkCancellation(); guard self.current(client, epoch: epoch) else { throw CancellationError() }
            let data = await Task.detached(priority: .utility) { image.jpegData(compressionQuality: 0.8) }.value
            if let data { try? await IOSChatImageDiskCache.shared.write(data, key: diskKey, generation: epoch) }
            return image
        })
        posters[key] = pending
        let image = try await consume(pending) { if self.posters[key]?.id == pending.id { self.posters[key] = nil } }
        try Task.checkCancellation()
        guard current(client, epoch: epoch) else { throw CancellationError() }
        images.setObject(image, forKey: key as NSString, cost: (image.cgImage?.bytesPerRow ?? 0) * (image.cgImage?.height ?? 0))
        return image
    }
    func clear() {
        generation += 1
        transfers.values.forEach { $0.task.cancel() }; renders.values.forEach { $0.task.cancel() }
        posters.values.forEach { $0.task.cancel() }
        transfers.removeAll(); renders.removeAll(); posters.removeAll(); images.removeAllObjects()
        let epoch = generation
        Task { await IOSChatImageDiskCache.shared.clear(generation: epoch) }
    }
}
