-- NULL preserves old role defaults; [] explicitly means no assigned page permissions.
ALTER TABLE admin_accounts ADD COLUMN permissions_json JSON NULL AFTER status;

CREATE TABLE IF NOT EXISTS admin_account_guard (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=InnoDB;
INSERT IGNORE INTO admin_account_guard (id) VALUES (1);
