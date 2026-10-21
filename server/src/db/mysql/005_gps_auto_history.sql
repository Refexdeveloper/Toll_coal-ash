CREATE TABLE IF NOT EXISTS gps_collection_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  status VARCHAR(16) NOT NULL,
  vehicles_seen INT NOT NULL DEFAULT 0,
  moving INT NOT NULL DEFAULT 0,
  inserted INT NOT NULL DEFAULT 0,
  skipped_dup INT NOT NULL DEFAULT 0,
  error_message VARCHAR(500) NULL,
  PRIMARY KEY (id),
  KEY idx_gps_collection_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gps_collection_settings (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  interval_minutes INT UNSIGNED NOT NULL DEFAULT 120,
  speed_threshold DECIMAL(6, 2) NOT NULL DEFAULT 1.00,
  updated_at DATETIME NULL,
  updated_by INT UNSIGNED NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO gps_collection_settings (id, enabled, interval_minutes, speed_threshold, updated_at)
VALUES (1, 1, 120, 1.00, UTC_TIMESTAMP())
ON DUPLICATE KEY UPDATE id = id;

SET @gps_add_source = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking') = 0
    OR (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking' AND COLUMN_NAME = 'source') > 0,
    'SELECT 1',
    'ALTER TABLE gps_tracking ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT ''manual'' AFTER recorded_at'
  )
);
PREPARE gps_add_source_stmt FROM @gps_add_source;
EXECUTE gps_add_source_stmt;
DEALLOCATE PREPARE gps_add_source_stmt;

SET @gps_add_key = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking') = 0
    OR (SELECT COUNT(*) FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking' AND COLUMN_NAME = 'auto_key') > 0,
    'SELECT 1',
    'ALTER TABLE gps_tracking ADD COLUMN auto_key VARCHAR(96) NULL AFTER source'
  )
);
PREPARE gps_add_key_stmt FROM @gps_add_key;
EXECUTE gps_add_key_stmt;
DEALLOCATE PREPARE gps_add_key_stmt;

SET @gps_add_unique = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking') = 0
    OR (SELECT COUNT(*) FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'gps_tracking' AND INDEX_NAME = 'uk_gps_auto_key') > 0,
    'SELECT 1',
    'ALTER TABLE gps_tracking ADD UNIQUE KEY uk_gps_auto_key (auto_key)'
  )
);
PREPARE gps_add_unique_stmt FROM @gps_add_unique;
EXECUTE gps_add_unique_stmt;
DEALLOCATE PREPARE gps_add_unique_stmt;
