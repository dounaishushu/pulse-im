package core

import (
	"errors"
	"strconv"
	"testing"
)

func TestFrozenUserPreservesExistingContactInformationAndHistory(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	avatar := uploadTestImage(t, f, f.bob, imageBytes(t, 20, 20), false)
	f.exec(t, "UPDATE pulse.users SET nickname='原来的昵称',avatar_id=$2,last_active_at=now() WHERE id=$1", f.bob.UserID, avatar.ID)
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	f.exec(t, "INSERT INTO pulse.legacy_ids(entity,legacy_id,new_id) VALUES('user',123456789,$1)", f.bob.UserID)
	if err := f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "原来的客户备注", "重要客户", 0); err != nil {
		t.Fatal(err)
	}
	sent := f.send(t, "before-freeze", "冻结前的消息记录")
	card, err := f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "card-before-freeze", Kind: "contact", CardUserID: f.bob.UserID})
	if err != nil {
		t.Fatal(err)
	}
	before, err := f.service.Profile(f.ctx, f.alice.Identity, f.bob.UserID, "")
	if err != nil {
		t.Fatal(err)
	}
	admin := newAdmin(t, f)
	admin.request(t, "PATCH", "/api/v2/admin/users/"+f.bob.UserID, map[string]any{"expected_version": strconv.FormatInt(before.Version, 10), "active": false}, 204, nil)

	for _, path := range []string{"/api/v2/client/friends", "/api/v2/client/friend-page?size=1"} {
		var page struct {
			Items []ClientUser `json:"items"`
		}
		f.request(t, "GET", path, f.alice.Token, nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != f.bob.UserID || page.Items[0].Nickname != before.Nickname || page.Items[0].Remark != before.Remark || page.Items[0].GroupName != before.GroupName || page.Items[0].AvatarID != avatar.ID {
			t.Fatalf("frozen friend lost existing identity or viewer metadata at %s: %+v", path, page)
		}
	}
	ids, err := f.service.Friends(f.ctx, f.alice.Identity, "")
	if err != nil || len(ids) != 1 || ids[0] != f.bob.UserID {
		t.Fatal("freeze removed the friendship", ids, err)
	}
	for _, path := range []string{"/api/v2/profiles/" + f.bob.UserID, "/api/v2/public-users/" + before.PublicID, "/api/v2/public-users/legacy/123456789"} {
		var profile Profile
		f.request(t, "GET", path, f.alice.Token, nil, 200, &profile)
		if profile.ID != before.ID || profile.Account != before.Account || profile.Nickname != before.Nickname || profile.AvatarID != avatar.ID || profile.Remark != before.Remark || profile.GroupName != before.GroupName || profile.ContactVersion != before.ContactVersion || !profile.IsContact || profile.CanAddFriend || profile.Online || profile.LastSeen == nil || !profile.LastSeen.Equal(*before.LastSeen) {
			t.Fatalf("frozen profile lost existing fields or appeared online at %s: %+v", path, profile)
		}
	}
	var compact ClientUser
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID, f.alice.Token, nil, 200, &compact)
	if compact.Remark != before.Remark || compact.AvatarID != avatar.ID {
		t.Fatal("compact profile lost the frozen contact", compact)
	}
	var found PublicUser
	f.request(t, "GET", "/api/v2/users/by-account/bob01", f.alice.Token, nil, 200, &found)
	if found.ID != before.ID || found.AvatarID != avatar.ID {
		t.Fatal("known frozen contact cannot be found by account", found)
	}
	var friends struct {
		Total int `json:"total"`
	}
	f.request(t, "GET", "/api/v2/client/friend-page?size=1", f.alice.Token, nil, 200, &friends)
	if friends.Total != 1 {
		t.Fatal("frozen friend omitted from pagination count", friends.Total)
	}
	for _, path := range []string{"/api/v2/client/conversations", "/api/v2/client/conversation-page"} {
		var page struct {
			Items []ClientConversation `json:"items"`
		}
		f.request(t, "GET", path, f.alice.Token, nil, 200, &page)
		if len(page.Items) != 1 || page.Items[0].ID != f.cid || page.Items[0].PeerName != before.Nickname || page.Items[0].AvatarID != avatar.ID || page.Items[0].CanSend || page.Items[0].LastMessage == nil {
			t.Fatal("freeze removed or damaged the existing conversation", path, page)
		}
	}
	var presence struct {
		Items   []ClientConversationPresence `json:"items"`
		Removed []string                     `json:"removed_ids"`
	}
	f.request(t, "POST", "/api/v2/client/conversation-presence", f.alice.Token, map[string]any{"conversation_ids": []string{f.cid}}, 200, &presence)
	if len(presence.Items) != 1 || len(presence.Removed) != 0 || presence.Items[0].Online || presence.Items[0].LastSeen == nil {
		t.Fatal("freeze treated the old conversation as removed or its peer as online", presence)
	}
	page, err := f.service.Sync(f.ctx, f.alice.Identity, f.cid, 0, nil, 100)
	if err != nil || len(page.Events) != 2 || page.Events[0].Message.ID != sent.ID {
		t.Fatal("freeze removed the old message history", page, err)
	}
	opened, err := f.service.Direct(f.ctx, f.alice.Identity, f.bob.UserID)
	if err != nil || opened != f.cid {
		t.Fatal("existing frozen conversation cannot be reopened for reading", opened, err)
	}
	var access ConversationAccess
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/access", f.alice.Token, nil, 200, &access)
	if access.CanSend {
		t.Fatal("frozen peer became writable")
	}
	if _, err = f.service.Send(f.ctx, f.alice.Identity, f.cid, SendInput{RequestID: "after-freeze", Body: "must be refused"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("read visibility bypassed frozen-peer speech restrictions", err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, f.cid, SendInput{RequestID: "frozen-send", Body: "must be refused"}); !errors.Is(err, ErrUnauthorized) {
		t.Fatal("frozen account retained write permission", err)
	}
	f.request(t, "GET", "/api/v2/me", f.bob.Token, nil, 401, nil)
	f.request(t, "POST", "/api/v2/auth/login", "", map[string]string{"account": "bob01", "password": testPassword, "device_id": "frozen-login"}, 401, nil)
	// Administrative sending uses the stricter admission helper, never the UI's read-only reopen.
	tx, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = directConversationTx(f.ctx, tx, f.alice.Identity, f.bob.UserID); !errors.Is(err, ErrForbidden) {
		t.Fatal("frozen history reopen relaxed dispatch admission", err)
	}
	_ = tx.Rollback(f.ctx)
	var grant struct {
		ContentPath string `json:"content_path"`
	}
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 201, &grant)
	f.request(t, "GET", grant.ContentPath, f.alice.Token, nil, 200, nil)
	f.request(t, "GET", "/api/v2/staff/users/"+f.bob.UserID, f.alice.Token, nil, 200, nil)
	f.request(t, "GET", "/api/v2/conversations/"+f.cid+"/messages/"+card.Message.ID+"/contact", f.alice.Token, nil, 200, nil)
	if err = f.service.ContactMetadata(f.ctx, f.alice.Identity, f.bob.UserID, "冻结后保留的新备注", before.GroupName, before.ContactVersion); err != nil {
		t.Fatal("freeze prevented the viewer from maintaining their own remark", err)
	}
	profile, err := f.service.Profile(f.ctx, f.alice.Identity, f.bob.UserID, "")
	if err != nil || profile.Remark != "冻结后保留的新备注" {
		t.Fatal("frozen contact remark update was lost", profile, err)
	}
	admin.request(t, "PATCH", "/api/v2/admin/users/"+f.bob.UserID, map[string]any{"expected_version": strconv.FormatInt(profile.Version, 10), "active": true}, 204, nil)
	profile, err = f.service.Profile(f.ctx, f.alice.Identity, f.bob.UserID, "")
	if err != nil || profile.Remark != "冻结后保留的新备注" || profile.GroupName != before.GroupName {
		t.Fatal("restoring a frozen user overwrote existing metadata", profile, err)
	}
}

