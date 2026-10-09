import * as XLSX from 'xlsx'
import { all, get, run } from '../db/index.js'
import { logAction } from './actionLog.js'
import { clock } from '../utils/clock.js'

const PLATE = /^(?:[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}|\d{2}BH\d{4}[A-Z]{1,2})$/
const INLINE = /[A-Z]{2}\s*-?\s*\d{1,2}\s*-?\s*[A-Z]{1,3}\s*-?\s*\d{1,4}|\d{2}\s*-?\s*BH\s*-?\s*\d{4}\s*-?\s*[A-Z]{1,2}/gi
const HEADER_HINT = /vehicle|reg(?:istration)?|number\s*plate|reg\.?\s*no|vrn|fastag|fleet|truck/i
const MAX_VEHICLES = 5000
const READ_LIMIT = 50000

const running = new Set<number>()

export type FastagBatch = {
  id: number
  filename: string
  source: string
  uploaded_by: number | null
  vehicle_count: number
  ok_count: number
  error_count: number
  read_count: number
  status: string
  error_message: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

export type FastagVehicle = {
  id: number
  batch_id: number
  vehicle_reg_no: string
  status: string
  http_status: number | null
  error_message: string | null
  read_count: number
  fetched_at: string | null
}

export type FastagRead = {
  id: number
  batch_id: number
  vehicle_id: number
  vehicle_reg_no: string
  reader_read_time: string | null
  seq_no: string | null
  lane_direction: string | null
  toll_plaza_geocode: string | null
  toll_plaza_name: string | null
  vehicle_type: string | null
  created_at: string
  fetched_at: string | null
  run_id: number | null
}

export function normalizePlate(raw: unknown): string | null {
  const compact = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!PLATE.test(compact)) return null
  return compact
}

function platesInText(value: unknown): string[] {
  const text = String(value ?? '').toUpperCase()
  if (!text.trim()) return []
  const direct = normalizePlate(text)
  if (direct) return [direct]
  const found: string[] = []
  const matches = text.match(INLINE) || []
  for (const match of matches) {
    const plate = normalizePlate(match)
    if (plate) found.push(plate)
  }
  return found
}

export function extractPlates(buffer: Buffer): string[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return []
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  if (!rows.length) return []

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const header = rows[0].map((cell) => String(cell ?? ''))
  const hinted = header
    .map((cell, index) => (HEADER_HINT.test(cell) ? index : -1))
    .filter((index) => index >= 0)

  const fromColumn = (indexes: number[]) => {
    const plates: string[] = []
    const seen = new Set<string>()
    rows.forEach((row, rowIndex) => {
      if (rowIndex === 0 && indexes.some((index) => HEADER_HINT.test(String(row[index] ?? '')))) return
      for (const index of indexes) {
        for (const plate of platesInText(row[index])) {
          if (seen.has(plate)) continue
          seen.add(plate)
          plates.push(plate)
        }
      }
    })
    return plates
  }

  if (hinted.length) {
    const picked = fromColumn(hinted)
    if (picked.length) return picked.slice(0, MAX_VEHICLES)
  }

  const scores = Array.from({ length: width }, (_, index) => fromColumn([index]).length)
  const best = scores.reduce((top, score, index) => (score > scores[top] ? index : top), 0)
  if (scores[best] > 0) return fromColumn([best]).slice(0, MAX_VEHICLES)

  const seen = new Set<string>()
  const plates: string[] = []
  for (const row of rows) {
    for (const cell of row) {
      for (const plate of platesInText(cell)) {
        if (seen.has(plate)) continue
        seen.add(plate)
        plates.push(plate)
        if (plates.length >= MAX_VEHICLES) return plates
      }
    }
  }
  return plates
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeRead(row: Record<string, unknown>) {
  return ['vehicleRegNo', 'vehicle_reg_no', 'seqNo', 'seq_no', 'tollPlazaName', 'toll_plaza_name', 'readerReadTime', 'reader_read_time']
    .some((key) => row[key] != null && String(row[key]).trim() !== '')
}

function pick(row: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = row[key]
    if (value == null || value === '') continue
    if (Array.isArray(value)) {
      const text = value.map((item) => String(item)).filter(Boolean).join(', ')
      if (text) return text.slice(0, 500)
      continue
    }
    return String(value).slice(0, 500)
  }
  return null
}

