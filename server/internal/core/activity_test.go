package core

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestActivitySkipsBusyCredentialsAndUpdatesOtherUsers(t *testing.T) {
	f := newFixture(t)
	f.exec(t, "UPDATE pulse.users SET last_active_at=now()-interval '2 minutes'")
	f.exec(t, "UPDATE pulse.login_sessions SET last_used_at=now()-interval '2 minutes'")
	reader, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Rollback(f.ctx)
	if _, err = lockIdentity(f.ctx, reader, f.alice.Identity); err != nil {
		t.Fatal(err)
	}
	var workers sync.WaitGroup
	for range 32 {
		workers.Go(func() {
			f.service.noteActivity(f.alice.Identity)
			f.service.noteActivity(f.bob.Identity)
		})
	}
	workers.Wait()
	if len(f.service.activity) != 2 {
		t.Fatal("activity was not coalesced by session")
	}
	ctx, cancel := context.WithTimeout(f.ctx, time.Second)
	defer cancel()
	if err = f.service.flushActivity(ctx); err != nil {
		t.Fatalf("activity queued behind authentication: %v", err)
	}
	assertRecent := func(who Identity, want bool) {
		t.Helper()
		var userRecent, sessionRecent bool
		err := f.store.Pool.QueryRow(f.ctx, `SELECT u.last_active_at>now()-interval '30 seconds',
			s.last_used_at>now()-interval '30 seconds' FROM pulse.users u
			JOIN pulse.login_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2`, who.UserID, who.SessionID).Scan(&userRecent, &sessionRecent)
		if err != nil || userRecent != want || sessionRecent != want {
			t.Fatalf("unexpected activity state: user=%v session=%v want=%v err=%v", userRecent, sessionRecent, want, err)
		}
	}
	assertRecent(f.alice.Identity, false)
	assertRecent(f.bob.Identity, true)
	if _, err = f.service.ClientConversations(ctx, f.alice.Identity, "", f.cid); err != nil {
		t.Fatalf("activity blocked subsequent authenticated requests: %v", err)
	}
	if err = reader.Rollback(f.ctx); err != nil {
		t.Fatal(err)
	}
	f.service.noteActivity(f.alice.Identity)
	if err = f.service.flushActivity(f.ctx); err != nil {
		t.Fatal(err)
	}
	assertRecent(f.alice.Identity, true)
}

func waitForCredentialLock(t *testing.T, f *fixture) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := f.store.Pool.QueryRow(f.ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid())`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("credential request did not reach the lock barrier")
}

func TestIdentityReadRecoversSnapshotChangedByActivity(t *testing.T) {
	f := newFixture(t)
	writer, err := f.store.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(f.ctx)
	if _, err = writer.Exec(f.ctx, "UPDATE pulse.users SET last_active_at=now() WHERE id=$1", f.alice.UserID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		tx, e := f.service.beginIdentityRead(f.ctx, f.alice.Identity)
		if e == nil {
			e = tx.Commit(f.ctx)
		}
		result <- e
	}()
	waitForCredentialLock(t, f)
	if err = writer.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; err != nil {
		t.Fatalf("activity-only update escaped as a read failure: %v", err)
	}
}

func TestIdentityReadPreservesFreezeAndRevocationBoundary(t *testing.T) {
	for _, change := range []string{
		"UPDATE pulse.users SET active=false WHERE id=$1",
		"UPDATE pulse.login_sessions SET revoked_at=now() WHERE user_id=$1",
	} {
		t.Run(change, func(t *testing.T) {
			f := newFixture(t)
			reader, err := f.service.beginIdentityRead(f.ctx, f.alice.Identity)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Rollback(f.ctx)
			result := make(chan error, 1)
			go func() {
				_, e := f.store.Pool.Exec(f.ctx, change, f.alice.UserID)
				result <- e
			}()
			waitForCredentialLock(t, f)
			select {
			case err = <-result:
				t.Fatalf("credential change bypassed the authenticated transaction: %v", err)
			default:
			}
			if err = reader.Commit(f.ctx); err != nil {
				t.Fatal(err)
			}
			if err = <-result; err != nil {
				t.Fatal(err)
			}
			var stale pgx.Tx
			stale, err = f.service.beginIdentityRead(f.ctx, f.alice.Identity)
			if stale != nil {
				_ = stale.Rollback(f.ctx)
			}
			if !errors.Is(err, ErrUnauthorized) {
				t.Fatalf("old identity admitted after credential change: %v", err)
			}
		})
	}
}
