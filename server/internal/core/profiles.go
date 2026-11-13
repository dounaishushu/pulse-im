package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var profileAccountPattern = regexp.MustCompile(`^[a-z0-9_]{2,32}$`)

type Profile struct {
	ContactVersion    int64      `json:"contact_version,string"`
	ID                string     `json:"id"`
	Account           string     `json:"account"`
	PublicID          string     `json:"public_id"`
	Nickname          string     `json:"nickname"`
	AvatarID          string     `json:"avatar_id"`
	Birthday          string     `json:"birthday"`
	Gender            string     `json:"gender"`
	Bio               string     `json:"bio"`
	Phone             *string    `json:"phone,omitempty"`
	LastSeen          *time.Time `json:"last_seen,omitempty"`
	Online            bool       `json:"online"`
	InternalStaff     bool       `json:"internal_staff"`
	FormalEmployee    bool       `json:"formal_employee,omitempty"`
	IsContact         bool       `json:"is_contact"`
	Remark            string     `json:"remark"`
	GroupName         string     `json:"group_name"`
	Version           int64      `json:"version,string"`
	CanChangeAccount  bool       `json:"can_change_account"`
	CanChangeBirthday bool       `json:"can_change_birthday"`
	InactivityDays    int        `json:"inactivity_days,omitempty"`
}