export function collectRecords(body: unknown): Record<string, unknown>[] {
  if (body == null) return []
  if (typeof body === 'string') {
    const trimmed = body.trim()
    if (!trimmed) return []
    try { return collectRecords(JSON.parse(trimmed)) } catch { return [] }
  }
  if (Array.isArray(body)) return body.filter(isRecord)
  if (!isRecord(body)) return []

  for (const key of ['transactions', 'data', 'records', 'rows', 'result', 'payload', 'items', 'list', 'response']) {
    const value = body[key]
    if (Array.isArray(value)) return value.filter(isRecord)
    if (isRecord(value) && looksLikeRead(value)) return [value]
    if (isRecord(value)) {
      const nested = collectRecords(value)
      if (nested.length) return nested
    }
  }
  if (looksLikeRead(body)) return [body]
  return []
}

function apiErrorMessage(body: unknown) {
  if (!isRecord(body)) return null
  const status = String(body.status ?? body.success ?? '').toLowerCase()
  const failed = status === 'error' || status === 'failed' || status === 'false' || body.success === false
  if (!failed) return null
  return pick(body, 'message', 'messages', 'error', 'msg', 'errorMessage') || 'Lookup failed'
}

function clip(value: string | null, max: number) {
  if (!value) return null
  return value.length > max ? value.slice(0, max) : value
}

type Actor = { id: number, email: string | null }

const activeRun = new Map<number, { id: number, started_at: string }>()

const BATCH_COLS = `id, filename, source, uploaded_by, vehicle_count, ok_count, error_count, read_count,
  status, error_message, created_at, started_at, finished_at`
const VEHICLE_COLS = `id, batch_id, vehicle_reg_no, status, http_status, error_message, read_count, fetched_at`
const READ_COLS = `id, batch_id, vehicle_id, vehicle_reg_no, reader_read_time, seq_no, lane_direction,
  toll_plaza_geocode, toll_plaza_name, vehicle_type, created_at, fetched_at, run_id`

function stampParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '00'
  return {
    file: `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-${part('second')}`,
    label: `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`,
  }
}

async function recount(batchId: number) {
  await run(`
    UPDATE fastag_batches b
    SET vehicle_count = (SELECT COUNT(*) FROM fastag_vehicles v WHERE v.batch_id = b.id),
        ok_count = (SELECT COUNT(*) FROM fastag_vehicles v WHERE v.batch_id = b.id AND v.status = 'ok'),
        error_count = (SELECT COUNT(*) FROM fastag_vehicles v WHERE v.batch_id = b.id AND v.status IN ('error', 'empty')),
        read_count = (SELECT COUNT(*) FROM fastag_reads r WHERE r.batch_id = b.id)
    WHERE b.id = ?
  `, [batchId])
}

export async function listBatches() {
  return all<FastagBatch>(`SELECT ${BATCH_COLS} FROM fastag_batches ORDER BY id DESC LIMIT 100`)
}

export async function getBatch(id: number) {
  return get<FastagBatch>(`SELECT ${BATCH_COLS} FROM fastag_batches WHERE id = ?`, [id])
}

export async function getBatchDetail(id: number) {
  const batch = await getBatch(id)
  if (!batch) return null
  const vehicles = await all<FastagVehicle>(
    `SELECT ${VEHICLE_COLS} FROM fastag_vehicles WHERE batch_id = ? ORDER BY id`,
    [id],
  )
  const reads = await all<FastagRead>(
    `SELECT ${READ_COLS} FROM fastag_reads WHERE batch_id = ? ORDER BY fetched_at DESC, id DESC LIMIT ${READ_LIMIT}`,
    [id],
  )
  return { batch, vehicles, reads }
}

export async function createBatch(opts: {
  filename: string
  source: 'excel' | 'manual'
  uploadedBy: number | null
  plates: string[]
}) {
  const plates = [...new Set(opts.plates.map((plate) => normalizePlate(plate)).filter((plate): plate is string => !!plate))]
  if (!plates.length) {
    throw new Error('No vehicle numbers found. Use values like CG13BF6032.')
  }
  if (plates.length > MAX_VEHICLES) {
    throw new Error(`A sheet can contain up to ${MAX_VEHICLES} vehicles.`)
  }
  const created = clock()
  const inserted = await run(`
    INSERT INTO fastag_batches
      (filename, source, uploaded_by, vehicle_count, ok_count, error_count, read_count, status, created_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, 'ready', ?)
  `, [opts.filename.slice(0, 255), opts.source, opts.uploadedBy, plates.length, created])
  const batchId = inserted.insertId
  for (const plate of plates) {
    await run(`
      INSERT INTO fastag_vehicles (batch_id, vehicle_reg_no, status, read_count)
      VALUES (?, ?, 'pending', 0)
    `, [batchId, plate])
  }
  const detail = await getBatchDetail(batchId)
  if (!detail) throw new Error('Could not load the uploaded sheet')
  return detail
}

