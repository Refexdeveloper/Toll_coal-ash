-- Keep every FASTag pull, and record who did what.

CREATE TABLE IF NOT EXISTS `fastag_runs` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `batch_id` INT UNSIGNED NOT NULL,
  `kind` VARCHAR(16) NOT NULL DEFAULT 'fetch',
  `actor_email` VARCHAR(191) NULL,
  `started_at` DATETIME NOT NULL,
  `finished_at` DATETIME NULL,
  PRIMARY KEY (`id`),
  KEY `idx_fastag_runs_batch` (`batch_id`),
  CONSTRAINT `fk_fastag_run_batch` FOREIGN KEY (`batch_id`) REFERENCES `fastag_batches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
