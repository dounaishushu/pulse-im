package core

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func TestRegistrationIPLimitReportsObservedIP(t *testing.T) {
	for _, tc := range []struct {
		name, remote, forwarded, ip string
		trusted                     []netip.Prefix
	}{
		{name: "ipv4", remote: "192.0.2.15:42000", ip: "192.0.2.15"},
		{name: "untrusted_header", remote: "198.51.100.15:42000", forwarded: "203.0.113.99", ip: "198.51.100.15", trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		{name: "trusted_proxy", remote: "127.0.0.1:42000", forwarded: "203.0.113.15", ip: "203.0.113.15", trusted: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		{name: "ipv6", remote: "[2001:db8::15]:42000", ip: "2001:db8::15"},
		{name: "mapped_ipv4", remote: "[::ffff:192.0.2.15]:42000", ip: "192.0.2.15"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":true,"avatar_required":false,"per_ip_limit":1}' WHERE key='registration'`)
			f.exec(t, "UPDATE pulse.users SET registration_ip=$2 WHERE id=$1", f.alice.UserID, tc.ip)
			captcha := opaqueToken()
			if err := f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(captcha), fmtDigest(tc.ip+":ABCDE"), time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			body, err := json.Marshal(RegisterInput{Account: "ipquota01", Nickname: "注册测试", Password: testPassword, CaptchaID: captcha, CaptchaCode: "ABCDE"})
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/api/v2/auth/register", bytes.NewReader(body))
			req.RemoteAddr = tc.remote
			req.Header.Set("X-Real-IP", tc.forwarded)
			req.Header.Set("X-Forwarded-For", "203.0.113.99")
			recorder := httptest.NewRecorder()
			NewHandler(f.service, f.hub, HTTPOptions{TrustedProxies: tc.trusted}).ServeHTTP(recorder, req)
			if recorder.Code != http.StatusTooManyRequests {
				t.Fatalf("unexpected registration result: %d %s", recorder.Code, recorder.Body.String())
			}
			var result struct {
				Error struct {
					Code      string `json:"code"`
					IP        string `json:"current_ip"`
					Message   string `json:"message"`
					RequestID string `json:"request_id"`
					Retryable bool   `json:"retryable"`
				} `json:"error"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Error.Code != "registration_ip_limit" || result.Error.IP != tc.ip || result.Error.Message != "该IP已经注册过账户\n当前IP："+tc.ip {
				t.Fatalf("missing or wrong IP warning: %+v", result.Error)
			}
			if result.Error.Retryable || recorder.Header().Get("Retry-After") != "" || result.Error.RequestID == "" {
				t.Fatalf("registration policy rejection was marked retryable or untraceable: %+v", result.Error)
			}
			if recorder.Header().Get("Cache-Control") != "no-store" || strings.Contains(recorder.Body.String(), f.alice.UserID) || strings.Contains(recorder.Body.String(), "alice01") {
				t.Fatal("IP warning is cacheable or exposes an existing account")
			}
			var count int
			if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.users WHERE account='ipquota01'").Scan(&count); err != nil || count != 0 {
				t.Fatal("rejected registration created a user", count, err)
			}
		})
	}
}

func TestRegistrationIPWarningPreservesConfiguredLimit(t *testing.T) {
	for _, tc := range []struct {
		name, policy string
		deleted      bool
	}{
		{name: "disabled_limit", policy: `{"enabled":true,"avatar_required":false,"per_ip_limit":0}`},
		{name: "remaining_quota", policy: `{"enabled":true,"avatar_required":false,"per_ip_limit":2}`},
		{name: "deleted_user_does_not_consume_quota", policy: `{"enabled":true,"avatar_required":false,"per_ip_limit":1}`, deleted: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			f.exec(t, "UPDATE pulse.system_settings SET value=$1::jsonb WHERE key='registration'", tc.policy)
			f.exec(t, "UPDATE pulse.users SET registration_ip='127.0.0.1',deleted_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1", f.alice.UserID, tc.deleted)
			captcha := opaqueToken()
			if err := f.cache.Client.Set(f.ctx, f.cache.Prefix+"captcha:"+fmtDigest(captcha), fmtDigest("127.0.0.1:ABCDE"), time.Minute).Err(); err != nil {
				t.Fatal(err)
			}
			f.request(t, http.MethodPost, "/api/v2/auth/register", "", RegisterInput{Account: "ipquota02", Nickname: "注册测试", Password: testPassword, CaptchaID: captcha, CaptchaCode: "ABCDE"}, http.StatusCreated, nil)
		})
	}
}

func TestRegistrationInvalidCaptchaDoesNotExposeIP(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":true,"avatar_required":false,"per_ip_limit":1}' WHERE key='registration'`)
	f.exec(t, "UPDATE pulse.users SET registration_ip='127.0.0.1' WHERE id=$1", f.alice.UserID)
	var result map[string]map[string]any
	f.request(t, http.MethodPost, "/api/v2/auth/register", "", RegisterInput{Account: "ipquota03", Nickname: "注册测试", Password: testPassword, CaptchaID: opaqueToken(), CaptchaCode: "ABCDE"}, http.StatusBadRequest, &result)
	if result["error"]["code"] != "captcha_invalid_or_expired" || result["error"]["current_ip"] != nil {
		t.Fatal("IP quota information exposed before captcha validation", result)
	}
}

func TestTemporaryRateLimitKeepsRetryAfter(t *testing.T) {
	recorder := httptest.NewRecorder()
	writeFault(recorder, ErrLimited)
	if recorder.Code != http.StatusTooManyRequests || recorder.Header().Get("Retry-After") == "" {
		t.Fatal("temporary rate limiting lost its retry interval")
	}
	var result map[string]map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result["error"]["retryable"] != true || result["error"]["current_ip"] != nil {
		t.Fatal("temporary rate limiting was mistaken for an IP registration quota", result)
	}
}
