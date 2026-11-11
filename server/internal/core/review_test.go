package core

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestReviewClearRetryAndReceiptIntegrity(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "review-clear-first", "before clear")
	var state State
	path := "/api/v2/conversations/" + f.cid + "/clear"
	// A clear request carries the boundary chosen by the user, including on retry.
	body := map[string]string{"through_seq": fmt.Sprint(first.Seq)}
	f.request(t, "PUT", path, f.bob.Token, body, 200, &state)
	if state.ReadSeq != 0 || state.DeliveredSeq != 0 {
		t.Errorf("clearing history forged receipt facts: %+v", state)
	}
	receipt, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, first.ID)
	if err != nil || receipt.ReadCount != 0 || receipt.DeliveredCount != 0 {
		t.Errorf("sender was told an unread message was read: %+v %v", receipt, err)
	}
	next := f.send(t, "review-clear-next", "after clear")
	f.request(t, "PUT", path, f.bob.Token, body, 200, &state)
	if state.ClearSeq != first.Seq || state.PersonalSeq != 1 {
		t.Fatalf("retry cleared later messages: %+v", state)
	}
	page, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != next.ID {
		t.Fatalf("new message lost after clear retry: %+v %v", page, err)
	}
	f.request(t, "PUT", path, f.bob.Token, nil, 400, nil)
	f.request(t, "PUT", path, f.bob.Token, map[string]string{"through_seq": "999999"}, 400, nil)
}

func TestReviewRestrictedGroupMembersExcludeFriendsAndSelf(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "restricted", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode); err != nil {
		t.Fatal(err)
	}
	request, err := f.service.FriendRequest(f.ctx, f.bob.Identity, f.carol.UserID, "friend")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.carol.Identity, request, true); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	// Internal staff still has no manager exception for the member directory.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.bob.UserID)
	list, err := f.service.GroupMembers(f.ctx, f.bob.Identity, group.ID, "")
	if err != nil || len(list) != 1 || list[0] != f.alice.UserID {
		t.Fatalf("restricted group exposed ordinary members: %v %v", list, err)
	}
	list, err = f.service.GroupMembers(f.ctx, f.alice.Identity, group.ID, "")
	if err != nil || len(list) != 3 {
		t.Fatalf("owner lost directory access: %v %v", list, err)
	}
}

func TestReviewBlockedFriendRequestCanStillBeRejected(t *testing.T) {
	f := newFixture(t)
	id, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "request")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, id, false); err != nil {
		t.Fatalf("recipient cannot dismiss a blocked sender: %v", err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, id, false); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.friend_requests WHERE id=$1", id).Scan(&status); err != nil || status != "rejected" {
		t.Fatalf("request remained pending: %s %v", status, err)
	}
}

func TestReviewStaffAddResolvesPendingRequests(t *testing.T) {
	f := newFixture(t)
	id, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "pending")
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	var status string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.friend_requests WHERE id=$1", id).Scan(&status); err != nil || status != "accepted" {
		t.Fatalf("staff add left pending request: %s %v", status, err)
	}
}

func TestReviewMutualRequestsAcceptExistingRequest(t *testing.T) {
	f := newFixture(t)
	original, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "first")
	if err != nil {
		t.Fatal(err)
	}
	returned, err := f.service.FriendRequest(f.ctx, f.alice.Identity, f.carol.UserID, "reciprocal")
	if err != nil || returned != original {
		t.Errorf("mutual request did not reuse original: %s %v", returned, err)
	}
	var pending int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friend_requests WHERE status='pending'").Scan(&pending); err != nil || pending != 0 {
		t.Fatalf("mutual consent left pending requests: %d %v", pending, err)
	}
	if _, err = f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatalf("mutual requests did not establish friendship: %v", err)
	}
}

