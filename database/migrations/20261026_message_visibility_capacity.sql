-- Apply before GroupInviteNoticeService uses is_group_invite.
-- The flag is derived entirely from the existing type/body; messages are retained.
ALTER TABLE messages
  ADD COLUMN is_group_invite TINYINT GENERATED ALWAYS AS (IF(type = 'system' AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(body_json, '$.kind')), '') = 'group_invite', 1, 0)) STORED,
  ADD INDEX idx_message_visibility_count (conversation_id, recalled_at, id, sender_id, type, is_group_invite);
