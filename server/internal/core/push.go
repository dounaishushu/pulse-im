package core

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

type PushConfig struct{ APNsKeyID, APNsTeam, APNsTopic, APNsKeyPath, FCMAccountPath string }
type PushTransport struct {
	config                                 PushConfig
	client                                 *http.Client
	apnsMu                                 sync.Mutex
	apnsJWT                                string
	apnsExpires                            time.Time
	mu                                     sync.Mutex
	fcmToken                               string
	fcmExpires                             time.Time
	project, email                         string
	rsaKey                                 *rsa.PrivateKey
	ecKey                                  *ecdsa.PrivateKey
	apnsURL, apnsSandbox, tokenURL, fcmURL string
}

func NewPushTransport(config PushConfig) (*PushTransport, error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxConnsPerHost = 16
	tr.MaxIdleConnsPerHost = 16
	tr.ResponseHeaderTimeout = 5 * time.Second
	p := &PushTransport{config: config, client: &http.Client{Transport: tr, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("push redirect refused") }}, apnsURL: "https://api.push.apple.com", apnsSandbox: "https://api.sandbox.push.apple.com", tokenURL: "https://oauth2.googleapis.com/token"}
	if config.APNsKeyPath != "" {
		raw, e := os.ReadFile(config.APNsKeyPath)
		if e != nil {
			return nil, errors.New("APNs key unreadable")
		}
		block, _ := pem.Decode(raw)
		if block == nil {
			return nil, errors.New("APNs key invalid")
		}
		key, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return nil, errors.New("APNs key invalid")
		}
		var ok bool
		p.ecKey, ok = key.(*ecdsa.PrivateKey)
		if !ok || p.ecKey.Curve.Params().BitSize != 256 || config.APNsKeyID == "" || config.APNsTeam == "" || config.APNsTopic == "" {
			return nil, errors.New("APNs configuration incomplete")
		}
	}
	if config.FCMAccountPath != "" {
		raw, e := os.ReadFile(config.FCMAccountPath)
		if e != nil {
			return nil, errors.New("FCM credentials unreadable")
		}
		var account struct {
			Project string `json:"project_id"`
			Email   string `json:"client_email"`
			Key     string `json:"private_key"`
		}
		if json.Unmarshal(raw, &account) != nil {
			return nil, errors.New("FCM credentials invalid")
		}
		block, _ := pem.Decode([]byte(account.Key))
		if block == nil {
			return nil, errors.New("FCM key invalid")
		}
		key, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return nil, errors.New("FCM key invalid")
		}
		var ok bool
		p.rsaKey, ok = key.(*rsa.PrivateKey)
		if !ok || account.Project == "" || account.Email == "" {
			return nil, errors.New("FCM credentials incomplete")
		}
		p.project, p.email = account.Project, account.Email
		p.fcmURL = "https://fcm.googleapis.com/v1/projects/" + url.PathEscape(p.project) + "/messages:send"
	}
	return p, nil
}
func (p *PushTransport) Available(platform string) bool {
	if p == nil {
		return false
	}
	if platform == "ios" {
		return p.ecKey != nil
	}
	return platform == "android" && p.rsaKey != nil
}
func jwtParts(header, claims any) (string, error) {
	h, e := json.Marshal(header)
	if e != nil {
		return "", e
	}
	c, e := json.Marshal(claims)
	if e != nil {
		return "", e
	}
	return base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c), nil
}
func (p *PushTransport) apnsToken() (string, error) {
	p.apnsMu.Lock()
	defer p.apnsMu.Unlock()
	now := time.Now()
	if p.apnsJWT != "" && now.Before(p.apnsExpires) {
		return p.apnsJWT, nil
	}
	body, e := jwtParts(map[string]string{"alg": "ES256", "kid": p.config.APNsKeyID}, map[string]any{"iss": p.config.APNsTeam, "iat": now.Unix()})
	if e != nil {
		return "", e
	}
	hash := sha256.Sum256([]byte(body))
	r, s, e := ecdsa.Sign(rand.Reader, p.ecKey, hash[:])
	if e != nil {
		return "", e
	}
	signature := make([]byte, 64)
	r.FillBytes(signature[:32])
	s.FillBytes(signature[32:])
	p.apnsJWT = body + "." + base64.RawURLEncoding.EncodeToString(signature)
	p.apnsExpires = now.Add(45 * time.Minute)
	return p.apnsJWT, nil
}
func (p *PushTransport) fcmAccess(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.fcmToken != "" && time.Until(p.fcmExpires) > time.Minute {
		return p.fcmToken, nil
	}
	body, e := jwtParts(map[string]string{"alg": "RS256", "typ": "JWT"}, map[string]any{"iss": p.email, "scope": "https://www.googleapis.com/auth/firebase.messaging", "aud": "https://oauth2.googleapis.com/token", "iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix()})
	if e != nil {
		return "", e
	}
	hash := sha256.Sum256([]byte(body))
	signature, e := rsa.SignPKCS1v15(rand.Reader, p.rsaKey, crypto.SHA256, hash[:])
	if e != nil {
		return "", e
	}
	assertion := body + "." + base64.RawURLEncoding.EncodeToString(signature)
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, _ := http.NewRequestWithContext(ctx, "POST", p.tokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, e := p.client.Do(req)
	if e != nil {
		return "", ErrBusy
	}
	defer resp.Body.Close()
	raw, e := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if e != nil || resp.StatusCode != 200 {
		return "", ErrBusy
	}
	var out struct {
		Token   string `json:"access_token"`
		Expires int    `json:"expires_in"`
	}
	if json.Unmarshal(raw, &out) != nil || out.Token == "" || out.Expires <= 0 {
		return "", ErrBusy
	}
	p.fcmToken = out.Token
	p.fcmExpires = time.Now().Add(time.Duration(min(out.Expires, 3600)) * time.Second)
	return p.fcmToken, nil
}

type PushDevice struct {
	ID, UserID, Platform, Token, Environment string
	Preview                                  bool
	PayloadVersion                           int
}

type pushMessage struct {
	ID, ConversationID, ConversationType, Body, Kind string
	Seq                                              int64
}

type pushBackoff struct {
	cause error
	delay time.Duration
}

func (e *pushBackoff) Error() string { return e.cause.Error() }
func (e *pushBackoff) Unwrap() error { return e.cause }

func (p *PushTransport) Send(ctx context.Context, d PushDevice, message pushMessage, title, body string) error {
	if !p.Available(d.Platform) {
		return &Fault{503, "push_provider_unconfigured"}
	}
	data := map[string]string{
		"user_id": d.UserID, "conversation_id": message.ConversationID, "message_id": message.ID,
		"conversation_type": message.ConversationType, "seq": strconv.FormatInt(message.Seq, 10),
	}
	var req *http.Request
	if d.Platform == "ios" {
		token, e := p.apnsToken()
		if e != nil {
			return e
		}
		host := p.apnsURL
		if d.Environment == "sandbox" {
			host = p.apnsSandbox
		}
		payload := make(map[string]any, len(data)+1)
		for key, value := range data {
			payload[key] = value
		}
		payload["aps"] = map[string]any{"alert": map[string]string{"title": title, "body": body}, "sound": "default"}
		raw, _ := json.Marshal(payload)
		req, _ = http.NewRequestWithContext(ctx, "POST", host+"/3/device/"+url.PathEscape(d.Token), bytes.NewReader(raw))
		req.Header.Set("Authorization", "bearer "+token)
		req.Header.Set("apns-topic", p.config.APNsTopic)
		req.Header.Set("apns-push-type", "alert")
		req.Header.Set("apns-priority", "10")
		req.Header.Set("apns-collapse-id", message.ConversationID)
		req.Header.Set("apns-expiration", strconv.FormatInt(time.Now().Add(pushMaxAge).Unix(), 10))
	} else {
		token, e := p.fcmAccess(ctx)
		if e != nil {
			return e
		}
		android := map[string]any{"priority": "high", "ttl": strconv.FormatInt(int64(pushMaxAge.Seconds()), 10) + "s"}
		payload := map[string]any{"token": d.Token, "data": data, "android": android}
		if d.PayloadVersion >= 2 {
			data["body"] = body
		} else {
			// An older app needs FCM's system notification to display in the background.
			payload["notification"] = map[string]string{"title": title, "body": body}
			android["collapse_key"] = message.ConversationID
		}
		raw, _ := json.Marshal(map[string]any{"message": payload})
		req, _ = http.NewRequestWithContext(ctx, "POST", p.fcmURL, bytes.NewReader(raw))
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, e := p.client.Do(req)
	if e != nil {
		return ErrBusy
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if (d.Platform == "ios" && resp.StatusCode == 410) || (d.Platform == "android" && resp.StatusCode == 404 && bytes.Contains(raw, []byte(`"UNREGISTERED"`))) {
		return &Fault{410, "push_device_expired"}
	}
	if resp.StatusCode == 429 || resp.StatusCode >= 500 || resp.StatusCode == 401 || resp.StatusCode == 403 {
		var delay time.Duration
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			delay = time.Duration(min(seconds, 3600)) * time.Second
		} else if at, err := http.ParseTime(resp.Header.Get("Retry-After")); err == nil {
			delay = min(time.Until(at), time.Hour)
		}
		if resp.StatusCode == 429 {
			delay = max(delay, time.Minute)
		}
		return &pushBackoff{ErrBusy, delay}
	}
	return &Fault{502, "push_provider_rejected"}
}
func (a *API) registerPush(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/me/push-devices", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		rows, err := s.Store.Pool.Query(r.Context(), `SELECT id::text,platform,created_at FROM pulse.push_devices WHERE user_id=$1 AND enabled ORDER BY created_at DESC LIMIT 20`, who.UserID)
		if err != nil {
			return err
		}
		defer rows.Close()
		items := []map[string]any{}
		for rows.Next() {
			var id, platform string
			var created time.Time
			if err = rows.Scan(&id, &platform, &created); err != nil {
				return err
			}
			items = append(items, map[string]any{"id": id, "platform": platform, "created_at": created, "last_used_at": nil})
		}
		if err = rows.Err(); err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/me/push-device", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Platform       string `json:"platform"`
			Token          string `json:"token"`
			Environment    string `json:"environment"`
			PayloadVersion int    `json:"payload_version"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if (in.Platform != "android" && in.Platform != "ios") || !validText(in.Token, 16, 4096) {
			return ErrInvalid
		}
		if in.PayloadVersion < 0 || in.PayloadVersion > 2 {
			return ErrInvalid
		}
		in.PayloadVersion = max(1, in.PayloadVersion)
		if in.Environment == "" {
			in.Environment = "production"
		}
		if in.Environment != "production" && in.Environment != "sandbox" {
			return ErrInvalid
		}
		if in.Platform == "ios" {
			in.Token = strings.ToLower(in.Token)
			if _, e := hex.DecodeString(in.Token); e != nil {
				return ErrInvalid
			}
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = lockIdentity(r.Context(), tx, who); e != nil {
			return e
		}
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.push_devices SET enabled=false WHERE token_hash=$1 AND session_id IS DISTINCT FROM $2 AND enabled", digest(in.Token), who.SessionID); e != nil {
			return e
		}
		var legacyOwner string
		var legacyEnabled bool
		legacyErr := tx.QueryRow(r.Context(), "SELECT user_id::text,enabled FROM pulse.legacy_push_devices WHERE token_hash=$1 FOR UPDATE", digest(in.Token)).Scan(&legacyOwner, &legacyEnabled)
		if legacyErr != nil && !errors.Is(legacyErr, pgx.ErrNoRows) {
			return legacyErr
		}
		if legacyErr == nil && legacyEnabled && legacyOwner != who.UserID {
			return ErrForbidden
		}
		// One active registration per session; token transfer preserves historical delivery references.
		var existingToken []byte
		scanErr := tx.QueryRow(r.Context(), "SELECT token_hash FROM pulse.push_devices WHERE session_id=$1", who.SessionID).Scan(&existingToken)
		if scanErr == nil && !equalBytes(existingToken, digest(in.Token)) {
			if _, e = tx.Exec(r.Context(), "UPDATE pulse.push_devices SET enabled=false,session_id=NULL WHERE session_id=$1", who.SessionID); e != nil {
				return e
			}
		} else if scanErr != nil && !errors.Is(scanErr, pgx.ErrNoRows) {
			return scanErr
		}
		_, e = tx.Exec(r.Context(), `INSERT INTO pulse.push_devices(id,user_id,session_id,platform,token,token_hash,environment,payload_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(token_hash) DO UPDATE SET user_id=$2,session_id=$3,platform=$4,token=$5,environment=$7,payload_version=$8,enabled=true,updated_at=now()`, newID(), who.UserID, who.SessionID, in.Platform, in.Token, digest(in.Token), in.Environment, in.PayloadVersion)
		if e != nil {
			return e
		}
		if legacyErr == nil && legacyEnabled {
			if _, e = tx.Exec(r.Context(), "UPDATE pulse.legacy_push_devices SET enabled=false WHERE token_hash=$1", digest(in.Token)); e != nil {
				return e
			}
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, map[string]any{"registered": true, "provider_configured": s.Push.Available(in.Platform)})
		}
		return e
	}))
	mux.HandleFunc("DELETE /api/v2/me/push-device", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		_, e := s.Store.Pool.Exec(r.Context(), "UPDATE pulse.push_devices SET enabled=false WHERE session_id=$1 AND user_id=$2", who.SessionID, who.UserID)
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
}
