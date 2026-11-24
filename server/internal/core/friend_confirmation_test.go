package core

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
)

func confirmationHistory(t *testing.T, f *fixture, viewer Login, cid string) []Message {
	t.Helper()
	page, err := f.service.History(f.ctx, viewer.Identity, cid, 0, 0, 0, nil, 100, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	items := []Message{}
	for _, m := range page.Items {
		var content map[string]string
		if m.Kind != "system" || json.Unmarshal(m.Content, &content) != nil || content["kind"] != "friend_accepted" {
			continue
		}
		if m.Body != friendConfirmationText || !requestPattern.MatchString(m.RequestID) || m.Sender == nil || m.Revoked {
			t.Fatalf("invalid confirmation message: %+v", m)
		}
		items = append(items, m)
	}
	return items
}

func TestFriendConfirmationAcceptedIsSharedInHistorySyncAndSummary(t *testing.T) {
	f := newFixture(t)
	request, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "please add")
	if err != nil {
		t.Fatal(err)
	}
	cid, err := f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, true)
	if err != nil {
		t.Fatal(err)
	}
	var messageID string
	for _, viewer := range []Login{f.carol, f.alice} {
		messages := confirmationHistory(t, f, viewer, cid)
		if len(messages) != 1 || messages[0].SenderID != f.alice.UserID {
			t.Fatalf("accepting peer did not author one confirmation: %+v", messages)
		}
		if messageID != "" && messageID != messages[0].ID {
			t.Fatal("participants received different confirmation records")
		}
		messageID = messages[0].ID
		var history HistoryPage
		f.request(t, "GET", "/api/v2/conversations/"+cid+"/history", viewer.Token, nil, 200, &history)
		if len(history.Items) != 1 || history.Items[0].ID != messageID || history.Items[0].Body != friendConfirmationText {
			t.Fatalf("HTTP history omitted the offline confirmation: %+v", history)
		}
		page, err := f.service.Sync(f.ctx, viewer.Identity, cid, 0, nil, 100)
		if err != nil || len(page.Events) != 1 || page.Events[0].Kind != "message.created" || page.Events[0].Message.ID != messageID {
			t.Fatal("confirmation was not recoverable through sync", page, err)
		}
		conversations, err := f.service.ClientConversations(f.ctx, viewer.Identity, "", cid)
		if err != nil || len(conversations) != 1 || conversations[0].LastMessage == nil || conversations[0].LastMessage.ID != messageID {
			t.Fatal("conversation preview omitted confirmation", conversations, err)
		}
		wantUnread := 0
		if viewer.UserID == f.carol.UserID {
			wantUnread = 1
		}
		if conversations[0].Unread != wantUnread {
			t.Fatalf("unexpected confirmation unread count: %+v", conversations[0])
		}
	}
	f.request(t, "GET", "/api/v2/conversations/"+cid+"/history", f.bob.Token, nil, 403, nil)
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, true); err != nil {
		t.Fatal(err)
	}
	if len(confirmationHistory(t, f, f.carol, cid)) != 1 {
		t.Fatal("replaying an accepted request duplicated the confirmation")
	}
	var eventCount, outboxCount int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.events WHERE message_id=$1", messageID).Scan(&eventCount); err != nil || eventCount != 1 {
		t.Fatal("confirmation event not emitted exactly once", eventCount, err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.outbox WHERE conversation_id=$1 AND kind='conversation.changed'", cid).Scan(&outboxCount); err != nil || outboxCount != 1 {
		t.Fatal("confirmation did not use the existing realtime outbox", outboxCount, err)
	}
}

