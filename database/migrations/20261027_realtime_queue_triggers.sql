-- Replace these five triggers only while all message writers are quiesced.
-- The two existing pin-cleanup triggers remain unchanged.
DELIMITER $$
CREATE TRIGGER pulse_message_insert_event AFTER INSERT ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' THEN
    INSERT INTO realtime_outbox(message_id,conversation_id,event_type,payload_json,created_at)
    VALUES(NEW.id,NEW.conversation_id,'message.new',
      JSON_OBJECT('id',NEW.id,'conversation_id',NEW.conversation_id,'sender_id',NEW.sender_id,
        'type',NEW.type,'body',JSON_EXTRACT(NEW.body_json,'$'),'created_at',NEW.created_at,
        'edited_at',NEW.edited_at,'recalled_at',NEW.recalled_at,'status','sent'),NOW(6));
  END IF;
END$$
CREATE TRIGGER pulse_message_update_event AFTER UPDATE ON messages FOR EACH ROW
BEGIN
  IF NEW.type <> 'red_packet' AND
    (NOT (NEW.recalled_at <=> OLD.recalled_at) OR NOT (NEW.edited_at <=> OLD.edited_at) OR NOT (NEW.body_json <=> OLD.body_json)) THEN
    INSERT INTO realtime_outbox(message_id,conversation_id,event_type,payload_json,created_at)
    VALUES(NEW.id,NEW.conversation_id,IF(NEW.recalled_at IS NOT NULL,'message.recalled','message.updated'),
      JSON_OBJECT('id',NEW.id,'conversation_id',NEW.conversation_id,'sender_id',NEW.sender_id,
        'type',NEW.type,'body',IF(NEW.recalled_at IS NULL,JSON_EXTRACT(NEW.body_json,'$'),JSON_OBJECT()),
        'created_at',NEW.created_at,'edited_at',NEW.edited_at,'recalled_at',NEW.recalled_at,
        'status',IF(NEW.recalled_at IS NULL,'edited','recalled')),NOW(6));
  END IF;
END$$
CREATE TRIGGER pulse_message_pin_insert_event AFTER INSERT ON message_pins FOR EACH ROW
BEGIN
  INSERT INTO realtime_outbox(message_id,conversation_id,event_type,payload_json,created_at)
    VALUES(NEW.message_id,NEW.conversation_id,'conversation.pins',JSON_OBJECT('conversation_id',NEW.conversation_id),NOW(6));
END$$
CREATE TRIGGER pulse_message_pin_delete_event AFTER DELETE ON message_pins FOR EACH ROW
BEGIN
  INSERT INTO realtime_outbox(message_id,conversation_id,event_type,payload_json,created_at)
    VALUES(OLD.message_id,OLD.conversation_id,'conversation.pins',JSON_OBJECT('conversation_id',OLD.conversation_id),NOW(6));
END$$
CREATE TRIGGER pulse_message_pin_clear_event AFTER UPDATE ON conversation_members FOR EACH ROW
BEGIN
  IF NEW.cleared_before_message_id <> OLD.cleared_before_message_id AND
    EXISTS(SELECT 1 FROM message_pins WHERE conversation_id=NEW.conversation_id) THEN
    INSERT INTO realtime_outbox(message_id,conversation_id,event_type,payload_json,created_at)
      VALUES(NEW.cleared_before_message_id,NEW.conversation_id,'conversation.pins',JSON_OBJECT('conversation_id',NEW.conversation_id),NOW(6));
  END IF;
END$$
DELIMITER ;
