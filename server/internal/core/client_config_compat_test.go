package core

import (
	"encoding/json"
	"testing"
)

func TestClientAnnouncementSupportsGoAndOlderNativeDecoders(t *testing.T) {
	for _, tc := range []struct {
		name, raw, title, body string
		version, revision      int64
		enabled                bool
	}{
		{"disabled empty", `{"enabled":false,"title":"","body":""}`, "", "", 1, 1, false},
		{"enabled", `{"enabled":true,"title":"公告","body":"探索入口正常"}`, "公告", "探索入口正常", 7, 7, true},
		{"disabled with saved content", `{"enabled":false,"title":"旧公告","body":"已保存内容"}`, "旧公告", "已保存内容", 2, 2, false},
		{"missing optional stored values", `{}`, "", "", 1, 1, false},
		{"missing version", `{"body":"body"}`, "", "body", 0, 1, false},
		{"negative version", `{"body":"body"}`, "", "body", -1, 1, false},
		{"stored aliases cannot override authoritative fields", `{"body":"canonical","content":"stale","id":"old","revision":"stale"}`, "", "canonical", 8, 8, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := clientAnnouncement(json.RawMessage(tc.raw), tc.version)
			if err != nil {
				t.Fatal(err)
			}
			if got.ID != 1 || got.Title != tc.title || got.Body != tc.body || got.Content != tc.body || got.Enabled != tc.enabled || got.Revision != tc.revision {
				t.Fatalf("incorrect announcement: %+v", got)
			}
			raw, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			var wire map[string]any
			if err = json.Unmarshal(raw, &wire); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"id", "enabled", "title", "body", "content", "revision"} {
				if _, ok := wire[key]; !ok {
					t.Fatal("native decoder required field omitted", key)
				}
			}
			if _, ok := wire["id"].(float64); !ok {
				t.Fatal("legacy announcement ID must be a JSON number")
			}
			if _, ok := wire["revision"].(float64); !ok {
				t.Fatal("legacy revision must be a JSON number")
			}
		})
	}
	for _, raw := range []string{`{`, `[]`, `true`, `{"body":42}`} {
		if _, err := clientAnnouncement(json.RawMessage(raw), 1); err == nil {
			t.Fatal("invalid configuration silently became a successful empty response", raw)
		}
	}
}

func TestPublicConfigAnnouncementCompatibilityDoesNotRewriteStoredSetting(t *testing.T) {
	f := newFixture(t)
	f.exec(t, `UPDATE pulse.system_settings SET value='{"enabled":false,"title":"公告","body":"保留探索"}',version=7 WHERE key='announcement'`)
	var response struct {
		Announcement ClientAnnouncement `json:"announcement"`
		Version      string             `json:"announcement_version"`
		Protocol     string             `json:"protocol"`
	}
	f.request(t, "GET", "/api/v2/client/config", "", nil, 200, &response)
	if response.Protocol != "pulse-v2" || response.Version != "7" || response.Announcement.Revision != 7 || response.Announcement.ID != 1 || response.Announcement.Content != "保留探索" || response.Announcement.Body != "保留探索" || response.Announcement.Enabled {
		t.Fatalf("incomplete public configuration: %+v", response)
	}
	var stored []byte
	if err := f.store.Pool.QueryRow(f.ctx, `SELECT value FROM pulse.system_settings WHERE key='announcement'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var original map[string]any
	if err := json.Unmarshal(stored, &original); err != nil {
		t.Fatal(err)
	}
	if _, exists := original["id"]; exists || len(original) != 3 || original["body"] != "保留探索" {
		t.Fatal("public configuration read rewrote the administrator setting", original)
	}
}
