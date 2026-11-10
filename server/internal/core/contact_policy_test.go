package core

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func setContactRule(t *testing.T, f *fixture, who Login, scope string, rule PrivacyRule) ContactPrivacy {
	t.Helper()
	before, err := f.service.ContactPrivacy(f.ctx, who.Identity)
	if err != nil {
		t.Fatal(err)
	}
	input := PrivacyPatch{ExpectedVersion: &before.Version}
	if scope == "temporary_chat" {
		input.TemporaryChat = &rule
	} else {
		input.GroupInvites = &rule
	}
	result, err := f.service.UpdateContactPrivacy(f.ctx, who.Identity, input)
	if err != nil {
		t.Fatal(err)
	}
	return result
}
func TestTemporaryChatWithoutFriendshipRespectsCurrentPrivacy(t *testing.T) {
	f := newFixture(t)
	cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	friends, err := f.service.Friends(f.ctx, f.alice.Identity, "")
	if err != nil || len(friends) != 1 {
		t.Fatal("temporary chat created friendship", friends, err)
	}
	list, err := f.service.Conversations(f.ctx, f.alice.Identity, "")
	if err != nil {
		t.Fatal(err)
	}
	temporary := false
	for _, c := range list {
		if c.ID == cid {
			temporary = c.Temporary
		}
	}
	if !temporary {
		t.Fatal("temporary conversation is not identified")
	}
	sent, err := f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "temporary-first", Body: "hello"})
	if err != nil {
		t.Fatal(err)
	}
	setContactRule(t, f, f.carol, "temporary_chat", PrivacyRule{Visibility: "contacts"})
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "privacy-denied", Body: "blocked"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("existing chat bypassed new privacy", err)
	}
	if _, err = f.service.MutateMessage(f.ctx, f.alice.Identity, cid, sent.Message.ID, "edited", 1, false); !errors.Is(err, ErrForbidden) {
		t.Fatal("edit bypassed privacy", err)
	}
	source := f.send(t, "temporary-source", "forward")
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "forward-denied", SourceMessageID: source.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("forward bypassed privacy", err)
	}
	setContactRule(t, f, f.carol, "temporary_chat", PrivacyRule{Visibility: "nobody", Allow: []string{f.alice.UserID}})
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "allow-exception", Body: "allowed"}); err != nil {
		t.Fatal(err)
	}
	if err = f.service.Block(f.ctx, f.carol.Identity, f.alice.UserID, true); err != nil {
		t.Fatal(err)
	}
	for _, pair := range []struct {
		actor Login
		peer  Login
	}{{f.alice, f.carol}, {f.carol, f.alice}} {
		if _, err = f.service.Direct(f.ctx, pair.actor.Identity, pair.peer.UserID); !errors.Is(err, ErrForbidden) {
			t.Fatal("block did not stop direct", err)
		}
		if _, err = f.service.Send(f.ctx, pair.actor.Identity, cid, SendInput{RequestID: "block-" + pair.actor.DeviceID, Body: "blocked"}); !errors.Is(err, ErrForbidden) {
			t.Fatal("block did not stop send", err)
		}
	}
	if err = f.service.Block(f.ctx, f.carol.Identity, f.alice.UserID, false); err != nil {
		t.Fatal(err)
	}
	setContactRule(t, f, f.carol, "temporary_chat", PrivacyRule{Visibility: "everyone", Deny: []string{f.alice.UserID}})
	if _, err = f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("deny exception ignored", err)
	}
	request, err := f.service.FriendRequest(f.ctx, f.alice.Identity, f.carol.UserID, "become contacts")
	if err != nil {
		t.Fatal(err)
	}
	friendCID, err := f.service.DecideFriendRequest(f.ctx, f.carol.Identity, request, true)
	if err != nil || friendCID != cid {
		t.Fatal("friend acceptance lost temporary history", err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "now-friends", Body: "friend chat"}); err != nil {
		t.Fatal("temporary-only rule incorrectly blocks friends", err)
	}
	if err = f.service.RemoveFriend(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "again-temporary", Body: "blocked"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("friend removal failed to restore temporary privacy", err)
	}
}

