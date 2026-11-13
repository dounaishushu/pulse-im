import Foundation

enum PublicUserIdentityError: Error, LocalizedError {
    case invalid, notFound, invalidResponse, unsupported
    var errorDescription: String? {
        switch self {
        case .invalid: return "用户 ID 或二维码无效"
        case .notFound: return "没有找到该用户"
        case .invalidResponse: return "用户查询结果不匹配，请重试"
        case .unsupported: return "二维码内容不受支持"
        }
    }
}

/// Public identifiers are server-owned strings. Internal relationship IDs stay Int.
enum PublicUserIdentity {
    enum QRTarget: Equatable { case publicUser(String), legacyUser(Int), group(Int) }

    static func isValid(_ value: String?) -> Bool {
        guard let value else { return false }
        let bytes = Array(value.utf8)
        if bytes.count == 32 {
            return bytes.allSatisfy { (48...57).contains($0) || (65...70).contains($0) }
        }
        guard bytes.count == 16 else { return false }
        var upper = false, lower = false, digit = false
        for byte in bytes {
            switch byte {
            case 65...90: upper = true
            case 97...122: lower = true
            case 48...57: digit = true
            default: return false
            }
        }
        return upper && lower && digit
    }

    static func display(_ value: String?) -> String {
        guard let value, isValid(value) else { return "未就绪" }
        return value
    }

    static func qrPayload(_ value: String?) -> String? {
        guard isValid(value) else { return nil }
        var components = URLComponents()
        components.scheme = "pulse"; components.host = "add-friend"
        components.queryItems = [URLQueryItem(name: "public_id", value: value)]
        return components.url?.absoluteString
    }

    static func searchPath(_ value: String) throws -> String {
        guard isValid(value) else { throw PublicUserIdentityError.invalid }
        var components = URLComponents()
        components.path = "/contacts/search"
        components.queryItems = [URLQueryItem(name: "public_id", value: value)]
        guard let path = components.string else { throw PublicUserIdentityError.invalid }
        return path
    }

    static func parseQRCode(_ code: String) throws -> QRTarget {
        guard let components = URLComponents(string: code), components.scheme == "pulse",
              let host = components.host, components.user == nil, components.password == nil,
              components.port == nil, components.fragment == nil else { throw PublicUserIdentityError.invalid }
        guard ["add-friend", "user", "group"].contains(host) else { throw PublicUserIdentityError.unsupported }
        if host == "add-friend", !components.path.isEmpty && components.path != "/" { throw PublicUserIdentityError.invalid }
        if host != "group" {
            let publicItems = (components.queryItems ?? []).filter { $0.name == "public_id" }
            if !publicItems.isEmpty {
                guard publicItems.count == 1, let value = publicItems[0].value, isValid(value) else { throw PublicUserIdentityError.invalid }
                return .publicUser(value)
            }
        }
        let rawID: String?
        if host == "add-friend" {
            let items = (components.queryItems ?? []).filter { $0.name == "user_id" }
            guard items.count == 1 else { throw PublicUserIdentityError.invalid }
            rawID = items[0].value
        } else {
            let path = components.path.split(separator: "/")
            guard path.count == 1 else { throw PublicUserIdentityError.invalid }
            rawID = String(path[0])
        }
        guard let rawID, !rawID.isEmpty, rawID.utf8.allSatisfy({ (48...57).contains($0) }),
              let id = Int(rawID), id > 0 else { throw PublicUserIdentityError.invalid }
        return host == "group" ? .group(id) : .legacyUser(id)
    }
}

struct PublicUserSearchPage: Decodable {
    let items: [SearchUser]
    let total: Int
    let page: Int
    let size: Int

    func resolve(publicID: String) throws -> SearchUser {
        guard PublicUserIdentity.isValid(publicID), page == 1, size == 1 else { throw PublicUserIdentityError.invalidResponse }
        if total == 0 && items.isEmpty { throw PublicUserIdentityError.notFound }
        guard total == 1, items.count == 1, let user = items.first, user.id > 0,
              user.publicID == publicID else { throw PublicUserIdentityError.invalidResponse }
        return user
    }
}

struct WorkTaskPage: Decodable {
    let date: String
    let employeeType: String
    let items: [WorkTask]
    enum CodingKeys: String, CodingKey { case date, items; case employeeType = "employee_type" }
}

struct WorkTask: Decodable, Identifiable {
    let id: Int
    let name: String
    let openTime: String
    let estimatedMinutes: Int
    let description: String
    let internUnitPrice: Double
    let formalUnitPrice: Double
    let questionCount: Int
    let status: String
    let statusLabel: String
    let record: WorkTaskRecord?
    enum CodingKeys: String, CodingKey {
        case id, name, description, status, record
        case openTime = "open_time", estimatedMinutes = "estimated_minutes"
        case internUnitPrice = "intern_unit_price", formalUnitPrice = "formal_unit_price", questionCount = "question_count", statusLabel = "status_label"
    }
}

struct WorkTaskRecord: Decodable, Identifiable {
    let id: Int
    let userID: Int
    let nickname: String
    let avatarURL: String
    let taskName: String
    let taskDate: String
    let employeeType: String
    let status: String
    let statusLabel: String
    let startAt: String
    let submittedAt: String
    let reviewedAt: String
    let durationSeconds: Int
    let totalQuestions: Int
    let correctCount: Int
    let wrongCount: Int
    let unitPrice: Double
    let wage: Double
    let reviewNote: String
    enum CodingKeys: String, CodingKey {
        case id, nickname, status, wage
        case userID = "user_id", avatarURL = "avatar_url", taskName = "task_name", taskDate = "task_date", employeeType = "employee_type", statusLabel = "status_label"
        case startAt = "start_at", submittedAt = "submitted_at", reviewedAt = "reviewed_at", durationSeconds = "duration_seconds"
        case totalQuestions = "total_questions", correctCount = "correct_count", wrongCount = "wrong_count", unitPrice = "unit_price", reviewNote = "review_note"
    }
    var durationText: String { "\(durationSeconds / 60)分\(durationSeconds % 60)秒" }
}

struct WorkQuestion: Decodable, Identifiable {
    let questionUUID: String
    let imageURL: String
    let answer: Bool?
    let correctAnswer: Bool?
    let reviewedCorrect: Bool?
    var id: String { questionUUID }
    enum CodingKeys: String, CodingKey {
        case answer
        case questionUUID = "question_uuid", imageURL = "image_url", correctAnswer = "correct_answer", reviewedCorrect = "reviewed_correct"
    }
}

struct WorkTaskPayload: Decodable, Identifiable {
    let record: WorkTaskRecord
    let questions: [WorkQuestion]
    var id: Int { record.id }
    var hasCompleteSettlement: Bool {
        let total = record.totalQuestions
        guard record.status == "reviewed", ["intern", "formal"].contains(record.employeeType),
              total > 0, total <= 1000, record.correctCount >= 0, record.wrongCount >= 0,
              record.correctCount <= total, record.wrongCount == total - record.correctCount,
              record.unitPrice.isFinite, record.unitPrice >= 0, record.wage.isFinite, record.wage >= 0,
              abs(record.wage - Double(record.correctCount) * record.unitPrice) < 0.000001,
              questions.count == total, Set(questions.map(\.id)).count == total,
              questions.allSatisfy({ !$0.id.isEmpty && $0.answer != nil && $0.reviewedCorrect != nil }) else { return false }
        return questions.filter { $0.reviewedCorrect == true }.count == record.correctCount
    }
}

