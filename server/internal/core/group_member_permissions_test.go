package core

import (
	"errors"
	"testing"
)

func TestMemberInvitesNeverGrantManagementOrChannelRights(t *testing.T) {
	for _, tc := range []struct {
		kind, role            string
		allow, invite, manage bool
	}{
		{"group", "owner", false, true, true},
		{"group", "admin", false, true, true},
		{"group", "member", false, false, false},
		{"group", "member", true, true, false},
		{"channel", "member", true, false, false},
		{"channel", "admin", true, true, true},
		{"direct", "owner", true, false, false},
		{"group", "guest", true, false, false},
		{"group", "", true, false, false},
	} {
		policy := groupPermissions(tc.kind, tc.role, true, tc.allow)
		if policy.CanInvite != tc.invite || policy.CanManage != tc.manage || policy.CanMentionAll != tc.manage {
			t.Fatalf("%s/%s allow=%v: unexpected capabilities %+v", tc.kind, tc.role, tc.allow, policy)
		}
		if !tc.manage && (policy.MembersVisibility != "managers" || policy.SearchScope != "friends") {
			t.Fatalf("invitation grant bypassed restricted member directory: %+v", policy)
		}
	}
}

func TestMemberInvitationSwitchRechecksWritesPrivacyAndHistory(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "member invitations", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Direct(f.ctx, f.bob.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/groups/" + group.ID
	f.request(t, "GET", path+"/invite-candidates", f.bob.Token, nil, 403, nil)
	if err = f.service.InviteGroupMember(f.ctx, f.bob.Identity, group.ID, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("default must deny member invitations", err)
	}
	f.request(t, "PATCH", path, f.bob.Token, map[string]bool{"allow_member_invites": true}, 403, nil)
	var details GroupDetails
	f.request(t, "PATCH", path, f.alice.Token, map[string]bool{"allow_member_invites": true}, 200, &details)
	f.request(t, "GET", path, f.bob.Token, nil, 200, &details)
	if !details.CanInvite || details.CanManage || !details.AllowMemberInvites {
		t.Fatal("invite permission was not isolated", details)
	}
	var candidates struct {
		Items []map[string]any `json:"items"`
	}
	f.request(t, "GET", path+"/invite-candidates", f.bob.Token, nil, 200, &candidates)
	if len(candidates.Items) != 1 || candidates.Items[0]["id"] != f.carol.UserID {
		t.Fatal("eligible direct peer missing", candidates)
	}
	// Inviting a member must not let an ordinary user expose pre-join history.
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.bob.Identity, group.ID, f.carol.UserID, true); !errors.Is(err, ErrForbidden) {
		t.Fatal("member exposed group history", err)
	}
	// Group-invitation privacy settings are editable only by internal accounts.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.carol.UserID)
	setContactRule(t, f, f.carol, "group_invites", PrivacyRule{Visibility: "nobody"})
	if err = f.service.InviteGroupMember(f.ctx, f.bob.Identity, group.ID, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("target privacy bypassed", err)
	}
	setContactRule(t, f, f.carol, "group_invites", PrivacyRule{Visibility: "everyone"})
	if err = f.service.InviteGroupMember(f.ctx, f.bob.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "PATCH", path, f.alice.Token, map[string]bool{"allow_member_invites": false}, 200, &details)
	if err = f.service.InviteGroupMember(f.ctx, f.bob.Identity, group.ID, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("stale permission authorized invitation", err)
	}
	f.request(t, "GET", path+"/invite-candidates", f.bob.Token, nil, 403, nil)
}

func TestPermissionExceptionsArePagedManagerOnlyAndExcludeExpiredMutes(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "permission exceptions", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupMute(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, true); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.members SET muted_until=now()-interval '1 minute' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.carol.UserID)
	path := "/api/v2/groups/" + group.ID
	var details GroupDetails
	f.request(t, "GET", path, f.alice.Token, nil, 200, &details)
	if details.RestrictedMemberCount != 1 {
		t.Fatal("exception count included expired mute", details.RestrictedMemberCount)
	}
	var page ClientMemberPage
	f.request(t, "GET", path+"/member-profiles?directory_version=2&restriction=muted&limit=1", f.alice.Token, nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0]["id"] != f.bob.UserID || page.NextAfter != "" {
		t.Fatal("wrong restricted page", page)
	}
	f.request(t, "GET", path+"/member-profiles?directory_version=2&restriction=muted", f.bob.Token, nil, 403, nil)
	f.request(t, "GET", path+"/member-profiles?directory_version=2&restriction=unknown", f.alice.Token, nil, 400, nil)
	if err = f.service.SetGroupRole(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, "admin"); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", path+"/member-profiles?directory_version=2&restriction=muted&q=bob", f.carol.Token, nil, 200, &page)
	if len(page.Items) != 1 {
		t.Fatal("admin could not search exceptions", page)
	}
	if err = f.service.SetGroupMute(f.ctx, f.carol.Identity, group.ID, f.bob.UserID, false); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", path, f.alice.Token, nil, 200, &details)
	if details.RestrictedMemberCount != 0 || details.AdministratorCount != 1 {
		t.Fatal("counts not refreshed after changes", details)
	}
}
