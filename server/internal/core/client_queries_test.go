package core

import (
	"fmt"
	"testing"
)

func TestClientQueriesPreserveHistoryAndPrivacy(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "client-history-1", "first")
	second := f.send(t, "client-history-2", "second")
	third := f.send(t, "client-history-3", "third")
	var list struct {
		Items []ClientConversation `json:"items"`
	}
	f.request(t, "GET", "/api/v2/client/conversations", f.bob.Token, nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].PeerID != f.alice.UserID || list.Items[0].LastMessage == nil || list.Items[0].LastMessage.ID != third.ID || list.Items[0].Unread != 3 {
		t.Fatalf("client conversation projection: %+v", list)
	}
	var history HistoryPage
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/history?limit=1", f.bob.Token, nil, 200, &history)
	if len(history.Items) != 1 || history.Items[0].ID != third.ID || !history.HasMore {
		t.Fatal("latest page invalid", history)
	}
	f.request(t, "GET", fmt.Sprintf("/api/v2/conversations/%s/history?order=asc&floor_seq=2&limit=1", f.cid), f.bob.Token, nil, 200, &history)
	if len(history.Items) != 1 || history.Items[0].ID != second.ID || history.NextAfterSeq != 2 || !history.HasMore {
		t.Fatal("snapshot page invalid", history)
	}
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/history", f.carol.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/personal-deletions", f.bob.Token, map[string][]string{"message_ids": {first.ID, second.ID}}, 200, nil)
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/history?order=asc", f.bob.Token, nil, 200, &history)
	if len(history.Items) != 1 || history.Items[0].ID != third.ID {
		t.Fatal("deleted messages leaked", history)
	}
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID, f.carol.Token, nil, 403, nil)
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID, f.alice.Token, nil, 200, nil)
	f.request(t, "GET", "/api/v2/me/profile", f.carol.Token, nil, 200, nil)
}
func TestClientMembersAndJoinUseActualGroupScope(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "client group", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	f.exec(t, "UPDATE pulse.users SET nickname='群主昵称' WHERE id=$1", f.alice.UserID)
	var members struct {
		Items []ClientUser `json:"items"`
	}
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/member-profiles", f.bob.Token, nil, 200, &members)
	if len(members.Items) != 1 || members.Items[0].ID != f.alice.UserID || members.Items[0].Nickname != "群主昵称" {
		t.Fatal("restricted member projection leaked", members)
	}
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/member-profiles", f.carol.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/groups/join", f.carol.Token, map[string]string{"invite_code": group.InviteCode}, 200, nil)
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID+"?conversation_id="+group.ID, f.carol.Token, nil, 403, nil)
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/history?membership_version=9", f.carol.Token, nil, 409, nil)
}
func TestClientDirectoryPagesBoundedAndAuthorized(t *testing.T) {
	f := newFixture(t)
	direct, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.CreateGroup(f.ctx, f.alice.Identity, "paged", nil); err != nil {
		t.Fatal(err)
	}
	var page struct {
		Items   []ClientConversation `json:"items"`
		Total   int                  `json:"total"`
		HasMore bool                 `json:"has_more"`
	}
	f.request(t, "GET", "/api/v2/client/conversation-page?page=1&size=1", f.alice.Token, nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0].Kind != "group" {
		t.Fatal("chat page did not return most recently updated conversation first", page)
	}
	if len(page.Items) != 1 || page.Total != 3 || !page.HasMore {
		t.Fatal("directory page not bounded", page)
	}
	f.request(t, "GET", "/api/v2/client/conversation-page?page=4&size=1", f.alice.Token, nil, 200, &page)
	if len(page.Items) != 0 || page.Total != 3 || page.HasMore {
		t.Fatal("directory tail incorrect", page)
	}
	f.request(t, "GET", "/api/v2/client/conversation-page?kind=group&size=100", f.alice.Token, nil, 200, &page)
	if len(page.Items) != 1 || page.Total != 1 || page.Items[0].Kind != "group" {
		t.Fatal("kind filter incorrect", page)
	}
	if err = f.service.Block(f.ctx, f.carol.Identity, f.alice.UserID, true); err != nil {
		t.Fatal(err)
	}
	var info ClientConversation
	f.request(t, "GET", "/api/v2/conversations/"+direct, f.alice.Token, nil, 200, &info)
	if info.CanSend {
		t.Fatal("directory projection ignored block")
	}
	f.request(t, "GET", "/api/v2/client/conversation-page?page=0", f.alice.Token, nil, 400, nil)
	var friends struct {
		Items []ClientUser `json:"items"`
		Total int          `json:"total"`
	}
	f.request(t, "GET", "/api/v2/client/friend-page", f.alice.Token, nil, 200, &friends)
	if len(friends.Items) != 1 || friends.Total != 1 || friends.Items[0].ID != f.bob.UserID {
		t.Fatal("friend page incorrect", friends)
	}
	f.request(t, "GET", "/api/v2/client/friend-page", f.carol.Token, nil, 200, &friends)
	if len(friends.Items) != 0 || friends.Total != 0 {
		t.Fatal("foreign friends leaked", friends)
	}
	f.request(t, "GET", "/api/v2/client/friend-request-page?direction=incoming", f.alice.Token, nil, 200, nil)
	f.request(t, "GET", "/api/v2/client/friend-request-page?direction=invalid", f.alice.Token, nil, 400, nil)
}

