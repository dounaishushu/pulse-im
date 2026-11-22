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

func TestGroupInvitationPinsTrackViewerWithoutMessageHistory(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "invitation pins", nil)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, `INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid)) ON CONFLICT DO NOTHING`, f.alice.UserID, f.bob.UserID)
	type candidate struct {
		ID           string `json:"id"`
		Pinned       *bool  `json:"pinned"`
		LastActivity string `json:"last_activity"`
	}
	read := func() map[string]candidate {
		t.Helper()
		var result struct {
			Items []candidate `json:"items"`
		}
		f.request(t, "GET", "/api/v2/groups/"+group.ID+"/invite-candidates", f.alice.Token, nil, 200, &result)
		people := make(map[string]candidate)
		for _, row := range result.Items {
			if row.Pinned == nil {
				t.Fatal("candidate pin state omitted", row.ID)
			}
			people[row.ID] = row
		}
		return people
	}
	check := func(pinned bool, activity string) {
		t.Helper()
		row, exists := read()[f.bob.UserID]
		if !exists || *row.Pinned != pinned || row.LastActivity != activity {
			t.Fatalf("wrong candidate pin/history: %+v; wanted pinned=%v activity=%q", row, pinned, activity)
		}
	}
	f.exec(t, "UPDATE pulse.user_states SET pinned=true WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	check(true, "")
	// The other participant's preference must never become the viewer's pin.
	f.exec(t, "UPDATE pulse.user_states SET pinned=(user_id=$2) WHERE conversation_id=$1", f.cid, f.bob.UserID)
	check(false, "")
	f.exec(t, "UPDATE pulse.user_states SET pinned=true WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	message := f.send(t, "invite-pin-cleared", "cleared private history")
	f.clearHistoryAsStaff(t, f.ctx, f.alice.Identity, f.cid, message.Seq)
	check(true, "")
	// A known contact remains eligible, but hidden conversation preferences and
	// history must not leak into the invitation list.
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	check(false, "")
	f.exec(t, "UPDATE pulse.user_states SET hidden=false WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.bob.UserID)
	if _, exists := read()[f.bob.UserID]; exists {
		t.Fatal("pinned frozen user was made eligible")
	}
	f.exec(t, "UPDATE pulse.users SET active=true WHERE id=$1", f.bob.UserID)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.alice.UserID, f.bob.UserID)
	if _, exists := read()[f.bob.UserID]; exists {
		t.Fatal("pinned blocked user was made eligible")
	}
	f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", f.alice.UserID, f.bob.UserID)
	if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	if _, exists := read()[f.bob.UserID]; exists {
		t.Fatal("pinned existing member was made eligible")
	}
}
