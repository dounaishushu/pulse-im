package core

import (
	"context"
	"errors"
	"testing"
)

func TestContactManagementDeniesOrdinaryFormalAndGroupManagers(t *testing.T) {
	f := newFixture(t)
	message := f.send(t, "contact-policy-history", "keep this message")
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark,group_name) VALUES($1,$2,'keep remark','keep group')", f.alice.UserID, f.bob.UserID)
	f.exec(t, "UPDATE pulse.users SET formal_employee=true WHERE id=$1", f.carol.UserID)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "ordinary contact managers", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupRole(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, "admin"); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []Login{f.alice, f.bob, f.carol} {
		peer := f.alice.UserID
		if actor.UserID == peer {
			peer = f.bob.UserID
		}
		if err = f.service.BlockWithReason(f.ctx, actor.Identity, peer, true, "old client"); !errors.Is(err, ErrForbidden) {
			t.Fatal("ordinary actor could block through the service", err)
		}
		if err = f.service.RemoveFriend(f.ctx, actor.Identity, peer); !errors.Is(err, ErrForbidden) {
			t.Fatal("ordinary actor could remove a friend through the service", err)
		}
		f.request(t, "PUT", "/api/v2/blocks/"+peer, actor.Token, map[string]string{"reason": "old client"}, 403, nil)
		f.request(t, "DELETE", "/api/v2/friends/"+peer, actor.Token, nil, 403, nil)
		blocks, err := f.service.Blocks(f.ctx, actor.Identity, "")
		if err != nil || len(blocks) != 0 {
			t.Fatal("a refused block changed the block list", blocks, err)
		}
	}
	friends, err := f.service.Friends(f.ctx, f.alice.Identity, "")
	if err != nil || len(friends) != 1 || friends[0] != f.bob.UserID {
		t.Fatal("refused removal changed the friendship", friends, err)
	}
	var remark, groupName, body string
	err = f.store.Pool.QueryRow(f.ctx, "SELECT remark,group_name FROM pulse.contact_metadata WHERE user_id=$1 AND peer_id=$2", f.alice.UserID, f.bob.UserID).Scan(&remark, &groupName)
	if err != nil || remark != "keep remark" || groupName != "keep group" {
		t.Fatal("refused action changed private contact metadata", err)
	}
	err = f.store.Pool.QueryRow(f.ctx, "SELECT body FROM pulse.messages WHERE id=$1", message.ID).Scan(&body)
	if err != nil || body != "keep this message" {
		t.Fatal("refused action changed chat history", err)
	}
}

func TestContactManagementUsesCurrentStaffPermissionWithOldToken(t *testing.T) {
	f := newFixture(t)
	blockPath, friendPath := "/api/v2/blocks/"+f.bob.UserID, "/api/v2/friends/"+f.bob.UserID
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.request(t, "PUT", blockPath, f.alice.Token, map[string]string{"reason": "staff block"}, 204, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	f.request(t, "PUT", blockPath, f.alice.Token, map[string]string{"reason": "unauthorized overwrite"}, 403, nil)
	var reason string
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT reason FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", f.alice.UserID, f.bob.UserID).Scan(&reason); err != nil || reason != "staff block" {
		t.Fatal("a revoked actor modified an existing block", reason, err)
	}
	f.request(t, "DELETE", blockPath, f.alice.Token, nil, 204, nil)
	f.request(t, "DELETE", friendPath, f.alice.Token, nil, 403, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.request(t, "DELETE", friendPath, f.alice.Token, nil, 204, nil)
	friends, err := f.service.Friends(f.ctx, f.alice.Identity, "")
	if err != nil || len(friends) != 0 {
		t.Fatal("staff could not remove a friend", friends, err)
	}
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	f.request(t, "DELETE", friendPath, f.alice.Token, nil, 403, nil)
	friends, err = f.service.Friends(f.ctx, f.alice.Identity, "")
	if err != nil || len(friends) != 1 || friends[0] != f.bob.UserID {
		t.Fatal("revoked staff removed a friend using an existing token", friends, err)
	}
}

func TestOrdinaryContactCanOnlyUnblockOwnExistingEntry(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2),($2,$1)", f.alice.UserID, f.bob.UserID)
	f.request(t, "DELETE", "/api/v2/blocks/"+f.bob.UserID, f.alice.Token, nil, 204, nil)
	blocks, err := f.service.Blocks(f.ctx, f.alice.Identity, "")
	if err != nil || len(blocks) != 0 {
		t.Fatal("ordinary user cannot clear their own legacy block", blocks, err)
	}
	blocks, err = f.service.Blocks(f.ctx, f.bob.Identity, "")
	if err != nil || len(blocks) != 1 || blocks[0] != f.alice.UserID {
		t.Fatal("unblocking modified another user's block", blocks, err)
	}
	f.request(t, "PUT", "/api/v2/blocks/"+f.bob.UserID, f.alice.Token, nil, 403, nil)
}

// Existing relationship/privacy tests exercise authorized mutations; keep the
// caller's original role everywhere outside the specific staff-only operation.
func (f *fixture) contactManagementGrant(t *testing.T, who Identity) func() {
	t.Helper()
	var previous bool
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1", who.UserID).Scan(&previous); err != nil {
		t.Fatal(err)
	}
	if previous {
		return func() {}
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", who.UserID)
	return func() { f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", who.UserID) }
}

func (f *fixture) blockAsStaff(t *testing.T, ctx context.Context, who Identity, peer string, blocked bool) error {
	t.Helper()
	if !blocked {
		return f.service.Block(ctx, who, peer, false)
	}
	restore := f.contactManagementGrant(t, who)
	defer restore()
	return f.service.Block(ctx, who, peer, true)
}

func (f *fixture) removeFriendAsStaff(t *testing.T, ctx context.Context, who Identity, peer string) error {
	t.Helper()
	restore := f.contactManagementGrant(t, who)
	defer restore()
	return f.service.RemoveFriend(ctx, who, peer)
}

func (f *fixture) requestContactAsStaff(t *testing.T, method, path, token string, value any, want int, out any) {
	t.Helper()
	for _, actor := range []Login{f.alice, f.bob, f.carol} {
		if actor.Token == token {
			restore := f.contactManagementGrant(t, actor.Identity)
			defer restore()
			f.request(t, method, path, token, value, want, out)
			return
		}
	}
	t.Fatal("unknown contact-management fixture actor")
}
