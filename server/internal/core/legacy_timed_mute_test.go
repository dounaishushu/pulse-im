package core

import (
	"errors"
	"testing"
)

func TestImportedTimedMuteExpiresAndPermanentControlSupersedesIt(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "legacy mute", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.members SET muted_until=now()+interval '1 hour' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "timed-denied", Body: "blocked"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("active old mute was ignored: %v", err)
	}
	if err = f.service.SetGroupMute(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, true); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.members SET muted_until=now()-interval '1 hour' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "permanent-denied", Body: "still blocked"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("permanent mute was lost when old timer expired: %v", err)
	}
	if err = f.service.SetGroupMute(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "mute-released", Body: "allowed"}); err != nil {
		t.Fatalf("unmuted member remained blocked: %v", err)
	}
}
