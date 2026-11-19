package core

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type historyIdentityRow struct {
	values []any
	err    error
}

func (r historyIdentityRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != len(r.values) {
		return errors.New("unexpected identity scan")
	}
	for i, value := range r.values {
		reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
	}
	return nil
}

type historyIdentityTx struct {
	pgx.Tx
	internal       bool
	userMissing    bool
	sessionRevoked bool
	adminRole      string
	adminRevoked   bool
}

func (tx historyIdentityTx) QueryRow(_ context.Context, query string, _ ...any) pgx.Row {
	switch {
	case strings.Contains(query, "FROM pulse.admin_accounts"):
		return historyIdentityRow{values: []any{tx.adminRole, []string{"users:write"}}}
	case strings.Contains(query, "FROM pulse.admin_sessions"):
		if tx.adminRevoked {
			return historyIdentityRow{err: pgx.ErrNoRows}
		}
		return historyIdentityRow{values: []any{"admin-session"}}
	case strings.Contains(query, "FROM pulse.users"):
		if tx.userMissing {
			return historyIdentityRow{err: pgx.ErrNoRows}
		}
		return historyIdentityRow{values: []any{tx.internal}}
	case strings.Contains(query, "FROM pulse.login_sessions"):
		if tx.sessionRevoked {
			return historyIdentityRow{err: pgx.ErrNoRows}
		}
		return historyIdentityRow{values: []any{"user-session"}}
	}
	return historyIdentityRow{err: errors.New("unexpected identity query")}
}

func TestHistoryDeletionUsesFreshAccountAndSessionPermissions(t *testing.T) {
	user := Identity{UserID: "actor", SessionID: "user-session"}
	admin := Identity{UserID: "ordinary-target", administrator: &AdminIdentity{ID: "admin", SessionID: "admin-session"}, adminModule: "users"}
	for _, tc := range []struct {
		name string
		tx   historyIdentityTx
		who  Identity
		want error
	}{
		{"ordinary user denied", historyIdentityTx{}, user, ErrForbidden},
		{"internal staff permitted", historyIdentityTx{internal: true}, user, nil},
		{"demoted staff denied with unchanged token", historyIdentityTx{}, user, ErrForbidden},
		{"revoked staff session rejected", historyIdentityTx{internal: true, sessionRevoked: true}, user, ErrUnauthorized},
		{"inactive user rejected", historyIdentityTx{internal: true, userMissing: true}, user, ErrUnauthorized},
		{"authorized administrator may manage ordinary user history", historyIdentityTx{adminRole: "superadmin"}, admin, nil},
		{"audit-only administrator cannot delete", historyIdentityTx{adminRole: "auditor"}, admin, ErrForbidden},
		{"revoked administrator cannot delete", historyIdentityTx{adminRole: "superadmin", adminRevoked: true}, admin, ErrUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := lockHistoryDeletionIdentity(context.Background(), tc.tx, tc.who); !errors.Is(err, tc.want) {
				t.Fatalf("permission result %v, want %v", err, tc.want)
			}
		})
	}
}

func TestOrdinaryUsersCannotDeleteTheirChatHistory(t *testing.T) {
	f := newFixture(t)
	first, second := f.send(t, "history-policy-1", "保留一"), f.send(t, "history-policy-2", "保留二")
	clearPath := "/api/v2/conversations/" + f.cid + "/clear"
	deletePath := "/api/v2/conversations/" + f.cid + "/personal-deletions"
	clear := map[string]string{"through_seq": "2"}
	remove := map[string][]string{"message_ids": {first.ID, second.ID}}
	f.request(t, "PUT", clearPath, f.bob.Token, clear, 403, nil)
	f.request(t, "POST", deletePath, f.bob.Token, remove, 403, nil)
	var deletions, clearSeq, events int
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT count(*) FROM pulse.message_deletions WHERE user_id=$1", f.bob.UserID).Scan(&deletions); err != nil {
		t.Fatal(err)
	}
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT clear_seq,personal_seq FROM pulse.user_states WHERE conversation_id=$1 AND user_id=$2", f.cid, f.bob.UserID).Scan(&clearSeq, &events); err != nil {
		t.Fatal(err)
	}
	if deletions != 0 || clearSeq != 0 || events != 0 {
		t.Fatal("a forbidden request changed history or emitted personal events")
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.bob.UserID)
	f.request(t, "POST", deletePath, f.bob.Token, map[string][]string{"message_ids": {first.ID}}, 200, nil)
	f.exec(t, "UPDATE pulse.users SET internal_staff=false WHERE id=$1", f.bob.UserID)
	f.request(t, "PUT", clearPath, f.bob.Token, clear, 403, nil)
	f.request(t, "POST", deletePath, f.bob.Token, map[string][]string{"message_ids": {second.ID}}, 403, nil)
	group, err := f.service.CreateGroup(f.ctx, f.alice.Identity, "ordinary group owner", nil)
	if err != nil {
		t.Fatal(err)
	}
	f.request(t, "PUT", "/api/v2/conversations/"+group.ID+"/clear", f.alice.Token, map[string]string{"through_seq": "0"}, 403, nil)
}

// Earlier history/receipt tests exercise authorized deletion semantics. Grant
// staff only for that operation, restoring the actor's original role afterward.
func (f *fixture) historyDeletionGrant(t *testing.T, who Identity) func() {
	t.Helper()
	if who.administrator != nil {
		return func() {}
	}
	var previous bool
	if err := f.store.Pool.QueryRow(f.ctx, "SELECT internal_staff FROM pulse.users WHERE id=$1", who.UserID).Scan(&previous); err != nil {
		t.Fatal(err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", who.UserID)
	return func() { f.exec(t, "UPDATE pulse.users SET internal_staff=$2 WHERE id=$1", who.UserID, previous) }
}

func (f *fixture) clearHistoryAsStaff(t *testing.T, ctx context.Context, who Identity, cid string, through int64) (State, error) {
	t.Helper()
	restore := f.historyDeletionGrant(t, who)
	defer restore()
	return f.service.ClearHistory(ctx, who, cid, through)
}

func (f *fixture) deleteMessagesAsStaff(t *testing.T, ctx context.Context, who Identity, cid string, ids []string) (State, error) {
	t.Helper()
	restore := f.historyDeletionGrant(t, who)
	defer restore()
	return f.service.DeletePersonalMessages(ctx, who, cid, ids)
}

func (f *fixture) requestHistoryAsStaff(t *testing.T, method, path, token string, value any, want int, out any) {
	t.Helper()
	for _, login := range []Login{f.alice, f.bob, f.carol} {
		if login.Token == token {
			restore := f.historyDeletionGrant(t, login.Identity)
			defer restore()
			break
		}
	}
	f.request(t, method, path, token, value, want, out)
}