struct APIEnvelope<T: Decodable>: Decodable { let ok: Bool; let data: T?; let error: APIError? }
struct APIError: Decodable { let message: String }
struct LoginData: Decodable { let accessToken: String; let userId: Int; let publicID: String?; var avatarURL: String? = nil; enum CodingKeys: String, CodingKey { case accessToken = "access_token", userId = "user_id", publicID = "public_id", avatarURL = "avatar_url" } }
struct User: Decodable, Identifiable {
    let id: Int
    let nickname: String
    let phone: String?
    let avatarURL: String?
    let username: String?
    let birthday: String?
    let birthdayChangeCount: Int?
    let gender: String?
    let signature: String?
    let status: String?
    let internalStaff: Bool
    let formalEmployee: Bool
    let publicID: String?
    enum CodingKeys: String, CodingKey {
        case id, nickname, phone, username, birthday, gender, signature, status
        case avatarURL = "avatar_url"
        case birthdayChangeCount = "birthday_change_count"
        case internalStaff = "internal_staff"
        case formalEmployee = "formal_employee"
        case publicID = "public_id"
    }
}
struct SessionInfo: Decodable, Identifiable { let id: Int; let deviceType: String; let createdAt: String; let lastUsedAt: String?; let isCurrent: Bool; enum CodingKeys: String, CodingKey { case id; case deviceType = "device_type"; case createdAt = "created_at"; case lastUsedAt = "last_used_at"; case isCurrent = "is_current" } }
struct BlockedUser: Decodable, Identifiable {
    let blockedId: Int
    let nickname: String?
    let username: String?
    let avatarURL: String?
    let reason: String?
    let publicID: String?
    enum CodingKeys: String, CodingKey {
        case blockedId = "blocked_id"
        case nickname, username, reason
        case avatarURL = "avatar_url"
        case publicID = "public_id"
    }
    var id: Int { blockedId }
}
struct BlockCandidate: Decodable, Identifiable {
    let userId: Int
    let nickname: String
    let username: String?
    let avatarURL: String?
    let publicID: String?
    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case nickname, username
        case avatarURL = "avatar_url"
        case publicID = "public_id"
    }
    var id: Int { userId }
}
struct Contact: Decodable, Identifiable {
    let userId: Int
    let nickname: String
    let username: String?
    let phone: String?
    let avatarURL: String?
    let remark: String?
    let groupName: String?
    let online: Bool?
    let lastSeenAt: String?
    let publicID: String?
    enum CodingKeys: String, CodingKey {
        case userId = "user_id", publicID = "public_id"
        case nickname, username, phone, remark
        case groupName = "group_name", avatarURL = "avatar_url", lastSeenAt = "last_seen_at"
        case online
    }
    var id: Int { userId }
}

struct ContactNameRecord: Decodable, Equatable {
    let userId: Int
    let nickname: String
    let remark: String
    enum CodingKeys: String, CodingKey { case userId = "user_id", nickname, remark }
    var displayName: String {
        let value = remark.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nickname : value
    }
}
struct ContactNamePage: Decodable {
    let items: [ContactNameRecord]
    let total: Int
    let page: Int
    let size: Int
    func isValid(expectedPage: Int) -> Bool {
        page == expectedPage && page > 0 && (1...100).contains(size) && total >= 0 && items.count <= size &&
            items.allSatisfy { $0.userId > 0 } && Set(items.map(\.userId)).count == items.count
    }
    var hasMore: Bool { total > 0 && page > 0 && size > 0 && page <= (total - 1) / size }
}

struct ContactCardContactPage: Decodable {
    let items: [Contact]
    let total: Int
    let page: Int
    let size: Int
    func isValid(expectedPage: Int) -> Bool { expectedPage > 0 && page == expectedPage && (1...100).contains(size) && total >= 0 && items.count <= size }
    var hasMore: Bool { !items.isEmpty && page > 0 && size > 0 && page <= Int.max / size && page * size < total }
}
extension Contact {
    var contactCardDisplayName: String { let value = remark?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""; return value.isEmpty ? nickname : value }
    func matchesContactCardQuery(_ raw: String) -> Bool {
        let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty || [nickname, remark ?? "", username ?? "", publicID ?? ""].contains { $0.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]) != nil }
    }
}
struct ContactProfile: Decodable {
    let canAddFriend: Bool?
    let userId: Int
    let nickname: String
    let phone: String?
    let avatarURL: String?
    let internalStaff: Bool
    let remark: String?
    let groupName: String?
    let addedAt: String?
    let status: String?
    let online: Bool
    let lastSeenAt: String?
    let lastLoginAt: String?
    let lastLoginDevice: String?
    let lastLoginIP: String?
    let ipLocation: String?
    let username: String?
    let isContact: Bool?
    let blockedByMe: Bool?
    let commonGroupCount: Int?
    let friendSourceLabel: String?
    let gender: String?
    let lastSeenHidden: Bool?
    let publicID: String?

    enum CodingKeys: String, CodingKey {
        case canAddFriend = "can_add_friend"
        case userId = "user_id"
        case nickname, phone, remark, status, online, username, gender
        case lastSeenAt = "last_seen_at"
        case groupName = "group_name"
        case avatarURL = "avatar_url"
        case internalStaff = "internal_staff"
        case addedAt = "added_at"
        case lastLoginAt = "last_login_at"
        case lastLoginDevice = "last_login_device"
        case lastLoginIP = "last_login_ip"
        case ipLocation = "ip_location"
        case isContact = "is_contact", blockedByMe = "blocked_by_me"
        case commonGroupCount = "common_group_count", friendSourceLabel = "friend_source_label"
        case lastSeenHidden = "last_seen_hidden"
        case publicID = "public_id"
    }

    init(userId: Int, nickname: String, phone: String? = nil, avatarURL: String? = nil, internalStaff: Bool = false,
         remark: String? = nil, groupName: String? = nil, addedAt: String? = nil, status: String? = nil, online: Bool = false,
         lastSeenAt: String? = nil, lastLoginAt: String? = nil, lastLoginDevice: String? = nil, lastLoginIP: String? = nil, ipLocation: String? = nil,
         username: String? = nil, isContact: Bool? = nil, blockedByMe: Bool? = nil, commonGroupCount: Int? = nil,
         friendSourceLabel: String? = nil, gender: String? = nil, lastSeenHidden: Bool? = nil, publicID: String? = nil, canAddFriend: Bool? = nil) {
        self.canAddFriend = canAddFriend
        self.userId = userId; self.nickname = nickname; self.phone = phone; self.avatarURL = avatarURL; self.internalStaff = internalStaff
        self.remark = remark; self.groupName = groupName; self.addedAt = addedAt; self.status = status; self.online = online
        self.lastSeenAt = lastSeenAt; self.lastLoginAt = lastLoginAt; self.lastLoginDevice = lastLoginDevice; self.lastLoginIP = lastLoginIP; self.ipLocation = ipLocation
        self.username = username; self.isContact = isContact; self.blockedByMe = blockedByMe; self.commonGroupCount = commonGroupCount
        self.friendSourceLabel = friendSourceLabel; self.gender = gender; self.lastSeenHidden = lastSeenHidden
        self.publicID = publicID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        canAddFriend = try values.decodeIfPresent(Bool.self, forKey: .canAddFriend)
        userId = try values.decode(Int.self, forKey: .userId); nickname = try values.decode(String.self, forKey: .nickname)
        phone = try values.decodeIfPresent(String.self, forKey: .phone); avatarURL = try values.decodeIfPresent(String.self, forKey: .avatarURL)
        internalStaff = try values.decodeIfPresent(Bool.self, forKey: .internalStaff) ?? false
        remark = try values.decodeIfPresent(String.self, forKey: .remark); groupName = try values.decodeIfPresent(String.self, forKey: .groupName)
        addedAt = try values.decodeIfPresent(String.self, forKey: .addedAt); status = try values.decodeIfPresent(String.self, forKey: .status)
        online = try values.decodeIfPresent(Bool.self, forKey: .online) ?? false
        lastSeenAt = try values.decodeIfPresent(String.self, forKey: .lastSeenAt); lastLoginAt = try values.decodeIfPresent(String.self, forKey: .lastLoginAt)
        lastLoginDevice = try values.decodeIfPresent(String.self, forKey: .lastLoginDevice); lastLoginIP = try values.decodeIfPresent(String.self, forKey: .lastLoginIP)
        ipLocation = try values.decodeIfPresent(String.self, forKey: .ipLocation); username = try values.decodeIfPresent(String.self, forKey: .username)
        isContact = try values.decodeIfPresent(Bool.self, forKey: .isContact); blockedByMe = try values.decodeIfPresent(Bool.self, forKey: .blockedByMe)
        commonGroupCount = try values.decodeIfPresent(Int.self, forKey: .commonGroupCount)
        friendSourceLabel = try values.decodeIfPresent(String.self, forKey: .friendSourceLabel); gender = try values.decodeIfPresent(String.self, forKey: .gender)
        lastSeenHidden = try values.decodeIfPresent(Bool.self, forKey: .lastSeenHidden)
        publicID = try values.decodeIfPresent(String.self, forKey: .publicID)
    }
}

struct ContactCommonGroupsPage: Decodable {
    let items: [Conversation]
    let total: Int
    let page: Int
    let size: Int
    var hasMore: Bool { total > 0 && page <= (total - 1) / size }
    enum CodingKeys: String, CodingKey { case items, total, page, size }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decode([Conversation].self, forKey: .items); total = try values.decode(Int.self, forKey: .total)
        page = try values.decode(Int.self, forKey: .page); size = try values.decode(Int.self, forKey: .size)
        var ids = Set<Int>()
        guard total >= 0, page > 0, (1...50).contains(size), items.count <= size,
              items.allSatisfy({ $0.id > 0 && $0.type == "group" && ids.insert($0.id).inserted }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid common group page"))
        }
    }
}

