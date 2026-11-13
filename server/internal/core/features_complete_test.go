package core

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/xuri/excelize/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSavedFoldersChannelsAndPrivacyProfiles(t *testing.T) {
	f := newFixture(t)
	saved, e := f.service.Saved(f.ctx, f.alice.Identity)
	if e != nil {
		t.Fatal(e)
	}
	again, e := f.service.Saved(f.ctx, f.alice.Identity)
	if e != nil || again != saved {
		t.Fatal("saved duplicated")
	}
	if _, e = f.service.Send(f.ctx, f.alice.Identity, saved, SendInput{RequestID: "saved", Body: "private note"}); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/conversations/"+saved+"/history", f.bob.Token, nil, 403, nil)
	archive := true
	if _, e = f.service.SetPreferences(f.ctx, f.alice.Identity, saved, PreferencePatch{Archived: &archive, Expected: 1}); !errors.Is(e, ErrForbidden) {
		t.Fatal("saved archived")
	}
	folder, e := f.service.SaveFolder(f.ctx, f.alice.Identity, "", FolderInput{Name: "同事", Scope: "direct"})
	if e != nil {
		t.Fatal(e)
	}
	hidden := true
	v, e := f.service.SetPreferences(f.ctx, f.alice.Identity, f.cid, PreferencePatch{Hidden: &hidden, FolderID: &folder.ID, Expected: 1})
	if e != nil || !v.Hidden {
		t.Fatal(e)
	}
	items, e := f.service.ClientConversations(f.ctx, f.alice.Identity, "", "")
	if e != nil {
		t.Fatal(e)
	}
	for _, item := range items {
		if item.ID == f.cid {
			t.Fatal("hidden conversation listed")
		}
	}
	if _, e = f.service.Direct(f.ctx, f.alice.Identity, f.bob.UserID); e != nil {
		t.Fatal(e)
	}
	var channel GroupCreated
	f.request(t, "POST", "/api/v2/channels", f.alice.Token, map[string]string{"title": "公告频道"}, 201, &channel)
	if e = f.service.InviteGroupMember(f.ctx, f.alice.Identity, channel.ID, f.bob.UserID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.service.Send(f.ctx, f.bob.Identity, channel.ID, SendInput{RequestID: "channel-denied", Body: "hi"}); !errors.Is(e, ErrForbidden) {
		t.Fatal("follower published")
	}
	if _, e = f.service.Send(f.ctx, f.alice.Identity, channel.ID, SendInput{RequestID: "channel-owner", Body: "公告"}); e != nil {
		t.Fatal(e)
	}
	var p Profile
	f.request(t, "GET", "/api/v2/profiles/"+f.bob.UserID, f.alice.Token, nil, 200, &p)
	if p.Phone != nil {
		t.Fatal("phone visibility default violated")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true,phone='+15550001111' WHERE id=$1", f.bob.UserID)
	privacy, e := f.service.ContactPrivacy(f.ctx, f.bob.Identity)
	if e != nil {
		t.Fatal(e)
	}
	rule := PrivacyRule{Visibility: "contacts"}
	if _, e = f.service.UpdateContactPrivacy(f.ctx, f.bob.Identity, PrivacyPatch{Phone: &rule, ExpectedVersion: &privacy.Version}); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/profiles/"+f.bob.UserID, f.alice.Token, nil, 200, &p)
	if p.Phone == nil || *p.Phone != "+15550001111" {
		t.Fatal("phone privacy not applied")
	}
}
func TestMentionReplyPinsSearchAndContactCards(t *testing.T) {
	f := newFixture(t)
	group, e := f.service.CreateGroup(f.ctx, f.alice.Identity, "group", []string{f.bob.UserID})
	if e != nil {
		t.Fatal(e)
	}
	source, e := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "source", Body: "历史关键词"})
	if e != nil {
		t.Fatal(e)
	}
	reply, e := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "reply", Body: "回复 @alice01", ReplyToID: source.Message.ID, Mentions: []string{f.alice.UserID}})
	if e != nil || reply.Message.ReplyToID != source.Message.ID {
		t.Fatal(e)
	}
	if _, e = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "all-denied", Body: "all", MentionAll: true}); !errors.Is(e, ErrForbidden) {
		t.Fatal("ordinary member mentioned all")
	}
	if e = f.service.PinMessage(f.ctx, f.bob.Identity, group.ID, source.Message.ID, true); !errors.Is(e, ErrForbidden) {
		t.Fatal("ordinary member pinned")
	}
	if e = f.service.PinMessage(f.ctx, f.alice.Identity, group.ID, source.Message.ID, true); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/pins", f.bob.Token, nil, 200, nil)
	found, e := f.service.SearchMessages(f.ctx, f.bob.Identity, SearchInput{ConversationID: group.ID, Query: "关键词", Limit: 10})
	if e != nil || len(found) != 1 {
		t.Fatalf("search %v %v", len(found), e)
	}
	if _, e = f.service.ClearHistory(f.ctx, f.bob.Identity, group.ID, source.Message.Seq); e != nil {
		t.Fatal(e)
	}
	found, e = f.service.SearchMessages(f.ctx, f.bob.Identity, SearchInput{ConversationID: group.ID, Query: "关键词", Limit: 10})
	if e != nil || len(found) != 0 {
		t.Fatal("search resurrected clear")
	}
	card, e := f.service.Send(f.ctx, f.alice.Identity, group.ID, SendInput{RequestID: "card", Kind: "contact", CardUserID: f.alice.UserID})
	if e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/messages/"+card.Message.ID+"/contact", f.bob.Token, nil, 200, nil)
	blocked := true
	if _, e = f.service.UpdateGroupSettings(f.ctx, f.alice.Identity, group.ID, GroupSettings{BlockMemberFriendRequests: &blocked}); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/messages/"+card.Message.ID+"/contact", f.bob.Token, nil, 403, nil)
}
func TestQuestionImportExportEmbeddedAndManualReview(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	enableTestMedia(t, f)
	if _, e := f.service.storeQuestionPicture(f.ctx, root.who, "direct.png", imageBytes(t, 40, 30)); e != nil {
		t.Fatalf("embedded storage: %v", e)
	}
	book := excelize.NewFile()
	sheet := book.GetSheetName(0)
	_ = book.SetSheetRow(sheet, "A1", &[]any{"question_uuid", "image_url", "correct_answer"})
	code := newID()
	_ = book.SetSheetRow(sheet, "A2", &[]any{code, "https://example.invalid/a.png", "1"})
	_ = book.SetSheetRow(sheet, "A3", &[]any{newID(), "", "0"})
	if e := book.AddPictureFromBytes(sheet, "B3", &excelize.Picture{Extension: ".png", File: imageBytes(t, 40, 30)}); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(t.TempDir(), "questions.xlsx")
	if e := book.SaveAs(path); e != nil {
		t.Fatal(e)
	}
	book.Close()
	result, e := f.service.ImportQuestions(f.ctx, root.who, path, ".xlsx")
	if e != nil {
		t.Fatal(e)
	}
	if result["created"] != 2 || len(result["errors"].([]any)) != 0 {
		t.Fatalf("import %+v", result)
	}
	result, e = f.service.ImportQuestions(f.ctx, root.who, path, ".xlsx")
	if e != nil || result["updated"] != 2 {
		t.Fatalf("upsert %+v %v", result, e)
	}
	root.request(t, "GET", "/api/v2/admin/exports/questions?format=xlsx", nil, 200, nil)
	root.request(t, "GET", "/api/v2/admin/questions/template", nil, 200, nil)
	task, e := f.service.SaveWorkTask(f.ctx, root.who, "", WorkTaskInput{Key: "review", Name: "审题", OpenTime: "00:00", Estimated: 10, Questions: 2, Intern: "1.001", Formal: "2.001", Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	daily, e := f.service.TaskCode(f.ctx, root.who, task, workDate(), false)
	if e != nil {
		t.Fatal(e)
	}
	record, e := f.service.StartTask(f.ctx, f.alice.Identity, task, daily)
	if e != nil {
		t.Fatal(e)
	}
	f.exec(t, "UPDATE pulse.work_records SET status='pending_review' WHERE id=$1", record.ID)
	in := ReviewInput{RequestID: "review1", Results: map[string]bool{record.Questions[0].ID: true, record.Questions[1].ID: false}, Note: "legacy review"}
	if e = f.service.ReviewWork(f.ctx, root.who, record.ID, in); e != nil {
		t.Fatal(e)
	}
	if e = f.service.ReviewWork(f.ctx, root.who, record.ID, in); e != nil {
		t.Fatal(e)
	}
	in.Note = "changed"
	if e = f.service.ReviewWork(f.ctx, root.who, record.ID, in); !errors.Is(e, ErrConflict) {
		t.Fatal("review overwrite")
	}
}
func TestPushProviderProtocolAndNotificationPrivacy(t *testing.T) {
	f := newFixture(t)
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	requests := 0
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("apns-topic") != "test.topic" || r.Header.Get("apns-push-type") != "alert" {
			t.Error("APNs headers")
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "bearer ")
		parts := strings.Split(token, ".")
		if len(parts) != 3 {
			t.Error("APNs JWT")
		}
		var data map[string]any
		if e := json.NewDecoder(r.Body).Decode(&data); e != nil {
			t.Error(e)
		}
		raw, _ := json.Marshal(data)
		if bytes.Contains(raw, []byte("secret text")) {
			t.Error("preview preference leaked content")
		}
		w.WriteHeader(200)
	}))
	defer mock.Close()
	f.service.Push = &PushTransport{config: PushConfig{APNsKeyID: "key", APNsTeam: "team", APNsTopic: "test.topic"}, ecKey: key, client: mock.Client(), apnsURL: mock.URL, apnsSandbox: mock.URL}
	f.request(t, "PUT", "/api/v2/me/push-device", f.bob.Token, map[string]string{"platform": "ios", "token": strings.Repeat("a", 64)}, 200, nil)
	f.exec(t, "INSERT INTO pulse.notification_preferences(user_id,preview) VALUES($1,false)", f.bob.UserID)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '5 minutes' WHERE id=$1", f.bob.UserID)
	if _, e = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "push", Body: "secret text"}); e != nil {
		t.Fatal(e)
	}
	if done, e := f.service.ProcessPushOnce(f.ctx); !done || e != nil {
		t.Fatalf("push worker %v %v", done, e)
	}
	if requests != 1 {
		t.Fatalf("push count %d", requests)
	}
	if _, e = f.service.ProcessPushOnce(f.ctx); e != nil {
		t.Fatal(e)
	}
	if requests != 1 {
		t.Fatal("duplicate push")
	}
	f.exec(t, "UPDATE pulse.user_states SET muted_notifications=true WHERE user_id=$1", f.bob.UserID)
	if _, e = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "muted-push", Body: "second"}); e != nil {
		t.Fatal(e)
	}
	if _, e = f.service.ProcessPushOnce(f.ctx); e != nil {
		t.Fatal(e)
	}
	if requests != 1 {
		t.Fatal("muted conversation pushed")
	}
}
func TestTelegramSecretGrantPINAndReplay(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	calls := 0
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer mock.Close()
	f.service.Telegram = &TelegramTransport{config: TelegramConfig{Token: "test-token", WebhookSecret: strings.Repeat("s", 32), AdminBaseURL: "https://example.invalid/admin"}, client: mock.Client(), base: mock.URL}
	root.request(t, "PUT", "/api/v2/admin/telegram/grants", map[string]any{"telegram_user_id": "123", "admin_id": root.who.ID, "permissions": []string{"tasks.codes", "entry.self"}, "active": true}, 204, nil)
	data := []byte(`{"update_id":1001,"message":{"text":"/codes","from":{"id":123},"chat":{"id":123,"type":"private"}}}`)
	for _, secret := range []string{"bad", strings.Repeat("s", 32), strings.Repeat("s", 32)} {
		req, _ := http.NewRequest("POST", f.http.URL+"/api/v2/integrations/telegram/webhook", bytes.NewReader(data))
		req.Header.Set("X-Telegram-Bot-Api-Secret-Token", secret)
		resp, e := f.http.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		resp.Body.Close()
		want := 200
		if secret == "bad" {
			want = 403
		}
		if resp.StatusCode != want {
			t.Fatalf("webhook status %d", resp.StatusCode)
		}
	}
	if done, e := f.service.ProcessTelegramOnce(f.ctx); !done || e != nil {
		t.Fatal(e)
	}
	if done, e := f.service.ProcessTelegramOnce(f.ctx); done || e != nil {
		t.Fatal("replayed update")
	}
	if calls != 1 {
		t.Fatalf("calls %d", calls)
	}
	root.request(t, "PUT", "/api/v2/admin/telegram/chats", map[string]any{"chat_id": "-100", "pin": "securePIN123", "enabled": true}, 204, nil)
	var update telegramUpdate
	_ = json.Unmarshal([]byte(`{"update_id":1002,"message":{"text":"/codes","from":{"id":123},"chat":{"id":-100,"type":"group"}}}`), &update)
	if _, e := f.service.telegramCommand(f.ctx, update); e == nil {
		t.Fatal("group without PIN")
	}
	update.Message.Text = "/pin securePIN123"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
	update.Message.Text = "/codes"
	if _, e := f.service.telegramCommand(f.ctx, update); e != nil {
		t.Fatal(e)
	}
}
func TestMaintenanceStalePreviewAndProtectedUsers(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '200 days'")
	items, e := f.service.IdleCandidates(f.ctx, 180, "")
	if e != nil || len(items) != 3 {
		t.Fatal(e)
	}
	in := IdleDeleteInput{Days: 180, Confirmation: "DELETE_IDLE_USERS"}
	for _, u := range items {
		if u.ID == f.bob.UserID {
			in.Users = append(in.Users, struct {
				ID      string `json:"id"`
				Version int64  `json:"version,string"`
			}{u.ID, u.Version})
		}
	}
	f.exec(t, "UPDATE pulse.users SET last_active_at=now() WHERE id=$1", f.bob.UserID)
	if _, e = f.service.DeleteIdle(f.ctx, &root.who, in); e == nil {
		t.Fatal("stale idle preview deleted")
	}
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '200 days',internal_staff=true WHERE id=$1", f.bob.UserID)
	if _, e = f.service.DeleteIdle(f.ctx, &root.who, in); e == nil {
		t.Fatal("protected staff deleted")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.bob.UserID)
	if n, e := f.service.DeleteIdle(f.ctx, &root.who, in); e != nil || n != 1 {
		t.Fatal(n, e)
	}
	f.request(t, "GET", "/api/v2/me", f.bob.Token, nil, 401, nil)
	runtimeDir := t.TempDir()
	f.service.RuntimeDir = runtimeDir
	cache := filepath.Join(runtimeDir, "cache")
	if e = os.Mkdir(cache, 0700); e != nil {
		t.Fatal(e)
	}
	old := filepath.Join(cache, "old.bin")
	_ = os.WriteFile(old, []byte("old"), 0600)
	ago := time.Now().Add(-100 * 24 * time.Hour)
	_ = os.Chtimes(old, ago, ago)
	if _, e = f.service.CleanupData(f.ctx, 90); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(old); !os.IsNotExist(e) {
		t.Fatal("old cache not removed")
	}
}
func TestImageHeaderBudgetAndRegistrationAvatar(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	data := imageBytes(t, 1, 1)
	binary.BigEndian.PutUint32(data[16:20], 30000)
	binary.BigEndian.PutUint32(data[20:24], 30000)
	// A forged image must be rejected before allocating its declared pixel buffer.
	mediaID := newID()
	name := mediaID + ".source"
	path, _ := f.service.Media.path(name)
	_ = os.WriteFile(path, data, 0600)
	_, e := f.service.Media.process(f.ctx, mediaJob{Media: Media{ID: mediaID, Kind: "image", Filename: "huge.png"}, Source: name, Lease: newID()})
	if e == nil {
		t.Fatal("forged huge image accepted")
	}
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":true,"avatar_required":true,"per_ip_limit":1}' WHERE key='registration'`)
	id := opaqueToken()
	f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(id), fmtDigest("127.0.0.1:ABCDE"), time.Minute)
	var out map[string]string
	f.request(t, "POST", "/api/v2/auth/register", "", RegisterInput{Account: "avatar123", Nickname: "头像用户", Password: testPassword, CaptchaID: id, CaptchaCode: "ABCDE", AvatarFilename: "avatar.png", AvatarBase64: base64.StdEncoding.EncodeToString(imageBytes(t, 600, 400))}, 201, &out)
	var avatar, status string
	if e = f.store.Pool.QueryRow(f.ctx, "SELECT u.avatar_id::text,m.status FROM pulse.users u JOIN pulse.media m ON m.id=u.avatar_id WHERE u.id=$1", out["id"]).Scan(&avatar, &status); e != nil || status != "ready" {
		t.Fatal("registration avatar not committed", e)
	}
}
func fmtDigest(s string) string { return fmt.Sprintf("%x", digest(s)) }
func TestAudioVideoProbeRealBinary(t *testing.T) {
	probe := os.Getenv("PULSE_TEST_FFPROBE")
	samples := os.Getenv("PULSE_TEST_MEDIA_SAMPLES")
	if probe == "" || samples == "" {
		t.Skip("requires explicit local ffprobe test binary and generated fixtures")
	}
	f := newFixture(t)
	enableTestMedia(t, f)
	f.service.Media.probe = probe
	for _, sample := range []struct{ name, kind string }{{"test-audio.wav", "audio"}, {"test-video.mp4", "video"}} {
		data, e := os.ReadFile(filepath.Join(samples, sample.name))
		if e != nil {
			t.Fatal(e)
		}
		name := newID() + ".source"
		path, _ := f.service.Media.path(name)
		_ = os.WriteFile(path, data, 0600)
		out, e := f.service.Media.process(f.ctx, mediaJob{Media: Media{ID: newID(), Kind: sample.kind, Filename: sample.name}, Source: name, Lease: newID()})
		if e != nil || out.duration <= 0 {
			t.Fatalf("probe %s: %+v %v", sample.name, out, e)
		}
	}
	for _, name := range []string{"legacy-video.avi", "legacy-video.mkv"} {
		data, e := os.ReadFile(filepath.Join("testdata", name))
		if e != nil {
			t.Fatal(e)
		}
		source := newID() + ".source"
		path, _ := f.service.Media.path(source)
		if e = os.WriteFile(path, data, 0600); e != nil {
			t.Fatal(e)
		}
		out, e := f.service.Media.process(f.ctx, mediaJob{Media: Media{ID: newID(), Kind: "video", Filename: name}, Source: source, Lease: newID()})
		if e != nil || out.duration <= 0 || out.mime == "" {
			t.Fatalf("legacy video %s: %+v %v", name, out, e)
		}
	}
}