async function startRun(batchId: number, kind: 'fetch' | 'retry', actorEmail: string | null) {
  const started_at = clock()
  const created = await run(`
    INSERT INTO fastag_runs (batch_id, kind, actor_email, started_at)
    VALUES (?, ?, ?, ?)
  `, [batchId, kind, actorEmail, started_at])
  activeRun.set(batchId, { id: created.insertId, started_at })
  return created.insertId
}

async function closeRun(batchId: number) {
  const active = activeRun.get(batchId)
  if (active) {
    await run(`UPDATE fastag_runs SET finished_at = ? WHERE id = ?`, [clock(), active.id])
  }
  activeRun.delete(batchId)
}

async function addReads(batchId: number, vehicleId: number, regNo: string, records: Record<string, unknown>[]) {
  let stored = 0
  const current = activeRun.get(batchId)
  const fetchedAt = current?.started_at || clock()
  for (const record of records) {
    const seq = clip(pick(record, 'seqNo', 'seq_no', 'seq', 'sequenceNo'), 128)
    const createdAt = clock()
    await run(`
      INSERT INTO fastag_reads (
        batch_id, vehicle_id, run_id, vehicle_reg_no, reader_read_time, seq_no, lane_direction,
        toll_plaza_geocode, toll_plaza_name, vehicle_type, raw_json, created_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
      ON DUPLICATE KEY UPDATE
        vehicle_id = VALUES(vehicle_id),
        vehicle_reg_no = VALUES(vehicle_reg_no),
        reader_read_time = VALUES(reader_read_time),
        lane_direction = VALUES(lane_direction),
        toll_plaza_geocode = VALUES(toll_plaza_geocode),
        toll_plaza_name = VALUES(toll_plaza_name),
        vehicle_type = VALUES(vehicle_type),
        raw_json = VALUES(raw_json),
        fetched_at = VALUES(fetched_at)
    `, [
      batchId,
      vehicleId,
      current?.id ?? null,
      regNo,
      clip(pick(record, 'readerReadTime', 'reader_read_time', 'readTime', 'read_time'), 40),
      seq,
      clip(pick(record, 'laneDirection', 'lane_direction', 'direction'), 16),
      clip(pick(record, 'tollPlazaGeocode', 'toll_plaza_geocode', 'geocode'), 80),
      clip(pick(record, 'tollPlazaName', 'toll_plaza_name', 'plazaName', 'plaza'), 191),
      clip(pick(record, 'vehicleType', 'vehicle_type', 'class'), 32),
      JSON.stringify(record),
      createdAt,
      fetchedAt,
    ])
    stored += 1
  }
  return stored
}

