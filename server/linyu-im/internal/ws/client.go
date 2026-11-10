// Modified for Pulse IM on 2026-11-09: bounded nonblocking delivery and explicit connection lifecycle.
package ws

import (
	"encoding/json"
	"github.com/gorilla/websocket"
	"sync/atomic"
	"time"
)

const readTimeout = 90 * time.Second
const writeTimeout = 5 * time.Second

type Client struct {
	UserId        string
	IP            string
	Conn          *websocket.Conn
	send          chan []byte
	done          chan struct{}
	closing       atomic.Bool
	Device        string
	HeartbeatTime uint64
	ConnectTime   uint64
}

func NewClient(conn *websocket.Conn, userId, device string) *Client {
	now := uint64(time.Now().Unix())
	c := &Client{UserId: userId, Device: device, Conn: conn, send: make(chan []byte, 64), done: make(chan struct{}), HeartbeatTime: now, ConnectTime: now}
	if conn != nil {
		c.IP = conn.RemoteAddr().String()
	}
	return c
}

func (c *Client) Close() {
	if c == nil || c.closing.Swap(true) {
		return
	}
	if c.done != nil {
		close(c.done)
	}
	if c.Conn != nil {
		_ = c.Conn.Close()
	}
}

func (c *Client) Read() {
	defer c.Close()
	c.Conn.SetReadLimit(64 << 10)
	_ = c.Conn.SetReadDeadline(time.Now().Add(readTimeout))
	c.Conn.SetPongHandler(func(string) error {
		atomic.StoreUint64(&c.HeartbeatTime, uint64(time.Now().Unix()))
		return c.Conn.SetReadDeadline(time.Now().Add(readTimeout))
	})
	for {
		_, data, err := c.Conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.Conn.SetReadDeadline(time.Now().Add(readTimeout))
		req := &Request{}
		if err := json.Unmarshal(data, req); err != nil {
			c.SendMsg(ErrorResponse("", "", "", "Data formatting error"))
			continue
		}
		ProcessData(c, req)
	}
}

func (c *Client) Write() {
	defer c.Close()
	defer Manager.LeaveClient(c)
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case data := <-c.send:
			if c.closing.Load() {
				return
			}
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.Conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.Conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeTimeout)); err != nil {
				return
			}
		}
	}
}

// SendMsg never waits for a slow peer. Durable sync must recover after disconnection.
func (c *Client) SendMsg(msg []byte) bool {
	if c == nil || c.closing.Load() {
		return false
	}
	select {
	case <-c.done:
		return false
	case c.send <- msg:
		return true
	default:
		c.Close()
		return false
	}
}
