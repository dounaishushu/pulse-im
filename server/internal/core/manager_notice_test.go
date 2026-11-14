package core

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestManagerOnlyInvitationNoticeVisibility(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "private invitation log", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.cid = group.ID
	public := f.send(t, "public-before-invite", "visible group message")
	notice := f.send(t, "imported-invitation-notice", "private invitation detail")
	f.exec(t, `UPDATE pulse.messages SET kind='system',content=jsonb_build_object('kind','group_invite','operator_id',$2::text,'member_id',$3::text),imported_legacy=true,manager_only=true WHERE id=$1`, notice.ID, f.alice.UserID, f.carol.UserID)
	prefix := "/api/v2/conversations/" + group.ID
	t.Run("history", func(t *testing.T) {
		var page struct {
			Items []Message `json:"items"`
		}
		f.request(t, "GET", prefix+"/history", f.bob.Token, nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != public.ID {
			t.Fatalf("private notice leaked in history: %+v", page.Items)
		}
	})
	t.Run("global-search", func(t *testing.T) {
		var page struct {
			Items []Message `json:"items"`
		}
		f.request(t, "GET", "/api/v2/messages/search?q=private", f.bob.Token, nil, 200, &page)
		if len(page.Items) != 0 {
			t.Fatal("private notice leaked in global search")
		}
		f.request(t, "GET", "/api/v2/messages/search?before_id="+notice.ID, f.bob.Token, nil, 400, nil)
	})
	t.Run("conversation-search", func(t *testing.T) {
		var page struct {
			Items []Message `json:"items"`
		}
		f.request(t, "GET", prefix+"/search?q=private", f.bob.Token, nil, 200, &page)
		if len(page.Items) != 0 {
			t.Fatal("private notice leaked in conversation search")
		}
	})
	t.Run("summary-and-count", func(t *testing.T) {
		items, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", group.ID)
		if err != nil || len(items) != 1 || items[0].LastMessage == nil || items[0].LastMessage.ID != public.ID || items[0].Unread != 1 {
			t.Fatalf("private notice leaked through summary/count: %+v %v", items, err)
		}
		unread, err := f.service.Unread(f.ctx, f.bob.Identity, group.ID, 999)
		if err != nil || unread.Count != 1 {
			t.Fatalf("private notice counted for member: %+v %v", unread, err)
		}
	})
	t.Run("sync", func(t *testing.T) {
		page, err := f.service.Sync(f.ctx, f.bob.Identity, group.ID, 0, nil, 100)
		if err != nil {
			t.Fatal(err)
		}
		for _, event := range page.Events {
			if event.Message.ID == notice.ID {
				t.Fatal("private notice leaked in event sync")
			}
		}
		if page.HasMore || page.NextAfterSeq != page.SnapshotMaxSeq {
			t.Fatal("filtered sync did not advance")
		}
	})
	t.Run("direct-and-receipt", func(t *testing.T) {
		f.request(t, "GET", prefix+"/messages/"+notice.ID, f.bob.Token, nil, 403, nil)
		f.request(t, "PUT", prefix+"/messages/"+notice.ID+"/receipt", f.bob.Token, map[string]string{"status": "read"}, 403, nil)
		f.request(t, "PUT", prefix+"/pins/"+notice.ID, f.bob.Token, nil, 403, nil)
		f.request(t, "POST", prefix+"/personal-deletions", f.bob.Token, map[string][]string{"message_ids": {notice.ID}}, 403, nil)
		// Internal staff still need the current group role for this notice.
		f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.bob.UserID)
		f.request(t, "DELETE", prefix+"/messages/"+notice.ID, f.bob.Token, nil, 403, nil)
	})
	t.Run("reply-context", func(t *testing.T) {
		reply := f.send(t, "reply-to-manager-log", "public reply")
		f.exec(t, "UPDATE pulse.messages SET reply_to=$2 WHERE id=$1", reply.ID, notice.ID)
		var page struct {
			Items []struct {
				Message json.RawMessage `json:"message"`
			} `json:"items"`
		}
		f.request(t, "POST", prefix+"/reply-contexts", f.bob.Token, map[string][]string{"message_ids": {reply.ID}}, 200, &page)
		if len(page.Items) != 1 || string(page.Items[0].Message) != "null" {
			t.Fatal("private parent leaked through reply")
		}
		f.request(t, "POST", prefix+"/messages", f.bob.Token, map[string]string{"request_id": "member-hidden-parent", "body": "reply", "reply_to_id": notice.ID}, 403, nil)
	})
	t.Run("role-changes-and-manager-access", func(t *testing.T) {
		f.request(t, "GET", prefix+"/messages/"+notice.ID, f.alice.Token, nil, 200, nil)
		f.request(t, "PUT", "/api/v2/groups/"+group.ID+"/members/"+f.bob.UserID+"/role", f.alice.Token, map[string]string{"role": "admin"}, 204, nil)
		f.request(t, "GET", prefix+"/messages/"+notice.ID, f.bob.Token, nil, 200, nil)
		var before struct {
			MembershipVersion string `json:"membership_version"`
			Snapshot          string `json:"snapshot_max_seq"`
		}
		f.request(t, "GET", prefix+"/history", f.bob.Token, nil, 200, &before)
		f.request(t, "PUT", "/api/v2/groups/"+group.ID+"/members/"+f.bob.UserID+"/role", f.alice.Token, map[string]string{"role": "member"}, 204, nil)
		f.request(t, "GET", prefix+"/messages/"+notice.ID, f.bob.Token, nil, 403, nil)
		f.request(t, "GET", prefix+"/history?membership_version="+before.MembershipVersion+"&snapshot_max_seq="+before.Snapshot, f.bob.Token, nil, 409, nil)
	})
	t.Run("ordinary-system-messages-stay-visible", func(t *testing.T) {
		ordinary := f.send(t, "ordinary-system", "a public system notification")
		f.exec(t, "UPDATE pulse.messages SET kind='system' WHERE id=$1", ordinary.ID)
		f.request(t, "GET", prefix+"/messages/"+ordinary.ID, f.bob.Token, nil, 200, nil)
	})
}

