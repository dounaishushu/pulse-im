package core

import (
	"net/url"
	"strings"
	"testing"
)

func TestMemberDirectoryFriendsOnlySearchAndManagerRoster(t *testing.T) {
	f := newFixture(t)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "directory", []string{f.bob.UserID, f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	admin, stranger, outside := newID(), newID(), newID()
	for i, id := range []string{admin, stranger, outside} {
		f.exec(t, "INSERT INTO pulse.users(id,account,password_hash,nickname) VALUES($1,$2,$3,$4)", id, []string{"admin01", "stranger01", "outside01"}[i], testPasswordHash, []string{"人才管理", "人才陌生人", "人才群外好友"}[i])
	}
	for _, id := range []string{admin, stranger} {
		if err = f.service.InviteGroupMember(f.ctx, f.alice.Identity, group.ID, id); err != nil {
			t.Fatal(err)
		}
	}
	f.exec(t, "UPDATE pulse.members SET role='admin' WHERE conversation_id=$1 AND user_id=$2", group.ID, admin)
	f.exec(t, "UPDATE pulse.users SET nickname='人才群主' WHERE id=$1", f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET nickname='人才100%好友',legacy_public_id='77889900' WHERE id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.contact_metadata(user_id,peer_id,remark) VALUES($1,$2,'我的工作备注')", f.bob.UserID, f.carol.UserID)
	for _, id := range []string{f.carol.UserID, outside} {
		f.exec(t, "INSERT INTO pulse.friendships(user_low,user_high) VALUES(LEAST($1::uuid,$2::uuid),GREATEST($1::uuid,$2::uuid))", f.bob.UserID, id)
	}
	prefix := "/api/v2/groups/" + group.ID
	search := func(token, query, after string, limit int) ClientMemberPage {
		t.Helper()
		var page ClientMemberPage
		path := prefix + "/member-profiles?directory_version=2&q=" + url.QueryEscape(query) + "&after=" + url.QueryEscape(after)
		if limit == 1 {
			path += "&limit=1"
		}
		f.request(t, "GET", path, token, nil, 200, &page)
		return page
	}
	for _, blocked := range []bool{false, true} {
		f.exec(t, "UPDATE pulse.conversations SET block_member_friend_requests=$2 WHERE id=$1", group.ID, blocked)
		page := search(f.bob.Token, "", "", 100)
		if !blocked {
			if page.MembersVisibility != "all" || page.SearchScope != "group" || len(page.Items) != 5 {
				t.Fatalf("open group directory: %+v", page)
			}
			var ids struct {
				Items []string `json:"items"`
			}
			f.request(t, "GET", prefix+"/members", f.bob.Token, nil, 200, &ids)
			if len(ids.Items) != 5 {
				t.Fatal("open group ID directory omitted members", ids)
			}
			for _, query := range []string{"陌生", "管理", "工作", "8899", "100%", "ROL01", "bob01"} {
				if page = search(f.bob.Token, query, "", 100); page.SearchScope != "group" || len(page.Items) != 1 {
					t.Fatalf("open group fuzzy search %q: %+v", query, page)
				}
			}
			for _, query := range []string{"群外", "_' OR 1=1 --"} {
				if page = search(f.bob.Token, query, "", 100); len(page.Items) != 0 {
					t.Fatalf("open group search escaped group scope %q: %+v", query, page)
				}
			}
			seen := map[string]bool{}
			for after := ""; ; {
				page = search(f.bob.Token, "人才", after, 1)
				for _, row := range page.Items {
					id := row["id"].(string)
					if seen[id] {
						t.Fatal("duplicate member across pages", id)
					}
					seen[id] = true
				}
				if page.NextAfter == "" {
					break
				}
				after = page.NextAfter
			}
			if len(seen) != 4 {
				t.Fatal("open group pagination omitted members", seen)
			}
			continue
		}
		if page.MembersVisibility != "managers" || page.SearchScope != "friends" || len(page.Items) != 2 {
			t.Fatalf("default roster: %+v", page)
		}
		for _, row := range page.Items {
			if row["role"] != "owner" && row["role"] != "admin" {
				t.Fatal("ordinary member leaked", row)
			}
		}
		var ids struct {
			Items []string `json:"items"`
		}
		f.request(t, "GET", prefix+"/members", f.bob.Token, nil, 200, &ids)
		if len(ids.Items) != 2 {
			t.Fatal("ID directory bypassed roster privacy", ids)
		}
		for _, query := range []string{"100", "工作", "ROL01", "8899", "%", "  工作  "} {
			page = search(f.bob.Token, query, "", 100)
			if page.Query != strings.TrimSpace(query) || page.SearchScope != "friends" || len(page.Items) != 1 || page.Items[0]["id"] != f.carol.UserID || page.Items[0]["is_contact"] != true {
				t.Fatalf("friend search %q: %+v", query, page)
			}
		}
		for _, query := range []string{"陌生", "管理", "群外", "bob01", "_' OR 1=1 --"} {
			if page = search(f.bob.Token, query, "", 100); len(page.Items) != 0 {
				t.Fatalf("search escaped friend/group scope %q: %+v", query, page)
			}
		}
		page = search(f.bob.Token, "人才", "", 1)
		if len(page.Items) != 1 || page.NextAfter == "" {
			t.Fatalf("first cursor page: %+v", page)
		}
		second := search(f.bob.Token, "人才", page.NextAfter, 1)
		if len(second.Items) != 1 || second.NextAfter != "" || second.Items[0]["id"] == page.Items[0]["id"] {
			t.Fatalf("second cursor page: %+v", second)
		}
		manager := search(f.alice.Token, "人才", "", 100)
		if manager.SearchScope != "group" || len(manager.Items) != 4 {
			t.Fatalf("owner search regressed: %+v", manager)
		}
	}
	// The same URL and an old cursor must use the viewer's current role and friendship.
	f.exec(t, "UPDATE pulse.members SET role='admin' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	if page := search(f.bob.Token, "陌生", "", 100); page.SearchScope != "group" || len(page.Items) != 1 {
		t.Fatalf("admin search: %+v", page)
	}
	f.exec(t, "UPDATE pulse.members SET role='member' WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID)
	f.exec(t, "DELETE FROM pulse.friendships WHERE user_low=LEAST($1::uuid,$2::uuid) AND user_high=GREATEST($1::uuid,$2::uuid)", f.bob.UserID, f.carol.UserID)
	if page := search(f.bob.Token, "100", "", 100); page.SearchScope != "friends" || len(page.Items) != 0 {
		t.Fatalf("removed friendship remained searchable: %+v", page)
	}
	f.request(t, "GET", prefix+"/member-profiles?limit=0", f.bob.Token, nil, 400, nil)
	f.request(t, "GET", prefix+"/member-profiles?limit=101", f.bob.Token, nil, 400, nil)
	f.request(t, "GET", prefix+"/member-profiles?q="+strings.Repeat("x", 101), f.bob.Token, nil, 400, nil)
	f.request(t, "GET", prefix+"/member-profiles?after=bad", f.bob.Token, nil, 400, nil)
	f.request(t, "GET", "/api/v2/groups/"+f.cid+"/member-profiles?q=alice", f.bob.Token, nil, 403, nil)
	if err = f.service.RemoveGroupMember(f.ctx, f.alice.Identity, group.ID, f.bob.UserID); err != nil {
		t.Fatal(err)
	}
	f.request(t, "GET", prefix+"/member-profiles?q=人才", f.bob.Token, nil, 403, nil)
}