async function lookupVehicle(regNo: string) {
  const token = String(process.env.FASTAG_ACCESS_TOKEN || '').trim()
  if (!token) {
    throw new Error('FASTAG_ACCESS_TOKEN is not set on the server')
  }
  const base = String(process.env.FASTAG_API_BASE || 'https://customer.ktt.io/refex/fastag').replace(/\/$/, '')
  const url = `${base}/${encodeURIComponent(regNo)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-AT-AccessToken': token,
      },
      signal: controller.signal,
    })
    const text = await response.text()
    let body: unknown = text
    try { body = text ? JSON.parse(text) : null } catch { /* keep text */ }
    return { httpStatus: response.status, ok: response.ok, body, text: text.slice(0, 500) }
  } finally {
    clearTimeout(timer)
  }
}

async function markVehicle(vehicleId: number, patch: Partial<FastagVehicle>) {
  const allowed = ['status', 'http_status', 'error_message', 'read_count', 'fetched_at'] as const
  const sets: string[] = []
  const params: unknown[] = []
  for (const key of allowed) {
    if (patch[key] !== undefined) {
      sets.push(`${key} = ?`)
      params.push(patch[key])
    }
  }
  if (!sets.length) return
  params.push(vehicleId)
  await run(`UPDATE fastag_vehicles SET ${sets.join(', ')} WHERE id = ?`, params)
}

async function fetchOne(batchId: number, vehicle: FastagVehicle) {
  const stamp = clock()
  try {
    const result = await lookupVehicle(vehicle.vehicle_reg_no)
    const failed = result.ok ? apiErrorMessage(result.body) : (apiErrorMessage(result.body) || result.text || `HTTP ${result.httpStatus}`)
    if (!result.ok || failed) {
      await markVehicle(vehicle.id, {
        status: 'error',
        http_status: result.httpStatus,
        error_message: clip(failed || `HTTP ${result.httpStatus}`, 500),
        read_count: 0,
        fetched_at: stamp,
      })
      await recount(batchId)
      return
    }

    let records = collectRecords(result.body)
    if (!records.length && isRecord(result.body) && Object.keys(result.body).length) {
      records = [result.body]
    }
    if (!records.length) {
      await markVehicle(vehicle.id, {
        status: 'empty',
        http_status: result.httpStatus,
        error_message: 'No toll reads returned',
        read_count: 0,
        fetched_at: stamp,
      })
      await recount(batchId)
      return
    }

    const stored = await addReads(batchId, vehicle.id, vehicle.vehicle_reg_no, records)
    await markVehicle(vehicle.id, {
      status: 'ok',
      http_status: result.httpStatus,
      error_message: null,
      read_count: stored,
      fetched_at: stamp,
    })
    await recount(batchId)
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? 'Timed out waiting for the FASTag API'
      : (error instanceof Error ? error.message : 'Lookup failed')
    await markVehicle(vehicle.id, {
      status: 'error',
      error_message: clip(message, 500),
      fetched_at: stamp,
    })
    await recount(batchId)
  }
}

async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await fn(items[index])
    }
  })
  await Promise.all(workers)
}

async function vehiclesFor(batchId: number) {
  return all<FastagVehicle>(
    `SELECT ${VEHICLE_COLS} FROM fastag_vehicles WHERE batch_id = ? ORDER BY id`,
    [batchId],
  )
}

export async function runBatch(batchId: number, actor?: Actor) {
  const batch = await getBatch(batchId)
  if (!batch) throw new Error('Sheet not found')
  const started = clock()
  await startRun(batchId, 'fetch', actor?.email ?? null)
  await run(`
    UPDATE fastag_vehicles
    SET status = 'pending', http_status = NULL, error_message = NULL, read_count = 0, fetched_at = NULL
    WHERE batch_id = ?
  `, [batchId])
  await run(`
    UPDATE fastag_batches
    SET status = 'running', ok_count = 0, error_count = 0, error_message = NULL, started_at = ?, finished_at = NULL
    WHERE id = ?
  `, [started, batchId])
  await logAction({
    userId: actor?.id,
    email: actor?.email,
    actionType: 'fetch_started',
    itemType: 'fastag_batch',
    itemId: batchId,
    note: `Started a full fetch for ${batch.filename}`,
  })

  const vehicles = await vehiclesFor(batchId)
  const concurrency = Math.max(1, Math.min(8, Number(process.env.FASTAG_CONCURRENCY || 4)))
  try {
    await mapPool(vehicles, concurrency, async (vehicle) => {
      await fetchOne(batchId, vehicle)
    })
    await run(`UPDATE fastag_batches SET status = 'done', finished_at = ? WHERE id = ?`, [clock(), batchId])
    await recount(batchId)
    await closeRun(batchId)
    const done = await getBatch(batchId)
    await logAction({
      userId: actor?.id,
      email: actor?.email,
      actionType: 'fetch_finished',
      itemType: 'fastag_batch',
      itemId: batchId,
      note: `Fetch finished. Stored ${done?.ok_count ?? 0}, failed ${done?.error_count ?? 0}, toll reads kept ${done?.read_count ?? 0}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fetch failed'
    await run(`
      UPDATE fastag_batches SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?
    `, [clip(message, 500), clock(), batchId])
    await recount(batchId)
    await closeRun(batchId)
    await logAction({
      userId: actor?.id,
      email: actor?.email,
      actionType: 'fetch_failed',
      itemType: 'fastag_batch',
      itemId: batchId,
      note: message,
    })
  }
}

async function finishBatch(batchId: number, status: 'done' | 'failed', errorMessage?: string) {
  await run(`
    UPDATE fastag_batches SET status = ?, error_message = ?, finished_at = ? WHERE id = ?
  `, [status, errorMessage ? clip(errorMessage, 500) : null, clock(), batchId])
  await recount(batchId)
}

