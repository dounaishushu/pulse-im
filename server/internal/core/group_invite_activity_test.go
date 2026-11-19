package core

import (
	"testing"
	"time"
)

func TestGroupInvitationActivityUsesVisiblePrivateMessages(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "invitation recency", nil)
	if err != nil {
		t.Fatal(err)
	}
	carolChat, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	bob := f.send(t, "invite-order-bob", "older private message")
	carol, err := f.service.Send(f.ctx, f.carol.Identity, carolChat, SendInput{RequestID: "invite-order-carol", Body: "newer private message"})
	if err != nil {
		t.Fatal(err)
	}
	older := time.Date(2026, 11, 19, 1, 0, 0, 1000, time.UTC)
	newer := older.Add(time.Microsecond)
	f.exec(t, "UPDATE pulse.messages SET created_at=$2 WHERE id=$1", bob.ID, older)
	f.exec(t, "UPDATE pulse.messages SET created_at=$2 WHERE id=$1", carol.Message.ID, newer)
	read := func() map[string]string {
		t.Helper()
		var result struct {
			Items []struct {
				ID           string `json:"id"`
				LastActivity string `json:"last_activity"`
			} `json:"items"`
		}
		f.request(t, "GET", "/api/v2/groups/"+group.ID+"/invite-candidates", f.alice.Token, nil, 200, &result)
		out := make(map[string]string)
		for _, person := range result.Items {
			out[person.ID] = person.LastActivity
		}
		return out
	}
	activity := read()
	if activity[f.bob.UserID] != older.Format(time.RFC3339Nano) || activity[f.carol.UserID] != newer.Format(time.RFC3339Nano) {
		t.Fatal("missing precise latest-message activity", activity)
	}
	// Reading a message or changing a conversation timestamp must not move users.
	f.exec(t, "UPDATE pulse.conversations SET updated_at=now() WHERE id=$1", f.cid)
	if got := read(); got[f.bob.UserID] != activity[f.bob.UserID] || got[f.carol.UserID] != activity[f.carol.UserID] {
		t.Fatal("conversation metadata changed message ordering", got)
	}
	f.clearHistoryAsStaff(t, f.ctx, f.alice.Identity, f.cid, bob.Seq)
	if got := read(); got[f.bob.UserID] != "" || got[f.carol.UserID] != activity[f.carol.UserID] {
		t.Fatal("cleared history leaked through invitation activity", got)
	}
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", carolChat, f.alice.UserID)
	if got := read(); got[f.carol.UserID] != "" {
		t.Fatal("hidden conversation activity was exposed", got)
	}
}
