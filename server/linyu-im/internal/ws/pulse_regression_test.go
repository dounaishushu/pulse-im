package ws

import (
	"github.com/linyu-im/linyu-server/linyu-common/pkg/db"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/db/cache"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/logger"
	"go.uber.org/zap"
	"testing"
	"time"
)

func testManager(t *testing.T) *ClientManager {
	t.Helper()
	logger.Log = zap.NewNop()
	db.CacheDB = cache.NewOtterClient()
	m := NewClientManager()
	t.Cleanup(m.Tw.Stop)
	return m
}

func TestReconnectOldTeardownMustKeepReplacement(t *testing.T) {
	m := testManager(t)
	old := &Client{UserId: "alice", Device: "desktop"}
	replacement := &Client{UserId: "alice", Device: "desktop"}
	m.Join("alice", old)
	m.Join("alice", replacement)
	// This is the cleanup called by the old writer after the replacement joined.
	m.LeaveClient(old)
	m.lock.RLock()
	current := m.Users["alice"]["desktop"]
	m.lock.RUnlock()
	if current != replacement {
		t.Fatal("old connection teardown removed the replacement")
	}
}

func TestRetryIdentityIncludesRecipient(t *testing.T) {
	m := testManager(t)
	m.AddRetryMessage("same-message", "alice", "desktop", "payload")
	m.AddRetryMessage("same-message", "bob", "desktop", "payload")
	count := 0
	m.RetryMessages.Range(func(_, _ any) bool { count++; return true })
	if count != 2 {
		t.Fatalf("expected independent ACK/retry records for 2 recipients, got %d", count)
	}
}

func TestFullSendQueueMustNotBlockPublisher(t *testing.T) {
	logger.Log = zap.NewNop()
	c := &Client{send: make(chan []byte, 1)}
	c.send <- []byte("first")
	done := make(chan struct{})
	go func() { c.SendMsg([]byte("second")); close(done) }()
	select {
	case <-done:
	case <-time.After(200 * time.Millisecond):
		<-c.send
		<-done
		t.Fatal("full connection queue blocked the publisher")
	}
}

func TestAckCannotSelectAnotherDevice(t *testing.T) {
	m := testManager(t)
	previous := Manager
	Manager = m
	t.Cleanup(func() { Manager = previous })
	m.AddRetryMessage("message", "alice", "desktop", "payload")
	m.AddRetryMessage("message", "alice", "mobile", "payload")
	_, err := AckHandler(&Client{UserId: "alice", Device: "desktop"}, &Request{SeqId: "message", Device: "mobile"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := m.RetryMessages.Load(m.GetRetryMessageKey("alice", "desktop", "message")); ok {
		t.Fatal("own ACK was not consumed")
	}
	if _, ok := m.RetryMessages.Load(m.GetRetryMessageKey("alice", "mobile", "message")); !ok {
		t.Fatal("forged device consumed another device ACK")
	}
}

func TestSendAfterCloseIsRejected(t *testing.T) {
	c := NewClient(nil, "alice", "desktop")
	c.Close()
	c.Close()
	if c.SendMsg([]byte("late")) {
		t.Fatal("accepted message after closing")
	}
}
