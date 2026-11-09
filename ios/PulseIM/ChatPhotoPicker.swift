import SwiftUI
import PhotosUI
import Photos
import UniformTypeIdentifiers
import ImageIO
import UIKit
import AVFoundation

/// System fallback when album access is declined. Selection is sent directly.
struct IOSSystemPhotoPicker: UIViewControllerRepresentable {
    let onSelection: ([NSItemProvider]) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onSelection: onSelection) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = IOSPhotoSelection.limit
        configuration.selection = .ordered
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ picker: PHPickerViewController, context: Context) {}
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onSelection: ([NSItemProvider]) -> Void
        private var completed = false
        init(onSelection: @escaping ([NSItemProvider]) -> Void) { self.onSelection = onSelection }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !completed else { return }; completed = true
            onSelection(Array(results.prefix(IOSPhotoSelection.limit)).map(\.itemProvider))
        }
    }
}

enum IOSPhotoPreparationFailure: LocalizedError {
    case unreadable, tooLarge, encode, timedOut
    var errorDescription: String? {
        switch self {
        case .unreadable: return "图片无法读取，请重新选择，或先将 iCloud 图片下载到手机。"
        case .tooLarge: return "图片文件过大，请选择其他图片。"
        case .encode: return "图片处理失败，请重新选择。"
        case .timedOut: return "从相册读取图片超时，请先下载到手机后重试。"
        }
    }
}

/// Provider/PhotoKit callbacks and task cancellation can arrive on different
/// queues. Resume once, including cancellation before a request ID exists.
private final class IOSPhotoReadState<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var result: Result<Value, Error>?
    private var cancelAction: (() -> Void)?
    private var cancelled = false
    func install(_ continuation: CheckedContinuation<Value, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result) }
        else { self.continuation = continuation; lock.unlock() }
    }
    @discardableResult func finish(_ value: Result<Value, Error>) -> Bool {
        lock.lock(); guard result == nil else { lock.unlock(); return false }
        result = value; let waiting = continuation; continuation = nil; cancelAction = nil
        lock.unlock(); waiting?.resume(with: value)
        return true
    }
    func setCancel(_ action: @escaping () -> Void) {
        lock.lock(); let stop = cancelled
        if result == nil { cancelAction = action }; lock.unlock()
        if stop { action() }
    }
    func cancel(_ error: Error = CancellationError()) {
        lock.lock(); cancelled = true; let stop = cancelAction; lock.unlock()
        finish(.failure(error)); stop?()
    }
}

/// A video-only system album, independent of broad photo-library access.
struct IOSSystemVideoPicker: UIViewControllerRepresentable {
    let onSelection: (NSItemProvider?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onSelection: onSelection) }
    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .videos; configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator; return picker
    }
    func updateUIViewController(_ picker: PHPickerViewController, context: Context) {}
    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onSelection: (NSItemProvider?) -> Void
        private var completed = false
        init(onSelection: @escaping (NSItemProvider?) -> Void) { self.onSelection = onSelection }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !completed else { return }; completed = true
            onSelection(results.first?.itemProvider)
        }
    }
}

struct IOSPreparedVideo {
    let id = UUID()
    let fileURL: URL
    let mime: String
    let size: Int
    let files: IOSPhotoDraftFiles
}

enum IOSVideoPreparationFailure: LocalizedError {
    case unreadable, tooLarge, timedOut
    var errorDescription: String? {
        switch self {
        case .unreadable: return "视频无法读取，请重新选择，或先将 iCloud 视频下载到手机。"
        case .tooLarge: return "视频文件不能超过100MB。"
        case .timedOut: return "从相册读取视频超时，请先下载到手机后重试。"
        }
    }
}

enum IOSVideoPreparation {
    static func prepare(_ provider: NSItemProvider) async throws -> IOSPreparedVideo {
        try Task.checkCancellation()
        guard provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) else { throw IOSVideoPreparationFailure.unreadable }
        let files = try IOSPhotoDraftFiles(), state = IOSPhotoReadState<URL>()
        let timeout = Task { try? await Task.sleep(nanoseconds: 180_000_000_000); if !Task.isCancelled { state.cancel(IOSVideoPreparationFailure.timedOut) } }
        defer { timeout.cancel() }
        let copied = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                state.install(continuation)
                let progress = provider.loadFileRepresentation(forTypeIdentifier: UTType.movie.identifier) { url, error in
                    do {
                        guard let url else { throw error ?? IOSVideoPreparationFailure.unreadable }
                        let info = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                        guard info.isRegularFile == true, let size = info.fileSize, size > 0 else { throw IOSVideoPreparationFailure.unreadable }
                        guard IOSVideoSelection.accepts(byteCount: size) else { throw IOSVideoPreparationFailure.tooLarge }
                        let hint = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
                            .first(where: { $0.conforms(to: .movie) })?.preferredFilenameExtension
                        guard let format = IOSVideoSelection.format(filenameExtension: url.pathExtension)
                            ?? hint.flatMap({ IOSVideoSelection.format(filenameExtension: $0) }) else { throw IOSVideoPreparationFailure.unreadable }
                        let destination = files.directory.appendingPathComponent("\(UUID().uuidString).\(format.fileExtension)")
                        // Provider URLs expire as soon as this callback returns.
                        try FileManager.default.copyItem(at: url, to: destination)
                        if !state.finish(.success(destination)) { try? FileManager.default.removeItem(at: destination) }
                    } catch { state.finish(.failure(error)) }
                }
                state.setCancel { progress.cancel() }
            }
        }, onCancel: { state.cancel() })
        try Task.checkCancellation()
        let tracks = try await AVURLAsset(url: copied).loadTracks(withMediaType: .video)
        guard !tracks.isEmpty, let format = IOSVideoSelection.format(filenameExtension: copied.pathExtension) else { throw IOSVideoPreparationFailure.unreadable }
        let size = try copied.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard IOSVideoSelection.accepts(byteCount: size) else { throw IOSVideoPreparationFailure.tooLarge }
        return IOSPreparedVideo(fileURL: copied, mime: format.mime, size: size, files: files)
    }
    static func data(_ video: IOSPreparedVideo) async throws -> Data {
        let task = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let size = try video.fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard IOSVideoSelection.accepts(byteCount: size) else { throw IOSVideoPreparationFailure.tooLarge }
            let data = try Data(contentsOf: video.fileURL, options: .mappedIfSafe)
            try Task.checkCancellation(); return data
        }
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }
}

