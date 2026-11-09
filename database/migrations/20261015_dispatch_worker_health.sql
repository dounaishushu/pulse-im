CREATE TABLE IF NOT EXISTS dispatch_worker_health (
  worker_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  started_at DATETIME NOT NULL,
  heartbeat_at DATETIME NOT NULL,
  last_tick_at DATETIME NULL,
  last_tick_json JSON NULL,
  KEY idx_dispatch_worker_heartbeat (heartbeat_at),
  KEY idx_dispatch_worker_tick (last_tick_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_dispatch_run_failures ON dispatch_task_runs (status,finished_at);
