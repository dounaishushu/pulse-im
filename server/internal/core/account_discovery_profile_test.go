package core

import "testing"

func TestAccountDiscoveryProvidesAvatarAndPublicProfileWithoutFriendship(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	avatar := uploadTestImage(t, f, f.carol, imageBytes(t, 16, 16), false)
	f.exec(t, "UPDATE pulse.users SET nickname='搜索到的用户',avatar_id=$2,phone='13800138000' WHERE id=$1", f.carol.UserID, avatar.ID)
	f.exec(t, "INSERT INTO pulse.privacy_settings(user_id,phone,last_seen) VALUES($1,'nobody','nobody') ON CONFLICT(user_id) DO UPDATE SET phone='nobody',last_seen='nobody'", f.carol.UserID)
	var found map[string]any
	f.request(t, "GET", "/api/v2/users/by-account/CAROL01", f.alice.Token, nil, 200, &found)
	if len(found) != 5 || found["id"] != f.carol.UserID || found["account"] != "carol01" || found["nickname"] != "搜索到的用户" || found["avatar_id"] != avatar.ID || found["public_id"] == "" {
		t.Fatalf("account discovery must return exactly the five public identity fields: %+v", found)
	}
	publicPath := "/api/v2/public-users/" + found["public_id"].(string)
	var profile Profile
	f.request(t, "GET", publicPath, f.alice.Token, nil, 200, &profile)
	if profile.ID != f.carol.UserID || profile.AvatarID != avatar.ID || profile.Nickname != "搜索到的用户" || profile.IsContact || !profile.CanAddFriend || profile.Phone != nil || profile.LastSeen != nil || profile.Online {
		t.Fatalf("discovered public profile lost the avatar or bypassed privacy: %+v", profile)
	}
	// Knowing a UUID through discovery does not grant the relationship-only route.
	f.request(t, "GET", "/api/v2/profiles/"+f.carol.UserID, f.alice.Token, nil, 403, nil)
	var grant map[string]any
	f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 201, &grant)
	content, ok := grant["content_path"].(string)
	if !ok || content == "" {
		t.Fatalf("discovered avatar cannot be fetched: %+v", grant)
	}
	f.request(t, "GET", content, f.alice.Token, nil, 200, nil)
	for _, reverse := range []bool{false, true} {
		actor, peer := f.alice.UserID, f.carol.UserID
		if reverse {
			actor, peer = peer, actor
		}
		f.exec(t, "INSERT INTO pulse.blocks(user_id,peer_id) VALUES($1,$2)", actor, peer)
		f.request(t, "GET", "/api/v2/users/by-account/carol01", f.alice.Token, nil, 404, nil)
		f.request(t, "GET", publicPath, f.alice.Token, nil, 404, nil)
		f.request(t, "POST", "/api/v2/media/"+avatar.ID+"/grants", f.alice.Token, nil, 403, nil)
		f.exec(t, "DELETE FROM pulse.blocks WHERE user_id=$1 AND peer_id=$2", actor, peer)
	}
	f.exec(t, "UPDATE pulse.users SET account_is_internal=true WHERE id=$1", f.carol.UserID)
	f.request(t, "GET", "/api/v2/users/by-account/carol01", f.alice.Token, nil, 404, nil)
	f.exec(t, "UPDATE pulse.users SET account_is_internal=false,active=false WHERE id=$1", f.carol.UserID)
	f.request(t, "GET", "/api/v2/users/by-account/carol01", f.alice.Token, nil, 404, nil)
	f.request(t, "GET", publicPath, f.alice.Token, nil, 404, nil)
}