enum IOSPhotoPreparation {
    static func prepare(_ input: IOSChatPhotoSource, files: IOSPhotoDraftFiles, id: UUID = UUID()) async throws -> IOSPreparedPhoto {
        try Task.checkCancellation()
        let source = files.directory.appendingPathComponent("\(id.uuidString).source")
        defer { try? FileManager.default.removeItem(at: source) }
        switch input {
        case .provider(let provider): try await copyProvider(provider, to: source)
        case .asset(let asset):
            let data = try await assetData(asset)
            guard !data.isEmpty, data.count <= IOSPhotoSelection.maximumSourceBytes else { throw IOSPhotoPreparationFailure.tooLarge }
            let copy = Task.detached(priority: .userInitiated) { try Task.checkCancellation(); try data.write(to: source, options: .atomic) }
            try await withTaskCancellationHandler(operation: { try await copy.value }, onCancel: { copy.cancel() })
        }
        try Task.checkCancellation()
        let destination = files.directory.appendingPathComponent("\(id.uuidString).jpg")
        let work = Task.detached(priority: .userInitiated) {
            try autoreleasepool {
                guard let source = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceShouldCacheImmediately: true,
                        kCGImageSourceThumbnailMaxPixelSize: IOSPhotoSelection.maximumPixelSize
                      ] as CFDictionary), image.width > 0, image.height > 0 else { throw IOSPhotoPreparationFailure.unreadable }
                var edge = IOSPhotoSelection.maximumPixelSize
                var quality = 0.82
                while true {
                    try Task.checkCancellation()
                    let ratio = min(1, Double(edge) / Double(max(image.width, image.height)))
                    let width = max(1, Int(Double(image.width) * ratio)), height = max(1, Int(Double(image.height) * ratio))
                    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
                          let encoder = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
                    else { throw IOSPhotoPreparationFailure.encode }
                    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.interpolationQuality = .high
                    let rect = CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
                    context.fill(rect); context.draw(image, in: rect)
                    guard let flattened = context.makeImage() else { throw IOSPhotoPreparationFailure.encode }
                    CGImageDestinationAddImage(encoder, flattened, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
                    guard CGImageDestinationFinalize(encoder) else { throw IOSPhotoPreparationFailure.encode }
                    let bytes = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard bytes > 0 else { throw IOSPhotoPreparationFailure.encode }
                    if bytes <= IOSPhotoSelection.preferredUploadBytes {
                        return IOSPreparedPhoto(id: id, fileURL: destination, width: width, height: height)
                    }
                    if quality > 0.7 { quality = 0.7 }
                    else { edge = Int(Double(edge) * 0.8); quality = 0.82 }
                    guard edge >= 256 else { throw IOSPhotoPreparationFailure.tooLarge }
                }
            }
        }
        return try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
    }

    private static func copyProvider(_ provider: NSItemProvider, to destination: URL) async throws {
        guard provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { throw IOSPhotoPreparationFailure.unreadable }
        let state = IOSPhotoReadState<URL>()
        let timeout = Task { try? await Task.sleep(nanoseconds: 90_000_000_000); if !Task.isCancelled { state.cancel(IOSPhotoPreparationFailure.timedOut) } }
        defer { timeout.cancel() }
        _ = try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                state.install(continuation)
                let progress = provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
                    do {
                        if let error { throw error }; guard let url else { throw IOSPhotoPreparationFailure.unreadable }
                        let info = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                        guard info.isRegularFile == true, let bytes = info.fileSize, bytes > 0, bytes <= IOSPhotoSelection.maximumSourceBytes else { throw IOSPhotoPreparationFailure.tooLarge }
                        try FileManager.default.copyItem(at: url, to: destination)
                        state.finish(.success(destination))
                    } catch { state.finish(.failure(error)) }
                }
                state.setCancel { progress.cancel() }
            }
        }, onCancel: { state.cancel() })
    }
    private static func assetData(_ asset: PHAsset) async throws -> Data {
        let state = IOSPhotoReadState<Data>()
        let timeout = Task { try? await Task.sleep(nanoseconds: 90_000_000_000); if !Task.isCancelled { state.cancel(IOSPhotoPreparationFailure.timedOut) } }
        defer { timeout.cancel() }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
                state.install(continuation)
                let options = PHImageRequestOptions(); options.isNetworkAccessAllowed = true; options.deliveryMode = .highQualityFormat; options.version = .current
                let request = PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, _, _, info in
                    if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                    if let data { state.finish(.success(data)) }
                    else { state.finish(.failure((info?[PHImageErrorKey] as? Error) ?? IOSPhotoPreparationFailure.unreadable)) }
                }
                state.setCancel { PHImageManager.default().cancelImageRequest(request) }
            }
        }, onCancel: { state.cancel() })
    }
    static func preview(_ url: URL, maximumPixelSize: Int = 1600) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: maximumPixelSize
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

