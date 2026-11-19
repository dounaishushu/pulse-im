package core

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

func TestFeedbackMediaGrantIdentityAndPrivateRevalidation(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	media := uploadTestImage(t, f, f.alice, imageBytes(t, 64, 48), false)
	first, err := f.service.createMediaGrant(f.ctx, f.alice.Identity, media.ID)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			items, e := f.service.batchMediaGrants(f.ctx, f.alice.Identity, []string{media.ID})
			if e == nil && (len(items) != 1 || items[0].Access == nil || items[0].Access.Token != first.Token) {
				e = errors.New("grant URL changed")
			}
			errs <- e
		})
	}
	wg.Wait()
	close(errs)
	for e := range errs {
		if e != nil {
			t.Fatal(e)
		}
	}
	fetch := func(path, etag string, want int) (string, int64) {
		t.Helper()
		req, _ := http.NewRequest("GET", f.http.URL+path, nil)
		if etag != "" {
			req.Header.Set("If-None-Match", etag)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		n, _ := io.Copy(io.Discard, res.Body)
		if res.StatusCode != want {
			t.Fatalf("media status %d, want %d", res.StatusCode, want)
		}
		if want == 200 || want == 304 {
			if res.Header.Get("Cache-Control") != "private, no-cache, must-revalidate" {
				t.Fatal("unsafe cache policy")
			}
			if res.Header.Get("Cross-Origin-Resource-Policy") != "cross-origin" {
				t.Fatal("desktop image embedding blocked")
			}
		}
		return res.Header.Get("ETag"), n
	}
	etag, size := fetch(first.PreviewPath, "", 200)
	if etag == "" || size == 0 {
		t.Fatal("missing image or validator")
	}
	_, size = fetch(first.PreviewPath, etag, 304)
	if size != 0 {
		t.Fatal("revalidation downloaded media body")
	}
	lease := f.cache.Prefix + "media-grant:" + hex.EncodeToString(digest(first.Token))
	if err = f.cache.Client.Del(f.ctx, lease).Err(); err != nil {
		t.Fatal(err)
	}
	fetch(first.PreviewPath, etag, 401)
	renewed, err := f.service.createMediaGrant(f.ctx, f.alice.Identity, media.ID)
	if err != nil || renewed.Token != first.Token {
		t.Fatal("authorized renewal lost content URL", err)
	}
	other, err := f.service.Login(f.ctx, "alice01", testPassword, "second-media-session", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	different, err := f.service.createMediaGrant(f.ctx, other.Identity, media.ID)
	if err != nil || different.Token == first.Token {
		t.Fatal("media URL crossed login sessions")
	}
	if err = f.service.Logout(f.ctx, f.alice.Identity); err != nil {
		t.Fatal(err)
	}
	fetch(first.PreviewPath, etag, 401)
}

func TestFeedbackMediaCachedContentStillHonorsRemoval(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	media := uploadTestImage(t, f, f.alice, imageBytes(t, 48, 48), false)
	sent, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "cached-image", Kind: "image", MediaID: media.ID})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.service.createMediaGrant(f.ctx, f.bob.Identity, media.ID)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", f.http.URL+grant.ContentPath, nil)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	etag := res.Header.Get("ETag")
	res.Body.Close()
	if _, err = f.deleteMessagesAsStaff(t, f.ctx, f.bob.Identity, f.cid, []string{sent.Message.ID}); err != nil {
		t.Fatal(err)
	}
	req, _ = http.NewRequest("GET", f.http.URL+grant.ContentPath, nil)
	req.Header.Set("If-None-Match", etag)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 403 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("cached content bypassed deletion")
	}
	if _, err = f.service.createMediaGrant(f.ctx, f.bob.Identity, media.ID); !errors.Is(err, ErrForbidden) {
		t.Fatal("deleted media renewed", err)
	}
}

func TestFeedbackGroupContractSearchInvitesAndTimedMuteReset(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "feedback", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]any
	f.request(t, "GET", "/api/v2/groups/"+group.ID, f.alice.Token, nil, 200, &profile)
	if profile["status"] != "active" || profile["my_role"] != "owner" {
		t.Fatal("owner client contract incomplete")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	if _, err = f.service.AddFriendAsStaff(f.ctx, f.alice.Identity, f.carol.UserID); err != nil {
		t.Fatal(err)
	}
	candidates, err := f.service.GroupSearch(f.ctx, f.alice.Identity, group.ID, "carol", "", true)
	if err != nil || len(candidates) != 1 || candidates[0]["id"] != f.carol.UserID {
		t.Fatal("forced friend absent from invite candidates", err)
	}
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.carol.UserID, true); err != nil {
		t.Fatal(err)
	}
	var search struct {
		Items  []map[string]any `json:"items"`
		Search bool             `json:"can_search"`
		All    bool             `json:"can_mention_all"`
	}
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/search-members?q=car", f.bob.Token, nil, 200, &search)
	if !search.Search || search.All || len(search.Items) != 1 || search.Items[0]["id"] != f.carol.UserID {
		t.Fatal("member could not find non-friend visible roster member")
	}
	f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=true WHERE id=$1", group.ID)
	search.Items = nil
	f.request(t, "GET", "/api/v2/groups/"+group.ID+"/search-members?q=car", f.bob.Token, nil, 200, &search)
	if len(search.Items) != 0 {
		t.Fatal("restricted directory exposed peer")
	}
	if err = f.service.SetGroupMuteMinutes(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, 60); err != nil {
		t.Fatal(err)
	}
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	if err = f.service.InviteGroupMemberWithHistory(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, true); err != nil {
		t.Fatal(err)
	}
	ac, err := f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || !ac.CanSend {
		t.Fatal("rejoined member inherited timed mute", err)
	}
	if err = f.service.SetGroupMuteMinutes(f.ctx, f.alice.Identity, group.ID, f.bob.UserID, 60); err != nil {
		t.Fatal(err)
	}
	if err = f.service.TransferGroup(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	ac, err = f.service.ConversationAccess(f.ctx, f.bob.Identity, group.ID)
	if err != nil || !ac.CanSend || ac.Role != "owner" {
		t.Fatal("new owner inherited timed mute", err)
	}
}

