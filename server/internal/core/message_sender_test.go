package core

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVisibleMessageSenderKeepsIdentityWithoutOpeningMemberDirectory(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	photo := uploadTestImage(t, f, f.carol, imageBytes(t, 40, 30), true)
	f.exec(t, "UPDATE pulse.users SET nickname='Visible author',avatar_id=$2,phone='13800000009' WHERE id=$1", f.carol.UserID, photo.ID)
	group, err := f.service.CreateGroupWithPrivacy(f.ctx, f.alice.Identity, "restricted authors", []string{f.bob.UserID, f.carol.UserID}, true)
	if err != nil {
		t.Fatal(err)
	}
	sent, err := f.service.Send(f.ctx, f.carol.Identity, group.ID, SendInput{RequestID: "visible-author", Body: "author identity"})
	if err != nil {
		t.Fatal(err)
	}
	check := func(m Message) {
		t.Helper()
		if m.Sender == nil || m.Sender.Name != "Visible author" || m.Sender.AvatarID != photo.ID {
			t.Fatalf("missing visible author: %+v", m)
		}
		raw, _ := json.Marshal(m)
		for _, secret := range []string{"13800000009", "carol01", "password_hash", "last_active_at"} {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("private profile field in message: %s", secret)
			}
		}
	}
	check(sent.Message)
	prefix := "/api/v2/conversations/" + group.ID
	var page struct {
		Items []Message `json:"items"`
	}
	for _, path := range []string{prefix + "/history", prefix + "/search?q=author", "/api/v2/messages/search?conversation_id=" + group.ID + "&q=author"} {
		f.request(t, "GET", path, f.bob.Token, nil, 200, &page)
		if len(page.Items) != 1 {
			t.Fatal(path, page)
		}
		check(page.Items[0])
	}
	var got Message
	f.request(t, "GET", prefix+"/messages/"+sent.Message.ID, f.bob.Token, nil, 200, &got)
	check(got)
	list, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", group.ID)
	if err != nil || len(list) != 1 || list[0].LastMessage == nil {
		t.Fatal(list, err)
	}
	check(*list[0].LastMessage)
	syncPage, err := f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
	if err != nil || len(syncPage.Events) != 1 {
		t.Fatal(syncPage, err)
	}
	check(syncPage.Events[0].Message)
	var reply SendResult
	f.request(t, "POST", prefix+"/messages", f.bob.Token, SendInput{RequestID: "author-reference", Body: "reply", ReplyToID: sent.Message.ID}, 201, &reply)
	var contexts struct {
		Items []struct {
			Message Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", prefix+"/reply-contexts", f.bob.Token, map[string][]string{"message_ids": {reply.Message.ID}}, 200, &contexts)
	if len(contexts.Items) != 1 {
		t.Fatal(contexts)
	}
	check(contexts.Items[0].Message)
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID+"?conversation_id="+group.ID, f.bob.Token, nil, 403, nil)
	var members struct {
		Items []map[string]any `json:"items"`
	}
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/member-profiles", f.bob.Token, nil, 200, &members)
	for _, member := range members.Items {
		if member["id"] == f.carol.UserID {
			t.Fatal("message author opened restricted directory")
		}
	}
	f.request(t, "POST", "/api/v2/media/"+photo.ID+"/grants", f.bob.Token, map[string]any{}, 201, nil)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", prefix+"/messages/"+sent.Message.ID, f.bob.Token, nil, 200, &got)
	check(got)
	f.request(t, "GET", prefix+"/messages/"+sent.Message.ID, f.carol.Token, nil, 403, nil)
}
