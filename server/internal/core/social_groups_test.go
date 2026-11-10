package core

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestFriendRequestDecisionBlockAndStaffAdd(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "please add"); err != nil {
		t.Fatal(err)
	}
	requests, err := f.service.IncomingFriendRequests(f.ctx, f.alice.Identity)
	if err != nil || len(requests) != 1 {
		t.Fatalf("incoming request: %v", err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.carol.Identity, requests[0], true); !errors.Is(err, ErrForbidden) {
		t.Fatal("sender accepted own request")
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.DecideFriendRequest(f.ctx, f.alice.Identity, requests[0], true); !errors.Is(err, ErrForbidden) {
		t.Fatal("block did not prevent acceptance")
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, false); err != nil {
		t.Fatal(err)
	}
	id, err := f.service.DecideFriendRequest(f.ctx, f.alice.Identity, requests[0], true)
	if err != nil || !validID(id) {
		t.Fatalf("acceptance: %v", err)
	}
	if repeated, err := f.service.DecideFriendRequest(f.ctx, f.alice.Identity, requests[0], true); err != nil || repeated != id {
		t.Fatal("same decision did not return its prior result")
	}
	if _, err = f.service.Send(f.ctx, f.carol.Identity, id, SendInput{RequestID: "friend-message", Body: "hello"}); err != nil {
		t.Fatal(err)
	}
	if err = f.service.RemoveFriend(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.carol.Identity, id, SendInput{RequestID: "after-removal", Body: "temporary conversation"}); err != nil {
		t.Fatalf("friend removal should preserve permitted temporary chat: %v", err)
	}
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.carol.Identity, f.alice.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("ordinary user used staff shortcut")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.carol.UserID)
	staffID, err := f.service.AddFriendAsStaff(f.ctx, f.carol.Identity, f.alice.UserID)
	if err != nil || staffID != id {
		t.Fatalf("staff shortcut did not restore direct conversation: %v", err)
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.carol.Identity, f.alice.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("staff shortcut bypassed block")
	}
}

func TestDirectSendSerializesWithBlockAndFriendRemoval(t *testing.T) {
	f := newFixture(t)
	for _, mutation := range []struct {
		name string
		run  func() error
	}{
		{"block", func() error { return f.service.Block(f.ctx, f.bob.Identity, f.alice.UserID, true) }},
		{"remove", func() error { return f.service.RemoveFriend(f.ctx, f.bob.Identity, f.alice.UserID) }},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			if mutation.name == "remove" {
				f.exec(t, "DELETE FROM pulse.blocks")
				setContactRule(t, f, f.bob, "temporary_chat", PrivacyRule{Visibility: "contacts"})
			}
			tx, err := f.store.Pool.Begin(f.ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(f.ctx)
			if err = lockPair(f.ctx, tx, f.alice.UserID, f.bob.UserID); err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			go func() { result <- mutation.run() }()
			select {
			case err := <-result:
				t.Fatalf("mutation passed held pair lock: %v", err)
			case <-time.After(40 * time.Millisecond):
			}
			if err = tx.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err = <-result:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("mutation did not finish")
			}
			_, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: mutation.name, Body: "must be rejected"})
			if !errors.Is(err, ErrForbidden) {
				t.Fatalf("message after %s committed: %v", mutation.name, err)
			}
		})
	}
}