struct SharedMediaPage: Decodable {
    let conversationId: Int
    let clearedBeforeMessageId: Int
    let items: [Message]
    let total: Int
    let page: Int
    let size: Int
    var hasMore: Bool { total > 0 && page <= (total - 1) / size }
    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id", clearedBeforeMessageId = "cleared_before_message_id"
        case items, total, page, size
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try values.decode(Int.self, forKey: .conversationId)
        clearedBeforeMessageId = try values.decode(Int.self, forKey: .clearedBeforeMessageId)
        items = try values.decode([Message].self, forKey: .items); total = try values.decode(Int.self, forKey: .total)
        page = try values.decode(Int.self, forKey: .page); size = try values.decode(Int.self, forKey: .size)
        var ids = Set<Int>()
        guard conversationId > 0, clearedBeforeMessageId >= 0, total >= 0, page > 0, (1...50).contains(size), items.count <= size,
              items.allSatisfy({ $0.id > clearedBeforeMessageId && $0.conversationId == conversationId && ["image", "video", "file"].contains($0.type)
                  && $0.recalledAt == nil && $0.status != "recalled" && ids.insert($0.id).inserted }) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid shared media page"))
        }
    }
    /// Apply the largest watermark already seen, including when an older page
    /// request completes after a later response advanced personal history clearing.
    func visibleItems(clearedBefore: Int = 0) -> [Message] {
        let cutoff = max(clearedBeforeMessageId, clearedBefore)
        return items.filter { $0.id > cutoff }.map { message in
            guard let sourceID = message.replyReference?.id ?? message.body["reply_to_id"]?.intValue, sourceID <= cutoff else { return message }
            var body = message.body
            body["reply_to"] = .object(["id": .number(Double(sourceID)), "unavailable": .bool(true)])
            return Message(id: message.id, conversationId: message.conversationId, senderId: message.senderId, type: message.type,
                           body: body, createdAt: message.createdAt, recalledAt: message.recalledAt, editedAt: message.editedAt, status: message.status, senderName: message.senderName, senderAvatarURL: message.senderAvatarURL)
        }
    }
}
struct InternalProfileData: Decodable {
    let userId: Int
    let nickname: String
    let registerIP: String?
    let registerIPLocation: String?
    let lastLoginIP: String?
    let lastLoginLocation: String?
    let lastLoginAt: String?
    let lastLoginDevice: String?
    let publicID: String?
    enum CodingKeys: String, CodingKey {
        case userId = "user_id", nickname
        case registerIP = "register_ip", registerIPLocation = "register_ip_location"
        case lastLoginIP = "last_login_ip", lastLoginLocation = "last_login_location"
        case lastLoginAt = "last_login_at", lastLoginDevice = "last_login_device"
        case publicID = "public_id"
    }
}
struct SearchUser: Decodable, Identifiable { let id: Int; let nickname: String; let username: String?; let phone: String?; let avatarURL: String?; let publicID: String?; enum CodingKeys: String, CodingKey { case id, nickname, username, phone; case avatarURL = "avatar_url", publicID = "public_id" } }

struct IOSReceivedContactCardProfile: Decodable {
    let user: SearchUser
    let isContact: Bool
    let canAddFriend: Bool
    let restriction: String?
    let conversationID: Int
    let messageID: Int
    enum CodingKeys: String, CodingKey {
        case isContact = "is_contact", canAddFriend = "can_add_friend", restriction = "add_friend_restriction"
        case conversationID = "source_conversation_id", messageID = "source_message_id"
    }
    init(from decoder: Decoder) throws {
        user = try SearchUser(from: decoder)
        let values = try decoder.container(keyedBy: CodingKeys.self)
        isContact = try values.decode(Bool.self, forKey: .isContact)
        canAddFriend = try values.decode(Bool.self, forKey: .canAddFriend)
        restriction = try values.decodeIfPresent(String.self, forKey: .restriction)
        conversationID = try values.decode(Int.self, forKey: .conversationID)
        messageID = try values.decode(Int.self, forKey: .messageID)
    }
}

/// Only a visible, live card message can own a received-card presentation.
struct IOSReceivedContactCardTarget: Equatable {
    let messageID: Int
    let conversationID: Int
    let userID: Int
    let publicID: String?
    let username: String?

    init?(message: Message) {
        guard message.id > 0, message.conversationId > 0, message.type == "contact_card",
              message.recalledAt == nil, message.status != "recalled", message.status != "deleted",
              let value = message.body["user_id"], let userID = Self.identifier(value) else { return nil }
        messageID = message.id; conversationID = message.conversationId; self.userID = userID
        publicID = message.body["public_id"]?.stringValue
        username = message.body["username"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func identifier(_ value: JSONValue) -> Int? {
        switch value {
        case .number(let number): return Int(exactly: number).flatMap { $0 > 0 ? $0 : nil }
        case .string(let text):
            guard text.range(of: "^[1-9][0-9]*$", options: .regularExpression) != nil else { return nil }
            return Int(text).flatMap { $0 > 0 ? $0 : nil }
        default: return nil
        }
    }

    func matches(_ message: Message) -> Bool {
        guard let other = Self(message: message) else { return false }
        return messageID == other.messageID && conversationID == other.conversationID && userID == other.userID
    }
}

/// UIKit focus notifications and SwiftUI refreshes arrive on different turns.
/// Only a changed focus request is allowed to change the native first responder.
struct IOSComposerFocusRequest {
    private var previous: Bool?
    mutating func consume(_ requested: Bool) -> Bool? {
        guard previous != requested else { return nil }
        previous = requested
        return requested
    }
}

enum IOSVoiceFileFormat {
    static func uploadType(_ data: Data) -> (filename: String, mime: String)? {
        let header = Array(data.prefix(12))
        guard header.count == 12 else { return nil }
        if header[0..<4].elementsEqual("RIFF".utf8), header[8..<12].elementsEqual("WAVE".utf8) {
            return ("voice.wav", "audio/wav")
        }
        // Retain retries for recordings prepared by the older AAC recorder.
        if header[4..<8].elementsEqual("ftyp".utf8) { return ("voice.m4a", "audio/mp4") }
        return nil
    }

    static func downloadName(_ url: URL) -> String {
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "path" })?.value ?? url.path
        let suffix = (path as NSString).pathExtension.lowercased()
        return ["wav", "m4a", "mp3", "aac", "ogg", "opus", "webm"].contains(suffix) ? "voice." + suffix : "voice.audio"
    }
}
struct ContactRequest: Decodable, Identifiable, Equatable { let id: Int; let userId: Int; let nickname: String; let avatarURL: String?; let message: String?; let status: String; let createdAt: String?; enum CodingKeys: String, CodingKey { case id; case userId = "user_id"; case nickname; case avatarURL = "avatar_url"; case message, status; case createdAt = "created_at" } }

struct IOSFriendRequestPage: Decodable {
    let items: [ContactRequest]
    let total: Int?
    let page: Int?
    let size: Int?
}

struct IOSFriendRequestSummary: Decodable {
    let pendingCount: Int
    enum CodingKeys: String, CodingKey { case pendingCount = "pending_count" }
}

/// Counts update independently from full request rows. Local actions and newer
/// fetches invalidate an older response before it can restore a stale badge.
struct IOSFriendRequestBadgeState {
    private(set) var count = 0
    private var revision = UUID()
    mutating func beginRefresh() -> UUID { revision = UUID(); return revision }
    @discardableResult mutating func apply(_ count: Int, revision expected: UUID) -> Bool {
        guard revision == expected, count >= 0 else { return false }
        self.count = count; return true
    }
    mutating func resolve() { count = max(0, count - 1); revision = UUID() }
    mutating func reset() { count = 0; revision = UUID() }
}

enum IOSVideoSelection {
    static let maximumBytes = 100 * 1024 * 1024
    struct Format: Equatable { let fileExtension: String; let mime: String }
    static func accepts(byteCount: Int) -> Bool { byteCount > 0 && byteCount <= maximumBytes }
    static func format(filenameExtension: String) -> Format? {
        switch filenameExtension.lowercased() {
        case "mp4": return Format(fileExtension: "mp4", mime: "video/mp4")
        case "mov", "qt": return Format(fileExtension: "mov", mime: "video/quicktime")
        case "m4v": return Format(fileExtension: "m4v", mime: "video/x-m4v")
        case "3gp", "3gpp": return Format(fileExtension: "3gp", mime: "video/3gpp")
        case "webm": return Format(fileExtension: "webm", mime: "video/webm")
        case "mkv": return Format(fileExtension: "mkv", mime: "video/x-matroska")
        case "avi": return Format(fileExtension: "avi", mime: "video/x-msvideo")
        case "ogv": return Format(fileExtension: "ogv", mime: "video/ogg")
        case "mpeg", "mpg": return Format(fileExtension: "mpeg", mime: "video/mpeg")
        case "wmv": return Format(fileExtension: "wmv", mime: "video/x-ms-wmv")
        default: return nil
        }
    }
}