func TestFeedbackBulkUsersAcceptLegacyPasswordAndIdempotentRetry(t *testing.T) {
	f := newFixture(t)
	admin := newAdmin(t, f)
	input := BulkUsersInput{RequestID: "bulk-eight", Prefix: "batch", Start: 999999999, Count: 2, Password: "Test1234"}
	var created struct {
		Items []map[string]string `json:"items"`
	}
	admin.request(t, "POST", "/api/v2/admin/users/batch", input, 201, &created)
	if len(created.Items) != 2 {
		t.Fatal("batch missing users")
	}
	var repeated struct {
		Items []map[string]string `json:"items"`
	}
	admin.request(t, "POST", "/api/v2/admin/users/batch", input, 201, &repeated)
	if repeated.Items[0]["id"] != created.Items[0]["id"] {
		t.Fatal("retry duplicated users")
	}
	if _, err := f.service.Login(f.ctx, created.Items[0]["account"], input.Password, "bulk-login", "127.0.0.1"); err != nil {
		t.Fatal("new user cannot log in", err)
	}
	for _, item := range []struct {
		input  BulkUsersInput
		status int
		code   string
	}{
		{BulkUsersInput{RequestID: "bulk-duplicate", Prefix: "batch", Start: 999999999, Count: 2, Password: "Test1234"}, 409, "bulk_account_exists"},
		{BulkUsersInput{RequestID: "bulk-short", Prefix: "bulk", Start: 1, Count: 1, Password: "1234567"}, 400, "bulk_password_invalid"},
		{BulkUsersInput{RequestID: "bulk-prefix", Prefix: "!", Start: 1, Count: 1, Password: "Test1234"}, 400, "bulk_prefix_invalid"},
	} {
		var response map[string]any
		admin.request(t, "POST", "/api/v2/admin/users/batch", item.input, item.status, &response)
		if response["error"].(map[string]any)["code"] != item.code {
			t.Fatal("field error missing")
		}
	}
	start := make(chan struct{})
	results := make(chan string, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			out, err := f.service.BulkCreateUsers(f.ctx, admin.who, BulkUsersInput{RequestID: "parallel-bulk", Prefix: "parallel", Start: 1, Count: 1, Password: "Test1234"})
			errs <- err
			if err == nil {
				results <- out[0]["id"]
			}
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatal("concurrent retry failed", err)
		}
	}
	if <-results != <-results {
		t.Fatal("concurrent request duplicated users")
	}
	var count int
	f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.users WHERE account LIKE 'batch%' ").Scan(&count)
	if count != 2 {
		t.Fatal("failed batch partially committed")
	}
}

func TestFeedbackDispatchScheduleAndQueueOutliveRequest(t *testing.T) {
	f := newFixture(t)
	admin := newAdmin(t, f)
	instant := time.Date(2026, 11, 20, 1, 0, 0, 0, time.UTC)
	var preview dispatchSchedulePreview
	admin.request(t, "POST", "/api/v2/admin/dispatch-plans/preview", dispatchScheduleInput{RunAt: &instant, Delays: []int{0, 60, 120}}, 200, &preview)
	if len(preview.Steps) != 3 || !preview.Steps[2].Equal(instant.Add(3*time.Minute)) || preview.Timezone != "Asia/Shanghai" {
		t.Fatal("incorrect cumulative schedule")
	}
	cronPreview, err := previewDispatchSchedule(dispatchScheduleInput{Cron: "0 9 * * *", Delays: []int{10}}, instant.Add(time.Minute))
	if err != nil || !cronPreview.Steps[0].Equal(instant.Add(24*time.Hour+10*time.Second)) {
		t.Fatal("cron ignored Beijing time", err)
	}
	admin.request(t, "POST", "/api/v2/admin/dispatch-plans/preview", map[string]any{"cron": "invalid", "delays_seconds": []int{0}}, 400, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	var batch map[string]string
	f.request(t, "POST", "/api/v2/broadcasts", f.alice.Token, map[string]any{"request_id": "closed-window", "conversation_ids": []string{f.cid}, "body": "queued after window closed"}, 202, &batch)
	// HTTP request has returned; a fresh worker processes persisted state without any client connection.
	restarted, err := NewService(f.store, f.cache)
	if err != nil {
		t.Fatal(err)
	}
	if done, err := restarted.ProcessSendOnce(f.ctx); !done || err != nil {
		t.Fatal("durable batch stopped after request", err)
	}
	var status string
	f.store.Pool.QueryRow(f.ctx, "SELECT status FROM pulse.send_batches WHERE id=$1", batch["id"]).Scan(&status)
	if status != "completed" {
		t.Fatal("queue did not complete")
	}
}
