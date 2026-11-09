USE `pulse_im`;

CREATE TABLE IF NOT EXISTS `sensitive_words` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `word` VARCHAR(128) NOT NULL,
  `replacement` VARCHAR(128) NOT NULL DEFAULT '*',
  `status` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_sensitive_word` (`word`),
  KEY `idx_sensitive_status` (`status`)
) ENGINE=InnoDB;
