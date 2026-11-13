package core

import (
	"errors"
	"testing"
)

func TestLegacyPrivacySettingsPersistWithRoleChecks(t *testing.T) {
	f := newFixture(t)
	bob, err := f.service.ContactPrivacy(f.ctx, f.bob.Identity)
	if err != nil {
		t.Fatal(err)
	}
	if bob.PhoneSearch.Visibility != "everyone" || bob.VoiceCall.Visibility != "everyone" || !bob.ShowActiveSessions {
		t.Fatalf("legacy privacy defaults changed: %+v", bob)
	}
	show := false
	bob, err = f.service.UpdateContactPrivacy(f.ctx, f.bob.Identity, PrivacyPatch{
		ExpectedVersion: &bob.Version, ShowActiveSessions: &show,
	})
	if err != nil || bob.ShowActiveSessions {
		t.Fatalf("ordinary user could not change own session visibility: %+v %v", bob, err)
	}
	search := PrivacyRule{Visibility: "contacts", Allow: []string{f.alice.UserID}, Deny: []string{}}
	_, err = f.service.UpdateContactPrivacy(f.ctx, f.bob.Identity, PrivacyPatch{
		ExpectedVersion: &bob.Version, PhoneSearch: &search,
	})
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("ordinary user changed staff-managed privacy: %v", err)
	}
	f.exec(t, "UPDATE pulse.users SET internal_staff=true WHERE id=$1", f.alice.UserID)
	alice, err := f.service.ContactPrivacy(f.ctx, f.alice.Identity)
	if err != nil {
		t.Fatal(err)
	}
	search.Allow = []string{f.bob.UserID}
	voice := PrivacyRule{Visibility: "nobody", Allow: []string{}, Deny: []string{f.carol.UserID}}
	p2p := "contacts"
	alice, err = f.service.UpdateContactPrivacy(f.ctx, f.alice.Identity, PrivacyPatch{
		ExpectedVersion: &alice.Version, PhoneSearch: &search, VoiceCall: &voice,
		VoiceCallPeerToPeer: &p2p,
	})
	if err != nil || alice.PhoneSearch.Visibility != "contacts" || alice.VoiceCall.Visibility != "nobody" || alice.VoiceCallPeerToPeer != "contacts" || len(alice.PhoneSearch.Allow) != 1 || len(alice.VoiceCall.Deny) != 1 {
		t.Fatalf("legacy privacy fields lost: %+v %v", alice, err)
	}
	search.Visibility = "nobody"
	_, err = f.service.UpdateContactPrivacy(f.ctx, f.alice.Identity, PrivacyPatch{
		ExpectedVersion: &alice.Version, PhoneSearch: &search,
	})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("old phone-search enum was not enforced: %v", err)
	}
}