func TestInvitationNoticeCreationAndPrivatePush(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "invitation records", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetGroupRole(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, "admin"); err != nil {
		t.Fatal(err)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var pushed []string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { pushed = append(pushed, r.URL.Path); w.WriteHeader(200) }))
	defer mock.Close()
	f.service.Push = &PushTransport{config: PushConfig{APNsKeyID: "key", APNsTeam: "team", APNsTopic: "test.topic"}, ecKey: key, client: mock.Client(), apnsURL: mock.URL, apnsSandbox: mock.URL}
	f.request(t, "PUT", "/api/v2/me/push-device", f.bob.Token, map[string]string{"platform": "ios", "token": strings.Repeat("b", 64)}, 200, nil)
	f.request(t, "PUT", "/api/v2/me/push-device", f.carol.Token, map[string]string{"platform": "ios", "token": strings.Repeat("c", 64)}, 200, nil)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '5 minutes'")
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, false); err != nil {
		t.Fatal(err)
	}
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	var count int
	var noticeID string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*),min(id::text) FROM pulse.messages WHERE conversation_id=$1 AND manager_only", group.ID).Scan(&count, &noticeID); err != nil || count != 1 {
		t.Fatalf("invitation retry duplicated/lost management record: %d %v", count, err)
	}
	prefix := "/api/v2/conversations/" + group.ID
	f.request(t, "GET", prefix+"/messages/"+noticeID, f.bob.Token, nil, 200, nil)
	f.request(t, "GET", prefix+"/messages/"+noticeID, f.carol.Token, nil, 403, nil)
	if done, err := f.service.ProcessPushOnce(f.ctx); err != nil || !done {
		t.Fatalf("private push: %v %v", done, err)
	}
	if len(pushed) != 1 || pushed[0] != "/3/device/"+strings.Repeat("b", 64) {
		t.Fatalf("management record pushed to a regular member: %+v", pushed)
	}
	// Revocation never strips the stored audience boundary.
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.request(t, "DELETE", prefix+"/messages/"+noticeID, f.alice.Token, nil, 200, nil)
	page, err := f.service.Sync(f.ctx, f.carol.Identity, group.ID, 0, nil, 100)
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range page.Events {
		if event.Message.ID == noticeID {
			t.Fatal("revoked management record leaked in member sync")
		}
	}
}

func TestManagerNoticeMigrationPreservesArchivedPayloads(t *testing.T) {
	f := newFixture(t)
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	// Run the actual additive SQL against temporary miniature legacy tables.
	_, err = tx.Exec(f.ctx, `CREATE TEMP TABLE notice_messages(id int PRIMARY KEY,kind text NOT NULL,content jsonb NOT NULL);
	CREATE TEMP TABLE notice_archives(message_id int PRIMARY KEY,body_json jsonb NOT NULL);
	INSERT INTO notice_messages VALUES(1,'text','{}'),(2,'system','{"kind":"group_invite","text":"retained"}'),(3,'system','{}');
	INSERT INTO notice_archives VALUES(3,'{"kind":"group_invite","text":"archived revoked notice"}');`)
	if err != nil {
		t.Fatal(err)
	}
	script, err := migrations.ReadFile("migrations/060_manager_notice_visibility.sql")
	if err != nil {
		t.Fatal(err)
	}
	sql := strings.NewReplacer("pulse.messages", "pg_temp.notice_messages", "pulse.legacy_message_bodies", "pg_temp.notice_archives").Replace(string(script))
	if _, err = tx.Exec(f.ctx, sql); err != nil {
		t.Fatal(err)
	}
	var valid bool
	err = tx.QueryRow(f.ctx, `SELECT
	(SELECT array_agg(manager_only ORDER BY id) FROM notice_messages)=ARRAY[false,true,true]
	AND (SELECT content->>'text' FROM notice_messages WHERE id=2)='retained'
	AND (SELECT content FROM notice_messages WHERE id=3)='{}'::jsonb
	AND (SELECT body_json->>'text' FROM notice_archives WHERE message_id=3)='archived revoked notice'`).Scan(&valid)
	if err != nil || !valid {
		t.Fatalf("migration changed legacy content or omitted its audience: %v %v", valid, err)
	}
}
