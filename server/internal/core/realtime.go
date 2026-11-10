package core

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// The fixed queue contains small invalidation hints only. No message body
// history, retransmission map or per-recipient retry goroutine lives here.
type socket struct {
	identity Identity
	id       string
	conn     *websocket.Conn
	send     chan []byte
	done     chan struct{}
	mu       sync.Mutex
	closed   bool
	hub      *Hub
}
type Hub struct {
	mu             sync.RWMutex
	sessions       map[string]*socket
	devices        map[string]*socket
	slots          chan struct{}
	queuedBytes    atomic.Int64
	maxQueuedBytes int64
	shuttingDown   bool
}

func NewHub(maxConnections int, maxBytes int64) *Hub {
	return &Hub{sessions: make(map[string]*socket), devices: make(map[string]*socket), slots: make(chan struct{}, maxConnections), maxQueuedBytes: maxBytes}
}
func (h *Hub) reserve() bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.shuttingDown {
		return false
	}
	select {
	case h.slots <- struct{}{}:
		return true
	default:
		return false
	}
}
func (h *Hub) add(c *socket) bool {
	h.mu.Lock()
	if h.shuttingDown {
		h.mu.Unlock()
		return false
	}
	key := c.identity.UserID + ":" + c.identity.DeviceID
	old := h.devices[key]
	h.sessions[c.identity.SessionID] = c
	h.devices[key] = c
	h.mu.Unlock()
	if old != nil {
		old.close()
	}
	return true
}
func (c *socket) close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	close(c.done)
	// Drain pending bytes under the same producer lock. The writer may own
	// one already-dequeued frame and accounts for that frame itself.
	for {
		select {
		case frame := <-c.send:
			c.hub.queuedBytes.Add(-int64(len(frame)))
		default:
			c.mu.Unlock()
			goto drained
		}
	}
