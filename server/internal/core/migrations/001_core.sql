CREATE SCHEMA IF NOT EXISTS pulse;
CREATE TABLE pulse.users (
    id uuid PRIMARY KEY,
    account varchar(64) NOT NULL UNIQUE,
    password_hash text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    can_send boolean NOT NULL DEFAULT true,
    internal_staff boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pulse.login_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES pulse.users(id),
    device_id varchar(128) NOT NULL,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at)
);
CREATE INDEX login_sessions_user_active ON pulse.login_sessions(user_id) WHERE revoked_at IS NULL;
CREATE TABLE pulse.login_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES pulse.users(id),
    device_id varchar(128) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_audit_recent ON pulse.login_audit(user_id, id DESC);
CREATE TABLE pulse.friendships (
    user_low uuid NOT NULL REFERENCES pulse.users(id),
    user_high uuid NOT NULL REFERENCES pulse.users(id),
    PRIMARY KEY (user_low, user_high),
    CHECK (user_low < user_high)
);
CREATE TABLE pulse.blocks (
    user_id uuid NOT NULL REFERENCES pulse.users(id),
    peer_id uuid NOT NULL REFERENCES pulse.users(id),
    PRIMARY KEY(user_id, peer_id),
    CHECK (user_id <> peer_id)
);
CREATE TABLE pulse.conversations (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('direct', 'group', 'channel')),
    direct_key text UNIQUE,
    title varchar(128) NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    mute_all boolean NOT NULL DEFAULT false,
    message_seq bigint NOT NULL DEFAULT 0 CHECK (message_seq >= 0),
    event_seq bigint NOT NULL DEFAULT 0 CHECK (event_seq >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'direct') = (direct_key IS NOT NULL))
);
CREATE TABLE pulse.members (
    conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),
    user_id uuid NOT NULL REFERENCES pulse.users(id),
    role text NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
    active boolean NOT NULL DEFAULT true,
    muted boolean NOT NULL DEFAULT false,
    visible_from_seq bigint NOT NULL DEFAULT 1 CHECK(visible_from_seq > 0),
    PRIMARY KEY(conversation_id, user_id)
);
CREATE INDEX members_user ON pulse.members(user_id, conversation_id) WHERE active;
CREATE TABLE pulse.user_states (
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_seq bigint NOT NULL DEFAULT 0 CHECK(read_seq >= 0),
    delivered_seq bigint NOT NULL DEFAULT 0 CHECK(delivered_seq >= read_seq),
    clear_seq bigint NOT NULL DEFAULT 0 CHECK(clear_seq >= 0),
    version bigint NOT NULL DEFAULT 0 CHECK(version >= 0),
    PRIMARY KEY(conversation_id, user_id),
    FOREIGN KEY(conversation_id,user_id) REFERENCES pulse.members(conversation_id,user_id)
);
CREATE TABLE pulse.messages (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),
    seq bigint NOT NULL CHECK(seq > 0),
    event_seq bigint NOT NULL CHECK(event_seq > 0),
    sender_id uuid NOT NULL REFERENCES pulse.users(id),
    request_id varchar(64) NOT NULL,
    request_hash bytea NOT NULL CHECK(octet_length(request_hash) = 32),
    body text NOT NULL,
    revoked boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(conversation_id, seq),
    UNIQUE(conversation_id, sender_id, request_id)
);
CREATE TABLE pulse.message_deletions (
    user_id uuid NOT NULL REFERENCES pulse.users(id),
    message_id uuid NOT NULL REFERENCES pulse.messages(id),
    PRIMARY KEY(user_id,message_id)
);
-- Event rows contain references, never immutable copies of private/revoked bodies.
CREATE TABLE pulse.events (
    conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),
    seq bigint NOT NULL CHECK(seq > 0),
    kind text NOT NULL CHECK(kind IN ('message.created','message.edited','message.revoked')),
    message_id uuid NOT NULL REFERENCES pulse.messages(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(conversation_id, seq)
);
CREATE TABLE pulse.outbox (
    id uuid PRIMARY KEY,
    conversation_id uuid NOT NULL REFERENCES pulse.conversations(id),
    event_seq bigint NOT NULL CHECK(event_seq >= 0),
    kind text NOT NULL CHECK(kind IN ('conversation.changed', 'state.changed')),
    subject_id uuid REFERENCES pulse.users(id),
    state_version bigint NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    created_at timestamptz NOT NULL DEFAULT now()
);
-- Successful dispatch removes outbox rows; durable sync reads pulse.events.
CREATE INDEX outbox_due ON pulse.outbox(available_at, id);
