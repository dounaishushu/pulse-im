-- Existing installations: use tools/apply-group-display-count-migration.php.
-- It checks the configured table prefix and existing column before running DDL.
ALTER TABLE `conversations` ADD COLUMN `member_count_offset` INT NOT NULL DEFAULT 0;
