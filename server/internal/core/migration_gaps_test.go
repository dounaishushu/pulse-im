package core

import (
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"
)

func TestNewMessageReopensHiddenConversationWithoutUndoingHistoryClear(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "hidden-first", Body: "old"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, first.Message.Seq); err != nil {
		t.Fatal(err)
	}
	hidden := true
	if _, err = f.service.SetPreferences(f.ctx, f.bob.Identity, f.cid, PreferencePatch{Hidden: &hidden, Expected: 1}); err != nil {
		t.Fatal(err)
	}
	next := SendInput{RequestID: "hidden-next", Body: "new"}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, next); err != nil {
		t.Fatal(err)
	}
	items, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", "")
	if err != nil || len(items) != 1 || items[0].Hidden || items[0].LastMessage == nil || items[0].LastMessage.Body != "new" || items[0].State.ClearSeq != first.Message.Seq || items[0].ConversationPreferences.Version != 3 {
		t.Fatalf("new message did not restore only the hidden preference: %+v %v", items, err)
	}
	// A replay must not reopen a conversation hidden after the original send.
	if _, err = f.service.SetPreferences(f.ctx, f.bob.Identity, f.cid, PreferencePatch{Hidden: &hidden, Expected: 3}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, next); err != nil {
		t.Fatal(err)
	}
	items, err = f.service.ClientConversations(f.ctx, f.bob.Identity, "", "")
	if err != nil || len(items) != 0 {
		t.Fatalf("idempotent replay reopened hidden conversation: %+v %v", items, err)
	}
}

func TestTimedGroupMuteContractAndPermissions(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "timed mute", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/groups/" + group.ID + "/members/" + f.bob.UserID + "/muted"
	f.request(t, "PUT", path, f.alice.Token, map[string]any{"minutes": 10}, 204, nil)
	var permanent bool
	var until *time.Time
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT muted,muted_until FROM pulse.members WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID).Scan(&permanent, &until); err != nil || permanent || until == nil || time.Until(*until) < 9*time.Minute || time.Until(*until) > 11*time.Minute {
		t.Fatalf("wrong timed restriction: %v %v %v", permanent, until, err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "timed-blocked", Body: "no"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("timed member could send: %v", err)
	}
	f.request(t, "PUT", path, f.carol.Token, map[string]any{"minutes": 0}, 403, nil)
	for _, payload := range []map[string]any{{}, {"minutes": -2}, {"minutes": 43201}, {"minutes": 1.5}, {"minutes": 10, "muted": true}} {
		f.request(t, "PUT", path, f.alice.Token, payload, 400, nil)
	}
	f.exec(t, "UPDATE pulse.members SET muted_until=now()-interval '1 minute' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "timed-expired", Body: "yes"}); err != nil {
		t.Fatalf("expired timer still blocks sending: %v", err)
	}
	// Retain the boolean contract for previously built clients.
	f.request(t, "PUT", path, f.alice.Token, map[string]any{"muted": true}, 204, nil)
	f.request(t, "PUT", path, f.alice.Token, map[string]any{"minutes": 43200}, 204, nil)
	f.request(t, "PUT", path, f.alice.Token, map[string]any{"minutes": -1}, 204, nil)
	f.request(t, "PUT", path, f.alice.Token, map[string]any{"minutes": 0}, 204, nil)
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT muted,muted_until FROM pulse.members WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID).Scan(&permanent, &until); err != nil || permanent || until != nil {
		t.Fatalf("unmute left a restriction: %v %v %v", permanent, until, err)
	}
}

func TestSessionLimitStillAllowsReplacingTheSameDevice(t *testing.T) {
	f := newFixture(t)
	for i := 0; i < 7; i++ {
		if _, err := f.service.Login(f.ctx, "alice01", testPassword, fmt.Sprintf("limit-device-%d", i), "session-limit"); err != nil {
			t.Fatal(err)
		}
	}
	_, err := f.service.Login(f.ctx, "alice01", testPassword, "limit-device-new", "session-limit")
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "device_session_limit" || fault.Status != 409 {
		t.Fatalf("wrong session-limit response: %v", err)
	}
	if _, err = f.service.Login(f.ctx, "alice01", testPassword, f.alice.DeviceID, "session-limit"); err != nil {
		t.Fatalf("same-device replacement was blocked at the limit: %v", err)
	}
}

