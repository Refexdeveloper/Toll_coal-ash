import { Router } from 'express'
import * as XLSX from 'xlsx'
import { all, get, run, now } from '../db/index.js'
import { okItem, fail } from '../utils/response.js'
import { can } from '../middleware/auth.js'
import { logAction } from '../services/actionLog.js'
import { clock } from '../utils/clock.js'
import { syncLiveFleet, fetchAndSaveVehicle, parseGpsTime } from '../services/gps.js'
import { collectionStatus } from '../services/gpsScheduler.js'
import { routeWindow, summarizeRoute, validCoordinate } from '../services/gpsRoute.js'

const router = Router()
router.use(can('gps'))

router.post('/export', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0))]
  if (!ids.length) return fail(res, 'Select at least one GPS record')
  const marks = ids.map(() => '?').join(', ')
  const rows = await all<{
    vno: string
    gps_time: string
    lat: number
    lon: number
    spd: number
    crs: number
    ign: number
    fuel: string
    vid: number | null
    recorded_at: string
  }>(`
    SELECT vno, gps_time, lat, lon, spd, crs, ign, fuel, vid, recorded_at
    FROM gps_tracking WHERE id IN (${marks}) ORDER BY gps_time DESC
  `, ids)
  if (!rows.length) return fail(res, 'Select at least one GPS record')
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    Vehicle: row.vno,
    'GPS time': row.gps_time,
    Latitude: row.lat,
    Longitude: row.lon,
    'Speed km/h': row.spd,
    Course: row.crs,
    Ignition: row.ign ? 'ON' : 'OFF',
    Fuel: row.fuel || '',
    VID: row.vid ?? '',
    'Stored at': row.recorded_at,
  })))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'GPS records')
  const filename = `gps-${clock().replace(/[: ]/g, '-')}.xlsx`
  await logAction({ userId: req.user?.id, email: req.user?.email, actionType: 'export', itemType: 'gps', itemId: 'selected', note: `Exported ${rows.length} GPS records to ${filename}` })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  return res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
})

/** POST /api/v1/gps/sync
 *  Synchronizes live GPS fleet telemetry from https://customer.ktt.io/refex/list
 *  and stores into MySQL gps_tracking.
 */
router.all('/sync', async (_req, res) => {
  try {
    const result = await syncLiveFleet()
    return okItem(res, result)
  } catch (e: any) {
    console.error('[gps] /sync error:', e)
    return fail(res, e.message || 'GPS sync failed', 500)
  }
})

/** POST /api/v1/gps/save
 *  Explicitly saves the current live reading or manual reading of a vehicle into the database.
 */
router.post('/save', async (req, res) => {
  try {
    const vno = String(req.body.vno || '').trim().toUpperCase()
    if (!vno) return fail(res, 'vno is required', 400)

    // If manual coordinates provided:
    if (req.body.lat != null && req.body.lon != null) {
      const vid = req.body.vid != null ? Number(req.body.vid) : null
      const lat = Number(req.body.lat)
      const lon = Number(req.body.lon)
      const spd = req.body.spd != null ? Number(req.body.spd) : 0
      const crs = req.body.crs != null ? Number(req.body.crs) : 0
      const ign = req.body.ign ? 1 : 0
      const fuel = String(req.body.fuel ?? 'unknown')
      const gpsTime = parseGpsTime(req.body.time || req.body.gps_time)
      const recordedAt = now()

      const ins = await run(
        `INSERT INTO gps_tracking (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vid, vno, lat, lon, spd, crs, ign, fuel, gpsTime, recordedAt],
      )
      const row = await get<any>(`SELECT * FROM gps_tracking WHERE id = ?`, [ins.insertId])
      return okItem(res, { saved: true, vno, data: row })
    }

    // Otherwise fetch from live API and save:
    const result = await fetchAndSaveVehicle(vno)
    return okItem(res, result)
  } catch (e: any) {
    console.error('[gps] /save error:', e)
    return fail(res, e.message || 'Save failed', 500)
  }
})

/** POST /api/v1/gps/ping
 *  Accept a live GPS payload and store it.
 *  Body: single object { vid?, vno, lat, lon, spd, crs, ign, fuel, time } OR array of such objects
 */
router.post('/ping', async (req, res) => {
  try {
    let list: any[] = []
    if (Array.isArray(req.body)) {
      list = req.body
    } else if (req.body && Array.isArray(req.body.data)) {
      list = req.body.data
    } else if (req.body && Array.isArray(req.body.results)) {
      list = req.body.results
    } else if (req.body && typeof req.body === 'object') {
      list = [req.body]
    }

    if (!list.length) {
      return fail(res, 'No GPS ping data provided', 400)
    }

    const inserted: any[] = []
    const recordedAt = now()

    for (const item of list) {
      const vno = String(item.vno || item.vehicle_no || item.vehicle_number || '').trim().toUpperCase()
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

      const result = await run(
        `INSERT INTO gps_tracking (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vid, vno, lat, lon, spd, crs, ign, fuel, gpsTime, recordedAt],
      )
      inserted.push({ id: result.insertId, vno, lat, lon, spd, crs, ign, fuel, time: gpsTime })
    }

    return okItem(res, {
      stored_count: inserted.length,
      pings: inserted,
    })
  } catch (e: any) {
    console.error('[gps] ping error:', e)
    return fail(res, e.message || 'Server error', 500)
  }
})

