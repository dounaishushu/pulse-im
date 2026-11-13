package core

import (
	"encoding/json"
	"testing"
)

func TestReplyContextRespectsCurrentDeletionClearAndMembership(t *testing.T) {
	f := newFixture(t)
	parent, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "parent", Body: "private quote"})
	if err != nil {
		t.Fatal(err)
	}
	child, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "child", Body: "reply", ReplyToID: parent.Message.ID})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/conversations/" + f.cid + "/reply-contexts"
	input := map[string]any{"message_ids": []string{child.Message.ID}}
	var result struct {
		Items []struct {
			Seq     string   `json:"reply_seq"`
			Message *Message `json:"message"`
		} `json:"items"`
	}
	f.request(t, "POST", path, f.bob.Token, input, 200, &result)
	if len(result.Items) != 1 || result.Items[0].Message == nil || result.Items[0].Message.Body != "private quote" {
		t.Fatal("visible parent missing")
	}
	f.request(t, "POST", path, f.carol.Token, input, 403, nil)
	if _, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{parent.Message.ID}); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", path, f.bob.Token, input, 200, &result)
	if result.Items[0].Seq != "1" || result.Items[0].Message != nil {
		t.Fatal("deleted quote content exposed")
	}
	if _, err = f.service.ClearHistory(f.ctx, f.alice.Identity, f.cid, parent.Message.Seq); err != nil {
		t.Fatal(err)
	}
	f.request(t, "POST", path, f.alice.Token, input, 200, &result)
	if result.Items[0].Message != nil {
		t.Fatal("cleared quote content exposed")
	}
}

func TestMutualFriendRequestReturnsAcceptedConversation(t *testing.T) {
	f := newFixture(t)
	var first, second map[string]string
	f.request(t, "POST", "/api/v2/friend-requests", f.alice.Token, map[string]string{"target_id": f.carol.UserID}, 201, &first)
	f.request(t, "POST", "/api/v2/friend-requests", f.carol.Token, map[string]string{"target_id": f.alice.UserID}, 201, &second)
	if first["status"] != "pending" || second["status"] != "accepted" || !validID(second["conversation_id"]) || first["id"] != second["id"] {
		t.Fatalf("bad request receipts: %v %v", first, second)
	}
}

func TestCommonGroupsPageBeyondFiftyAndAdminMessageMetadata(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 51; i++ {
		if _, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "group", []string{f.bob.UserID}); err != nil {
			t.Fatal(err)
		}
	}
	var groups struct {
		Total int               `json:"total"`
		Items []json.RawMessage `json:"items"`
	}
	f.request(t, "GET", "/api/v2/profiles/"+f.bob.UserID+"/common-groups?page=2&size=50", f.alice.Token, nil, 200, &groups)
	if groups.Total != 51 || len(groups.Items) != 1 {
		t.Fatal("common groups truncated", groups.Total, len(groups.Items))
	}
	admin := newAdmin(t, f)
	if _, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "metadata", Body: "test"}); err != nil {
		t.Fatal(err)
	}
	var messages struct {
		Items []struct {
			Kind       string            `json:"conversation_type"`
			Sender     string            `json:"sender_account"`
			Recipients []json.RawMessage `json:"recipients"`
		} `json:"items"`
	}
	admin.request(t, "GET", "/api/v2/admin/messages?conversation_type=direct", nil, 200, &messages)
	if len(messages.Items) != 1 || messages.Items[0].Kind != "direct" || messages.Items[0].Sender != "alice01" || len(messages.Items[0].Recipients) != 1 {
		t.Fatal("admin metadata missing", messages)
	}
	admin.request(t, "GET", "/api/v2/admin/task-records?user_id="+f.alice.UserID, nil, 200, nil)
}

func TestLegacyQRLookupAndOldRouteSettingsUseGoWithoutChangingArchives(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',12,$1)", f.carol.UserID)
	var profile Profile
	f.request(t, "GET", "/api/v2/public-users/legacy/12", f.alice.Token, nil, 200, &profile)
	if profile.ID != f.carol.UserID {
		t.Fatal("legacy QR resolved to wrong account")
	}
	f.request(t, "PUT", "/api/v2/blocks/"+f.carol.UserID, f.alice.Token, nil, 204, nil)
	f.request(t, "GET", "/api/v2/public-users/legacy/12", f.alice.Token, nil, 404, nil)
	old := `[{"id":"route-12","name":"主线路","api_url":"https://chat.example.org/api","ws_url":"wss://chat.example.org/ws","media_url":"https://chat.example.org/storage","enabled":true}]`
	f.exec(t, "UPDATE pulse.system_settings SET value=$1 WHERE key='routes'", old)
	var config struct {
		Routes []ClientRoute `json:"routes"`
	}
	f.request(t, "GET", "/api/v2/client/config", "", nil, 200, &config)
	if len(config.Routes) != 1 || config.Routes[0].API != "https://chat.example.org/api/v2" || config.Routes[0].WS != "wss://chat.example.org/api/v2/realtime" {
		t.Fatal(config.Routes)
	}
	var saved []byte
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT value FROM pulse.system_settings WHERE key='routes'").Scan(&saved); err != nil {
		t.Fatal(err)
	}
	var archived []ClientRoute
	if err := json.Unmarshal(saved, &archived); err != nil || archived[0].API != "https://chat.example.org/api" {
		t.Fatal("archived route was rewritten", err)
	}
}
