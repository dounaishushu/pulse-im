package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStaffBlocksRejectOrdinaryAndStaleStaffTokens(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id IN ($1,$2)", f.bob.UserID, f.carol.UserID)
	for _, formal := range []bool{false, true} {
		f.exec(t, "UPDATE pulse.users SET formal_employee=$2 WHERE id=$1", f.alice.UserID, formal)
		f.request(t, "PUT", "/api/v2/blocks/"+f.bob.UserID, f.alice.Token, map[string]string{"reason": "old client"}, 403, nil)
	}
	// A token issued while an employee cannot retain their old block permission.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	login, err := f.service.Login(f.ctx, "alice01", testPassword, "staff-block-old-token", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	if err = f.service.Block(f.ctx, login.Identity, f.bob.UserID, true); !errors.Is(err, ErrForbidden) {
		t.Fatal("demoted staff token blocked an internal employee", err)
	}
	f.request(t, "PUT", "/api/v2/blocks/"+f.carol.UserID, f.bob.Token, nil, 204, nil)
	var count int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.blocks WHERE user_id=$1", f.alice.UserID).Scan(&count); err != nil || count != 0 {
		t.Fatal("refused request persisted an ordinary-user block", count, err)
	}
}

func TestStaffBlocksReleaseOnlyProtectedRelationsAndRestoreChat(t *testing.T) {
	f := newFixture(t)
	message := f.send(t, "staff-block-history", "preserve history")
	dave := newID()
	f.exec(t, "INSERT INTO pulse.users(id,account,password_hash) VALUES($1,'dave01',$2)", dave, testPasswordHash)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id IN ($1,$2)", f.bob.UserID, f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'keep remark')", f.alice.UserID, f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id,reason) VALUES($1,$2,'legacy'),($3,$2,'legacy without chat'),($2,$3,'staff to ordinary'),($2,$4,'staff to staff'),($1,$3,'ordinary legacy')", f.alice.UserID, f.bob.UserID, dave, f.carol.UserID)
	f.exec(t, "DELETE FROM pulse.user_outbox")
	before, err := f.service.ConversationAccess(f.ctx, f.bob.Identity, f.cid)
	if err != nil || before.CanSend {
		t.Fatal("fixture is not blocked", before, err)
	}
	count, err := f.service.ReleaseProtectedStaffBlocks(f.ctx)
	if err != nil || count != 2 {
		t.Fatal("wrong backfill count", count, err)
	}
	for _, actor := range []Identity{f.alice.Identity, f.bob.Identity} {
		access, err := f.service.ConversationAccess(f.ctx, actor, f.cid)
		if err != nil || !access.CanSend {
			t.Fatal("unblocked direct chat is still unavailable", access, err)
		}
	}
	var remaining, hints, users int
	var body, remark string
	err = f.store.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM pulse.blocks),
		(SELECT count(*) FROM pulse.outbox WHERE conversation_id=$1 AND kind='membership.changed'),
		(SELECT count(*) FROM pulse.user_outbox),
		(SELECT body FROM pulse.messages WHERE id=$2),
		(SELECT remark FROM pulse.contact_metadata WHERE user_id=$3 AND peer_id=$4)`, f.cid, message.ID, f.alice.UserID, f.bob.UserID).Scan(&remaining, &hints, &users, &body, &remark)
	if err != nil || remaining != 3 || hints != 1 || users != 3 || body != "preserve history" || remark != "keep remark" {
		t.Fatal("backfill changed unrelated data or failed to notify", remaining, hints, users, body, remark, err)
	}
	f.send(t, "staff-block-after-release", "can send again")
	count, err = f.service.ReleaseProtectedStaffBlocks(f.ctx)
	if err != nil || count != 0 {
		t.Fatal("backfill is not idempotent", count, err)
	}
}

func TestStaffBlocksStaffPromotionAndDemotionReleaseInSameTransaction(t *testing.T) {
	for _, promote := range []bool{true, false} {
		t.Run(map[bool]string{true: "promotion", false: "demotion"}[promote], func(t *testing.T) {
			f := newFixture(t)
			root := newAdmin(t, f)
			changed := f.bob.UserID
			if !promote {
				changed = f.alice.UserID
				f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id IN ($1,$2)", f.alice.UserID, f.bob.UserID)
			}
			f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2),($2,$1)", f.alice.UserID, f.bob.UserID)
			var version int64
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT profile_version FROM pulse.users WHERE id=$1", changed).Scan(&version); err != nil {
				t.Fatal(err)
			}
			if err := f.service.AdminSaveUser(f.ctx, root.who, changed, AdminUserPatch{Internal: &promote, Expected: version}); err != nil {
				t.Fatal(err)
			}
			var invalid, reverse int
			if err := f.store.Pool.QueryRow(f.ctx, `SELECT count(*) FILTER(WHERE user_id=$1),count(*) FILTER(WHERE user_id=$2) FROM pulse.blocks`, f.alice.UserID, f.bob.UserID).Scan(&invalid, &reverse); err != nil || invalid != 0 || reverse != 1 {
				t.Fatal("role change did not release exactly the protected direction", invalid, reverse, err)
			}
		})
	}
}

func TestStaffBlocksAdminAuditFailureRollsBackRoleAndRelease(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.alice.UserID, f.bob.UserID)
	f.exec(t, `CREATE FUNCTION pulse.test_reject_staff_role_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='user.update' THEN RAISE EXCEPTION 'isolated audit failure'; END IF; RETURN NEW; END $$`)
	f.exec(t, `CREATE TRIGGER test_reject_staff_role_audit BEFORE INSERT ON pulse.admin_audit FOR EACH ROW EXECUTE FUNCTION pulse.test_reject_staff_role_audit()`)
	t.Cleanup(func() {
		f.exec(t, "DROP TRIGGER test_reject_staff_role_audit ON pulse.admin_audit")
		f.exec(t, "DROP FUNCTION pulse.test_reject_staff_role_audit()")
	})
	var version int64
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT profile_version FROM pulse.users WHERE id=$1", f.bob.UserID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	internal := true
	if err := f.service.AdminSaveUser(f.ctx, root.who, f.bob.UserID, AdminUserPatch{Internal: &internal, Expected: version}); err == nil {
		t.Fatal("expected audit error")
	}
	var staff, blocked bool
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT internal_staff,EXISTS(SELECT 1 FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2) FROM pulse.users WHERE id=$2`, f.alice.UserID, f.bob.UserID).Scan(&staff, &blocked); err != nil || staff || !blocked {
		t.Fatal("failed admin transaction partially applied the release", staff, blocked, err)
	}
}

func TestStaffBlocksRoleGateSerializesBackfill(t *testing.T) {
	f := newFixture(t)
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if err = lockStaffBlockPolicy(f.ctx, tx); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.ctx, 150*time.Millisecond)
	defer cancel()
	if _, err = f.service.ReleaseProtectedStaffBlocks(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("backfill ignored an in-progress role transaction", err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if count, err := f.service.ReleaseProtectedStaffBlocks(f.ctx); err != nil || count != 0 {
		t.Fatal("role gate did not release after commit", count, err)
	}
}
