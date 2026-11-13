ALTER TABLE pulse.conversations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX conversations_created_cursor ON pulse.conversations(created_at,id);

ALTER TABLE pulse.friendships ADD COLUMN created_at timestamptz;
UPDATE pulse.friendships f SET created_at=COALESCE(
    (SELECT min(cm.created_at) FROM pulse.contact_metadata cm
     WHERE (cm.user_id=f.user_low AND cm.peer_id=f.user_high)
        OR (cm.user_id=f.user_high AND cm.peer_id=f.user_low)),now());
ALTER TABLE pulse.friendships ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE pulse.friendships ALTER COLUMN created_at SET NOT NULL;
CREATE INDEX friendships_created_cursor ON pulse.friendships(created_at,user_low,user_high);

UPDATE pulse.members SET joined_at=now() WHERE joined_at IS NULL;
ALTER TABLE pulse.members ALTER COLUMN joined_at SET DEFAULT now();
ALTER TABLE pulse.members ALTER COLUMN joined_at SET NOT NULL;