func TestFrozenUserReadVisibilityKeepsPrivacyAndDeletionBoundaries(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	avatar := uploadTestImage(t, f, f.bob, imageBytes(t, 20, 20), false)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2,active=false,last_active_at=now() WHERE id=$1", f.bob.UserID, avatar.ID)
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,phone,last_seen) VALUES($1,'nobody','nobody') ON CONFLICT(user_id) DO UPDATE SET phone='nobody',last_seen='nobody'", f.bob.UserID)
	profile, err := f.service.Profile(f.ctx, f.alice.Identity, f.bob.UserID, "")
	if err != nil || profile.LastSeen != nil || profile.Phone != nil || profile.Online || profile.CanAddFriend {
		t.Fatal("preserving the profile bypassed current privacy", profile, err)
	}
	for _, path := range []string{"/api/v2/users/by-account/bob01", "/api/v2/public-users/" + profile.PublicID} {
		f.request(t, "GET", path, f.carol.Token, nil, 404, nil)
	}
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID, f.carol.Token, nil, 403, nil)
	f.request(t, "GET", "/api/v2/profiles/"+f.bob.UserID, f.carol.Token, nil, 403, nil)
	f.request(t, "POST", "/api/v2/conversations/direct", f.carol.Token, map[string]string{"peer_id": f.bob.UserID}, 403, nil)
	f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", f.bob.UserID, f.alice.UserID)
	f.request(t, "GET", "/api/v2/users/by-account/bob01", f.alice.Token, nil, 404, nil)
	f.request(t, "GET", "/api/v2/public-users/"+profile.PublicID, f.alice.Token, nil, 404, nil)
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 403, nil)
	f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", f.bob.UserID, f.alice.UserID)
	f.exec(t, "UPDATE pulse.users SET deleted_at=now() WHERE id=$1", f.bob.UserID)
	var friends struct {
		Items []ClientUser `json:"items"`
		Total int          `json:"total"`
	}
	f.request(t, "GET", "/api/v2/client/friend-page", f.alice.Token, nil, 200, &friends)
	if len(friends.Items) != 0 || friends.Total != 0 {
		t.Fatal("deleted users were restored to the friend list", friends)
	}
	f.request(t, "GET", "/api/v2/profiles/"+f.bob.UserID, f.alice.Token, nil, 404, nil)
	f.request(t, "GET", "/api/v2/client/users/"+f.bob.UserID, f.alice.Token, nil, 403, nil)
	f.request(t, "GET", "/api/v2/users/by-account/bob01", f.alice.Token, nil, 404, nil)
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 403, nil)
}

