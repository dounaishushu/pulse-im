package core

import "time"

type Identity struct {
	UserID    string    `json:"user_id"`
	SessionID string    `json:"session_id"`
	DeviceID  string    `json:"device_id"`
	ExpiresAt time.Time `json:"expires_at"`
}
type Login struct {
	Identity
	Token string `json:"access_token"`
}
type Message struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Seq            int64     `json:"seq,string"`
	EventSeq       int64     `json:"event_seq,string"`
	SenderID       string    `json:"sender_id"`
	RequestID      string    `json:"request_id"`
	Body           string    `json:"body"`
	Revoked        bool      `json:"revoked"`
	Version        int64     `json:"version,string"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}
type SendInput struct {
	RequestID       string `json:"request_id"`
	Body            string `json:"body"`
	SourceMessageID string `json:"source_message_id,omitempty"`
}
type SendResult struct {
	Message   Message `json:"message"`
	Duplicate bool    `json:"duplicate"`
}
type State struct {
	UserID       string `json:"user_id"`
	ReadSeq      int64  `json:"read_seq,string"`
	DeliveredSeq int64  `json:"delivered_seq,string"`
	ClearSeq     int64  `json:"clear_seq,string"`
	Version      int64  `json:"version,string"`
	PersonalSeq  int64  `json:"personal_seq,string"`
	Reminder     bool   `json:"reminder"`
}
type HistoryScope struct {
	VisibleFromSeq      int64 `json:"visible_from_seq,string"`
	VisibleFromEventSeq int64 `json:"visible_from_event_seq,string"`
	MembershipVersion   int64 `json:"membership_version,string"`
	HistoryAllowed      bool  `json:"history_allowed"`
}

func scopeOf(a access) HistoryScope {
	return HistoryScope{a.VisibleFrom, a.VisibleFromEvent, a.MembershipVersion, a.HistoryAllowed}
}

type Conversation struct {
	HistoryScope
	Temporary  bool   `json:"temporary"`
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	MessageSeq int64  `json:"message_seq,string"`
	EventSeq   int64  `json:"event_seq,string"`
	State      State  `json:"state"`
}
type SyncEvent struct {
	Seq     int64   `json:"seq,string"`
	Kind    string  `json:"kind"`
	Message Message `json:"message"`
}
type SyncPage struct {
	HistoryScope
	Events         []SyncEvent `json:"events"`
	SnapshotMaxSeq int64       `json:"snapshot_max_seq,string"`
	NextAfterSeq   int64       `json:"next_after_seq,string"`
	HasMore        bool        `json:"has_more"`
}
type PersonalEvent struct {
	Seq         int64  `json:"seq,string"`
	Kind        string `json:"kind"`
	MessageID   string `json:"message_id,omitempty"`
	BoundarySeq int64  `json:"boundary_seq,string,omitempty"`
	Reminder    *bool  `json:"reminder,omitempty"`
}
type PersonalPage struct {
	Events         []PersonalEvent `json:"events"`
	SnapshotMaxSeq int64           `json:"snapshot_max_seq,string"`
	NextAfterSeq   int64           `json:"next_after_seq,string"`
	HasMore        bool            `json:"has_more"`
}
type Unread struct {
	Count     int  `json:"count"`
	Truncated bool `json:"truncated"`
}
type Hint struct {
	Type           string `json:"type"`
	ConversationID string `json:"conversation_id"`
	EventSeq       int64  `json:"event_seq,string,omitempty"`
	UserID         string `json:"user_id,omitempty"`
	StateVersion   int64  `json:"state_version,string,omitempty"`
}
