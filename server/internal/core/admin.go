package core

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"
)

type AdminIdentity struct {
	ID          string   `json:"id"`
	Account     string   `json:"account"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Version     int64    `json:"version,string"`
	SessionID   string   `json:"-"`
	RequestID   string   `json:"-"`
	IP          string   `json:"-"`
}

func legacyAdminEntryMatches(secret, entry string, numericID int64, salt, hash string) bool {
	if len(secret) < 32 || len(secret) > 256 || len(entry) != 64 || numericID <= 0 || len(salt) != 64 || len(hash) != 64 {
		return false
	}
	key := hmac.New(sha256.New, []byte(secret))
	_, _ = key.Write([]byte("pulse-admin-entry-key-v1"))
	derived := hmac.New(sha256.New, key.Sum(nil))
	_, _ = derived.Write([]byte(fmt.Sprintf("account:%d:salt:%s", numericID, salt)))
	expected := hex.EncodeToString(derived.Sum(nil))
	actual := sha256.Sum256([]byte(expected))
	stored, e := hex.DecodeString(hash)
	if e != nil || len(stored) != sha256.Size {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(entry), []byte(expected)) == 1 && subtle.ConstantTimeCompare(stored, actual[:]) == 1
}

var adminModules = map[string]bool{"accounts": true, "users": true, "groups": true, "messages": true, "sensitive_words": true, "announcements": true, "tasks": true, "questions": true, "records": true, "dispatch": true, "config": true, "devices": true, "audit": true, "maintenance": true, "stats": true, "telegram": true}

func adminPermission(role string, permissions []string, module string, manage bool) bool {
	if role == "superadmin" {
		return true
	}
	if manage && role == "auditor" {
		return false
	}
	verb := "view"
	if manage {
		verb = "manage"
	}
	for _, p := range permissions {
		if p == module+"."+verb || (!manage && p == module+".manage") {
			return true
		}
	}
	return false
}
func validPermissions(permissions []string) bool {
	if len(permissions) > len(adminModules)*2 {
		return false
	}
	seen := map[string]bool{}
	for _, p := range permissions {
		parts := strings.Split(p, ".")
		if len(parts) != 2 || !adminModules[parts[0]] || (parts[1] != "view" && parts[1] != "manage") || seen[p] {
			return false
		}
		seen[p] = true
	}
	return true
}
func (s *Service) BootstrapAdmin(ctx context.Context, account, password string) (string, string, error) {
	if !validText(account, 3, 64) {
		return "", "", ErrInvalid
	}
	hash, e := hashPassword(password)
	if e != nil {
		return "", "", e
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return "", "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7153001)"); e != nil {
		return "", "", e
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.admin_accounts").Scan(&count); e != nil {
		return "", "", e
	}
	if count != 0 {
		return "", "", &Fault{409, "admin_already_bootstrapped"}
	}
	id, entry := newID(), opaqueToken()
	_, e = tx.Exec(ctx, "INSERT INTO pulse.admin_accounts(id,account,password_hash,role,entry_hash) VALUES($1,$2,$3,'superadmin',$4)", id, strings.ToLower(account), hash, digest(entry))
	if e != nil {
		return "", "", uniqueFault(e)
	}
	if e = tx.Commit(ctx); e != nil {
		return "", "", e
	}
	return id, entry, nil
}
func lockAdmin(ctx context.Context, tx pgx.Tx, who AdminIdentity, module string, manage bool) error {
	var role string
	var permissions []string
	e := tx.QueryRow(ctx, "SELECT role,permissions FROM pulse.admin_accounts WHERE id=$1 AND active FOR SHARE", who.ID).Scan(&role, &permissions)
	if errors.Is(e, pgx.ErrNoRows) {
		return ErrUnauthorized
	}
	if e != nil {
		return e
	}
	if !adminPermission(role, permissions, module, manage) {
		return ErrForbidden
	}
	if who.SessionID != "" {
		var sid string
		e = tx.QueryRow(ctx, "SELECT id::text FROM pulse.admin_sessions WHERE id=$1 AND admin_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE", who.SessionID, who.ID).Scan(&sid)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrUnauthorized
		}
	}
	return e
}
func auditTx(ctx context.Context, tx pgx.Tx, who AdminIdentity, action, kind, id string, details any) error {
	raw, e := json.Marshal(details)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "INSERT INTO pulse.admin_audit(admin_id,action,target_type,target_id,request_id,ip,details) VALUES($1,$2,$3,$4,$5,$6,$7)", optionalUUID(who.ID), action, kind, id, who.RequestID, nullableIP(who.IP), raw)
	return e
}
func (a *API) secureAdmin(r *http.Request) bool {
	ip, e := netip.ParseAddr(a.clientIP(r))
	if e != nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	if r.TLS != nil {
		return true
	}
	host, _, e := net.SplitHostPort(r.RemoteAddr)
	if e != nil {
		return false
	}
	peer, e := netip.ParseAddr(host)
	if e != nil {
		return false
	}
	for _, prefix := range a.Options.TrustedProxies {
		if prefix.Contains(peer) && r.Header.Get("X-Forwarded-Proto") == "https" {
			return true
		}
	}
	return false
}

type adminEndpoint func(http.ResponseWriter, *http.Request, AdminIdentity) error

func (a *API) adminWrap(module string, manage bool, fn adminEndpoint) http.HandlerFunc {
	return a.wrapTimed(false, 150*time.Second, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		if !a.secureAdmin(r) {
			return &Fault{403, "https_required"}
		}
		allowed, accessErr := a.adminRequestAllowed(r)
		if accessErr != nil {
			return accessErr
		}
		if !allowed {
			return &Fault{403, "admin_ip_denied"}
		}
		cookie, e := r.Cookie("pulse_admin")
		if e != nil || len(cookie.Value) != 64 {
			return ErrUnauthorized
		}
		entry := adminRequestEntry(r, "")
		if len(entry) != 64 {
			return ErrUnauthorized
		}
		var who AdminIdentity
		var csrf []byte
		var oldID *int64
		var oldSalt, oldHash *string
		var currentHash []byte
		e = a.Service.Store.Pool.QueryRow(r.Context(), `SELECT a.id::text,a.account,a.role,a.permissions,a.version,s.id::text,s.csrf_hash,
 a.entry_hash,a.legacy_numeric_id,a.legacy_entry_salt,a.legacy_entry_hash
 FROM pulse.admin_accounts a JOIN pulse.admin_sessions s ON s.admin_id=a.id
 WHERE s.token_hash=$1 AND a.active AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, digest(cookie.Value)).Scan(&who.ID, &who.Account, &who.Role, &who.Permissions, &who.Version, &who.SessionID, &csrf, &currentHash, &oldID, &oldSalt, &oldHash)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrUnauthorized
		}
		if e != nil {
			return e
		}
		entryValid := subtle.ConstantTimeCompare(currentHash, digest(entry)) == 1
		if !entryValid && oldID != nil && oldSalt != nil && oldHash != nil {
			entryValid = legacyAdminEntryMatches(os.Getenv("PULSE_LEGACY_ADMIN_ENTRY_SECRET"), entry, *oldID, *oldSalt, *oldHash)
		}
		if !entryValid {
			return ErrUnauthorized
		}
		if module != "" && !adminPermission(who.Role, who.Permissions, module, manage) {
			return ErrForbidden
		}
		if r.Method != "GET" && r.Method != "HEAD" {
			if subtle.ConstantTimeCompare(csrf, digest(r.Header.Get("X-CSRF-Token"))) != 1 {
				return &Fault{403, "csrf_invalid"}
			}
		}
		if e = a.Service.Cache.Allow(r.Context(), "admin-api", who.ID, 600, time.Minute); e != nil {
			return e
		}
		who.IP = a.clientIP(r)
		who.RequestID = w.Header().Get("X-Request-ID")
		return fn(w, r, who)
	})
}

