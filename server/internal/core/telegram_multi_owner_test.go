package core

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestTelegramMultipleAccountsKeepCreatorGrantAndReturnEveryEntry(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	var sent []string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			ChatID int64  `json:"chat_id"`
			Text   string `json:"text"`
		}
		if e := json.NewDecoder(r.Body).Decode(&payload); e != nil || payload.ChatID != 123 {
			t.Errorf("unexpected Telegram request: %v", e)
		}
		sent = append(sent, payload.Text)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer mock.Close()
	f.service.Telegram = &TelegramTransport{
		config: TelegramConfig{Token: "fixture", WebhookSecret: strings.Repeat("s", 32), AdminBaseURL: "https://example.invalid/admin"},
		client: mock.Client(), base: mock.URL,
	}
	root.request(t, "PUT", "/api/v2/admin/telegram/grants", map[string]any{
		"telegram_user_id": "123", "admin_id": root.who.ID,
		"permissions": []string{"accounts.create", "entry.self"}, "active": true,
	}, 204, nil)
	for index, account := range []string{"secondaryone", "secondarytwo"} {
		var update telegramUpdate
		raw, _ := json.Marshal(map[string]any{
			"update_id": 100 + index,
			"message": map[string]any{
				"text": "/create_admin " + account + " operator users.view",
				"from": map[string]any{"id": 123},
				"chat": map[string]any{"id": 123, "type": "private"},
			},
		})
		if e := json.Unmarshal(raw, &update); e != nil {
			t.Fatal(e)
		}
		if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
			t.Fatalf("create %s: %v", account, e)
		}
	}
	var primary string
	var linked int
	if e := f.store.Pool.QueryRow(f.ctx, "SELECT admin_id::text,cardinality(admin_ids) FROM pulse.telegram_grants WHERE telegram_user_id=123").Scan(&primary, &linked); e != nil {
		t.Fatal(e)
	}
	if primary != root.who.ID || linked != 3 {
		t.Fatalf("creator grant changed: primary=%s linked=%d", primary, linked)
	}
	sent = nil
	var update telegramUpdate
	_ = json.Unmarshal([]byte(`{"update_id":300,"message":{"text":"/entry","from":{"id":123},"chat":{"id":123,"type":"private"}}}`), &update)
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	body := strings.Join(sent, "\n")
	for _, account := range []string{"rootreview", "secondaryone", "secondarytwo"} {
		if !strings.Contains(body, "后台账号："+account) {
			t.Fatalf("entry for %s missing", account)
		}
	}
	var oldEntryStillValid bool
	if e := f.store.Pool.QueryRow(f.ctx, "SELECT entry_hash=$2 FROM pulse.admin_accounts WHERE id=$1", root.who.ID, digest(root.entry)).Scan(&oldEntryStillValid); e != nil {
		t.Fatal(e)
	}
	if oldEntryStillValid {
		t.Fatal("old entry was not rotated")
	}
}

func TestTelegramGroupPINAdmitsUnlistedMemberForOneOperation(t *testing.T) {
	f := newFixture(t)
	_ = newAdmin(t, f)
	var sent []string
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			ChatID int64  `json:"chat_id"`
			Text   string `json:"text"`
		}
		if e := json.NewDecoder(r.Body).Decode(&payload); e != nil || payload.ChatID != 456 {
			t.Errorf("credential message was not private: %v", e)
		}
		sent = append(sent, payload.Text)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer mock.Close()
	f.service.Telegram = &TelegramTransport{
		config: TelegramConfig{
			Token: "fixture", WebhookSecret: strings.Repeat("s", 32),
			AdminBaseURL: "https://example.invalid/admin",
			GroupPIN:     "group12345", GroupAccountsEnabled: true,
		},
		client: mock.Client(), base: mock.URL,
	}
	var update telegramUpdate
	_ = json.Unmarshal([]byte(`{"update_id":400,"message":{"text":"/codes","from":{"id":456},"chat":{"id":-100,"type":"group"}}}`), &update)
	if _, e := f.service.telegramCommand(f.ctx, update); e == nil {
		t.Fatal("unlisted group member used task codes without PIN")
	}
	update.Message.Text = "/pin group12345"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	update.Message.Text = "/codes"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	if _, e := f.service.telegramCommand(f.ctx, update); e == nil {
		t.Fatal("group PIN was reused")
	}
	update.Message.Text = "/pin group12345"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	update.Message.Text = "/create_admin groupmember operator users.view"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	update.Message.Text = "/entry"
	if _, e := f.service.telegramCommand(f.ctx, update); e == nil {
		t.Fatal("group entry did not require another PIN")
	}
	update.Message.Text = "/pin group12345"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	update.Message.Text = "/entry"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	body := strings.Join(sent, "\n")
	if !strings.Contains(body, "后台账号：groupmember") || strings.Contains(body, "后台账号：rootreview") {
		t.Fatal("group member received the wrong account entry")
	}
}
