-- Only changes the default for future permission rows; existing values are preserved.
ALTER TABLE `user_permissions` ALTER COLUMN `allow_create_group` SET DEFAULT 0;
