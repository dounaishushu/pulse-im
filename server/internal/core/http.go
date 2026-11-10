package core

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

func validID(id string) bool {
	if len(id) != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-' {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(id, "-", ""))
	return err == nil && id == strings.ToLower(id)
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func writeFault(w http.ResponseWriter, err error) {
	var fault *Fault
	if !errors.As(err, &fault) {
		fault = ErrBusy
		slog.Warn("request could not complete")
	}
	if fault.Status == 429 || fault.Status == 503 {
		w.Header().Set("Retry-After", "1")
	}
	writeJSON(w, fault.Status, map[string]any{"error": map[string]string{"code": fault.Code}})
}
func decode(w http.ResponseWriter, r *http.Request, value any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return ErrInvalid
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	return nil
}

type HTTPOptions struct {
	Origins        map[string]bool
	TrustedProxies []netip.Prefix
}
type API struct {
	Service    *Service
	Hub        *Hub
	Options    HTTPOptions
	slots      chan struct{}
	handshakes chan struct{}
}
type endpoint func(http.ResponseWriter, *http.Request, Identity) error

func (a *API) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return "unknown"
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return "unknown"
	}
	for _, prefix := range a.Options.TrustedProxies {
		if prefix.Contains(ip) {
			forwarded, err := netip.ParseAddr(r.Header.Get("X-Real-IP"))
			if err == nil {
				ip = forwarded
			}
			break
		}
	}
	return ip.Unmap().String()
}
func (a *API) wrap(auth bool, fn endpoint) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case a.slots <- struct{}{}:
			defer func() { <-a.slots }()
		default:
			writeFault(w, ErrBusy)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		w.Header().Set("X-Request-ID", newID())
		var who Identity
		var err error
		if auth {
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if token == r.Header.Get("Authorization") {
				writeFault(w, ErrUnauthorized)
				return
			}
			who, err = a.Service.Authenticate(ctx, token)
			if err != nil {
				writeFault(w, err)
				return
			}
			if err = a.Service.Cache.Allow(ctx, "api", who.UserID, 600, time.Minute); err != nil {
				// During a cache outage, bounded read-only recovery remains available.
				if !(errors.Is(err, ErrBusy) && (r.Method == http.MethodGet || r.URL.Path == "/api/v2/auth/logout")) {
					writeFault(w, err)
					return
				}
			}
		}
		if err = fn(w, r, who); err != nil {
			writeFault(w, err)
		}
	}
}
func NewHandler(service *Service, hub *Hub, options HTTPOptions) http.Handler {
	a := &API{Service: service, Hub: hub, Options: options, slots: make(chan struct{}, 256), handshakes: make(chan struct{}, 128)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		writeJSON(w, 200, map[string]string{"status": "ok"})
		return nil
	}))
	mux.HandleFunc("GET /readyz", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		if service.Store.Pool.Ping(r.Context()) != nil || service.Cache.Client.Ping(r.Context()).Err() != nil {
			return ErrBusy
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/auth/login", a.wrap(false, func(w http.ResponseWriter, r *http.Request, _ Identity) error {
		var in struct {
			Account  string `json:"account"`
			Password string `json:"password"`
			DeviceID string `json:"device_id"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		result, err := service.Login(r.Context(), in.Account, in.Password, in.DeviceID, a.clientIP(r))
		if err != nil {
			return err
		}
		hub.CloseDevice(result.UserID, result.DeviceID, result.SessionID)
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/auth/logout", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.Logout(r.Context(), who); err != nil {
			return err
		}
		hub.CloseSession(who.SessionID)
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/auth/sessions", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		items, err := service.Sessions(r.Context(), who)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/auth/sessions/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		id := r.PathValue("id")
		if err := service.RevokeSession(r.Context(), who, id); err != nil {
			return err
		}
		hub.CloseSession(id)
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/auth/password", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			CurrentPassword string `json:"current_password"`
			NewPassword     string `json:"new_password"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if err := service.ChangePassword(r.Context(), who, in.CurrentPassword, in.NewPassword); err != nil {
			return err
		}
		hub.CloseUser(who.UserID)
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/me/privacy", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		result, err := service.ContactPrivacy(r.Context(), who)
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("PATCH /api/v2/me/privacy", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var input PrivacyPatch
		if err := decode(w, r, &input); err != nil {
			return err
		}
		result, err := service.UpdateContactPrivacy(r.Context(), who, input)
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/me", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		writeJSON(w, 200, who)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/realtime/tickets", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.Cache.Allow(r.Context(), "ticket", who.UserID, 30, time.Minute); err != nil {
			return err
		}
		ticket, err := service.Cache.Ticket(r.Context(), who.SessionID)
		if err != nil {
			return err
		}
		writeJSON(w, 201, map[string]any{"ticket": ticket, "expires_in": 30})
		return nil
	}))
	// An upgraded socket has its own connection budget and must not occupy one
	// of the short-lived HTTP request slots for its entire lifetime.
	mux.HandleFunc("GET /api/v2/realtime", func(w http.ResponseWriter, r *http.Request) {
		select {
		case a.handshakes <- struct{}{}:
		default:
			writeFault(w, ErrBusy)
			return
		}
		// The handshake budget is released before this handler waits on a socket.
		release := func() { <-a.handshakes }

		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		if err := service.Cache.Allow(ctx, "connect", a.clientIP(r), 2400, time.Minute); err != nil {
			cancel()
			release()
			writeFault(w, err)
			return
		}
		sid, err := service.Cache.TakeTicket(ctx, r.URL.Query().Get("ticket"))
		if err != nil {
			cancel()
			release()
			writeFault(w, err)
			return
		}
		who, err := service.Session(ctx, sid)
		cancel()
		release()
		if err != nil {
			writeFault(w, err)
			return
		}
		hub.Serve(w, r, who, options.Origins, service.Session)
	})
	mux.HandleFunc("GET /api/v2/conversations", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		if after != "" && !validID(after) {
			return ErrInvalid
		}
		list, err := service.Conversations(r.Context(), who, after)
		if err != nil {
			return err
		}
		next := ""
		if len(list) == 100 {
			next = list[len(list)-1].ID
		}
		writeJSON(w, 200, map[string]any{"items": list, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/access", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		result, err := service.ConversationAccess(r.Context(), who, r.PathValue("id"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/conversations/direct", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			PeerID string `json:"peer_id"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if !validID(in.PeerID) {
			return ErrInvalid
		}
		id, err := service.Direct(r.Context(), who, in.PeerID)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/friends", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		if after != "" && !validID(after) {
			return ErrInvalid
		}
		items, err := service.Friends(r.Context(), who, after)
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[len(items)-1]
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/users/by-account/{account}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		result, err := service.LookupAccount(r.Context(), who, r.PathValue("account"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/friend-requests", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		items, err := service.FriendRequests(r.Context(), who, r.URL.Query().Get("direction"), r.URL.Query().Get("after"))
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[len(items)-1].ID
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/friend-requests", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			TargetID              string `json:"target_id"`
			Note                  string `json:"note"`
			ContextConversationID string `json:"context_conversation_id,omitempty"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		id, err := service.FriendRequestInContext(r.Context(), who, in.TargetID, in.Note, in.ContextConversationID)
		if err != nil {
			return err
		}
		writeJSON(w, 201, map[string]string{"id": id})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/friend-requests/incoming", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		items, err := service.IncomingFriendRequests(r.Context(), who)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": items})
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/friend-requests/{id}/decision", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Accept *bool `json:"accept"`
		}
		if err := decode(w, r, &in); err != nil || in.Accept == nil {
			return ErrInvalid
		}
		id, err := service.DecideFriendRequest(r.Context(), who, r.PathValue("id"), *in.Accept)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"conversation_id": id})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/friends/direct-add", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			TargetID string `json:"target_id"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		id, err := service.AddFriendAsStaff(r.Context(), who, in.TargetID)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"conversation_id": id})
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/friends/{peer}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.RemoveFriend(r.Context(), who, r.PathValue("peer")); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/blocks/{peer}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.Block(r.Context(), who, r.PathValue("peer"), true); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/blocks", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		items, err := service.Blocks(r.Context(), who, after)
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[len(items)-1]
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/blocks/{peer}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.Block(r.Context(), who, r.PathValue("peer"), false); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Title          string   `json:"title"`
			InitialMembers []string `json:"initial_members"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		result, err := service.CreateGroup(r.Context(), who, in.Title, in.InitialMembers)
		if err != nil {
			return err
		}
		writeJSON(w, 201, result)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/groups/{id}/members", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		after := r.URL.Query().Get("after")
		items, err := service.GroupMembers(r.Context(), who, r.PathValue("id"), after)
		if err != nil {
			return err
		}
		next := ""
		if len(items) == 100 {
			next = items[len(items)-1]
		}
		writeJSON(w, 200, map[string]any{"items": items, "next_after": next})
		return nil
	}))
	mux.HandleFunc("GET /api/v2/groups/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		result, err := service.GroupDetails(r.Context(), who, r.PathValue("id"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("PATCH /api/v2/groups/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var input GroupSettings
		if err := decode(w, r, &input); err != nil {
			return err
		}
		result, err := service.UpdateGroupSettings(r.Context(), who, r.PathValue("id"), input)
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/{id}/invite-code/rotate", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		code, err := service.RotateGroupInvite(r.Context(), who, r.PathValue("id"))
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]string{"invite_code": code})
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/{id}/join", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			InviteCode string `json:"invite_code"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if err := service.JoinGroup(r.Context(), who, r.PathValue("id"), in.InviteCode); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/{id}/members", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			TargetID     string `json:"target_id"`
			AllowHistory *bool  `json:"allow_history"`
		}
		if err := decode(w, r, &in); err != nil || in.AllowHistory == nil {
			return ErrInvalid
		}
		if err := service.InviteGroupMemberWithHistory(r.Context(), who, r.PathValue("id"), in.TargetID, *in.AllowHistory); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/{id}/members/batch", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			UserIDs      []string `json:"user_ids"`
			AllowHistory *bool    `json:"allow_history"`
		}
		if err := decode(w, r, &in); err != nil || in.AllowHistory == nil {
			return ErrInvalid
		}
		results, err := service.InviteGroupMembersWithHistory(r.Context(), who, r.PathValue("id"), in.UserIDs, *in.AllowHistory)
		if err != nil {
			return err
		}
		writeJSON(w, 200, map[string]any{"items": results})
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/groups/{id}/members/{user}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.RemoveGroupMember(r.Context(), who, r.PathValue("id"), r.PathValue("user")); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/groups/{id}/members/{user}/muted", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Muted *bool `json:"muted"`
		}
		if err := decode(w, r, &in); err != nil || in.Muted == nil {
			return ErrInvalid
		}
		if err := service.SetGroupMute(r.Context(), who, r.PathValue("id"), r.PathValue("user"), *in.Muted); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/groups/{id}/mute-all", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Muted *bool `json:"muted"`
		}
		if err := decode(w, r, &in); err != nil || in.Muted == nil {
			return ErrInvalid
		}
		if err := service.SetGroupMuteAll(r.Context(), who, r.PathValue("id"), *in.Muted); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/groups/{id}/members/{user}/role", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			Role string `json:"role"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if err := service.SetGroupRole(r.Context(), who, r.PathValue("id"), r.PathValue("user"), in.Role); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/groups/{id}/transfer", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		var in struct {
			TargetID string `json:"target_id"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		if err := service.TransferGroup(r.Context(), who, r.PathValue("id"), in.TargetID); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/groups/{id}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		if err := service.DissolveGroup(r.Context(), who, r.PathValue("id")); err != nil {
			return err
		}
		w.WriteHeader(204)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/conversations/{id}/messages", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		if err := service.Cache.Allow(r.Context(), "send", who.UserID, 30, time.Second); err != nil {
			return err
		}
		var in SendInput
		if err := decode(w, r, &in); err != nil {
			return err
		}
		out, err := service.Send(r.Context(), who, cid, in)
		if err != nil {
			return err
		}
		status := 201
		if out.Duplicate {
			status = 200
		}
		writeJSON(w, status, out)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/sync", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		after, err := parseSeq(r.URL.Query().Get("after"), 0)
		if err != nil {
			return err
		}
		limit, err := parseSeq(r.URL.Query().Get("limit"), 100)
		if err != nil || limit > 100 || limit < 1 {
			return ErrInvalid
		}
		var upper *int64
		if r.URL.Query().Has("snapshot_max_seq") {
			value, err := parseSeq(r.URL.Query().Get("snapshot_max_seq"), -1)
			if err != nil || value < 0 {
				return ErrInvalid
			}
			upper = &value
		}
		var membership *int64
		if r.URL.Query().Has("membership_version") {
			value, err := parseSeq(r.URL.Query().Get("membership_version"), -1)
			if err != nil || value < 1 {
				return ErrInvalid
			}
			membership = &value
		}
		page, err := service.SyncMembership(r.Context(), who, cid, after, upper, int(limit), membership)
		if err != nil {
			return err
		}
		writeJSON(w, 200, page)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/personal-sync", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		after, err := parseSeq(r.URL.Query().Get("after"), 0)
		if err != nil {
			return err
		}
		limit, err := parseSeq(r.URL.Query().Get("limit"), 100)
		if err != nil || limit < 1 || limit > 100 {
			return ErrInvalid
		}
		var upper *int64
		if r.URL.Query().Has("snapshot_max_seq") {
			value, err := parseSeq(r.URL.Query().Get("snapshot_max_seq"), -1)
			if err != nil || value < 0 {
				return ErrInvalid
			}
			upper = &value
		}
		page, err := service.PersonalSync(r.Context(), who, cid, after, upper, int(limit))
		if err != nil {
			return err
		}
		writeJSON(w, 200, page)
		return nil
	}))
	mux.HandleFunc("GET /api/v2/conversations/{id}/unread", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		capCount, err := parseSeq(r.URL.Query().Get("cap"), 999)
		if err != nil || capCount < 1 || capCount > 999 {
			return ErrInvalid
		}
		result, err := service.Unread(r.Context(), who, cid, int(capCount))
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/conversations/{id}/reminder", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		var input struct {
			Reminder *bool `json:"reminder"`
		}
		if err := decode(w, r, &input); err != nil || input.Reminder == nil {
			return ErrInvalid
		}
		state, err := service.SetReminder(r.Context(), who, cid, *input.Reminder)
		if err != nil {
			return err
		}
		writeJSON(w, 200, state)
		return nil
	}))
	mux.HandleFunc("PUT /api/v2/conversations/{id}/clear", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		var input struct {
			ThroughSeq *int64 `json:"through_seq,string"`
		}
		if err := decode(w, r, &input); err != nil || input.ThroughSeq == nil {
			return ErrInvalid
		}
		state, err := service.ClearHistory(r.Context(), who, cid, *input.ThroughSeq)
		if err != nil {
			return err
		}
		writeJSON(w, 200, state)
		return nil
	}))
	mux.HandleFunc("POST /api/v2/conversations/{id}/personal-deletions", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid := r.PathValue("id")
		if !validID(cid) {
			return ErrInvalid
		}
		var input struct {
			MessageIDs []string `json:"message_ids"`
		}
		if err := decode(w, r, &input); err != nil {
			return err
		}
		state, err := service.DeletePersonalMessages(r.Context(), who, cid, input.MessageIDs)
		if err != nil {
			return err
		}
		writeJSON(w, 200, state)
		return nil
	}))
	for _, operation := range []string{"read", "delivered"} {
		mux.HandleFunc("PUT /api/v2/conversations/{id}/"+operation, a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
			cid := r.PathValue("id")
			if !validID(cid) {
				return ErrInvalid
			}
			var in struct {
				Seq *int64 `json:"seq,string"`
			}
			if err := decode(w, r, &in); err != nil || in.Seq == nil {
				return ErrInvalid
			}
			state, err := service.Advance(r.Context(), who, cid, *in.Seq, operation == "read")
			if err != nil {
				return err
			}
			writeJSON(w, 200, state)
			return nil
		}))
	}
	mux.HandleFunc("GET /api/v2/conversations/{id}/states", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, after := r.PathValue("id"), r.URL.Query().Get("after")
		if !validID(cid) || (after != "" && !validID(after)) {
			return ErrInvalid
		}
		list, err := service.States(r.Context(), who, cid, after)
		if err != nil {
			return err
		}
		next := ""
		if len(list) == 100 {
			next = list[len(list)-1].UserID
		}
		writeJSON(w, 200, map[string]any{"items": list, "next_after": next})
		return nil
	}))

	mux.HandleFunc("GET /api/v2/conversations/{id}/messages/{message}/receipts", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
			return ErrInvalid
		}
		result, err := service.Receipts(r.Context(), who, cid, mid)
		if err != nil {
			return err
		}
		writeJSON(w, 200, result)
		return nil
	}))
	mux.HandleFunc("PATCH /api/v2/conversations/{id}/messages/{message}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
			return ErrInvalid
		}
		var in struct {
			Body            string `json:"body"`
			ExpectedVersion int64  `json:"expected_version,string"`
		}
		if err := decode(w, r, &in); err != nil {
			return err
		}
		m, err := service.MutateMessage(r.Context(), who, cid, mid, in.Body, in.ExpectedVersion, false)
		if err != nil {
			return err
		}
		writeJSON(w, 200, m)
		return nil
	}))
	mux.HandleFunc("DELETE /api/v2/conversations/{id}/messages/{message}", a.wrap(true, func(w http.ResponseWriter, r *http.Request, who Identity) error {
		cid, mid := r.PathValue("id"), r.PathValue("message")
		if !validID(cid) || !validID(mid) {
			return ErrInvalid
		}
		m, err := service.MutateMessage(r.Context(), who, cid, mid, "", 0, true)
		if err != nil {
			return err
		}
		writeJSON(w, 200, m)
		return nil
	}))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() != nil {
				slog.Error("request panic recovered")
				writeFault(w, ErrBusy)
			}
		}()
		origin := r.Header.Get("Origin")
		if origin != "" {
			if !options.Origins[origin] {
				writeFault(w, ErrForbidden)
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
func parseSeq(raw string, fallback int64) (int64, error) {
	if raw == "" {
		return fallback, nil
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || v < 0 {
		return 0, ErrInvalid
	}
	return v, nil
}
