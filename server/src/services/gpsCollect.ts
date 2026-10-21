import { run, now } from '../db/index.js'
import { fetchFleetList, parseGpsTime, type GpsPingRaw } from './gps.js'

const MOVING_TRUE = new Set(['1', 'true', 'yes', 'moving', 'running', 'run', 'on'])
const MOVING_FALSE = new Set(['0', 'false', 'no', 'stopped', 'stop', 'idle', 'parked', 'off', 'stationary', 'halt'])

export type CollectionSettings = {
  enabled: boolean
  intervalMinutes: number
  speedThreshold: number
}

export function collectionIsDue(input: {
  enabled: boolean
  intervalMinutes: number
  lastStartedAt: string | null
  lastStatus: string | null
  now?: Date
}) {
  if (!input.enabled) return false
  const interval = Math.max(1, input.intervalMinutes) * 60 * 1000
  if (!input.lastStartedAt) return true
  const started = stampMs(input.lastStartedAt)
  if (started == null) return true
  const age = (input.now?.getTime() ?? Date.now()) - started
  if (input.lastStatus === 'running' && age < 20 * 60 * 1000) return false
  return age >= interval
}

export function isMoving(item: Record<string, unknown>, speedThreshold: number) {
  const flagged = movementFlag(item)
  if (flagged != null) return flagged
  const speed = Number(item.spd ?? item.speed)
  if (!Number.isFinite(speed)) return false
  return speed >= speedThreshold
}

export function autoSnapshotKey(vno: string, gpsTime: string, hadApiTime: boolean, lat: number, lon: number) {
  if (hadApiTime) return `${vno}|${gpsTime}`.slice(0, 96)
  return `${vno}|${lat.toFixed(5)}|${lon.toFixed(5)}|${gpsTime.slice(0, 13)}`.slice(0, 96)
}

export async function collectMovingSnapshots(speedThreshold: number, timeoutMs = 30000) {
  const fleet = await fetchFleetList(timeoutMs)
  const recordedAt = now()
  let moving = 0
  let inserted = 0
  let duplicates = 0
  for (const item of fleet) {
    const saved = await saveMovingSnapshot(item, speedThreshold, recordedAt)
    if (saved === 'ignore' || saved === 'still') continue
    moving += 1
    if (saved === 'inserted') inserted += 1
    if (saved === 'duplicate') duplicates += 1
  }
  return {
    vehicles_seen: fleet.length,
    moving,
    inserted,
    duplicates,
  }
}

async function saveMovingSnapshot(item: GpsPingRaw, speedThreshold: number, recordedAt: string) {
  const vno = String(item.vno || '').trim().toUpperCase()
  if (!vno) return 'ignore'
  const lat = item.lat != null ? Number(item.lat) : Number.NaN
  const lon = item.lon != null ? Number(item.lon) : Number.NaN
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'ignore'
  if (!isMoving(item as unknown as Record<string, unknown>, speedThreshold)) return 'still'
  const apiTime = item.time || item.gps_time
  const gpsTime = parseGpsTime(apiTime)
  const key = autoSnapshotKey(vno, gpsTime, Boolean(apiTime), lat, lon)
  const inserted = await run(
    `INSERT IGNORE INTO gps_tracking
      (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at, source, auto_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?)`,
    [
      item.vid != null ? Number(item.vid) : null,
      vno,
      lat,
      lon,
      item.spd != null ? Number(item.spd) : 0,
      item.crs != null ? Number(item.crs) : 0,
      item.ign ? 1 : 0,
      String(item.fuel ?? 'unknown'),
      gpsTime,
      recordedAt,
      key,
    ],
  )
  return inserted.affectedRows > 0 ? 'inserted' : 'duplicate'
}

function movementFlag(item: Record<string, unknown>) {
  for (const key of ['moving', 'isMoving', 'is_moving', 'motion']) {
    const parsed = parseFlag(item[key])
    if (parsed != null) return parsed
  }
  for (const key of ['movement', 'status', 'vehStatus', 'vehicleStatus']) {
    const parsed = parseFlag(item[key])
    if (parsed != null) return parsed
  }
  return null
}

function parseFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (value == null) return null
  const text = String(value).trim().toLowerCase()
  if (!text) return null
  if (MOVING_TRUE.has(text)) return true
  if (MOVING_FALSE.has(text)) return false
  return null
}

function stampMs(value: string) {
  const text = value.includes('T') ? value : value.replace(' ', 'T')
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`
  const at = Date.parse(withZone)
  return Number.isFinite(at) ? at : null
}
