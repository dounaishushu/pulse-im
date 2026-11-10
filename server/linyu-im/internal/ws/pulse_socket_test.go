package ws

import (
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func socketHarness(t *testing.T) (*ClientManager, string, chan *Client, chan *Client) {
	t.Helper()
	m := testManager(t)
	previous := Manager
	Manager = m
	joined := make(chan *Client, 4)
	closed := make(chan *Client, 4)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		client := NewClient(socket, "alice", "desktop")
		m.Join("alice", client)
		joined <- client
		go client.Read()
		go func() { client.Write(); closed <- client }()
	}))
	t.Cleanup(func() {
		for _, c := range m.clientsFor("alice") {
			m.LeaveClient(c)
		}
		server.Close()
		Manager = previous
	})
	return m, "ws" + strings.TrimPrefix(server.URL, "http"), joined, closed
}
func awaitClient(t *testing.T, ch <-chan *Client) *Client {
	t.Helper()
	select {
	case c := <-ch:
		return c
	case <-time.After(2 * time.Second):
		t.Fatal("socket lifecycle did not complete")
		return nil
	}
}
func TestRealSocketReplacementReceivesMessages(t *testing.T) {
	m, url, joined, closed := socketHarness(t)
	first, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	old := awaitClient(t, joined)
	second, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	replacement := awaitClient(t, joined)
	if exited := awaitClient(t, closed); exited != old {
		t.Fatal("replacement unexpectedly disconnected")
	}
	m.SendToUser("event-1", "alice", "replacement-still-connected")
	_ = second.SetReadDeadline(time.Now().Add(2 * time.Second))
	var response Response
	if err := second.ReadJSON(&response); err != nil {
		t.Fatal(err)
	}
	if response.SeqId != "event-1" || response.Data != "replacement-still-connected" {
		t.Fatal("replacement missed its notification")
	}
	_ = second.Close()
	if exited := awaitClient(t, closed); exited != replacement {
		t.Fatal("unexpected writer exit")
	}
}
func TestRealSocketRejectsOversizedFrame(t *testing.T) {
	_, url, joined, closed := socketHarness(t)
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	serverClient := awaitClient(t, joined)
	_ = client.WriteMessage(websocket.TextMessage, []byte(strings.Repeat("x", 65<<10)))
	if exited := awaitClient(t, closed); exited != serverClient {
		t.Fatal("oversized connection was not closed")
	}
}
