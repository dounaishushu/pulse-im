import Foundation

@main struct GroupMemberPolicyTests {
    enum Failure: Error { case assertion(String) }
    static func check(_ value: Bool, _ message: String) throws {
        if !value { throw Failure.assertion(message) }
    }
    static func profile(role: String = "member", allowed: Bool?, visibility: String?) throws -> GroupProfile {
        var raw: [String: Any] = ["conversation_id": 1, "name": "群权限测试", "owner_id": 2, "member_count": 3,
            "my_role": role, "can_manage": ["owner", "admin"].contains(role), "is_owner": role == "owner",
            "notifications_muted": false, "is_pinned": false]
        raw["allow_member_add_friend"] = allowed; raw["members_visibility"] = visibility
        return try JSONDecoder().decode(GroupProfile.self, from: JSONSerialization.data(withJSONObject: raw))
    }
    static func main() throws {
        let open = try profile(allowed: true, visibility: "all")
        try check(open.canViewMemberProfiles && !open.membersRestricted, "ordinary member cannot view an open group")
        try check(!open.canManage && !open.canInviteMembers, "browsing members granted management permissions")
        let restricted = try profile(allowed: false, visibility: "managers")
        try check(restricted.membersRestricted && !restricted.canViewMemberProfiles, "group ban did not restrict member browsing")
        for role in ["owner", "admin"] {
            let manager = try profile(role: role, allowed: false, visibility: "all")
            try check(manager.canManage && !manager.membersRestricted, "manager lost directory access")
        }
        try check(profile(allowed: true, visibility: "managers").membersRestricted, "restricted directory metadata was ignored")
        try check(profile(allowed: nil, visibility: nil).membersRestricted, "missing permissions exposed members")
        print("PASS open ordinary-member directory; no management escalation; ban on; owner/admin access; restrictive metadata; missing-policy default")
    }
}
