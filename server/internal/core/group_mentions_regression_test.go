package core

import (
	"encoding/json"
	"errors"
	"net/url"
	"testing"
)

func TestOrdinaryGroupMentionsDoNotRequirePeerMessages(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "silent members", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	var friends, messages int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.bob.UserID, f.carol.UserID).Scan(&friends); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1 AND sender_id=$2", group.ID, f.carol.UserID).Scan(&messages); err != nil || friends != 0 || messages != 0 {
		t.Fatalf("expected a non-friend who never spoke: friends=%d messages=%d err=%v", friends, messages, err)
	}
	send := func(key string) Message {
		t.Helper()
		result, e := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: key, Body: "@carol01 请查看", Mentions: []string{f.carol.UserID}})
		if e != nil {
			t.Fatalf("ordinary member could not mention a current silent member: %v", e)
		}
		var content MessageContent
		if e = json.Unmarshal(result.Message.Content, &content); e != nil || len(content.Mentions) != 1 || content.Mentions[0] != f.carol.UserID {
			t.Fatalf("mention identity was not stored: %+v %v", content, e)
		}
		var references int
		if e = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_mentions WHERE message_id=$1 AND user_id=$2", result.Message.ID, f.carol.UserID).Scan(&references); e != nil || references != 1 {
			t.Fatalf("missing real mention notification reference: %d %v", references, e)
		}
		return result.Message
	}
	first := send("silent-mention-one")
	if _, err = f.clearHistoryAsStaff(t, f.ctx, f.bob.Identity, group.ID, first.Seq); err != nil {
		t.Fatal(err)
	}
	send("silent-mention-after-clear")
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "plain-after-mention", Body: "继续发送普通消息"}); err != nil {
		t.Fatalf("plain message after mention failed: %v", err)
	}
	// Mentioning never grants profile or friend-request access in a restricted group.
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID+"?conversation_id="+group.ID, f.bob.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/friend-requests", f.bob.Token, map[string]string{"target_id": f.carol.UserID, "context_conversation_id": group.ID}, 403, nil)
	for _, input := range []SendInput{
		{RequestID: "ordinary-all-denied", Body: "@所有人 hello", MentionAll: true},
		{RequestID: "missing-member-denied", Body: "@unknown hello", Mentions: []string{newID()}},
	} {
		if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, input); !errors.Is(err, ErrForbidden) {
			t.Fatalf("invalid mention was not forbidden: %v", err)
		}
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "name-mismatch-denied", Body: "not a mention", Mentions: []string{f.carol.UserID}}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mention without its visible label accepted: %v", err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "left-member-denied", Body: "@carol01 hello", Mentions: []string{f.carol.UserID}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("former member was mentionable: %v", err)
	}
	if err = f.service.SetGroupMuteMinutes(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, 30); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "muted-actor-denied", Body: "@alice01 hello", Mentions: []string{f.alice.UserID}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("muted actor could send a mention: %v", err)
	}
}

func TestMentionCandidatesPreserveRestrictedDirectoryAndPagination(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "mention search", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	var page struct {
		Items  []map[string]any `json:"items"`
		Next   string           `json:"next_after"`
		Search bool             `json:"can_search"`
		All    bool             `json:"can_mention_all"`
	}
	base := "/api/v2/groups/" + group.ID + "/search-members"
	f.request(t, "GET", base+"?q=carol", f.bob.Token, nil, 200, &page)
	if len(page.Items) != 0 {
		t.Fatal("ordinary directory exposed a restricted peer")
	}
	f.request(t, "GET", base+"?purpose=mention&q=carol", f.bob.Token, nil, 200, &page)
	if !page.Search || page.All || len(page.Items) != 1 || page.Items[0]["id"] != f.carol.UserID || page.Items[0]["nickname"] != "carol01" {
		t.Fatalf("silent member absent from mention-only search: %+v", page)
	}
	for _, field := range []string{"account", "public_id"} {
		if page.Items[0][field] != "" {
			t.Fatalf("ordinary mention search exposed %s", field)
		}
	}
	seen, after := map[string]bool{}, ""
	for n := 0; n < 3; n++ {
		f.request(t, "GET", base+"?purpose=mention&limit=1&after="+url.QueryEscape(after), f.bob.Token, nil, 200, &page)
		for _, item := range page.Items {
			id := item["id"].(string)
			if id == f.bob.UserID || seen[id] {
				t.Fatal("mention pagination repeated self or a peer")
			}
			seen[id] = true
		}
		if page.Next == "" {
			break
		}
		if page.Next == after {
			t.Fatal("mention cursor did not progress")
		}
		after = page.Next
	}
	if len(seen) != 2 {
		t.Fatalf("mention candidates truncated: %+v", seen)
	}
	f.request(t, "GET", base+"?purpose=mention&q=carol", f.alice.Token, nil, 200, &page)
	if !page.All || len(page.Items) != 1 || page.Items[0]["account"] != "carol01" {
		t.Fatalf("owner capabilities lost: %+v", page)
	}
	f.request(t, "GET", base+"?purpose=unknown", f.bob.Token, nil, 400, nil)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.carol.UserID)
	f.request(t, "GET", base+"?purpose=mention&q=carol", f.bob.Token, nil, 200, &page)
	if len(page.Items) != 0 {
		t.Fatal("inactive user remained a mention candidate")
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "inactive-mention", Body: "@carol01 hi", Mentions: []string{f.carol.UserID}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("inactive user mention accepted: %v", err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", base+"?purpose=mention", f.bob.Token, nil, 403, nil)
}

func TestMentionSearchDoesNotMatchRedactedIdentifiers(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "private mention search", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='Visible Person',legacy_public_id='AbCdEf89ABCDEFxy' WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'My Colleague')", f.bob.UserID, f.carol.UserID)
	base := "/api/v2/groups/" + group.ID + "/search-members?purpose=mention&q="
	var page struct {
		Items []map[string]any `json:"items"`
	}
	for _, blocked := range []bool{false, true} {
		f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=$2 WHERE id=$1", group.ID, blocked)
		for _, query := range []string{"carol", "89ABCDEF", "AbCdEf89ABCDEFxy"} {
			f.request(t, "GET", base+url.QueryEscape(query), f.bob.Token, nil, 200, &page)
			if len(page.Items) != 0 {
				t.Fatalf("redacted identifier %q remained searchable (blocked=%v): %+v", query, blocked, page)
			}
			f.request(t, "GET", base+url.QueryEscape(query), f.alice.Token, nil, 200, &page)
			if len(page.Items) != 1 || page.Items[0]["id"] != f.carol.UserID {
				t.Fatalf("owner lost identifier search %q: %+v", query, page)
			}
		}
		for _, query := range []string{"Visible", "Colleague"} {
			f.request(t, "GET", base+query, f.bob.Token, nil, 200, &page)
			if len(page.Items) != 1 || page.Items[0]["id"] != f.carol.UserID || page.Items[0]["account"] != "" || page.Items[0]["public_id"] != "" {
				t.Fatalf("visible label search %q failed or exposed identifiers: %+v", query, page)
			}
		}
	}
	// An empty nickname visibly falls back to the account, so that label remains searchable.
	f.exec(t, "UPDATE pulse.users SET nickname='' WHERE id=$1", f.carol.UserID)
	f.request(t, "GET", base+"carol", f.bob.Token, nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0]["nickname"] != "carol01" {
		t.Fatalf("visible fallback label stopped being searchable: %+v", page)
	}
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID+"?conversation_id="+group.ID, f.bob.Token, nil, 403, nil)
}