func TestContactPrivacyOwnershipValidationAndVersion(t *testing.T) {
	f := newFixture(t)
	var before ContactPrivacy
	f.request(t, "GET", "/api/v2/me/privacy", f.carol.Token, nil, 200, &before)
	nobody := PrivacyRule{Visibility: "nobody"}
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &before.Version, GroupInvites: &nobody}, 403, nil)
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, map[string]any{"expected_version": fmt.Sprint(before.Version), "user_id": f.alice.UserID, "temporary_chat": nobody}, 400, nil)
	invalid := PrivacyRule{Visibility: "everyone", Allow: []string{f.alice.UserID}, Deny: []string{f.alice.UserID}}
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &before.Version, TemporaryChat: &invalid}, 400, nil)
	missing := PrivacyRule{Visibility: "everyone", Allow: []string{newID()}}
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &before.Version, TemporaryChat: &missing}, 400, nil)
	var changed ContactPrivacy
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &before.Version, TemporaryChat: &nobody}, 200, &changed)
	if changed.Version != before.Version+1 || changed.TemporaryChat.Visibility != "nobody" {
		t.Fatal("privacy not persisted", changed)
	}
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &before.Version, TemporaryChat: &nobody}, 409, nil)
	var unrelated ContactPrivacy
	f.request(t, "GET", "/api/v2/me/privacy", f.alice.Token, nil, 200, &unrelated)
	if unrelated.TemporaryChat.Visibility != "everyone" {
		t.Fatal("changed another account")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.carol.UserID)
	policy := setContactRule(t, f, f.carol, "group_invites", PrivacyRule{Visibility: "contacts", Deny: []string{f.bob.UserID}})
	if !policy.CanManageGroupInvites || policy.GroupInvites.Visibility != "contacts" || len(policy.GroupInvites.Deny) != 1 {
		t.Fatal("staff privacy missing")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.carol.UserID)
	f.request(t, "PATCH", "/api/v2/me/privacy", f.carol.Token, PrivacyPatch{ExpectedVersion: &policy.Version, GroupInvites: &nobody}, 403, nil)
}

func TestInvitationHistoryChoiceAndRejoinPreservePersonalVisibility(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "history choice", nil)
	if err != nil {
		t.Fatal(err)
	}
	send := func(key string) Message {
		result, e := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: key, Body: key})
		if e != nil {
			t.Fatal(e)
		}
		return result.Message
	}
	old := send("old-history")
	path := "/api/v2/groups/" + group.ID + "/members"
	f.request(t, "POST", path, f.alice.Token, map[string]any{"target_id": f.bob.UserID}, 400, nil)
	f.request(t, "POST", path, f.alice.Token, map[string]any{"target_id": f.bob.UserID, "allow_history": false}, 204, nil)
	page, err := f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 0 || page.HistoryAllowed || page.VisibleFromSeq != old.Seq+1 {
		t.Fatal("history leaked to unchecked invite", page, err)
	}
	firstVersion := page.MembershipVersion
	recent := send("since-joining")
	f.request(t, "POST", path, f.alice.Token, map[string]any{"target_id": f.bob.UserID, "allow_history": true}, 204, nil)
	page, err = f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != recent.ID || page.MembershipVersion != firstVersion || page.HistoryAllowed {
		t.Fatal("repeat invite expanded history", page, err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, f.cid, SendInput{RequestID: "hidden-history-forward", SourceMessageID: old.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("forward exposed hidden history", err)
	}
	f.request(t, "POST", path, f.bob.Token, map[string]any{"target_id": f.carol.UserID, "allow_history": true}, 403, nil)
	// Carol is not the inviter's friend, but accepts invitations from everyone.
	f.request(t, "POST", path, f.alice.Token, map[string]any{"target_id": f.carol.UserID, "allow_history": true}, 204, nil)
	page, err = f.service.Sync(f.ctx, f.carol.Identity, group.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 2 || !page.HistoryAllowed || page.VisibleFromSeq != 1 || page.VisibleFromEventSeq != 1 {
		t.Fatal("checked invite did not grant history", page, err)
	}
	if _, err = f.service.ClearHistory(f.ctx, f.bob.Identity, group.ID, recent.Seq); err != nil {
		t.Fatal(err)
	}
	deleted := send("personally-deleted")
	if _, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, group.ID, []string{deleted.ID}); err != nil {
		t.Fatal(err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	newest := send("after-removal")
	f.request(t, "POST", path, f.alice.Token, map[string]any{"target_id": f.bob.UserID, "allow_history": true}, 204, nil)
	page, err = f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != newest.ID || page.MembershipVersion != firstVersion+1 {
		t.Fatal("rejoin revived cleared/deleted history", page, err)
	}
	f.request(t, "GET", fmt.Sprintf("/api/v2/conversations/%s/sync?membership_version=%d", group.ID, firstVersion), f.bob.Token, nil, 409, nil)
	var access ConversationAccess
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/access", f.bob.Token, nil, 200, &access)
	if access.MembershipVersion != page.MembershipVersion || !access.HistoryAllowed {
		t.Fatal("access did not expose new scope", access)
	}
	list, err := f.service.Conversations(f.ctx, f.bob.Identity, "")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range list {
		if c.ID == group.ID {
			found = c.MembershipVersion == page.MembershipVersion && c.HistoryAllowed
		}
	}
	if !found {
		t.Fatal("directory omitted membership reset boundary")
	}
	// A self-join payload cannot grant itself privileged history visibility.
	f.request(t, "POST", "/api/v2/groups/"+group.ID+"/join", f.carol.Token, map[string]any{"invite_code": group.InviteCode, "allow_history": true}, 400, nil)
}

func TestGroupInvitationPrivacyAppliesToInitialAndBatchMembers(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.carol.UserID)
	setContactRule(t, f, f.carol, "group_invites", PrivacyRule{Visibility: "contacts"})
	if _, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "denied initial", []string{f.carol.UserID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("initial invite ignored privacy", err)
	}
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "batch privacy", nil)
	if err != nil {
		t.Fatal(err)
	}
	msg, err := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "batch-old", Body: "old"})
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Items []InviteResult `json:"items"`
	}
	f.request(t, "POST", "/api/v2/groups/"+group.ID+"/members/batch", f.alice.Token, map[string]any{"user_ids": []string{f.bob.UserID, f.carol.UserID}, "allow_history": true}, 200, &result)
	if len(result.Items) != 2 || !result.Items[0].Added || result.Items[1].Error != "forbidden" {
		t.Fatal("batch privacy result", result)
	}
	page, err := f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != msg.Message.ID {
		t.Fatal("batch history choice missing", err)
	}
	setContactRule(t, f, f.carol, "group_invites", PrivacyRule{Visibility: "nobody", Allow: []string{f.alice.UserID}})
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if err = f.service.Block(f.ctx, f.carol.Identity, f.alice.UserID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.CreateGroup(f.ctx, f.alice.Identity, "block precedence", []string{f.carol.UserID}); !errors.Is(err, ErrForbidden) {
		t.Fatal("allow exception bypassed block", err)
	}
}

