package core

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// Exercise the same minutes payload used by the PC member menu and exceptions
// editor, rather than relying only on imported rows or the legacy bool payload.
func TestIndividualGroupMuteBlocksDeliveryAcrossRolesAndDurations(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "single member mute", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/v2/groups/" + group.ID
	sendPath := "/api/v2/conversations/" + group.ID + "/messages"
	before, err := f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "mute-before", Body: "original message"})
	if err != nil {
		t.Fatal(err)
	}
	for _, role := range []string{"member", "admin"} {
		if err = f.service.SetGroupRole(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, role); err != nil {
			t.Fatal(err)
		}
		for _, minutes := range []int{-1, 30} {
			name := fmt.Sprintf("%s-%d", role, minutes)
			f.request(t, "PUT", path+"/members/"+f.bob.UserID+"/muted", f.alice.Token, map[string]int{"minutes": minutes}, 204, nil)
			var permanent, timed bool
			if err = f.store.Pool.QueryRow(f.ctx, `SELECT muted,COALESCE(muted_until>clock_timestamp(),false) FROM pulse.members WHERE conversation_id=$1 AND user_id=$2`, group.ID, f.bob.UserID).Scan(&permanent, &timed); err != nil {
				t.Fatal(err)
			}
			if permanent != (minutes == -1) || timed != (minutes > 0) {
				t.Fatal("mute write did not persist the requested duration")
			}
			var details GroupDetails
			f.request(t, "GET", path, f.bob.Token, nil, 200, &details)
			if !details.MyMuted {
				t.Fatal("muted member profile reported permission to speak")
			}
			access, e := f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
			if e != nil || access.CanSend || access.Reason != "member_mute" {
				t.Fatal("access endpoint ignored the individual mute", e)
			}
			rows, e := f.service.ClientConversations(f.ctx, f.bob.Identity, "", group.ID)
			if e != nil || len(rows) != 1 || rows[0].CanSend || !rows[0].Muted {
				t.Fatal("conversation metadata ignored the individual mute", e)
			}
			for i, input := range []SendInput{
				{Body: "new text"},
				{Body: "reply while muted", ReplyToID: before.Message.ID},
				{SourceMessageID: before.Message.ID},
			} {
				input.RequestID = fmt.Sprintf("muted-%s-%d", name, i)
				f.request(t, "POST", sendPath, f.bob.Token, input, 403, nil)
			}
			if _, e = f.service.MutateMessage(f.ctx, f.bob.Identity, group.ID, before.Message.ID, "edit while muted", 1, false); !errors.Is(e, ErrForbidden) {
				t.Fatal("editing bypassed a member mute", e)
			}
			// This is a group-local restriction, not a ban on another member or DM.
			if _, e = f.service.Send(f.ctx, f.carol.Identity, group.ID, SendInput{RequestID: "other-" + name, Body: "other member allowed"}); e != nil {
				t.Fatal("mute affected a different group member", e)
			}
			if _, e = f.service.Send(f.ctx, f.bob.Identity, f.cid, SendInput{RequestID: "direct-" + name, Body: "direct chat allowed"}); e != nil {
				t.Fatal("group mute affected direct messages", e)
			}
			f.request(t, "PUT", path+"/members/"+f.bob.UserID+"/muted", f.alice.Token, map[string]int{"minutes": 0}, 204, nil)
		}
	}
	var sent int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1 AND sender_id=$2 AND kind<>'system'", group.ID, f.bob.UserID).Scan(&sent); err != nil || sent != 1 {
		t.Fatal("a blocked request created a message", err)
	}
	f.request(t, "POST", sendPath, f.bob.Token, SendInput{RequestID: "mute-removed", Body: "unmuted message"}, 201, nil)
}

func TestIndividualTimedGroupMuteExpiresWithoutLeavingFalseRestriction(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "timed member mute", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, "PUT", "/api/v2/groups/"+group.ID+"/members/"+f.bob.UserID+"/muted", f.alice.Token, map[string]int{"minutes": 1}, 204, nil)
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "before-expiry", Body: "blocked"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("timed mute did not block delivery", err)
	}
	f.exec(t, "UPDATE pulse.members SET muted_until=$3 WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID, time.Now().Add(-time.Minute))
	access, err := f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || !access.CanSend {
		t.Fatal("expired restriction still blocked the member", err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "after-expiry", Body: "allowed after expiry"}); err != nil {
		t.Fatal(err)
	}
}
