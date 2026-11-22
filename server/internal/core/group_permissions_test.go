package core

import (
	"encoding/json"
	"testing"
)

func TestGroupPermissionsKeepDirectoryAndManagementIndependent(t *testing.T) {
	for _, tc := range []struct {
		name, kind, role  string
		blocked           bool
		manage, add       bool
		visibility, scope string
	}{
		{"ordinary open group", "group", "member", false, false, true, "all", "group"},
		{"ordinary restricted group", "group", "member", true, false, false, "managers", "friends"},
		{"owner restricted group", "group", "owner", true, true, false, "all", "group"},
		{"admin open group", "group", "admin", false, true, true, "all", "group"},
		{"admin restricted group", "group", "admin", true, true, false, "all", "group"},
		{"ordinary channel", "channel", "member", false, false, false, "managers", "friends"},
		{"channel manager", "channel", "admin", false, true, false, "all", "group"},
		{"unknown kind", "direct", "owner", false, false, false, "managers", "friends"},
		{"missing role", "group", "", false, false, false, "managers", "friends"},
		{"unknown role", "group", "guest", false, false, false, "managers", "friends"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := groupPermissions(tc.kind, tc.role, tc.blocked, false)
			if got.CanManage != tc.manage || got.CanInvite != tc.manage || got.CanMentionAll != tc.manage || got.AllowMemberAddFriend != tc.add || got.MembersVisibility != tc.visibility || got.SearchScope != tc.scope {
				t.Fatalf("unexpected group permissions: %+v", got)
			}
			if got.IsOwner != (tc.manage && tc.role == "owner") {
				t.Fatal("owner capability disagrees with the authenticated role", got)
			}
		})
	}
}

func TestGroupDetailsExposeTheSamePermissionsAsDirectory(t *testing.T) {
	details := GroupDetails{Kind: "group", MyRole: "member", GroupPermissions: groupPermissions("group", "member", false, false)}
	raw, err := json.Marshal(details)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err = json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"can_manage", "can_invite", "is_owner", "can_mention_all", "allow_member_add_friend", "members_visibility", "search_scope"} {
		if _, ok := wire[field]; !ok {
			t.Fatal("group permission missing from API response", field)
		}
	}
	if wire["members_visibility"] != "all" || wire["search_scope"] != "group" || wire["can_manage"] != false || wire["allow_member_add_friend"] != true {
		t.Fatal("ordinary browsing changed management rights", wire)
	}
}
