package core

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"strconv"
	"strings"
)

type ConversationPreferences struct {
	Pinned   bool   `json:"pinned"`
	Muted    bool   `json:"muted_notifications"`
	Archived bool   `json:"archived"`
	Hidden   bool   `json:"hidden"`
	FolderID string `json:"folder_id"`
	Version  int64  `json:"preference_version,string"`
}
type PreferencePatch struct {
	Pinned   *bool   `json:"pinned"`
	Muted    *bool   `json:"muted_notifications"`
	Archived *bool   `json:"archived"`
	Hidden   *bool   `json:"hidden"`
	FolderID *string `json:"folder_id"`
	Expected int64   `json:"expected_version,string"`
}

func (s *Service) Saved(ctx context.Context, who Identity) (string, error) {
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7152))", who.UserID); e != nil {
		return "", e
	}
	var id string
	e = tx.QueryRow(ctx, "SELECT conversation_id::text FROM pulse.saved_conversations WHERE user_id=$1", who.UserID).Scan(&id)
	if e == nil {
		return id, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	id = newID()
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.conversations(id,kind,title) VALUES($1,'saved','我的收藏')", id); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.members(conversation_id,user_id,role,history_allowed) VALUES($1,$2,'owner',true)", id, who.UserID); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.user_states(conversation_id,user_id) VALUES($1,$2)", id, who.UserID); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.saved_conversations(user_id,conversation_id) VALUES($1,$2)", who.UserID, id); e != nil {
		return "", e
	}
	if e = membershipHint(ctx, tx, id, who.UserID); e != nil {
		return "", e
	}
	if e = tx.Commit(ctx); e == nil {
		s.notify()
	}
	return id, e
}
func (s *Service) SetPreferences(ctx context.Context, who Identity, cid string, in PreferencePatch) (ConversationPreferences, error) {
	var out ConversationPreferences
	if !validID(cid) || in.Expected < 1 || (in.FolderID != nil && *in.FolderID != "" && !validID(*in.FolderID)) {
		return out, ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return out, e
	}
	a, e := authorize(ctx, tx, who, cid, false)
	if e != nil {
		return out, e
	}
	if a.Kind == "saved" && in.Archived != nil && *in.Archived {
		return out, ErrForbidden
	}
	if in.FolderID != nil && *in.FolderID != "" {
		var scope string
		e = tx.QueryRow(ctx, "SELECT scope FROM pulse.conversation_folders WHERE id=$1 AND user_id=$2 FOR SHARE", *in.FolderID, who.UserID).Scan(&scope)
		if errors.Is(e, pgx.ErrNoRows) {
			return out, ErrForbidden
		}
		if e != nil {
			return out, e
		}
		if scope != a.Kind {
			return out, ErrInvalid
		}
	}
	e = tx.QueryRow(ctx, `UPDATE pulse.user_states SET pinned=COALESCE($3,pinned),muted_notifications=COALESCE($4,muted_notifications),archived=COALESCE($5,archived),hidden=COALESCE($6,hidden),folder_id=CASE WHEN $7::text IS NULL THEN folder_id ELSE NULLIF($7,'')::uuid END,preference_version=preference_version+1
 WHERE conversation_id=$1 AND user_id=$2 AND preference_version=$8 RETURNING pinned,muted_notifications,archived,hidden,COALESCE(folder_id::text,''),preference_version`, cid, who.UserID, in.Pinned, in.Muted, in.Archived, in.Hidden, in.FolderID, in.Expected).Scan(&out.Pinned, &out.Muted, &out.Archived, &out.Hidden, &out.FolderID, &out.Version)
	if errors.Is(e, pgx.ErrNoRows) {
		return out, ErrConflict
	}
	if e != nil {
		return out, e
	}
	if e = membershipHint(ctx, tx, cid, who.UserID); e != nil {
		return out, e
	}
	if e = tx.Commit(ctx); e == nil {
		s.notify()
	}
	return out, e
}

