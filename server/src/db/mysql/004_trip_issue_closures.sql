CREATE TABLE IF NOT EXISTS trip_issue_closures (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_key VARCHAR(500) NOT NULL,
  closed_by INT UNSIGNED NULL,
  closed_at DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_trip_issue_key (issue_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
