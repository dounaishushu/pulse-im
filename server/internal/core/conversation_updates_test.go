package core

import (
	"reflect"
	"testing"
	"time"
)

func TestConversationUpdatesPreserveVisibilityAndAuthentication(t *testing.T) {
	f := newFixture(t)
	f.send(t, "delta-first", "message")
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "batch group", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	missing := "88888888-8888-4888-8888-888888888888"
	ids := []string{f.cid, group.ID, missing}
	path := "/api/v2/client/conversation-updates"
	var page struct {
		Items       []ClientConversation `json:"items"`
		Removed     []string             `json:"removed_ids"`
		Incremental bool                 `json:"incremental"`
	}
	read := func(token string) {
		t.Helper()
		f.request(t, "POST", path, token, map[string]any{"conversation_ids": ids}, 200, &page)
	}
	read(f.bob.Token)
	if !page.Incremental || len(page.Items) != 2 || !reflect.DeepEqual(page.Removed, []string{missing}) {
		t.Fatalf("批量摘要不完整: %+v", page)
	}
	for _, row := range page.Items {
		single, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", row.ID)
		if err != nil || len(single) != 1 || !reflect.DeepEqual(single[0], row) {
			t.Fatalf("批量与单项语义不一致: %s %v", row.ID, err)
		}
	}
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID)
	f.exec(t, "UPDATE pulse.members SET active=false,membership_version=membership_version+1 WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	read(f.bob.Token)
	if len(page.Items) != 0 || !reflect.DeepEqual(page.Removed, ids) {
		t.Fatalf("隐藏或退群后泄露摘要: %+v", page)
	}
	read(f.carol.Token)
	if len(page.Items) != 0 || !reflect.DeepEqual(page.Removed, ids) {
		t.Fatal("非成员获得摘要")
	}
	for _, invalid := range [][]string{nil, {}, {"bad"}, {f.cid, f.cid}, make([]string, 101)} {
		f.request(t, "POST", path, f.bob.Token, map[string]any{"conversation_ids": invalid}, 400, nil)
	}
	f.request(t, "POST", path, "invalid", map[string]any{"conversation_ids": ids}, 401, nil)
}

func TestConversationUpdatesBatchMeasurement(t *testing.T) {
	f := newFixture(t)
	ids := []string{f.cid}
	for range 7 {
		group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "batch timing", []string{f.bob.UserID})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, group.ID)
	}
	measure := func(batch bool) time.Duration {
		started := time.Now()
		for range 8 {
			if batch {
				rows, err := f.service.clientConversationSelection(f.ctx, f.bob.Identity, "", "", 0, 100, "", false, ids)
				if err != nil || len(rows) != 8 {
					t.Fatalf("批量读取异常: %d %v", len(rows), err)
				}
			} else {
				for _, id := range ids {
					if _, err := f.service.ClientConversations(f.ctx, f.bob.Identity, "", id); err != nil {
						t.Fatal(err)
					}
				}
			}
		}
		return time.Since(started)
	}
	// 同库交替测试，预热结果不计入；耗时仅记录，不设依赖机器速度的断言。
	measure(true)
	measure(false)
	single, batch := measure(false), measure(true)
	t.Logf("8 轮各 8 个会话: 逐个 %.3f ms, 批量 %.3f ms", float64(single.Microseconds())/1000, float64(batch.Microseconds())/1000)
}
