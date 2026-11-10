package core

import (
	"errors"
	"testing"
)

func TestPersonalDeletionClearAndUnreadAreIsolated(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "personal-1", "visible to both")
	second := f.send(t, "personal-2", "also visible")
	count, err := f.service.Unread(f.ctx, f.bob.Identity, f.cid, 1)
	if err != nil || count.Count != 1 || !count.Truncated {
		t.Fatalf("capped unread: %+v %v", count, err)
	}
	state, err := f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{first.ID})
	if err != nil || state.PersonalSeq != 1 {
		t.Fatalf("personal delete: %+v %v", state, err)
	}
	state, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{first.ID})
	if err != nil || state.PersonalSeq != 1 {
		t.Fatal("retry created another personal event")
	}
	page, err := f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != second.ID {
		t.Fatalf("recipient visibility: %+v %v", page, err)
	}
	page, err = f.service.Sync(f.ctx, f.alice.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 2 {
		t.Fatal("one user's deletion affected the sender")
	}
	personal, err := f.service.PersonalSync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(personal.Events) != 1 || personal.Events[0].MessageID != first.ID {
		t.Fatalf("personal recovery: %+v %v", personal, err)
	}
	if _, err = f.service.PersonalSync(f.ctx, f.alice.Identity, f.cid, 0, nil, 100); err != nil {
		t.Fatal(err)
	}
	state, err = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, second.Seq)
	if err != nil || state.ClearSeq != 2 || state.PersonalSeq != 2 {
		t.Fatalf("clear: %+v %v", state, err)
	}
	state, err = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, second.Seq)
	if err != nil || state.PersonalSeq != 2 {
		t.Fatal("repeated clear was not idempotent")
	}
	page, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 0 || page.NextAfterSeq != 2 {
		t.Fatal("cleared history leaked")
	}
	count, err = f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || count.Count != 0 {
		t.Fatalf("cleared unread: %+v %v", count, err)
	}
	third := f.send(t, "personal-3", "new message")
	page, err = f.service.Sync(f.ctx, f.bob.Identity, f.cid, 2, nil, 100)
	if err != nil || len(page.Events) != 1 || page.Events[0].Message.ID != third.ID {
		t.Fatal("clear hid a subsequent message")
	}
	if _, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{first.ID}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cleared message deletion accepted: %v", err)
	}
}

func TestPersonalSyncIsPrivatePagedAndNotified(t *testing.T) {
	f := newFixture(t)
	bobSocket := f.ws(t, f.bob)
	aliceSocket := f.ws(t, f.alice)
	message := f.send(t, "personal-source", "private")
	if _, err := f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	_ = readHint(t, bobSocket)
	_ = readHint(t, aliceSocket)
	state, err := f.service.SetReminder(f.ctx, f.bob.Identity, f.cid, true)
	if err != nil || !state.Reminder || state.PersonalSeq != 1 {
		t.Fatal("reminder not set")
	}
	state, err = f.service.SetReminder(f.ctx, f.bob.Identity, f.cid, true)
	if err != nil || state.PersonalSeq != 1 {
		t.Fatal("same reminder generated another event")
	}
	_, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{message.ID})
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.PersonalSync(f.ctx, f.bob.Identity, f.cid, 0, nil, 1)
	if err != nil || len(page.Events) != 1 || !page.HasMore || page.SnapshotMaxSeq != 2 {
		t.Fatalf("first personal page: %+v %v", page, err)
	}
	upper := page.SnapshotMaxSeq
	page, err = f.service.PersonalSync(f.ctx, f.bob.Identity, f.cid, page.NextAfterSeq, &upper, 1)
	if err != nil || len(page.Events) != 1 || page.HasMore || page.Events[0].MessageID != message.ID {
		t.Fatalf("second personal page: %+v %v", page, err)
	}
	if _, err = f.service.DispatchOnce(f.ctx, f.hub); err != nil {
		t.Fatal(err)
	}
	if hint := readHint(t, bobSocket); hint.Type != "personal.changed" || hint.UserID != f.bob.UserID {
		t.Fatalf("targeted hint: %+v", hint)
	}
	// No private hint is sent to Alice; her own personal cursor stays at zero.
	states, err := f.service.States(f.ctx, f.alice.Identity, f.cid, "")
	if err != nil || len(states) != 1 || states[0].PersonalSeq != 0 {
		t.Fatal("personal state leaked to other member")
	}
	if _, err = f.service.PersonalSync(f.ctx, f.carol.Identity, f.cid, 0, nil, 10); !errors.Is(err, ErrForbidden) {
		t.Fatal("nonmember can sync personal history")
	}
}

func TestUnreadExcludesSelfRevokedAndDeleted(t *testing.T) {
	f := newFixture(t)
	f.send(t, "self", "Alice's message")
	bobMessage, err := f.service.Send(f.ctx, f.bob.Identity, f.cid, SendInput{RequestID: "bob-own", Body: "Bob's own message"})
	if err != nil {
		t.Fatal(err)
	}
	count, err := f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || count.Count != 1 {
		t.Fatal("own message counted as unread")
	}
	if _, err = f.service.DeletePersonalMessages(f.ctx, f.bob.Identity, f.cid, []string{bobMessage.Message.ID}); err != nil {
		t.Fatal(err)
	}
	count, err = f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || count.Count != 1 {
		t.Fatal("personal deletion changed unrelated unread")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	var id string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT id::text FROM pulse.messages WHERE request_id='self'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.MutateMessage(f.ctx, f.alice.Identity, f.cid, id, "", 0, true); err != nil {
		t.Fatal(err)
	}
	count, err = f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || count.Count != 0 {
		t.Fatal("revoked message still counted as unread")
	}
}
