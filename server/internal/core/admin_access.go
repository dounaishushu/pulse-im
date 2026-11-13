package core

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"time"
)

type AdminIPRule struct {
	CIDR      string     `json:"cidr"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}
type AdminAccess struct {
	Enabled bool          `json:"enabled"`
	Version int64         `json:"version,string"`
	Rules   []AdminIPRule `json:"rules"`
}

func (s *Service) AdminIPAllowed(ctx context.Context, ip string) (bool, error) {
	address, e := netip.ParseAddr(ip)
	if e != nil {
		return false, ErrForbidden
	}
	var allowed bool
	e = s.Store.Pool.QueryRow(ctx, `SELECT NOT cfg.enabled OR EXISTS(SELECT 1 FROM pulse.admin_access_rules rule WHERE $1::inet <<= rule.network AND(rule.expires_at IS NULL OR rule.expires_at>now())) FROM pulse.admin_access_settings cfg WHERE id`, address.String()).Scan(&allowed)
	return allowed, e
}
func (s *Service) AdminAccess(ctx context.Context) (AdminAccess, error) {
	var out AdminAccess
	e := s.Store.Pool.QueryRow(ctx, "SELECT enabled,version FROM pulse.admin_access_settings WHERE id").Scan(&out.Enabled, &out.Version)
	if e != nil {
		return out, e
	}
	rows, e := s.Store.Pool.Query(ctx, "SELECT network::text,expires_at FROM pulse.admin_access_rules ORDER BY network LIMIT 32")
	if e != nil {
		return out, e
	}
	defer rows.Close()
	out.Rules = []AdminIPRule{}
	for rows.Next() {
		var rule AdminIPRule
		if e = rows.Scan(&rule.CIDR, &rule.ExpiresAt); e != nil {
			return out, e
		}
		out.Rules = append(out.Rules, rule)
	}
	return out, rows.Err()
}
func opsSignature(secret, method, path, timestamp, nonce string, body []byte) string {
	sum := sha256.Sum256(body)
	input := method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + hex.EncodeToString(sum[:])
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(input))
	return hex.EncodeToString(mac.Sum(nil))
}
func (a *API) verifyAdminOps(r *http.Request, tx pgx.Tx, body []byte) error {
	if len(a.Options.AdminOpsSecret) < 32 {
		return &Fault{503, "admin_ops_secret_unconfigured"}
	}
	stamp := r.Header.Get("X-Ops-Time")
	nonce := r.Header.Get("X-Ops-Nonce")
	signature := r.Header.Get("X-Ops-Signature")
	when, e := strconv.ParseInt(stamp, 10, 64)
	if e != nil || time.Since(time.Unix(when, 0)) > 2*time.Minute || time.Until(time.Unix(when, 0)) > 2*time.Minute || len(nonce) < 16 || len(nonce) > 64 || len(signature) != 64 {
		return ErrForbidden
	}
	expected := opsSignature(a.Options.AdminOpsSecret, r.Method, r.URL.Path, stamp, nonce, body)
	if !hmac.Equal([]byte(signature), []byte(expected)) {
		return ErrForbidden
	}
	_, e = tx.Exec(r.Context(), "DELETE FROM pulse.admin_ops_nonces WHERE created_at<now()-interval '10 minutes'")
	if e != nil {
		return e
	}
	_, e = tx.Exec(r.Context(), "INSERT INTO pulse.admin_ops_nonces(nonce) VALUES($1)", nonce)
	if e != nil {
		return &Fault{409, "operation_replayed"}
	}
	return nil
}
func (a *API) registerAdminAccess(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/security/ip-rules", a.adminWrap("accounts", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if who.Role != "superadmin" {
			return ErrForbidden
		}
		v, e := s.AdminAccess(r.Context())
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/admin/security/ip-rules", a.adminWrap("accounts", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if who.Role != "superadmin" {
			return ErrForbidden
		}
		r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
		raw, e := io.ReadAll(r.Body)
		if e != nil {
			return ErrInvalid
		}
		var input AdminAccess
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if e = decoder.Decode(&input); e != nil {
			return ErrInvalid
		}
		var extra any
		if e = decoder.Decode(&extra); !errors.Is(e, io.EOF) {
			return ErrInvalid
		}
		if len(input.Rules) > 32 || (input.Enabled && len(input.Rules) == 0) {
			return ErrInvalid
		}
		seen := map[string]bool{}
		for i := range input.Rules {
			rule := &input.Rules[i]
			prefix, e := netip.ParsePrefix(rule.CIDR)
			if e != nil || !prefix.Addr().IsValid() || !prefix.IsValid() {
				return ErrInvalid
			}
			rule.CIDR = prefix.Masked().String()
			if seen[rule.CIDR] {
				return ErrInvalid
			}
			seen[rule.CIDR] = true
			if rule.ExpiresAt != nil && rule.ExpiresAt.Before(time.Now()) {
				return ErrInvalid
			}
		}
		clientIP, e := netip.ParseAddr(a.clientIP(r))
		if e != nil {
			return ErrForbidden
		}
		if input.Enabled {
			present := false
			for _, rule := range input.Rules {
				prefix, _ := netip.ParsePrefix(rule.CIDR)
				if prefix.Contains(clientIP) && (rule.ExpiresAt == nil || rule.ExpiresAt.After(time.Now())) {
					present = true
					break
				}
			}
			if !present {
				return &Fault{409, "current_ip_not_allowed"}
			}
		}
		tx, e := s.Store.Pool.Begin(r.Context())
		if e != nil {
			return e
		}
		defer tx.Rollback(r.Context())
		if e = lockAdmin(r.Context(), tx, who, "accounts", true); e != nil {
			return e
		}
		if e = a.verifyAdminOps(r, tx, raw); e != nil {
			return e
		}
		var current int64
		if e = tx.QueryRow(r.Context(), "SELECT version FROM pulse.admin_access_settings WHERE id FOR UPDATE").Scan(&current); e != nil {
			return e
		}
		if current != input.Version {
			return ErrConflict
		}
		if _, e = tx.Exec(r.Context(), "DELETE FROM pulse.admin_access_rules"); e != nil {
			return e
		}
		for _, rule := range input.Rules {
			if _, e = tx.Exec(r.Context(), "INSERT INTO pulse.admin_access_rules(network,expires_at) VALUES($1,$2)", rule.CIDR, rule.ExpiresAt); e != nil {
				return e
			}
		}
		if _, e = tx.Exec(r.Context(), "UPDATE pulse.admin_access_settings SET enabled=$1,version=version+1 WHERE id", input.Enabled); e != nil {
			return e
		}
		if e = auditTx(r.Context(), tx, who, "access.update", "admin", "", map[string]any{"enabled": input.Enabled, "rules": len(input.Rules)}); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		v, e := s.AdminAccess(r.Context())
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
}

func (a *API) adminRequestAllowed(r *http.Request) (bool, error) {
	var enabled bool
	if e := a.Service.Store.Pool.QueryRow(r.Context(), "SELECT enabled FROM pulse.admin_access_settings WHERE id").Scan(&enabled); e != nil {
		return false, e
	}
	if enabled {
		host, _, e := net.SplitHostPort(r.RemoteAddr)
		if e != nil {
			return false, ErrForbidden
		}
		peer, e := netip.ParseAddr(host)
		if e != nil {
			return false, ErrForbidden
		}
		if peer.IsLoopback() {
			trusted := false
			for _, prefix := range a.Options.TrustedProxies {
				if prefix.Contains(peer) {
					trusted = true
					break
				}
			}
			address, e := netip.ParseAddr(r.Header.Get("X-Real-IP"))
			if !trusted || e != nil || !address.IsValid() {
				return false, ErrForbidden
			}
		}
	}
	return a.Service.AdminIPAllowed(r.Context(), a.clientIP(r))
}
