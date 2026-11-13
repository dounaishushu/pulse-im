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
	"github.com/jackc/pgx/v5"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type PushConfig struct{ APNsKeyID, APNsTeam, APNsTopic, APNsKeyPath, FCMAccountPath string }
type PushTransport struct {
	config                                 PushConfig
	client                                 *http.Client
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
	tr.MaxConnsPerHost = 4
	tr.MaxIdleConnsPerHost = 4
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
	body, e := jwtParts(map[string]string{"alg": "ES256", "kid": p.config.APNsKeyID}, map[string]any{"iss": p.config.APNsTeam, "iat": time.Now().Unix()})
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
	return body + "." + base64.RawURLEncoding.EncodeToString(signature), nil
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
}

func (p *PushTransport) Send(ctx context.Context, d PushDevice, mid, cid, title, body string) error {
	if !p.Available(d.Platform) {
		return &Fault{503, "push_provider_unconfigured"}
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
		raw, _ := json.Marshal(map[string]any{"aps": map[string]any{"alert": map[string]string{"title": title, "body": body}, "sound": "default"}, "message_id": mid, "conversation_id": cid})
		req, _ = http.NewRequestWithContext(ctx, "POST", host+"/3/device/"+url.PathEscape(d.Token), bytes.NewReader(raw))
		req.Header.Set("Authorization", "bearer "+token)
		req.Header.Set("apns-topic", p.config.APNsTopic)
		req.Header.Set("apns-push-type", "alert")
		req.Header.Set("apns-priority", "10")
		req.Header.Set("apns-collapse-id", cid)
	} else {
		token, e := p.fcmAccess(ctx)
		if e != nil {
			return e
		}
		raw, _ := json.Marshal(map[string]any{"message": map[string]any{"token": d.Token, "notification": map[string]string{"title": title, "body": body}, "data": map[string]string{"message_id": mid, "conversation_id": cid}, "android": map[string]any{"priority": "high", "collapse_key": cid}}})
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
	if (d.Platform == "ios" && (resp.StatusCode == 410 || bytes.Contains(raw, []byte("BadDeviceToken")))) || (d.Platform == "android" && bytes.Contains(raw, []byte("UNREGISTERED"))) {
		return &Fault{410, "push_device_expired"}
	}
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return ErrBusy
	}
	return &Fault{502, "push_provider_rejected"}
}
func (s *Service) ProcessPushOnce(ctx context.Context) (bool, error) {
	if _, e := s.Store.Pool.Exec(ctx, `DELETE FROM pulse.push_jobs WHERE message_id IN(SELECT j.message_id FROM pulse.push_jobs j JOIN pulse.messages m ON m.id=j.message_id WHERE m.created_at<now()-interval '7 days' OR j.attempts>=20 ORDER BY j.available_at LIMIT 100)`); e != nil {
		return false, e
	}
	if s.Push == nil || (!s.Push.Available("android") && !s.Push.Available("ios")) {
		return false, nil
	}
	lease := newID()
	var mid, cursor string
	e := s.Store.Pool.QueryRow(ctx, `WITH candidate AS(SELECT message_id FROM pulse.push_jobs WHERE available_at<=now() AND(lease_until IS NULL OR lease_until<now()) ORDER BY available_at,message_id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE pulse.push_jobs j SET lease_token=$1,lease_until=now()+interval '30 seconds',attempts=attempts+1 FROM candidate c WHERE j.message_id=c.message_id RETURNING j.message_id::text,j.cursor_user::text`, lease).Scan(&mid, &cursor)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	var cid, body, kind string
	var revoked bool
	if e = s.Store.Pool.QueryRow(ctx, "SELECT conversation_id::text,body,kind,revoked FROM pulse.messages WHERE id=$1", mid).Scan(&cid, &body, &kind, &revoked); e != nil {
		return true, e
	}
	if revoked {
		_, e = s.Store.Pool.Exec(ctx, "DELETE FROM pulse.push_jobs WHERE message_id=$1 AND lease_token=$2", mid, lease)
		return true, e
	}
	rows, e := s.Store.Pool.Query(ctx, `SELECT m.user_id::text FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id AND c.active JOIN pulse.users u ON u.id=m.user_id AND u.active WHERE m.conversation_id=$1 AND m.active AND m.user_id>$2 ORDER BY m.user_id LIMIT 25`, cid, cursor)
	if e != nil {
		return true, e
	}
	users := []string{}
	for rows.Next() {
		var uid string
		if e = rows.Scan(&uid); e != nil {
			rows.Close()
			return true, e
		}
		users = append(users, uid)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return true, e
	}
	for _, uid := range users {
		devices, e := s.Store.Pool.Query(ctx, `SELECT d.id::text,d.user_id::text,d.platform,d.token,d.environment,COALESCE(p.preview,true) FROM pulse.push_devices d JOIN pulse.login_sessions ls ON ls.id=d.session_id AND ls.revoked_at IS NULL AND ls.expires_at>now() JOIN pulse.users u ON u.id=d.user_id AND u.active JOIN pulse.members m ON m.user_id=d.user_id AND m.conversation_id=$2 AND m.active JOIN pulse.user_states st ON st.user_id=m.user_id AND st.conversation_id=m.conversation_id JOIN pulse.messages msg ON msg.id=$3 AND NOT msg.revoked LEFT JOIN pulse.notification_preferences p ON p.user_id=d.user_id
 WHERE d.user_id=$1 AND d.enabled AND msg.sender_id<>$1 AND NOT st.muted_notifications AND COALESCE(p.enabled,true) AND u.last_active_at<now()-interval '60 seconds' AND NOT EXISTS(SELECT 1 FROM pulse.blocks bl WHERE(bl.user_id=$1 AND bl.peer_id=msg.sender_id)OR(bl.peer_id=$1 AND bl.user_id=msg.sender_id)) AND msg.seq>GREATEST(st.read_seq,st.clear_seq,m.visible_from_seq-1) AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions del WHERE del.message_id=msg.id AND del.user_id=$1) AND NOT EXISTS(SELECT 1 FROM pulse.push_deliveries pd WHERE pd.message_id=$3 AND pd.device_id=d.id AND pd.status IN('sent','expired','rejected')) LIMIT 8`, uid, cid, mid)
		if e != nil {
			return true, e
		}
		list := []PushDevice{}
		for devices.Next() {
			var d PushDevice
			if e = devices.Scan(&d.ID, &d.UserID, &d.Platform, &d.Token, &d.Environment, &d.Preview); e != nil {
				devices.Close()
				return true, e
			}
			list = append(list, d)
		}
		e = devices.Err()
		devices.Close()
		if e != nil {
			return true, e
		}
		for _, d := range list {
			summary := "你有一条新消息"
			if d.Preview && kind == "text" {
				runes := []rune(body)
				summary = string(runes[:min(len(runes), 120)])
			}
			e = s.Push.Send(ctx, d, mid, cid, "新消息", summary)
			status, code := "sent", ""
			if e != nil {
				status = "failed"
				code = "push_failed"
				var fault *Fault
				if errors.As(e, &fault) {
					code = fault.Code
					if fault.Status == 410 {
						status = "expired"
					}
					if fault.Status == 502 {
						status = "rejected"
					}
					if fault.Status == 410 {
						_, _ = s.Store.Pool.Exec(ctx, "UPDATE pulse.push_devices SET enabled=false WHERE id=$1", d.ID)
					}
				}
			}
			_, recordErr := s.Store.Pool.Exec(ctx, "INSERT INTO pulse.push_deliveries(message_id,device_id,status,error_code) VALUES($1,$2,$3,$4) ON CONFLICT(message_id,device_id) DO UPDATE SET status=$3,error_code=$4,updated_at=now()", mid, d.ID, status, code)
			if recordErr != nil {
				return true, recordErr
			}
			var fault *Fault
			if e != nil && !(errors.As(e, &fault) && (fault.Status == 410 || fault.Status == 502)) {
				_, _ = s.Store.Pool.Exec(ctx, "UPDATE pulse.push_jobs SET available_at=now()+make_interval(secs=>LEAST(3600,30*attempts)),lease_until=NULL,lease_token=NULL,last_error=$3 WHERE message_id=$1 AND lease_token=$2", mid, lease, code)
				return true, e
			}
		}
		if _, e = s.Store.Pool.Exec(ctx, "UPDATE pulse.push_jobs SET cursor_user=$3,lease_until=now()+interval '30 seconds' WHERE message_id=$1 AND lease_token=$2", mid, lease, uid); e != nil {
			return true, e
		}
	}
	if len(users) < 25 {
		_, e = s.Store.Pool.Exec(ctx, "DELETE FROM pulse.push_jobs WHERE message_id=$1 AND lease_token=$2", mid, lease)
	} else {
		_, e = s.Store.Pool.Exec(ctx, "UPDATE pulse.push_jobs SET lease_until=NULL,lease_token=NULL,attempts=0,available_at=now() WHERE message_id=$1 AND lease_token=$2", mid, lease)
	}
	return true, e
}
func (s *Service) RunPushWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		pass, cancel := context.WithTimeout(ctx, 20*time.Second)
		_ = s.ObserveWorker(pass, "push", func(c context.Context) error { _, e := s.ProcessPushOnce(c); return e })
		cancel()
	}
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
			Platform    string `json:"platform"`
			Token       string `json:"token"`
			Environment string `json:"environment"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if (in.Platform != "android" && in.Platform != "ios") || !validText(in.Token, 16, 4096) {
			return ErrInvalid
		}
		if in.Environment == "" {
			in.Environment = "production"
		}
		if in.Environment != "production" && in.Environment != "sandbox" {
			return ErrInvalid
		}
		if in.Platform == "ios" {
			b, e := hex.DecodeString(in.Token)
			if e != nil || len(b) != 32 {
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
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.push_devices SET enabled=false WHERE token_hash=$1 AND session_id<>$2", digest(in.Token), who.SessionID); e != nil {
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
		_, e = tx.Exec(r.Context(), `INSERT INTO pulse.push_devices(id,user_id,session_id,platform,token,token_hash,environment) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(token_hash) DO UPDATE SET user_id=$2,session_id=$3,platform=$4,token=$5,environment=$7,enabled=true,updated_at=now()`, newID(), who.UserID, who.SessionID, in.Platform, in.Token, digest(in.Token), in.Environment)
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
