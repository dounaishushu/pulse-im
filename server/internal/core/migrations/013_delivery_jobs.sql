CREATE TABLE pulse.dispatch_plans (
 id uuid PRIMARY KEY,admin_id uuid NOT NULL REFERENCES pulse.admin_accounts(id),sender_id uuid NOT NULL REFERENCES pulse.users(id),name varchar(120) NOT NULL,
 payload jsonb NOT NULL,cron text NOT NULL DEFAULT '',run_at timestamptz,next_run timestamptz,enabled boolean NOT NULL DEFAULT true,
 version bigint NOT NULL DEFAULT 1,last_status text NOT NULL DEFAULT '',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dispatch_due ON pulse.dispatch_plans(next_run,id) WHERE enabled;
CREATE TABLE pulse.send_batches (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES pulse.users(id),session_id uuid REFERENCES pulse.login_sessions(id),admin_id uuid REFERENCES pulse.admin_accounts(id),
 plan_id uuid REFERENCES pulse.dispatch_plans(id),plan_version bigint,request_id varchar(64) NOT NULL,request_hash bytea NOT NULL,
 kind text NOT NULL CHECK(kind IN('forward','broadcast','dispatch')),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','completed','partial','cancelled')),
 total integer NOT NULL CHECK(total BETWEEN 1 AND 10000),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(user_id,request_id)
);
CREATE TABLE pulse.send_batch_items (
 batch_id uuid NOT NULL REFERENCES pulse.send_batches(id),ordinal integer NOT NULL,conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),payload jsonb NOT NULL,
 due_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','sent','failed','cancelled')),
 lease_token uuid,lease_until timestamptz,attempts integer NOT NULL DEFAULT 0,error_code text NOT NULL DEFAULT '',message_id uuid REFERENCES pulse.messages(id),PRIMARY KEY(batch_id,ordinal)
);
CREATE INDEX send_items_due ON pulse.send_batch_items(due_at,batch_id,ordinal) WHERE status IN('pending','running');