func TestContactPrivacyChangesSerializeWithAdmissionAndSend(t *testing.T) {
	for _, operation := range []string{"direct", "send", "invite"} {
		t.Run(operation, func(t *testing.T) {
			f := newFixture(t)
			cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
			if err != nil {
				t.Fatal(err)
			}
			group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "privacy order", nil)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := f.store.Pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(f.ctx)
			if err = lockContactPrivacy(f.ctx, tx, []string{f.carol.UserID}, true); err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				var e error
				switch operation {
				case "direct":
					_, e = f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
				case "send":
					_, e = f.service.Send(f.ctx, f.alice.Identity, cid, SendInput{RequestID: "policy-race", Body: "denied"})
				case "invite":
					e = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, true)
				}
				done <- e
			}()
			deadline := time.Now().Add(time.Second)
			for {
				select {
				case e := <-done:
					t.Fatalf("operation crossed pending policy change: %v", e)
				default:
				}
				var waiting int
				if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'").Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("policy check did not reach gate")
				}
				time.Sleep(5 * time.Millisecond)
			}
			if _, err = tx.Exec(f.ctx, `INSERT INTO pulse.privacy_settings(user_id,temporary_chat,group_invites) VALUES($1,'nobody','nobody')
            ON CONFLICT(user_id) DO UPDATE SET temporary_chat='nobody',group_invites='nobody',version=pulse.privacy_settings.version+1`, f.carol.UserID); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case e := <-done:
				if !errors.Is(e, ErrForbidden) {
					t.Fatal("committed privacy was ignored", e)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("operation never completed")
			}
		})
	}
}

func TestTemporaryChatCannotReactivateDisabledConversation(t *testing.T) {
	f := newFixture(t)
	cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET active=false WHERE id=$1", cid)
	if _, err = f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("temporary chat reopened disabled conversation", err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("friendship reopened disabled conversation", err)
	}
	var active bool
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT active FROM pulse.conversations WHERE id=$1", cid).Scan(&active); err != nil || active {
		t.Fatal("disabled flag was lost", err)
	}
}
