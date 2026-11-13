-- PHP allowed one Telegram identity to own several administrator entries.
-- Keep the exact relation; admin_accounts.telegram_user_id remains a shortcut
-- for newly created Go accounts only.
CREATE TABLE pulse.legacy_telegram_owners (
 telegram_user_id bigint NOT NULL,
 admin_id uuid NOT NULL REFERENCES pulse.admin_accounts(id),
 legacy_entry_id bigint NOT NULL,
 PRIMARY KEY(telegram_user_id,admin_id)
);
