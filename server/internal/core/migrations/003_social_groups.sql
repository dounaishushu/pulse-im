ALTER TABLE pulse.users ADD COLUMN allow_friend_requests boolean NOT NULL DEFAULT true;
ALTER TABLE pulse.users ADD COLUMN allow_group_invites boolean NOT NULL DEFAULT true;

CREATE TABLE pulse.friend_requests (
    id uuid PRIMARY KEY,
    requester_id uuid NOT NULL REFERENCES pulse.users(id),
    target_id uuid NOT NULL REFERENCES pulse.users(id),
    note varchar(300) NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz,
    CHECK (requester_id <> target_id)
);
CREATE UNIQUE INDEX friend_request_pending_pair ON pulse.friend_requests(requester_id, target_id) WHERE status='pending';
CREATE INDEX friend_requests_incoming ON pulse.friend_requests(target_id, created_at DESC) WHERE status='pending';

ALTER TABLE pulse.conversations ADD COLUMN join_policy text NOT NULL DEFAULT 'invite'
    CHECK (join_policy IN ('open', 'invite', 'closed'));
ALTER TABLE pulse.conversations ADD COLUMN invite_code_hash bytea;
ALTER TABLE pulse.conversations ADD COLUMN invite_code_changed_at timestamptz;
ALTER TABLE pulse.conversations ADD COLUMN announcement text NOT NULL DEFAULT '';
ALTER TABLE pulse.conversations ADD COLUMN description varchar(500) NOT NULL DEFAULT '';
ALTER TABLE pulse.conversations ADD COLUMN block_member_friend_requests boolean NOT NULL DEFAULT false;
CREATE INDEX conversations_invite_code ON pulse.conversations(invite_code_hash) WHERE invite_code_hash IS NOT NULL;

-- The first implementation sends membership invalidations by conversation ID.
-- Joined clients discover current membership through their authenticated list.
CREATE INDEX members_active_by_conversation ON pulse.members(conversation_id, user_id) WHERE active;
