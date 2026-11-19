package core

import (
	"net/url"
	"strings"
	"testing"
)

func TestBroadcastTargetsSearchAccountOwnedRemarksAndKeepPermissions(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET nickname='原昵称100%',legacy_public_id='77889900' WHERE id=$1", f.bob.UserID)
	if err := f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "11/18 平安备注", "", 0); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'其他人的私有备注')", f.carol.UserID, f.bob.UserID)
	type targets struct {
		Items    []BroadcastTarget `json:"items"`
		Query    string            `json:"query"`
		Snapshot string            `json:"snapshot_max_id"`
		More     bool              `json:"has_more"`
	}
	search := func(kind, query string) targets {
		t.Helper()
		var page targets
		f.request(t, "GET", "/api/v2/broadcast-targets?kind="+kind+"&q="+url.QueryEscape(query), f.alice.Token, nil, 200, &page)
		if page.Query != strings.TrimSpace(query) || page.Snapshot == "" {
			t.Fatal("search context omitted", page)
		}
		return page
	}
	for _, query := range []string{"平安", "原昵称", "BOB01", "8899", "100%", "  平安  "} {
		page := search("friend", query)
		if len(page.Items) != 1 || page.Items[0].ID != f.bob.UserID || page.Items[0].Name != "原昵称100%" || page.Items[0].Remark != "11/18 平安备注" || page.Items[0].DisplayName != "11/18 平安备注" || page.Items[0].PublicID != "77889900" {
			t.Fatalf("remark/name/account/ID search %q: %+v", query, page)
		}
	}
	for _, query := range []string{"其他人的私有备注", "carol01", "_' OR 1=1 --"} {
		if page := search("friend", query); len(page.Items) != 0 {
			t.Fatal("search escaped the viewer's friend directory", query, page)
		}
	}
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "邀请群100%", []string{f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	page := search("group", "群100%")
	if len(page.Items) != 1 || page.Items[0].ID != group.ID || page.Items[0].Remark != "" {
		t.Fatal("group search or response columns changed", page)
	}
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", group.ID, f.alice.UserID)
	if page = search("group", "邀请群"); len(page.Items) != 0 {
		t.Fatal("hidden group appeared in broadcast candidates", page)
	}
	f.request(t, "GET", "/api/v2/broadcast-targets?kind=friend", f.bob.Token, nil, 403, nil)
	f.request(t, "GET", "/api/v2/broadcast-targets?kind=friend&q="+strings.Repeat("x", 101), f.alice.Token, nil, 400, nil)
	for _, query := range []string{"kind=direct", "kind=friend&after=bad", "kind=friend&limit=0", "kind=friend&limit=101", "kind=friend&snapshot=bad"} {
		f.request(t, "GET", "/api/v2/broadcast-targets?"+query, f.alice.Token, nil, 400, nil)
	}
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.alice.UserID)
	if page = search("friend", "平安"); len(page.Items) != 0 {
		t.Fatal("reverse block did not remove a broadcast target", page)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.alice.UserID)
	f.request(t, "GET", "/api/v2/broadcast-targets?kind=friend", f.alice.Token, nil, 403, nil)
}
