import Foundation

struct GoPrivacyRule: Codable, Equatable {
    var visibility: String
    var allow: [String]
    var deny: [String]
    var dictionary: [String: Any] { ["visibility": visibility, "allow": allow, "deny": deny] }
}
struct GoPrivacyUser: Decodable, Identifiable { let id: String; let account: String }
struct GoContactPrivacy: Decodable {
    let temporaryChat: GoPrivacyRule
    let groupInvites: GoPrivacyRule
    let canManageGroupInvites: Bool
    let version: String
    let exceptionUsers: [GoPrivacyUser]?
    enum CodingKeys: String, CodingKey {
        case temporaryChat = "temporary_chat", groupInvites = "group_invites", version
        case canManageGroupInvites = "can_manage_group_invites", exceptionUsers = "exception_users"
    }
}
struct GoInviteCode: Decodable { let inviteCode: String; enum CodingKeys: String, CodingKey { case inviteCode = "invite_code" } }
