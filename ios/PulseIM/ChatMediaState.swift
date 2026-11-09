import Foundation
import CryptoKit

enum IOSChatMediaFailure: LocalizedError {
    case authorizationExpired, unavailable, invalidImage, httpStatus(Int)
    var errorDescription: String? {
        switch self {
        case .authorizationExpired: return "媒体链接已过期，正在更新"
        case .unavailable: return "该媒体已撤回、已清空或不可查看"
        case .invalidImage: return "图片内容无法读取，请重试"
        case .httpStatus: return "媒体暂时加载失败，请稍后重试"
        }
    }
}

struct IOSChatMediaDescriptor {
    enum Kind: String { case image, video }
    let messageID: Int
    let conversationID: Int
    let kind: Kind
    let rawURL: String
    let thumbnailURL: String?
    let createdAt: String
    let width: Double?
    let height: Double?
    let caption: String?

    init?(message: Message) {
        guard message.id > 0, message.conversationId > 0, message.recalledAt == nil, !["recalled", "deleted"].contains(message.status ?? ""),
              let raw = message.body["url"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return nil }
        let mime = message.body["mime"]?.stringValue?.lowercased() ?? ""
        if message.type == "image" { kind = .image }
        else if message.type == "video" || (message.type == "file" && mime.hasPrefix("video/")) { kind = .video }
        else { return nil }
        messageID = message.id; conversationID = message.conversationId; rawURL = raw
        thumbnailURL = ["thumbnail_url", "thumb_url"].compactMap { message.body[$0]?.stringValue }
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
        createdAt = message.createdAt
        let text = message.body["text"]?.stringValue ?? ""
        caption = kind == .image && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : nil
        if let field = message.body["width"], case .number(let value) = field, value.isFinite, value > 0 { width = value } else { width = nil }
        if let field = message.body["height"], case .number(let value) = field, value.isFinite, value > 0 { height = value } else { height = nil }
    }
    func refreshed(from page: MessageLocationPage) throws -> Self {
        guard page.targetId == messageID,
              let message = page.items.first(where: { $0.id == messageID && $0.conversationId == conversationID }),
              let value = Self(message: message), value.kind == kind else { throw IOSChatMediaFailure.unavailable }
        return value
    }
    /// A request includes the full current grant. Content cache identity remains stable across renewal.
    func requestID(scope: String, active: Bool, activation: UUID, generation: Int) -> String {
        let value = [scope, String(conversationID), String(messageID), kind.rawValue, rawURL, thumbnailURL ?? "",
                     String(active), activation.uuidString, String(generation)].joined(separator: "\0")
        return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    var timeText: String {
        IOSChatMessageDisplay.timeLabel(createdAt)
    }
    func fittedSize(width: Double? = nil, height: Double? = nil) -> (width: Double, height: Double) {
        guard let w = width ?? self.width, let h = height ?? self.height,
              w.isFinite, h.isFinite, w > 0, h > 0 else { return (230, 172.5) }
        let scale = min(230 / w, 280 / h)
        return (max(1, w * scale), max(1, h * scale))
    }
}

/// Bounded recovery, shared by thumbnails and video opening. Cancellation never
/// becomes a sticky failed state and never refreshes another account's grant.
enum IOSChatMediaLoader {
    static func needsFreshGrant(_ error: Error) -> Bool {
        if case IOSChatMediaFailure.authorizationExpired = error { return true }
        // AVFoundation reports expired signed asset URLs as an asset-loading error.
        return (error as NSError).domain == "AVFoundationErrorDomain"
    }
    static func isCancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
    static func mayRetry(_ error: Error) -> Bool {
        if case IOSChatMediaFailure.invalidImage = error { return true }
        if case IOSChatMediaFailure.httpStatus(let status) = error { return status == 408 || status == 429 || status >= 500 }
        guard let code = (error as? URLError)?.code else { return false }
        return [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(code)
    }
    @MainActor static func load<Value>(source: IOSChatMediaDescriptor, current: () -> Bool,
        operation: (IOSChatMediaDescriptor) async throws -> Value,
        refresh: () async throws -> IOSChatMediaDescriptor,
        discard: (Value) -> Void = { _ in },
        wait: (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }) async throws -> Value {
        var source = source, refreshed = false
        for attempt in 0..<3 {
            try Task.checkCancellation(); guard current() else { throw CancellationError() }
            do {
                let value = try await operation(source)
                if Task.isCancelled || !current() { discard(value); throw CancellationError() }; return value
            } catch {
                if Task.isCancelled || isCancelled(error) || !current() { throw CancellationError() }
                guard attempt < 2 else { throw error }
                if needsFreshGrant(error), !refreshed {
                    source = try await refresh(); refreshed = true
                    try Task.checkCancellation(); guard current() else { throw CancellationError() }
                } else if !mayRetry(error) { throw error }
                try await wait(attempt == 0 ? 350_000_000 : 1_000_000_000)
            }
        }
        throw IOSChatMediaFailure.unavailable
    }
}
