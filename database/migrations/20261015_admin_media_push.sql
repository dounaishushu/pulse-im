CREATE TABLE IF NOT EXISTS admin_accounts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'operator',
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS media_references (
  path VARCHAR(255) NOT NULL, message_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (path,message_id), KEY idx_media_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, admin_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL,
  UNIQUE KEY uk_admin_token (token_hash), KEY idx_admin_session (admin_id),
  CONSTRAINT fk_admin_session_account FOREIGN KEY (admin_id) REFERENCES admin_accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, username VARCHAR(64) NOT NULL,
  ip VARCHAR(45) NOT NULL, success TINYINT NOT NULL, created_at DATETIME NOT NULL,
  KEY idx_admin_attempt_ip (ip,success,created_at), KEY idx_admin_attempt_user (username,success,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS media_uploads (
  path VARCHAR(255) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NULL,
  admin_id BIGINT UNSIGNED NULL, kind VARCHAR(16) NOT NULL, created_at DATETIME NOT NULL,
  KEY idx_media_owner (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS push_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, message_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL, device_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending', attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL, lease_until DATETIME NULL,
  last_error VARCHAR(255) NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_push_message_device (message_id,device_id), KEY idx_push_due (status,next_attempt_at,lease_until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS push_cursor (
  id TINYINT PRIMARY KEY, last_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0, heartbeat_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO push_cursor (id,last_event_id) VALUES (1,0);
