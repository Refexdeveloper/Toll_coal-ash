import * as XLSX from 'xlsx'
import { all, get, run } from '../db/index.js'
import { logAction } from './actionLog.js'
import { clock } from '../utils/clock.js'

const PLATE = /^(?:[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{1,4}|\d{2}BH\d{4}[A-Z]{1,2})$/
const INLINE = /[A-Z]{2}\s*-?\s*\d{1,2}\s*-?\s*[A-Z]{1,3}\s*-?\s*\d{1,4}|\d{2}\s*-?\s*BH\s*-?\s*\d{4}\s*-?\s*[A-Z]{1,2}/gi
const HEADER_HINT = /vehicle|reg(?:istration)?|number\s*plate|reg\.?\s*no|vrn|fastag|fleet|truck/i
const PROJECT_HINT = /project/i
const CHALLAN_HINT = /challan/i
const TRIP_HINT = /\btrip\b/i
const FROM_HINT = /^(from|source)$|\bfrom\s*(location|site|place|coord)/i
const TO_HINT = /^(to|destination)$|\bto\s*(location|site|place|coord)/i
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
  project_name: string | null
  challan_id: string | null
  trip_id: string | null
  from_location: string | null
  to_location: string | null
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
  project_name: string | null
  challan_id: string | null
  trip_id: string | null
  reader_read_time: string | null
  seq_no: string | null
  lane_direction: string | null
  toll_plaza_geocode: string | null
  toll_plaza_name: string | null
  vehicle_type: string | null
  created_at: string
  fetched_at: string | null
  run_id: number | null
  heading_towards?: string
  heading_code?: 'loading' | 'unloading' | 'unknown'
}

export type SheetVehicle = {
  vehicle_reg_no: string
  project_name: string | null
  challan_id: string | null
  trip_id: string | null
  from_location: string | null
  to_location: string | null
}

export type SheetRowError = {
  row: number
  vehicle_reg_no: string | null
  challan_id: string | null
  message: string
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

function cellText(value: unknown, max: number) {
  const text = String(value ?? '').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) : text
}

function columnIndex(header: string[], hint: RegExp) {
  return header.findIndex((cell) => hint.test(cell))
}

function rowIsHeader(row: (string | number | null)[]) {
  return row.some((cell) => {
    const text = String(cell ?? '')
    return HEADER_HINT.test(text) || CHALLAN_HINT.test(text) || PROJECT_HINT.test(text) || TRIP_HINT.test(text) || FROM_HINT.test(text) || TO_HINT.test(text)
  })
}

function rowIsBlank(row: (string | number | null)[]) {
  return row.every((cell) => !String(cell ?? '').trim())
}

export function extractSheetRows(buffer: Buffer): { rows: SheetVehicle[], errors: SheetRowError[], duplicates: SheetRowError[], totalRows: number } {
  const workbook = XLSX.read(buffer, { type: 'buffer', raw: false })
  const sheetName = workbook.SheetNames[0]
  if (!sheetName) return { rows: [], errors: [], duplicates: [], totalRows: 0 }
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  })
  if (!rows.length) return { rows: [], errors: [], duplicates: [], totalRows: 0 }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const header = rows[0].map((cell) => String(cell ?? ''))
  const hasHeader = rowIsHeader(rows[0])
  const hinted = hasHeader
    ? header.map((cell, index) => (HEADER_HINT.test(cell) ? index : -1)).filter((index) => index >= 0)
    : []
  const projectCol = hasHeader ? columnIndex(header, PROJECT_HINT) : -1
  const challanCol = hasHeader ? columnIndex(header, CHALLAN_HINT) : -1
  const tripCol = hasHeader ? columnIndex(header, TRIP_HINT) : -1
  const fromCol = hasHeader ? columnIndex(header, FROM_HINT) : -1
  const toCol = hasHeader ? columnIndex(header, TO_HINT) : -1

  const countPlates = (indexes: number[]) => {
    let count = 0
    rows.forEach((row, rowIndex) => {
      if (rowIndex === 0 && hasHeader) return
      if (rowIsBlank(row)) return
      for (const index of indexes) count += platesInText(row[index]).length
    })
    return count
  }

  let vehicleCols = hinted
  if (!vehicleCols.length || countPlates(vehicleCols) === 0) {
    const scores = Array.from({ length: width }, (_, index) => countPlates([index]))
    const best = scores.reduce((top, score, index) => (score > scores[top] ? index : top), 0)
    vehicleCols = scores[best] > 0 ? [best] : []
  }

  const seen = new Map<string, SheetVehicle>()
  const errors: SheetRowError[] = []
  const duplicates: SheetRowError[] = []
  let totalRows = 0

  rows.forEach((row, rowIndex) => {
    if (seen.size >= MAX_VEHICLES) return
    if (rowIndex === 0 && hasHeader) return
    if (rowIsBlank(row)) return
    totalRows += 1

    const excelRow = rowIndex + 1
    const vehicleText = vehicleCols.length
      ? cellText(vehicleCols.map((index) => row[index]).find((cell) => String(cell ?? '').trim()), 40)
      : null
    const plates = vehicleCols.length
      ? vehicleCols.flatMap((index) => platesInText(row[index]))
      : row.flatMap((cell) => platesInText(cell))
    const challanId = challanCol >= 0 ? cellText(row[challanCol], 100) : null
    const problems: string[] = []
    if (!plates.length) {
      problems.push(vehicleText ? `vehicle number "${vehicleText}" is not valid` : 'vehicle number is required')
    }
    if (!challanId) problems.push('challan ID is required')
    if (problems.length) {
      errors.push({
        row: excelRow,
        vehicle_reg_no: plates[0] || vehicleText,
        challan_id: challanId,
        message: `Row ${excelRow}: ${problems.join(' and ')}`,
      })
      return
    }

    const tripId = tripCol >= 0 ? cellText(row[tripCol], 100) : null
    const projectName = projectCol >= 0 ? cellText(row[projectCol], 191) : null
    const fromLocation = fromCol >= 0 ? cellText(row[fromCol], 191) : null
    const toLocation = toCol >= 0 ? cellText(row[toCol], 191) : null
    for (const plate of plates) {
      if (seen.size >= MAX_VEHICLES) return
      const key = `${plate}|${tripId || ''}|${challanId}`
      if (seen.has(key)) {
        duplicates.push({
          row: excelRow,
          vehicle_reg_no: plate,
          challan_id: challanId,
          message: `Row ${excelRow}: duplicate of ${plate} with challan ${challanId}`,
        })
        continue
      }
      seen.set(key, {
        vehicle_reg_no: plate,
        project_name: projectName,
        challan_id: challanId,
        trip_id: tripId,
        from_location: fromLocation,
        to_location: toLocation,
      })
    }
  })

  return { rows: [...seen.values()], errors, duplicates, totalRows }
}

