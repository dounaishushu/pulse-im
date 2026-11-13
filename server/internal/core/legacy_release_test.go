package core

import "testing"

func TestLegacyTwoPartIOSReleaseRemainsComparable(t *testing.T) {
	short, ok := versionNumber("1.0")
	full, fullOK := versionNumber("1.0.0")
	if !ok || !fullOK || short != full {
		t.Fatal("old two-part version changed meaning")
	}
	f := newFixture(t)
	f.exec(t, `UPDATE pulse.system_settings SET value=
 '{"ios":{"latest":"1.0","minimum":"","force":false,"url":"","notes":""}}'
 WHERE key='releases'`)
	older, err := f.service.CheckUpdate(f.ctx, "ios", "0.9")
	if err != nil || older["update_available"] != true || older["required"] != false {
		t.Fatalf("old iOS release was not offered: %+v, %v", older, err)
	}
	current, err := f.service.CheckUpdate(f.ctx, "ios", "1.0.0")
	if err != nil || current["update_available"] != false {
		t.Fatalf("equal legacy versions were treated as different: %+v, %v", current, err)
	}
}
