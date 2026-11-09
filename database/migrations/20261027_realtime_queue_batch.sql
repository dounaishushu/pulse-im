-- Raw queue IDs are discovered by a separate, nonlocking committed SELECT.
-- Only those exact IDs enter this transaction; lower uncommitted gaps are
-- revisited by discovery on the next tick, never treated as an event cursor.
CREATE PROCEDURE `pulse_realtime_sequence_batch_v2`(IN p_ids LONGTEXT)
SQL SECURITY INVOKER
MODIFIES SQL DATA
main: BEGIN
  DECLARE v_pending BIGINT UNSIGNED;
  DECLARE v_sequence BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_message BIGINT UNSIGNED;
  DECLARE v_conversation BIGINT UNSIGNED;
  DECLARE v_type VARCHAR(32);
  DECLARE v_payload LONGTEXT;
  DECLARE v_created DATETIME(6);
  DECLARE v_count INT DEFAULT 0;
  DECLARE v_index INT DEFAULT 0;
  DECLARE v_total INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;
  IF JSON_VALID(p_ids)=0 OR JSON_TYPE(p_ids)<>'ARRAY' OR JSON_LENGTH(p_ids)>500 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REALTIME_BATCH_IDS_INVALID';
  END IF;
  SET v_total=JSON_LENGTH(p_ids);
  START TRANSACTION;
  SELECT last_id INTO v_sequence FROM realtime_sequence WHERE id=1 FOR UPDATE;
  IF v_sequence IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REALTIME_SEQUENCE_MISSING'; END IF;
  move_pending: WHILE v_index<v_total DO
    IF JSON_TYPE(JSON_EXTRACT(p_ids,CONCAT('$[',v_index,']')))<>'INTEGER' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REALTIME_BATCH_ID_INVALID';
    END IF;
    SET v_pending=CAST(JSON_UNQUOTE(JSON_EXTRACT(p_ids,CONCAT('$[',v_index,']'))) AS UNSIGNED);
    IF v_pending=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='REALTIME_BATCH_ID_INVALID'; END IF;
    BEGIN
      DECLARE v_found TINYINT DEFAULT 1;
      DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_found=0;
      SELECT message_id,conversation_id,event_type,payload_json,created_at
        INTO v_message,v_conversation,v_type,v_payload,v_created
        FROM realtime_outbox WHERE id=v_pending FOR UPDATE;
      IF v_found=1 THEN
        SET v_sequence=v_sequence+1;
        INSERT INTO realtime_events(id,message_id,conversation_id,event_type,payload_json,created_at)
          VALUES(v_sequence,v_message,v_conversation,v_type,v_payload,v_created);
        DELETE FROM realtime_outbox WHERE id=v_pending;
        SET v_count=v_count+1;
      END IF;
    END;
    SET v_index=v_index+1;
  END WHILE;
  UPDATE realtime_sequence SET last_id=v_sequence WHERE id=1;
  UPDATE realtime_sequencer_health SET heartbeat_at=NOW(6),last_batch_count=v_count,last_event_id=v_sequence
    WHERE id=1 AND (v_count>0 OR heartbeat_at IS NULL OR heartbeat_at<DATE_SUB(NOW(6),INTERVAL 2 SECOND));
  COMMIT;
  SELECT v_count AS processed;
END
