-- Invitation management records keep their audience even after revocation.
-- This is additive metadata; original imported payloads remain archived intact.
ALTER TABLE pulse.messages ADD COLUMN manager_only boolean NOT NULL DEFAULT false;
UPDATE pulse.messages m SET manager_only=true
WHERE m.kind='system' AND (m.content->>'kind'='group_invite' OR EXISTS(
    SELECT 1 FROM pulse.legacy_message_bodies archived
    WHERE archived.message_id=m.id AND archived.body_json->>'kind'='group_invite'));
ALTER TABLE pulse.messages ADD CONSTRAINT messages_manager_notice_kind CHECK(NOT manager_only OR kind='system');
