package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"net/http"
)

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
		if in.Count < 1 || in.Count > 100 || in.Start < 0 || in.Start > 999999 {
			return nil, ErrInvalid
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
		if !validText(u.Account, 3, 64) || !validText(u.Nickname, 2, 32) || len(u.Password) < 10 || len(u.Password) > 256 || seen[u.Account] {
			return nil, ErrInvalid
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
	return result, e
}
func (a *API) registerAdminBulk(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/v2/admin/users/batch", a.adminWrap("users", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in BulkUsersInput
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