func TestGroupLifecycleRolesMuteAndRejoinVisibility(t *testing.T) {
	f := newFixture(t)
	created, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "project", []string{f.bob.UserID})
	if err != nil || !validID(created.ID) || len(created.InviteCode) != 64 {
		t.Fatalf("create group: %+v %v", created, err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, created.ID, SendInput{RequestID: "before-join", Body: "old group history"}); err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, created.ID, "incorrect"); !errors.Is(err, ErrInvalid) && !errors.Is(err, ErrForbidden) {
		t.Fatal("bad invite accepted")
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, created.ID, created.InviteCode); err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, created.ID, ""); err != nil {
		t.Fatal("repeat join should be idempotent")
	}
	page, err := f.service.Sync(f.ctx, f.carol.Identity, created.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 0 || page.NextAfterSeq != 1 {
		t.Fatal("new member received old history")
	}
	if err = f.service.SetGroupMute(f.ctx, f.bob.Identity, created.ID, f.alice.UserID, true); !errors.Is(err, ErrForbidden) {
		t.Fatal("member muted owner")
	}
	if err = f.service.SetGroupRole(f.ctx, f.alice.Identity, created.ID, f.bob.UserID, "admin"); err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupMute(f.ctx, f.bob.Identity, created.ID, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.carol.Identity, created.ID, SendInput{RequestID: "muted", Body: "rejected"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("mute ignored")
	}
	if err = f.service.SetGroupMute(f.ctx, f.bob.Identity, created.ID, f.bob.UserID, true); !errors.Is(err, ErrForbidden) {
		t.Fatal("admin muted self")
	}
	if err = f.service.SetGroupMute(f.ctx, f.alice.Identity, created.ID, f.carol.UserID, false); err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupMuteAll(f.ctx, f.bob.Identity, created.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.carol.Identity, created.ID, SendInput{RequestID: "all-muted", Body: "rejected"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("mute-all ignored")
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, created.ID, SendInput{RequestID: "admin-exception", Body: "allowed"}); err != nil {
		t.Fatal(err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.bob.Identity, created.ID, f.alice.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("admin removed owner")
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.bob.Identity, created.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Sync(f.ctx, f.carol.Identity, created.ID, 0, nil, 100); !errors.Is(err, ErrForbidden) {
		t.Fatal("removed member retained history")
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, created.ID, created.InviteCode); err != nil {
		t.Fatal(err)
	}
	page, err = f.service.Sync(f.ctx, f.carol.Identity, created.ID, 0, nil, 100)
	if err != nil || len(page.Events) != 0 {
		t.Fatal("rejoined member received prior membership history")
	}
	if err = f.service.TransferGroup(f.ctx, f.alice.Identity, created.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	if err = f.service.DissolveGroup(f.ctx, f.alice.Identity, created.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("former owner dissolved group")
	}
	if err = f.service.DissolveGroup(f.ctx, f.bob.Identity, created.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, created.ID, SendInput{RequestID: "after-dissolve", Body: "rejected"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("dissolved group accepted message")
	}
}

func TestGroupInvitePrivacyCapacityAndMemberListing(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,group_invites) VALUES($1,'contacts')", f.carol.UserID)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "limited", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("invited nonfriend")
	}
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,group_invites) VALUES($1,'nobody') ON CONFLICT(user_id) DO UPDATE SET group_invites='nobody'", f.bob.UserID)
	if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("ignored invite privacy")
	}
	f.exec(t, "UPDATE pulse.privacy_settings SET group_invites='everyone' WHERE user_id=$1", f.bob.UserID)
	if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET member_limit=2 WHERE id=$1", group.ID)
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode); err == nil {
		t.Fatal("capacity ignored")
	}
	if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal("repeat invite should be idempotent")
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	members, err := f.service.GroupMembers(f.ctx, f.bob.Identity, group.ID, "")
	if err != nil || len(members) != 1 || members[0] != f.alice.UserID {
		t.Fatalf("member list: %v %+v", err, members)
	}
}

func TestGroupJoinDeniedWhenBlockedByOwner(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "blocked join", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode); !errors.Is(err, ErrForbidden) {
		t.Fatalf("blocked user joined with valid code: %v", err)
	}
	if err = f.service.Block(f.ctx, f.alice.Identity, f.carol.UserID, false); err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.carol.Identity, group.ID, group.InviteCode); err != nil {
		t.Fatal(err)
	}
}

func TestBatchInviteReturnsPerTargetProgress(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,group_invites) VALUES($1,'contacts')", f.carol.UserID)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "batch", nil)
	if err != nil {
		t.Fatal(err)
	}
	results, err := f.service.InviteGroupMembers(f.ctx, f.alice.Identity, group.ID, []string{f.bob.UserID, f.carol.UserID})
	if err != nil || len(results) != 2 || !results[0].Added || results[1].Added || results[1].Error != "forbidden" {
		t.Fatalf("batch result: %+v %v", results, err)
	}
	results, err = f.service.InviteGroupMembers(f.ctx, f.alice.Identity, group.ID, []string{f.bob.UserID})
	if err != nil || len(results) != 1 || !results[0].Added {
		t.Fatal("repeat invite should be recoverable")
	}
	results, err = f.service.InviteGroupMembers(f.ctx, f.bob.Identity, group.ID, []string{f.carol.UserID})
	if err != nil || len(results) != 1 || results[0].Added || results[0].Error != "forbidden" {
		t.Fatal("ordinary member invite result incorrect")
	}
}

