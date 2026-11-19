package core

import (
	"errors"
	"testing"
)

func TestInactiveAvatarsAreOmittedFromHistoryAndRestore(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	avatar := uploadTestImage(t, f, f.bob, imageBytes(t, 20, 20), false)
	f.exec(t, "UPDATE pulse.users SET nickname='Historical sender',avatar_id=$2 WHERE id=$1", f.bob.UserID, avatar.ID)
	parent, err := f.service.Send(f.ctx, f.bob.Identity, f.cid, SendInput{RequestID: "avatar-history", Body: "historical author"})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "avatar-reply", Body: "reply", ReplyToID: parent.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	prefix := "/api/v2/conversations/" + f.cid
	for _, active := range []bool{true, false, true} {
		f.exec(t, "UPDATE pulse.users SET active=$2 WHERE id=$1", f.bob.UserID, active)
		want := ""
		if active {
			want = avatar.ID
		}
		check := func(message Message) {
			t.Helper()
			if message.ID == parent.Message.ID && (message.Sender == nil || message.Sender.Name != "Historical sender" || message.Sender.AvatarID != want) {
				t.Fatalf("active=%v sender=%+v", active, message.Sender)
			}
		}
		var message Message
		f.request(t, "GET", prefix+"/messages/"+parent.Message.ID, f.alice.Token, nil, 200, &message)
		check(message)
		for _, path := range []string{prefix + "/history", prefix + "/search?q=historical", "/api/v2/messages/search?conversation_id=" + f.cid + "&q=historical"} {
			var page struct {
				Items []Message `json:"items"`
			}
			f.request(t, "GET", path, f.alice.Token, nil, 200, &page)
			if len(page.Items) == 0 {
				t.Fatal("historical messages disappeared")
			}
			for _, message := range page.Items {
				check(message)
			}
		}
		list, err := f.service.ClientConversations(f.ctx, f.alice.Identity, "", f.cid)
		if err != nil || len(list) != 1 || list[0].AvatarID != want {
			t.Fatalf("active=%v conversations=%+v err=%v", active, list, err)
		}
		sync, err := f.service.Sync(f.ctx, f.alice.Identity, f.cid, 0, nil, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, event := range sync.Events {
			check(event.Message)
		}
		var quoted struct {
			Items []struct {
				Message Message `json:"message"`
			} `json:"items"`
		}
		f.request(t, "POST", prefix+"/reply-contexts", f.alice.Token, map[string][]string{"message_ids": {reply.Message.ID}}, 200, &quoted)
		if len(quoted.Items) != 1 {
			t.Fatal("quote missing")
		}
		check(quoted.Items[0].Message)
		_, err = f.service.createMediaGrant(f.ctx, f.alice.Identity, avatar.ID)
		if active && err != nil || !active && !errors.Is(err, ErrForbidden) {
			t.Fatalf("avatar authorization active=%v err=%v", active, err)
		}
	}
}

func TestOptimizedMediaBatchPreservesMixedVisibilityAndMultipleReferences(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	own := uploadTestImage(t, f, f.bob, imageBytes(t, 16, 16), false)
	private := uploadTestImage(t, f, f.carol, imageBytes(t, 17, 17), false)
	shared := uploadTestImage(t, f, f.alice, imageBytes(t, 18, 18), false)
	avatar := uploadTestImage(t, f, f.carol, imageBytes(t, 19, 19), false)
	groupAvatar := uploadTestImage(t, f, f.alice, imageBytes(t, 20, 20), false)
	pending := uploadTestImage(t, f, f.bob, imageBytes(t, 21, 21), false)
	f.exec(t, "UPDATE pulse.media SET status='failed' WHERE id=$1", pending.ID)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", f.carol.UserID, avatar.ID)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "visibility", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET avatar_id=$2 WHERE id=$1", group.ID, groupAvatar.ID)
	first, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "media-first", Kind: "image", MediaID: shared.ID})
	if err != nil {
		t.Fatal(err)
	}
	second, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "media-second", Kind: "image", MediaID: shared.ID})
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{own.ID, private.ID, shared.ID, avatar.ID, groupAvatar.ID, pending.ID}
	for len(ids) < 128 {
		ids = append(ids, newID())
	}
	allowed := map[string]bool{own.ID: true, shared.ID: true, avatar.ID: true, groupAvatar.ID: true}
	check := func() {
		t.Helper()
		items, err := f.service.batchMediaGrants(f.ctx, f.bob.Identity, ids)
		if err != nil || len(items) != 128 {
			t.Fatalf("items=%d err=%v", len(items), err)
		}
		for _, item := range items {
			if (item.Access != nil) != allowed[item.ID] || (!allowed[item.ID] && (item.Error == nil || item.Error.Status != 403)) {
				t.Fatalf("unexpected media permission %s", item.ID)
			}
		}
	}
	check()
	if _, err = f.deleteMessagesAsStaff(t, f.ctx, f.bob.Identity, f.cid, []string{first.Message.ID}); err != nil {
		t.Fatal(err)
	}
	check() // Another visible reference still authorizes the same media.
	if _, err = f.deleteMessagesAsStaff(t, f.ctx, f.bob.Identity, f.cid, []string{second.Message.ID}); err != nil {
		t.Fatal(err)
	}
	delete(allowed, shared.ID)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.carol.UserID)
	delete(allowed, avatar.ID)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	delete(allowed, groupAvatar.ID)
	check()
	f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.carol.UserID)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.carol.UserID)
	check()
	if err = f.service.Logout(f.ctx, f.bob.Identity); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.batchMediaGrants(f.ctx, f.bob.Identity, ids); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("revoked identity: %v", err)
	}
}
