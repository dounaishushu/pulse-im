package core

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type ClientRelease struct {
	Latest  string `json:"latest"`
	Minimum string `json:"minimum"`
	Force   bool   `json:"force"`
	URL     string `json:"url"`
	Notes   string `json:"notes"`
}
type NavigationItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	URL   string `json:"url"`
	Order int    `json:"sort_order"`
}
type ClientRoute struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	API     string `json:"api_url"`
	WS      string `json:"ws_url"`
	Media   string `json:"media_url"`
	Enabled bool   `json:"enabled"`
	Order   int    `json:"sort_order"`
}

// Retain configured hosts while replacing the PHP entry paths on read. The
// archived settings remain untouched until an administrator saves a new policy.
func goClientRoute(route ClientRoute) ClientRoute {
	u, err := url.Parse(route.API)
	if err != nil || u.Host == "" {
		return route
	}
	switch strings.TrimRight(u.Path, "/") {
	case "", "/api", "/index.php", "/index.php/api", "/api/v2":
		u.Path, u.RawPath, u.RawQuery, u.Fragment = "/api/v2", "", "", ""
		route.API = u.String()
		if u.Scheme == "https" {
			u.Scheme = "wss"
		} else {
			u.Scheme = "ws"
		}
		u.Path = "/api/v2/realtime"
		route.WS = u.String()
		route.Media = route.API
	}
	return route
}

