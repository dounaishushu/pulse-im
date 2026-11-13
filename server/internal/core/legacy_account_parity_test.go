package core

import (
	"errors"
	"testing"
	"time"
)

func TestLegacyUsernameAndBirthdayRules(t *testing.T) {
	f := newFixture(t)
	codeID := opaqueToken()
	if err := f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(codeID), fmtDigest("127.0.0.1:ABCDE"), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	var created struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/auth/register", "", RegisterInput{
		Account: "LegacyAccountName", Nickname: "兼容用户", Password: "A1bcdefg",
		CaptchaID: codeID, CaptchaCode: "ABCDE",
	}, 201, &created)
	if created.ID == "" {
		t.Fatal("registration returned no id")
	}
	var login Login
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{
		"account": "LEGACYACCOUNTNAME", "password": "A1bcdefg", "device_id": "legacy-login",
	}, 200, &login)
	if login.UserID != created.ID {
		t.Fatal("legacy username login did not resolve the new user")
	}
	profile, err := f.service.Profile(f.ctx, f.alice.Identity, f.alice.UserID, "")
	if err != nil {
		t.Fatal(err)
	}
	if profile.CanChangeAccount != false || !profile.CanChangeBirthday {
		t.Fatalf("profile change flags differ from old rules: %+v", profile)
	}
	newAccount := "otheraccount"
	if _, err = f.service.UpdateProfile(f.ctx, f.alice.Identity, ProfilePatch{Account: &newAccount, ExpectedVersion: profile.Version}); err == nil {
		t.Fatal("an account already set at registration was changed")
	}
	for i, day := range []string{"2000-01-01", "2001-01-01"} {
		profile, err = f.service.UpdateProfile(f.ctx, f.alice.Identity, ProfilePatch{Birthday: &day, ExpectedVersion: profile.Version})
		if err != nil {
			t.Fatalf("birthday update %d failed: %v", i, err)
		}
	}
	third := "2002-01-01"
	_, err = f.service.UpdateProfile(f.ctx, f.alice.Identity, ProfilePatch{Birthday: &third, ExpectedVersion: profile.Version})
	var fault *Fault
	if !errors.As(err, &fault) || fault.Code != "birthday_change_limit" {
		t.Fatalf("second birthday change was not rejected: %v", err)
	}
	if profile.Birthday != "2001-01-01" || profile.CanChangeBirthday {
		t.Fatalf("birthday state after one change: %+v", profile)
	}
}

func TestPhoneOnlyRegistrationKeepsPrivateInternalAccountHidden(t *testing.T) {
	f := newFixture(t)
	codeID := opaqueToken()
	if err := f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(codeID), fmtDigest("127.0.0.1:ABCDE"), time.Minute).Err(); err != nil {
		t.Fatal(err)
	}
	var created struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/auth/register", "", RegisterInput{
		Phone: "+86 138 0000", Nickname: "手机用户", Password: "12345678",
		CaptchaID: codeID, CaptchaCode: "ABCDE",
	}, 201, &created)
	var login Login
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{
		"account": "+86 138 0000", "password": "12345678", "device_id": "phone-only-device",
	}, 200, &login)
	if login.UserID != created.ID {
		t.Fatal("phone login resolved the wrong user")
	}
	profile, err := f.service.Profile(f.ctx, login.Identity, created.ID, "")
	if err != nil || profile.Account != "" || !profile.CanChangeAccount || profile.Phone == nil || *profile.Phone != "+86 138 0000" {
		t.Fatalf("phone-only profile leaked or lost identity: %+v %v", profile, err)
	}
	var internalAccount string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT account FROM pulse.users WHERE id=$1", created.ID).Scan(&internalAccount); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", "/api/v2/users/by-account/"+internalAccount, f.alice.Token, nil, 404, nil)
	var public Profile
	f.request(t, "GET", "/api/v2/public-users/"+profile.PublicID, f.alice.Token, nil, 200, &public)
	if public.Account != "" || public.Phone != nil {
		t.Fatalf("public lookup exposed phone-only private account: %+v", public)
	}
	var direct struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": created.ID}, 200, &direct)
	var inConversation map[string]any
	f.request(t, "GET", "/api/v2/client/users/"+created.ID+"?conversation_id="+direct.ID, f.alice.Token, nil, 200, &inConversation)
	if inConversation["account"] != "" {
		t.Fatalf("conversation profile exposed phone-only private account: %+v", inConversation)
	}
	username := "phone_user"
	profile, err = f.service.UpdateProfile(f.ctx, login.Identity, ProfilePatch{Account: &username, ExpectedVersion: profile.Version})
	if err != nil || profile.Account != username || profile.CanChangeAccount {
		t.Fatalf("phone-only username was not set exactly once: %+v %v", profile, err)
	}
}
