CREATE TABLE IF NOT EXISTS maintenance_config (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT UNSIGNED NOT NULL DEFAULT 0,
  clean_accounts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  clean_cache TINYINT UNSIGNED NOT NULL DEFAULT 1,
  inactive_days SMALLINT UNSIGNED NOT NULL DEFAULT 90,
  cache_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
  interval_days SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  run_time CHAR(5) NOT NULL DEFAULT '03:00',
  next_run_at DATETIME NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_admin_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO maintenance_config (id,updated_at) VALUES (1,NOW());

CREATE TABLE IF NOT EXISTS maintenance_state (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  lease_token CHAR(64) NULL,
  lease_until DATETIME NULL,
  worker_seen_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO maintenance_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS maintenance_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  trigger_type VARCHAR(16) NOT NULL,
  admin_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  config_version INT UNSIGNED NULL,
  options_json TEXT NOT NULL,
  selected_ids_json TEXT NULL,
  cutoff_at DATETIME NOT NULL,
  upper_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  cursor_user_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  deleted_count INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
  cache_done TINYINT UNSIGNED NOT NULL DEFAULT 0,
  cache_json TEXT NULL,
  error_code VARCHAR(40) NULL,
  created_at DATETIME NOT NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  UNIQUE KEY uk_maintenance_request (request_id),
  KEY idx_maintenance_queue (status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS maintenance_run_users (
  run_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  outcome VARCHAR(16) NOT NULL,
  reason VARCHAR(40) NOT NULL,
  last_active_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (run_id,user_id),
  KEY idx_maintenance_user (user_id,run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
