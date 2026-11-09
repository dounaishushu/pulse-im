CREATE TABLE IF NOT EXISTS admin_account_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_id BIGINT UNSIGNED NOT NULL,
  telegram_user_id VARCHAR(20) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_salt CHAR(64) NOT NULL,
  creation_request_key CHAR(64) NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_entry_account (admin_id),
  UNIQUE KEY uk_admin_entry_token (token_hash),
  UNIQUE KEY uk_admin_entry_creation (creation_request_key),
  KEY idx_admin_entry_telegram (telegram_user_id),
  CONSTRAINT fk_admin_entry_account FOREIGN KEY (admin_id) REFERENCES admin_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
