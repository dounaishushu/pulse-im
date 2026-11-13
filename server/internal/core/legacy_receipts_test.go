package core

import (
	"testing"
	"time"
)

func TestImportedReceiptFactsDoNotInheritReadWatermark(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "legacy-first", "first")
	second := f.send(t, "legacy-second", "second")
	f.exec(t, "UPDATE pulse.messages SET imported_legacy=true WHERE id IN ($1,$2)", first.ID, second.ID)
	// Old progress is a cursor, not proof of a receipt for either message.
	f.exec(t, "UPDATE pulse.user_states SET read_seq=$3,delivered_seq=$3 WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID, second.Seq)
	got, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, first.ID)
	if err != nil || got.ReadCount != 0 || got.DeliveredCount != 0 {
		t.Fatalf("fabricated first receipt: %+v %v", got, err)
	}
	unread, err := f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || unread.Count != 2 {
		t.Fatalf("old watermark hid sparse unread messages: %+v %v", unread, err)
	}
	f.exec(t, "INSERT INTO pulse.receipt_facts(message_id,user_id,status,updated_at) VALUES($1,$2,'read',$3)", first.ID, f.bob.UserID, time.Now().UTC())
	got, err = f.service.Receipts(f.ctx, f.alice.Identity, f.cid, first.ID)
	if err != nil || got.ReadCount != 1 || got.DeliveredCount != 1 {
		t.Fatalf("real read fact missing: %+v %v", got, err)
	}
	unread, err = f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || unread.Count != 1 {
		t.Fatalf("real receipt did not reduce unread count: %+v %v", unread, err)
	}
	// Personal clearing must not erase a receipt that really existed in MySQL.
	f.exec(t, "UPDATE pulse.user_states SET read_seq=0,delivered_seq=0 WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	if _, err = f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, first.Seq); err != nil {
		t.Fatal(err)
	}
	got, err = f.service.Receipts(f.ctx, f.alice.Identity, f.cid, first.ID)
	if err != nil || got.ReadCount != 1 || got.DeliveredCount != 1 {
		t.Fatalf("personal clearing erased imported receipt: %+v %v", got, err)
	}
	if _, err = f.service.Advance(f.ctx, f.bob.Identity, f.cid, second.Seq, true); err != nil {
		t.Fatal(err)
	}
	got, err = f.service.Receipts(f.ctx, f.alice.Identity, f.cid, second.ID)
	if err != nil || got.ReadCount != 1 || got.DeliveredCount != 1 {
		t.Fatalf("new read did not override imported sparse facts: %+v %v", got, err)
	}
	unread, err = f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || unread.Count != 0 {
		t.Fatalf("new read did not clear imported unread: %+v %v", unread, err)
	}
}

func TestImportedClearBeforeLaterReadDoesNotCreateReceipt(t *testing.T) {
	f := newFixture(t)
	old := f.send(t, "old-unseen", "old")
	f.exec(t, "UPDATE pulse.messages SET imported_legacy=true WHERE id=$1", old.ID)
	if _, err := f.service.ClearHistory(f.ctx, f.bob.Identity, f.cid, old.Seq); err != nil {
		t.Fatal(err)
	}
	newMessage := f.send(t, "new-after-clear", "new")
	if _, err := f.service.Advance(f.ctx, f.bob.Identity, f.cid, newMessage.Seq, true); err != nil {
		t.Fatal(err)
	}
	oldReceipt, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, old.ID)
	if err != nil || oldReceipt.ReadCount != 0 || oldReceipt.DeliveredCount != 0 {
		t.Fatalf("later read invented an imported receipt: %+v %v", oldReceipt, err)
	}
	newReceipt, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, newMessage.ID)
	if err != nil || newReceipt.ReadCount != 1 || newReceipt.DeliveredCount != 1 {
		t.Fatalf("new message was not read: %+v %v", newReceipt, err)
	}
}

func TestIndividualReceiptIsSparseAndReadDominatesDelivered(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "sparse-first", "first")
	second := f.send(t, "sparse-second", "second")
	if _, err := f.service.ReceiptOne(f.ctx, f.carol.Identity, f.cid, second.ID, "read"); err == nil {
		t.Fatal("nonmember wrote a receipt")
	}
	if _, err := f.service.ReceiptOne(f.ctx, f.alice.Identity, f.cid, second.ID, "read"); err == nil {
		t.Fatal("sender wrote a receipt for own message")
	}
	actual, err := f.service.ReceiptOne(f.ctx, f.bob.Identity, f.cid, second.ID, "read")
	if err != nil || actual.Status != "read" {
		t.Fatalf("individual receipt failed: %+v %v", actual, err)
	}
	actual, err = f.service.ReceiptOne(f.ctx, f.bob.Identity, f.cid, second.ID, "delivered")
	if err != nil || actual.Status != "read" {
		t.Fatalf("late delivered packet downgraded read: %+v %v", actual, err)
	}
	for _, want := range []struct {
		message Message
		count   int64
	}{{first, 0}, {second, 1}} {
		summary, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, want.message.ID)
		if err != nil || summary.ReadCount != want.count {
			t.Fatalf("sparse receipt count: %+v %v", summary, err)
		}
	}
	unread, err := f.service.Unread(f.ctx, f.bob.Identity, f.cid, 999)
	if err != nil || unread.Count != 1 {
		t.Fatalf("sparse read changed unrelated unread message: %+v %v", unread, err)
	}
	batch, err := f.service.ReceiptBatch(f.ctx, f.alice.Identity, f.cid, []string{first.ID, second.ID})
	if err != nil || len(batch) != 2 || batch[0].ReadCount != 0 || batch[1].ReadCount != 1 {
		t.Fatalf("batch differs from single receipt: %+v %v", batch, err)
	}
}

func TestImportedReceiptSurvivesRecipientLeaving(t *testing.T) {
	f := newFixture(t)
	old := f.send(t, "historical-member", "read before leaving")
	f.exec(t, "UPDATE pulse.messages SET imported_legacy=true WHERE id=$1", old.ID)
	f.exec(t, "INSERT INTO pulse.receipt_facts(message_id,user_id,status,updated_at) VALUES($1,$2,'read',$3)", old.ID, f.bob.UserID, time.Now().UTC())
	f.exec(t, "UPDATE pulse.members SET active=false WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	summary, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, old.ID)
	if err != nil || summary.ReadCount != 1 || summary.DeliveredCount != 1 {
		t.Fatalf("departure erased historical read fact: %+v %v", summary, err)
	}
	items, err := f.service.ReceiptBatch(f.ctx, f.alice.Identity, f.cid, []string{old.ID})
	if err != nil || len(items) != 1 || items[0].ReadCount != 1 {
		t.Fatalf("batch erased historical read fact: %+v %v", items, err)
	}
}