func TestLegacyXLSWithEmbeddedBitmap(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	enableTestMedia(t, f)
	path := filepath.Join("testdata", "legacy-questions.xls")
	pictures, e := xlsEmbeddedPictures(path)
	if e != nil || len(pictures) != 1 {
		t.Fatalf("XLS picture extraction %d %v", len(pictures), e)
	}
	v, e := f.service.ImportQuestions(f.ctx, root.who, path, ".xls")
	if e != nil {
		t.Fatal(e)
	}
	if v["created"] != 2 || len(v["errors"].([]any)) != 0 {
		t.Fatalf("XLS import: %+v", v)
	}
}

func TestMediaGrantRechecksSessionAndMessageVisibility(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	m := uploadTestImage(t, f, f.alice, imageBytes(t, 80, 60), false)
	sent, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "grant-media", Kind: "image", MediaID: m.ID})
	if e != nil {
		t.Fatal(e)
	}
	var grant struct {
		Path string `json:"content_path"`
	}
	f.request(t, "POST", "/api/v2/media/"+m.ID+"/grants", f.bob.Token, map[string]any{}, 201, &grant)
	f.request(t, "GET", grant.Path, "", nil, 200, nil)
	if _, e = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, sent.Message.Seq); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", grant.Path, "", nil, 403, nil)
	f.request(t, "POST", "/api/v2/media/"+m.ID+"/grants", f.alice.Token, map[string]any{}, 201, &grant)
	if e = f.service.Logout(f.ctx, f.alice.Identity); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", grant.Path, "", nil, 401, nil)
}

