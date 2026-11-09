-- Quotes store only body.reply_to_id; summaries are resolved per viewer at read time.
CREATE TABLE IF NOT EXISTS message_pins (
  conversation_id BIGINT UNSIGNED NOT NULL,
  message_id BIGINT UNSIGNED NOT NULL,
  pinned_by BIGINT UNSIGNED NOT NULL,
  pinned_at DATETIME(6) NOT NULL,
  PRIMARY KEY (conversation_id, message_id),
  KEY idx_message_pin_message (message_id),
  CONSTRAINT fk_message_pin_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  CONSTRAINT fk_message_pin_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- These controls use the same commit-ordered sequence as ordinary message events.
-- Only IDs are persisted here; the worker resolves the latest safe snapshot.
DELIMITER $$
DROP TRIGGER IF EXISTS pulse_message_pin_insert_event$$
CREATE TRIGGER pulse_message_pin_insert_event AFTER INSERT ON message_pins FOR EACH ROW
BEGIN
  UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
  INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
  SELECT last_id, NEW.message_id, NEW.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', NEW.conversation_id), NOW(6)
  FROM realtime_sequence WHERE id = 1;
END$$

DROP TRIGGER IF EXISTS pulse_message_pin_delete_event$$
CREATE TRIGGER pulse_message_pin_delete_event AFTER DELETE ON message_pins FOR EACH ROW
BEGIN
  UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
  INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
  SELECT last_id, OLD.message_id, OLD.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', OLD.conversation_id), NOW(6)
  FROM realtime_sequence WHERE id = 1;
END$$

DROP TRIGGER IF EXISTS pulse_message_recall_remove_pin$$
CREATE TRIGGER pulse_message_recall_remove_pin BEFORE UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.recalled_at IS NOT NULL AND OLD.recalled_at IS NULL THEN
    DELETE FROM message_pins WHERE conversation_id = OLD.conversation_id AND message_id = OLD.id;
  END IF;
END$$

-- Explicit deletion runs the pin outbox trigger (FK cascades alone do not).
DROP TRIGGER IF EXISTS pulse_message_delete_remove_pin$$
CREATE TRIGGER pulse_message_delete_remove_pin BEFORE DELETE ON messages FOR EACH ROW
BEGIN
  DELETE FROM message_pins WHERE conversation_id = OLD.conversation_id AND message_id = OLD.id;
END$$

DROP TRIGGER IF EXISTS pulse_message_pin_clear_event$$
CREATE TRIGGER pulse_message_pin_clear_event AFTER UPDATE ON conversation_members FOR EACH ROW
BEGIN
  IF NEW.cleared_before_message_id <> OLD.cleared_before_message_id AND
    EXISTS (SELECT 1 FROM message_pins WHERE conversation_id = NEW.conversation_id) THEN
    UPDATE realtime_sequence SET last_id = last_id + 1 WHERE id = 1;
    INSERT INTO realtime_events (id, message_id, conversation_id, event_type, payload_json, created_at)
    SELECT last_id, NEW.cleared_before_message_id, NEW.conversation_id, 'conversation.pins', JSON_OBJECT('conversation_id', NEW.conversation_id), NOW(6)
    FROM realtime_sequence WHERE id = 1;
  END IF;
END$$
DELIMITER ;