func profileVisible(ctx context.Context, tx pgx.Tx, viewer, target, scope string) (bool, error) {
	if viewer == target {
		return true, nil
	}
	var allowed bool
	err := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE (b.user_id=$1 AND b.peer_id=$2) OR (b.user_id=$2 AND b.peer_id=$1)) AND
 COALESCE(e.effect,'')<>'deny' AND (COALESCE(e.effect,'')='allow' OR COALESCE(CASE WHEN $3='phone' THEN p.phone ELSE p.last_seen END,CASE WHEN $3='phone' THEN 'nobody' ELSE 'everyone' END)='everyone' OR
 (COALESCE(CASE WHEN $3='phone' THEN p.phone ELSE p.last_seen END,'')='contacts' AND EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid))))
 FROM pulse.users u LEFT JOIN pulse.privacy_settings p ON p.user_id=u.id LEFT JOIN pulse.privacy_exceptions e ON e.user_id=u.id AND e.peer_id=$1 AND e.scope=$3 WHERE u.id=$2 AND u.active`, viewer, target, scope).Scan(&allowed)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return allowed, err
}
func (s *Service) Profile(ctx context.Context, who Identity, id, cid string) (Profile, error) {
	if !validID(id) || (cid != "" && !validID(cid)) {
		return Profile{}, ErrInvalid
	}
	return s.profileWithAccess(ctx, who, id, cid, true)
}
func (s *Service) profile(ctx context.Context, who Identity, id string) (Profile, error) {
	return s.profileWithAccess(ctx, who, id, "", false)
}
func (s *Service) profileWithAccess(ctx context.Context, who Identity, id, cid string, restricted bool) (Profile, error) {
	var out Profile
	tx, err := s.Store.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return out, err
	}
	if restricted {
		if cid != "" {
			a, e := authorize(ctx, tx, who, cid, false)
			if e != nil {
				return out, e
			}
			var member bool
			e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.members m JOIN pulse.conversations c ON c.id=m.conversation_id AND c.active WHERE m.conversation_id=$1 AND m.user_id=$2 AND m.active AND(NOT c.block_member_friend_requests OR $3))`, cid, id, a.Role == "owner" || a.Role == "admin").Scan(&member)
			if e != nil {
				return out, e
			}
			if !member {
				return out, ErrForbidden
			}
		} else if id != who.UserID {
			var relationship bool
			e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)) OR EXISTS(SELECT 1 FROM pulse.members a JOIN pulse.members b USING(conversation_id) JOIN pulse.conversations c ON c.id=a.conversation_id WHERE a.user_id=$1 AND b.user_id=$2 AND a.active AND b.active AND c.active AND c.kind='direct')`, who.UserID, id).Scan(&relationship)
			if e != nil {
				return out, e
			}
			if !relationship {
				return out, ErrForbidden
			}
		}
	}
	var seen time.Time
	var phone string
	var changes, birthdayChanges int
	err = tx.QueryRow(ctx, `SELECT u.id::text,CASE WHEN u.account_is_internal THEN '' ELSE u.account END,COALESCE(u.legacy_public_id,u.public_id),COALESCE(NULLIF(u.nickname,''),CASE WHEN u.account_is_internal THEN '' ELSE u.account END),COALESCE(u.avatar_id::text,''),COALESCE(u.birthday::text,''),u.gender,u.bio,COALESCE(u.phone,''),u.last_active_at,u.internal_staff,u.formal_employee,u.profile_version,u.account_changes,u.birthday_change_count,u.inactivity_days,
 EXISTS(SELECT 1 FROM pulse.friendships f WHERE f.user_low=LEAST($1::uuid,$2::uuid) AND f.user_high=GREATEST($1::uuid,$2::uuid)),COALESCE(c.remark,''),COALESCE(c.group_name,''),COALESCE(c.version,0)
 FROM pulse.users u LEFT JOIN pulse.contact_metadata c ON c.user_id=$1 AND c.peer_id=u.id WHERE u.id=$2 AND u.active`, who.UserID, id).Scan(&out.ID, &out.Account, &out.PublicID, &out.Nickname, &out.AvatarID, &out.Birthday, &out.Gender, &out.Bio, &phone, &seen, &out.InternalStaff, &out.FormalEmployee, &out.Version, &changes, &birthdayChanges, &out.InactivityDays, &out.IsContact, &out.Remark, &out.GroupName, &out.ContactVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, ErrMissing
	}
	if err != nil {
		return out, err
	}
	for _, scope := range []string{"phone", "last_seen"} {
		allowed, e := profileVisible(ctx, tx, who.UserID, id, scope)
		if e != nil {
			return out, e
		}
		if allowed {
			if scope == "phone" {
				out.Phone = &phone
			} else {
				out.LastSeen = &seen
				out.Online = time.Since(seen) < 60*time.Second
			}
		}
	}
	out.CanChangeAccount = who.UserID == id && changes == 0
	out.CanChangeBirthday = who.UserID == id && birthdayChanges == 0
	if who.UserID != id {
		out.FormalEmployee = false
		out.InactivityDays = 0
	}
	return out, tx.Commit(ctx)
}

type ProfilePatch struct {
	Account         *string `json:"account"`
	Nickname        *string `json:"nickname"`
	Birthday        *string `json:"birthday"`
	Gender          *string `json:"gender"`
	Bio             *string `json:"bio"`
	InactivityDays  *int    `json:"inactivity_days"`
	ExpectedVersion int64   `json:"expected_version,string"`
}

func (s *Service) UpdateProfile(ctx context.Context, who Identity, in ProfilePatch) (Profile, error) {
	if in.Account == nil && in.Nickname == nil && in.Birthday == nil && in.Gender == nil && in.Bio == nil && in.InactivityDays == nil {
		return Profile{}, ErrInvalid
	}
	if in.ExpectedVersion < 1 {
		return Profile{}, ErrInvalid
	}
	if in.Nickname != nil && (!validText(*in.Nickname, 2, 32) || strings.TrimSpace(*in.Nickname) == "") {
		return Profile{}, ErrInvalid
	}
	if in.Bio != nil && !validText(*in.Bio, 0, 70) {
		return Profile{}, ErrInvalid
	}
	if in.Gender != nil && *in.Gender != "male" && *in.Gender != "female" && *in.Gender != "unspecified" {
		return Profile{}, ErrInvalid
	}
	if in.Account != nil {
		*in.Account = strings.ToLower(strings.TrimSpace(*in.Account))
		if !profileAccountPattern.MatchString(*in.Account) {
			return Profile{}, ErrInvalid
		}
	}
	if in.Birthday != nil && *in.Birthday != "" {
		d, e := time.Parse("2006-01-02", *in.Birthday)
		if e != nil || d.After(time.Now()) || d.Year() < 1000 {
			return Profile{}, ErrInvalid
		}
	}
	if in.InactivityDays != nil {
		switch *in.InactivityDays {
		case 0, 30, 90, 180, 365:
		default:
			return Profile{}, ErrInvalid
		}
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return Profile{}, err
	}
	defer tx.Rollback(ctx)
	var version int64
	var changes, birthdayChanges int
	var account, birthday string
	if err = tx.QueryRow(ctx, "SELECT profile_version,account_changes,account,COALESCE(birthday::text,''),birthday_change_count FROM pulse.users WHERE id=$1 AND active FOR UPDATE", who.UserID).Scan(&version, &changes, &account, &birthday, &birthdayChanges); err != nil {
		return Profile{}, err
	}
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return Profile{}, err
	}
	if version != in.ExpectedVersion {
		return Profile{}, ErrConflict
	}
	if in.Account != nil && *in.Account != account {
		if changes >= 1 {
			return Profile{}, &Fault{409, "account_change_limit"}
		}
		changes++
	}
	if in.Birthday != nil && *in.Birthday != birthday && birthday != "" {
		if birthdayChanges >= 1 {
			return Profile{}, &Fault{409, "birthday_change_limit"}
		}
		birthdayChanges++
	}
	_, err = tx.Exec(ctx, `UPDATE pulse.users SET account=COALESCE($2,account),account_is_internal=CASE WHEN $2::text IS NULL THEN account_is_internal ELSE false END,nickname=COALESCE($3,nickname),birthday=CASE WHEN $4::text IS NULL THEN birthday ELSE NULLIF($4,'')::date END,gender=COALESCE($5,gender),bio=COALESCE($6,bio),inactivity_days=COALESCE($7,inactivity_days),account_changes=$8,birthday_change_count=$9,profile_version=profile_version+1 WHERE id=$1`, who.UserID, in.Account, in.Nickname, in.Birthday, in.Gender, in.Bio, in.InactivityDays, changes, birthdayChanges)
	if err != nil {
		return Profile{}, uniqueFault(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return Profile{}, err
	}
	return s.profile(ctx, who, who.UserID)
}
func (s *Service) ContactMetadata(ctx context.Context, who Identity, peer, remark, group string, version int64) error {
	if !validID(peer) || !validText(remark, 0, 64) || !validText(group, 0, 64) || version < 0 {
		return ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return err
	}
	if err = lockPair(ctx, tx, who.UserID, peer); err != nil {
		return err
	}
	var friend bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid))", who.UserID, peer).Scan(&friend); err != nil {
		return err
	}
	if !friend {
		return ErrForbidden
	}
	var old int64
	err = tx.QueryRow(ctx, "SELECT version FROM pulse.contact_metadata WHERE user_id=$1 AND peer_id=$2", who.UserID, peer).Scan(&old)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if old != version {
		return ErrConflict
	}
	_, err = tx.Exec(ctx, `INSERT INTO pulse.contact_metadata(user_id,peer_id,remark,group_name) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,peer_id) DO UPDATE SET remark=$3,group_name=$4,version=pulse.contact_metadata.version+1`, who.UserID, peer, remark, group)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (a *API) registerProfiles(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("PATCH /api/v2/me/profile", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in ProfilePatch
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := s.UpdateProfile(r.Context(), who, in)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/profiles/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		v, e := s.Profile(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("conversation_id"))
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/public-users/legacy/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		number, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || number < 1 {
			return ErrInvalid
		}
		if err = s.Cache.Allow(r.Context(), "legacy-user-lookup", who.UserID, 30, time.Minute); err != nil {
			return err
		}
		var id string
		err = s.Store.Pool.QueryRow(r.Context(), `SELECT u.id::text FROM pulse.legacy_ids l JOIN pulse.users u ON u.id=l.new_id AND u.active WHERE l.entity='user' AND l.legacy_id=$1 AND NOT EXISTS(SELECT 1 FROM pulse.blocks b WHERE(b.user_id=$2 AND b.peer_id=u.id)OR(b.user_id=u.id AND b.peer_id=$2))`, number, who.UserID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMissing
		}
		if err != nil {
			return err
		}
		profile, err := s.profile(r.Context(), who, id)
		if err == nil {
			writeJSON(w, 200, profile)
		}
		return err
	}))
	mux.HandleFunc("GET /api/v2/public-users/{public}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		pid := r.PathValue("public")
		if !(len(pid) == 32 && strings.ToUpper(pid) == pid) && !validLegacyPublicID(pid) {
			return ErrInvalid
		}
		var id string
		e := s.Store.Pool.QueryRow(r.Context(), `SELECT id::text FROM pulse.users WHERE (public_id=$1 OR legacy_public_id=$1) AND active AND NOT EXISTS(SELECT 1 FROM pulse.blocks WHERE(user_id=$2 AND peer_id=pulse.users.id)OR(user_id=pulse.users.id AND peer_id=$2))`, pid, who.UserID).Scan(&id)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e != nil {
			return e
		}
		v, e := s.profile(r.Context(), who, id)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/friends/{id}/metadata", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Remark  string `json:"remark"`
			Group   string `json:"group_name"`
			Version int64  `json:"expected_version,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if e := s.ContactMetadata(r.Context(), who, r.PathValue("id"), in.Remark, in.Group, in.Version); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"version": strconv.FormatInt(in.Version+1, 10)})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/profiles/{id}/common-groups", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		peer := r.PathValue("id")
		if _, e := s.Profile(r.Context(), who, peer, r.URL.Query().Get("conversation_id")); e != nil {
			return e
		}
		after := r.URL.Query().Get("after")
		if after == "" {
			after = "00000000-0000-0000-0000-000000000000"
		}
		if !validID(after) {
			return ErrInvalid
		}
		page, size, e := clientPage(r)
		if e != nil {
			return e
		}
		rows, e := s.Store.Pool.Query(r.Context(), `SELECT c.id::text,c.title FROM pulse.members a JOIN pulse.members b USING(conversation_id) JOIN pulse.conversations c ON c.id=a.conversation_id WHERE a.user_id=$1 AND b.user_id=$2 AND a.active AND b.active AND c.active AND c.kind='group' AND c.id>$3 ORDER BY c.id LIMIT $4 OFFSET $5`, who.UserID, peer, after, size, (page-1)*size)
		if e != nil {
			return e
		}
		defer rows.Close()
		items := []map[string]string{}
		for rows.Next() {
			var id, title string
			if e = rows.Scan(&id, &title); e != nil {
				return e
			}
			items = append(items, map[string]string{"id": id, "title": title})
		}
		if e = rows.Err(); e != nil {
			return e
		}
		var total int
		if e = s.Store.Pool.QueryRow(r.Context(), `SELECT count(*) FROM pulse.members a JOIN pulse.members b USING(conversation_id) JOIN pulse.conversations c ON c.id=a.conversation_id WHERE a.user_id=$1 AND b.user_id=$2 AND a.active AND b.active AND c.active AND c.kind='group'`, who.UserID, peer).Scan(&total); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items, "page": page, "size": size, "total": total})
		return nil
	}))
}

func validLegacyPublicID(id string) bool {
	if len(id) != 16 {
		return false
	}
	upper, lower, digit := false, false, false
	for _, ch := range id {
		switch {
		case ch >= 'A' && ch <= 'Z':
			upper = true
		case ch >= 'a' && ch <= 'z':
			lower = true
		case ch >= '0' && ch <= '9':
			digit = true
		default:
			return false
		}
	}
	return upper && lower && digit
}