async function runRetry(batchId: number, failedIds: number[], actor?: Actor) {
  const vehicles = (await vehiclesFor(batchId)).filter((row) => failedIds.includes(row.id))
  const concurrency = Math.max(1, Math.min(8, Number(process.env.FASTAG_CONCURRENCY || 4)))
  try {
    await mapPool(vehicles, concurrency, async (vehicle) => {
      await fetchOne(batchId, vehicle)
    })
    await closeRun(batchId)
    await finishBatch(batchId, 'done')
    const done = await getBatch(batchId)
    await logAction({
      userId: actor?.id,
      email: actor?.email,
      actionType: 'retry_finished',
      itemType: 'fastag_batch',
      itemId: batchId,
      note: `Retry finished. Failed remaining ${done?.error_count ?? 0}. Toll reads kept ${done?.read_count ?? 0}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Fetch failed'
    await closeRun(batchId)
    await finishBatch(batchId, 'failed', message)
    await logAction({
      userId: actor?.id,
      email: actor?.email,
      actionType: 'retry_failed',
      itemType: 'fastag_batch',
      itemId: batchId,
      note: message,
    })
  }
}

export async function queueRetryFailed(batchId: number, actor?: Actor) {
  if (running.has(batchId)) return 0
  const batch = await getBatch(batchId)
  if (!batch) throw new Error('Sheet not found')
  const failed = await all<{ id: number }>(
    `SELECT id FROM fastag_vehicles WHERE batch_id = ? AND status = 'error' ORDER BY id`,
    [batchId],
  )
  const failedIds = failed.map((row) => Number(row.id))
  if (!failedIds.length) return 0
  running.add(batchId)
  try {
    await startRun(batchId, 'retry', actor?.email ?? null)
    const marks = failedIds.map(() => '?').join(', ')
    await run(`
      UPDATE fastag_vehicles
      SET status = 'pending', http_status = NULL, error_message = NULL, read_count = 0, fetched_at = NULL
      WHERE id IN (${marks})
    `, failedIds)
    await run(`
      UPDATE fastag_batches
      SET status = 'running', error_message = NULL, started_at = ?, finished_at = NULL
      WHERE id = ?
    `, [clock(), batchId])
    await recount(batchId)
    await logAction({
      userId: actor?.id,
      email: actor?.email,
      actionType: 'retry_started',
      itemType: 'fastag_batch',
      itemId: batchId,
      note: `Re-running ${failedIds.length} failed vehicle${failedIds.length === 1 ? '' : 's'}`,
    })
  } catch (error) {
    running.delete(batchId)
    throw error
  }
  void runRetry(batchId, failedIds, actor).finally(() => running.delete(batchId))
  return failedIds.length
}

export async function queueBatch(batchId: number, actor?: Actor) {
  if (running.has(batchId)) return false
  running.add(batchId)
  try {
    await run(`
      UPDATE fastag_batches
      SET status = 'running', error_message = NULL, started_at = ?, finished_at = NULL
      WHERE id = ?
    `, [clock(), batchId])
  } catch (error) {
    running.delete(batchId)
    throw error
  }
  void runBatch(batchId, actor).finally(() => running.delete(batchId))
  return true
}

export async function exportBatchExcel(id: number) {
  const detail = await getBatchDetail(id)
  if (!detail) return null
  const stamp = stampParts()
  const rows = detail.reads.map((row) => ({
    Vehicle: row.vehicle_reg_no,
    'Read time': row.reader_read_time || '',
    'Seq no': row.seq_no || '',
    Direction: row.lane_direction || '',
    'Toll plaza': row.toll_plaza_name || '',
    Geocode: row.toll_plaza_geocode || '',
    Type: row.vehicle_type || '',
    'Fetched at': row.fetched_at || row.created_at || '',
    'Exported at': stamp.label,
  }))
  const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{
    Vehicle: '',
    'Read time': '',
    'Seq no': '',
    Direction: '',
    'Toll plaza': '',
    Geocode: '',
    Type: '',
    'Fetched at': '',
    'Exported at': stamp.label,
  }])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Stored responses')
  const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return {
    filename: `fastag-responses-${stamp.file}.xlsx`,
    buffer,
  }
}

export function isBatchRunning(batchId: number) {
  return running.has(batchId)
}