/** GET /api/v1/gps/live?vno=CG04NU2465&save=1
 *  Returns the most recent ping for a vehicle.
 *  If save=1 (or default when queried with save), it queries the live API
 *  and inserts a new record into gps_tracking so every search is saved.
 */
router.get('/live', async (req, res) => {
  try {
    const vno = String(req.query.vno || '').toUpperCase().trim()
    if (!vno) return fail(res, 'vno is required', 400)

    const shouldSave = req.query.save !== '0' && req.query.save !== 'false'

    if (shouldSave) {
      const syncResult = await fetchAndSaveVehicle(vno)
      if (syncResult.found) {
        return okItem(res, syncResult)
      }
    }

    const row = await get<any>(
      `SELECT * FROM gps_tracking WHERE vno = ? ORDER BY id DESC LIMIT 1`,
      [vno],
    )

    if (!row) return okItem(res, { found: false, saved: false, vno, data: null })
    return okItem(res, { found: true, saved: false, vno, data: row })
  } catch (e: any) {
    return fail(res, e.message || 'Server error', 500)
  }
})

function dayParam(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  return text
}

function clockParam(value: unknown) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return null
  return text.length === 5 ? text : text.slice(0, 8)
}

/** GET /api/v1/gps/collection-status
 *  Read-only status for the automatic history job. Settings are changed by an administrator.
 */
router.get('/collection-status', async (_req, res) => {
  try {
    const status = await collectionStatus()
    return okItem(res, {
      enabled: status.enabled,
      interval_minutes: status.interval_minutes,
      last_success_at: status.last_success_at,
      last_run: status.last_run,
    })
  } catch (e: any) {
    return fail(res, e.message || 'Server error', 500)
  }
})

/** GET /api/v1/gps/route?vno=CG04NU2465&date=2026-10-15&fromTime=08:00&toTime=18:00
 *  Stored points for one vehicle and day, oldest GPS time first.
 */
