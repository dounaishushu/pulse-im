package core

import "testing"

func TestMemberDirectoryKeepsLegacyContractAndNegotiatesOpenRoster(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "compat-directory", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=false WHERE id=$1", group.ID)
	f.exec(t, "UPDATE pulse.users SET nickname='directory-stranger' WHERE id=$1", f.carol.UserID)
	prefix := "/api/v2/groups/" + group.ID + "/member-profiles"
	var legacy, modern ClientMemberPage
	f.request(t, "GET", prefix+"?q=&limit=100", f.bob.Token, nil, 200, &legacy)
	if legacy.MembersVisibility != "managers" || legacy.SearchScope != "friends" || len(legacy.Items) != 1 || legacy.Items[0]["id"] != f.alice.UserID {
		t.Fatalf("legacy client received an incompatible roster: %+v", legacy)
	}
	f.request(t, "GET", prefix+"?directory_version=2&q=&limit=100", f.bob.Token, nil, 200, &modern)
	if modern.MembersVisibility != "all" || modern.SearchScope != "group" || len(modern.Items) != 3 {
		t.Fatalf("modern client did not receive open-group members: %+v", modern)
	}
	f.request(t, "GET", prefix+"?q=directory-stranger", f.bob.Token, nil, 200, &legacy)
	if len(legacy.Items) != 0 || legacy.SearchScope != "friends" {
		t.Fatalf("legacy search escaped its advertised friendship scope: %+v", legacy)
	}
	f.request(t, "GET", prefix+"?directory_version=2&q=directory-stranger", f.bob.Token, nil, 200, &modern)
	if len(modern.Items) != 1 || modern.Items[0]["id"] != f.carol.UserID {
		t.Fatalf("modern group search lost a non-friend: %+v", modern)
	}
	f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.bob.UserID, f.carol.UserID)
	f.request(t, "GET", prefix+"?q=directory-stranger", f.bob.Token, nil, 200, &legacy)
	if len(legacy.Items) != 1 || legacy.Items[0]["is_contact"] != true {
		t.Fatalf("legacy friend search regressed: %+v", legacy)
	}
	f.request(t, "GET", prefix, f.alice.Token, nil, 200, &legacy)
	if legacy.MembersVisibility != "all" || legacy.SearchScope != "group" || len(legacy.Items) != 3 {
		t.Fatalf("legacy owner lost its full roster: %+v", legacy)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	for _, suffix := range []string{"", "?directory_version=2"} {
		var page ClientMemberPage
		f.request(t, "GET", prefix+suffix, f.bob.Token, nil, 200, &page)
		if page.MembersVisibility != "managers" || page.SearchScope != "friends" || len(page.Items) != 1 {
			t.Fatalf("group ban changed during contract negotiation: %+v", page)
		}
	}
	f.request(t, "GET", prefix+"?directory_version=3", f.bob.Token, nil, 400, nil)
}
