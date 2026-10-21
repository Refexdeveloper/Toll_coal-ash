import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { all, get, getPool, now, run } from '../db/index.js'
import { collectMovingSnapshots, collectionIsDue, type CollectionSettings } from './gpsCollect.js'

const LOCK_NAME = 'toll_gps_history_collect'
const TICK_MS = 60_000
let started = false
let ticking = false

export async function readCollectionSettings(): Promise<CollectionSettings> {
  const row = await get<{ enabled: number, interval_minutes: number, speed_threshold: number }>(
    `SELECT enabled, interval_minutes, speed_threshold FROM gps_collection_settings WHERE id = 1`,
  ).catch(() => undefined)
  return {
    enabled: row ? Number(row.enabled) === 1 : true,
    intervalMinutes: clampInterval(row?.interval_minutes ?? 120),
    speedThreshold: clampSpeed(row?.speed_threshold ?? 1),
  }
}

export async function saveCollectionSettings(input: {
  enabled: boolean
  intervalMinutes: number
  speedThreshold: number
  userId: number | null
}) {
  const enabled = input.enabled ? 1 : 0
  const intervalMinutes = clampInterval(input.intervalMinutes)
  const speedThreshold = clampSpeed(input.speedThreshold)
  await run(
    `INSERT INTO gps_collection_settings (id, enabled, interval_minutes, speed_threshold, updated_at, updated_by)
     VALUES (1, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled = VALUES(enabled),
       interval_minutes = VALUES(interval_minutes),
       speed_threshold = VALUES(speed_threshold),
       updated_at = VALUES(updated_at),
       updated_by = VALUES(updated_by)`,
    [enabled, intervalMinutes, speedThreshold, now(), input.userId],
  )
  return readCollectionSettings()
}

export async function collectionStatus() {
  const settings = await readCollectionSettings()
  const latest = await get<{
    id: number
    started_at: string
    finished_at: string | null
    status: string
    vehicles_seen: number
    moving: number
    inserted: number
    skipped_dup: number
    error_message: string | null
  }>(
    `SELECT id, started_at, finished_at, status, vehicles_seen, moving, inserted, skipped_dup, error_message
     FROM gps_collection_runs ORDER BY id DESC LIMIT 1`,
  ).catch(() => undefined)
  const success = await get<{ finished_at: string }>(
    `SELECT finished_at FROM gps_collection_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1`,
  ).catch(() => undefined)
  const runs = await all(
    `SELECT id, started_at, finished_at, status, vehicles_seen, moving, inserted, skipped_dup, error_message
     FROM gps_collection_runs ORDER BY id DESC LIMIT 15`,
  ).catch(() => [])
  return {
    enabled: settings.enabled,
    interval_minutes: settings.intervalMinutes,
    speed_threshold: settings.speedThreshold,
    last_success_at: success?.finished_at || null,
    last_run: latest || null,
    runs,
  }
}

export function startGpsHistoryScheduler() {
  if (started) return
  started = true
  const kick = setTimeout(() => {
    void tick('startup')
  }, 15_000)
  const timer = setInterval(() => {
    void tick('interval')
  }, TICK_MS)
  kick.unref?.()
  timer.unref?.()
  console.log('[gps-history] scheduler armed; default interval is 2 hours')
}

export async function runCollectionNow() {
  const settings = await readCollectionSettings()
  return executeCollection(settings)
}

async function tick(reason: string) {
  if (ticking) return
  ticking = true
  try {
    const settings = await readCollectionSettings()
    const latest = await get<{ started_at: string, status: string }>(
      `SELECT started_at, status FROM gps_collection_runs ORDER BY id DESC LIMIT 1`,
    ).catch(() => undefined)
    if (!collectionIsDue({
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes,
      lastStartedAt: latest?.started_at || null,
      lastStatus: latest?.status || null,
    })) return
    const result = await executeCollection(settings)
    if (result?.started) console.log(`[gps-history] collection finished (${reason})`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GPS history collection failed'
    console.error('[gps-history] collection failed:', message)
  } finally {
    ticking = false
  }
}

async function executeCollection(settings: CollectionSettings) {
  const conn = await getPool().getConnection()
  let runId = 0
  let locked = false
  try {
    const [lockRows] = await conn.query<RowDataPacket[]>(`SELECT GET_LOCK(?, 0) AS got`, [LOCK_NAME])
    locked = Number(lockRows[0]?.got) === 1
    if (!locked) return { started: false, reason: 'Another server is already collecting GPS history' }
    await conn.query(
      `UPDATE gps_collection_runs
       SET status = 'failed', finished_at = ?, error_message = 'The previous collection was interrupted'
       WHERE status = 'running' AND started_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE)`,
      [now()],
    )
    const [running] = await conn.query<RowDataPacket[]>(
      `SELECT id FROM gps_collection_runs WHERE status = 'running' AND started_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE) LIMIT 1`,
    )
    if (running.length) return { started: false, reason: 'A collection is already running' }
    const startedAt = now()
    const [inserted] = await conn.query<ResultSetHeader>(
      `INSERT INTO gps_collection_runs (started_at, status) VALUES (?, 'running')`,
      [startedAt],
    )
    runId = Number(inserted.insertId || 0)
    if (!runId) {
      const created = await get<{ id: number }>(
        `SELECT id FROM gps_collection_runs WHERE started_at = ? AND status = 'running' ORDER BY id DESC LIMIT 1`,
        [startedAt],
      )
      runId = Number(created?.id || 0)
    }
    try {
      const result = await collectMovingSnapshots(settings.speedThreshold, 30000)
      await run(
        `UPDATE gps_collection_runs
         SET finished_at = ?, status = 'ok', vehicles_seen = ?, moving = ?, inserted = ?, skipped_dup = ?, error_message = NULL
         WHERE id = ?`,
        [now(), result.vehicles_seen, result.moving, result.inserted, result.duplicates, runId],
      )
      console.log(`[gps-history] saved ${result.inserted} moving snapshots, skipped ${result.duplicates} duplicates, saw ${result.vehicles_seen} vehicles`)
      return { started: true, ...result }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'GPS history collection failed'
      if (runId) {
        await run(
          `UPDATE gps_collection_runs
           SET finished_at = ?, status = 'failed', error_message = ?
           WHERE id = ?`,
          [now(), message.slice(0, 500), runId],
        ).catch(() => undefined)
      }
      throw error
    }
  } finally {
    if (locked) await conn.query(`SELECT RELEASE_LOCK(?)`, [LOCK_NAME]).catch(() => undefined)
    conn.release()
  }
}

function clampInterval(value: number) {
  const minutes = Math.round(Number(value))
  if (!Number.isFinite(minutes)) return 120
  return Math.min(1440, Math.max(15, minutes))
}

function clampSpeed(value: number) {
  const speed = Number(value)
  if (!Number.isFinite(speed)) return 1
  return Math.min(200, Math.max(0, Math.round(speed * 100) / 100))
}
