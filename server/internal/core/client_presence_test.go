package core

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestPresenceConversationIDs(t *testing.T) {
	id := "abcdef12-3456-4789-8abc-123456789abc"
	for _, invalid := range [][]string{nil, {}, {"bad"}, {id, strings.ToUpper(id)}, make([]string, 101)} {
		if _, err := presenceConversationIDs(invalid); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid batch accepted: %v", invalid)
		}
	}
	input := []string{strings.ToUpper(id)}
	result, err := presenceConversationIDs(input)
	if err != nil || !reflect.DeepEqual(result, []string{id}) || input[0] != strings.ToUpper(id) {
		t.Fatalf("normalized batch invalid or caller input mutated: %v %v", result, err)
	}
}

func TestClientConversationPresencePrivacyAndVisibility(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "presence group", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	missing := "88888888-8888-4888-8888-888888888888"
	path := "/api/v2/client/conversation-presence"
	ids := []string{f.cid, group.ID, missing}
	var result struct {
		Items   []ClientConversationPresence `json:"items"`
		Removed []string                     `json:"removed_ids"`
	}
	read := func(token string) {
		t.Helper()
		f.request(t, "POST", path, token, map[string]any{"conversation_ids": ids}, 200, &result)
	}
	f.exec(t, "UPDATE pulse.users SET last_active_at=now() WHERE id=$1", f.bob.UserID)
	read(f.alice.Token)
	if len(result.Items) != 1 || result.Items[0].PeerID != f.bob.UserID || !result.Items[0].Online || result.Items[0].LastSeenHidden || result.Items[0].LastSeen == nil || !reflect.DeepEqual(result.Removed, []string{group.ID, missing}) {
		t.Fatalf("online batch projection invalid: %+v", result)
	}
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '5 minutes' WHERE id=$1", f.bob.UserID)
	read(f.alice.Token)
	if result.Items[0].Online || result.Items[0].LastSeen == nil {
		t.Fatal("offline peer did not retain its authorized timestamp")
	}
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,last_seen) VALUES($1,'nobody') ON CONFLICT(user_id) DO UPDATE SET last_seen='nobody'", f.bob.UserID)
	read(f.alice.Token)
	if !result.Items[0].LastSeenHidden || result.Items[0].LastSeen != nil || result.Items[0].Online {
		t.Fatal("hidden last-seen leaked activity")
	}
	f.exec(t, "INSERT INTO pulse.privacy_exceptions(user_id,peer_id,scope,effect) VALUES($1,$2,'last_seen','allow')", f.bob.UserID, f.alice.UserID)
	read(f.alice.Token)
	if result.Items[0].LastSeenHidden {
		t.Fatal("explicit allow was ignored")
	}
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.alice.UserID)
	read(f.alice.Token)
	if !result.Items[0].LastSeenHidden || result.Items[0].LastSeen != nil || result.Items[0].Online {
		t.Fatal("block did not override the privacy exception")
	}
	read(f.carol.Token)
	if len(result.Items) != 0 || !reflect.DeepEqual(result.Removed, ids) {
		t.Fatal("a nonmember discovered direct-chat peer status")
	}
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", f.cid, f.alice.UserID)
	read(f.alice.Token)
	if len(result.Items) != 0 || !reflect.DeepEqual(result.Removed, ids) {
		t.Fatal("hidden conversation status leaked")
	}
	for _, invalid := range [][]string{nil, {"bad"}, {f.cid, f.cid}, make([]string, 101)} {
		f.request(t, "POST", path, f.alice.Token, map[string]any{"conversation_ids": invalid}, 400, nil)
	}
	f.request(t, "POST", path, "invalid", map[string]any{"conversation_ids": ids}, 401, nil)
}