func TestFriendConfirmationStaffAddIsIdempotentAndFromPeer(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET allow_friend_requests=false WHERE id=$1", f.carol.UserID)
	var added, repeated map[string]string
	input := map[string]string{"target_id": f.carol.UserID}
	f.request(t, "POST", "/api/v2/friends/direct-add", f.alice.Token, input, 200, &added)
	f.request(t, "POST", "/api/v2/friends/direct-add", f.alice.Token, input, 200, &repeated)
	if added["conversation_id"] != repeated["conversation_id"] {
		t.Fatal("retry changed the direct conversation")
	}
	for _, viewer := range []Login{f.alice, f.carol} {
		messages := confirmationHistory(t, f, viewer, added["conversation_id"])
		if len(messages) != 1 || messages[0].SenderID != f.carol.UserID {
			t.Fatalf("staff add did not receive one peer confirmation: %+v", messages)
		}
	}
	var notifications, requests int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.notifications WHERE user_id=$1 AND kind='friend.added'", f.carol.UserID).Scan(&notifications); err != nil || notifications != 1 {
		t.Fatal("replayed staff add duplicated its notification", notifications, err)
	}
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friend_requests").Scan(&requests); err != nil || requests != 0 {
		t.Fatal("staff add unexpectedly required verification", requests, err)
	}
}

func TestFriendConfirmationMutualRequestUsesCurrentAcceptingPeer(t *testing.T) {
	f := newFixture(t)
	original, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "first")
	if err != nil {
		t.Fatal(err)
	}
	returned, err := f.service.FriendRequest(f.ctx, f.alice.Identity, f.carol.UserID, "mutual")
	if err != nil || returned != original {
		t.Fatal("mutual request did not accept original", returned, err)
	}
	var cid string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT id::text FROM pulse.conversations WHERE direct_key=$1", directKey(f.alice.UserID, f.carol.UserID)).Scan(&cid); err != nil {
		t.Fatal(err)
	}
	messages := confirmationHistory(t, f, f.carol, cid)
	if len(messages) != 1 || messages[0].SenderID != f.alice.UserID {
		t.Fatal("mutual confirmation used the original requester as author", messages)
	}
}

func TestFriendConfirmationPendingRejectedAndDeniedAddsStaySilent(t *testing.T) {
	f := newFixture(t)
	cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	request, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "pending")
	if err != nil {
		t.Fatal(err)
	}
	if len(confirmationHistory(t, f, f.carol, cid)) != 0 {
		t.Fatal("a pending request emitted an acceptance")
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("ordinary user bypassed force-add authorization", err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.conversations SET active=false WHERE id=$1", cid)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("force add reactivated a disabled conversation", err)
	}
	var friends, messages int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.alice.UserID, f.carol.UserID).Scan(&friends); err != nil || friends != 0 {
		t.Fatal("failed add committed its friendship", friends, err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", cid).Scan(&messages); err != nil || messages != 0 {
		t.Fatal("unsuccessful add emitted a confirmation", messages, err)
	}
}

func TestFriendConfirmationReaddPreservesHistoryRemarkAndPreferences(t *testing.T) {
	f := newFixture(t)
	cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "temporary-history", Body: "existing message"}); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	first := confirmationHistory(t, f, f.alice, cid)[0]
	if _, err = f.service.ClearHistory(f.ctx, f.alice.Identity, cid, first.Seq); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark,group_name) VALUES($1,$2,'my remark','my group')", f.alice.UserID, f.carol.UserID)
	f.exec(t, "UPDATE pulse.user_states SET hidden=true,pinned=true,muted_notifications=true WHERE conversation_id=$1", cid)
	if err = f.service.RemoveFriend(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if restored, err := f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); err != nil || restored != cid {
		t.Fatal("re-add changed the conversation", restored, err)
	}
	visible := confirmationHistory(t, f, f.alice, cid)
	if len(visible) != 1 || visible[0].ID == first.ID || visible[0].Seq <= first.Seq {
		t.Fatal("re-add resurrected cleared data or omitted new confirmation", visible)
	}
	if len(confirmationHistory(t, f, f.carol, cid)) != 2 {
		t.Fatal("re-add discarded the peer's earlier confirmation")
	}
	var hidden, pinned, muted bool
	var clearSeq int64
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT hidden,pinned,muted_notifications,clear_seq FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", cid, f.alice.UserID).Scan(&hidden, &pinned, &muted, &clearSeq); err != nil || hidden || !pinned || !muted || clearSeq != first.Seq {
		t.Fatal("confirmation reset personal preferences or clear boundary", hidden, pinned, muted, clearSeq, err)
	}
	var remark, group string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT remark,group_name FROM pulse.contact_metadata WHERE user_id=$1 AND peer_id=$2", f.alice.UserID, f.carol.UserID).Scan(&remark, &group); err != nil || remark != "my remark" || group != "my group" {
		t.Fatal("re-add changed private contact metadata", remark, group, err)
	}
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", cid, f.alice.UserID)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT hidden FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", cid, f.alice.UserID).Scan(&hidden); err != nil || !hidden {
		t.Fatal("retry reopened a subsequently hidden conversation", hidden, err)
	}
	if len(confirmationHistory(t, f, f.carol, cid)) != 2 {
		t.Fatal("retry duplicated the re-add confirmation")
	}
}

