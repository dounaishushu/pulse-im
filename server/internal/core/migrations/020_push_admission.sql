CREATE OR REPLACE FUNCTION pulse.queue_message_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pulse.members m JOIN pulse.push_devices d ON d.user_id=m.user_id AND d.enabled
 WHERE m.conversation_id=NEW.conversation_id AND m.active AND m.user_id<>NEW.sender_id) THEN
  INSERT INTO pulse.push_jobs(message_id) VALUES(NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE INDEX push_devices_active_user ON pulse.push_devices(user_id) WHERE enabled;
