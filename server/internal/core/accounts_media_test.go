package core

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestRegistrationCaptchaSingleUseAndProfileVersion(t *testing.T) {
	f := newFixture(t)
	var captcha Captcha
	f.request(t, "GET", "/api/v2/auth/captcha", "", nil, 200, &captcha)
	if captcha.ExpiresIn != 120 || len(captcha.Image) < 100 {
		t.Fatal("captcha image missing")
	}
	f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+hex.EncodeToString(digest(captcha.ID)), hex.EncodeToString(digest("127.0.0.1:ABCDE")), time.Minute)
	in := RegisterInput{Account: "newuser9", Nickname: "新用户", Password: testPassword, CaptchaID: captcha.ID, CaptchaCode: "wrong"}
	f.request(t, "POST", "/api/v2/auth/register", "", in, 400, nil)
	in.CaptchaCode = "ABCDE"
	f.request(t, "POST", "/api/v2/auth/register", "", in, 400, nil)
	f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+hex.EncodeToString(digest(captcha.ID)), hex.EncodeToString(digest("127.0.0.1:ABCDE")), time.Minute)
	f.request(t, "POST", "/api/v2/auth/register", "", in, 201, nil)
	var login Login
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": in.Account, "password": testPassword, "device_id": "register-test", "platform": "web"}, 200, &login)
	var profile Profile
	f.request(t, "GET", "/api/v2/me/profile", login.Token, nil, 200, &profile)
	if profile.Nickname != "新用户" || len(profile.PublicID) != 32 {
		t.Fatalf("profile incomplete: %+v", profile)
	}
	nickname := "新昵称"
	patch := ProfilePatch{Nickname: &nickname, ExpectedVersion: profile.Version}
	f.request(t, "PATCH", "/api/v2/me/profile", login.Token, patch, 200, &profile)
	f.request(t, "PATCH", "/api/v2/me/profile", login.Token, patch, 409, nil)
	f.request(t, "GET", "/api/v2/public-users/"+profile.PublicID, f.alice.Token, nil, 200, nil)
	f.request(t, "GET", "/api/v2/profiles/"+profile.ID, f.alice.Token, nil, 403, nil)
}
func TestTwoStepRecoveryReplayAndMobileBinding(t *testing.T) {
	f := newFixture(t)
	var result struct {
		Enabled bool     `json:"enabled"`
		Codes   []string `json:"recovery_codes"`
	}
	f.request(t, "PUT", "/api/v2/me/security", f.alice.Token, SecurityInput{Action: "enable", LoginPassword: testPassword, Next: "SecondFactor_2026"}, 200, &result)
	if !result.Enabled || len(result.Codes) != 8 {
		t.Fatal("recovery codes missing")
	}
	loginBody := map[string]string{"account": "alice01", "password": testPassword, "device_id": "mobile-a", "platform": "android"}
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 401, nil)
	loginBody["second_factor"] = result.Codes[0]
	var logged Login
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 200, &logged)
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 401, nil)
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":true}' WHERE key='mobile_binding'`)
	loginBody["second_factor"] = "SecondFactor_2026"
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 200, &logged)
	loginBody["device_id"] = "other-mobile"
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 403, nil)
	loginBody["platform"] = "pc"
	f.request(t, "POST", "/api/v2/auth/login", "", loginBody, 200, nil)
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":false}' WHERE key='mobile_binding'`)
}
func enableTestMedia(t *testing.T, f *fixture) {
	t.Helper()
	var e error
	f.service.Media, e = NewMediaStore(t.TempDir(), "")
	if e != nil {
		t.Fatal(e)
	}
}
func imageBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			im.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), uint8(x + y), 255})
		}
	}
	var b bytes.Buffer
	if e := png.Encode(&b, im); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func uploadTestImage(t *testing.T, f *fixture, owner Login, content []byte, original bool) Media {
	t.Helper()
	sum := sha256.Sum256(content)
	in := UploadInput{RequestID: newID(), Kind: "image", Filename: "photo.png", Bytes: int64(len(content)), SHA256: hex.EncodeToString(sum[:]), Original: original}
	var out Media
	f.request(t, "POST", "/api/v2/media/uploads", owner.Token, in, 201, &out)
	req, _ := http.NewRequest("PUT", f.http.URL+"/api/v2/media/"+out.ID+"/bytes", bytes.NewReader(content))
	req.Header.Set("Authorization", "Bearer "+owner.Token)
	resp, e := f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 202 {
		t.Fatalf("upload %d: %s", resp.StatusCode, b)
	}
	if done, e := f.service.ProcessMediaOnce(f.ctx); !done || e != nil {
		t.Fatalf("worker: %v %v", done, e)
	}
	f.request(t, "GET", "/api/v2/media/"+out.ID, owner.Token, nil, 200, &out)
	if out.Status != "ready" {
		t.Fatalf("image not ready: %+v", out)
	}
	return out
}
func TestPrivateMediaOriginalForwardRevocationAndRange(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	raw := imageBytes(t, 80, 60)
	media := uploadTestImage(t, f, f.alice, raw, true)
	f.request(t, "GET", "/api/v2/media/"+media.ID+"/content", f.bob.Token, nil, 403, nil)
	var sent SendResult
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/messages", f.alice.Token, SendInput{RequestID: "image-first", Kind: "image", MediaID: media.ID}, 201, &sent)
	var data MessageContent
	if e := json.Unmarshal(sent.Message.Content, &data); e != nil || data.Media == nil || data.Media.ID != media.ID {
		t.Fatal("missing authoritative media")
	}
	req, _ := http.NewRequest("GET", f.http.URL+"/api/v2/media/"+media.ID+"/content", nil)
	req.Header.Set("Authorization", "Bearer "+f.bob.Token)
	resp, e := f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 || !bytes.Equal(got, raw) {
		t.Fatal("original bytes changed")
	}
	req.Header.Set("Range", "bytes=0-9")
	resp, e = f.http.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	got, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 206 || !bytes.Equal(got, raw[:10]) {
		t.Fatal("range unavailable")
	}
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/messages", f.carol.Token, SendInput{RequestID: "stolen", Kind: "image", MediaID: media.ID}, 403, nil)
	if _, e = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, sent.Message.Seq); e != nil {
		t.Fatal(e)
	}
	f.request(t, "GET", "/api/v2/media/"+media.ID+"/content", f.bob.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/messages", f.bob.Token, SendInput{RequestID: "hidden-forward", SourceMessageID: sent.Message.ID}, 403, nil)
	// The uploader retains ownership access even after another participant clears history.
	f.request(t, "GET", "/api/v2/media/"+media.ID+"/preview", f.alice.Token, nil, 200, nil)
	f.request(t, "PATCH", "/api/v2/conversations/"+f.cid+"/messages/"+sent.Message.ID, f.alice.Token, map[string]string{"body": "fake type", "expected_version": "1"}, 403, nil)
}
func TestMediaProcessingAndCancelledUpload(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	raw := imageBytes(t, 2800, 100)
	media := uploadTestImage(t, f, f.alice, raw, false)
	if media.Width != 2560 || media.Height >= 100 || media.MIME != "image/jpeg" {
		t.Fatalf("image not transformed: %+v", media)
	}
	sum := sha256.Sum256(raw)
	in := UploadInput{RequestID: "cancel-photo", Kind: "image", Filename: "photo.png", Bytes: int64(len(raw)), SHA256: hex.EncodeToString(sum[:])}
	m, e := f.service.CreateUpload(f.ctx, f.alice.Identity, in)
	if e != nil {
		t.Fatal(e)
	}
	if e = f.service.CancelUpload(f.ctx, f.alice.Identity, m.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = f.service.UploadBytes(f.ctx, f.alice.Identity, m.ID, bytes.NewReader(raw)); !errors.Is(e, ErrConflict) {
		t.Fatalf("cancelled upload accepted: %v", e)
	}
	// Concurrent replay of creation never allocates multiple objects.
	in.RequestID = "parallel-photo"
	var wg sync.WaitGroup
	ids := make(chan string, 4)
	for i := 0; i < 4; i++ {
		wg.Go(func() {
			m, e := f.service.CreateUpload(f.ctx, f.alice.Identity, in)
			if e != nil {
				t.Error(e)
				return
			}
			ids <- m.ID
		})
	}
	wg.Wait()
	close(ids)
	same := ""
	for id := range ids {
		if same != "" && same != id {
			t.Fatal("duplicate media")
		}
		same = id
	}
}
