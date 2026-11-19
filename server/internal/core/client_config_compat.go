package core

import "encoding/json"

// Keep the Go body field and the complete announcement consumed by older
// native clients in one response. The stored administrator setting is unchanged.
type ClientAnnouncement struct {
	ID       int64  `json:"id"`
	Enabled  bool   `json:"enabled"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Content  string `json:"content"`
	Revision int64  `json:"revision"`
}

func clientAnnouncement(raw json.RawMessage, version int64) (ClientAnnouncement, error) {
	var stored struct {
		Enabled bool   `json:"enabled"`
		Title   string `json:"title"`
		Body    string `json:"body"`
	}
	if err := json.Unmarshal(raw, &stored); err != nil {
		return ClientAnnouncement{}, err
	}
	if version < 1 {
		version = 1
	}
	return ClientAnnouncement{ID: 1, Enabled: stored.Enabled, Title: stored.Title,
		Body: stored.Body, Content: stored.Body, Revision: version}, nil
}