enum IOSFriendRequestPages {
    enum LoadError: LocalizedError {
        case inconsistentPage
        var errorDescription: String? { "好友申请列表发生变化，请稍后重试" }
    }

    /// The existing API includes handled requests; pending ones may be on later pages.
    static func load(fetch: (Int, Int) async throws -> IOSFriendRequestPage) async throws -> [ContactRequest] {
        let requestedSize = 50
        var page = 1, seen = Set<Int>(), result: [ContactRequest] = []
        while true {
            try Task.checkCancellation()
            let response = try await fetch(page, requestedSize)
            try Task.checkCancellation()
            guard response.page == nil || response.page == page else { throw LoadError.inconsistentPage }
            if response.items.isEmpty { return result }
            let fresh = response.items.filter { seen.insert($0.id).inserted }
            guard !fresh.isEmpty else { throw LoadError.inconsistentPage }
            result.append(contentsOf: fresh)
            let size = response.size ?? requestedSize
            guard size > 0 else { throw LoadError.inconsistentPage }
            if let total = response.total {
                if page >= Int(ceil(Double(max(0, total)) / Double(size))) { return result }
            } else if response.items.count < size { return result }
            page += 1
        }
    }
}

/// One shared inbox drives both badges and the New Friends sheet.
struct IOSFriendRequestInbox: Equatable {
    private(set) var pending: [ContactRequest] = []
    private(set) var refreshRevision = UUID()
    var count: Int { pending.count }

    @discardableResult mutating func replace(with rows: [ContactRequest], revision: UUID) -> Bool {
        guard revision == refreshRevision else { return false }
        var seen = Set<Int>()
        pending = rows.filter { row in
            row.id > 0 && row.userId > 0 && seen.insert(row.id).inserted
                && row.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "pending"
        }.sorted { $0.id > $1.id }
        return true
    }

    /// A GET started before a successful action cannot restore that old request.
    mutating func resolve(_ id: Int) { pending.removeAll { $0.id == id }; refreshRevision = UUID() }
    mutating func reset() { pending = []; refreshRevision = UUID() }
    static func badgeText(for count: Int) -> String? { count > 0 ? (count > 99 ? "99+" : String(count)) : nil }
}

struct ConversationLastMessage: Decodable { let id: Int; let senderId: Int; let type: String; let body: [String: JSONValue]; let createdAt: String; enum CodingKeys: String, CodingKey { case id; case senderId = "sender_id"; case type, body; case createdAt = "created_at" } }
struct Conversation: Decodable, Identifiable {
    let id: Int
    let type: String
    let name: String?
    let avatarURL: String?
    let memberCount: Int?
    let unreadCount: Int
    let unreadMentionCount: Int
    let lastMessage: ConversationLastMessage?
    let notificationsMuted: Bool
    let isPinned: Bool
    let peerUserId: Int?
    let peerOnline: Bool?
    let peerLastSeenAt: String?
    let canPublish: Bool
    let frozenAt: String?
    let status: String?
    let myRole: String?
    let canSend: Bool?
    let sendDisabledReason: String?
    let myMutedUntil: String?
    let allMuted: Bool?
    var sendPermission: IOSConversationSendPermission {
        IOSConversationSendPermission(canSend: canSend, reason: sendDisabledReason, mutedUntil: myMutedUntil,
            type: type, role: myRole, allMuted: allMuted == true, canPublish: canPublish, status: status)
    }

    enum CodingKeys: String, CodingKey { case id, type, name, status; case avatarURL = "avatar_url"; case memberCount = "member_count"; case unreadCount = "unread_count"; case unreadMentionCount = "unread_mention_count"; case lastMessage = "last_message"; case notificationsMuted = "notifications_muted"; case isPinned = "is_pinned"; case peerUserId = "peer_user_id"; case peerOnline = "peer_online"; case peerLastSeenAt = "peer_last_seen_at"; case canPublish = "can_publish"; case frozenAt = "frozen_at"; case myRole = "my_role"; case canSend = "can_send", sendDisabledReason = "send_disabled_reason", myMutedUntil = "my_muted_until", allMuted = "all_muted" }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(Int.self, forKey: .id)
        type = try values.decode(String.self, forKey: .type)
        name = try values.decodeIfPresent(String.self, forKey: .name)
        avatarURL = try values.decodeIfPresent(String.self, forKey: .avatarURL)
        memberCount = try values.decodeIfPresent(Int.self, forKey: .memberCount)
        unreadCount = try values.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        unreadMentionCount = max(0, try values.decodeIfPresent(Int.self, forKey: .unreadMentionCount) ?? 0)
        lastMessage = try values.decodeIfPresent(ConversationLastMessage.self, forKey: .lastMessage)
        notificationsMuted = try values.decodeIfPresent(Bool.self, forKey: .notificationsMuted) ?? false
        isPinned = try values.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        peerUserId = try values.decodeIfPresent(Int.self, forKey: .peerUserId)
        peerOnline = try values.decodeIfPresent(Bool.self, forKey: .peerOnline)
        peerLastSeenAt = try values.decodeIfPresent(String.self, forKey: .peerLastSeenAt)
        canPublish = try values.decodeIfPresent(Bool.self, forKey: .canPublish) ?? (type != "channel")
        frozenAt = try values.decodeIfPresent(String.self, forKey: .frozenAt)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        myRole = try values.decodeIfPresent(String.self, forKey: .myRole)
        canSend = try values.decodeIfPresent(Bool.self, forKey: .canSend)
        sendDisabledReason = try values.decodeIfPresent(String.self, forKey: .sendDisabledReason)
        myMutedUntil = try values.decodeIfPresent(String.self, forKey: .myMutedUntil)
        allMuted = try values.decodeIfPresent(Bool.self, forKey: .allMuted)
    }
}
struct GroupMember: Decodable, Identifiable { let userId: Int; let nickname: String; let role: String; let avatarURL: String?; let mutedUntil: String?; enum CodingKeys: String, CodingKey { case userId = "user_id"; case nickname, role; case avatarURL = "avatar_url"; case mutedUntil = "muted_until" }; var id: Int { userId } }
struct GroupProfile: Decodable {
    let conversationId: Int
    let name: String
    let avatarURL: String?
    let description: String?
    let announcement: String?
    let inviteCode: String?
    let ownerId: Int
    let memberCount: Int
    let myRole: String
    let canManage: Bool
    let isOwner: Bool
    let notificationsMuted: Bool
    let isPinned: Bool
    let allowMemberAddFriend: Bool?
    let membersVisibility: String?
    let canSend: Bool?
    let sendDisabledReason: String?
    let myMutedUntil: String?
    let allMuted: Bool?
    var sendPermission: IOSConversationSendPermission {
        IOSConversationSendPermission(canSend: canSend, reason: sendDisabledReason, mutedUntil: myMutedUntil,
            type: "group", role: myRole, allMuted: allMuted == true)
    }
    var canInviteMembers: Bool { canManage && ["owner", "admin"].contains(myRole) }
    var canViewMemberProfiles: Bool { ["owner", "admin"].contains(myRole) || allowMemberAddFriend == true }
    var membersRestricted: Bool { membersVisibility == "managers" || !canViewMemberProfiles }

    enum CodingKeys: String, CodingKey {
        case conversationId = "conversation_id", name
        case avatarURL = "avatar_url", description, announcement
        case inviteCode = "invite_code", ownerId = "owner_id", memberCount = "member_count"
        case myRole = "my_role", canManage = "can_manage", isOwner = "is_owner"
        case notificationsMuted = "notifications_muted", isPinned = "is_pinned"
        case membersVisibility = "members_visibility"
        case allowMemberAddFriend = "allow_member_add_friend"
        case canSend = "can_send", sendDisabledReason = "send_disabled_reason", myMutedUntil = "my_muted_until", allMuted = "all_muted"
    }
}

