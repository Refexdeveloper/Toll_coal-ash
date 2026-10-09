import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise'
import { get, withTransaction } from './index.js'

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data')

async function exec(conn: PoolConnection, sql: string, params: unknown[] = []) {
  const [result] = await conn.query<ResultSetHeader>(sql, params)
  return result
}

async function bump(conn: PoolConnection, table: string) {
  const [rows] = await conn.query<Array<{ n: number } & import('mysql2/promise').RowDataPacket>>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS n FROM \`${table}\``,
  )
  const next = Number(rows[0]?.n || 1)
  await conn.query(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${next}`)
}

export async function importFastagJsonIfRicher() {
  await importReads()
  await importActivity()
}

async function importReads() {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dataDir, 'fastag.json'), 'utf8')
  } catch {
    return
  }
  const parsed = JSON.parse(raw) as {
    batches?: Record<string, unknown>[]
    vehicles?: Record<string, unknown>[]
    reads?: Record<string, unknown>[]
    runs?: Record<string, unknown>[]
  }
  const reads = Array.isArray(parsed.reads) ? parsed.reads : []
  const current = await get<{ n: number }>('SELECT COUNT(*) AS n FROM fastag_reads')
  if (reads.length <= Number(current?.n || 0)) return

  await withTransaction(async (conn) => {
    await exec(conn, 'SET FOREIGN_KEY_CHECKS = 0')
    await exec(conn, 'DELETE FROM fastag_reads')
    await exec(conn, 'DELETE FROM fastag_vehicles')
    await exec(conn, 'DELETE FROM fastag_runs')
    await exec(conn, 'DELETE FROM fastag_batches')

    const [userRows] = await conn.query<Array<{ id: number } & import('mysql2/promise').RowDataPacket>>(
      'SELECT id FROM users',
    )
    const userIds = new Set(userRows.map((row) => Number(row.id)))

    for (const batch of parsed.batches || []) {
      const uploadedBy = Number(batch.uploaded_by)
      await exec(conn, `
        INSERT INTO fastag_batches (
          id, filename, source, uploaded_by, vehicle_count, ok_count, error_count, read_count,
          status, error_message, created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        batch.id,
        batch.filename,
        batch.source || 'excel',
        userIds.has(uploadedBy) ? uploadedBy : null,
        batch.vehicle_count || 0,
        batch.ok_count || 0,
        batch.error_count || 0,
        batch.read_count || 0,
        batch.status || 'done',
        batch.error_message ?? null,
        batch.created_at,
        batch.started_at ?? null,
        batch.finished_at ?? null,
      ])
    }

    for (const item of parsed.runs || []) {
      await exec(conn, `
        INSERT INTO fastag_runs (id, batch_id, kind, actor_email, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        item.id,
        item.batch_id,
        item.kind || 'fetch',
        item.actor_email ?? null,
        item.started_at,
        item.finished_at ?? null,
      ])
    }

    for (const vehicle of parsed.vehicles || []) {
      await exec(conn, `
        INSERT INTO fastag_vehicles (
          id, batch_id, vehicle_reg_no, status, http_status, error_message, read_count, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        vehicle.id,
        vehicle.batch_id,
        vehicle.vehicle_reg_no,
        vehicle.status || 'pending',
        vehicle.http_status ?? null,
        vehicle.error_message ?? null,
        vehicle.read_count || 0,
        vehicle.fetched_at ?? null,
      ])
    }

    for (const row of reads) {
      await exec(conn, `
        INSERT INTO fastag_reads (
          id, batch_id, vehicle_id, run_id, vehicle_reg_no, reader_read_time, seq_no, lane_direction,
          toll_plaza_geocode, toll_plaza_name, vehicle_type, raw_json, created_at, fetched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
      `, [
        row.id,
        row.batch_id,
        row.vehicle_id,
        row.run_id ?? null,
        row.vehicle_reg_no,
        row.reader_read_time ?? null,
        row.seq_no ?? null,
        row.lane_direction ?? null,
        row.toll_plaza_geocode ?? null,
        row.toll_plaza_name ?? null,
        row.vehicle_type ?? null,
        row.raw_json ? JSON.stringify(row.raw_json) : null,
        row.created_at,
        row.fetched_at || row.created_at,
      ])
    }

    await bump(conn, 'fastag_batches')
    await bump(conn, 'fastag_vehicles')
    await bump(conn, 'fastag_runs')
    await bump(conn, 'fastag_reads')
    await exec(conn, 'SET FOREIGN_KEY_CHECKS = 1')
  })
  console.log(`Imported ${reads.length} toll reads from server/data/fastag.json`)
}

async function importActivity() {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dataDir, 'activity.json'), 'utf8')
  } catch {
    return
  }
  const parsed = JSON.parse(raw) as { entries?: Record<string, unknown>[] } | Record<string, unknown>[]
  const entries = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.entries) ? parsed.entries : [])
  if (!entries.length) return

  let added = 0
  await withTransaction(async (conn) => {
    const [userRows] = await conn.query<Array<{ id: number, email: string } & import('mysql2/promise').RowDataPacket>>(
      'SELECT id, email FROM users',
    )
    const byEmail = new Map(userRows.map((row) => [String(row.email).toLowerCase(), Number(row.id)]))
    for (const row of entries) {
      const action = String(row.action || row.action_type || '')
      const at = String(row.at || row.created_at || '')
      const email = row.email != null ? String(row.email) : null
      const note = row.note ?? null
      if (!action || !at) continue
      const userId = email ? (byEmail.get(email.toLowerCase()) ?? null) : null
      const [found] = await conn.query<Array<{ id: number } & import('mysql2/promise').RowDataPacket>>(
        `SELECT id FROM action_logs
         WHERE action_type = ? AND created_at = ? AND COALESCE(email, '') = COALESCE(?, '')
           AND COALESCE(note, '') = COALESCE(?, '')
         LIMIT 1`,
        [action, at, email, note],
      )
      if (found.length) continue
      await exec(conn, `
        INSERT INTO action_logs (user_id, email, action_type, item_type, item_id, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        userId,
        email,
        action,
        row.item_type ?? null,
        row.item_id != null ? String(row.item_id) : null,
        note,
        at,
      ])
      added += 1
    }
  })
  if (added) console.log(`Imported ${added} activity rows from server/data/activity.json`)
}
