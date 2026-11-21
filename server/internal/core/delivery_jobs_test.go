package core

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestQueuedForwardRetryCancelAndDispatchPermission(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	first, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "source-1", Body: "first"})
	if e != nil {
		t.Fatal(e)
	}
	second, e := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "source-2", Body: "second"})
	if e != nil {
		t.Fatal(e)
	}
	ops := []SendOperation{{ConversationID: f.cid, Input: SendInput{SourceMessageID: first.Message.ID}}, {ConversationID: f.cid, Input: SendInput{SourceMessageID: second.Message.ID}}}
	batch, e := f.service.CreateSendBatch(f.ctx, f.alice.Identity, "forward1", "forward", ops, "", 0)
	if e != nil {
		t.Fatal(e)
	}
	same, e := f.service.CreateSendBatch(f.ctx, f.alice.Identity, "forward1", "forward", ops, "", 0)
	if e != nil || same != batch {
		t.Fatal("batch duplicate")
	}
	if _, e = f.service.ProcessSendOnce(f.ctx); e != nil {
		t.Fatal(e)
	}
	f.request(t, "DELETE", "/api/v2/send-batches/"+batch, f.alice.Token, nil, 204, nil)
	if done, e := f.service.ProcessSendOnce(f.ctx); e != nil || done {
		t.Fatal("cancelled queue continued")
	}
	var count int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", f.cid).Scan(&count)
	if count != 3 {
		t.Fatalf("unexpected message count %d", count)
	}
	future := time.Now().Add(time.Hour)
	plan, e := f.service.SaveDispatch(f.ctx, root.who, "", DispatchInput{Name: "scheduled", SenderID: f.alice.UserID, Targets: []string{f.cid}, Steps: []SendInput{{Body: "scheduled text"}}, Delays: []int{0}, RunAt: &future, Enabled: true})
	if e != nil {
		t.Fatal(e)
	}
	f.exec(t, "UPDATE pulse.dispatch_plans SET next_run=now()-interval '1 second' WHERE id=$1", plan)
	if done, e := f.service.ScheduleDispatchOnce(f.ctx); !done || e != nil {
		t.Fatalf("schedule: %v %v", done, e)
	}
	f.exec(t, "UPDATE pulse.admin_accounts SET active=false WHERE id=$1", root.who.ID)
	if _, e = f.service.ProcessSendOnce(f.ctx); e != nil {
		t.Fatal(e)
	}
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", f.cid).Scan(&count)
	if count != 3 {
		t.Fatal("revoked administrator sent scheduled message")
	}
}
func TestCompoundMessageIsAtomicAndSensitiveTextOnly(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	input := SendInput{RequestID: "compound", Kind: "image", Body: "caption", MediaID: newID()}
	if _, e := f.service.SendCompound(f.ctx, f.alice.Identity, f.cid, input); !errors.Is(e, ErrForbidden) {
		t.Fatalf("unowned image: %v", e)
	}
	var count int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", f.cid).Scan(&count)
	if count != 0 {
		t.Fatal("half compound message committed")
	}
	media := uploadTestImage(t, f, f.alice, imageBytes(t, 80, 60), false)
	input.MediaID = media.ID
	f.exec(t, "INSERT INTO pulse.sensitive_words(id,word,replacement) VALUES($1,'caption','filtered')", newID())
	f.service.invalidateWords()
	if _, e := f.service.SendCompound(f.ctx, f.alice.Identity, f.cid, input); e != nil {
		t.Fatal(e)
	}
	if _, e := f.service.SendCompound(f.ctx, f.alice.Identity, f.cid, input); e != nil {
		t.Fatal(e)
	}
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.messages WHERE conversation_id=$1", f.cid).Scan(&count)
	if count != 2 {
		t.Fatal("compound retry duplicated")
	}
	page, e := f.service.History(f.ctx, f.bob.Identity, f.cid, 0, 0, 0, nil, 10, false, nil)
	if e != nil {
		t.Fatal(e)
	}
	if page.Items[0].Body != "filtered" {
		t.Fatal("text not filtered")
	}
	var content MessageContent
	if e = json.Unmarshal(page.Items[1].Content, &content); e != nil || content.Media.ID != media.ID {
		t.Fatal("media ID filtered")
	}
}

func TestBroadcastOverHundredRecipientsHasSingleProgressAndCancellation(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	targets := []string{f.cid}
	for len(targets) < 105 {
		id := newID()
		f.exec(t, "INSERT INTO pulse.conversations(id,kind,title) VALUES($1,'group','broadcast fixture')", id)
		targets = append(targets, id)
	}
	payload := map[string]any{"request_id": "broadcast-over-100", "conversation_ids": targets, "body": "one message per target"}
	var job struct{ ID string }
	f.request(t, "POST", "/api/v2/broadcasts", f.alice.Token, payload, 202, &job)
	var replay struct{ ID string }
	f.request(t, "POST", "/api/v2/broadcasts", f.alice.Token, payload, 202, &replay)
	if job.ID == "" || replay.ID != job.ID {
		t.Fatal("retry must return the same job")
	}
	path := "/api/v2/send-batches/" + job.ID
	var progress struct {
		Status string
		Sent   int
		Total  int
	}
	f.request(t, "GET", path+"?summary=1", f.bob.Token, nil, 404, nil)
	f.request(t, "GET", path+"?summary=1", f.alice.Token, nil, 200, &progress)
	if progress.Status != "pending" || progress.Sent != 0 || progress.Total != len(targets) {
		t.Fatalf("unexpected admitted job progress: %+v", progress)
	}
	if done, err := f.service.ProcessSendOnce(f.ctx); !done || err != nil {
		t.Fatalf("start sending: %v %v", done, err)
	}
	f.request(t, "DELETE", path, f.alice.Token, nil, 204, nil)
	f.request(t, "GET", path+"?summary=1", f.alice.Token, nil, 200, &progress)
	if progress.Status != "cancelled" || progress.Sent != 1 || progress.Total != len(targets) {
		t.Fatalf("unexpected cancelled job progress: %+v", progress)
	}
	f.request(t, "POST", "/api/v2/forward-batches", f.alice.Token, map[string]any{"request_id": "still-limited", "conversation_ids": targets, "message_ids": []string{newID()}}, 400, nil)
}