func TestSharedMediaAndUpdateCheck(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	media := uploadTestImage(t, f, f.alice, imageBytes(t, 64, 48), false)
	var sent SendResult
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/messages", f.alice.Token, SendInput{RequestID: "shared-photo", Kind: "image", MediaID: media.ID}, 201, &sent)
	var out SharedMediaPage
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/shared-media?kind=image", f.bob.Token, nil, 200, &out)
	if len(out.Items) != 1 || out.Items[0].ID != sent.Message.ID {
		t.Fatal("shared media missing")
	}
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/shared-media?kind=image", f.carol.Token, nil, 403, nil)
	if _, e := f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{sent.Message.ID}); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/shared-media?kind=all", f.bob.Token, nil, 200, &out)
	if len(out.Items) != 0 {
		t.Fatal("deleted media exposed")
	}
	f.exec(t, `UPDATE pulse.system_settings SET value='{"pc":{"latest":"1.2.0","minimum":"1.1.0","force":true,"url":"https://example.invalid/download","notes":"upgrade"}}' WHERE key='releases'`)
	var update map[string]any
	f.request(t, "GET", "/api/v2/client/update?platform=pc&version=1.0.0", "", nil, 200, &update)
	if update["required"] != true || update["update_available"] != true {
		t.Fatal("forced update missing")
	}
	f.request(t, "GET", "/api/v2/client/update?platform=pc&version=1.2.0", "", nil, 200, &update)
	if update["required"] != false || update["update_available"] != false {
		t.Fatal("current version forced")
	}
}

