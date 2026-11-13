package main

import "testing"

func TestDispatchImageRequiresVerifiedArchive(t *testing.T) {
	cloud := "https://nim-nosdn.netease.im/old-image"
	imported := &importer{
		imageURLMessageIDs: map[string]int64{cloud: 42},
		mediaPaths: map[string]legacyMedia{
			"external/message/42":      {ID: "external"},
			"uploads/2026/11/test.png": {ID: "local"},
		},
	}
	for _, input := range []struct {
		url  string
		want string
	}{
		{cloud, "external"},
		{"https://legacy.example/uploads/2026/11/test.png", "local"},
		{"https://nim-nosdn.netease.im/missing", ""},
		{"https://untrusted.example/old-image", ""},
	} {
		media, ok := imported.dispatchImage(input.url)
		if ok != (input.want != "") || media.ID != input.want {
			t.Fatalf("unexpected mapping for %s: %+v, %v", input.url, media, ok)
		}
	}
}