func TestClientDirectoryPreservesViewerMetadataAndPeerAvatars(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	aliceAvatar := uploadTestImage(t, f, f.alice, imageBytes(t, 20, 20), false)
	bobAvatar := uploadTestImage(t, f, f.bob, imageBytes(t, 24, 24), false)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", f.alice.UserID, aliceAvatar.ID)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", f.bob.UserID, bobAvatar.ID)
	if err := f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "我的客户", "工作", 0); err != nil {
		t.Fatal(err)
	}
	if err := f.service.ContactMetadata(f.ctx, f.bob.Identity, f.alice.UserID, "另一份备注", "家人", 0); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/v2/client/friends", "/api/v2/client/friend-page"} {
		for _, viewer := range []struct {
			login               Login
			peer, remark, group string
		}{{f.alice, f.bob.UserID, "我的客户", "工作"}, {f.bob, f.alice.UserID, "另一份备注", "家人"}} {
			var page struct {
				Items []map[string]any `json:"items"`
			}
			f.request(t, "GET", path, viewer.login.Token, nil, 200, &page)
			if len(page.Items) != 1 || page.Items[0]["id"] != viewer.peer || page.Items[0]["remark"] != viewer.remark || page.Items[0]["group_name"] != viewer.group {
				t.Errorf("%s lost or mixed the viewer's metadata: %+v", path, page)
			}
		}
	}
	for _, viewer := range []struct {
		login  Login
		avatar string
	}{{f.alice, bobAvatar.ID}, {f.bob, aliceAvatar.ID}} {
		for _, path := range []string{"/api/v2/conversations/" + f.cid, "/api/v2/client/conversations", "/api/v2/client/conversation-page"} {
			var result map[string]any
			f.request(t, "GET", path, viewer.login.Token, nil, 200, &result)
			if items, ok := result["items"].([]any); ok {
				result = items[0].(map[string]any)
			}
			if result["avatar_id"] != viewer.avatar {
				t.Errorf("%s did not use the other participant's avatar: %+v", path, result)
			}
		}
	}
	var foreign struct {
		Items []map[string]any `json:"items"`
	}
	f.request(t, "GET", "/api/v2/client/friends", f.carol.Token, nil, 200, &foreign)
	if len(foreign.Items) != 0 {
		t.Fatal("foreign private contact metadata leaked")
	}
}
