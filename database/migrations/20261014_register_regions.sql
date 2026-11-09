CREATE TABLE IF NOT EXISTS `ip_region_locations` (
  `ip` VARCHAR(45) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `country_code` CHAR(2) CHARACTER SET ascii NULL,
  `province_code` CHAR(6) CHARACTER SET ascii NULL,
  `region_name` VARCHAR(100) NULL,
  `region_code` VARCHAR(20) NULL,
  `city_name` VARCHAR(100) NULL,
  `location` VARCHAR(160) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `checked_at` DATETIME NULL,
  `next_retry_at` DATETIME NOT NULL,
  PRIMARY KEY (`ip`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
