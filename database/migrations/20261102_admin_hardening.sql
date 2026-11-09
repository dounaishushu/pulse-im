-- Additive only. Existing accounts, credentials and business records are preserved.
CREATE TABLE IF NOT EXISTS admin_security_rates (
  bucket_key CHAR(64) NOT NULL PRIMARY KEY,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  KEY idx_admin_security_rate_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
