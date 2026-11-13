package core

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

var requestPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)

const messageColumns = `id::text,conversation_id::text,seq,event_seq,sender_id::text,request_id,
    CASE WHEN revoked THEN '' ELSE body END,revoked,version,created_at,updated_at,kind,CASE WHEN revoked THEN '{}'::jsonb ELSE content END,COALESCE(reply_to::text,'')`

type scanner interface{ Scan(...any) error }

func scanMessage(row scanner, m *Message, extra ...any) error {
	args := []any{&m.ID, &m.ConversationID, &m.Seq, &m.EventSeq, &m.SenderID, &m.RequestID, &m.Body, &m.Revoked, &m.Version, &m.CreatedAt, &m.UpdatedAt, &m.Kind, &m.Content, &m.ReplyToID}
	if err := row.Scan(append(args, extra...)...); err != nil {
		return err
	}
	m.CreatedAt = m.CreatedAt.UTC()
	m.UpdatedAt = m.UpdatedAt.UTC()
	return nil
}
func validText(value string, minimum, maximum int) bool {
	length := utf8.RuneCountInString(value)
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && length >= minimum && length <= maximum
}
func validBody(body string) bool {
	return validText(body, 1, 5000) && strings.TrimSpace(body) != ""
}
func (s *Service) Send(ctx context.Context, who Identity, cid string, input SendInput) (SendResult, error) {
	return s.sendTransaction(ctx, who, cid, input, nil)
}
func (s *Service) sendTransaction(ctx context.Context, who Identity, cid string, input SendInput, external pgx.Tx) (SendResult, error) {
	if err := validateSend(input); err != nil {
		return SendResult{}, err
	}
	encoded, _ := json.Marshal(input)
	requestHash := digest(string(encoded))
	tx := external
	owned := tx == nil
	var err error
	if owned {
		tx, err = s.Store.Pool.Begin(ctx)
		if err != nil {
			return SendResult{}, err
		}
		defer tx.Rollback(ctx)
	}
	commit := func() error {
		if owned {
			return tx.Commit(ctx)
		}
		return nil
	}
	if _, err = lockIdentity(ctx, tx, who); err != nil {
		return SendResult{}, err
	}
	if err = lockSendExecution(ctx, tx, who); err != nil {
		return SendResult{}, err
	}
	ids := []string{cid}
	if input.SourceMessageID != "" {
		var sourceID string
		err = tx.QueryRow(ctx, `SELECT msg.conversation_id::text FROM pulse.messages msg
            JOIN pulse.members m ON m.conversation_id=msg.conversation_id AND m.user_id=$2 AND m.active
            WHERE msg.id=$1`, input.SourceMessageID, who.UserID).Scan(&sourceID)
		if errors.Is(err, pgx.ErrNoRows) {
			return SendResult{}, ErrForbidden
		}
		if err != nil {
			return SendResult{}, err
		}
		ids = append(ids, sourceID)
	}
	if err = lockDirectConversations(ctx, tx, ids); err != nil {
		return SendResult{}, err
	}
	if err = lockConversations(ctx, tx, ids); err != nil {
		return SendResult{}, err
	}
	if _, err = authorize(ctx, tx, who, cid, true); err != nil {
		return SendResult{}, err
	}
	var m Message
	var priorHash []byte
	err = scanMessage(tx.QueryRow(ctx, "SELECT "+messageColumns+",request_hash FROM pulse.messages WHERE conversation_id=$1 AND sender_id=$2 AND request_id=$3", cid, who.UserID, input.RequestID), &m, &priorHash)
	if err == nil {
		if !bytes.Equal(priorHash, requestHash) {
			return SendResult{}, ErrConflict
		}
		// A retry does not expose content that this user has since cleared/deleted.
		var visible bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pulse.members mm JOIN pulse.user_states st
            ON st.conversation_id=mm.conversation_id AND st.user_id=mm.user_id
            WHERE mm.conversation_id=$1 AND mm.user_id=$2 AND $3>=mm.visible_from_seq AND $3>st.clear_seq
            AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=$4 AND d.user_id=$2))`, cid, who.UserID, m.Seq, m.ID).Scan(&visible)
		if err != nil {
			return SendResult{}, err
		}
		if !visible {
			m.Body = ""
			m.Content = []byte("{}")
			m.ReplyToID = ""
		}
		return SendResult{Message: m, Duplicate: true}, commit()
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return SendResult{}, err
	}
	body := input.Body
	kind := input.Kind
	if kind == "" {
		kind = "text"
	}
	content := []byte("{}")
	replyID := input.ReplyToID
	if input.SourceMessageID != "" {
		err = tx.QueryRow(ctx, `SELECT msg.body,msg.kind,msg.content FROM pulse.messages msg
            JOIN pulse.conversations c ON c.id=msg.conversation_id AND c.active
            JOIN pulse.members mm ON mm.conversation_id=c.id AND mm.user_id=$2 AND mm.active
            JOIN pulse.user_states st ON st.conversation_id=c.id AND st.user_id=$2
            WHERE msg.id=$1 AND NOT msg.revoked AND msg.seq>=mm.visible_from_seq AND msg.seq>st.clear_seq
            AND NOT EXISTS(SELECT 1 FROM pulse.message_deletions d WHERE d.message_id=msg.id AND d.user_id=$2)`, input.SourceMessageID, who.UserID).Scan(&body, &kind, &content)
		if errors.Is(err, pgx.ErrNoRows) {
			return SendResult{}, ErrForbidden
		}
		if err != nil {
			return SendResult{}, err
		}
	}
	if input.SourceMessageID == "" {
		content, err = s.resolveContent(ctx, tx, who, cid, kind, input)
		if err != nil {
			return SendResult{}, err
		}
	} else {
		content, err = forwardContent(content, kind)
		if err != nil {
			return SendResult{}, err
		}
	}
	if kind == "file" {
		access, e := authorize(ctx, tx, who, cid, true)
		if e != nil {
			return SendResult{}, e
		}
		if access.Kind == "group" || access.Kind == "channel" {
			return SendResult{}, ErrForbidden
		}
	}
	body, err = s.filterText(ctx, tx, body)
	if err != nil {
		return SendResult{}, err
	}
	var seq, eventSeq int64
	err = tx.QueryRow(ctx, `UPDATE pulse.conversations SET message_seq=message_seq+1,event_seq=event_seq+1,updated_at=now()
        WHERE id=$1 RETURNING message_seq,event_seq`, cid).Scan(&seq, &eventSeq)
	if err != nil {
		return SendResult{}, err
	}
	err = scanMessage(tx.QueryRow(ctx, `INSERT INTO pulse.messages(id,conversation_id,seq,event_seq,sender_id,request_id,request_hash,body,kind,content,reply_to)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+messageColumns, newID(), cid, seq, eventSeq, who.UserID, input.RequestID, requestHash, body, kind, content, optionalUUID(replyID)), &m)
	if err != nil {
		return SendResult{}, err
	}
	if err = storeMessageReferences(ctx, tx, m, input); err != nil {
		return SendResult{}, err
	}
	if err = recordEvent(ctx, tx, cid, eventSeq, "message.created", m.ID); err != nil {
		return SendResult{}, err
	}
	if err = commit(); err != nil {
		return SendResult{}, err
	}
	if owned {
		s.notify()
	}
	return SendResult{Message: m}, nil
}
func recordEvent(ctx context.Context, tx pgx.Tx, cid string, seq int64, kind, mid string) error {
	if _, err := tx.Exec(ctx, "INSERT INTO pulse.events(conversation_id,seq,kind,message_id) VALUES($1,$2,$3,$4)", cid, seq, kind, mid); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, "INSERT INTO pulse.outbox(id,conversation_id,event_seq,kind) VALUES($1,$2,$3,'conversation.changed')", newID(), cid, seq)
	return err
}
func (s *Service) MutateMessage(ctx context.Context, who Identity, cid, mid, body string, expected int64, revoke bool) (Message, error) {
	if !revoke && (!validBody(body) || expected < 1) {
		return Message{}, ErrInvalid
	}
	tx, err := s.Store.Pool.Begin(ctx)
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback(ctx)
	internal, err := lockIdentity(ctx, tx, who)
	if err != nil {
		return Message{}, err
	}
	if err = lockDirectConversations(ctx, tx, []string{cid}); err != nil {
		return Message{}, err
	}
	if err = lockConversations(ctx, tx, []string{cid}); err != nil {
		return Message{}, err
	}
	a, err := authorize(ctx, tx, who, cid, false)
	if err != nil {
		return Message{}, err
	}
	var m Message
	err = scanMessage(tx.QueryRow(ctx, "SELECT "+messageColumns+" FROM pulse.messages WHERE id=$1 AND conversation_id=$2", mid, cid), &m)
	if errors.Is(err, pgx.ErrNoRows) {
		return m, ErrMissing
	}
	if err != nil {
		return m, err
	}
	var deleted bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pulse.message_deletions WHERE message_id=$1 AND user_id=$2)", mid, who.UserID).Scan(&deleted); err != nil {
		return m, err
	}
	if m.Seq < a.VisibleFrom || m.Seq <= a.ClearSeq || deleted || (revoke && !internal) || (!revoke && m.SenderID != who.UserID) {
		return m, ErrForbidden
	}
	if revoke && m.Revoked {
		return m, tx.Commit(ctx)
	}
	if m.Revoked || (!revoke && expected != m.Version) {
		return m, ErrConflict
	}
	if !revoke {
		if m.Kind != "text" {
			return m, ErrForbidden
		}
		if _, err = authorize(ctx, tx, who, cid, true); err != nil {
			return m, err
		}
	}
	if !revoke {
		body, err = s.filterText(ctx, tx, body)
		if err != nil {
			return m, err
		}
	}
	kind := "message.edited"
	if revoke {
		body = ""
		kind = "message.revoked"
	}
	var eventSeq int64
	if err = tx.QueryRow(ctx, "UPDATE pulse.conversations SET event_seq=event_seq+1,updated_at=now() WHERE id=$1 RETURNING event_seq", cid).Scan(&eventSeq); err != nil {
		return m, err
	}
	err = scanMessage(tx.QueryRow(ctx, `UPDATE pulse.messages SET body=$3,revoked=$4,version=version+1,updated_at=now(),event_seq=$5
        WHERE id=$1 AND conversation_id=$2 RETURNING `+messageColumns, mid, cid, body, revoke, eventSeq), &m)
	if err != nil {
		return m, err
	}
	if !revoke {
		content, ids, e := pruneMentions(ctx, tx, body, m.Content)
		if e != nil {
			return m, e
		}
		m.Content = content
		if _, err = tx.Exec(ctx, "UPDATE pulse.messages SET content=$2 WHERE id=$1", mid, content); err != nil {
			return m, err
		}
		if _, err = tx.Exec(ctx, "DELETE FROM pulse.message_mentions WHERE message_id=$1 AND NOT(user_id=ANY($2::uuid[]))", mid, ids); err != nil {
			return m, err
		}
	}
	if revoke {
		if _, err = tx.Exec(ctx, "DELETE FROM pulse.message_pins WHERE message_id=$1", mid); err != nil {
			return m, err
		}
	}
	if err = recordEvent(ctx, tx, cid, eventSeq, kind, mid); err != nil {
		return m, err
	}
	if err = tx.Commit(ctx); err != nil {
		return m, err
	}
	s.notify()
	return m, nil
}

func (s *Service) SendCompound(ctx context.Context, who Identity, cid string, input SendInput) (SendResult, error) {
	if input.Kind != "image" || input.Body == "" {
		return s.Send(ctx, who, cid, input)
	}
	tx, e := s.Store.Pool.Begin(ctx)
	if e != nil {
		return SendResult{}, e
	}
	defer tx.Rollback(ctx)
	text := SendInput{RequestID: input.RequestID + ":text", Body: input.Body}
	image := input
	image.RequestID += ":image"
	image.Body = ""
	if _, e = s.sendTransaction(ctx, who, cid, text, tx); e != nil {
		return SendResult{}, e
	}
	v, e := s.sendTransaction(ctx, who, cid, image, tx)
	if e != nil {
		return SendResult{}, e
	}
	if e = tx.Commit(ctx); e != nil {
		return SendResult{}, e
	}
	s.notify()
	return v, nil
}