func TestReviewConcurrentSessionRevocationHasNoDeadlock(t *testing.T) {
	f := newFixture(t)
	other, err := f.service.Login(f.ctx, "alice01", testPassword, "review-other-device", "test")
	if err != nil {
		t.Fatal(err)
	}
	barrier, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer barrier.Rollback(f.ctx)
	if _, err = barrier.Exec(f.ctx, "SELECT id FROM pulse.login_sessions WHERE user_id=$1 FOR SHARE", f.alice.UserID); err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	go func() { results <- f.service.RevokeSession(f.ctx, f.alice.Identity, other.SessionID) }()
	go func() { results <- f.service.RevokeSession(f.ctx, other.Identity, f.alice.SessionID) }()
	deadline := time.Now().Add(time.Second)
	for {
		var waiting int
		err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'").Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("revocations did not reach the lock barrier")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err = barrier.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	successes, invalidated := 0, 0
	for i := 0; i < 2; i++ {
		select {
		case err = <-results:
			if err == nil {
				successes++
			} else if errors.Is(err, ErrUnauthorized) {
				invalidated++
			} else {
				t.Errorf("concurrent revocation returned database failure: %v", err)
			}
		case <-time.After(4 * time.Second):
			t.Fatal("revocation did not finish")
		}
	}
	if successes != 1 || invalidated != 1 {
		t.Fatalf("expected one winner and one stale actor: %d, %d", successes, invalidated)
	}
}

func TestReviewMetadataRejectsNullBytes(t *testing.T) {
	f := newFixture(t)
	f.request(t, "POST", "/api/v2/groups", f.alice.Token, map[string]string{"title": "bad\u0000title"}, 400, nil)
	f.request(t, "POST", "/api/v2/friend-requests", f.alice.Token, map[string]string{"target_id": f.carol.UserID, "note": "bad\u0000note"}, 400, nil)
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "alice01", "password": testPassword, "device_id": "bad\u0000device"}, 400, nil)
}

func TestReviewFriendRequestHonorsExplicitGroupContext(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "context", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	body := map[string]string{"target_id": f.carol.UserID, "note": "from group", "context_conversation_id": group.ID}
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, body, 403, nil)
	// Account discovery is independent of a shared, restricted group.
	delete(body, "context_conversation_id")
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, body, 201, nil)
	f.exec(t, "DELETE FROM pulse.friend_requests")
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=false WHERE id=$1", group.ID)
	body["context_conversation_id"] = group.ID
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, body, 201, nil)
	f.exec(t, "DELETE FROM pulse.friend_requests")
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, body, 403, nil)
}

func TestReviewJoinSerializesWithParticipantBlock(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "block ordering", nil)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	// Hold the same per-user gate used by block mutations, then commit a block
	// while a join is in flight. Joining must evaluate the committed policy.
	if _, err = tx.Exec(f.ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 1148))", f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	joined := make(chan error, 1)
	go func() { joined <- f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode) }()
	deadline := time.Now().Add(time.Second)
	for {
		select {
		case err = <-joined:
			t.Fatalf("join crossed pending block mutation: %v", err)
		default:
		}
		var waiting int
		err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'").Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("join never waited for block mutation")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err = tx.Exec(f.ctx, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.alice.UserID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-joined:
		if !errors.Is(err, ErrForbidden) {
			t.Fatalf("join ignored committed block: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("join failed to finish")
	}
}

func TestReviewWebSocketControlFramesShareRateBudget(t *testing.T) {
	f := newFixture(t)
	ws := f.ws(t, f.alice)
	for i := 0; i < 65; i++ {
		if err := ws.WriteControl(9, nil, time.Now().Add(time.Second)); err != nil {
			return
		}
	}
	if err := ws.WriteJSON(map[string]string{"type": "ping"}); err != nil {
		return
	}
	_ = ws.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := ws.ReadMessage(); err == nil {
		t.Fatal("control-frame flood bypassed the frame budget")
	}
}

func TestReviewGroupCreationRetainsLegacyCapacity(t *testing.T) {
	f := newFixture(t)
	ids := make([]string, 50)
	for i := range ids {
		ids[i] = newID()
		f.exec(t, "INSERT INTO pulse.users(id,account,password_hash) VALUES($1,$2,$3)", ids[i], fmt.Sprintf("capacity%03d", i), testPasswordHash)
		f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.alice.UserID, ids[i])
	}
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "initial members", ids)
	if err != nil {
		t.Fatalf("creation incorrectly inherited the 50-person batch-invite limit: %v", err)
	}
	var count int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.members WHERE conversation_id=$1 AND active", group.ID).Scan(&count); err != nil || count != 51 {
		t.Fatalf("initial members missing: %d %v", count, err)
	}
}

