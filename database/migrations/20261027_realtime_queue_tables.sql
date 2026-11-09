CREATE TABLE IF NOT EXISTS realtime_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_realtime_outbox_created (created_at),
  KEY idx_realtime_outbox_message (message_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS realtime_sequencer_health (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  heartbeat_at DATETIME(6) NULL,
  last_batch_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT IGNORE INTO realtime_sequencer_health(id) VALUES(1);