// Server authorization is authoritative. The role fallback is only for older
// metadata; an internal-staff flag never exempts a member from group restrictions.
struct IOSConversationSendPermission: Equatable {
    let canSend: Bool
    let reason: String
    let mutedUntil: String?
    init(canSend: Bool?, reason: String?, mutedUntil: String?, type: String, role: String?,
         allMuted: Bool = false, canPublish: Bool = true, status: String? = nil, now: Date = Date()) {
        self.mutedUntil = mutedUntil
        if let canSend {
            self.canSend = canSend; self.reason = canSend ? "" : (reason?.isEmpty == false ? reason! : "member_muted")
        } else if let status, !status.isEmpty, status != "active" {
            self.canSend = false; self.reason = "inactive"
        } else if type == "channel", !canPublish {
            self.canSend = false; self.reason = "channel_readonly"
        } else if type == "group", allMuted, !["owner", "admin"].contains(role ?? "") {
            self.canSend = false; self.reason = "group_muted"
        } else if let mutedUntil, !mutedUntil.isEmpty, Self.date(mutedUntil).map({ $0 > now }) ?? true {
            self.canSend = false; self.reason = "member_muted"
        } else { self.canSend = true; self.reason = "" }
    }
    var placeholder: String { canSend ? "输入消息" : "已禁止发言" }
    func needsExpiryRefresh(now: Date = Date()) -> Bool {
        guard !canSend, reason == "member_muted", let mutedUntil, let end = Self.date(mutedUntil) else { return false }
        return end <= now
    }
    // Expiry only requests fresh authorization; it never enables the composer
    // using the device clock while a newer or overlapping mute may exist.
    static func date(_ value: String) -> Date? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

struct IOSComposerAuthorization {
    private(set) var permission: IOSConversationSendPermission
    private(set) var request = UUID()
    init(permission: IOSConversationSendPermission) { self.permission = permission }
    mutating func beginRefresh() -> UUID { request = UUID(); return request }
    mutating func cancelRefresh() { request = UUID() }
    @discardableResult mutating func apply(_ value: IOSConversationSendPermission, request: UUID) -> Bool {
        guard self.request == request else { return false }
        permission = value; return true
    }
}
enum JSONValue: Codable, Equatable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    init(from decoder: Decoder) throws { let container = try decoder.singleValueContainer(); if container.decodeNil() { self = .null } else if let value = try? container.decode(String.self) { self = .string(value) } else if let value = try? container.decode(Bool.self) { self = .bool(value) } else if let value = try? container.decode(Double.self) { self = .number(value) } else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) } else { self = .array(try container.decode([JSONValue].self)) } }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self { case .string(let v): try c.encode(v); case .number(let v): try c.encode(v); case .bool(let v): try c.encode(v); case .object(let v): try c.encode(v); case .array(let v): try c.encode(v); case .null: try c.encodeNil() }
    }
    var stringValue: String? { if case .string(let value) = self { return value }; return nil }
    var intValue: Int? { if case .number(let value) = self { return Int(value) }; return nil }
    var anyValue: Any {
        switch self {
        case .string(let value): return value
        case .number(let value): return value
        case .bool(let value): return value
        case .object(let value): return value.mapValues { $0.anyValue }
        case .array(let value): return value.map(\.anyValue)
        case .null: return NSNull()
        }
    }
}
struct Message: Codable, Identifiable, Equatable {
    let id: Int; let conversationId: Int; let senderId: Int; let type: String; let body: [String: JSONValue]
    let createdAt: String; let recalledAt: String?; let editedAt: String?; let status: String?; let senderName: String?; let senderAvatarURL: String?
    init(id: Int, conversationId: Int, senderId: Int, type: String, body: [String: JSONValue], createdAt: String, recalledAt: String?, editedAt: String?, status: String?, senderName: String? = nil, senderAvatarURL: String? = nil) {
        self.id = id; self.conversationId = conversationId; self.senderId = senderId; self.type = type; self.body = body
        self.createdAt = createdAt; self.recalledAt = recalledAt; self.editedAt = editedAt; self.status = status; self.senderName = senderName; self.senderAvatarURL = senderAvatarURL
    }
    enum CodingKeys: String, CodingKey { case id; case conversationId = "conversation_id"; case senderId = "sender_id"; case senderName = "sender_name"; case senderAvatarURL = "sender_avatar_url"; case type, body, status; case createdAt = "created_at"; case recalledAt = "recalled_at"; case editedAt = "edited_at" }
}
struct MessageReplyReference {
    let id: Int
    let senderId: Int
    let senderName: String
    let type: String
    let text: String
    let thumbnailURL: String?
    let unavailable: Bool
    init?(value: JSONValue?) {
        guard let value, case .object(let body) = value, let id = body["id"]?.intValue, id > 0 else { return nil }
        self.id = id
        if let value = body["unavailable"], case .bool(let flag) = value { unavailable = flag } else { unavailable = false }
        senderId = unavailable ? 0 : body["sender_id"]?.intValue ?? 0
        senderName = unavailable ? "原消息" : body["sender_name"]?.stringValue ?? "原消息"
        type = unavailable ? "unavailable" : body["type"]?.stringValue ?? "text"
        text = unavailable ? "原消息已不可用" : body["text"]?.stringValue ?? "消息"
        thumbnailURL = unavailable ? nil : body["thumbnail_url"]?.stringValue
    }
}
struct MessagePinMetadata: Decodable {
    let pinnedBy: Int
    let pinnedAt: String
    enum CodingKeys: String, CodingKey { case pinnedBy = "pinned_by"; case pinnedAt = "pinned_at" }
}
struct PinnedMessage: Decodable, Identifiable {
    let message: Message
    let pin: MessagePinMetadata
    var id: Int { message.id }
    enum CodingKeys: String, CodingKey { case pin }
    init(from decoder: Decoder) throws {
        message = try Message(from: decoder)
        pin = try decoder.container(keyedBy: CodingKeys.self).decode(MessagePinMetadata.self, forKey: .pin)
    }
}
struct MessagePinsSnapshot: Decodable {
    static let maximumCount = 20
    let conversationId: Int
    let items: [PinnedMessage]
    let limit: Int
    enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case items, limit }
}
struct PersonalMessageDeletion: Decodable {
    let conversationId: Int
    let userId: Int
    let messageIds: [Int]
    enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case userId = "user_id"; case messageIds = "message_ids" }
}
struct ConversationHistoryClearResult: Decodable {
    let conversationId: Int
    let clearedBeforeMessageId: Int
    enum CodingKeys: String, CodingKey { case conversationId = "conversation_id"; case clearedBeforeMessageId = "cleared_before_message_id" }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        conversationId = try values.decode(Int.self, forKey: .conversationId)
        clearedBeforeMessageId = try values.decode(Int.self, forKey: .clearedBeforeMessageId)
        guard conversationId > 0, clearedBeforeMessageId >= 0 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid history clear boundary"))
        }
    }
    func cutoff(for conversationID: Int, keeping current: Int) -> Int? {
        guard conversationID == conversationId, current >= 0 else { return nil }
        return max(current, clearedBeforeMessageId)
    }
}
/// Cursor pages remain stable while newer messages arrive. All clients use bounded reads.
struct IOSChatHistoryPage: Decodable {
    init(items: [Message], hasMore: Bool) { self.items = items; self.total = nil; self.size = nil; self.page = nil; self.more = hasMore; self.membershipVersion = nil; self.clearedBeforeMessageID = nil }
    let items: [Message]
    let total: Int?
    let size: Int?
    let page: Int?
    private let more: Bool?
    let membershipVersion: Int?
    let clearedBeforeMessageID: Int?
    enum CodingKeys: String, CodingKey { case items, total, size, page; case more = "has_more", membershipVersion = "membership_version", clearedBeforeMessageID = "cleared_before_message_id" }
    var chronological: [Message] { items.sorted { $0.id < $1.id } }
    var nextMaxID: Int { max(0, (items.map(\.id).min() ?? 0) - 1) }
    var hasMore: Bool { nextMaxID > 0 && (more ?? total.map { $0 > items.count } ?? !items.isEmpty) }
    func validated(conversationID: Int, maximumID: Int = 0) throws -> Self {
        guard conversationID > 0, maximumID >= 0, Set(items.map(\.id)).count == items.count,
              items.allSatisfy({ $0.id > 0 && $0.conversationId == conversationID && (maximumID == 0 || $0.id <= maximumID) }),
              !(items.isEmpty && (more == true || (total ?? 0) > 0)) else { throw IOSChatHistoryFailure.invalidPage }
        return self
    }
}
enum IOSChatHistoryFailure: Error { case invalidPage }