func TestReviewLaterReadPreservesClearedAndDeletedReceiptFacts(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "skip-first", "unseen cleared message")
	if _, err := f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, first.Seq); err != nil {
		t.Fatal(err)
	}
	second := f.send(t, "skip-second", "actually read")
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, second.Seq, true); err != nil {
		t.Fatal(err)
	}
	third := f.send(t, "skip-third", "unseen deleted message")
	fourth := f.send(t, "skip-fourth", "delivered but never read")
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, fourth.Seq, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{fourth.ID, third.ID, second.ID}); err != nil {
		t.Fatal(err)
	}
	fifth := f.send(t, "skip-fifth", "later read")
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, fifth.Seq, true); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct {
		message         Message
		read, delivered int64
	}{
		{first, 0, 0}, {second, 1, 1}, {third, 0, 1}, {fourth, 0, 1}, {fifth, 1, 1},
	} {
		got, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, want.message.ID)
		if err != nil || got.ReadCount != want.read || got.DeliveredCount != want.delivered {
			t.Errorf("receipt for seq %d: %+v %v; want read=%d delivered=%d", want.message.Seq, got, err, want.read, want.delivered)
		}
	}
	// Adjacent deletion ranges merge even when IDs are supplied out of order.
	var readRanges int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.receipt_exclusions WHERE conversation_id=$1 AND user_id=$2 AND kind='read'", f.cid, f.bob.UserID).Scan(&readRanges); err != nil || readRanges != 2 {
		t.Fatalf("exclusions are not compact disjoint ranges: %d %v", readRanges, err)
	}
}

func TestReviewCannotAcceptInactiveFriendRequester(t *testing.T) {
	f := newFixture(t)
	request, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "before freeze")
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.carol.UserID)
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inactive applicant was accepted: %v", err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, false); err != nil {
		t.Fatal(err)
	}
}

func TestMobileReviewOnlySenderCanEdit(t *testing.T) {
	f := newFixture(t)
	message := f.send(t, "own-edit", "original")
	path := "/api/v2/conversations/" + f.cid + "/messages/" + message.ID
	patch := map[string]string{"body": "forged", "expected_version": "1"}
	f.request(t, "PATCH", path, f.bob.Token, patch, 403, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.bob.UserID)
	f.request(t, "PATCH", path, f.bob.Token, patch, 403, nil)
	var actual Message
	if err := scanMessage(f.store.Pool.QueryRow(f.ctx, "SELECT "+messageColumns+" FROM pulse.messages WHERE id=$1", message.ID), &actual); err != nil || actual.Body != "original" || actual.Version != 1 {
		t.Fatalf("unauthorized edit changed message: %+v %v", actual, err)
	}
	var count int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.events WHERE message_id=$1", message.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unauthorized edit wrote event: %d %v", count, err)
	}
	var edited Message
	patch["body"] = "author's correction"
	f.request(t, "PATCH", path, f.alice.Token, patch, 200, &edited)
	if edited.Version != 2 || edited.Body != patch["body"] {
		t.Fatal("sender edit failed")
	}
	f.request(t, "PATCH", path, f.alice.Token, patch, 409, nil)
}
