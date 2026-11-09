CREATE TABLE IF NOT EXISTS work_record_reviews (
  request_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  record_id BIGINT UNSIGNED NOT NULL,
  reviewer_admin_id BIGINT UNSIGNED NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_work_review_record (record_id),
  CONSTRAINT fk_work_review_record FOREIGN KEY (record_id) REFERENCES work_task_records(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

UPDATE work_record_reviews
SET result_json = JSON_REMOVE(result_json, '$.record.nickname', '$.record.username', '$.record.avatar_url')
WHERE JSON_CONTAINS_PATH(result_json, 'one', '$.record.nickname', '$.record.username', '$.record.avatar_url');