func TestGroupCreationWithOwnedAvatar(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	asset := uploadTestImage(t, f, f.alice, imageBytes(t, 64, 64), false)
	var group GroupCreated
	f.request(t, "POST", "/api/v2/groups", f.alice.Token, map[string]any{"title": "有头像的群", "initial_members": []string{f.bob.UserID}, "avatar_id": asset.ID}, 201, &group)
	details, e := f.service.GroupDetails(f.ctx, f.alice.Identity, group.ID)
	if e != nil || details.AvatarID != asset.ID {
		t.Fatal("group avatar missing", e)
	}
	f.request(t, "POST", "/api/v2/groups", f.bob.Token, map[string]any{"title": "盗用头像", "avatar_id": asset.ID}, 403, nil)
}
func TestFCMProviderProtocol(t *testing.T) {
	f := newFixture(t)
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	tokenCalls, pushCalls := 0, 0
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/token":
			tokenCalls++
			_, _ = w.Write([]byte(`{"access_token":"fixture-access","expires_in":3600}`))
		case "/send":
			pushCalls++
			if r.Header.Get("Authorization") != "Bearer fixture-access" {
				t.Error("missing FCM authorization")
			}
			var message map[string]any
			if e := json.NewDecoder(r.Body).Decode(&message); e != nil {
				t.Error(e)
			}
			_, _ = w.Write([]byte(`{"name":"fixture-message"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer mock.Close()
	f.service.Push = &PushTransport{rsaKey: key, project: "fixture", email: "fixture@example.invalid", client: mock.Client(), tokenURL: mock.URL + "/token", fcmURL: mock.URL + "/send"}
	f.request(t, "PUT", "/api/v2/me/push-device", f.bob.Token, map[string]string{"platform": "android", "token": strings.Repeat("fixture", 5)}, 200, nil)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '5 minutes' WHERE id=$1", f.bob.UserID)
	if _, e = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "fcm-test", Body: "hello"}); e != nil {
		t.Fatal(e)
	}
	if done, e := f.service.ProcessPushOnce(f.ctx); e != nil || !done {
		t.Fatal("FCM processing", e)
	}
	if tokenCalls != 1 || pushCalls != 1 {
		t.Fatalf("unexpected FCM requests %d %d", tokenCalls, pushCalls)
	}
}
