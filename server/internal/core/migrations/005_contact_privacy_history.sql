CREATE TABLE pulse.privacy_settings (
    user_id uuid PRIMARY KEY REFERENCES pulse.users(id),
    temporary_chat text NOT NULL DEFAULT 'everyone' CHECK (temporary_chat IN ('everyone','contacts','nobody')),
    group_invites text NOT NULL DEFAULT 'everyone' CHECK (group_invites IN ('everyone','contacts','nobody')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
-- Import the previous invitation switch once; new writes use privacy_settings.
INSERT INTO pulse.privacy_settings(user_id,group_invites)
    SELECT id,CASE WHEN allow_group_invites THEN 'everyone' ELSE 'nobody' END FROM pulse.users;
CREATE TABLE pulse.privacy_exceptions (
    user_id uuid NOT NULL REFERENCES pulse.privacy_settings(user_id),
    scope text NOT NULL CHECK (scope IN ('temporary_chat','group_invites')),
    peer_id uuid NOT NULL REFERENCES pulse.users(id),
    effect text NOT NULL CHECK (effect IN ('allow','deny')),
    PRIMARY KEY(user_id,scope,peer_id),
    CHECK(user_id <> peer_id)
);
ALTER TABLE pulse.members ADD COLUMN membership_version bigint NOT NULL DEFAULT 1 CHECK (membership_version > 0);
ALTER TABLE pulse.members ADD COLUMN history_allowed boolean NOT NULL DEFAULT false;
UPDATE pulse.members SET history_allowed=true WHERE visible_from_seq=1 AND visible_from_event_seq=1;