router.get('/route', async (req, res) => {
  try {
    const vno = String(req.query.vno || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (vno.length < 4 || vno.length > 30) return fail(res, 'Enter a vehicle number', 400)
    const fromDate = dayParam(req.query.from || req.query.date)
    const toDate = dayParam(req.query.to)
    const fromTime = clockParam(req.query.fromTime)
    const toTime = clockParam(req.query.toTime)
    if (fromDate == null || toDate == null || fromTime == null || toTime == null) {
      return fail(res, 'Enter dates as YYYY-MM-DD and times as HH:MM', 400)
    }
    const startDay = fromDate || toDate
    const endDay = toDate || fromDate
    if (!startDay) return fail(res, 'Enter a from date and a to date', 400)
    let window
    try {
      window = routeWindow(startDay, endDay, fromTime, toTime)
    } catch (error) {
      return fail(res, error instanceof Error ? error.message : 'Enter a valid time range', 400)
    }
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '2000'), 10) || 2000, 1), 5000)
    const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0)
    const bounds = [vno, window.start, window.end]
    const totalRow = await get<{ total: number }>(
      `SELECT COUNT(*) AS total
       FROM gps_tracking
       WHERE vno = ? AND gps_time >= ? AND gps_time <= ?
         AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180`,
      bounds,
    )
    const rows = await all<{
      id: number
      vid: number | null
      vno: string
      lat: number
      lon: number
      spd: number
      crs: number
      ign: number
      fuel: string
      gps_time: string
      recorded_at: string
    }>(
      `SELECT id, vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at
       FROM gps_tracking
       WHERE vno = ? AND gps_time >= ? AND gps_time <= ?
         AND lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180
       ORDER BY gps_time ASC, id ASC
       LIMIT ? OFFSET ?`,
      [...bounds, limit, offset],
    )
    const points = rows
      .map((row) => ({
        ...row,
        lat: Number(row.lat),
        lon: Number(row.lon),
        spd: Number(row.spd),
        crs: Number(row.crs),
        ign: Number(row.ign) ? 1 : 0,
      }))
      .filter((row) => validCoordinate(row.lat, row.lon))
    const total = Number(totalRow?.total || 0)
    return okItem(res, {
      vno,
      from_date: startDay,
      to_date: endDay,
      from: window.start,
      to: window.end,
      total,
      limit,
      offset,
      truncated: offset + points.length < total,
      summary: summarizeRoute(points),
      points,
    })
  } catch (e: any) {
    return fail(res, e.message || 'Server error', 500)
  }
})

/** GET /api/v1/gps/history?vno=CG04NU2465&from=2026-09-01&to=2026-09-30&limit=500
 *  Returns historical pings. Vehicle and dates are optional filters.
 */
router.get('/history', async (req, res) => {
  try {
    const vno = String(req.query.vno || '').toUpperCase().trim()
    const from = dayParam(req.query.from)
    const to = dayParam(req.query.to)
    const fromTime = clockParam(req.query.fromTime)
    const toTime = clockParam(req.query.toTime)
    if (from == null || to == null || fromTime == null || toTime == null) {
      return fail(res, 'Enter dates as YYYY-MM-DD and times as HH:MM', 400)
    }
    const limit = Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000)

    const params: any[] = []
    let whereSql = 'WHERE 1 = 1'
    if (vno) {
      whereSql += ' AND vno = ?'
      params.push(vno)
    }
    if (from && fromTime) {
      whereSql += ' AND gps_time >= ?'
      params.push(`${from} ${fromTime.length === 5 ? `${fromTime}:00` : fromTime}`)
    } else if (from) {
      whereSql += ' AND gps_time >= ?'
      params.push(from)
    }
    if (to && toTime) {
      whereSql += ' AND gps_time <= ?'
      params.push(`${to} ${toTime.length === 5 ? `${toTime}:59` : toTime}`)
    } else if (to) {
      whereSql += ' AND gps_time < DATE_ADD(?, INTERVAL 1 DAY)'
      params.push(to)
    }

    params.push(limit)

    const rows = await all<any>(
      `SELECT * FROM gps_tracking
       ${whereSql}
       ORDER BY id DESC
       LIMIT ?`,
      params,
    )
    return okItem(res, { vno, count: rows.length, rows })
  } catch (e: any) {
    return fail(res, e.message || 'Server error', 500)
  }
})

/** GET /api/v1/gps/vehicles
 *  Returns a distinct list of all vehicle numbers that have GPS data.
 */
router.get('/vehicles', async (_req, res) => {
  try {
    const rows = await all<{ vno: string; last_seen: string; last_lat: number; last_lon: number; last_spd: number; last_ign: number; last_fuel: string }>(
      `SELECT g.vno,
              g.gps_time AS last_seen,
              g.lat AS last_lat,
              g.lon AS last_lon,
              g.spd AS last_spd,
              g.ign AS last_ign,
              g.fuel AS last_fuel
       FROM gps_tracking g
       INNER JOIN (
         SELECT MAX(id) AS id
         FROM gps_tracking
         WHERE vno IS NOT NULL AND vno <> ''
         GROUP BY vno
       ) latest ON latest.id = g.id
       ORDER BY g.vno ASC
       LIMIT 500`,
    )
    return okItem(res, { count: rows.length, vehicles: rows })
  } catch (e: any) {
    return fail(res, e.message || 'Server error', 500)
  }
})

export default router