struct MessageLocationPage: Decodable {
    let items: [Message]
    let targetId: Int
    enum CodingKeys: String, CodingKey { case items; case targetId = "target_id" }
}
/// A user-selected history location outranks background scrolling until the user
/// scrolls again or explicitly sends a new message. Request revisions isolate taps.
struct ChatMessageNavigation {
    private(set) var revision = UUID()
    private(set) var targetID: Int?
    private(set) var highlightedMessageID: Int?
    private(set) var isResolving = false
    private(set) var holdsPosition = false
    mutating func begin(targetID: Int) -> UUID {
        revision = UUID(); self.targetID = targetID; highlightedMessageID = nil
        isResolving = true; holdsPosition = true
        return revision
    }
    mutating func resolve(revision: UUID) -> Bool {
        guard self.revision == revision, let targetID else { return false }
        isResolving = false; highlightedMessageID = targetID
        return true
    }
    mutating func fail(revision: UUID) -> Bool {
        guard self.revision == revision else { return false }
        resumeFollowing(); return true
    }
    mutating func resumeFollowing() {
        revision = UUID(); targetID = nil; highlightedMessageID = nil
        isResolving = false; holdsPosition = false
    }
    mutating func clearHighlight(revision: UUID) {
        if self.revision == revision { highlightedMessageID = nil }
    }
    mutating func pause() {
        let resolving = isResolving
        revision = UUID(); targetID = nil; highlightedMessageID = nil; isResolving = false
        if resolving { holdsPosition = false }
    }
    func shouldFollowLatest(nearBottom: Bool, ownMessage: Bool = false) -> Bool {
        !holdsPosition && (nearBottom || ownMessage)
    }
}
extension Message {
    var goWireID: String? { guard let id = body["_go_wire_id"]?.stringValue, UUID(uuidString: id) != nil else { return nil }; return id }
    var goVersion: Int? { body["_go_version"]?.stringValue.flatMap(Int.init) }
    var storageVersion: String { goVersion.map { String(format: "%020lld", Int64($0)) } ?? editedAt ?? "" }
    var replyReference: MessageReplyReference? { MessageReplyReference(value: body["reply_to"]) }
    var previewText: String {
        if recalledAt != nil || status == "recalled" { return "消息已撤回" }
        let caption = body["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !caption.isEmpty { return caption }
        switch type {
        case "image": return "[图片]"
        case "video": return "[视频]"
        case "voice": return "[语音]"
        case "file": return "[文件] " + (body["name"]?.stringValue ?? body["file_name"]?.stringValue ?? "附件")
        case "contact_card": return "[名片] " + (body["nickname"]?.stringValue ?? "联系人")
        case "shake": return "[窗口抖动]"
        case "system": return "[系统消息]"
        default: return "[消息]"
        }
    }
    var previewThumbnailURL: String? {
        guard recalledAt == nil, status != "recalled" else { return nil }
        return body["thumbnail_url"]?.stringValue ?? body["thumb_url"]?.stringValue ?? (type == "image" ? body["url"]?.stringValue : nil)
    }
}
struct MessageSyncPage: Decodable {
    let conversationId: Int
    let items: [Message]
    let snapshotMaxId: Int
    let nextAfterId: Int
    let hasMore: Bool
    let clearedBeforeMessageId: Int
    let membershipVersion: Int?
    enum CodingKeys: String, CodingKey { case membershipVersion = "membership_version"; case conversationId = "conversation_id"; case items; case snapshotMaxId = "snapshot_max_id"; case nextAfterId = "next_after_id"; case hasMore = "has_more"; case clearedBeforeMessageId = "cleared_before_message_id" }
}
struct IOSMessageRecallReceipt: Decodable {
    let messageID: Int
    let status: String
    enum CodingKeys: String, CodingKey { case messageID = "message_id", status }
    func confirms(_ id: Int) -> Bool { id > 0 && messageID == id && status == "recalled" }
}

enum MessageReconciliation {
    struct Application {
        let items: [Message]
        let changed: Bool
    }

    /// Live events change one sorted row; avoid rebuilding and sorting the
    /// entire history for every ACK, duplicate delivery and new message.
    static func applying(_ incoming: Message, to items: [Message], conversationID: Int, clearedBefore: Int) -> Application {
        guard incoming.conversationId == conversationID else { return Application(items: items, changed: false) }
        var low = 0, high = items.count
        while low < high {
            let middle = low + (high - low) / 2
            if items[middle].id < incoming.id { low = middle + 1 } else { high = middle }
        }
        let exists = low < items.count && items[low].id == incoming.id
        let message = preferred(current: exists ? items[low] : nil, incoming: incoming)
        let unavailable = message.id <= clearedBefore || message.recalledAt != nil || message.status == "recalled" || message.type == "red_packet"
        if unavailable {
            guard exists else { return Application(items: items, changed: false) }
            var result = items; result.remove(at: low)
            return Application(items: result, changed: true)
        }
        if exists, items[low] == message { return Application(items: items, changed: false) }
        var result = items
        if exists { result[low] = message } else { result.insert(message, at: low) }
        return Application(items: result, changed: true)
    }

    static func tombstone(_ message: Message) -> Message {
        Message(id: message.id, conversationId: message.conversationId, senderId: message.senderId, type: message.type, body: message.body.filter { ["_go_wire_id", "_go_version"].contains($0.key) }, createdAt: message.createdAt, recalledAt: message.recalledAt ?? "removed", editedAt: message.editedAt, status: "recalled", senderName: message.senderName, senderAvatarURL: message.senderAvatarURL)
    }
    static func preferred(current: Message?, incoming: Message, preferIncomingOnEqual: Bool = true) -> Message {
        guard let current else { return preserveUnavailableReply(incoming, sources: [incoming]) }
        let recalled = current.recalledAt != nil || current.status == "recalled"
        let incomingRecalled = incoming.recalledAt != nil || incoming.status == "recalled"
        if recalled && !incomingRecalled { return current }
        if incomingRecalled { return incoming }
        let selected: Message
        if let old = current.goVersion, let new = incoming.goVersion, old != new { return new > old ? incoming : current }
        if current.editedAt != nil && incoming.editedAt == nil { selected = current }
        else if let old = current.editedAt, let new = incoming.editedAt, new != old { selected = new > old ? incoming : current }
        else if current.editedAt == nil && incoming.editedAt != nil { selected = incoming }
        else { selected = preferIncomingOnEqual ? incoming : current }
        // reply_to is hydrated from another message: its privacy state can change
        // without changing this reply's edited_at. Never restore a known hidden quote.
        return preserveUnavailableReply(selected, sources: [current, incoming])
    }
    private static func preserveUnavailableReply(_ selected: Message, sources: [Message]) -> Message {
        guard let target = selected.replyReference?.id ?? selected.body["reply_to_id"]?.intValue,
              sources.contains(where: { $0.id == selected.id && $0.conversationId == selected.conversationId && $0.replyReference?.id == target && $0.replyReference?.unavailable == true }) else { return selected }
        var body = selected.body
        body["reply_to"] = .object(["id": .number(Double(target)), "unavailable": .bool(true)])
        return Message(id: selected.id, conversationId: selected.conversationId, senderId: selected.senderId, type: selected.type, body: body, createdAt: selected.createdAt, recalledAt: selected.recalledAt, editedAt: selected.editedAt, status: selected.status, senderName: selected.senderName, senderAvatarURL: selected.senderAvatarURL)
    }
    static func visiblePins(_ items: [PinnedMessage], conversationID: Int, clearedBefore: Int, versions: [Int: Message]) -> [PinnedMessage] {
        var seen = Set<Int>()
        return Array(items.filter { pin in
            pin.message.conversationId == conversationID && pin.id > clearedBefore && pin.message.recalledAt == nil && pin.message.status != "recalled" && versions[pin.id]?.recalledAt == nil && versions[pin.id]?.status != "recalled" && seen.insert(pin.id).inserted
        }.prefix(MessagePinsSnapshot.maximumCount))
    }
    static func merge(snapshot: [Message], events: [Message], conversationID: Int, clearedBefore: Int) -> [Message] {
        var result: [Int: Message] = [:]
        for message in snapshot + events where message.conversationId == conversationID && message.id > clearedBefore {
            result[message.id] = preferred(current: result[message.id], incoming: message)
        }
        return result.values.filter { $0.recalledAt == nil && $0.status != "recalled" && $0.type != "red_packet" }.sorted { $0.id < $1.id }
    }
}
extension Message {
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(Int.self, forKey: .id)
        conversationId = try values.decode(Int.self, forKey: .conversationId)
        senderId = try values.decode(Int.self, forKey: .senderId)
        senderName = try values.decodeIfPresent(String.self, forKey: .senderName)
        senderAvatarURL = try values.decodeIfPresent(String.self, forKey: .senderAvatarURL)
        type = try values.decode(String.self, forKey: .type)
        createdAt = try values.decode(String.self, forKey: .createdAt)
        recalledAt = try values.decodeIfPresent(String.self, forKey: .recalledAt)
        editedAt = try values.decodeIfPresent(String.self, forKey: .editedAt)
        status = try values.decodeIfPresent(String.self, forKey: .status)
        if let object = try? values.decode([String: JSONValue].self, forKey: .body) { body = object }
        else if let legacy = try? values.decode([JSONValue].self, forKey: .body), legacy.isEmpty { body = [:] }
        else { throw DecodingError.dataCorruptedError(forKey: .body, in: values, debugDescription: "Message body must be an object") }
    }
}
struct MessageSearchResult: Decodable, Identifiable {
    let id: Int
    let conversationId: Int
    let senderId: Int
    let type: String
    let body: [String: JSONValue]
    let createdAt: String
    let senderNickname: String?

