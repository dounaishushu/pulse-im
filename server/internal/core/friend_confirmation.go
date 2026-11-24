package core

import (
	"context"

	"github.com/jackc/pgx/v5"
)

const friendConfirmationText = "我已通过您的好友验证，现在可以发起对话"

// The friendship transaction already owns the pair/conversation locks. Store one
// server-authored message so every device sees the same confirmation in history
// and sync, including a device that was offline when the friendship was created.
func recordFriendConfirmation(ctx context.Context, tx pgx.Tx, cid, peer string) error {
	mid, request := newID(), "friend-accepted:"+newID()
	var eventSeq int64
	if err := tx.QueryRow(ctx, `WITH advanced AS (
		UPDATE pulse.conversations SET message_seq=message_seq+1,event_seq=event_seq+1,updated_at=now()
		WHERE id=$2 AND kind='direct' AND active RETURNING message_seq,event_seq
	) INSERT INTO pulse.messages(id,conversation_id,seq,event_seq,sender_id,request_id,request_hash,body,kind,content)
		SELECT $1,$2,message_seq,event_seq,$3,$4,$5,$6,'system','{"kind":"friend_accepted"}'::jsonb
		FROM advanced RETURNING event_seq`, mid, cid, peer, request, digest(request), friendConfirmationText).Scan(&eventSeq); err != nil {
		return err
	}
	// Reopen the newly established chat without resetting either user's history,
	// remark, mute, pin, clear or receipt state. Replaying an add never gets here.
	if _, err := tx.Exec(ctx, `UPDATE pulse.user_states st SET hidden=false,preference_version=preference_version+1
		WHERE st.conversation_id=$1 AND st.hidden AND EXISTS(SELECT 1 FROM pulse.members m
		WHERE m.conversation_id=st.conversation_id AND m.user_id=st.user_id AND m.active)`, cid); err != nil {
		return err
	}
	return recordEvent(ctx, tx, cid, eventSeq, "message.created", mid)
}
