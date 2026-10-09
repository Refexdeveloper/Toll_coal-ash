import { all, run } from './index.js'

async function columnExists(table: string, column: string) {
  const rows = await all<{ Field: string }>(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column])
  return rows.length > 0
}

async function indexExists(table: string, name: string) {
  const rows = await all<{ Key_name: string }>(
    `SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`,
    [name],
  )
  return rows.length > 0
}

export async function ensureAppColumns() {
  if (!(await columnExists('fastag_reads', 'run_id'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN run_id INT UNSIGNED NULL AFTER vehicle_id`)
  }
  if (!(await columnExists('fastag_reads', 'fetched_at'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN fetched_at DATETIME NULL AFTER created_at`)
  }
  if (!(await columnExists('action_logs', 'email'))) {
    await run(`ALTER TABLE action_logs ADD COLUMN email VARCHAR(191) NULL AFTER user_id`)
  }
  if (await indexExists('fastag_reads', 'uk_fastag_batch_seq')) {
    await run(`ALTER TABLE fastag_reads DROP INDEX uk_fastag_batch_seq`)
  }
  if (!(await indexExists('fastag_reads', 'uk_fastag_run_seq'))) {
    await run(`ALTER TABLE fastag_reads ADD UNIQUE KEY uk_fastag_run_seq (run_id, seq_no)`)
  }
}
