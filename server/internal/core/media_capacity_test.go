package core

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestConcurrentMediaReservationsRespectQuotaAndReplay(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 15*time.Second)
	defer cancel()
	limits := DefaultMediaLimits()
	limits.AdmissionPreparers = 8
	limits.AdmissionWait = 10 * time.Second
	limits.QueueJobs = 18
	store, err := NewMediaStoreWithLimits(t.TempDir(), "", limits)
	if err != nil {
		t.Fatal(err)
	}
	f.service.Media = store
	owners := make([]Identity, 0, 3)
	for _, actor := range []Login{f.alice, f.bob, f.carol} {
		owner, err := f.service.Authenticate(ctx, actor.Token)
		if err != nil {
			t.Fatal(err)
		}
		owners = append(owners, owner)
	}
	type result struct {
		owner Identity
		input UploadInput
		media Media
		err   error
	}
	const requests = 24
	start := make(chan struct{})
	results := make(chan result, requests)
	for i := range requests {
		go func() {
			<-start
			owner := owners[i%len(owners)]
			input := UploadInput{RequestID: fmt.Sprintf("parallel-upload-%d", i), Kind: "image", Filename: "test.png", Bytes: 100, SHA256: strings.Repeat("a", 64)}
			media, err := f.service.CreateUpload(ctx, owner, input)
			results <- result{owner, input, media, err}
		}()
	}
	close(start)
	var first result
	var accepted int
	for range requests {
		item := <-results
		if item.err == nil {
			first = item
			accepted++
			continue
		}
		var fault *Fault
		if !errors.As(item.err, &fault) || fault.Code != "upload_queue_full" {
			t.Errorf("unexpected concurrent reservation error: %v", item.err)
		}
	}
	var stored int
	if err = f.store.Pool.QueryRow(ctx, "SELECT count(*) FROM pulse.media WHERE status='pending'").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if accepted != limits.QueueJobs || stored != limits.QueueJobs {
		t.Fatalf("expected %d reservations, accepted %d and stored %d", limits.QueueJobs, accepted, stored)
	}
	replayed, err := f.service.CreateUpload(ctx, first.owner, first.input)
	if err != nil || replayed.ID != first.media.ID {
		t.Fatalf("replay at capacity did not return the existing reservation: %v", err)
	}
	first.input.Bytes++
	if _, err = f.service.CreateUpload(ctx, first.owner, first.input); !errors.Is(err, ErrConflict) {
		t.Fatalf("a changed replay must conflict: %v", err)
	}
}
