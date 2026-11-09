-- Install once, before enabling GROUP_TEXT_WRITE_ROUTINE=pulse_group_text_send_v1.
-- No transaction boundary here: the application owns commit and rollback.
CREATE PROCEDURE `pulse_group_text_send_v1`(
  IN p_conversation BIGINT UNSIGNED,
  IN p_sender BIGINT UNSIGNED,
  IN p_request VARCHAR(80),
  IN p_body LONGTEXT CHARACTER SET utf8mb4,
  IN p_now DATETIME,
  IN p_internal TINYINT
)
SQL SECURITY INVOKER
MODIFIES SQL DATA
main: BEGIN
  DECLARE v_kind VARCHAR(16) DEFAULT NULL;
  DECLARE v_all_muted TINYINT DEFAULT 0;
  DECLARE v_sender BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_name VARCHAR(255) DEFAULT NULL;
  DECLARE v_avatar TEXT DEFAULT NULL;
  DECLARE v_member BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_role VARCHAR(16) DEFAULT NULL;
  DECLARE v_muted_until DATETIME DEFAULT NULL;
  DECLARE v_muted TINYINT DEFAULT 0;
  DECLARE v_staff TINYINT DEFAULT 0;
  DECLARE v_duplicate TINYINT DEFAULT 0;
  DECLARE v_missing TINYINT DEFAULT 0;
  DECLARE v_id BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_message_conversation BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_message_sender BIGINT UNSIGNED DEFAULT NULL;
  DECLARE v_message_kind VARCHAR(24) DEFAULT NULL;
  DECLARE v_body LONGTEXT DEFAULT NULL;
  DECLARE v_created DATETIME DEFAULT NULL;
  DECLARE v_edited DATETIME DEFAULT NULL;
  DECLARE v_recalled DATETIME DEFAULT NULL;
  DECLARE v_deleted BIGINT UNSIGNED DEFAULT NULL;
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_missing = 1;

  SELECT type, all_muted INTO v_kind, v_all_muted
    FROM conversations WHERE id=p_conversation AND status='active' FOR UPDATE;
  IF v_kind IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_CONVERSATION_DISABLED'; END IF;
  IF v_kind NOT IN ('group','channel') THEN
    SELECT 0 AS __handled;
    LEAVE main;
  END IF;

  SELECT u.id,u.nickname,u.avatar_url,m.user_id,m.role,m.muted_until,p.muted,p.internal_staff
    INTO v_sender,v_name,v_avatar,v_member,v_role,v_muted_until,v_muted,v_staff
    FROM users u
    LEFT JOIN conversation_members m ON m.user_id=u.id AND m.conversation_id=p_conversation
    LEFT JOIN user_permissions p ON p.user_id=u.id
    WHERE u.id=p_sender AND u.status='active' FOR UPDATE;
  IF v_sender IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_ACCOUNT_DISABLED'; END IF;
  IF v_member IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_NOT_MEMBER'; END IF;
  IF v_kind='channel' AND v_role NOT IN ('owner','admin') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_CHANNEL_RESTRICTED'; END IF;
  IF v_kind='group' AND v_all_muted=1 AND v_role NOT IN ('owner','admin') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_ALL_MUTED'; END IF;
  IF p_internal<>0 AND COALESCE(v_staff,0)=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_STAFF_RESTRICTED'; END IF;
  IF COALESCE(v_muted,0)<>0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_ACCOUNT_MUTED'; END IF;
  IF v_muted_until IS NOT NULL AND v_muted_until>p_now THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_MEMBER_MUTED'; END IF;

  -- An absent-key locking read would acquire a gap lock. Insert first and
  -- inspect a positive unique-key conflict instead, across conversations too.
  BEGIN
    DECLARE CONTINUE HANDLER FOR 1062 SET v_duplicate=1;
    INSERT INTO messages(conversation_id,sender_id,type,request_id,body_json,created_at)
      VALUES(p_conversation,p_sender,'text',p_request,p_body,p_now);
  END;
  IF v_duplicate=0 THEN
    SET v_id=LAST_INSERT_ID();
    SET v_message_conversation=p_conversation;
    SET v_message_sender=p_sender;
    SET v_message_kind='text';
    SET v_body=p_body;
    SET v_created=p_now;
    UPDATE conversation_members FORCE INDEX(idx_member_hidden) SET hidden_at=NULL
      WHERE conversation_id=p_conversation AND hidden_at IS NOT NULL;
    UPDATE conversations SET updated_at=p_now WHERE id=p_conversation;
  ELSE
    SELECT id,conversation_id,sender_id,type,body_json,created_at,edited_at,recalled_at
      INTO v_id,v_message_conversation,v_message_sender,v_message_kind,v_body,v_created,v_edited,v_recalled
      FROM messages WHERE request_id=p_request FOR UPDATE;
    IF v_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_INSERT_CONFLICT'; END IF;
    IF v_message_sender<>p_sender OR v_message_conversation<>p_conversation OR v_message_kind<>'text' THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_REQUEST_COLLISION';
    END IF;
    SELECT user_id INTO v_deleted FROM message_deletions WHERE user_id=p_sender AND message_id=v_id FOR UPDATE;
    IF v_deleted IS NOT NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='GROUP_MESSAGE_DELETED'; END IF;
  END IF;
  SELECT 1 AS __handled,1-v_duplicate AS __created,v_id AS id,v_message_conversation AS conversation_id,
    v_message_sender AS sender_id,v_message_kind AS type,v_body AS body_json,v_created AS created_at,
    v_edited AS edited_at,v_recalled AS recalled_at,v_sender AS __sender_id,v_name AS __sender_name,v_avatar AS __sender_avatar;
END
