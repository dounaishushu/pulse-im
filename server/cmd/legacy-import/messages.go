package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

func importMessages(ctx context.Context, i *importer) error {
	rows, err := i.source.QueryContext(ctx, `SELECT id,conversation_id,sender_id,type,request_id,
 body_json,created_at,recalled_at,edited_at FROM messages ORDER BY conversation_id,id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var currentConversation, sequence int64
	flush := func() error {
		if currentConversation == 0 {
			return nil
		}
		_, e := i.target.Exec(ctx, `UPDATE pulse.conversations SET message_seq=$2,event_seq=$2 WHERE id=$1`,
			legacyUUID("conversation", currentConversation), sequence)
		return e
	}
	for rows.Next() {
		var id, cid, sender int64
		var kind, request string
		var raw []byte
		var created time.Time
		var recalled, edited sql.NullTime
		if err = rows.Scan(&id, &cid, &sender, &kind, &request, &raw, &created, &recalled, &edited); err != nil {
			return err
		}
		if id <= 0 || cid <= 0 || sender <= 0 || len(request) == 0 || len(request) > 80 || !json.Valid(raw) {
			return fmt.Errorf("legacy message %d has invalid required fields", id)
		}
		if currentConversation != cid {
			if err = flush(); err != nil {
				return err
			}
			currentConversation = cid
			sequence = 0
		}
		sequence++
		switch kind {
		case "voice":
			kind = "audio"
		case "contact_card":
			kind = "contact"
		case "text", "image", "video", "file", "shake", "system":
		default:
			return fmt.Errorf("legacy message %d has unsupported kind", id)
		}
		i.messageIDs[id] = messageKey{Conversation: cid, Sequence: sequence, Sender: sender, Kind: kind}
		i.conversationMessageIDs[cid] = append(i.conversationMessageIDs[cid], id)
		var content map[string]any
		if err = json.Unmarshal(raw, &content); err != nil {
			return fmt.Errorf("legacy message %d JSON: %w", id, err)
		}
		if kind == "image" {
			for _, field := range []string{"url", "image_url", "original_url"} {
				if value, ok := content[field].(string); ok && value != "" {
					if previous, seen := i.imageURLMessageIDs[value]; seen && previous != id {
						// A repeated URL cannot identify one archived message. Dispatch
						// may use only a URL with one unambiguous old message.
						i.imageURLMessageIDs[value] = 0
						continue
					}
					i.imageURLMessageIDs[value] = id
				}
			}
		}
		body, _ := content["text"].(string)
		managerOnly := kind == "system" && content["kind"] == "group_invite"
		updated := created
		version := int64(1)
		if edited.Valid {
			version = 2
			if edited.Time.After(updated) {
				updated = edited.Time
			}
		}
		revoked := recalled.Valid
		if revoked {
			if recalled.Time.After(updated) {
				updated = recalled.Time
			}
			body = ""
			content = map[string]any{}
		}
		if kind == "contact" {
			if oldUser, ok := content["user_id"].(float64); ok && oldUser > 0 && oldUser == float64(int64(oldUser)) {
				content["user_id"] = legacyUUID("user", int64(oldUser))
			}
		}
		encoded, err := json.Marshal(content)
		if err != nil {
			return err
		}
		_, err = i.target.Exec(ctx, `INSERT INTO pulse.messages(
 id,conversation_id,seq,event_seq,sender_id,request_id,request_hash,body,revoked,
 version,created_at,updated_at,kind,content,imported_legacy,manager_only)
 VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true,$14)`,
			legacyUUID("message", id), legacyUUID("conversation", cid), sequence, legacyUUID("user", sender),
			request, legacyDigest(kind+":"+string(raw)), body, revoked, version, created, updated, kind, encoded, managerOnly)
		if err != nil {
			return fmt.Errorf("legacy message %d: %w", id, err)
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.legacy_message_bodies(message_id,body_json)
 VALUES($1,$2)`, legacyUUID("message", id), json.RawMessage(raw)); err != nil {
			return err
		}
		eventKind := "message.created"
		if revoked {
			eventKind = "message.revoked"
		}
		if _, err = i.target.Exec(ctx, `INSERT INTO pulse.events(conversation_id,seq,kind,message_id,created_at)
 VALUES($1,$2,$3,$4,$5)`, legacyUUID("conversation", cid), sequence, eventKind, legacyUUID("message", id), updated); err != nil {
			return err
		}
		if err = i.addID(ctx, "message", id); err != nil {
			return err
		}
		i.counts["messages"]++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if err = flush(); err != nil {
		return err
	}
	// Import is a historical snapshot, not a new burst of push notifications.
	_, err = i.target.Exec(ctx, "DELETE FROM pulse.push_jobs")
	return err
}