    enum CodingKeys: String, CodingKey {
        case id, type, body
        case conversationId = "conversation_id"
        case senderId = "sender_id"
        case createdAt = "created_at"
        case senderNickname = "sender_nickname"
    }
}

struct ClientAnnouncement: Decodable, Identifiable {
    let id: Int
    let title: String
    let content: String
    let enabled: Bool
    let revision: Int
    let updatedAt: String?
    enum CodingKeys: String, CodingKey { case id, title, content, enabled, revision; case updatedAt = "updated_at" }
}

struct ClientExternalLink: Decodable, Identifiable {
    let id: Int
    let name: String
    let url: String
    enum CodingKeys: String, CodingKey { case id, name, url }
    init(id: Int, name: String, url: String) { self.id = id; self.name = name; self.url = url }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(Int.self, forKey: .id) ?? 0
        name = try values.decode(String.self, forKey: .name)
        url = try values.decode(String.self, forKey: .url)
    }
}

struct ClientRoute: Decodable, Identifiable {
    let id: Int
    let name: String
    let url: String
    let sort: Int
    let status: String
    enum CodingKeys: String, CodingKey { case id, name, url, sort, status }
}

struct ClientRoutePage: Decodable {
    let items: [ClientRoute]
}

struct ClientConfig: Decodable {
    let chatNotice: String?
    let announcement: ClientAnnouncement?
    let groupMemberLimit: Int
    let exploreLinks: [ClientExternalLink]
    let showGroupMemberCount: Bool
    let latestVersion: String
    let androidDownloadURL: String
    let iosDownloadURL: String
    let updateDescription: String
    let forceUpdate: Bool
    let registerRequireAvatar: Bool
    let maxRegisterAccountsPerIP: Int
    let mallLinks: [ClientExternalLink]
    enum CodingKeys: String, CodingKey { case chatNotice = "chat_notice"; case announcement; case groupMemberLimit = "group_member_limit"; case exploreLinks = "explore_links"; case showGroupMemberCount = "show_group_member_count"; case latestVersion = "latest_version"; case androidDownloadURL = "android_download_url"; case iosDownloadURL = "ios_download_url"; case updateDescription = "update_description"; case forceUpdate = "force_update"; case registerRequireAvatar = "register_require_avatar"; case maxRegisterAccountsPerIP = "max_register_accounts_per_ip"; case mallLinks = "mall_links" }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        chatNotice = try values.decodeIfPresent(String.self, forKey: .chatNotice)
        announcement = try values.decodeIfPresent(ClientAnnouncement.self, forKey: .announcement)
        groupMemberLimit = try values.decodeIfPresent(Int.self, forKey: .groupMemberLimit) ?? 500
        exploreLinks = try values.decodeIfPresent([ClientExternalLink].self, forKey: .exploreLinks) ?? []
        showGroupMemberCount = try values.decodeIfPresent(Bool.self, forKey: .showGroupMemberCount) ?? true
        latestVersion = try values.decodeIfPresent(String.self, forKey: .latestVersion) ?? "1.0.0"
        androidDownloadURL = try values.decodeIfPresent(String.self, forKey: .androidDownloadURL) ?? ""
        iosDownloadURL = try values.decodeIfPresent(String.self, forKey: .iosDownloadURL) ?? ""
        updateDescription = try values.decodeIfPresent(String.self, forKey: .updateDescription) ?? ""
        forceUpdate = try values.decodeIfPresent(Bool.self, forKey: .forceUpdate) ?? false
        registerRequireAvatar = try values.decodeIfPresent(Bool.self, forKey: .registerRequireAvatar) ?? false
        maxRegisterAccountsPerIP = try values.decodeIfPresent(Int.self, forKey: .maxRegisterAccountsPerIP) ?? 0
        mallLinks = try values.decodeIfPresent([ClientExternalLink].self, forKey: .mallLinks) ?? []
    }
}

struct PrivacyExceptions: Decodable {
    let phoneVisibilityAlways: [Int]
    let phoneSearchAlways: [Int]
    let lastSeenNever: [Int]
    let voiceCallNever: [Int]
    let inviteNever: [Int]

    enum CodingKeys: String, CodingKey {
        case phoneVisibilityAlways = "phone_visibility_always"
        case phoneSearchAlways = "phone_search_always"
        case lastSeenNever = "last_seen_never"
        case voiceCallNever = "voice_call_never"
        case inviteNever = "invite_never"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        phoneVisibilityAlways = try values.decodeIfPresent([Int].self, forKey: .phoneVisibilityAlways) ?? []
        phoneSearchAlways = try values.decodeIfPresent([Int].self, forKey: .phoneSearchAlways) ?? []
        lastSeenNever = try values.decodeIfPresent([Int].self, forKey: .lastSeenNever) ?? []
        voiceCallNever = try values.decodeIfPresent([Int].self, forKey: .voiceCallNever) ?? []
        inviteNever = try values.decodeIfPresent([Int].self, forKey: .inviteNever) ?? []
    }

    static let empty = PrivacyExceptions(phoneVisibilityAlways: [], phoneSearchAlways: [], lastSeenNever: [], voiceCallNever: [], inviteNever: [])

    init(phoneVisibilityAlways: [Int], phoneSearchAlways: [Int], lastSeenNever: [Int], voiceCallNever: [Int], inviteNever: [Int]) {
        self.phoneVisibilityAlways = phoneVisibilityAlways
        self.phoneSearchAlways = phoneSearchAlways
        self.lastSeenNever = lastSeenNever
        self.voiceCallNever = voiceCallNever
        self.inviteNever = inviteNever
    }

    var dictionary: [String: Any] {
        [
            "phone_visibility_always": phoneVisibilityAlways,
            "phone_search_always": phoneSearchAlways,
            "last_seen_never": lastSeenNever,
            "voice_call_never": voiceCallNever,
            "invite_never": inviteNever
        ]
    }
}

struct UserSettings: Decodable {
    let canManagePrivacy: Bool
    let phoneVisibility: String
    let phoneSearchVisibility: String
    let lastSeenVisibility: String
    let voiceCallVisibility: String
    let voiceCallPeerToPeer: String
    let inviteVisibility: String
    let showActiveSessions: Bool
    let accountAutoDeleteDays: Int
    let privacyExceptions: PrivacyExceptions
    enum CodingKeys: String, CodingKey {
        case canManagePrivacy = "can_manage_privacy"
        case phoneVisibility = "phone_visibility"
        case phoneSearchVisibility = "phone_search_visibility"
        case lastSeenVisibility = "last_seen_visibility"
        case voiceCallVisibility = "voice_call_visibility"
        case voiceCallPeerToPeer = "voice_call_peer_to_peer"
        case inviteVisibility = "invite_visibility"
        case showActiveSessions = "show_active_sessions"
        case accountAutoDeleteDays = "account_auto_delete_days"
        case privacyExceptions = "privacy_exceptions"
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        canManagePrivacy = try values.decodeIfPresent(Bool.self, forKey: .canManagePrivacy) ?? false
        phoneVisibility = try values.decodeIfPresent(String.self, forKey: .phoneVisibility) ?? "nobody"
        phoneSearchVisibility = try values.decodeIfPresent(String.self, forKey: .phoneSearchVisibility) ?? "everyone"
        lastSeenVisibility = try values.decodeIfPresent(String.self, forKey: .lastSeenVisibility) ?? "everyone"
        voiceCallVisibility = try values.decodeIfPresent(String.self, forKey: .voiceCallVisibility) ?? "everyone"
        voiceCallPeerToPeer = try values.decodeIfPresent(String.self, forKey: .voiceCallPeerToPeer) ?? "everyone"
        inviteVisibility = try values.decodeIfPresent(String.self, forKey: .inviteVisibility) ?? "everyone"
        showActiveSessions = try values.decodeIfPresent(Bool.self, forKey: .showActiveSessions) ?? true
        accountAutoDeleteDays = try values.decodeIfPresent(Int.self, forKey: .accountAutoDeleteDays) ?? 180
        privacyExceptions = try values.decodeIfPresent(PrivacyExceptions.self, forKey: .privacyExceptions) ?? .empty
    }
}


enum IOSGroupMentionPolicy {
    static func canMention(role: String?) -> Bool { ["owner", "admin", "member"].contains(role ?? "") }
    static func canSearch(role: String?) -> Bool { ["owner", "admin"].contains(role ?? "") }
}

/// Retain the exact identities selected from an avatar or the member picker.
/// Editing inside a selected token removes its identity; typed names never add one.
struct IOSGroupMentionSelection {
    private struct Token { var range: NSRange; let text: String; let userID: Int }
    private var text = ""
    private var tokens: [Token] = []

