package core

import "testing"

func TestStaffDirectAddUsesCurrentPrivilegeWithoutFriendVerification(t *testing.T) {
	f := newFixture(t)
	path := "/api/v2/friends/direct-add"
	input := map[string]string{"target_id": f.alice.UserID}
	// Formal employment is independent of internal staff authority.
	f.exec(t, "UPDATE pulse.users SET formal_employee=true WHERE id=$1", f.carol.UserID)
	f.request(t, "POST", path, f.carol.Token, input, 403, nil)
	var pending map[string]string
	f.request(t, "POST", "/api/v2/friend-requests", f.carol.Token, input, 201, &pending)
	if pending["status"] != "pending" {
		t.Fatalf("ordinary account bypassed verification: %+v", pending)
	}
	// The same login session must see the changed admin privilege. Staff direct
	// add follows its existing policy, independent of ordinary request switches.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true,can_add_friends=false WHERE id=$1", f.carol.UserID)
	f.exec(t, "UPDATE pulse.users SET allow_friend_requests=false WHERE id=$1", f.alice.UserID)
	var added map[string]string
	f.request(t, "POST", path, f.carol.Token, input, 200, &added)
	if !validID(added["conversation_id"]) {
		t.Fatalf("direct add did not establish a conversation: %+v", added)
	}
	var requests, friends int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friend_requests WHERE id=$1 AND status='pending'", pending["id"]).Scan(&requests); err != nil || requests != 0 {
		t.Fatal("direct add left a pending verification request", requests, err)
	}
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.carol.UserID, f.alice.UserID).Scan(&friends); err != nil || friends != 1 {
		t.Fatal("staff direct add did not create one shared friendship", friends, err)
	}
	var repeated map[string]string
	f.request(t, "POST", path, f.carol.Token, input, 200, &repeated)
	if repeated["conversation_id"] != added["conversation_id"] {
		t.Fatal("repeating direct add created a second conversation")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false,can_add_friends=true WHERE id=$1", f.carol.UserID)
	f.request(t, "POST", path, f.carol.Token, map[string]string{"target_id": f.bob.UserID}, 403, nil)
	// Restoring staff authority still never bypasses a current block or a frozen target.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.carol.UserID)
	f.request(t, "POST", path, f.carol.Token, map[string]string{"target_id": f.bob.UserID}, 403, nil)
	f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.bob.UserID)
	f.request(t, "POST", path, f.carol.Token, map[string]string{"target_id": f.bob.UserID}, 403, nil)
}
