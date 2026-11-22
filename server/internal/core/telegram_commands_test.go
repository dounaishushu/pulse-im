package core

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func telegramCommandFixture(t *testing.T, text, chatType string, bot bool) telegramUpdate {
	t.Helper()
	chatID := int64(-100)
	if chatType == "private" {
		chatID = 123
	}
	raw, err := json.Marshal(map[string]any{
		"update_id": 1,
		"message": map[string]any{
			"text": text,
			"from": map[string]any{"id": 123, "is_bot": bot},
			"chat": map[string]any{"id": chatID, "type": chatType},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var update telegramUpdate
	if err = json.Unmarshal(raw, &update); err != nil {
		t.Fatal(err)
	}
	return update
}

func TestTelegramGroupChatterDoesNotReply(t *testing.T) {
	service := &Service{}
	for _, chatType := range []string{"group", "supergroup"} {
		for _, text := range []string{
			"丢", "大家好", "命令：/pin 验证群授权，/codes 查询任务码", "@fixture_bot 你好", "/unknown", "", " \n\t",
		} {
			t.Run(chatType+"/"+text, func(t *testing.T) {
				replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, text, chatType, false))
				if err != nil || len(replies) != 0 {
					t.Fatalf("ordinary group message produced replies=%q err=%v", replies, err)
				}
			})
		}
	}
}

func TestTelegramBotMessagesDoNotReply(t *testing.T) {
	service := &Service{}
	for _, chatType := range []string{"private", "group", "supergroup"} {
		for _, text := range []string{"/help", "命令：/pin 验证群授权"} {
			t.Run(chatType+"/"+text, func(t *testing.T) {
				replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, text, chatType, true))
				if err != nil || len(replies) != 0 {
					t.Fatalf("bot message produced replies=%q err=%v", replies, err)
				}
			})
		}
	}
}

func TestTelegramExplicitHelpAndPrivateFallback(t *testing.T) {
	service := &Service{}
	for _, chatType := range []string{"private", "group", "supergroup"} {
		for _, text := range []string{"/start", "/help"} {
			t.Run(chatType+"/"+text, func(t *testing.T) {
				replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, text, chatType, false))
				if err != nil || len(replies) != 1 || !strings.Contains(replies[0], "/codes") {
					t.Fatalf("explicit help produced replies=%q err=%v", replies, err)
				}
			})
		}
	}
	replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, "菜单", "private", false))
	if err != nil || len(replies) != 1 || !strings.Contains(replies[0], "/codes") {
		t.Fatalf("private help fallback produced replies=%q err=%v", replies, err)
	}
}

func TestTelegramCommandsRespectBotAddress(t *testing.T) {
	var identityRequests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/botfixture/getMe" {
			t.Errorf("unexpected Telegram request %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		identityRequests.Add(1)
		_, _ = w.Write([]byte(`{"ok":true,"result":{"is_bot":true,"username":"fixture_bot"}}`))
	}))
	defer provider.Close()
	service := &Service{Telegram: &TelegramTransport{config: TelegramConfig{Token: "fixture"}, client: provider.Client(), base: provider.URL}}
	for _, chatType := range []string{"private", "group", "supergroup"} {
		for _, text := range []string{"/help@other_bot", "/codes@other_bot", "/pin@other_bot secret", "/create_admin@other_bot account operator users.view", "/entry@other_bot", "/help@", "/help@fixture_bot@other_bot"} {
			t.Run(chatType+"/"+text, func(t *testing.T) {
				replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, text, chatType, false))
				if err != nil || len(replies) != 0 {
					t.Fatalf("another bot's command produced replies=%q err=%v", replies, err)
				}
			})
		}
	}
	for _, text := range []string{"/help@fixture_bot", "/help@FIXTURE_BOT", "/start@fixture_bot"} {
		replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, text, "supergroup", false))
		if err != nil || len(replies) != 1 {
			t.Fatalf("own addressed command produced replies=%q err=%v", replies, err)
		}
	}
	if got := identityRequests.Load(); got != 1 {
		t.Fatalf("expected one cached getMe request, got %d", got)
	}
}

func TestTelegramAddressLookupFailureStaysSilent(t *testing.T) {
	var requests atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"ok":false}`))
	}))
	defer provider.Close()
	service := &Service{Telegram: &TelegramTransport{config: TelegramConfig{Token: "fixture"}, client: provider.Client(), base: provider.URL}}
	for range 3 {
		replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, "/help@fixture_bot", "group", false))
		if err != nil || len(replies) != 0 {
			t.Fatalf("failed identity lookup produced replies=%q err=%v", replies, err)
		}
	}
	if got := requests.Load(); got != 1 {
		t.Fatalf("failed getMe lookups were not throttled: %d", got)
	}
	replies, err := service.telegramCommand(context.Background(), telegramCommandFixture(t, "/help", "group", false))
	if err != nil || len(replies) != 1 {
		t.Fatalf("unqualified command was blocked by identity lookup failure: %q %v", replies, err)
	}
}

func TestTelegramWebhookIgnoresChatterBeforeDatabaseAndRateLimit(t *testing.T) {
	secret := strings.Repeat("s", 32)
	// No database or Redis is installed in this service: ignored traffic must
	// receive a successful acknowledgement without touching either dependency.
	a := &API{Service: &Service{Telegram: &TelegramTransport{config: TelegramConfig{Token: "fixture", WebhookSecret: secret}}}, slots: make(chan struct{}, 1)}
	mux := http.NewServeMux()
	a.registerTelegram(mux)
	for _, input := range []struct {
		name string
		text string
		bot  bool
	}{
		{"ordinary text", "丢", false},
		{"quoted help", "命令：/pin 验证群授权", false},
		{"another command", "/unrelated@another_bot", false},
		{"another bot", "/help", true},
		{"another bot business command", "/codes", true},
		{"empty text", "", false},
	} {
		t.Run(input.name, func(t *testing.T) {
			update := telegramCommandFixture(t, input.text, "supergroup", input.bot)
			body, _ := json.Marshal(update)
			request := httptest.NewRequest(http.MethodPost, "/api/v2/integrations/telegram/webhook", bytes.NewReader(body))
			request.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
				t.Fatalf("ignored webhook status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v2/integrations/telegram/webhook", strings.NewReader(`{"update_id":2}`))
	request.Header.Set("X-Telegram-Bot-Api-Secret-Token", "wrong")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("ignored traffic bypassed webhook secret: %d", response.Code)
	}
}

func TestTelegramGroupBusinessCommandsRemainCandidates(t *testing.T) {
	for _, chatType := range []string{"group", "supergroup"} {
		for _, text := range []string{"/pin secret", "/codes", "/create_admin account operator users.view", "/entry", "/codes@fixture_bot"} {
			t.Run(chatType+"/"+text, func(t *testing.T) {
				if !telegramCommandCandidate(telegramCommandFixture(t, text, chatType, false)) {
					t.Fatal("business command was dropped before its existing authorization checks")
				}
			})
		}
	}
}