var versionPattern = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){1,3}$`)

type parsedVersion [4]uint64

func versionNumber(v string) (parsedVersion, bool) {
	var out parsedVersion
	if len(v) > 32 || !versionPattern.MatchString(v) {
		return out, false
	}
	for index, part := range strings.Split(v, ".") {
		number, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return out, false
		}
		out[index] = number
	}
	return out, true
}

func versionLess(a, b parsedVersion) bool {
	for index := range a {
		if a[index] != b[index] {
			return a[index] < b[index]
		}
	}
	return false
}
func safeURL(raw string, ws bool) bool {
	u, e := url.Parse(raw)
	if e != nil || u.User != nil || u.Hostname() == "" || u.Fragment != "" {
		return false
	}
	if ws {
		return u.Scheme == "wss" || u.Scheme == "ws"
	}
	return u.Scheme == "https" || u.Scheme == "http"
}
func validateSetting(key string, raw json.RawMessage) error {
	switch key {
	case "registration":
		var v RegistrationPolicy
		if e := json.Unmarshal(raw, &v); e != nil || v.PerIPLimit < 0 || v.PerIPLimit > 100000 {
			return ErrInvalid
		}
	case "mobile_binding":
		var v struct {
			Enabled bool `json:"enabled"`
		}
		if json.Unmarshal(raw, &v) != nil {
			return ErrInvalid
		}
	case "announcement":
		var v struct {
			Enabled bool   `json:"enabled"`
			Title   string `json:"title"`
			Body    string `json:"body"`
		}
		if json.Unmarshal(raw, &v) != nil || !validText(v.Title, 0, 32) || !validText(v.Body, 0, 4000) || (v.Enabled && (strings.TrimSpace(v.Title) == "" || strings.TrimSpace(v.Body) == "")) {
			return ErrInvalid
		}
	case "releases":
		var v map[string]ClientRelease
		if json.Unmarshal(raw, &v) != nil || len(v) > 4 {
			return ErrInvalid
		}
		for platform, item := range v {
			switch platform {
			case "pc", "web", "android", "ios":
			default:
				return ErrInvalid
			}
			latest, ok := versionNumber(item.Latest)
			minimum, minOK := versionNumber(item.Minimum)
			if !ok || (item.Minimum != "" && (!minOK || versionLess(latest, minimum))) || (item.Force && item.Minimum == "") || !validText(item.Notes, 0, 4000) || (item.URL != "" && !safeURL(item.URL, false)) {
				return ErrInvalid
			}
		}
	case "navigation", "shops":
		var items []NavigationItem
		if json.Unmarshal(raw, &items) != nil || len(items) > 10 {
			return ErrInvalid
		}
		seen := map[string]bool{}
		for _, item := range items {
			if !requestPattern.MatchString(item.ID) || seen[item.ID] || !validText(item.Title, 1, 64) || !safeURL(item.URL, false) || item.Order < 0 || item.Order > 1000 {
				return ErrInvalid
			}
			seen[item.ID] = true
		}
	case "routes":
		var items []ClientRoute
		if json.Unmarshal(raw, &items) != nil || len(items) > 32 || len(items) == 0 {
			return ErrInvalid
		}
		seen := map[string]bool{}
		enabled := false
		for _, item := range items {
			if !requestPattern.MatchString(item.ID) || !validText(item.Name, 1, 64) || !safeURL(item.API, false) || !safeURL(item.WS, true) || !safeURL(item.Media, false) || seen[item.API] || seen["id:"+item.ID] {
				return ErrInvalid
			}
			seen[item.API] = true
			seen["id:"+item.ID] = true
			enabled = enabled || item.Enabled
		}
		if !enabled {
			return &Fault{409, "last_enabled_route"}
		}
	case "display":
		var v struct {
			Show bool `json:"show_group_count"`
		}
		if json.Unmarshal(raw, &v) != nil {
			return ErrInvalid
		}
	case "maintenance":
		var v struct {
			Enabled       bool `json:"enabled"`
			Retention     int  `json:"retention_days"`
			Hour          int  `json:"hour"`
			Minute        int  `json:"minute"`
			IntervalDays  int  `json:"interval_days"`
			InactiveDays  int  `json:"inactive_days"`
			CleanAccounts bool `json:"clean_accounts"`
			CleanCache    bool `json:"clean_cache"`
		}
		if json.Unmarshal(raw, &v) != nil || v.Retention < 7 || v.Retention > 3650 || v.Hour < 0 || v.Hour > 23 || v.Minute < 0 || v.Minute > 59 || (v.IntervalDays != 0 && (v.IntervalDays < 1 || v.IntervalDays > 30)) || (v.InactiveDays != 0 && (v.InactiveDays < 1 || v.InactiveDays > 3650)) || ((v.IntervalDays != 0 || v.CleanAccounts || v.CleanCache) && !v.CleanAccounts && !v.CleanCache) {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}
func (s *Service) PublicConfig(ctx context.Context) (map[string]any, error) {
	out := map[string]any{"protocol": "pulse-v2", "capabilities": []string{"text", "temporary_chat", "groups", "channels", "saved_messages", "invite_history", "contact_privacy", "personal_history", "device_sessions", "registration", "second_factor", "media", "search", "pins", "notifications"}, "push_enabled": s.Push.Available("ios") || s.Push.Available("android"), "group_member_limit": 500}
	rows, e := s.Store.Pool.Query(ctx, "SELECT key,value,version FROM pulse.system_settings WHERE key=ANY($1::text[])", []string{"registration", "announcement", "releases", "navigation", "shops", "routes", "display"})
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var raw []byte
		var version int64
		if e = rows.Scan(&key, &raw, &version); e != nil {
			return nil, e
		}
		switch key {
		case "registration":
			var v RegistrationPolicy
			if e = json.Unmarshal(raw, &v); e != nil {
				return nil, e
			}
			out["registration_enabled"] = v.Enabled
			out["registration_avatar_required"] = v.AvatarRequired
			out["registration"] = v
		case "routes":
			var v []ClientRoute
			if e = json.Unmarshal(raw, &v); e != nil {
				return nil, e
			}
			enabled := []ClientRoute{}
			for _, it := range v {
				if it.Enabled {
					enabled = append(enabled, goClientRoute(it))
				}
			}
			sort.Slice(enabled, func(i, j int) bool { return enabled[i].Order < enabled[j].Order })
			out[key] = enabled
		default:
			out[key] = json.RawMessage(raw)
		}
		out[key+"_version"] = strconv.FormatInt(version, 10)
	}
	return out, rows.Err()
}
func (s *Service) filterText(ctx context.Context, tx pgx.Tx, body string) (string, error) {
	if body == "" {
		return body, nil
	}
	s.wordMu.Lock()
	if s.words == nil || time.Now().After(s.wordsUntil) {
		rows, e := tx.Query(ctx, "SELECT word,replacement FROM pulse.sensitive_words WHERE enabled ORDER BY length(word) DESC,word LIMIT 10000")
		if e != nil {
			s.wordMu.Unlock()
			return "", e
		}
		pairs := []string{}
		for rows.Next() {
			var word, replacement string
			if e = rows.Scan(&word, &replacement); e != nil {
				rows.Close()
				s.wordMu.Unlock()
				return "", e
			}
			pairs = append(pairs, word, replacement)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			s.wordMu.Unlock()
			return "", e
		}
		s.words = strings.NewReplacer(pairs...)
		s.wordsUntil = time.Now().Add(time.Second)
	}
	filter := s.words
	s.wordMu.Unlock()
	body = filter.Replace(body)
	if !validText(body, 0, 5000) {
		return "", &Fault{422, "filtered_message_too_long"}
	}
	return body, nil
}
func (s *Service) invalidateWords() { s.wordMu.Lock(); s.wordsUntil = time.Time{}; s.wordMu.Unlock() }

func (a *API) registerConfiguration(mux *http.ServeMux) {
	s := a.Service
	mux.HandleFunc("GET /api/v2/admin/config/{key}", a.adminWrap("", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		if !adminPermission(who.Role, who.Permissions, settingModule(r.PathValue("key")), false) {
			return ErrForbidden
		}
		var raw []byte
		var version int64
		e := s.Store.Pool.QueryRow(r.Context(), "SELECT value,version FROM pulse.system_settings WHERE key=$1", r.PathValue("key")).Scan(&raw, &version)
		if errors.Is(e, pgx.ErrNoRows) {
			return ErrMissing
		}
		if e == nil {
			if r.PathValue("key") == "routes" {
				var routes []ClientRoute
				if e = json.Unmarshal(raw, &routes); e != nil {
					return e
				}
				for index := range routes {
					routes[index] = goClientRoute(routes[index])
				}
				raw, e = json.Marshal(routes)
				if e != nil {
					return e
				}
			}
			writeJSON(w, 200, map[string]any{"value": json.RawMessage(raw), "version": strconv.FormatInt(version, 10)})
		}
		return e
	}))
	mux.HandleFunc("PUT /api/v2/admin/config/{key}", a.adminWrap("", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		key := r.PathValue("key")
		if !adminPermission(who.Role, who.Permissions, settingModule(key), true) {
			return ErrForbidden
		}
		var in struct {
			Value   json.RawMessage `json:"value"`
			Version int64           `json:"expected_version,string"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if e := validateSetting(key, in.Value); e != nil {
			return e
		}
		e := s.adminWrite(r.Context(), who, settingModule(key), "config.update", "config", key, func(tx pgx.Tx) error {
			if key == "registration" {
				if _, e := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(7157)"); e != nil {
					return e
				}
			}
			if key == "mobile_binding" {
				if _, e := tx.Exec(r.Context(), "SELECT pg_advisory_xact_lock(7153002)"); e != nil {
					return e
				}
			}
			var prior []byte
			var old int64
			if e := tx.QueryRow(r.Context(), "SELECT value,version FROM pulse.system_settings WHERE key=$1 FOR UPDATE", key).Scan(&prior, &old); e != nil {
				return e
			}
			if old != in.Version {
				return ErrConflict
			}
			if _, e := tx.Exec(r.Context(), "UPDATE pulse.system_settings SET value=$2,version=version+1,updated_at=now() WHERE key=$1", key, in.Value); e != nil {
				return e
			}
			if key == "mobile_binding" {
				var oldPolicy, newPolicy struct {
					Enabled bool `json:"enabled"`
				}
				_ = json.Unmarshal(prior, &oldPolicy)
				_ = json.Unmarshal(in.Value, &newPolicy)
				if !oldPolicy.Enabled && newPolicy.Enabled {
					_, e := tx.Exec(r.Context(), `UPDATE pulse.login_sessions s SET revoked_at=now() FROM pulse.users u WHERE u.id=s.user_id AND NOT u.internal_staff AND s.platform IN('android','ios') AND s.revoked_at IS NULL`)
					return e
				}
			}
			return nil
		})
		if e == nil {
			writeJSON(w, 200, map[string]any{"version": strconv.FormatInt(in.Version+1, 10)})
		}
		return e
	}))
	mux.HandleFunc("GET /api/v2/admin/sensitive-words", a.adminWrap("sensitive_words", false, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		q := r.URL.Query().Get("q")
		if len(q) > 128 {
			return ErrInvalid
		}
		pattern := "%" + strings.NewReplacer("%", "\\%", "_", "\\_").Replace(q) + "%"
		return adminRows(w, r, s, "SELECT to_jsonb(x)||jsonb_build_object('version',version::text) FROM pulse.sensitive_words x WHERE word ILIKE $3 ORDER BY word,id LIMIT $1 OFFSET $2", pattern)
	}))
	for _, path := range []string{"POST /api/v2/admin/sensitive-words", "PUT /api/v2/admin/sensitive-words/{id}"} {
		mux.HandleFunc(path, a.adminWrap("sensitive_words", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
			var in struct {
				Word        string `json:"word"`
				Replacement string `json:"replacement"`
				Enabled     bool   `json:"enabled"`
				Version     int64  `json:"expected_version,string"`
			}
			if e := decode(w, r, &in); e != nil {
				return e
			}
			if !validText(in.Word, 1, 128) || !validText(in.Replacement, 0, 128) {
				return ErrInvalid
			}
			id := r.PathValue("id")
			create := id == ""
			if create {
				id = newID()
			}
			if !validID(id) {
				return ErrInvalid
			}
			e := s.adminWrite(r.Context(), who, "sensitive_words", "word.save", "word", id, func(tx pgx.Tx) error {
				if create {
					var count int
					if e := tx.QueryRow(r.Context(), "SELECT count(*) FROM pulse.sensitive_words").Scan(&count); e != nil {
						return e
					}
					if count >= 10000 {
						return &Fault{409, "word_limit"}
					}
					_, e := tx.Exec(r.Context(), "INSERT INTO pulse.sensitive_words(id,word,replacement,enabled) VALUES($1,$2,$3,$4)", id, in.Word, in.Replacement, in.Enabled)
					return e
				}
				cmd, e := tx.Exec(r.Context(), "UPDATE pulse.sensitive_words SET word=$2,replacement=$3,enabled=$4,version=version+1 WHERE id=$1 AND version=$5", id, in.Word, in.Replacement, in.Enabled, in.Version)
				if e == nil && cmd.RowsAffected() != 1 {
					return ErrConflict
				}
				return e
			})
			if e == nil {
				writeJSON(w, 200, map[string]string{"id": id})
			}
			return e
		}))
	}
	mux.HandleFunc("POST /api/v2/admin/sensitive-words/delete", a.adminWrap("sensitive_words", true, func(w http.ResponseWriter, r *http.Request, who AdminIdentity) error {
		var in struct {
			IDs []string `json:"ids"`
		}
		if e := decode(w, r, &in); e != nil {
			return e
		}
		if len(in.IDs) < 1 || len(in.IDs) > 100 {
			return ErrInvalid
		}
		for _, id := range in.IDs {
			if !validID(id) {
				return ErrInvalid
			}
		}
		e := s.adminWrite(r.Context(), who, "sensitive_words", "word.delete", "word", "", func(tx pgx.Tx) error {
			_, e := tx.Exec(r.Context(), "DELETE FROM pulse.sensitive_words WHERE id=ANY($1::uuid[])", in.IDs)
			return e
		})
		if e == nil {
			w.WriteHeader(204)
		}
		return e
	}))
}

func settingModule(key string) string {
	switch key {
	case "announcement":
		return "announcements"
	case "mobile_binding":
		return "devices"
	case "maintenance":
		return "maintenance"
	}
	return "config"
}
