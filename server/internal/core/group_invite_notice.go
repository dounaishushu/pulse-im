package core

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// The invitation transaction already owns the conversation lock. These records
// are authored by the server and keep the same manager-only audience as PHP.
func recordGroupInvite(ctx context.Context, tx pgx.Tx, cid, actor, target string) error {
	var operatorName, memberName string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(NULLIF(a.nickname,''),'用户'),COALESCE(NULLIF(b.nickname,''),'用户')
		FROM pulse.users a,pulse.users b WHERE a.id=$1 AND b.id=$2`, actor, target).Scan(&operatorName, &memberName); err != nil {
		return err
	}
	request := "group-invite:" + newID()
	body := operatorName + " 邀请 " + memberName + " 加入群聊"
	content, err := json.Marshal(map[string]string{"kind": "group_invite", "operator_id": actor, "member_id": target})
	if err != nil {
		return err
	}
	var seq, eventSeq int64
	if err = tx.QueryRow(ctx, `UPDATE pulse.conversations SET message_seq=message_seq+1,event_seq=event_seq+1,updated_at=now()
		WHERE id=$1 RETURNING message_seq,event_seq`, cid).Scan(&seq, &eventSeq); err != nil {
		return err
	}
	mid := newID()
	if _, err = tx.Exec(ctx, `INSERT INTO pulse.messages(id,conversation_id,seq,event_seq,sender_id,request_id,request_hash,body,kind,content,manager_only)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,'system',$9,true)`, mid, cid, seq, eventSeq, actor, request, digest(request), body, content); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE pulse.user_states st SET hidden=false,preference_version=preference_version+1
		WHERE st.conversation_id=$1 AND st.hidden AND EXISTS(SELECT 1 FROM pulse.members m
		WHERE m.conversation_id=st.conversation_id AND m.user_id=st.user_id AND m.active AND m.role IN('owner','admin'))`, cid); err != nil {
		return err
	}
	return recordEvent(ctx, tx, cid, eventSeq, "message.created", mid)
}
