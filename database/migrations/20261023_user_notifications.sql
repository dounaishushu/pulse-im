-- Run once on the existing shared application database, never import schema.sql.
CREATE TABLE IF NOT EXISTS user_notifications (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(32) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NULL,
  request_id BIGINT UNSIGNED NULL,
  pending_request_id BIGINT UNSIGNED NULL,
  request_status VARCHAR(16) NULL,
  body_json JSON NOT NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_notification_pending_request (pending_request_id),
  KEY idx_notification_user_unread (user_id,read_at,id),
  KEY idx_notification_user_cursor (user_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Keep existing pending requests actionable; rerunning never duplicates them.
INSERT IGNORE INTO user_notifications
  (user_id,type,actor_id,request_id,pending_request_id,request_status,body_json,created_at)
SELECT r.to_user_id,'friend.request',r.from_user_id,r.id,r.id,'pending',
  JSON_OBJECT('actor_name',COALESCE(u.nickname,'用户'),'actor_avatar_url',u.avatar_url,'message',r.message),r.created_at
FROM contact_requests r LEFT JOIN users u ON u.id=r.from_user_id
WHERE r.status='pending';
