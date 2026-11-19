package core

// GroupPermissions is display metadata for the authenticated viewer. Every
// write still authorizes the current membership and settings in its transaction.
type GroupPermissions struct {
	CanManage            bool   `json:"can_manage"`
	CanInvite            bool   `json:"can_invite"`
	IsOwner              bool   `json:"is_owner"`
	CanMentionAll        bool   `json:"can_mention_all"`
	AllowMemberAddFriend bool   `json:"allow_member_add_friend"`
	MembersVisibility    string `json:"members_visibility"`
	SearchScope          string `json:"search_scope"`
}

func groupPermissions(kind, role string, blocked bool) GroupPermissions {
	policy := GroupPermissions{MembersVisibility: "managers", SearchScope: "friends"}
	if kind != "group" && kind != "channel" {
		return policy
	}
	if role != "owner" && role != "admin" && role != "member" {
		return policy
	}
	policy.CanManage = role == "owner" || role == "admin"
	policy.CanInvite, policy.CanMentionAll = policy.CanManage, policy.CanManage
	policy.IsOwner = role == "owner"
	policy.AllowMemberAddFriend = kind == "group" && !blocked
	if policy.CanManage || policy.AllowMemberAddFriend {
		policy.MembersVisibility, policy.SearchScope = "all", "group"
	}
	return policy
}
