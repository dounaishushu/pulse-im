package core

import "testing"

func TestGroupFriendSwitchControlsProfilesAndRequests(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "group friend switch", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	profilePath := "/api/v2/profiles/" + f.carol.UserID + "?conversation_id=" + group.ID
	request := map[string]string{"target_id": f.carol.UserID, "context_conversation_id": group.ID}
	setBlocked := func(blocked bool) {
		t.Helper()
		var details GroupDetails
		f.request(t, "PATCH", "/api/v2/groups/"+group.ID, f.alice.Token, map[string]bool{"block_member_friend_requests": blocked}, 200, &details)
		if details.BlockMemberFriendRequests != blocked {
			t.Fatal("group switch was not saved", details)
		}
	}
	profile := func(token, path string, canAdd bool) {
		t.Helper()
		var value Profile
		f.request(t, "GET", path, token, nil, 200, &value)
		if value.CanAddFriend != canAdd {
			t.Fatalf("can_add_friend=%v, want %v", value.CanAddFriend, canAdd)
		}
	}
	profile(f.bob.Token, profilePath, true)
	profile(f.carol.Token, "/api/v2/profiles/"+f.bob.UserID+"?conversation_id="+group.ID, true)
	profile(f.bob.Token, "/api/v2/profiles/"+f.bob.UserID+"?conversation_id="+group.ID, false)
	// Ordinary members can browse each other while the group ban is off.
	var directory ClientMemberPage
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/member-profiles", f.bob.Token, nil, 200, &directory)
	if directory.MembersVisibility != "all" || directory.SearchScope != "group" || len(directory.Items) != 3 {
		t.Fatal("open group did not expose its complete member directory", directory)
	}
	setBlocked(true)
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/member-profiles", f.bob.Token, nil, 200, &directory)
	if directory.MembersVisibility != "managers" || directory.SearchScope != "friends" || len(directory.Items) != 1 || directory.Items[0]["id"] != f.alice.UserID {
		t.Fatal("restricted group exposed ordinary members", directory)
	}
	f.request(t, "GET", profilePath, f.bob.Token, nil, 403, nil)
	profile(f.alice.Token, profilePath, false)
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, request, 403, nil)
	// A false PATCH must lift the ban without requiring a rejoin or relogin.
	setBlocked(false)
	profile(f.bob.Token, profilePath, true)
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, request, 201, nil)
	f.exec(t, "DELETE FROM pulse.friend_requests WHERE requester_id=$1 AND target_id=$2", f.bob.UserID, f.carol.UserID)
	// A profile opened before the switch changed cannot authorize a stale write.
	setBlocked(true)
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, request, 403, nil)
	setBlocked(false)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", profilePath, f.bob.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, request, 403, nil)
}

func TestGroupFriendCapabilityKeepsAccountAndPairRestrictions(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "group friend limits", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/profiles/" + f.carol.UserID + "?conversation_id=" + group.ID
	for _, tc := range []struct {
		name, setup, restore string
	}{
		{"actor cannot add friends", "UPDATE pulse.users SET can_add_friends=false WHERE id=$1", "UPDATE pulse.users SET can_add_friends=true WHERE id=$1"},
		{"target disallows requests", "UPDATE pulse.users SET allow_friend_requests=false WHERE id=$2", "UPDATE pulse.users SET allow_friend_requests=true WHERE id=$2"},
		{"actor blocked target", "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2"},
		{"target blocked actor", "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($2,$1)", "DELETE FROM pulse.blocks WHERE user_id=$2 AND peer_id=$1"},
		{"already friends", "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", "DELETE FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Include both typed parameters even when only one is used by an UPDATE.
			setup := "WITH peers AS (SELECT $1::uuid AS actor,$2::uuid AS target) " + tc.setup
			restore := "WITH peers AS (SELECT $1::uuid AS actor,$2::uuid AS target) " + tc.restore
			f.exec(t, setup, f.bob.UserID, f.carol.UserID)
			defer f.exec(t, restore, f.bob.UserID, f.carol.UserID)
			var value Profile
			f.request(t, "GET", path, f.bob.Token, nil, 200, &value)
			if value.CanAddFriend {
				t.Fatal("group switch bypassed account or pair restrictions")
			}
		})
	}
}