type AdminAccountInput struct {
	Account     string   `json:"account"`
	Password    string   `json:"password"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
	Active      bool     `json:"active"`
	Expected    int64    `json:"expected_version,string"`
}

func (s *Service) SaveAdmin(ctx context.Context, who AdminIdentity, id string, in AdminAccountInput) (map[string]any, error) {
	return s.saveAdmin(ctx, who, id, in, 0)
}

func (s *Service) saveAdmin(ctx context.Context, who AdminIdentity, id string, in AdminAccountInput, telegramTarget int64) (map[string]any, error) {
	if !validText(in.Account, 3, 64) || !validPermissions(in.Permissions) || (in.Role != "superadmin" && in.Role != "operator" && in.Role != "auditor") || (id != "" && !validID(id)) {
		return nil, ErrInvalid
	}
	if in.Role == "auditor" {
		for _, p := range in.Permissions {
			if strings.HasSuffix(p, ".manage") {
				return nil, ErrInvalid
			}
		}
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return nil, ErrBusy
	}
	hash := ""
	var e error
	if in.Password != "" {
		hash, e = hashPassword(in.Password)
		if e != nil {
			return nil, e
		}
	}
	if id == "" && hash == "" {
		return nil, ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(7153001)"); e != nil {
		return nil, e
	}
	if e = lockAdmin(ctx, tx, who, "accounts", true); e != nil {
		return nil, e
	}
	var role string
	if e = tx.QueryRow(ctx, "SELECT role FROM pulse.admin_accounts WHERE id=$1", who.ID).Scan(&role); e != nil {
		return nil, e
	}
	if role != "superadmin" {
		return nil, ErrForbidden
	}
	entry := ""
	version := int64(1)
	if id == "" {
		id, entry = newID(), opaqueToken()
		_, e = tx.Exec(ctx, "INSERT INTO pulse.admin_accounts(id,account,password_hash,role,permissions,active,entry_hash) VALUES($1,$2,$3,$4,$5,$6,$7)", id, strings.ToLower(in.Account), hash, in.Role, in.Permissions, in.Active, digest(entry))
	} else {
		var oldRole string
		var oldActive bool
		var oldVersion int64
		e = tx.QueryRow(ctx, "SELECT role,active,version FROM pulse.admin_accounts WHERE id=$1 FOR UPDATE", id).Scan(&oldRole, &oldActive, &oldVersion)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, ErrMissing
		}
		if e != nil {
			return nil, e
		}
		if oldVersion != in.Expected {
			return nil, ErrConflict
		}
		if id == who.ID && (!in.Active || in.Role != oldRole) {
			return nil, ErrForbidden
		}
		if oldRole == "superadmin" && oldActive && (!in.Active || in.Role != "superadmin") {
			var count int
			if e = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.admin_accounts WHERE active AND role='superadmin'").Scan(&count); e != nil {
				return nil, e
			}
			if count <= 1 {
				return nil, &Fault{409, "last_superadmin"}
			}
		}
		e = tx.QueryRow(ctx, `UPDATE pulse.admin_accounts SET account=$2,password_hash=COALESCE(NULLIF($3,''),password_hash),role=$4,permissions=$5,active=$6,version=version+1,updated_at=now() WHERE id=$1 RETURNING version`, id, strings.ToLower(in.Account), hash, in.Role, in.Permissions, in.Active).Scan(&version)
		if e == nil {
			_, e = tx.Exec(ctx, "UPDATE pulse.admin_sessions SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL", id)
		}
	}
	if e != nil {
		return nil, uniqueFault(e)
	}
	if telegramTarget > 0 {
		_, e = tx.Exec(ctx, `INSERT INTO pulse.telegram_grants(telegram_user_id,admin_id,admin_ids,permissions)
 VALUES($1,$2,ARRAY[$2::uuid],ARRAY['entry.self'])
 ON CONFLICT(telegram_user_id) DO UPDATE SET
 admin_ids=CASE WHEN $2::uuid=ANY(pulse.telegram_grants.admin_ids) THEN pulse.telegram_grants.admin_ids ELSE pulse.telegram_grants.admin_ids||$2::uuid END,
 permissions=CASE WHEN 'entry.self'=ANY(pulse.telegram_grants.permissions) THEN pulse.telegram_grants.permissions ELSE pulse.telegram_grants.permissions||ARRAY['entry.self'] END,
 active=true`, telegramTarget, id)
		if e != nil {
			return nil, e
		}
		if e = auditTx(ctx, tx, who, "telegram.account.link", "admin", id, map[string]any{"telegram_user_id": telegramTarget}); e != nil {
			return nil, e
		}
	}
	if e = auditTx(ctx, tx, who, "account.save", "admin", id, map[string]any{"role": in.Role, "permissions": in.Permissions, "active": in.Active}); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"id": id, "entry_token": entry, "version": version}, nil
}
func (a *API) registerAdmin(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/admin/auth/login", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		if !a.secureAdmin(r) {
			return &Fault{403, "https_required"}
		}
		allowed, accessErr := a.adminRequestAllowed(r)
		if accessErr != nil {
			return accessErr
		}
		if !allowed {
			return &Fault{403, "admin_ip_denied"}
		}
		var in struct {
			Account  string `json:"account"`
			Password string `json:"password"`
			Entry    string `json:"entry_token"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		in.Entry = adminRequestEntry(r, in.Entry)
		if in.Entry == "" {
			return &Fault{401, "admin_entry_required"}
		}
		if !validText(in.Account, 3, 64) || len(in.Password) > 256 || len(in.Entry) != 64 {
			return ErrUnauthorized
		}
		if e := s.Cache.Allow(r.Context(), "admin-login-ip", a.clientIP(r), 20, time.Minute); e != nil {
			return e
		}
		if e := s.Cache.Allow(r.Context(), "admin-login", strings.ToLower(in.Account), 10, time.Minute); e != nil {
			return e
		}
		select {
		case s.passwordSlots <- struct{}{}:
			defer func() { <-s.passwordSlots }()
		default:
			return ErrBusy
		}
		var who AdminIdentity
		var hash string
		var oldID *int64
		var oldSalt, oldHash *string
		e := s.Store.Pool.QueryRow(r.Context(), `SELECT id::text,account,password_hash,role,permissions,version,
 legacy_numeric_id,legacy_entry_salt,legacy_entry_hash FROM pulse.admin_accounts
 WHERE account=$1 AND active`, strings.ToLower(in.Account)).Scan(&who.ID, &who.Account, &hash, &who.Role, &who.Permissions, &who.Version, &oldID, &oldSalt, &oldHash)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		entryValid := false
		if who.ID != "" {
			var currentHash []byte
			if e = s.Store.Pool.QueryRow(r.Context(), "SELECT entry_hash FROM pulse.admin_accounts WHERE id=$1", who.ID).Scan(&currentHash); e != nil {
				return e
			}
			entryValid = subtle.ConstantTimeCompare(currentHash, digest(in.Entry)) == 1
			if !entryValid && oldID != nil && oldSalt != nil && oldHash != nil {
				entryValid = legacyAdminEntryMatches(os.Getenv("PULSE_LEGACY_ADMIN_ENTRY_SECRET"), in.Entry, *oldID, *oldSalt, *oldHash)
			}
		}
		if hash == "" {
			hash = s.dummyHash
		}
		if !verifyPassword(in.Password, hash) || who.ID == "" || !entryValid {
			return ErrUnauthorized
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		var current int64
		var lockedHash []byte
		var lockedOldID *int64
		var lockedSalt, lockedOldHash *string
		e = tx.QueryRow(r.Context(), `SELECT version,entry_hash,legacy_numeric_id,legacy_entry_salt,legacy_entry_hash
 FROM pulse.admin_accounts WHERE id=$1 AND active FOR UPDATE`, who.ID).Scan(&current, &lockedHash, &lockedOldID, &lockedSalt, &lockedOldHash)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrUnauthorized
		}
		if e != nil {
			return e
		}
		lockedEntryValid := subtle.ConstantTimeCompare(lockedHash, digest(in.Entry)) == 1
		if !lockedEntryValid && lockedOldID != nil && lockedSalt != nil && lockedOldHash != nil {
			lockedEntryValid = legacyAdminEntryMatches(os.Getenv("PULSE_LEGACY_ADMIN_ENTRY_SECRET"), in.Entry, *lockedOldID, *lockedSalt, *lockedOldHash)
		}
		if current != who.Version || !lockedEntryValid {
			return ErrUnauthorized
		}
		token, csrf := opaqueToken(), opaqueToken()
		if _, e = tx.Exec(r.Context(), `UPDATE pulse.admin_sessions SET revoked_at=now() WHERE id IN(SELECT id FROM pulse.admin_sessions WHERE admin_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC OFFSET 4)`, who.ID); e != nil {
			return e
		}
		if _, e = tx.Exec(r.Context(), "INSERT INTO pulse.admin_sessions(id,admin_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')", newID(), who.ID, digest(token), digest(csrf)); e != nil {
			return e
		}
		who.IP = a.clientIP(r)
		who.RequestID = w.Header().Get("X-Request-ID")
		if e = auditTx(r.Context(), tx, who, "login", "admin", who.ID, map[string]any{}); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
		http.SetCookie(w, &http.Cookie{Name: "pulse_admin", Value: token, Path: "/api/v2/admin", HttpOnly: true, Secure: secure, SameSite: http.SameSiteStrictMode, MaxAge: 8 * 3600})
		setAdminEntryCookie(w, r, in.Entry)
		writeJSON(w, 200, map[string]any{"user": who, "csrf_token": csrf})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/me", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		writeJSON(w, 200, who)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/admin/auth/logout", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if _, e := s.Store.Pool.Exec(r.Context(), "UPDATE pulse.admin_sessions SET revoked_at=now() WHERE id=$1", who.SessionID); e != nil {
			return e
		}
		http.SetCookie(w, &http.Cookie{Name: "pulse_admin", Path: "/api/v2/admin", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/admin/accounts", a.adminWrap("accounts", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		return adminRows(w, r, s, `SELECT jsonb_build_object('id',id,'account',account,'role',role,'permissions',permissions,'active',active,'version',version::text,'created_at',created_at) FROM pulse.admin_accounts ORDER BY account LIMIT $1 OFFSET $2`)
	}))
	for _, path := range []string{"POST /api/v2/admin/accounts", "PUT /api/v2/admin/accounts/{id}"} {
		mux.HandleFunc(path, a.adminWrap("accounts", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in AdminAccountInput
			if e := decode(w, r, &in); e != nil {
				return e
			}
			v, e := s.SaveAdmin(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, v)
			}
			return e
		}))
	}
	mux.HandleFunc("POST /api/v2/admin/accounts/{id}/entry", a.adminWrap("accounts", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		id := r.PathValue("id")
		if !validID(id) || who.Role != "superadmin" {
			return ErrForbidden
		}
		entry := opaqueToken()
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if _, e = tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(7153001)"); e != nil {
			return e
		}
		if e = lockAdmin(r.Context(), tx, who, "accounts", true); e != nil {
			return e
		}
		cmd, e := tx.Exec(r.Context(), "UPDATE pulse.admin_accounts SET entry_hash=$2,legacy_entry_salt=NULL,legacy_entry_hash=NULL,version=version+1 WHERE id=$1", id, digest(entry))
		if e != nil {
			return e
		}
		if cmd.RowsAffected() == 0 {
			return ErrMissing
		}
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.admin_sessions SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL", id); e != nil {
			return e
		}
		if e = auditTx(r.Context(), tx, who, "entry.rotate", "admin", id, map[string]any{}); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e == nil {
			writeJSON(w, 200, map[string]string{"entry_token": entry})
		}
		return e
	}))
}
func adminRows(w http.ResponseWriter, r *http.Request, s *Service, query string, args ...any) error {
	page, size, e := clientPage(r)
	if e != nil {
		return e
	}
	params := append([]any{size, (page - 1) * size}, args...)
	rows, e := s.Store.Pool.Query(r.Context(), query, params...)
	if e != nil {
		return e
	}
	defer rows.Close()
	items := []json.RawMessage{}
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			return e
		}
		items = append(items, json.RawMessage(raw))
	}
	if e = rows.Err(); e != nil {
		return e
	}
	writeJSON(w, 200, map[string]any{"items": items, "page": page, "size": size, "has_more": len(items) == size})
	return nil
}