    mutating func update(_ value: String) {
        guard value != text else { return }
        let old = Array(text.utf16), new = Array(value.utf16)
        var prefix = 0
        while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
        var suffix = 0
        while suffix < min(old.count, new.count) - prefix,
              old[old.count - suffix - 1] == new[new.count - suffix - 1] { suffix += 1 }
        let oldEnd = old.count - suffix, delta = new.count - old.count
        tokens = tokens.compactMap { token in
            var item = token
            if NSMaxRange(item.range) <= prefix { /* Before the edit. */ }
            else if item.range.location >= oldEnd { item.range.location += delta }
            else { return nil }
            return Self.valid(item, in: value) ? item : nil
        }
        text = value
    }

    mutating func appending(userID: Int, name: String?, to draft: String) -> String? {
        guard let next = IOSGroupMentionText.appending(senderName: name, to: draft) else { return nil }
        var selection = self
        selection.update(draft)
        guard selection.record(userID: userID, name: name, in: next, caret: next.utf16.count) else { return nil }
        self = selection
        return next
    }

    mutating func replacing(userID: Int, name: String, query: IOSGroupMentionQuery) -> (text: String, caret: Int)? {
        guard let next = query.replacing(name: name) else { return nil }
        var selection = self
        selection.update(query.draft)
        guard selection.record(userID: userID, name: name, in: next.text, caret: next.caret) else { return nil }
        self = selection
        return next
    }

    mutating func userIDs(in draft: String) -> [Int] {
        update(draft)
        var seen = Set<Int>()
        return tokens.filter { Self.valid($0, in: draft) && seen.insert($0.userID).inserted }.map(\.userID)
    }

    private mutating func record(userID: Int, name: String?, in value: String, caret: Int) -> Bool {
        guard userID > 0, let normalized = IOSGroupMentionText.appending(senderName: name, to: "") else { return false }
        update(value)
        guard tokens.contains(where: { $0.userID == userID }) || Set(tokens.map(\.userID)).count < 100 else { return false }
        let token = String(normalized.dropLast())
        let range = NSRange(location: caret - token.utf16.count - 1, length: token.utf16.count)
        let item = Token(range: range, text: token, userID: userID)
        guard Self.valid(item, in: value) else { return false }
        tokens.removeAll { NSIntersectionRange($0.range, range).length > 0 }
        tokens.append(item)
        return true
    }

    private static func valid(_ token: Token, in value: String) -> Bool {
        let string = value as NSString, range = token.range
        guard range.location >= 0, range.length > 0, range.location <= string.length,
              range.length <= string.length - range.location, string.substring(with: range) == token.text else { return false }
        let before = string.substring(to: range.location).unicodeScalars.last
        let after = string.substring(from: NSMaxRange(range)).unicodeScalars.first
        return (before.map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? true)
            && (after.map { CharacterSet.whitespacesAndNewlines.contains($0) } ?? true)
    }
}

enum IOSChatBlankTapPolicy {
    static func allows(_ point: CGPoint, protectedFrames: [CGRect], enabled: Bool) -> Bool {
        enabled && point.x.isFinite && point.y.isFinite
            && !protectedFrames.contains { $0.insetBy(dx: -3, dy: -3).contains(point) }
    }
}

enum IOSGroupMentionText {
    static func appending(senderName: String?, to draft: String) -> String? {
        guard let senderName else { return nil }
        // Names are server-authoritative; strip control and direction-format
        // characters, normalize whitespace, and never fall back to a body alias.
        let scalars = senderName.unicodeScalars.map { scalar -> String in
            if CharacterSet.whitespacesAndNewlines.contains(scalar) { return " " }
            if CharacterSet.controlCharacters.contains(scalar) || scalar.properties.generalCategory == .format { return "" }
            return String(scalar)
        }.joined()
        let name = String(scalars.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ").prefix(80))
        guard !name.isEmpty else { return nil }
        let separator = draft.isEmpty || draft.last?.isWhitespace == true ? "" : " "
        let value = draft + separator + "@" + name + " "
        guard value.unicodeScalars.count <= 5000 else { return nil }
        return value
    }
}

struct GroupMentionCandidate: Decodable, Identifiable {
    let userId: Int; let nickname: String; let username: String?; let publicId: String?; let avatarURL: String?
    var id: Int { userId }
    enum CodingKeys: String, CodingKey { case userId = "user_id", nickname, username; case publicId = "public_id"; case avatarURL = "avatar_url" }
}
struct GroupMentionPage: Decodable {
    let conversationId: Int; let canSearch: Bool; let items: [GroupMentionCandidate]; let page: Int; let hasMore: Bool
    enum CodingKeys: String, CodingKey { case conversationId = "conversation_id", canSearch = "can_search", items, page, hasMore = "has_more" }
}
struct IOSGroupMentionQuery: Equatable {
    let range: NSRange; let query: String; let draft: String; let caret: Int
    static func parse(_ text: String, caret: Int) -> Self? {
        let value = text as NSString
        guard caret >= 0, caret <= value.length,
              let regex = try? NSRegularExpression(pattern: "(?:^|\\s)@([^\\s@]{0,80})$"),
              let match = regex.firstMatch(in: value.substring(to: caret), range: NSRange(location: 0, length: caret)) else { return nil }
        let part = match.range(at: 1)
        return Self(range: NSRange(location: part.location - 1, length: part.length + 1), query: value.substring(with: part), draft: text, caret: caret)
    }
    func replacing(name: String) -> (text: String, caret: Int)? {
        guard let insertion = IOSGroupMentionText.appending(senderName: name, to: "") else { return nil }
        let value = (draft as NSString).replacingCharacters(in: range, with: insertion)
        guard value.unicodeScalars.count <= 5000 else { return nil }
        return (value, range.location + insertion.utf16.count)
    }
}

struct FriendChatEvent: Decodable, Identifiable {
    let id: Int
    let conversationID: Int
    let peerUserID: Int
    enum CodingKeys: String, CodingKey { case id; case conversationID = "conversation_id"; case peerUserID = "peer_user_id" }
    var valid: Bool { id > 0 && conversationID > 0 && peerUserID > 0 }
}

enum IOSFriendChatListSync {
    /// A successful, complete inbox refresh consumes the event. Opening a chat
    /// is a separate user action and never controls this device cursor.
    static func consumedEventID(_ event: FriendChatEvent, afterID: Int, conversations: [Conversation]) -> Int? {
        guard event.valid, event.id > afterID,
              conversations.contains(where: { $0.id == event.conversationID && $0.type == "direct" && $0.peerUserId == event.peerUserID }) else { return nil }
        return event.id
    }
}

/// A receipt may settle only its exact request, actor and conversation.
enum IOSMessageDelivery {
    static func matches(_ message: Message, requestID: String, conversationID: Int, senderID: Int) -> Bool {
        !requestID.isEmpty && conversationID > 0 && senderID > 0 && message.id > 0 && message.type == "text" && message.conversationId == conversationID &&
            message.senderId == senderID && message.body["request_id"]?.stringValue == requestID
    }
}

/// iOS 16 has ScrollViewReader but no scrollPosition binding. Track the first
/// intersecting message without treating off-screen lazy rows as visible.
enum IOSLegacyChatViewport {
    static func firstVisibleMessage(frames: [Int: CGRect], height: CGFloat) -> Int? {
        guard height.isFinite, height > 0 else { return nil }
        return frames.filter { id, rect in
            id > 0 && rect.origin.y.isFinite && rect.size.height.isFinite && rect.minY.isFinite && rect.maxY.isFinite && rect.size.height > 0 && rect.maxY > 0 && rect.minY < height
        }.min { a, b in
            a.value.minY == b.value.minY ? a.key < b.key : a.value.minY < b.value.minY
        }?.key
    }
}

enum IOSChatMessageDisplay {
    static func senderName(_ message: Message) -> String {
        let name = message.senderName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? (message.goWireID == nil ? "用户 \(message.senderId)" : "群成员") : name
    }

    /// SQL and ISO timestamps use the same server clock on both mobile clients.
    static func timeLabel(_ value: String) -> String {
        for part in value.split(whereSeparator: { $0 == "T" || $0.isWhitespace }) {
            let bytes = Array(part.prefix(5).utf8)
            guard bytes.count == 5, bytes[2] == 58,
                  [bytes[0], bytes[1], bytes[3], bytes[4]].allSatisfy({ (48...57).contains($0) }) else { continue }
            let hour = Int(bytes[0] - 48) * 10 + Int(bytes[1] - 48)
            let minute = Int(bytes[3] - 48) * 10 + Int(bytes[4] - 48)
            if hour < 24 && minute < 60 { return String(decoding: bytes, as: UTF8.self) }
        }
        return "—:—"
    }
}