func TestFriendConfirmationConcurrentStaffAddsEmitOnlyOnce(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=ANY($1::uuid[])", []string{f.alice.UserID, f.carol.UserID})
	type result struct {
		cid string
		err error
	}
	results := make(chan result, 8)
	var workers sync.WaitGroup
	for i := 0; i < 8; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			actor, target := f.alice, f.carol
			if i%2 != 0 {
				actor, target = target, actor
			}
			cid, err := f.service.AddFriendAsStaff(f.ctx, actor.Identity, target.UserID)
			results <- result{cid, err}
		}(i)
	}
	workers.Wait()
	close(results)
	cid := ""
	for result := range results {
		if result.err != nil || (cid != "" && result.cid != cid) {
			t.Fatal("concurrent add failed or split the conversation", result)
		}
		cid = result.cid
	}
	if len(confirmationHistory(t, f, f.alice, cid)) != 1 || len(confirmationHistory(t, f, f.carol, cid)) != 1 {
		t.Fatal("concurrent adds duplicated the shared confirmation")
	}
}

func TestFriendConfirmationFailureRollsBackTheEntireAcceptance(t *testing.T) {
	f := newFixture(t)
	request, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "pending")
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `ALTER TABLE pulse.messages ADD CONSTRAINT friend_confirmation_test_failure
		CHECK(NOT (kind='system' AND content->>'kind'='friend_accepted'))`)
	defer f.exec(t, "ALTER TABLE pulse.messages DROP CONSTRAINT IF EXISTS friend_confirmation_test_failure")
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, true); err == nil {
		t.Fatal("simulated storage failure was ignored")
	}
	var status string
	var friends, conversations int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.friend_requests WHERE id=$1", request).Scan(&status); err != nil || status != "pending" {
		t.Fatal("failed confirmation committed acceptance", status, err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.alice.UserID, f.carol.UserID).Scan(&friends); err != nil || friends != 0 {
		t.Fatal("failed confirmation committed the friendship", friends, err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.conversations WHERE direct_key=$1", directKey(f.alice.UserID, f.carol.UserID)).Scan(&conversations); err != nil || conversations != 0 {
		t.Fatal("failed confirmation committed an orphan chat", conversations, err)
	}
	f.exec(t, "ALTER TABLE pulse.messages DROP CONSTRAINT friend_confirmation_test_failure")
	cid, err := f.service.DecideFriendRequest(f.ctx, f.alice.Identity, request, true)
	if err != nil || len(confirmationHistory(t, f, f.carol, cid)) != 1 {
		t.Fatal("retry after recovery did not produce one confirmation", err)
	}
}

func TestFriendConfirmationCannotBeForgedEditedOrForwarded(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	cid, err := f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	m := confirmationHistory(t, f, f.carol, cid)[0]
	if _, err = f.service.Send(f.ctx, f.carol.Identity, cid, SendInput{RequestID: "forged-acceptance", Kind: "system", Body: friendConfirmationText}); !errors.Is(err, ErrInvalid) {
		t.Fatal("client could forge a system confirmation", err)
	}
	if _, err = f.service.MutateMessage(f.ctx, f.carol.Identity, cid, m.ID, "changed", 1, false); !errors.Is(err, ErrForbidden) {
		t.Fatal("peer could edit server-authored confirmation", err)
	}
	if _, err = f.service.Send(f.ctx, f.carol.Identity, cid, SendInput{RequestID: "forward-confirmation", SourceMessageID: m.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("confirmation could be forwarded as another user's text", err)
	}
}
