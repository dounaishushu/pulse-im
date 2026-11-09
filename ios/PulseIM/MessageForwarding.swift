import Foundation

enum IOSMessageForwardError: LocalizedError {
    case empty, tooMany, unavailable
    var errorDescription: String? {
        switch self {
        case .empty: return "请先选择消息"
        case .tooMany: return "一次最多选择 100 条消息"
        case .unavailable: return "原消息已不可转发，请取消后重新选择"
        }
    }
}

enum IOSMessageForwarding {
    private static let fields: [String: Set<String>] = [
        "text": ["text"], "contact_card": ["user_id"],
        "image": ["url", "text", "mime", "size", "name", "width", "height", "original"],
        "video": ["url", "thumbnail_url", "text", "mime", "size", "name", "width", "height", "duration_ms"],
        "file": ["url", "text", "mime", "size", "name", "file_name", "original_name"],
        "voice": ["url", "mime", "size", "name", "duration_ms"]
    ]
    static func supported(_ message: Message) -> Bool {
        message.id > 0 && fields[message.type] != nil && message.recalledAt == nil && message.status != "recalled"
    }
    static func body(_ message: Message) throws -> [String: JSONValue] {
        guard supported(message), let allowed = fields[message.type] else { throw IOSMessageForwardError.unavailable }
        return message.body.filter { allowed.contains($0.key) }
    }
    static func targetAllowed(_ target: Conversation) -> Bool {
        target.id > 0 && ["direct", "group", "channel", "customer_service", "favorites"].contains(target.type) && target.canPublish
            && (target.frozenAt == nil || target.frozenAt?.isEmpty == true) && target.status != "frozen"
            && (target.type != "channel" || target.myRole == nil || ["owner", "admin"].contains(target.myRole ?? ""))
    }
}

struct IOSForwardMessage {
    let sourceID: Int
    let type: String
    let body: [String: JSONValue]
    let requestID: String
}

struct IOSMessageForwardBatch {
    let items: [IOSForwardMessage]
    private(set) var completed = 0
    var pending: IOSForwardMessage? { completed < items.count ? items[completed] : nil }
    init(messages: [Message]) throws {
        let unique = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }).values.sorted { $0.id < $1.id }
        guard !unique.isEmpty else { throw IOSMessageForwardError.empty }
        guard unique.count <= 100 else { throw IOSMessageForwardError.tooMany }
        items = try unique.map { IOSForwardMessage(sourceID: $0.id, type: $0.type, body: try IOSMessageForwarding.body($0), requestID: "ios-forward-\(UUID().uuidString)") }
    }
    @discardableResult mutating func acknowledge(requestID: String) -> Bool {
        guard pending?.requestID == requestID else { return false }
        completed += 1; return true
    }
}

struct IOSForwardPresentation: Identifiable {
    let id = UUID()
    let batch: IOSMessageForwardBatch
}

struct IOSForwardConversationPage: Decodable {
    let items: [Conversation]
    let total: Int?
    let page: Int?
    let size: Int?
}
