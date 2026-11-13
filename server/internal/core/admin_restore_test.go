package core

import "testing"

func TestAdminRestoreDeletedUserKeepsRevokedSessionsRevoked(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	f.exec(t, "UPDATE pulse.users SET active=false,deleted_at=now() WHERE id=$1", f.bob.UserID)
	f.exec(t, "UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1", f.bob.UserID)
	root.request(t, "POST", "/api/v2/admin/users/"+f.bob.UserID+"/restore", map[string]any{}, 204, nil)
	var active bool
	var deleted bool
	var liveSessions int
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT active,deleted_at IS NOT NULL,
        (SELECT count(*) FROM pulse.login_sessions WHERE user_id=$1 AND revoked_at IS NULL)
        FROM pulse.users WHERE id=$1`, f.bob.UserID).Scan(&active, &deleted, &liveSessions); err != nil {
		t.Fatal(err)
	}
	if !active || deleted || liveSessions != 0 {
		t.Fatalf("restore did not preserve session revocation: active=%t deleted=%t sessions=%d", active, deleted, liveSessions)
	}
	root.request(t, "POST", "/api/v2/admin/users/"+f.bob.UserID+"/restore", map[string]any{}, 409, nil)
}

func TestAdminCanReadUserAvatarWithoutMessageReference(t *testing.T) {
	f := newFixture(t)
	enableTestMedia(t, f)
	root := newAdmin(t, f)
	image := uploadTestImage(t, f, f.alice, imageBytes(t, 80, 60), true)
	f.exec(t, "UPDATE pulse.users SET avatar_id=$2 WHERE id=$1", f.alice.UserID, image.ID)
	root.request(t, "GET", "/api/v2/admin/media/"+image.ID+"/content", nil, 200, nil)
	// An unreferenced upload is not a user avatar and remains unavailable to
	// administrators who do not own it.
	orphan := uploadTestImage(t, f, f.alice, imageBytes(t, 40, 40), true)
	root.request(t, "GET", "/api/v2/admin/media/"+orphan.ID+"/content", nil, 403, nil)
}
