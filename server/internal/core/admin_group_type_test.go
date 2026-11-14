package core

import (
	"errors"
	"testing"
)

func TestAdminGroupChannelConversionRefreshesPermissionsWithoutLosingHistory(t *testing.T) {
	f := newFixture(t)
	root := newAdmin(t, f)
	input := AdminGroupInput{Title: "convertible", OwnerID: f.alice.UserID, Kind: "group", Policy: "open", Limit: 100, Active: true, Offset: 50}
	group, err := f.service.AdminSaveGroup(f.ctx, root.who, "", input)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.JoinGroup(f.ctx, f.bob.Identity, group.ID, ""); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "before-conversion", Body: "kept history"}); err != nil {
		t.Fatal(err)
	}
	var prior int64
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT membership_version FROM pulse.members WHERE conversation_id=$1 AND user_id=$2", group.ID, f.bob.UserID).Scan(&prior); err != nil {
		t.Fatal(err)
	}
	input.Kind = "channel"
	if _, err = f.service.AdminSaveGroup(f.ctx, root.who, group.ID, input); err != nil {
		t.Fatal(err)
	}
	var version int64
	var kind string
	var offset int
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT c.kind,c.display_count_offset,m.membership_version FROM pulse.conversations c JOIN pulse.members m ON m.conversation_id=c.id WHERE c.id=$1 AND m.user_id=$2", group.ID, f.bob.UserID).Scan(&kind, &offset, &version); err != nil || kind != "channel" || offset != 0 || version <= prior {
		t.Fatal("type, count or permission version not updated", err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "channel-denied", Body: "forbidden"}); !errors.Is(err, ErrForbidden) {
		t.Fatal("ordinary member could send after channel conversion", err)
	}
	history, err := f.service.History(f.ctx, f.bob.Identity, group.ID, 0, 0, 0, nil, 10, false, nil)
	if err != nil || len(history.Items) != 1 {
		t.Fatal("conversion lost history", err)
	}
	input.Kind = "group"
	if _, err = f.service.AdminSaveGroup(f.ctx, root.who, group.ID, input); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "group-restored", Body: "allowed again"}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.service.AdminSaveGroup(f.ctx, root.who, f.cid, input); !errors.Is(err, ErrConflict) {
		t.Fatal("direct conversation could be converted into group", err)
	}
	input.Kind = "customer_service"
	if _, err = f.service.AdminSaveGroup(f.ctx, root.who, group.ID, input); err != nil {
		t.Fatal(err)
	}
	var classification string
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT kind,management_type,display_count_offset FROM pulse.conversations WHERE id=$1", group.ID).Scan(&kind, &classification, &offset); err != nil || kind != "group" || classification != "customer_service" || offset != 0 {
		t.Fatal("customer-service classification not preserved", err)
	}
	if _, err = f.service.Send(f.ctx, f.bob.Identity, group.ID, SendInput{RequestID: "customer-classification", Body: "ordinary membership still applies"}); err != nil {
		t.Fatal(err)
	}
	input.Kind = "channel"
	if _, err = f.service.AdminSaveGroup(f.ctx, root.who, group.ID, input); err != nil {
		t.Fatal(err)
	}
	if err = f.store.Pool.QueryRow(f.ctx, "SELECT management_type FROM pulse.conversations WHERE id=$1", group.ID).Scan(&classification); err != nil || classification != "" {
		t.Fatal("stale customer-service classification", err)
	}
}