func TestConversationMentionSummaryHonorsSparseReadAndVisibility(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "mention summary", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET nickname='Bob' WHERE id=$1", f.bob.UserID)
	send := func(key, body string, all bool) Message {
		t.Helper()
		in := SendInput{RequestID: key, Body: body, MentionAll: all}
		if !all {
			in.Mentions = []string{f.bob.UserID}
		}
		out, e := f.service.Send(f.ctx, f.alice.Identity, group.ID, in)
		if e != nil {
			t.Fatal(e)
		}
		return out.Message
	}
	first := send("mention-summary-one", "@Bob one", false)
	second := send("mention-summary-all", "@所有人 two", true)
	muted := true
	if _, err = f.service.SetPreferences(f.ctx, f.bob.Identity, group.ID, PreferencePatch{Muted: &muted, Expected: 1}); err != nil {
		t.Fatal(err)
	}
	check := func(who Identity, count int, last int64) {
		t.Helper()
		rows, e := f.service.ClientConversations(f.ctx, who, "", group.ID)
		if e != nil || len(rows) != 1 || rows[0].UnreadMentions != count || rows[0].LastMentionSeq != last {
			t.Fatalf("wrong mention summary: %+v %v", rows, e)
		}
	}
	check(f.alice.Identity, 0, 0)
	check(f.bob.Identity, 2, second.Seq)
	check(f.carol.Identity, 1, second.Seq)
	if _, err = f.service.ReceiptOne(f.ctx, f.bob.Identity, group.ID, first.ID, "delivered"); err != nil {
		t.Fatal(err)
	}
	check(f.bob.Identity, 2, second.Seq)
	if _, err = f.service.ReceiptOne(f.ctx, f.bob.Identity, group.ID, first.ID, "read"); err != nil {
		t.Fatal(err)
	}
	check(f.bob.Identity, 1, second.Seq)
	if _, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, group.ID, []string{second.ID}); err != nil {
		t.Fatal(err)
	}
	check(f.bob.Identity, 0, 0)
	if _, err = f.service.ClearHistory(f.ctx, f.carol.Identity, group.ID, second.Seq); err != nil {
		t.Fatal(err)
	}
	check(f.carol.Identity, 0, 0)
	third := send("mention-summary-edit", "@Bob three", false)
	check(f.bob.Identity, 1, third.Seq)
	if _, err = f.service.MutateMessage(f.ctx, f.alice.Identity, group.ID, third.ID, "mention removed", third.Version, false); err != nil {
		t.Fatal(err)
	}
	check(f.bob.Identity, 0, 0)
}

func TestAdminUserByIDIsAuthorizedAndNeverReturnsPasswordHash(t *testing.T) {
	f := newFixture(t)
	admin := newAdmin(t, f)
	var user map[string]any
	path := "/api/v2/admin/users/" + f.alice.UserID
	admin.request(t, "GET", path, nil, 200, &user)
	if user["id"] != f.alice.UserID || user["profile_version"] != "1" || user["password_hash"] != nil {
		t.Fatalf("invalid public admin projection: %v", user)
	}
	f.request(t, "GET", path, f.alice.Token, nil, 401, nil)
	admin.request(t, "GET", "/api/v2/admin/users/"+newID(), nil, 404, nil)
	f.exec(t, "UPDATE pulse.admin_accounts SET role='auditor',permissions=ARRAY['groups.view'] WHERE id=$1", admin.who.ID)
	admin.request(t, "GET", path, nil, 403, nil)
}

func TestGlobalMessageSearchUsesTimeAndAuthorizedCursor(t *testing.T) {
	f := newFixture(t)
	messages := []Message{f.send(t, "search-time-1", "time ordering"), f.send(t, "search-time-2", "time ordering"), f.send(t, "search-time-3", "time ordering")}
	sort.Slice(messages, func(i, j int) bool { return messages[i].ID < messages[j].ID })
	// Make UUID order oppose chronological order.
	for i, m := range messages {
		f.exec(t, "UPDATE pulse.messages SET created_at=$2::timestamptz WHERE id=$1", m.ID, time.Date(2026, 11, 13, 12, 2-i, 0, 0, time.UTC))
	}
	var page struct {
		Items []Message `json:"items"`
		Next  string    `json:"next_before"`
	}
	path := "/api/v2/messages/search?conversation_id=" + f.cid + "&q=time&limit=1"
	for i, m := range messages {
		url := path
		if i > 0 {
			url += "&before_id=" + page.Next
		}
		f.request(t, "GET", url, f.bob.Token, nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != m.ID {
			t.Fatalf("search lost chronological order at page %d: %+v", i, page)
		}
	}
	// Equal timestamps must still produce disjoint pages using the UUID tie-breaker.
	for _, m := range messages {
		f.exec(t, "UPDATE pulse.messages SET created_at='2026-11-13T12:00:00Z' WHERE id=$1", m.ID)
	}
	page.Next = ""
	for i := len(messages) - 1; i >= 0; i-- {
		url := path
		if page.Next != "" {
			url += "&before_id=" + page.Next
		}
		f.request(t, "GET", url, f.bob.Token, nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != messages[i].ID {
			t.Fatalf("timestamp tie lost a search result: %+v", page)
		}
	}
	f.request(t, "GET", path+"&before_id="+newID(), f.bob.Token, nil, 400, nil)
	f.request(t, "GET", "/api/v2/messages/search?q=time&before_id="+messages[0].ID, f.carol.Token, nil, 400, nil)
}
