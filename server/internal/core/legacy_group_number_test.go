package core

import "testing"

func TestImportedGroupNumberStillResolvesAfterCutover(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "legacy number", nil)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('conversation',12345,$1)", group.ID)
	var joined struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/groups/join-by-number", f.bob.Token,
		map[string]string{"number": "12345", "invite_code": group.InviteCode}, 200, &joined)
	if joined.ID != group.ID {
		t.Fatalf("old group number resolved incorrectly: %+v", joined)
	}
	f.request(t, "POST", "/api/v2/groups/join-by-number", f.carol.Token,
		map[string]string{"number": "00012345", "invite_code": group.InviteCode}, 400, nil)
}

func TestChannelFollowByLegacyNumberAndInviteCode(t *testing.T) {
	f := newFixture(t)
	var channel GroupCreated
	f.request(t, "POST", "/api/v2/channels", f.alice.Token, map[string]string{"title": "Public channel"}, 201, &channel)
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('conversation',54321,$1)", channel.ID)
	var joined struct {
		ID string `json:"id"`
	}
	f.request(t, "POST", "/api/v2/channels/follow", f.bob.Token, map[string]string{"conversation_id": "54321"}, 403, nil)
	f.request(t, "POST", "/api/v2/channels/follow", f.bob.Token, map[string]string{"conversation_id": "54321", "invite_code": channel.InviteCode}, 200, &joined)
	if joined.ID != channel.ID {
		t.Fatalf("channel number resolved incorrectly: %+v", joined)
	}
	f.request(t, "POST", "/api/v2/channels/follow", f.carol.Token, map[string]string{"invite_code": channel.InviteCode}, 200, &joined)
	if joined.ID != channel.ID {
		t.Fatalf("channel invite resolved incorrectly: %+v", joined)
	}
	if _, err := f.service.Send(f.ctx, f.bob.Identity, channel.ID, SendInput{RequestID: "channel-follow-read-only", Body: "not allowed"}); err == nil {
		t.Fatal("channel follower unexpectedly gained publisher permission")
	}
}
