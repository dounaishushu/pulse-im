package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"time"
)

func importUsers(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT u.id,u.username,u.phone,u.public_id,u.nickname,u.password_hash,
 u.status,u.created_at,u.updated_at,u.birthday,u.birthday_change_count,u.gender,u.signature,u.register_ip,u.avatar_url,
 COALESCE(p.muted,0),COALESCE(p.allow_add_friend,1),COALESCE(p.allow_create_group,0),
 COALESCE(p.internal_staff,0),COALESCE(p.formal_employee,0),COALESCE(p.allow_view_devices,0),
 v.last_seen_at
 FROM users u LEFT JOIN user_permissions p ON p.user_id=u.id
 LEFT JOIN user_presence v ON v.user_id=u.id ORDER BY u.id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var account, phone, public, gender, signature, ip, avatar sql.NullString
		var birthday sql.NullTime
		var nickname, hash, status string
		var created, updated time.Time
		var birthChanges int
		var muted, addFriend, createGroup, staff, formal, viewDevices bool
		var seen sql.NullTime
		if err = rows.Scan(&id, &account, &phone, &public, &nickname, &hash,
			&status, &created, &updated, &birthday, &birthChanges, &gender, &signature, &ip, &avatar,
			&muted, &addFriend, &createGroup, &staff, &formal, &viewDevices, &seen); err != nil {
			return err
		}
		if id <= 0 || len(nickname) > 256 || hash == "" {
			return fmt.Errorf("legacy user %d has invalid required fields", id)
		}
		name := strings.ToLower(strings.TrimSpace(nullString(account)))
		internal := name == ""
		if internal {
			name = fmt.Sprintf("__phone_only__legacy%d", id)
		} else if !validOldAccount(name) {
			return fmt.Errorf("legacy user %d has an unrepresentable account", id)
		}
		active := status == "active"
		if status != "active" && status != "frozen" && status != "deleted" {
			return fmt.Errorf("legacy user %d has unknown status", id)
		}
		var deleted any
		if status == "deleted" {
			deleted = updated
		}
		var registrationIP any
		if raw := nullString(ip); raw != "" {
			if net.ParseIP(raw) == nil {
				return fmt.Errorf("legacy user %d has invalid registration IP", id)
			}
			registrationIP = raw
		}
		var oldGender string
		switch nullString(gender) {
		case "", "保密", "unspecified":
			oldGender = "unspecified"
		case "男", "male":
			oldGender = "male"
		case "女", "female":
			oldGender = "female"
		default:
			return fmt.Errorf("legacy user %d has unknown gender", id)
		}
		var birth any
		if birthday.Valid && birthday.Time.Year() >= 1000 {
			birth = birthday.Time
		}
		if birthChanges < 0 || birthChanges > 1 {
			return fmt.Errorf("legacy user %d has invalid birthday change count", id)
		}
		lastActive := created
		if seen.Valid && seen.Time.After(lastActive) {
			lastActive = seen.Time
		}
		changes := 1
		if internal {
			changes = 0
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.users(
 id,account,account_is_internal,password_hash,active,can_send,internal_staff,created_at,
 nickname,phone,birthday,birthday_change_count,gender,bio,registration_ip,last_active_at,
 deleted_at,can_add_friends,can_create_group,formal_employee,can_view_devices,
 legacy_public_id,account_changes,legacy_avatar_url)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14,$15,$16,
 $17,$18,$19,$20,$21,$22,$23,$24)`,
			legacyUUID("user", id), name, internal, hash, active, !muted, staff, created,
			nickname, nullOrString(phone), birth, birthChanges, oldGender, nullString(signature), registrationIP,
			lastActive, deleted, addFriend, createGroup, formal, viewDevices, nullOrString(public), changes, nullOrString(avatar))
		if err != nil {
			return fmt.Errorf("legacy user %d: %w", id, err)
		}
		if err = i.addID(ctx, "user", id); err != nil {
			return err
		}
		i.counts["users"]++
	}
	return rows.Err()
}

func importUserSettings(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, "SELECT user_id,settings_json FROM user_settings ORDER BY user_id")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		var raw []byte
		if err = rows.Scan(&userID, &raw); err != nil {
			return err
		}
		var value struct {
			Phone          string             `json:"phone_visibility"`
			PhoneSearch    string             `json:"phone_search_visibility"`
			LastSeen       string             `json:"last_seen_visibility"`
			VoiceCall      string             `json:"voice_call_visibility"`
			VoiceP2P       string             `json:"voice_call_peer_to_peer"`
			Invite         string             `json:"invite_visibility"`
			ShowSessions   *bool              `json:"show_active_sessions"`
			AutoDeleteDays *int               `json:"account_auto_delete_days"`
			Exceptions     map[string][]int64 `json:"privacy_exceptions"`
		}
		if err = json.Unmarshal(raw, &value); err != nil {
			return fmt.Errorf("settings for legacy user %d: %w", userID, err)
		}
		setDefault := func(v, fallback string) string {
			if v == "" {
				return fallback
			}
			return v
		}
		value.Phone = setDefault(value.Phone, "nobody")
		value.PhoneSearch = setDefault(value.PhoneSearch, "everyone")
		value.LastSeen = setDefault(value.LastSeen, "everyone")
		value.VoiceCall = setDefault(value.VoiceCall, "everyone")
		value.VoiceP2P = setDefault(value.VoiceP2P, "everyone")
		value.Invite = setDefault(value.Invite, "everyone")
		show := true
		if value.ShowSessions != nil {
			show = *value.ShowSessions
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.privacy_settings(
 user_id,temporary_chat,group_invites,phone,last_seen,phone_search,voice_call,
 voice_call_peer_to_peer,show_active_sessions,imported_legacy)
 VALUES($1,'everyone',$2,$3,$4,$5,$6,$7,$8,true)`, legacyUUID("user", userID), value.Invite,
			value.Phone, value.LastSeen, value.PhoneSearch, value.VoiceCall, value.VoiceP2P, show)
		if err != nil {
			return fmt.Errorf("settings for legacy user %d: %w", userID, err)
		}
		if value.AutoDeleteDays != nil {
			days := *value.AutoDeleteDays
			if days != 0 && days != 30 && days != 90 && days != 180 && days != 365 {
				return fmt.Errorf("settings for legacy user %d have invalid retention", userID)
			}
			if _, err = i.target.Exec(ctx, "UPDATE pulse.users SET inactivity_days=$2 WHERE id=$1", legacyUUID("user", userID), days); err != nil {
				return err
			}
		}
		for oldKey, mapping := range map[string]struct{ scope, effect string }{
			"phone_visibility_always": {"phone", "allow"},
			"phone_search_always":     {"phone_search", "allow"},
			"last_seen_never":         {"last_seen", "deny"},
			"voice_call_never":        {"voice_call", "deny"},
			"invite_never":            {"group_invites", "deny"},
		} {
			for _, peerID := range value.Exceptions[oldKey] {
				if peerID <= 0 || peerID == userID {
					return fmt.Errorf("settings for legacy user %d contain invalid exception", userID)
				}
				if _, err = i.target.Exec(ctx, `INSERT INTO pulse.privacy_exceptions(user_id,scope,peer_id,effect)
 VALUES($1,$2,$3,$4) ON CONFLICT(user_id,scope,peer_id) DO NOTHING`, legacyUUID("user", userID), mapping.scope, legacyUUID("user", peerID), mapping.effect); err != nil {
					return err
				}
			}
		}
		i.counts["user_settings"]++
	}
	return rows.Err()
}

func importUserSecurity(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, "SELECT user_id,two_step_hash,recovery_hashes FROM user_security ORDER BY user_id")
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var hash string
		var raw []byte
		if err = rows.Scan(&id, &hash, &raw); err != nil {
			return err
		}
		var recovery []string
		if err = json.Unmarshal(raw, &recovery); err != nil || hash == "" {
			return fmt.Errorf("security record for legacy user %d cannot be imported", id)
		}
		if _, err = i.target.Exec(ctx, "INSERT INTO pulse.security(user_id,password_hash,recovery_hashes) VALUES($1,$2,$3)", legacyUUID("user", id), hash, recovery); err != nil {
			return err
		}
		i.counts["user_security"]++
	}
	return rows.Err()
}
