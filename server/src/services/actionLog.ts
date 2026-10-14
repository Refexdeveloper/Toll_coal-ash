import { all, run } from '../db/index.js'
import { clock } from '../utils/clock.js'

export async function logAction(opts: {
  userId?: number | null
  email?: string | null
  actionType: string
  itemType?: string | null
  itemId?: string | number | null
  note?: string | null
}) {
  try {
    await run(
      `INSERT INTO action_logs (user_id, email, action_type, item_type, item_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.userId ?? null,
        opts.email ?? null,
        opts.actionType,
        opts.itemType ?? null,
        opts.itemId != null ? String(opts.itemId) : null,
        opts.note ?? null,
        clock(),
      ],
    )
  } catch (error) {
    console.warn('[actionLog]', error instanceof Error ? error.message : error)
  }
}

export async function countActivity() {
  const row = await all<{ c: number }>('SELECT COUNT(*) AS c FROM action_logs')
  return Number(row[0]?.c || 0)
}

export async function listActivity(limit = 10, offset = 0) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const safeOffset = Math.max(0, Math.floor(offset))
  return all(`
    SELECT a.id, a.created_at AS at, a.user_id,
           COALESCE(a.email, u.email) AS email,
           a.action_type AS action, a.item_type, a.item_id, a.note
    FROM action_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.id DESC
    LIMIT ${safeLimit} OFFSET ${safeOffset}
  `)
}