drained:
	if c.conn != nil {
		_ = c.conn.Close()
	}
	c.hub.mu.Lock()
	if c.hub.sessions[c.identity.SessionID] == c {
		delete(c.hub.sessions, c.identity.SessionID)
	}
	key := c.identity.UserID + ":" + c.identity.DeviceID
	if c.hub.devices[key] == c {
		delete(c.hub.devices, key)
	}
	c.hub.mu.Unlock()
}
func (c *socket) enqueue(frame []byte) bool {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return false
	}
	size := int64(len(frame))
	if c.hub.queuedBytes.Add(size) > c.hub.maxQueuedBytes {
		c.hub.queuedBytes.Add(-size)
		c.mu.Unlock()
		c.close()
		return false
	}
	select {
	case c.send <- frame:
		c.mu.Unlock()
		return true
	default:
		c.hub.queuedBytes.Add(-size)
		c.mu.Unlock()
		c.close()
		return false
	}
}
func (h *Hub) SessionIDs() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	ids := make([]string, 0, len(h.sessions))
	for id := range h.sessions {
		ids = append(ids, id)
	}
	return ids
}
func (h *Hub) Deliver(sessions []string, hint Hint) {
	frame, _ := json.Marshal(hint)
	h.mu.RLock()
	clients := make([]*socket, 0, len(sessions))
	for _, sid := range sessions {
		if c := h.sessions[sid]; c != nil {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()

	var publicFrame []byte
	if hint.Type == "state.changed" {
		publicFrame, _ = json.Marshal(Hint{Type: "receipts.changed", ConversationID: hint.ConversationID})
	}
	for _, c := range clients {
		if (hint.Type == "personal.changed" || (hint.Type == "membership.changed" && hint.UserID != "")) && c.identity.UserID != hint.UserID {
			continue
		}
		if hint.Type == "state.changed" && c.identity.UserID != hint.UserID {
			c.enqueue(publicFrame)
		} else {
			c.enqueue(frame)
		}
	}
}
func (h *Hub) CloseSession(sid string) {
	h.mu.RLock()
	c := h.sessions[sid]
	h.mu.RUnlock()
	if c != nil {
		c.close()
	}
}
func (h *Hub) CloseUser(uid string) {
	h.mu.RLock()
	clients := make([]*socket, 0)
	for _, c := range h.sessions {
		if c.identity.UserID == uid {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		c.close()
	}
}
func (h *Hub) CloseDevice(uid, device, sidToKeep string) {
	h.mu.RLock()
	c := h.devices[uid+":"+device]
	h.mu.RUnlock()
	if c != nil && c.identity.SessionID != sidToKeep {
		c.close()
	}
}
func (h *Hub) Close() {
	h.mu.Lock()
	h.shuttingDown = true
	all := make([]*socket, 0, len(h.sessions))
	for _, c := range h.sessions {
		all = append(all, c)
	}
	h.mu.Unlock()
	for _, c := range all {
		c.close()
	}
}
func (h *Hub) Serve(w http.ResponseWriter, r *http.Request, who Identity, origins map[string]bool, revalidate func(context.Context, string) (Identity, error)) {
	if !h.reserve() {
		writeFault(w, ErrBusy)
		return
	}
	defer func() { <-h.slots }()
	upgrader := websocket.Upgrader{ReadBufferSize: 1024, WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			return origin == "" || origins[origin]
		}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &socket{identity: who, id: newID(), conn: conn, hub: h, send: make(chan []byte, 64), done: make(chan struct{})}

	// Queue ready before exposing the socket to concurrent dispatch. The writer
	// starts only after registration and credential revalidation are complete.
	if !c.enqueue([]byte(`{"type":"ready"}`)) {
		c.close()
		return
	}
	if !h.add(c) {
		c.close()
		return
	}

	defer c.close()
	check, cancelCheck := context.WithTimeout(r.Context(), 3*time.Second)
	_, err = revalidate(check, who.SessionID)
	cancelCheck()
	if err != nil {
		return
	}
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); c.write() }()
	c.read()
	c.close()
	<-writerDone
}
func (c *socket) read() {
	c.conn.SetReadLimit(4096)
	_ = c.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	window := time.Now()
	frames := 0
	countFrame := func() error {
		if time.Since(window) >= time.Minute {
			window, frames = time.Now(), 0
		}
		frames++
		if frames > 60 {
			return ErrLimited
		}
		return nil
	}
	// Gorilla consumes control frames inside ReadMessage. Count them in the
	// handlers too, otherwise ping/pong floods bypass the application budget.
	defaultPing := c.conn.PingHandler()
	c.conn.SetPingHandler(func(data string) error {
		if err := countFrame(); err != nil {
			return err
		}
		return defaultPing(data)
	})
	c.conn.SetPongHandler(func(string) error {
		if err := countFrame(); err != nil {
			return err
		}
		return c.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	})
	for {
		_, b, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		if countFrame() != nil {
			return
		}
		var ping struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(b, &ping) != nil || ping.Type != "ping" {
			return
		}
		if !c.enqueue([]byte(`{"type":"pong"}`)) {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(75 * time.Second))
	}
}
func (c *socket) write() {
	defer c.close()
	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	expiry := time.NewTimer(max(time.Until(c.identity.ExpiresAt), time.Millisecond))
	defer expiry.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-expiry.C:
			return
		case frame := <-c.send:
			c.hub.queuedBytes.Add(-int64(len(frame)))
			_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, frame); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
				return
			}
		}
	}
}
func (s *Service) Sweep(ctx context.Context, h *Hub) error {
	ids := h.SessionIDs()
	if len(ids) == 0 {
		return nil
	}
	// One batch query per 30s sweep, not one database query per heartbeat.
	rows, err := s.Store.Pool.Query(ctx, `SELECT ls.id::text FROM pulse.login_sessions ls
        JOIN pulse.users u ON u.id=ls.user_id AND u.active
        WHERE ls.id=ANY($1::uuid[]) AND ls.revoked_at IS NULL AND ls.expires_at>clock_timestamp()`, ids)
	if err != nil {
		return err
	}
	valid := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		valid[id] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if !valid[id] {
			h.CloseSession(id)
		}
	}
	h.mu.RLock()
	online := make([]Presence, 0, len(h.sessions))
	for _, c := range h.sessions {
		online = append(online, Presence{c.identity.UserID, c.identity.DeviceID, c.id})
	}
	h.mu.RUnlock()
	// Bound each pipeline even if 10k connections are present.
	for start := 0; start < len(online); start += 256 {
		end := min(start+256, len(online))
		if err = s.Cache.Presence(ctx, online[start:end]); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) RunSweeper(ctx context.Context, h *Hub) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pass, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = s.Sweep(pass, h)
			cancel()
		}
	}
}
