ALTER TABLE pulse.conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE pulse.conversations ADD CONSTRAINT conversations_kind_check CHECK(kind IN ('direct','group','channel','saved'));
ALTER TABLE pulse.conversations ADD COLUMN public_id text GENERATED ALWAYS AS (upper(replace(id::text,'-',''))) STORED UNIQUE;
CREATE TABLE pulse.saved_conversations(user_id uuid PRIMARY KEY REFERENCES pulse.users(id),conversation_id uuid NOT NULL UNIQUE REFERENCES pulse.conversations(id));
CREATE TABLE pulse.conversation_folders (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES pulse.users(id),scope text NOT NULL CHECK(scope IN ('direct','group')),
 name varchar(64) NOT NULL,sort_order integer NOT NULL DEFAULT 0,collapsed boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1,
 UNIQUE(user_id,scope,name),UNIQUE(id,user_id)
);
ALTER TABLE pulse.user_states
 ADD COLUMN pinned boolean NOT NULL DEFAULT false,
 ADD COLUMN muted_notifications boolean NOT NULL DEFAULT false,
 ADD COLUMN archived boolean NOT NULL DEFAULT false,
 ADD COLUMN hidden boolean NOT NULL DEFAULT false,
 ADD COLUMN folder_id uuid,
 ADD COLUMN preference_version bigint NOT NULL DEFAULT 1,
 ADD CONSTRAINT state_owned_folder FOREIGN KEY(folder_id,user_id) REFERENCES pulse.conversation_folders(id,user_id);
CREATE TABLE pulse.notifications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid NOT NULL REFERENCES pulse.users(id),kind text NOT NULL,
 actor_id uuid REFERENCES pulse.users(id),target_id uuid,reference_id uuid,read_at timestamptz,handled text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON pulse.notifications(user_id,id DESC);
CREATE INDEX notifications_unread ON pulse.notifications(user_id,id) WHERE read_at IS NULL;
CREATE TABLE pulse.user_outbox(user_id uuid PRIMARY KEY REFERENCES pulse.users(id),version bigint NOT NULL DEFAULT 1);
CREATE TABLE pulse.notification_preferences(user_id uuid PRIMARY KEY REFERENCES pulse.users(id),enabled boolean NOT NULL DEFAULT true,preview boolean NOT NULL DEFAULT true,sound boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1);
CREATE FUNCTION pulse.notification_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pulse.user_outbox(user_id) VALUES(NEW.user_id) ON CONFLICT(user_id) DO UPDATE SET version=pulse.user_outbox.version+1;RETURN NEW;END $$;
CREATE TRIGGER notification_changed AFTER INSERT OR UPDATE ON pulse.notifications FOR EACH ROW EXECUTE FUNCTION pulse.notification_changed();
CREATE FUNCTION pulse.friend_request_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO pulse.notifications(user_id,kind,actor_id,target_id,reference_id) VALUES(NEW.target_id,'friend.request',NEW.requester_id,NEW.requester_id,NEW.id);
 ELSIF NEW.status<>OLD.status THEN
  UPDATE pulse.notifications SET handled=NEW.status,read_at=COALESCE(read_at,now()) WHERE reference_id=NEW.id AND kind='friend.request';
  IF NEW.status='accepted' THEN INSERT INTO pulse.notifications(user_id,kind,actor_id,target_id,reference_id) VALUES(NEW.requester_id,'friend.accepted',NEW.target_id,NEW.target_id,NEW.id); END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER friend_request_notification AFTER INSERT OR UPDATE ON pulse.friend_requests FOR EACH ROW EXECUTE FUNCTION pulse.friend_request_notification();
