import Foundation

/// Both the picker and the queue enforce the same limit. Avatars keep their own single picker.
enum IOSPhotoSelection {
    static let limit = 300
    static let maximumSourceBytes = 40 * 1024 * 1024
    static let maximumUploadBytes = 10 * 1024 * 1024
    static let maximumPixelSize = 1600
    static let preferredUploadBytes = 512 * 1024
    static func originalFormat(mime: String) -> (fileExtension: String, mime: String)? {
        switch mime {
        case "image/jpeg": return ("jpg", mime)
        case "image/png": return ("png", mime)
        case "image/gif": return ("gif", mime)
        case "image/webp": return ("webp", mime)
        default: return nil
        }
    }
}

struct IOSPreparedPhoto: Identifiable, Sendable {
    let id: UUID
    let fileURL: URL
    let width: Int
    let height: Int
    let mime: String
    let original: Bool
    var requestID: String { "ios-photo-\(id.uuidString)" }
    init(id: UUID, fileURL: URL, width: Int, height: Int, mime: String = "image/jpeg", original: Bool = false) {
        self.id = id; self.fileURL = fileURL; self.width = width; self.height = height
        self.mime = mime; self.original = original
    }
}

/// PhotoKit resources are streamed to disk with a strict bound. The lock also
/// serializes a late callback with task cancellation and file closure.
final class IOSBoundedPhotoFile: @unchecked Sendable {
    private let lock = NSLock()
    private var handle: FileHandle?
    private var bytes = 0
    private let maximumBytes: Int
    init(url: URL, maximumBytes: Int) throws {
        self.maximumBytes = maximumBytes
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        handle = try FileHandle(forWritingTo: url)
    }
    func append(_ data: Data) throws {
        lock.lock(); defer { lock.unlock() }
        guard let handle else { throw CancellationError() }
        guard data.count <= maximumBytes - bytes else {
            throw NSError(domain: "PulsePhoto", code: 413, userInfo: [NSLocalizedDescriptionKey: "原图不能超过10MB，请取消原图后发送。"])
        }
        try handle.write(contentsOf: data); bytes += data.count
    }
    func close() {
        lock.lock(); defer { lock.unlock() }
        try? handle?.close(); handle = nil
    }
    deinit { close() }
}

/// A draft owns only its own newly-created temporary directory. All copies of a
/// presentation/queue retain this owner until their outstanding work finishes.
final class IOSPhotoDraftFiles {
    let directory: URL
    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("pulse-photo-draft-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

/// Prepare/upload two photos ahead, while committing messages in selection order.
/// A retry reuses uploaded data and request IDs, including a prefetched photo.
@MainActor final class IOSPhotoSendQueue<Upload: Sendable> {
    let photos: [IOSPreparedPhoto]
    private(set) var nextIndex = 0
    private(set) var running = false
    private(set) var stopped = false
    private var cachedUpload: Upload?
    private struct PendingUpload { let attempt: Int; let task: Task<Upload, Error> }
    private var prefetch: [Int: PendingUpload] = [:]
    private var attempt = 0
    var completed: Bool { nextIndex == photos.count }

    init(photos: [IOSPreparedPhoto]) {
        self.photos = photos
    }
    func stop() { stopped = true; prefetch.values.forEach { $0.task.cancel() }; prefetch = [:] }

    func run<Receipt>(current: () -> Bool,
        upload: @escaping @MainActor (IOSPreparedPhoto) async throws -> Upload,
        send: (IOSPreparedPhoto, Upload, Int) async throws -> Receipt,
        accepted: (Receipt, Int) throws -> Void,
        progress: (Int, Int) -> Void) async throws {
        guard !running, !photos.isEmpty, photos.count <= IOSPhotoSelection.limit else { return }
        running = true; attempt += 1
        defer { running = false }
        func check() throws {
            try Task.checkCancellation()
            guard !stopped, current() else { throw CancellationError() }
        }
        while !completed {
            try check()
            let index = nextIndex, photo = photos[index]
            progress(index, photos.count)
            for candidate in index...min(index + 1, photos.count - 1) where prefetch[candidate] == nil && !(candidate == index && cachedUpload != nil) {
                let nextPhoto = photos[candidate]
                prefetch[candidate] = PendingUpload(attempt: attempt, task: Task { try Task.checkCancellation(); return try await upload(nextPhoto) })
            }
            if cachedUpload == nil {
                do {
                    guard let pending = prefetch[index] else { return }
                    let result: Upload
                    do { result = try await pending.task.value }
                    catch {
                        // A look-ahead upload may have failed before the user
                        // pressed Retry. Reuse successes; restart stale failures.
                        guard pending.attempt < attempt else { throw error }
                        try check(); result = try await upload(photo)
                    }
                    prefetch[index] = nil
                    try check(); cachedUpload = result
                } catch { prefetch[index] = nil; throw error }
            }
            guard let result = cachedUpload else { return }
            try check()
            let receipt = try await send(photo, result, index)
            try check()
            try accepted(receipt, index)
            nextIndex += 1
            cachedUpload = nil
            progress(nextIndex, photos.count)
        }
    }
}