func TestFrozenTemporaryConversationRetainsReadableIdentity(t *testing.T) {
	f := newFixture(t)
	cid, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.carol.UserID)
	f.request(t, "GET", "/api/v2/users/by-account/carol01", f.alice.Token, nil, 200, nil)
	var profile Profile
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID, f.alice.Token, nil, 200, &profile)
	if profile.IsContact || profile.CanAddFriend {
		t.Fatal("temporary history changed the relationship", profile)
	}
	reopened, err := f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil || reopened != cid {
		t.Fatal("temporary frozen history cannot be reopened", reopened, err)
	}
	f.request(t, "GET", "/api/v2/users/by-account/carol01", f.bob.Token, nil, 404, nil)
	// Preserving history never broadens the temporary-chat reopen policy.
	f.exec(t, "UPDATE pulse.user_states SET hidden=true WHERE conversation_id=$1 AND user_id=$2", cid, f.alice.UserID)
	for _, rule := range []string{"contacts", "nobody"} {
		f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,temporary_chat) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET temporary_chat=$2", f.carol.UserID, rule)
		f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.carol.UserID}, 403, nil)
	}
	f.exec(t, "UPDATE pulse.privacy_settings SET temporary_chat='everyone' WHERE user_id=$1", f.carol.UserID)
	f.exec(t, "INSERT INTO pulse.privacy_exceptions(user_id,peer_id,scope,effect) VALUES($1,$2,'temporary_chat','deny')", f.carol.UserID, f.alice.UserID)
	f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.carol.UserID}, 403, nil)
	f.exec(t, "UPDATE pulse.privacy_exceptions SET effect='allow' WHERE user_id=$1 AND peer_id=$2 AND scope='temporary_chat'", f.carol.UserID, f.alice.UserID)
	for _, pair := range [][2]string{{f.carol.UserID, f.alice.UserID}, {f.alice.UserID, f.carol.UserID}} {
		f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", pair[0], pair[1])
		f.request(t, "POST", "/api/v2/conversations/direct", f.alice.Token, map[string]string{"peer_id": f.carol.UserID}, 403, nil)
		f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", pair[0], pair[1])
	}
	var hidden bool
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT hidden FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", cid, f.alice.UserID).Scan(&hidden); err != nil || !hidden {
		t.Fatal("denied frozen-peer reopen changed the hidden conversation", hidden, err)
	}
	reopened, err = f.service.Direct(f.ctx, f.alice.Identity, f.carol.UserID)
	if err != nil || reopened != cid {
		t.Fatal("authorized frozen-peer history exception was ignored", reopened, err)
	}
}

func TestFrozenGroupSenderAvatarRemainsVisibleOnlyToParticipants(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	avatar := uploadTestImage(t, f, f.carol, imageBytes(t, 22, 22), false)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", f.carol.UserID, avatar.ID)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "existing participants", []string{f.carol.UserID})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := f.service.Send(f.ctx, f.carol.Identity, group.ID, SendInput{RequestID: "group-before-freeze", Body: "previous group message"})
	if err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET active=false WHERE id=$1", f.carol.UserID)
	var message Message
	f.request(t, "GET", "/api/v2/conversations/"+group.ID+"/messages/"+sent.Message.ID, f.alice.Token, nil, 200, &message)
	if message.Sender == nil || message.Sender.AvatarID != avatar.ID {
		t.Fatal("freezing a group sender erased their old avatar", message.Sender)
	}
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 201, nil)
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.bob.Token, nil, 403, nil)
}
