package core

import (
	"sync"
	"testing"
)

func TestConcurrentOpenIsIdempotentAndPreservesPreferences(t *testing.T) {
	f := newFixture(t)
	yes := true
	initial, err := f.service.SetPreferences(f.ctx, f.alice.Identity, f.cid, PreferencePatch{Hidden: &yes, Pinned: &yes, Muted: &yes, Expected: 1})
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 16)
	var workers sync.WaitGroup
	for i := 0; i < 16; i++ {
		workers.Go(func() {
			<-start
			item, err := f.service.OpenConversation(f.ctx, f.alice.Identity, f.cid)
			if err == nil && (item.ID != f.cid || item.Hidden || !item.Pinned || !item.ConversationPreferences.Muted || item.State.UserID != f.alice.UserID || item.ConversationPreferences.Version != initial.Version+1) {
				err = ErrConflict
			}
			results <- err
		})
	}
	close(start)
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent open failed: %v", err)
		}
	}
	var item ClientConversation
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/open", f.alice.Token, map[string]any{}, 200, &item)
	if item.ID != f.cid || item.Hidden || item.ConversationPreferences.Version != initial.Version+1 {
		t.Fatal("open response is not complete or changed a visible conversation again")
	}
	f.exec(t, "UPDATE pulse.members SET active=false WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/open", f.bob.Token, map[string]any{}, 403, nil)
}

func TestBatchMediaGrantsArePartialScopedAndRevocable(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	media := uploadTestImage(t, f, f.alice, imageBytes(t, 64, 48), false)
	missing := newID()
	var result struct {
		Items []mediaGrantResult `json:"items"`
	}
	f.request(t, "POST", "/api/v2/media/grants", f.alice.Token, map[string]any{"media_ids": []string{media.ID, missing, media.ID}}, 200, &result)
	if len(result.Items) != 2 || result.Items[0].Access == nil || result.Items[1].Access != nil || result.Items[1].Error == nil {
		t.Fatal("batch did not distinguish allowed media from inaccessible media")
	}
	path := result.Items[0].Access.PreviewPath
	f.request(t, "GET", path, "", nil, 200, nil)
	result.Items = nil
	f.request(t, "POST", "/api/v2/media/grants", f.bob.Token, map[string]any{"media_ids": []string{media.ID}}, 200, &result)
	if len(result.Items) != 1 || result.Items[0].Access != nil || result.Items[0].Error == nil || result.Items[0].Error.Status != 403 {
		t.Fatal("another user received access to an unshared upload")
	}
	f.request(t, "POST", "/api/v2/media/grants", f.alice.Token, map[string]any{"media_ids": []string{media.ID, "bad-id"}}, 400, nil)
	f.request(t, "POST", "/api/v2/media/grants", f.alice.Token, map[string]any{"media_ids": []string{}}, 400, nil)
	if err := f.service.Logout(f.ctx, f.alice.Identity); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", path, "", nil, 401, nil)
}
