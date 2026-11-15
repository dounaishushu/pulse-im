package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestMediaWaitUploadReturnsProcessedMediaAndScopedAccess(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	f.workers.Go(func() { f.service.RunMediaWorkers(f.ctx) })
	data := imageBytes(t, 80, 60)
	sum := sha256.Sum256(data)
	var admitted Media
	f.request(t, "POST", "/api/v2/media/uploads", f.alice.Token, UploadInput{RequestID: newID(), Kind: "image", Filename: "photo.png", Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}, 201, &admitted)
	req, _ := http.NewRequest("PUT", f.http.URL+"/api/v2/media/"+admitted.ID+"/bytes?wait_ms=1500", bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+f.alice.Token)
	response, err := f.http.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var result struct {
		Media
		Access mediaGrant `json:"access"`
	}
	if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 202 || result.Status != "ready" || result.Access.ContentPath == "" || result.Width != 80 {
		t.Fatalf("upload did not return a ready image: HTTP %d, %s", response.StatusCode, result.Status)
	}
	f.request(t, "GET", result.Access.PreviewPath, "", nil, 200, nil)
	f.request(t, "GET", "/api/v2/media/"+admitted.ID+"?wait_ms=1500", f.bob.Token, nil, 404, nil)
	if err = f.service.Logout(f.ctx, f.alice.Identity); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", result.Access.ContentPath, "", nil, 401, nil)
}

func TestMediaWaitCancellationAndBoundedSlotsReleaseRegistrations(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	sum := sha256.Sum256([]byte("not transferred"))
	media, err := f.service.CreateUpload(f.ctx, f.alice.Identity, UploadInput{RequestID: newID(), Kind: "image", Filename: "photo.png", Bytes: 15, SHA256: hex.EncodeToString(sum[:])})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(f.ctx)
	done := make(chan error, 1)
	go func() { _, e := f.service.waitForMedia(ctx, f.alice.Identity, media, time.Second); done <- e }()
	until := time.Now().Add(time.Second)
	for {
		f.service.Media.mu.Lock()
		registered := len(f.service.Media.completion) == 1
		f.service.Media.mu.Unlock()
		if registered {
			break
		}
		if time.Now().After(until) {
			t.Fatal("waiter was not registered")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	if err = <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated: %v", err)
	}
	if len(f.service.Media.completion) != 0 || len(f.service.Media.waits) != 0 {
		t.Fatal("cancelled waiter leaked a slot or notification")
	}
	for i := 0; i < cap(f.service.Media.waits); i++ {
		f.service.Media.waits <- struct{}{}
	}
	defer func() {
		for len(f.service.Media.waits) > 0 {
			<-f.service.Media.waits
		}
	}()
	got, err := f.service.waitForMedia(f.ctx, f.alice.Identity, media, time.Second)
	if err != nil || got.ID != media.ID || len(f.service.Media.completion) != 0 {
		t.Fatal("saturated wait slots did not fall back to ordinary asynchronous status")
	}
}

func TestMediaWaitQueryIsBoundedAndCompletionDoesNotLeaveRecords(t *testing.T) {
	for _, query := range []string{"wait_ms=-1", "wait_ms=1501", "wait_ms=1&wait_ms=2", "wait_ms=bad"} {
		req, _ := http.NewRequest("GET", "https://test.invalid/api/v2/media/id?"+query, nil)
		if _, err := mediaWaitDuration(req); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid wait accepted: %s", query)
		}
	}
	m, err := NewMediaStore(t.TempDir(), "")
	if err != nil {
		t.Fatal(err)
	}
	done, release := m.watch("owned-media")
	m.completed("owned-media")
	m.completed("owned-media")
	select {
	case <-done:
	default:
		t.Fatal("worker completion did not notify the waiter")
	}
	release()
	if len(m.completion) != 0 {
		t.Fatal("completion retained a notification record")
	}
}
