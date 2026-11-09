ALTER TABLE `messages`
  ADD COLUMN `edited_at` DATETIME NULL AFTER `recalled_at`;
