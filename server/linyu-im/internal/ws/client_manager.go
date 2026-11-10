// Modified for Pulse IM on 2026-11-09: connection identity, locked snapshots, and recipient-bound retries.
package ws

import (
	"encoding/json"
	"fmt"
	"github.com/RussellLuo/timingwheel"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/constant"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/db"
	"github.com/linyu-im/linyu-server/linyu-common/pkg/logger"
	"go.uber.org/zap"
	"sync"
	"sync/atomic"
	"time"
)

var Manager = NewClientManager()

type Connection interface{ Close() error }
type ClientManager struct {
	Users         map[string]map[string]*Client
	lock          sync.RWMutex
	RetryMessages sync.Map
	Tw            *timingwheel.TimingWheel
}

func NewClientManager() *ClientManager {
	tw := timingwheel.NewTimingWheel(time.Second, 60)
	tw.Start()
	m := &ClientManager{Tw: tw, Users: make(map[string]map[string]*Client)}
	InitTask(m)
	return m
}
func (m *ClientManager) Join(userId string, c *Client) {
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.Users[userId] == nil {
		m.Users[userId] = make(map[string]*Client)
	}
	if old := m.Users[userId][c.Device]; old != nil {
		old.Close()
	}
	m.Users[userId][c.Device] = c
	// Cache operations follow the same order as membership changes. The core
	// profile uses the in-process cache; remote cache latency needs separate review.
	if err := db.CacheDB.SAdd(m.onlineDevicesKey(userId), 0, c.Device); err != nil {
		logger.Log.Error("cache online device", zap.Error(err))
	}
}
func (m *ClientManager) Leave(userId, device string) {
	m.lock.Lock()
	defer m.lock.Unlock()
	m.LeaveUnlock(userId, device)
}

// LeaveClient only removes this exact socket; late old-writer cleanup cannot evict its replacement.
func (m *ClientManager) LeaveClient(c *Client) {
	if c == nil {
		return
	}
	m.lock.Lock()
	defer m.lock.Unlock()
	if m.Users[c.UserId][c.Device] == c {
		m.LeaveUnlock(c.UserId, c.Device)
	}
}
func (m *ClientManager) LeaveUnlock(userId, device string) bool {
	devices := m.Users[userId]
	c := devices[device]
	if c == nil {
		return false
	}
	c.Close()
	delete(devices, device)
	if len(devices) == 0 {
		delete(m.Users, userId)
	}
	m.removeOnlineDeviceCache(userId, device)
	return true
}
func (m *ClientManager) onlineDevicesKey(userId string) string {
	return fmt.Sprintf(constant.RedisKey.UserOnline, userId)
}
func (m *ClientManager) removeOnlineDeviceCache(userId, device string) {
	if err := db.CacheDB.SRem(m.onlineDevicesKey(userId), device); err != nil {
		logger.Log.Error("remove cached online device", zap.Error(err))
	}
}
func (m *ClientManager) clientsFor(userId string) []*Client {
	m.lock.RLock()
	defer m.lock.RUnlock()
	out := make([]*Client, 0, len(m.Users[userId]))
	for _, c := range m.Users[userId] {
		out = append(out, c)
	}
	return out
}
func (m *ClientManager) SendToUsers(seqId string, userIds []string, data any) {
	for _, id := range userIds {
		m.SendToUser(seqId, id, data)
	}
}
func (m *ClientManager) SendToUser(seqId, userId string, data any) {
	for _, c := range m.clientsFor(userId) {
		m.sendTracked(c, seqId, data)
	}
}
func (m *ClientManager) SendToUserOnDevice(seqId, userId, device string, data any) {
	m.lock.RLock()
	c := m.Users[userId][device]
	m.lock.RUnlock()
	if c != nil {
		m.sendTracked(c, seqId, data)
	}
}
func (m *ClientManager) sendTracked(c *Client, seqId string, data any) {
	m.AddRetryMessage(seqId, c.UserId, c.Device, data)
	if !m.Send(c, seqId, c.Device, data) {
		m.DeleteRetryMessage(c.UserId, c.Device, seqId)
		m.LeaveClient(c)
	}
}
func (m *ClientManager) Send(c *Client, seqId, device string, data any) bool {
	return c.SendMsg(SucceedResponse(seqId, device, "server", data))
}
func (m *ClientManager) GetRetryMessageKey(userId, device, seqId string) string {
	b, _ := json.Marshal([3]string{userId, device, seqId})
	return string(b)
}
func (m *ClientManager) AddRetryMessage(seqId, userId, device string, data any) {
	key := m.GetRetryMessageKey(userId, device, seqId)
	p := &RetryMessage{Key: key, SeqId: seqId, UserId: userId, Device: device, Data: data}
	if _, loaded := m.RetryMessages.LoadOrStore(key, p); loaded {
		return
	}
	m.ScheduleRetry(p)
}
func (m *ClientManager) DeleteRetryMessage(userId, device, seqId string) {
	m.RetryMessages.Delete(m.GetRetryMessageKey(userId, device, seqId))
}
func (m *ClientManager) ScheduleRetry(p *RetryMessage) {
	if p.RetryCount >= len(RetryIntervals) {
		m.RetryMessages.Delete(p.Key)
		return
	}
	delay := RetryIntervals[p.RetryCount]
	m.Tw.AfterFunc(delay, func() {
		current, ok := m.RetryMessages.Load(p.Key)
		if !ok || current != p {
			return
		}
		m.SendToUserOnDevice(p.SeqId, p.UserId, p.Device, p.Data)
		p.RetryCount++
		m.ScheduleRetry(p)
	})
}
func (m *ClientManager) CleanExpiredClients() bool {
	threshold := uint64(time.Now().Add(-readTimeout).Unix())
	m.lock.Lock()
	defer m.lock.Unlock()
	for uid, devices := range m.Users {
		for device, c := range devices {
			if atomic.LoadUint64(&c.HeartbeatTime) < threshold {
				m.LeaveUnlock(uid, device)
			}
		}
	}
	return true
}