export function extractPlates(buffer: Buffer): string[] {
  return [...new Set(extractSheetRows(buffer).rows.map((row) => row.vehicle_reg_no))]
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
export type FetchWindow = { from: string | null, to: string | null }

export function readFetchWindow(fromRaw: unknown, toRaw: unknown): FetchWindow {
  const from = dayText(fromRaw)
  const to = dayText(toRaw)
  if (from && to && from > to) throw new Error('The from date must be on or before the to date')
  return { from, to }
}

function dayText(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('Enter dates as YYYY-MM-DD')
  return text
}

const activeRun = new Map<number, { id: number, started_at: string }>()

const BATCH_COLS = `id, filename, source, uploaded_by, vehicle_count, ok_count, error_count, read_count,
  status, error_message, created_at, started_at, finished_at`
const VEHICLE_COLS = `id, batch_id, vehicle_reg_no, project_name, challan_id, trip_id, from_location, to_location, status, http_status, error_message, read_count, fetched_at`
const READ_COLS = `id, batch_id, vehicle_id, vehicle_reg_no, project_name, challan_id, trip_id, reader_read_time, seq_no, lane_direction,
  toll_plaza_geocode, toll_plaza_name, vehicle_type, created_at, fetched_at, run_id`
const READ_COLS_R = READ_COLS.split(',').map((column) => `r.${column.trim()}`).join(', ')

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

const CARDINAL: Record<string, number> = { N: 0, E: 90, S: 180, W: 270 }
const HEADING_LABEL = {
  loading: 'Towards Loading Point',
  unloading: 'Towards Unloading Point',
  unknown: 'Unknown / Unverified',
} as const

function parseCoord(value: string | null | undefined) {
  if (!value) return null
  const match = String(value).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function bearingDeg(from: { lat: number, lng: number }, to: { lat: number, lng: number }) {
  const lat1 = from.lat * Math.PI / 180
  const lat2 = to.lat * Math.PI / 180
  const dLng = (to.lng - from.lng) * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360
}

function angleDiff(left: number, right: number) {
  const delta = Math.abs(left - right) % 360
  return delta > 180 ? 360 - delta : delta
}

function distanceKm(a: { lat: number, lng: number }, b: { lat: number, lng: number }) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const lat1 = a.lat * rad
  const lat2 = b.lat * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

function siteKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function sitesMatch(leftRaw: string, rightRaw: string) {
  const left = leftRaw.trim().toLowerCase()
  const right = rightRaw.trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  const a = parseCoord(leftRaw)
  const b = parseCoord(rightRaw)
  if (a && b) return distanceKm(a, b) <= 2
  const compactLeft = siteKey(left)
  const compactRight = siteKey(right)
  if (compactLeft.length < 4 || compactRight.length < 4) return false
  return compactLeft.includes(compactRight) || compactRight.includes(compactLeft)
}

function plazaKey(name: string) {
  return name.toLowerCase().replace(/toll\s*plaza/g, '').replace(/[^a-z0-9]/g, '')
}

function plazasMatch(expected: string, actual: string) {
  const left = plazaKey(expected)
  const right = plazaKey(actual)
  if (!left || !right) return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 5 && longer.includes(shorter)
}

function readStamp(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return Number.isNaN(parsed) ? null : parsed
}

type RouteHeading = {
  route_id: number
  from_location: string
  to_location: string
  seq_order: number
  toll_plaza_name: string
  toll_plaza_geocode: string | null
}

function sequenceBearing(rows: RouteHeading[]) {
  const located = rows
    .map((row) => ({ ...row, point: parseCoord(row.toll_plaza_geocode) }))
    .filter((row): row is RouteHeading & { point: { lat: number, lng: number } } => !!row.point)
    .sort((a, b) => a.seq_order - b.seq_order || a.toll_plaza_name.localeCompare(b.toll_plaza_name))
  if (located.length < 2) return null
  const from = located[0].point
  const to = located[located.length - 1].point
  if (distanceKm(from, to) < 0.5) return null
  return bearingDeg(from, to)
}

function routePoints(rows: RouteHeading[]) {
  return rows
    .map((row) => parseCoord(row.toll_plaza_geocode))
    .filter((point): point is { lat: number, lng: number } => !!point)
}

const placeCache = new Map<string, { lat: number, lng: number } | null>()
let lastGeocodeAt = 0

function placeQuery(value: string) {
  return value
    .replace(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/g, ' ')
    .replace(/\b(ntpc|power\s*plant|thermal|project|site)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function placeRank(original: string, label: string) {
  if (!/\bntpc\b/i.test(original)) return 1
  const text = label.toLowerCase()
  if (/thermal|power station|power plant/.test(text)) return 0
  if (/mine/.test(text)) return 2
  return 1
}

async function geocodePlace(name: string, near: Array<{ lat: number, lng: number }>) {
  const query = placeQuery(name)
  const key = name.trim().toLowerCase()
  if (!key) return null
  if (placeCache.has(key)) return placeCache.get(key) || null
  const searches = query.toLowerCase() === name.trim().toLowerCase() ? [query] : [name.trim(), query]
  const box = near.length
    ? `&viewbox=${Math.min(...near.map((item) => item.lng)) - 1.5},${Math.max(...near.map((item) => item.lat)) + 1.5},${Math.max(...near.map((item) => item.lng)) + 1.5},${Math.min(...near.map((item) => item.lat)) - 1.5}`
    : ''
  let best: { lat: number, lng: number, km: number, rank: number } | null = null
  for (const search of searches) {
    try {
      const wait = 1100 - (Date.now() - lastGeocodeAt)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      lastGeocodeAt = Date.now()
      const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=in${box}&q=${encodeURIComponent(search)}`
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'RefexOne-Toll/1.0' },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) continue
      const found = await response.json() as Array<{ lat?: string, lon?: string, display_name?: string }>
      for (const row of found) {
        const point = { lat: Number(row.lat), lng: Number(row.lon) }
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue
        const km = near.length ? Math.min(...near.map((item) => distanceKm(point, item))) : 0
        if (near.length && km > 500) continue
        const rank = placeRank(name, String(row.display_name || ''))
        if (!best || rank < best.rank || (rank === best.rank && km < best.km)) best = { ...point, km, rank }
      }
      if (best && best.rank === 0) break
    } catch {
      /* The next name variant can still resolve. */
    }
  }
  const point = best ? { lat: best.lat, lng: best.lng } : null
  placeCache.set(key, point)
  return point
}

async function resolvePoint(primary: string, fallback: string, near: Array<{ lat: number, lng: number }>) {
  return parseCoord(primary) || parseCoord(fallback) || geocodePlace(primary || fallback, near)
}

async function attachHeadings(rows: FastagRead[]): Promise<FastagRead[]> {
  const unknown = (row: FastagRead): FastagRead => ({ ...row, heading_code: 'unknown', heading_towards: HEADING_LABEL.unknown })
  if (!rows.length) return rows
  const routeRows = await all<RouteHeading>(`
    SELECT r.id AS route_id, r.from_location, r.to_location,
      COALESCE(t.seq_order, 0) AS seq_order,
      COALESCE(t.toll_plaza_name, '') AS toll_plaza_name,
      t.toll_plaza_geocode
    FROM routes r
    LEFT JOIN route_tolls t ON t.route_id = r.id
    WHERE r.status = 'active'
    ORDER BY r.id, t.seq_order, t.id
  `)
  const routes = new Map<number, RouteHeading[]>()
  for (const row of routeRows) {
    const list = routes.get(row.route_id) || []
    list.push(row)
    routes.set(row.route_id, list)
  }
  const bearings = new Map<number, number | null>()
  for (const [id, list] of routes) bearings.set(id, sequenceBearing(list))

  const vehicleIds = [...new Set(rows.map((row) => row.vehicle_id).filter(Boolean))]
  const vehicleSites = new Map<number, { from_location: string | null, to_location: string | null }>()
  if (vehicleIds.length) {
    const marks = vehicleIds.map(() => '?').join(', ')
    const sites = await all<{ id: number, from_location: string | null, to_location: string | null }>(
      `SELECT id, from_location, to_location FROM fastag_vehicles WHERE id IN (${marks})`,
      vehicleIds,
    )
    for (const site of sites) vehicleSites.set(site.id, site)
  }
  const plates = [...new Set(rows.map((row) => row.vehicle_reg_no).filter(Boolean))]
  const plateSites = new Map<string, { from_location: string | null, to_location: string | null }>()
  if (plates.length) {
    const marks = plates.map(() => '?').join(', ')
    const latest = await all<{ vehicle_reg_no: string, from_location: string | null, to_location: string | null }>(
      `SELECT vehicle_reg_no, from_location, to_location
       FROM fastag_vehicles
       WHERE vehicle_reg_no IN (${marks})
         AND from_location IS NOT NULL AND from_location <> ''
         AND to_location IS NOT NULL AND to_location <> ''
       ORDER BY id DESC`,
      plates,
    )
    for (const site of latest) {
      if (!plateSites.has(site.vehicle_reg_no)) plateSites.set(site.vehicle_reg_no, site)
    }
  }

  const gpsByPlate = new Map<string, Array<{ lat: number, lng: number, at: number }>>()
  if (plates.length) {
    try {
      const marks = plates.map(() => '?').join(', ')
      const pings = await all<{ vno: string, lat: number, lon: number, gps_time: string }>(
        `SELECT vno, lat, lon, gps_time FROM gps_tracking WHERE vno IN (${marks}) ORDER BY gps_time`,
        plates,
      )
      for (const ping of pings) {
        const at = readStamp(ping.gps_time)
        if (at == null || !Number.isFinite(Number(ping.lat)) || !Number.isFinite(Number(ping.lon))) continue
        const list = gpsByPlate.get(ping.vno) || []
        list.push({ lat: Number(ping.lat), lng: Number(ping.lon), at })
        gpsByPlate.set(ping.vno, list)
      }
    } catch {
      gpsByPlate.clear()
    }
  }

  function chooseRoute(row: FastagRead) {
    const site = vehicleSites.get(row.vehicle_id)
    const fallback = plateSites.get(row.vehicle_reg_no)
    const from = String(site?.from_location || fallback?.from_location || '').trim()
    const to = String(site?.to_location || fallback?.to_location || '').trim()
    if (from && to) {
      const matched = [...routes.values()].filter((list) => {
        const routeFrom = list[0]?.from_location || ''
        const routeTo = list[0]?.to_location || ''
        return (sitesMatch(routeFrom, from) && sitesMatch(routeTo, to))
          || (sitesMatch(routeFrom, to) && sitesMatch(routeTo, from))
      })
      if (matched.length !== 1) return null
      const list = matched[0]
      const routeFrom = list[0]?.from_location || ''
      const routeTo = list[0]?.to_location || ''
      const reversed = !(sitesMatch(routeFrom, from) && sitesMatch(routeTo, to))
      return { list, from, to, reversed }
    }
    const byPlaza = [...routes.values()].filter((list) => list.some((toll) => plazasMatch(toll.toll_plaza_name, row.toll_plaza_name || '')))
    if (byPlaza.length !== 1) return null
    return {
      list: byPlaza[0],
      from: byPlaza[0][0]?.from_location || '',
      to: byPlaza[0][0]?.to_location || '',
      reversed: false,
    }
  }

  function gpsAgrees(row: FastagRead, cardinal: number) {
    const at = readStamp(row.reader_read_time)
    const pings = gpsByPlate.get(row.vehicle_reg_no) || []
    if (at == null || pings.length < 2) return true
    const windowMs = 2 * 60 * 60 * 1000
    const near = pings.filter((ping) => Math.abs(ping.at - at) <= windowMs)
    const before = near.filter((ping) => ping.at <= at).at(-1)
    const after = near.find((ping) => ping.at >= at)
    if (!before || !after || before === after) return true
    if (distanceKm(before, after) < 0.3) return true
    return angleDiff(bearingDeg(before, after), cardinal) <= 60
  }

  const ends = new Map<string, { from: { lat: number, lng: number } | null, to: { lat: number, lng: number } | null, forward: number | null }>()
  for (const row of rows) {
    const picked = chooseRoute(row)
    if (!picked) continue
    const routeFrom = picked.list[0]?.from_location || ''
    const routeTo = picked.list[0]?.to_location || ''
    const loadingText = picked.from || (picked.reversed ? routeTo : routeFrom)
    const unloadingText = picked.to || (picked.reversed ? routeFrom : routeTo)
    const key = `${picked.list[0]?.route_id}|${loadingText}|${unloadingText}`
    if (ends.has(key)) continue
    const near = routePoints(picked.list)
    const from = await resolvePoint(loadingText, picked.reversed ? routeTo : routeFrom, near)
    const to = await resolvePoint(unloadingText, picked.reversed ? routeFrom : routeTo, near)
    const endpointBearing = from && to && distanceKm(from, to) >= 0.5 ? bearingDeg(from, to) : null
    const alongPlazas = bearings.get(picked.list[0].route_id) ?? null
    let forward = endpointBearing
    if (forward != null && alongPlazas != null && angleDiff(forward, alongPlazas) >= 45) forward = null
    if (forward == null) forward = alongPlazas
    ends.set(key, { from, to, forward })
  }

  return rows.map((row) => {
    const cardinal = CARDINAL[String(row.lane_direction || '').trim().toUpperCase()]
    if (cardinal == null) return unknown(row)
    const picked = chooseRoute(row)
    if (!picked) return unknown(row)
    const routeFrom = picked.list[0]?.from_location || ''
    const routeTo = picked.list[0]?.to_location || ''
    const loadingText = picked.from || (picked.reversed ? routeTo : routeFrom)
    const unloadingText = picked.to || (picked.reversed ? routeFrom : routeTo)
    const end = ends.get(`${picked.list[0]?.route_id}|${loadingText}|${unloadingText}`)
    if (!end) return unknown(row)
    const plaza = parseCoord(row.toll_plaza_geocode)
    let towardLoading = false
    let towardUnloading = false
    if (plaza && end.from && angleDiff(cardinal, bearingDeg(plaza, end.from)) < 45) towardLoading = true
    if (plaza && end.to && angleDiff(cardinal, bearingDeg(plaza, end.to)) < 45) towardUnloading = true
    if (end.forward != null) {
      if (angleDiff(cardinal, end.forward) < 45) towardUnloading = true
      if (angleDiff(cardinal, (end.forward + 180) % 360) < 45) towardLoading = true
    }
    if (!towardLoading && !towardUnloading && plaza && end.from && end.to) {
      const toLoading = bearingDeg(plaza, end.from)
      const toUnloading = bearingDeg(plaza, end.to)
      if (angleDiff(toLoading, toUnloading) >= 45) {
        const opposite = (cardinal + 180) % 360
        const backToLoading = angleDiff(opposite, toLoading) < 45
        const backToUnloading = angleDiff(opposite, toUnloading) < 45
        if (backToLoading && !backToUnloading) towardUnloading = true
        if (backToUnloading && !backToLoading) towardLoading = true
      }
    }
    if (towardUnloading === towardLoading) return unknown(row)
    if (!gpsAgrees(row, cardinal)) return unknown(row)
    if (towardUnloading) return { ...row, heading_code: 'unloading' as const, heading_towards: HEADING_LABEL.unloading }
    return { ...row, heading_code: 'loading' as const, heading_towards: HEADING_LABEL.loading }
  })
}

export async function getBatchDetail(id: number) {
  const batch = await getBatch(id)
  if (!batch) return null
  const vehicles = await all<FastagVehicle>(
    `SELECT ${VEHICLE_COLS} FROM fastag_vehicles WHERE batch_id = ? ORDER BY id`,
    [id],
  )
  const reads = await all<FastagRead>(
    `SELECT ${READ_COLS_R} FROM fastag_reads r
     INNER JOIN (
       SELECT MAX(id) AS id
       FROM fastag_reads
       WHERE batch_id = ?
       GROUP BY vehicle_reg_no,
         CASE WHEN seq_no IS NOT NULL AND seq_no <> '' THEN seq_no ELSE CONCAT('row:', id) END
     ) picked ON picked.id = r.id
     ORDER BY (r.reader_read_time IS NULL), r.reader_read_time DESC, r.id DESC
     LIMIT ${READ_LIMIT}`,
    [id],
  )
  return { batch, vehicles, reads: await attachHeadings(reads) }
}

function likeTerm(raw: string) {
  return `%${String(raw || '').trim().replace(/[%_]/g, '')}%`
}

export async function listEnteredVehicles(filters: {
  vehicle?: string
  challan?: string
  project?: string
  date?: string
} = {}) {
  const vehicle = String(filters.vehicle || '').trim()
  const challan = String(filters.challan || '').trim()
  const project = String(filters.project || '').trim()
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(filters.date || '')) ? String(filters.date) : ''
  const readDate = date ? 'AND DATE(r.reader_read_time) = ?' : ''
  const entryDate = date
    ? `AND (
        DATE(v.fetched_at) = ?
        OR EXISTS (
          SELECT 1 FROM fastag_reads r
          WHERE r.vehicle_reg_no = v.vehicle_reg_no
            AND DATE(r.reader_read_time) = ?
            AND (IFNULL(v.challan_id, '') = '' OR IFNULL(r.challan_id, '') = v.challan_id)
            AND (IFNULL(v.project_name, '') = '' OR IFNULL(r.project_name, '') = v.project_name)
        )
      )`
    : ''
  const params: Array<string> = []
  if (date) params.push(date, date)
  params.push(vehicle, likeTerm(vehicle), challan, likeTerm(challan), project, likeTerm(project))
  if (date) params.push(date, date)
  return all<{
    vehicle_reg_no: string
    project_name: string | null
    challan_id: string | null
    from_location: string | null
    to_location: string | null
    fetched_at: string | null
    toll_count: number
    last_entry: string | null
  }>(`
    SELECT v.vehicle_reg_no, v.project_name, v.challan_id, v.from_location, v.to_location, v.fetched_at,
      (
        SELECT COUNT(*) FROM fastag_reads r
        WHERE r.vehicle_reg_no = v.vehicle_reg_no
          AND (IFNULL(v.challan_id, '') = '' OR IFNULL(r.challan_id, '') = v.challan_id)
          AND (IFNULL(v.project_name, '') = '' OR IFNULL(r.project_name, '') = v.project_name)
          ${readDate}
      ) AS toll_count,
      (
        SELECT MAX(r.reader_read_time) FROM fastag_reads r
        WHERE r.vehicle_reg_no = v.vehicle_reg_no
          AND (IFNULL(v.challan_id, '') = '' OR IFNULL(r.challan_id, '') = v.challan_id)
          AND (IFNULL(v.project_name, '') = '' OR IFNULL(r.project_name, '') = v.project_name)
          ${readDate}
      ) AS last_entry
    FROM fastag_vehicles v
    INNER JOIN (
      SELECT MAX(id) AS id
      FROM fastag_vehicles
      GROUP BY vehicle_reg_no, IFNULL(project_name, ''), IFNULL(challan_id, '')
    ) latest ON latest.id = v.id
    WHERE (? = '' OR v.vehicle_reg_no LIKE ?)
      AND (? = '' OR IFNULL(v.challan_id, '') LIKE ?)
      AND (? = '' OR IFNULL(v.project_name, '') LIKE ?)
      ${entryDate}
    ORDER BY (v.fetched_at IS NULL), v.fetched_at DESC, v.id DESC
    LIMIT 40
  `, params)
}

export async function searchStoredReads(raw: string) {
  const compact = String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (compact.length < 4) {
    throw new Error('Enter at least 4 characters of the vehicle number.')
  }
  const plate = normalizePlate(compact)
  const where = plate ? 'vehicle_reg_no = ?' : 'vehicle_reg_no LIKE ?'
  const param = plate || `%${compact}%`
  const rows = await all<FastagRead>(
    `SELECT ${READ_COLS_R} FROM fastag_reads r
     INNER JOIN (
       SELECT MAX(id) AS id
       FROM fastag_reads
       WHERE ${where}
       GROUP BY vehicle_reg_no,
         CASE WHEN seq_no IS NOT NULL AND seq_no <> '' THEN seq_no ELSE CONCAT('row:', id) END
     ) picked ON picked.id = r.id
     ORDER BY (r.reader_read_time IS NULL), r.reader_read_time DESC, r.id DESC
     LIMIT ${READ_LIMIT}`,
    [param],
  )
  return { vehicle: plate || compact, rows: await attachHeadings(rows) }
}

export async function createBatch(opts: {
  filename: string
  source: 'excel' | 'manual'
  uploadedBy: number | null
  plates?: string[]
  rows?: SheetVehicle[]
}) {
  const incoming = opts.rows?.length
    ? opts.rows
    : (opts.plates || []).map((plate) => ({
      vehicle_reg_no: plate,
      project_name: null,
      challan_id: null,
      trip_id: null,
      from_location: null,
      to_location: null,
    }))
  const rows: SheetVehicle[] = []
  const seen = new Set<string>()
  for (const row of incoming) {
    const plate = normalizePlate(row.vehicle_reg_no)
    if (!plate) continue
    const tripId = cellText(row.trip_id, 100)
    const challanId = cellText(row.challan_id, 100)
    const key = `${plate}|${tripId || ''}|${challanId || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({
      vehicle_reg_no: plate,
      project_name: cellText(row.project_name, 191),
      challan_id: challanId,
      trip_id: tripId,
      from_location: cellText(row.from_location, 191),
      to_location: cellText(row.to_location, 191),
    })
  }
  if (!rows.length) {
    throw new Error('No vehicle numbers found. Use values like CG13BF6032.')
  }
  if (rows.length > MAX_VEHICLES) {
    throw new Error(`A sheet can contain up to ${MAX_VEHICLES} vehicles.`)
  }
  const created = clock()
  const inserted = await run(`
    INSERT INTO fastag_batches
      (filename, source, uploaded_by, vehicle_count, ok_count, error_count, read_count, status, created_at)
    VALUES (?, ?, ?, ?, 0, 0, 0, 'ready', ?)
  `, [opts.filename.slice(0, 255), opts.source, opts.uploadedBy, rows.length, created])
  const batchId = inserted.insertId
  for (const row of rows) {
    await run(`
      INSERT INTO fastag_vehicles (batch_id, vehicle_reg_no, project_name, challan_id, trip_id, from_location, to_location, status, read_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0)
    `, [batchId, row.vehicle_reg_no, row.project_name, row.challan_id, row.trip_id, row.from_location, row.to_location])
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

async function addReads(batchId: number, vehicle: FastagVehicle, records: Record<string, unknown>[]) {
  let stored = 0
  const current = activeRun.get(batchId)
  const fetchedAt = current?.started_at || clock()
  for (const record of records) {
    const seq = clip(pick(record, 'seqNo', 'seq_no', 'seq', 'sequenceNo'), 128)
    const createdAt = clock()
    await run(`
      INSERT INTO fastag_reads (
        batch_id, vehicle_id, run_id, vehicle_reg_no, project_name, challan_id, trip_id,
        reader_read_time, seq_no, lane_direction,
        toll_plaza_geocode, toll_plaza_name, vehicle_type, raw_json, created_at, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
      ON DUPLICATE KEY UPDATE
        batch_id = VALUES(batch_id),
        vehicle_id = VALUES(vehicle_id),
        run_id = VALUES(run_id),
        vehicle_reg_no = VALUES(vehicle_reg_no),
        project_name = VALUES(project_name),
        challan_id = VALUES(challan_id),
        trip_id = VALUES(trip_id),
        reader_read_time = VALUES(reader_read_time),
        lane_direction = COALESCE(VALUES(lane_direction), lane_direction),
        toll_plaza_geocode = VALUES(toll_plaza_geocode),
        toll_plaza_name = VALUES(toll_plaza_name),
        vehicle_type = VALUES(vehicle_type),
        raw_json = VALUES(raw_json),
        fetched_at = VALUES(fetched_at)
    `, [
      batchId,
      vehicle.id,
      current?.id ?? null,
      vehicle.vehicle_reg_no,
      clip(vehicle.project_name, 191),
      clip(vehicle.challan_id, 100),
      clip(vehicle.trip_id, 100),
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

function readInWindow(record: Record<string, unknown>, window?: FetchWindow) {
  if (!window?.from && !window?.to) return true
  const raw = String(pick(record, 'readerReadTime', 'reader_read_time', 'readTime', 'read_time') || '')
  const match = raw.match(/\d{4}-\d{2}-\d{2}/)
  const day = match ? match[0] : ''
  if (window.from && (!day || day < window.from)) return false
  if (window.to && (!day || day > window.to)) return false
  return true
}

async function fetchOne(batchId: number, vehicle: FastagVehicle, window?: FetchWindow) {
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
    const dated = window?.from || window?.to
    if (dated) records = records.filter((record) => readInWindow(record, window))
    if (!records.length) {
      await markVehicle(vehicle.id, {
        status: 'empty',
        http_status: result.httpStatus,
        error_message: dated ? 'No toll reads in this date range' : 'No toll reads returned',
        read_count: 0,
        fetched_at: stamp,
      })
      await recount(batchId)
      return
    }

    const stored = await addReads(batchId, vehicle, records)
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

export async function runBatch(batchId: number, actor?: Actor, window?: FetchWindow) {
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
      await fetchOne(batchId, vehicle, window)
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

export type ExportFilters = {
  q?: string
  project?: string
  plaza?: string
  from?: string
  to?: string
  fromTime?: string
  toTime?: string
  vehicles?: string
  heading?: string
}

function matchesExport(row: FastagRead, filters: ExportFilters) {
  const q = String(filters.q || '').trim().toUpperCase()
  if (q) {
    const haystack = [row.vehicle_reg_no, row.project_name, row.challan_id, row.trip_id, row.toll_plaza_name, row.vehicle_type]
      .join(' ')
      .toUpperCase()
    if (!haystack.includes(q)) return false
  }
  if (filters.project && (row.project_name || '') !== filters.project) return false
  if (filters.plaza && !(row.toll_plaza_name || '').toLowerCase().includes(String(filters.plaza).toLowerCase())) return false
  const rawTime = String(row.reader_read_time || '').trim()
  const day = rawTime.slice(0, 10)
  const at = rawTime ? Date.parse(rawTime.includes('T') ? rawTime : rawTime.replace(' ', 'T')) : Number.NaN
  const fromTime = String(filters.fromTime || '').trim()
  const toTime = String(filters.toTime || '').trim()
  if (filters.from) {
    if (fromTime) {
      const from = Date.parse(`${filters.from}T${fromTime.length === 5 ? `${fromTime}:00` : fromTime}`)
      if (!Number.isFinite(at) || at < from) return false
    } else if (!day || day < filters.from) return false
  }
  if (filters.to) {
    if (toTime) {
      const clock = toTime.length === 5 ? `${toTime}:59` : toTime
      const to = Date.parse(`${filters.to}T${clock}`)
      if (!Number.isFinite(at) || at > to) return false
    } else if (!day || day > filters.to) return false
  }
  const plates = String(filters.vehicles || '').split(',').map((item) => item.trim()).filter(Boolean)
  if (plates.length && !plates.includes(row.vehicle_reg_no)) return false
  const heading = String(filters.heading || '').trim()
  if (heading && (row.heading_code || 'unknown') !== heading) return false
  return true
}

export function rejectedRowsWorkbook(rows: SheetRowError[]) {
  const stamp = stampParts()
  const sheet = XLSX.utils.json_to_sheet(rows.length ? rows.map((row) => ({
    Row: row.row,
    Vehicle: row.vehicle_reg_no || '',
    'Challan ID': row.challan_id || '',
    Error: row.message,
  })) : [{ Row: '', Vehicle: '', 'Challan ID': '', Error: '' }])
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Rejected rows')
  return {
    filename: `fastag-rejected-${stamp.file}.xlsx`,
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  }
}

export async function exportBatchExcel(id: number, filters: ExportFilters = {}, includeDirection = false) {
  const detail = await getBatchDetail(id)
  if (!detail) return null
  const stamp = stampParts()
  const filtered = detail.reads.filter((row) => matchesExport(row, filters))
  const rows = filtered.map((row) => ({
    Vehicle: row.vehicle_reg_no,
    Project: row.project_name || '',
    'Challan ID': row.challan_id || '',
    'Trip ID': row.trip_id || '',
    'Toll entry time': row.reader_read_time || '',
    ...(includeDirection ? { Direction: row.lane_direction || '' } : {}),
    'Heading Towards': row.heading_towards || 'Unknown / Unverified',
    'Toll plaza': row.toll_plaza_name || '',
    Geocode: row.toll_plaza_geocode || '',
    Type: row.vehicle_type || '',
    'Fetched at': row.fetched_at || row.created_at || '',
    'Exported at': stamp.label,
  }))
  const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{
    Vehicle: '',
    Project: '',
    'Challan ID': '',
    'Trip ID': '',
    'Toll entry time': '',
    Direction: '',
    'Heading Towards': '',
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
    filtered: Boolean(filters.q || filters.project || filters.plaza || filters.from || filters.to || filters.vehicles || filters.heading),
    count: filtered.length,
  }
}

export async function exportReadsByIds(rawIds: number[], includeDirection = false) {
  const ids = [...new Set(rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))]
  if (!ids.length) return null
  const marks = ids.map(() => '?').join(', ')
  const reads = await all<FastagRead>(`SELECT ${READ_COLS} FROM fastag_reads WHERE id IN (${marks})`, ids)
  if (!reads.length) return null
  const headed = await attachHeadings(reads)
  const order = new Map(ids.map((id, index) => [id, index]))
  headed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const stamp = stampParts()
  const rows = headed.map((row) => ({
    Vehicle: row.vehicle_reg_no,
    Project: row.project_name || '',
    'Challan ID': row.challan_id || '',
    'Trip ID': row.trip_id || '',
    'Toll entry time': row.reader_read_time || '',
    ...(includeDirection ? { Direction: row.lane_direction || '' } : {}),
    'Heading Towards': row.heading_towards || 'Unknown / Unverified',
    'Toll plaza': row.toll_plaza_name || '',
    Geocode: row.toll_plaza_geocode || '',
    Type: row.vehicle_type || '',
    'Fetched at': row.fetched_at || row.created_at || '',
    'Exported at': stamp.label,
  }))
  const sheet = XLSX.utils.json_to_sheet(rows)
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Selected tolls')
  return {
    filename: `fastag-selected-${stamp.file}.xlsx`,
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
    count: rows.length,
  }
}

export function isBatchRunning(batchId: number) {
  return running.has(batchId)
}