type Folder struct {
	ID              string   `json:"id"`
	Scope           string   `json:"scope"`
	Name            string   `json:"name"`
	Order           int      `json:"sort_order"`
	Collapsed       bool     `json:"collapsed"`
	Version         int64    `json:"version,string"`
	ConversationIDs []string `json:"conversation_ids"`
}
type FolderInput struct {
	Scope     string `json:"scope"`
	Name      string `json:"name"`
	Order     int    `json:"sort_order"`
	Collapsed bool   `json:"collapsed"`
	Expected  int64  `json:"expected_version,string"`
}

func (s *Service) SaveFolder(ctx context.Context, who Identity, id string, in FolderInput) (Folder, error) {
	out := Folder{ID: id, Scope: in.Scope, Name: strings.TrimSpace(in.Name), Order: in.Order, Collapsed: in.Collapsed, ConversationIDs: []string{}}
	if !validText(out.Name, 1, 64) || (in.Scope != "direct" && in.Scope != "group") || in.Order < 0 || in.Order > 10000 || (id != "" && !validID(id)) {
		return out, ErrInvalid
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	if _, e = lockIdentity(ctx, tx, who); e != nil {
		return out, e
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,7153))", who.UserID); e != nil {
		return out, e
	}
	if id == "" {
		var count int
		if e = tx.QueryRow(ctx, "SELECT count(*) FROM pulse.conversation_folders WHERE user_id=$1", who.UserID).Scan(&count); e != nil {
			return out, e
		}
		if count >= 100 {
			return out, &Fault{409, "folder_limit"}
		}
		out.ID = newID()
		out.Version = 1
		_, e = tx.Exec(ctx, "INSERT INTO pulse.conversation_folders(id,user_id,scope,name,sort_order,collapsed) VALUES($1,$2,$3,$4,$5,$6)", out.ID, who.UserID, out.Scope, out.Name, out.Order, out.Collapsed)
	} else {
		e = tx.QueryRow(ctx, `UPDATE pulse.conversation_folders SET name=$3,sort_order=$4,collapsed=$5,version=version+1 WHERE id=$1 AND user_id=$2 AND version=$6 AND scope=$7 RETURNING version`, id, who.UserID, out.Name, out.Order, out.Collapsed, in.Expected, in.Scope).Scan(&out.Version)
		if errors.Is(e, pgx.ErrNoRows) {
			return out, ErrConflict
		}
	}
	if e != nil {
		return out, uniqueFault(e)
	}
	if _, e = tx.Exec(ctx, "INSERT INTO pulse.user_outbox(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET version=pulse.user_outbox.version+1", who.UserID); e != nil {
		return out, e
	}
	return out, tx.Commit(ctx)
}
func (a *API) registerOrganization(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("POST /api/v2/conversations/saved", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id, e := s.Saved(r.Context(), who)
		if e == nil {
			writeJSON(w, 200, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("PATCH /api/v2/conversations/{id}/preferences", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in PreferencePatch
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := s.SetPreferences(r.Context(), who, r.PathValue("id"), in)
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/channels", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Title string `json:"title"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		v, e := s.createGroupKind(r.Context(), who, in.Title, nil, false, "channel")
		if e == nil {
			writeJSON(w, 201, v)
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/groups/join-by-number", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Number     string `json:"number"`
			InviteCode string `json:"invite_code"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		in.Number = strings.TrimSpace(in.Number)
		var id string
		var e error
		if validID(in.Number) {
			e = s.Store.Pool.QueryRow(r.Context(), "SELECT id::text FROM pulse.conversations WHERE id=$1 AND active AND kind IN('group','channel')", in.Number).Scan(&id)
		} else if len(in.Number) == 32 && strings.ToUpper(in.Number) == in.Number {
			e = s.Store.Pool.QueryRow(r.Context(), "SELECT id::text FROM pulse.conversations WHERE public_id=$1 AND active AND kind IN('group','channel')", in.Number).Scan(&id)
		} else {
			legacyNumber, parseErr := strconv.ParseInt(in.Number, 10, 64)
			if parseErr != nil || legacyNumber <= 0 || strconv.FormatInt(legacyNumber, 10) != in.Number {
				return ErrInvalid
			}
			e = s.Store.Pool.QueryRow(r.Context(), `SELECT c.id::text FROM pulse.legacy_ids l
                JOIN pulse.conversations c ON c.id=l.new_id
                WHERE l.entity='conversation' AND l.legacy_id=$1 AND c.active AND c.kind IN('group','channel')`, legacyNumber).Scan(&id)
		}
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e != nil {
			return e
		}
		if e = s.JoinGroup(r.Context(), who, id, in.InviteCode); e == nil {
			writeJSON(w, 200, map[string]string{"id": id})
		}
		return e
	}))
	mux.HandleFunc("POST /api/v2/channels/follow", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			ConversationID string `json:"conversation_id"`
			InviteCode     string `json:"invite_code"`
		}
		if err := decode(w, r, &in); err != nil || (in.ConversationID == "" && in.InviteCode == "") {
			return ErrInvalid
		}
		in.InviteCode = strings.TrimSpace(in.InviteCode)
		var id string
		var err error
		if in.ConversationID != "" {
			value := strings.TrimSpace(in.ConversationID)
			if validID(value) {
				err = s.Store.Pool.QueryRow(r.Context(), "SELECT id::text FROM pulse.conversations WHERE id=$1 AND active AND kind='channel'", value).Scan(&id)
			} else {
				number, parseErr := strconv.ParseInt(value, 10, 64)
				if parseErr != nil || number <= 0 || strconv.FormatInt(number, 10) != value {
					return ErrInvalid
				}
				err = s.Store.Pool.QueryRow(r.Context(), `SELECT c.id::text FROM pulse.legacy_ids l JOIN pulse.conversations c ON c.id=l.new_id
					WHERE l.entity='conversation' AND l.legacy_id=$1 AND c.active AND c.kind='channel'`, number).Scan(&id)
			}
		} else {
			if len(in.InviteCode) != 64 {
				return ErrInvalid
			}
			err = s.Store.Pool.QueryRow(r.Context(), "SELECT id::text FROM pulse.conversations WHERE invite_code_hash=$1 AND active AND kind='channel'", digest(strings.TrimSpace(in.InviteCode))).Scan(&id)
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrMissing
		}
		if err != nil {
			return err
		}
		err = s.JoinGroup(r.Context(), who, id, in.InviteCode)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversation-folders", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		rows, e := s.Store.Pool.Query(r.Context(), `SELECT f.id::text,f.scope,f.name,f.sort_order,f.collapsed,f.version,COALESCE(array_agg(st.conversation_id::text) FILTER(WHERE st.conversation_id IS NOT NULL),'{}') FROM pulse.conversation_folders f LEFT JOIN (SELECT st.* FROM pulse.user_states st JOIN pulse.members m USING(conversation_id,user_id) JOIN pulse.conversations c ON c.id=st.conversation_id WHERE m.active AND c.active) st ON st.folder_id=f.id AND st.user_id=f.user_id WHERE f.user_id=$1 GROUP BY f.id ORDER BY f.sort_order,f.id LIMIT 100`, who.UserID)
		if e != nil {
			return e
		}
		defer rows.Close()
		items := []Folder{}
		for rows.Next() {
			var v Folder
			if e = rows.Scan(&v.ID, &v.Scope, &v.Name, &v.Order, &v.Collapsed, &v.Version, &v.ConversationIDs); e != nil {
				return e
			}
			items = append(items, v)
		}
		if e = rows.Err(); e != nil {
			return e
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	for _, path := range []string{"POST /api/v2/conversation-folders", "PUT /api/v2/conversation-folders/{id}"} {
		mux.HandleFunc(path, a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
			var in FolderInput
			if e := decode(w, r, &in); e != nil {
				return e
			}
			v, e := s.SaveFolder(r.Context(), who, r.PathValue("id"), in)
			if e == nil {
				writeJSON(w, 200, v)
			}
			return e
		}))
	}
}
