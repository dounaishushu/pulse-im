package core

import (
	"fmt"
	"testing"
)

func TestBrowserReceiptBatchPreservesPermissionsAndExclusions(t *testing.T) {
	f := newFixture(t)
	first := f.send(t, "batch-first", "before deletion")
	second := f.send(t, "batch-second", "after deletion")
	path := "/api/v2/conversations/" + f.cid + "/message-receipts"
	request := map[string][]string{"message_ids": {first.ID, second.ID}}
	var result struct {
		Items []ReceiptSummary `json:"items"`
	}
	f.request(t, "POST", path, f.alice.Token, request, 200, &result)
	if len(result.Items) != 2 || result.Items[0].RecipientCount != 1 || result.Items[0].ReadCount != 0 {
		t.Fatal(result)
	}
	f.request(t, "POST", path, f.bob.Token, request, 403, nil)
	f.request(t, "POST", path, f.carol.Token, request, 403, nil)
	f.request(t, "POST", path, f.alice.Token, map[string][]string{"message_ids": {first.ID, first.ID}}, 400, nil)
	f.request(t, "POST", path, f.alice.Token, map[string][]string{"message_ids": {}}, 400, nil)
	f.request(t, "POST", path, f.alice.Token, map[string][]string{"message_ids": make([]string, 101)}, 400, nil)
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/personal-deletions", f.bob.Token, map[string][]string{"message_ids": {first.ID}}, 200, nil)
	f.request(t, "PUT", "/api/v2/conversations/"+f.cid+"/read", f.bob.Token, map[string]string{"seq": fmt.Sprint(second.Seq)}, 200, nil)
	f.request(t, "POST", path, f.alice.Token, request, 200, &result)
	for _, item := range result.Items {
		single, err := f.service.Receipts(f.ctx, f.alice.Identity, f.cid, item.MessageID)
		if err != nil || single != item {
			t.Fatalf("batch differs from authorized single: %+v %+v %v", item, single, err)
		}
	}
	if result.Items[0].ReadCount != 0 || result.Items[1].ReadCount != 1 {
		t.Fatal("deletion forged a read", result)
	}
	f.request(t, "POST", "/api/v2/conversations/"+f.cid+"/personal-deletions", f.alice.Token, map[string][]string{"message_ids": {first.ID}}, 200, nil)
	f.request(t, "POST", path, f.alice.Token, request, 403, nil)
	f.request(t, "PUT", "/api/v2/conversations/"+f.cid+"/clear", f.alice.Token, map[string]string{"through_seq": fmt.Sprint(second.Seq)}, 200, nil)
	f.request(t, "POST", path, f.alice.Token, map[string][]string{"message_ids": {second.ID}}, 403, nil)
}