func TestConcurrentGroupMuteAndSendHaveCommitBoundary(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "ordered", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if err = lockConversations(f.ctx, tx, []string{group.ID}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	mutation := make(chan error, 1)
	wg.Go(func() { mutation <- f.service.SetGroupMute(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, true) })
	select {
	case err = <-mutation:
		t.Fatalf("mutation passed held conversation lock: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if err = <-mutation; err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "after-group-mute", Body: "must fail"})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("post-mute send: %v", err)
	}
	if _, err = f.service.Sync(f.ctx, f.carol.Identity, group.ID, 0, nil, 100); !errors.Is(err, ErrForbidden) {
		t.Fatal("outsider read group")
	}
	var actual bool
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT muted FROM pulse.members WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID).Scan(&actual); err != nil || !actual {
		t.Fatal("mute did not commit")
	}
}

func TestHTTPFriendGroupAndPersonalRoutes(t *testing.T) {
	f := newFixture(t)
	var incoming struct {
		Items []string `json:"items"`
	}
	var req struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/friend-requests", f.carol.Token, map[string]string{"target_id": f.alice.UserID, "note": "hello"}, 201, &req)
	f.request(t, "GET", "/api/v2/friend-requests/incoming", f.alice.Token, nil, 200, &incoming)
	if len(incoming.Items) != 1 || incoming.Items[0] != req.ID {
		t.Fatal("friend request missing")
	}
	f.request(t, "PUT", "/api/v2/friend-requests/"+req.ID+"/decision", f.alice.Token, map[string]bool{"accept": true}, 200, nil)
	var friends struct {
		Items []string `json:"items"`
	}
	f.request(t, "GET", "/api/v2/friends", f.alice.Token, nil, 200, &friends)
	if len(friends.Items) != 2 {
		t.Fatal("friend list was not updated")
	}
	f.request(t, "PUT", "/api/v2/blocks/"+f.carol.UserID, f.alice.Token, nil, 204, nil)
	f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.carol.UserID}, 403, nil)
	f.request(t, "DELETE", "/api/v2/blocks/"+f.carol.UserID, f.alice.Token, nil, 204, nil)
	var group GroupCreated
	f.request(t, "POST", "/api/v2/groups", f.alice.Token, map[string]any{"title": "API group", "initial_members": []string{f.bob.UserID}}, 201, &group)
	var details GroupDetails
	f.request(t, "GET", "/api/v2/groups/"+group.ID, f.alice.Token, nil, 200, &details)
	if details.Title != "API group" || details.MyRole != "owner" {
		t.Fatal("group details invalid")
	}
	f.request(t, "PATCH", "/api/v2/groups/"+group.ID, f.bob.Token, map[string]string{"title": "unauthorized"}, 403, nil)
	f.request(t, "PATCH", "/api/v2/groups/"+group.ID, f.alice.Token, map[string]any{"title": "renamed", "join_policy": "invite", "member_limit": 4}, 200, &details)
	if details.Title != "renamed" || details.MemberLimit != 4 {
		t.Fatal("settings not saved")
	}
	var rotated struct {
		InviteCode string `json:"invite_code"`
	}
	f.request(t, "POST", "/api/v2/groups/"+group.ID+"/invite-code/rotate", f.alice.Token, nil, 200, &rotated)
	f.request(t, "POST", "/api/v2/groups/"+group.ID+"/join", f.carol.Token, map[string]string{"invite_code": group.InviteCode}, 403, nil)
	f.request(t, "POST", "/api/v2/groups/"+group.ID+"/join", f.carol.Token, map[string]string{"invite_code": rotated.InviteCode}, 204, nil)
	f.request(t, "PUT", "/api/v2/groups/"+group.ID+"/members/"+f.carol.UserID+"/muted", f.bob.Token, map[string]bool{"muted": true}, 403, nil)
	f.request(t, "PUT", "/api/v2/groups/"+group.ID+"/members/"+f.carol.UserID+"/muted", f.alice.Token, map[string]bool{"muted": true}, 204, nil)
	f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/messages", f.carol.Token, SendInput{RequestID: "muted-http", Body: "blocked"}, 403, nil)
	var sent SendResult
	f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/messages", f.alice.Token, SendInput{RequestID: "owner-http", Body: "notice"}, 201, &sent)
	var unread Unread
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/unread", f.bob.Token, nil, 200, &unread)
	if unread.Count != 1 {
		t.Fatal("HTTP unread count incorrect")
	}
	f.request(t, "POST", "/api/v2/conversations/"+group.ID+"/personal-deletions", f.bob.Token, map[string][]string{"message_ids": []string{sent.Message.ID}}, 200, nil)
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/unread", f.bob.Token, nil, 200, &unread)
	if unread.Count != 0 {
		t.Fatal("personal delete did not update unread")
	}
	var personal PersonalPage
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/personal-sync", f.bob.Token, nil, 200, &personal)
	if len(personal.Events) != 1 || personal.Events[0].MessageID != sent.Message.ID {
		t.Fatal("personal event not returned")
	}
	f.request(t, "PUT", "/api/v2/conversations/"+group.ID+"/clear", f.bob.Token, map[string]string{"through_seq": "1"}, 200, nil)
	f.request(t, "DELETE", "/api/v2/groups/"+group.ID, f.bob.Token, nil, 403, nil)
	f.request(t, "DELETE", "/api/v2/groups/"+group.ID, f.alice.Token, nil, 204, nil)
}

