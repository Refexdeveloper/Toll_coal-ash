import { all, get, run, now } from '../db/index.js'

const GPS_API_URL = process.env.GPS_API_URL || 'https://customer.ktt.io/refex/list'
const GPS_ACCESS_TOKEN = process.env.GPS_ACCESS_TOKEN || 'FAmAuHiWKxCZJeBufUUhLoJjFobSyfscvqXUphi'

export interface GpsPingRaw {
  vid?: number
  vno: string
  lat: number
  lon: number
  spd?: number
  crs?: number
  ign?: number
  fuel?: string
  time?: string
  gps_time?: string
}

export function parseGpsTime(t: any): string {
  if (!t) return now()
  const s = String(t).trim()
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    return s.slice(0, 19).replace('T', ' ')
  }
  try {
    const d = new Date(s)
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 19).replace('T', ' ')
    }
  } catch { /* fallback */ }
  return now()
}

/** Fetches a specific vehicle directly from the live GPS API,
 *  AND saves a new record into `gps_tracking` so it is permanently logged.
 */
export async function fetchAndSaveVehicle(targetVno: string): Promise<{
  found: boolean
  saved: boolean
  data: any
}> {
  const vno = targetVno.trim().toUpperCase()
  const url = process.env.GPS_API_URL || GPS_API_URL
  const token = process.env.GPS_ACCESS_TOKEN || GPS_ACCESS_TOKEN

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-AT-AccessToken': token,
      },
    })

    if (res.ok) {
      const payload: any = await res.json()
      const list: GpsPingRaw[] = Array.isArray(payload.results)
        ? payload.results
        : Array.isArray(payload)
          ? payload
          : []

      const match = list.find((item) => String(item.vno || '').trim().toUpperCase() === vno)
      if (match && match.lat != null && match.lon != null) {
        const recordedAt = now()
        const vid = match.vid != null ? Number(match.vid) : null
        const lat = Number(match.lat)
        const lon = Number(match.lon)
        const spd = match.spd != null ? Number(match.spd) : 0
        const crs = match.crs != null ? Number(match.crs) : 0
        const ign = match.ign ? 1 : 0
        const fuel = String(match.fuel ?? 'unknown')
        const gpsTime = parseGpsTime(match.time || match.gps_time)

        // Save new record into gps_tracking
        const insertRes = await run(
          `INSERT INTO gps_tracking (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [vid, vno, lat, lon, spd, crs, ign, fuel, gpsTime, recordedAt],
        )

        const savedRow = await get<any>(`SELECT * FROM gps_tracking WHERE id = ?`, [insertRes.insertId])
        return { found: true, saved: true, data: savedRow }
      }
    }
  } catch (err: any) {
    console.error(`[gps] fetchAndSaveVehicle for ${vno} error:`, err.message)
  }

  // Fallback to latest stored row in DB
  const existing = await get<any>(
    `SELECT * FROM gps_tracking WHERE vno = ? ORDER BY id DESC LIMIT 1`,
    [vno],
  )
  if (existing) {
    return { found: true, saved: false, data: existing }
  }
  return { found: false, saved: false, data: null }
}

/** Fetches the latest live vehicle positions for the entire fleet from ktt.io
 *  and saves them into MySQL `gps_tracking`.
 */
export async function syncLiveFleet(): Promise<{
  success: boolean
  total_vehicles: number
  inserted: number
  vehicles: GpsPingRaw[]
}> {
  try {
    const url = process.env.GPS_API_URL || GPS_API_URL
    const token = process.env.GPS_ACCESS_TOKEN || GPS_ACCESS_TOKEN

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-AT-AccessToken': token,
      },
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      throw new Error(`GPS API error ${res.status}: ${txt || res.statusText}`)
    }

    const data: any = await res.json()
    const results: GpsPingRaw[] = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data)
        ? data
        : []

    if (!results.length) {
      return { success: true, total_vehicles: 0, inserted: 0, vehicles: [] }
    }

    const recordedAt = now()
    let inserted = 0

    for (const item of results) {
      const vno = String(item.vno || '').trim().toUpperCase()
      if (!vno) continue

      const lat = item.lat != null ? Number(item.lat) : null
      const lon = item.lon != null ? Number(item.lon) : null
      if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) continue

      const vid = item.vid != null ? Number(item.vid) : null
      const spd = item.spd != null ? Number(item.spd) : 0
      const crs = item.crs != null ? Number(item.crs) : 0
      const ign = item.ign ? 1 : 0
      const fuel = String(item.fuel ?? 'unknown')
      const gpsTime = parseGpsTime(item.time || item.gps_time)

      await run(
        `INSERT INTO gps_tracking (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vid, vno, lat, lon, spd, crs, ign, fuel, gpsTime, recordedAt],
      )
      inserted++
    }

    return {
      success: true,
      total_vehicles: results.length,
      inserted,
      vehicles: results,
    }
  } catch (err: any) {
    console.error('[gps] syncLiveFleet failed:', err.message)
    throw err
  }
}
