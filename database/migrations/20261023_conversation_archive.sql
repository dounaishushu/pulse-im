-- Run against the configured application database. Safe to repeat.
SET @pulse_archive_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation_members' AND COLUMN_NAME = 'is_archived'
);
SET @pulse_archive_ddl = IF(
  @pulse_archive_exists = 0,
  'ALTER TABLE `conversation_members` ADD COLUMN `is_archived` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_pinned`',
  'SELECT 1'
);
PREPARE pulse_archive_statement FROM @pulse_archive_ddl;
EXECUTE pulse_archive_statement;
DEALLOCATE PREPARE pulse_archive_statement;
