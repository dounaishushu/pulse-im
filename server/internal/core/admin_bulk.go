package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var bulkPrefixPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,23}$`)

type BulkUser struct {
	Account  string `json:"account"`
	Nickname string `json:"nickname"`
	Password string `json:"password"`
}
type BulkUsersInput struct {
	RequestID string     `json:"request_id"`
	Users     []BulkUser `json:"users"`
	Prefix    string     `json:"prefix"`
	Start     int        `json:"start"`
	Count     int        `json:"count"`
	Password  string     `json:"password"`
}

func (s *Service) BulkCreateUsers(ctx context.Context, who AdminIdentity, in BulkUsersInput) ([]map[string]string, error) {
	if !requestPattern.MatchString(in.RequestID) {
		return nil, ErrInvalid
	}
	if len(in.Users) == 0 {
		in.Prefix = strings.TrimSpace(in.Prefix)
		if !bulkPrefixPattern.MatchString(in.Prefix) {
			return nil, &Fault{400, "bulk_prefix_invalid"}
		}
		if in.Count < 1 || in.Count > 100 {
			return nil, &Fault{400, "bulk_count_invalid"}
		}
		if in.Start < 1 || in.Start > 999999999 {
			return nil, &Fault{400, "bulk_start_invalid"}
		}
		if len(fmt.Sprintf("%s%d", in.Prefix, in.Start+in.Count-1)) > 32 {
			return nil, &Fault{400, "bulk_account_invalid"}
		}
		for i := 0; i < in.Count; i++ {
			account := fmt.Sprintf("%s%d", in.Prefix, in.Start+i)
			in.Users = append(in.Users, BulkUser{account, account, in.Password})
		}
	} else if in.Prefix != "" || in.Count != 0 {
		return nil, ErrInvalid
	}
	if len(in.Users) > 100 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	for i := range in.Users {
		u := &in.Users[i]
		u.Account = normalizeAccount(u.Account)
		if !validText(u.Account, 3, 64) || !validText(u.Nickname, 2, 32) {
			return nil, &Fault{400, "bulk_account_invalid"}
		}
		if len(u.Password) < 8 || len(u.Password) > 128 {
			return nil, &Fault{400, "bulk_password_invalid"}
		}
		if seen[u.Account] {
			return nil, &Fault{400, "bulk_account_duplicate"}
		}
		seen[u.Account] = true
	}
	payload, _ := json.Marshal(in.Users)
	fingerprint := digest(string(payload))
	var prior []byte
	var priorHash []byte
	e := s.Store.Pool.QueryRow(ctx, "SELECT result,request_hash FROM pulse.admin_create_requests WHERE admin_id=$1 AND request_id=$2", who.ID, in.RequestID).Scan(&prior, &priorHash)
	if e == nil {
		if !equalBytes(priorHash, fingerprint) {
			return nil, ErrConflict
		}
		var out []map[string]string
		e = json.Unmarshal(prior, &out)
		return out, e
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	accounts := make([]string, 0, len(in.Users))
	for _, u := range in.Users {
		accounts = append(accounts, u.Account)
	}
	var exists bool
	if e = s.Store.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.users WHERE account=ANY($1::text[]))", accounts).Scan(&exists); e != nil {
		return nil, e
	}
	if exists {
		// A concurrent identical request may have committed after the first
		// lookup. Account existence alone must not turn its retry into a conflict.
		var saved, savedHash []byte
		err := s.Store.Pool.QueryRow(ctx, "SELECT result,request_hash FROM pulse.admin_create_requests WHERE admin_id=$1 AND request_id=$2", who.ID, in.RequestID).Scan(&saved, &savedHash)
		if err == nil {
			if !equalBytes(savedHash, fingerprint) {
				return nil, ErrConflict
			}
			var out []map[string]string
			err = json.Unmarshal(saved, &out)
			return out, err
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, err
		}
		return nil, &Fault{409, "bulk_account_exists"}
	}
	select {
	case s.passwordSlots <- struct{}{}:
		defer func() { <-s.passwordSlots }()
	default:
		return nil, ErrBusy
	}
	hashes := make(map[string]string)
	for _, u := range in.Users {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		{
			hash, e := hashPassword(u.Password)
			if e != nil {
				return nil, e
			}
			hashes[u.Account] = hash
		}
	}
	result := []map[string]string{}
	e = s.adminWrite(ctx, who, "users", "user.bulk-create", "users", "", func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7156))", who.ID+":"+in.RequestID); e != nil {
			return e
		}
		var existing []byte
		var old []byte
		e := tx.QueryRow(ctx, "SELECT result,request_hash FROM pulse.admin_create_requests WHERE admin_id=$1 AND request_id=$2", who.ID, in.RequestID).Scan(&existing, &old)
		if e == nil {
			if !equalBytes(old, fingerprint) {
				return ErrConflict
			}
			return json.Unmarshal(existing, &result)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		for _, u := range in.Users {
			id := newID()
			if _, e = tx.Exec(ctx, "INSERT INTO pulse.users(id,account,nickname,password_hash) VALUES($1,$2,$3,$4)", id, u.Account, u.Nickname, hashes[u.Account]); e != nil {
				return e
			}
			result = append(result, map[string]string{"id": id, "account": u.Account})
		}
		raw, _ := json.Marshal(result)
		_, e = tx.Exec(ctx, "INSERT INTO pulse.admin_create_requests(admin_id,request_id,request_hash,result) VALUES($1,$2,$3,$4)", who.ID, in.RequestID, fingerprint, raw)
		return e
	})
	var pgerr *pgconn.PgError
	if errors.As(e, &pgerr) && pgerr.Code == "23505" {
		return nil, &Fault{409, "bulk_account_exists"}
	}
	return result, e
}
func (a *API) registerAdminBulk(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/admin/users/batch", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in BulkUsersInput
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(150 * time.Second))
		if e := decodeLimit(w, r, &in, 128<<10); e != nil {
			return e
		}
		v, e := a.Service.BulkCreateUsers(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 201, map[string]any{"items": v})
		}
		return e
	}))
}
