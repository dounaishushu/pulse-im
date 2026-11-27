package core

import "testing"

func TestAccountSearchFriendshipBelongsToCurrentViewer(t *testing.T) {
	f := newFixture(t)
	for _, tc := range []struct {
		viewer  Login
		account string
		friend  bool
	}{
		{f.alice, "bob01", true},
		{f.bob, "alice01", true},
		{f.carol, "bob01", false},
		{f.alice, "carol01", false},
	} {
		var found PublicUser
		f.request(t, "GET", "/api/v2/users/by-account/"+tc.account, tc.viewer.Token, nil, 200, &found)
		if found.Account != tc.account || found.IsContact != tc.friend {
			t.Fatalf("friendship flag is missing or belongs to another viewer: %+v", found)
		}
	}
	f.request(t, "GET", "/api/v2/users/by-account/bob01", "", nil, 401, nil)
}

func TestAccountSearchImmediatelyReflectsFriendshipChanges(t *testing.T) {
	f := newFixture(t)
	lookup := func(want bool) {
		t.Helper()
		var found PublicUser
		f.request(t, "GET", "/api/v2/users/by-account/bob01", f.alice.Token, nil, 200, &found)
		if found.IsContact != want {
			t.Fatalf("search retained an outdated friendship: %+v", found)
		}
	}
	lookup(true)
	// Existing messages remain, but a direct conversation alone is not a friendship.
	f.exec(t, "DELETE FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.alice.UserID, f.bob.UserID)
	lookup(false)
	f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.alice.UserID, f.bob.UserID)
	lookup(true)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.bob.UserID)
	lookup(true)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.alice.UserID)
	f.request(t, "GET", "/api/v2/users/by-account/bob01", f.alice.Token, nil, 404, nil)
}
