CREATE TABLE pulse.push_devices (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES pulse.users(id),session_id uuid NOT NULL REFERENCES pulse.login_sessions(id),platform text NOT NULL CHECK(platform IN('android','ios')),
 token text NOT NULL,token_hash bytea NOT NULL UNIQUE,environment text NOT NULL DEFAULT 'production' CHECK(environment IN('production','sandbox')),enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id)
);
CREATE TABLE pulse.push_jobs (
 message_id uuid PRIMARY KEY REFERENCES pulse.messages(id),cursor_user uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',available_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,last_error text NOT NULL DEFAULT ''
);
CREATE INDEX push_jobs_due ON pulse.push_jobs(available_at,message_id);
CREATE TABLE pulse.push_deliveries (
 message_id uuid NOT NULL REFERENCES pulse.messages(id),device_id uuid NOT NULL REFERENCES pulse.push_devices(id),status text NOT NULL,error_code text NOT NULL DEFAULT '',updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(message_id,device_id)
);
CREATE FUNCTION pulse.queue_message_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN INSERT INTO pulse.push_jobs(message_id) VALUES(NEW.id);RETURN NEW;END $$;
CREATE TRIGGER queue_message_push AFTER INSERT ON pulse.messages FOR EACH ROW EXECUTE FUNCTION pulse.queue_message_push();
CREATE TABLE pulse.maintenance_runs (
 id uuid PRIMARY KEY,kind text NOT NULL,admin_id uuid REFERENCES pulse.admin_accounts(id),status text NOT NULL DEFAULT 'pending',parameters jsonb NOT NULL,
 progress integer NOT NULL DEFAULT 0,deleted_count bigint NOT NULL DEFAULT 0,error_code text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),started_at timestamptz,finished_at timestamptz,lease_until timestamptz,lease_token uuid
);
CREATE TABLE pulse.telegram_grants (
 telegram_user_id bigint PRIMARY KEY,admin_id uuid REFERENCES pulse.admin_accounts(id),permissions text[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT true
);
CREATE TABLE pulse.telegram_chats(chat_id bigint PRIMARY KEY,pin_hash text NOT NULL,enabled boolean NOT NULL DEFAULT true,version bigint NOT NULL DEFAULT 1);
CREATE TABLE pulse.telegram_authorizations(chat_id bigint NOT NULL REFERENCES pulse.telegram_chats(chat_id),telegram_user_id bigint NOT NULL,chat_version bigint NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(chat_id,telegram_user_id));
CREATE TABLE pulse.telegram_updates(update_id bigint PRIMARY KEY,payload jsonb NOT NULL,status text NOT NULL DEFAULT 'pending',available_at timestamptz NOT NULL DEFAULT now(),lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,error_code text NOT NULL DEFAULT '');
