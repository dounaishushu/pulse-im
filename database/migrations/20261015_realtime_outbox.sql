CREATE TABLE IF NOT EXISTS realtime_sequence (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT IGNORE INTO realtime_sequence (id, last_id) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS realtime_events (
  id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  message_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  payload_json JSON NOT NULL,
  created_at DATETIME(6) NOT NULL,
  KEY idx_realtime_events_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS websocket_worker_health (
  node_id VARCHAR(64) NOT NULL PRIMARY KEY,
  process_id INT UNSIGNED NOT NULL,
  event_cursor BIGINT UNSIGNED NOT NULL DEFAULT 0,
  heartbeat_at DATETIME(6) NOT NULL,
  started_at DATETIME(6) NOT NULL,
  KEY idx_websocket_heartbeat (heartbeat_at)
) ENGINE=InnoDB;

-- The singleton sequence lock is retained until the message transaction commits.
-- Unlike AUTO_INCREMENT, this prevents a later transaction from becoming visible
-- before an earlier numbered event and being skipped by a consumer cursor.
DELIMITER $$
DROP TRIGGER IF EXISTS pulse_message_insert_event$$
CREATE TRIGGER pulse_message_insert_event AFTER INSERT ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.id, NEW.conversation_id, 'message.new',
      JSON_OBJECT('id', NEW.id, 'conversation_id', NEW.conversation_id, 'sender_id', NEW.sender_id,
        'type', NEW.type, 'body', JSON_EXTRACT(NEW.body_json, '$'), 'created_at', NEW.created_at,
        'edited_at', NEW.edited_at, 'recalled_at', NEW.recalled_at, 'status', 'sent'), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$

DROP TRIGGER IF EXISTS pulse_message_update_event$$
CREATE TRIGGER pulse_message_update_event AFTER UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' AND
    (NOT (NEW.recalled_at <=> OLD.recalled_at) OR NOT (NEW.edited_at <=> OLD.edited_at) OR NOT (NEW.body_json <=> OLD.body_json)) THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.id, NEW.conversation_id,
      IF(NEW.recalled_at IS NOT NULL, 'message.recalled', 'message.updated'),
      JSON_OBJECT('id', NEW.id, 'conversation_id', NEW.conversation_id, 'sender_id', NEW.sender_id,
        'type', NEW.type, 'body', IF(NEW.recalled_at IS NULL, JSON_EXTRACT(NEW.body_json, '$'), JSON_OBJECT()),
        'created_at', NEW.created_at, 'edited_at', NEW.edited_at, 'recalled_at', NEW.recalled_at,
        'status', IF(NEW.recalled_at IS NULL, 'edited', 'recalled')), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$
DELIMITER ;
