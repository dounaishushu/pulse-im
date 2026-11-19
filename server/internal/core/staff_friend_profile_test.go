package core

import "testing"

func TestStaffFriendProfileKeepsAccessWhenOpenedFromGroup(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "staff-friend-context", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true,can_view_devices=false WHERE id IN ($1,$2)", f.bob.UserID, f.alice.UserID)
	prefix := "/api/v2/staff/users/" + f.carol.UserID
	context := "?conversation_id=" + group.ID
	f.request(t, "GET", prefix+context, f.bob.Token, nil, 403, nil)
	f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.bob.UserID, f.carol.UserID)
	for _, suffix := range []string{"", context} {
		var profile map[string]any
		f.request(t, "GET", prefix+suffix, f.bob.Token, nil, 200, &profile)
		if profile["id"] != f.carol.UserID || profile["logins"] == nil {
			t.Fatalf("staff friend profile omitted the existing login metadata: %+v", profile)
		}
	}
	// The fix does not grant ordinary users the staff profile endpoint.
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.bob.UserID)
	f.request(t, "GET", prefix+context, f.bob.Token, nil, 403, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.bob.UserID)
	// Removing the friendship immediately removes the group-context exception.
	f.exec(t, "DELETE FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.bob.UserID, f.carol.UserID)
	f.request(t, "GET", prefix+context, f.bob.Token, nil, 403, nil)
	// Existing staff group administrators retain their original access.
	f.request(t, "GET", prefix+context, f.alice.Token, nil, 200, nil)
	f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.bob.UserID, f.carol.UserID)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", prefix+context, f.bob.Token, nil, 403, nil)
}
