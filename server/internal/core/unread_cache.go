package core

import "encoding/json"

type unreadCacheScope struct{ userID, conversationID string }
type unreadCacheEntry struct {
	Stamp string `json:"stamp"`
	Count int    `json:"count"`
}

// 每次仍读取并验证当前账号、成员与个人状态版本。缓存只复用同版本的计数，不能代替授权。
const unreadCacheStampSQL = `concat_ws(':',c.message_seq,c.event_seq,st.version,m.membership_version,m.visible_from_seq,m.role,st.read_seq,st.clear_seq,st.legacy_delivered_override_seq)`

func (s *Service) unreadSnapshot(userID string) []byte {
	s.unreadMu.Lock()
	defer s.unreadMu.Unlock()
	entries := map[string]unreadCacheEntry{}
	for scope, entry := range s.unreadCache {
		if scope.userID == userID {
			entries[scope.conversationID] = entry
		}
	}
	data, _ := json.Marshal(entries)
	return data
}

func (s *Service) rememberUnread(userID string, entries map[string]unreadCacheEntry) {
	s.unreadMu.Lock()
	defer s.unreadMu.Unlock()
	if s.unreadCache == nil {
		s.unreadCache = make(map[unreadCacheScope]unreadCacheEntry)
	}
	for cid, entry := range entries {
		scope := unreadCacheScope{userID, cid}
		if _, exists := s.unreadCache[scope]; !exists && len(s.unreadCache) >= 4096 {
			for key := range s.unreadCache {
				delete(s.unreadCache, key)
				break
			}
		}
		s.unreadCache[scope] = entry
	}
}
