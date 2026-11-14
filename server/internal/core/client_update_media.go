package core

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
)

type SharedMediaPage struct {
	Items         []Message `json:"items"`
	NextBeforeSeq string    `json:"next_before_seq"`
	HasMore       bool      `json:"has_more"`
}

func (s *Service) SharedMedia(ctx context.Context, who Identity, cid, kind string, before int64, limit int) (SharedMediaPage, error) {
	out := SharedMediaPage{Items: []Message{}}
	if !validID(cid) || before < 0 || limit < 1 || limit > 50 {
		return out, ErrInvalid
	}
	switch kind {
	case "", "all", "image", "video", "file":
	default:
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
	access, e := authorize(ctx, tx, who, cid, false)
	if e != nil {
		return out, e
	}
	rows, e := tx.Query(ctx, `SELECT msg.id::text,msg.conversation_id::text,msg.seq,msg.event_seq,msg.sender_id::text,msg.request_id,msg.body,msg.revoked,msg.version,msg.created_at,msg.updated_at,msg.kind,msg.content,COALESCE(msg.reply_to::text,''),`+messageSenderColumn+` FROM pulse.messages msg JOIN pulse.message_media link ON link.message_id=msg.id JOIN pulse.media media ON media.id=link.media_id AND media.status='ready'
 WHERE msg.conversation_id=$1 AND msg.seq>GREATEST($2::bigint,$3::bigint-1) AND($4::bigint=0 OR msg.seq<$4) AND msg.kind IN('image','video','file') AND ($5='' OR $5='all' OR msg.kind=$5) AND NOT msg.revoked AND (NOT msg.manager_only OR $8)
 AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$6)
 ORDER BY msg.seq DESC LIMIT $7`, cid, access.ClearSeq, access.VisibleFrom, before, kind, who.UserID, limit+1, access.managesGroup())
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var item Message
		if e = scanMessage(rows, &item); e != nil {
			rows.Close()
			return out, e
		}
		out.Items = append(out.Items, item)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
	}
	if len(out.Items) > limit {
		out.HasMore = true
		out.Items = out.Items[:limit]
	}
	if len(out.Items) > 0 {
		out.NextBeforeSeq = strconv.FormatInt(out.Items[len(out.Items)-1].Seq, 10)
	}
	return out, tx.Commit(ctx)
}
func (s *Service) CheckUpdate(ctx context.Context, platform, current string) (map[string]any, error) {
	now, ok := versionNumber(current)
	if !ok {
		return nil, ErrInvalid
	}
	switch platform {
	case "pc", "web", "android", "ios":
	default:
		return nil, ErrInvalid
	}
	var raw []byte
	e := s.Store.Pool.QueryRow(ctx, "SELECT value FROM pulse.system_settings WHERE key='releases'").Scan(&raw)
	if e != nil {
		return nil, e
	}
	var releases map[string]ClientRelease
	if e = json.Unmarshal(raw, &releases); e != nil {
		return nil, e
	}
	release, found := releases[platform]
	out := map[string]any{"platform": platform, "current_version": current, "update_available": false, "required": false, "latest_version": "1.0.0", "minimum_version": "", "latest": "1.0.0", "minimum": "", "force": false, "url": "", "notes": ""}
	if !found {
		return out, nil
	}
	latest, _ := versionNumber(release.Latest)
	minimum, _ := versionNumber(release.Minimum)
	out["update_available"] = versionLess(now, latest)
	out["required"] = release.Force && release.Minimum != "" && versionLess(now, minimum)
	out["latest_version"] = release.Latest
	out["minimum_version"] = release.Minimum
	out["url"] = release.URL
	out["notes"] = release.Notes
	out["latest"] = release.Latest
	out["minimum"] = release.Minimum
	out["force"] = release.Force
	return out, nil
}
func (a *API) registerClientCompletionMore(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/client/update", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		v, e := s.CheckUpdate(r.Context(), r.URL.Query().Get("platform"), r.URL.Query().Get("version"))
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/shared-media", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		before, e := parseSeq(r.URL.Query().Get("before_seq"), 0)
		if e != nil {
			return e
		}
		limit, e := parseSeq(r.URL.Query().Get("limit"), 30)
		if e != nil {
			return e
		}
		v, e := s.SharedMedia(r.Context(), who, r.PathValue("id"), r.URL.Query().Get("kind"), before, int(limit))
		if e == nil {
			writeJSON(w, 200, v)
		}
		return e
	}))
}
