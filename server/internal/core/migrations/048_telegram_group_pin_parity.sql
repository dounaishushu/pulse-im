-- Existing single-account grants retain their entry ownership after 047.
UPDATE pulse.telegram_grants
SET admin_ids = ARRAY[admin_id]
WHERE cardinality(admin_ids) = 0 AND admin_id IS NOT NULL;

-- A configured global PIN may admit members of any group that hosts the bot.
-- Manual per-chat PIN rules remain separate.
ALTER TABLE pulse.telegram_chats
ADD COLUMN global_managed boolean NOT NULL DEFAULT false;