func TestRemovedMemberGetsTargetedDirectoryInvalidation(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "removal", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	bobSocket := f.ws(t, f.bob)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	hint := readHint(t, bobSocket)
	if hint.Type != "membership.changed" || hint.ConversationID != group.ID || hint.UserID != f.bob.UserID {
		t.Fatalf("removed member received wrong hint: %+v", hint)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "after-removal", Body: "private"}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100); !errors.Is(err, ErrForbidden) {
		t.Fatal("removed member could still sync")
	}
}

func TestConversationAccessExplainsSendRestriction(t *testing.T) {
	f := newFixture(t)
	access, err := f.service.ConversationAccess(f.ctx, f.alice.Identity, f.cid)
	if err != nil || !access.CanSend {
		t.Fatalf("allowed direct access: %+v %v", access, err)
	}
	if err = f.service.Block(f.ctx, f.bob.Identity, f.alice.UserID, true); err != nil {
		t.Fatal(err)
	}
	access, err = f.service.ConversationAccess(f.ctx, f.alice.Identity, f.cid)
	if err != nil || access.CanSend || access.Reason != "peer_unavailable" {
		t.Fatal("direct restriction not explained")
	}
	if err = f.service.Block(f.ctx, f.bob.Identity, f.alice.UserID, false); err != nil {
		t.Fatal(err)
	}
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "muted", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupMuteAll(f.ctx, f.alice.Identity, group.ID, true); err != nil {
		t.Fatal(err)
	}
	access, err = f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || access.CanSend || access.Reason != "group_mute_all" {
		t.Fatalf("group restriction: %+v %v", access, err)
	}
	if err = f.service.SetGroupMute(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, true); err != nil {
		t.Fatal(err)
	}
	access, err = f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || access.Reason != "member_mute" {
		t.Fatal("individual mute reason lost")
	}
	f.exec(t, "UPDATE pulse.users SET can_send=false WHERE id=$1", f.bob.UserID)
	access, err = f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || access.Reason != "account_mute" {
		t.Fatal("account mute reason lost")
	}
	if _, err = f.service.ConversationAccess(f.ctx, f.carol.Identity, group.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("outsider saw conversation status")
	}
}

func TestAccountLookupAndFriendRequestPaginationPrivacy(t *testing.T) {
	f := newFixture(t)
	user, err := f.service.LookupAccount(f.ctx, f.alice.Identity, "CAROL01")
	if err != nil || user.ID != f.carol.UserID || user.Account != "carol01" {
		t.Fatalf("exact account lookup: %+v %v", user, err)
	}
	if _, err = f.service.LookupAccount(f.ctx, f.alice.Identity, "car"); !errors.Is(err, ErrMissing) {
		t.Fatal("partial account search accepted")
	}
	requestID, err := f.service.FriendRequest(f.ctx, f.carol.Identity, f.alice.UserID, "privacy note")
	if err != nil {
		t.Fatal(err)
	}
	items, err := f.service.FriendRequests(f.ctx, f.alice.Identity, "incoming", "")
	if err != nil || len(items) != 1 || items[0].ID != requestID || items[0].Note != "privacy note" {
		t.Fatal("recipient request list")
	}
	items, err = f.service.FriendRequests(f.ctx, f.bob.Identity, "incoming", "")
	if err != nil || len(items) != 0 {
		t.Fatal("third party read friend request")
	}
	items, err = f.service.FriendRequests(f.ctx, f.carol.Identity, "outgoing", "")
	if err != nil || len(items) != 1 || items[0].TargetID != f.alice.UserID {
		t.Fatal("sender request list")
	}
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.alice.UserID, f.carol.UserID)
	if _, err = f.service.LookupAccount(f.ctx, f.alice.Identity, "carol01"); !errors.Is(err, ErrMissing) {
		t.Fatal("blocked account leaked through lookup")
	}
}
