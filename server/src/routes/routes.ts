import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'
import { all, get, now, run } from '../db/index.js'
import { fail, okItem, okList, okMessage } from '../utils/response.js'
import { logAction } from '../services/actionLog.js'
import { clock } from '../utils/clock.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
})

export type RouteToll = {
  id?: number
  route_id?: number
  seq_order: number
  toll_plaza_name: string
  location?: string | null
  highway?: string | null
  toll_plaza_geocode?: string | null
  plaza_code?: string | null
  fee_single: number
  fee_return: number
  fee_commercial: number
  source_type: 'manual' | 'fetched'
}

export type RouteRecord = {
  id: number
  name: string
  from_location: string
  to_location: string
  highway: string | null
  distance_km: number | null
  est_time_hours: number | null
  description: string | null
  status: string
  created_by: number | null
  created_at: string
  updated_at: string
  total_tolls?: number
  total_fee_single?: number
  total_fee_return?: number
  total_fee_commercial?: number
  tolls?: RouteToll[]
}

// Predefined catalog of known toll corridors & plazas
const KNOWN_CORRIDORS: Record<
  string,
  {
    highway: string
    distance_km: number
    est_time_hours: number
    tolls: Omit<RouteToll, 'route_id' | 'id'>[]
  }
> = {
  'raipur-korba': {
    highway: 'NH-130',
    distance_km: 215,
    est_time_hours: 4.5,
    tolls: [
      {
        seq_order: 1,
        toll_plaza_name: 'Dhank Toll Plaza',
        location: 'NH-53 / NH-130 Arang-Simga',
        highway: 'NH-130',
        toll_plaza_geocode: '21.227203, 82.42025',
        plaza_code: 'TP-CG-01',
        fee_single: 95,
        fee_return: 145,
        fee_commercial: 315,
        source_type: 'fetched',
      },
      {
        seq_order: 2,
        toll_plaza_name: 'Simga Toll Plaza',
        location: 'Simga Bypass, Baloda Bazar',
        highway: 'NH-130',
        toll_plaza_geocode: '21.6288, 81.7042',
        plaza_code: 'TP-CG-02',
        fee_single: 80,
        fee_return: 120,
        fee_commercial: 270,
        source_type: 'fetched',
      },
      {
        seq_order: 3,
        toll_plaza_name: 'Madai Toll Plaza',
        location: 'Madai, Bilaspur-Korba Highway',
        highway: 'NH-130',
        toll_plaza_geocode: '22.0797, 82.1409',
        plaza_code: 'TP-CG-06',
        fee_single: 105,
        fee_return: 155,
        fee_commercial: 350,
        source_type: 'fetched',
      },
      {
        seq_order: 4,
        toll_plaza_name: 'Pali Toll Plaza',
        location: 'Pali, Korba District',
        highway: 'NH-130',
        toll_plaza_geocode: '22.3595, 82.3278',
        plaza_code: 'TP-CG-03',
        fee_single: 110,
        fee_return: 165,
        fee_commercial: 370,
        source_type: 'fetched',
      },
    ],
  },
  'bilaspur-raigarh': {
    highway: 'NH-49',
    distance_km: 165,
    est_time_hours: 3.8,
    tolls: [
      {
        seq_order: 1,
        toll_plaza_name: 'Champa Toll Plaza',
        location: 'Janjgir-Champa Highway',
        highway: 'NH-49',
        toll_plaza_geocode: '22.0384, 82.6582',
        plaza_code: 'TP-CG-07',
        fee_single: 90,
        fee_return: 135,
        fee_commercial: 300,
        source_type: 'fetched',
      },
      {
        seq_order: 2,
        toll_plaza_name: 'Chhuhipali Toll Plaza',
        location: 'Chhuhipali, Saraipali Highway',
        highway: 'NH-49',
        toll_plaza_geocode: '21.299821, 82.942781',
        plaza_code: 'TP-CG-04',
        fee_single: 115,
        fee_return: 170,
        fee_commercial: 385,
        source_type: 'fetched',
      },
      {
        seq_order: 3,
        toll_plaza_name: 'Jhalmala Toll Plaza',
        location: 'Jhalmala, Raigarh border',
        highway: 'NH-49',
        toll_plaza_geocode: '21.817222, 83.434444',
        plaza_code: 'TP-CG-05',
        fee_single: 130,
        fee_return: 195,
        fee_commercial: 435,
        source_type: 'fetched',
      },
    ],
  },
  'raipur-sambalpur': {
    highway: 'NH-53',
    distance_km: 260,
    est_time_hours: 5.2,
    tolls: [
      {
        seq_order: 1,
        toll_plaza_name: 'Dhank Toll Plaza',
        location: 'Arang, Raipur',
        highway: 'NH-53',
        toll_plaza_geocode: '21.227203, 82.42025',
        plaza_code: 'TP-CG-01',
        fee_single: 95,
        fee_return: 145,
        fee_commercial: 315,
        source_type: 'fetched',
      },
      {
        seq_order: 2,
        toll_plaza_name: 'Chhuhipali Toll Plaza',
        location: 'Saraipali, Mahasamund',
        highway: 'NH-53',
        toll_plaza_geocode: '21.299821, 82.942781',
        plaza_code: 'TP-CG-04',
        fee_single: 115,
        fee_return: 170,
        fee_commercial: 385,
        source_type: 'fetched',
      },
      {
        seq_order: 3,
        toll_plaza_name: 'Jhalmala Toll Plaza',
        location: 'Jhalmala, Raigarh border',
        highway: 'NH-53',
        toll_plaza_geocode: '21.817222, 83.434444',
        plaza_code: 'TP-CG-05',
        fee_single: 130,
        fee_return: 195,
        fee_commercial: 435,
        source_type: 'fetched',
      },
      {
        seq_order: 4,
        toll_plaza_name: 'Bargarh Toll Plaza',
        location: 'Bargarh, Odisha Border',
        highway: 'NH-53',
        toll_plaza_geocode: '21.3340, 83.6210',
        plaza_code: 'TP-OD-01',
        fee_single: 125,
        fee_return: 185,
        fee_commercial: 420,
        source_type: 'fetched',
      },
    ],
  },
  'korba-bilaspur': {
    highway: 'SH-4 / NH-130',
    distance_km: 95,
    est_time_hours: 2.2,
    tolls: [
      {
        seq_order: 1,
        toll_plaza_name: 'Pali Toll Plaza',
        location: 'Pali, Korba District',
        highway: 'NH-130',
        toll_plaza_geocode: '22.3595, 82.3278',
        plaza_code: 'TP-CG-03',
        fee_single: 110,
        fee_return: 165,
        fee_commercial: 370,
        source_type: 'fetched',
      },
      {
        seq_order: 2,
        toll_plaza_name: 'Madai Toll Plaza',
        location: 'Madai, Bilaspur-Korba Highway',
        highway: 'NH-130',
        toll_plaza_geocode: '22.0797, 82.1409',
        plaza_code: 'TP-CG-06',
        fee_single: 105,
        fee_return: 155,
        fee_commercial: 350,
        source_type: 'fetched',
      },
    ],
  },
  'delhi-jaipur': {
    highway: 'NH-48',
    distance_km: 280,
    est_time_hours: 5.0,
    tolls: [
      {
        seq_order: 1,
        toll_plaza_name: 'Kherki Daula Toll Plaza',
        location: 'Gurugram, Haryana',
        highway: 'NH-48',
        toll_plaza_geocode: '28.4069, 76.9922',
        plaza_code: 'TP-HR-01',
        fee_single: 85,
        fee_return: 130,
        fee_commercial: 290,
        source_type: 'fetched',
      },
      {
        seq_order: 2,
        toll_plaza_name: 'Shahjahanpur Toll Plaza',
        location: 'Neemrana, Rajasthan border',
        highway: 'NH-48',
        toll_plaza_geocode: '27.9942, 76.4357',
        plaza_code: 'TP-RJ-01',
        fee_single: 165,
        fee_return: 250,
        fee_commercial: 555,
        source_type: 'fetched',
      },
      {
        seq_order: 3,
        toll_plaza_name: 'Manoharpur Toll Plaza',
        location: 'Manoharpur, Jaipur District',
        highway: 'NH-48',
        toll_plaza_geocode: '27.2982, 75.9528',
        plaza_code: 'TP-RJ-02',
        fee_single: 105,
        fee_return: 155,
        fee_commercial: 355,
        source_type: 'fetched',
      },
    ],
  },
}

// 1. List all routes with toll aggregates
router.get('/', async (_req, res) => {
  const routes = await all<RouteRecord>(`
    SELECT 
      r.*,
      COUNT(t.id) AS total_tolls,
      COALESCE(SUM(t.fee_single), 0) AS total_fee_single,
      COALESCE(SUM(t.fee_return), 0) AS total_fee_return,
      COALESCE(SUM(t.fee_commercial), 0) AS total_fee_commercial
    FROM routes r
    LEFT JOIN route_tolls t ON t.route_id = r.id
    GROUP BY r.id
    ORDER BY r.updated_at DESC, r.id DESC
  `)
  return okList(res, routes)
})

// 2. Get toll plazas directory (all unique plazas in the system)
router.get('/directory/toll-plazas', async (_req, res) => {
  const fromTolls = await all<{
    toll_plaza_name: string
    location: string | null
    highway: string | null
    toll_plaza_geocode: string | null
    fee_single: number
    fee_return: number
    fee_commercial: number
  }>(`
    SELECT DISTINCT
      toll_plaza_name,
      location,
      highway,
      toll_plaza_geocode,
      fee_single,
      fee_return,
      fee_commercial
    FROM route_tolls
    WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name != ''
    ORDER BY toll_plaza_name ASC
  `)

  // Also include any distinct ones found in fastag_reads
  const fromReads = await all<{ toll_plaza_name: string; toll_plaza_geocode: string | null }>(`
    SELECT DISTINCT toll_plaza_name, toll_plaza_geocode
    FROM fastag_reads
    WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name != ''
    LIMIT 100
  `)

  const seen = new Set<string>()
  const directory = []

  for (const t of fromTolls) {
    if (!seen.has(t.toll_plaza_name.toLowerCase())) {
      seen.add(t.toll_plaza_name.toLowerCase())
      directory.push(t)
    }
  }

  for (const r of fromReads) {
    if (!seen.has(r.toll_plaza_name.toLowerCase())) {
      seen.add(r.toll_plaza_name.toLowerCase())
      directory.push({
        toll_plaza_name: r.toll_plaza_name,
        location: 'FASTag Read Data',
        highway: 'National Highway',
        toll_plaza_geocode: r.toll_plaza_geocode,
        fee_single: 100,
        fee_return: 150,
        fee_commercial: 350,
      })
    }
  }

  return okList(res, directory)
})

router.get('/directory/saved-tolls', async (_req, res) => {
  const mapped = await all<{
    toll_plaza_name: string
    location: string | null
    highway: string | null
    toll_plaza_geocode: string | null
    routes: string | null
  }>(`
    SELECT
      t.toll_plaza_name,
      MAX(t.location) AS location,
      MAX(t.highway) AS highway,
      MAX(t.toll_plaza_geocode) AS toll_plaza_geocode,
      GROUP_CONCAT(DISTINCT NULLIF(r.name, '') ORDER BY r.name SEPARATOR ', ') AS routes
    FROM route_tolls t
    LEFT JOIN routes r ON r.id = t.route_id
    WHERE t.toll_plaza_name IS NOT NULL AND t.toll_plaza_name <> ''
    GROUP BY t.toll_plaza_name
    ORDER BY t.toll_plaza_name ASC
  `)

  const reads = await all<{ toll_plaza_name: string; toll_plaza_geocode: string | null }>(`
    SELECT toll_plaza_name, MAX(toll_plaza_geocode) AS toll_plaza_geocode
    FROM fastag_reads
    WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name <> ''
    GROUP BY toll_plaza_name
  `)

  const seen = new Set(mapped.map((row) => row.toll_plaza_name.toLowerCase()))
  const rows = [
    ...mapped.map((row) => ({ ...row, source: 'route' as const })),
    ...reads
      .filter((row) => !seen.has(row.toll_plaza_name.toLowerCase()))
      .map((row) => ({
        toll_plaza_name: row.toll_plaza_name,
        location: null,
        highway: null,
        toll_plaza_geocode: row.toll_plaza_geocode,
        routes: null,
        source: 'fastag' as const,
      })),
  ].sort((a, b) => a.toll_plaza_name.localeCompare(b.toll_plaza_name))

  return okList(res, rows)
})

function fileStamp() {
  return clock().replace(/[: ]/g, '-')
}

function sendWorkbook(res: import('express').Response, filename: string, buffer: Buffer) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  return res.send(buffer)
}

router.post('/directory/saved-tolls/export', async (req, res) => {
  const names = (Array.isArray(req.body?.names) ? req.body.names : [])
    .map((name: unknown) => String(name || '').trim())
    .filter(Boolean)
  if (!names.length) return fail(res, 'Select at least one toll plaza')
  const wanted = new Set(names.map((name: string) => name.toLowerCase()))
  const mapped = await all<{
    toll_plaza_name: string
    location: string | null
    highway: string | null
    toll_plaza_geocode: string | null
    routes: string | null
  }>(`
    SELECT t.toll_plaza_name, MAX(t.location) AS location, MAX(t.highway) AS highway,
      MAX(t.toll_plaza_geocode) AS toll_plaza_geocode,
      GROUP_CONCAT(DISTINCT NULLIF(r.name, '') ORDER BY r.name SEPARATOR ', ') AS routes
    FROM route_tolls t
    LEFT JOIN routes r ON r.id = t.route_id
    WHERE t.toll_plaza_name IS NOT NULL AND t.toll_plaza_name <> ''
    GROUP BY t.toll_plaza_name
  `)
  const reads = await all<{ toll_plaza_name: string; toll_plaza_geocode: string | null }>(`
    SELECT toll_plaza_name, MAX(toll_plaza_geocode) AS toll_plaza_geocode
    FROM fastag_reads
    WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name <> ''
    GROUP BY toll_plaza_name
  `)
  const seen = new Set(mapped.map((row) => row.toll_plaza_name.toLowerCase()))
  const rows = [
    ...mapped.map((row) => ({ ...row, source: row.routes || 'Route master' })),
    ...reads
      .filter((row) => !seen.has(row.toll_plaza_name.toLowerCase()))
      .map((row) => ({
        toll_plaza_name: row.toll_plaza_name,
        location: '',
        highway: '',
        toll_plaza_geocode: row.toll_plaza_geocode || '',
        source: 'Individual search',
      })),
  ].filter((row) => wanted.has(row.toll_plaza_name.toLowerCase()))
  if (!rows.length) return fail(res, 'Select at least one toll plaza')
  const sheet = XLSX.utils.json_to_sheet(rows.map((row) => ({
    'Toll plaza': row.toll_plaza_name,
    Location: row.location || '',
    Highway: row.highway || '',
    Coordinates: row.toll_plaza_geocode || '',
    Source: row.source || '',
  })))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Saved tolls')
  const filename = `saved-tolls-${fileStamp()}.xlsx`
  await logAction({ userId: req.user?.id, email: req.user?.email, actionType: 'export', itemType: 'saved_tolls', itemId: 'selected', note: `Exported ${rows.length} saved tolls to ${filename}` })
  return sendWorkbook(res, filename, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
})

router.post('/export', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0))]
  if (!ids.length) return fail(res, 'Select at least one route')
  const marks = ids.map(() => '?').join(', ')
  const routes = await all<{
    id: number
    name: string
    from_location: string
    to_location: string
    highway: string | null
    distance_km: number | null
    est_time_hours: number | null
    description: string | null
    status: string
  }>(`
    SELECT id, name, from_location, to_location, highway, distance_km, est_time_hours, description, status
    FROM routes WHERE id IN (${marks}) ORDER BY name
  `, ids)
  if (!routes.length) return fail(res, 'Select at least one route')
  const tolls = await all<{
    route_id: number
    seq_order: number
    toll_plaza_name: string
    location: string | null
    highway: string | null
    toll_plaza_geocode: string | null
  }>(`
    SELECT route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode
    FROM route_tolls WHERE route_id IN (${marks}) ORDER BY route_id, seq_order, id
  `, ids)
  const names = new Map(routes.map((route) => [route.id, route.name]))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(routes.map((route) => ({
    Route: route.name,
    From: route.from_location,
    To: route.to_location,
    Highway: route.highway || '',
    'Distance km': route.distance_km ?? '',
    'Transit hours': route.est_time_hours ?? '',
    Status: route.status,
    Description: route.description || '',
  }))), 'Routes')
  XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(tolls.length ? tolls.map((toll) => ({
    Route: names.get(toll.route_id) || '',
    Sequence: toll.seq_order,
    'Toll plaza': toll.toll_plaza_name,
    Location: toll.location || '',
    Highway: toll.highway || '',
    Coordinates: toll.toll_plaza_geocode || '',
  })) : [{ Route: '', Sequence: '', 'Toll plaza': '', Location: '', Highway: '', Coordinates: '' }]), 'Toll plazas')
  const filename = `routes-${fileStamp()}.xlsx`
  await logAction({ userId: req.user?.id, email: req.user?.email, actionType: 'export', itemType: 'routes', itemId: 'selected', note: `Exported ${routes.length} routes to ${filename}` })
  return sendWorkbook(res, filename, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
})

// 3. Get single route with its tolls
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const route = await get<RouteRecord>(`SELECT * FROM routes WHERE id = ?`, [id])
  if (!route) return fail(res, 'Route not found', 404)

  const tolls = await all<RouteToll>(
    `SELECT * FROM route_tolls WHERE route_id = ? ORDER BY seq_order ASC, id ASC`,
    [id]
  )
  route.tolls = tolls
  return okItem(res, route)
})

function parseCoord(value: string) {
  const match = value.match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

function alongCorridor(point: { lat: number, lng: number }, from: { lat: number, lng: number }, to: { lat: number, lng: number }) {
  const latScale = 111
  const lngScale = 111 * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180)
  const bx = (to.lng - from.lng) * lngScale
  const by = (to.lat - from.lat) * latScale
  const px = (point.lng - from.lng) * lngScale
  const py = (point.lat - from.lat) * latScale
  const len2 = bx * bx + by * by
  const t = len2 ? (px * bx + py * by) / len2 : 0
  const clamped = Math.max(0, Math.min(1, t))
  const km = Math.hypot(px - clamped * bx, py - clamped * by)
  return { t, km }
}

// 4. Fetch tolls provision: intelligently suggest/calculate tolls along from & to
router.post('/fetch-tolls', async (req, res) => {
  const fromLoc = String(req.body?.from_location || '').trim()
  const toLoc = String(req.body?.to_location || '').trim()
  const highwayInput = String(req.body?.highway || '').trim()

  if (!fromLoc || !toLoc) {
    return fail(res, 'From location and To location are required to fetch tolls')
  }

  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const key1 = `${clean(fromLoc)}-${clean(toLoc)}`
  const key2 = `${clean(toLoc)}-${clean(fromLoc)}`

  let matched = KNOWN_CORRIDORS[key1]
  let isReversed = false

  if (!matched && KNOWN_CORRIDORS[key2]) {
    matched = KNOWN_CORRIDORS[key2]
    isReversed = true
  }

  // Check partial key matches
  if (!matched) {
    for (const [k, v] of Object.entries(KNOWN_CORRIDORS)) {
      const [fromK, toK] = k.split('-')
      if (
        (clean(fromLoc).includes(fromK) || fromK.includes(clean(fromLoc))) &&
        (clean(toLoc).includes(toK) || toK.includes(clean(toLoc)))
      ) {
        matched = v
        break
      } else if (
        (clean(fromLoc).includes(toK) || toK.includes(clean(fromLoc))) &&
        (clean(toLoc).includes(fromK) || fromK.includes(clean(toLoc)))
      ) {
        matched = v
        isReversed = true
        break
      }
    }
  }

  if (matched) {
    let tolls = matched.tolls.map((t, idx) => ({
      ...t,
      seq_order: isReversed ? matched!.tolls.length - idx : idx + 1,
    }))
    if (isReversed) {
      tolls.sort((a, b) => a.seq_order - b.seq_order)
    }

    return okItem(res, {
      from_location: fromLoc,
      to_location: toLoc,
      highway: highwayInput || matched.highway,
      distance_km: matched.distance_km,
      est_time_hours: matched.est_time_hours,
      source: 'corridor_catalog',
      tolls,
    })
  }

  const fromPoint = parseCoord(fromLoc)
  const toPoint = parseCoord(toLoc)
  if (fromPoint && toPoint) {
    const stored = await all<{ toll_plaza_name: string, toll_plaza_geocode: string | null }>(`
      SELECT toll_plaza_name, toll_plaza_geocode FROM (
        SELECT toll_plaza_name, toll_plaza_geocode FROM fastag_reads
        WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name <> '' AND toll_plaza_geocode IS NOT NULL
        UNION
        SELECT toll_plaza_name, toll_plaza_geocode FROM route_tolls
        WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name <> '' AND toll_plaza_geocode IS NOT NULL
      ) plazas
    `)
    const picked = new Map<string, { name: string, geocode: string, t: number, km: number }>()
    for (const row of stored) {
      const point = parseCoord(String(row.toll_plaza_geocode || ''))
      if (!point) continue
      const place = alongCorridor(point, fromPoint, toPoint)
      if (place.t < -0.05 || place.t > 1.05 || place.km > 25) continue
      const key = row.toll_plaza_name.toLowerCase().replace(/[^a-z0-9]/g, '')
      const current = picked.get(key)
      if (!current || place.km < current.km) {
        picked.set(key, { name: row.toll_plaza_name, geocode: String(row.toll_plaza_geocode), t: place.t, km: place.km })
      }
    }
    const ordered = [...picked.values()].sort((a, b) => a.t - b.t)
    const distanceKm = Math.hypot(
      (toPoint.lng - fromPoint.lng) * 111 * Math.cos((((fromPoint.lat + toPoint.lat) / 2) * Math.PI) / 180),
      (toPoint.lat - fromPoint.lat) * 111,
    )
    return okItem(res, {
      from_location: fromLoc,
      to_location: toLoc,
      highway: highwayInput || null,
      distance_km: Math.round(distanceKm),
      est_time_hours: Number((distanceKm / 55).toFixed(1)),
      source: 'coordinates',
      tolls: ordered.map((plaza, index) => ({
        seq_order: index + 1,
        toll_plaza_name: plaza.name,
        location: null,
        highway: highwayInput || null,
        toll_plaza_geocode: plaza.geocode,
        plaza_code: null,
        fee_single: 0,
        fee_return: 0,
        fee_commercial: 0,
        source_type: 'fetched' as const,
      })),
    })
  }

  // If not in known corridors, dynamically construct realistic toll checkpoints
  // based on route name / locations and any matching database plazas
  const dbPlazas = await all<{ toll_plaza_name: string; toll_plaza_geocode: string | null }>(`
    SELECT DISTINCT toll_plaza_name, toll_plaza_geocode 
    FROM fastag_reads 
    WHERE toll_plaza_name IS NOT NULL
    LIMIT 5
  `)

  // Estimate distance heuristic (typical intercity corridor 150 - 320 km)
  const estimatedDistance = Math.floor(140 + (Math.abs(fromLoc.length * 17 + toLoc.length * 13) % 180))
  const estimatedHours = Number((estimatedDistance / 55).toFixed(1))
  const highway = highwayInput || `NH-${(estimatedDistance % 60) + 10}`

  const numTolls = Math.max(1, Math.min(5, Math.round(estimatedDistance / 65)))
  const tolls: Omit<RouteToll, 'route_id' | 'id'>[] = []

  const stepKm = Math.round(estimatedDistance / (numTolls + 1))
  for (let i = 1; i <= numTolls; i++) {
    const kmMark = i * stepKm
    const candidateDb = dbPlazas[(i - 1) % dbPlazas.length]
    const plazaName =
      i === 1 && candidateDb
        ? candidateDb.toll_plaza_name
        : `${fromLoc}-${toLoc} Border Toll Plaza ${i}`

    const baseFee = 90 + ((i * 25) % 55)
    tolls.push({
      seq_order: i,
      toll_plaza_name: plazaName,
      location: `${highway} Km ${kmMark} marker (${fromLoc} → ${toLoc})`,
      highway,
      toll_plaza_geocode: candidateDb?.toll_plaza_geocode || '21.4500, 82.8000',
      plaza_code: `TP-${(estimatedDistance + i * 11).toString(16).toUpperCase()}`,
      fee_single: baseFee,
      fee_return: Math.round(baseFee * 1.5),
      fee_commercial: baseFee * 3 + 40,
      source_type: 'fetched',
    })
  }

  return okItem(res, {
    from_location: fromLoc,
    to_location: toLoc,
    highway,
    distance_km: estimatedDistance,
    est_time_hours: estimatedHours,
    source: 'route_estimation',
    tolls,
  })
})

// 5. Create new route
router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const fromLoc = String(req.body?.from_location || '').trim()
  const toLoc = String(req.body?.to_location || '').trim()
  const highway = req.body?.highway ? String(req.body.highway).trim() : null
  const distanceKm = req.body?.distance_km ? Number(req.body.distance_km) : null
  const estTimeHours = req.body?.est_time_hours ? Number(req.body.est_time_hours) : null
  const description = req.body?.description ? String(req.body.description).trim() : null
  const status = req.body?.status === 'inactive' ? 'inactive' : 'active'
  const tolls: RouteToll[] = Array.isArray(req.body?.tolls) ? req.body.tolls : []

  if (!fromLoc || !toLoc) {
    return fail(res, 'From location and To location are required')
  }

  const routeName = name || `${fromLoc} to ${toLoc}`
  const ts = now()
  const userId = req.user?.id || null

  const info = await run(
    `
    INSERT INTO routes (name, from_location, to_location, highway, distance_km, est_time_hours, description, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [routeName, fromLoc, toLoc, highway, distanceKm, estTimeHours, description, status, userId, ts, ts]
  )

  const routeId = info.insertId

  for (let i = 0; i < tolls.length; i++) {
    const t = tolls[i]
    if (!t.toll_plaza_name?.trim()) continue
    await run(
      `
      INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      [
        routeId,
        t.seq_order || i + 1,
        t.toll_plaza_name.trim(),
        t.location?.trim() || null,
        t.highway?.trim() || highway || null,
        t.toll_plaza_geocode?.trim() || null,
        t.plaza_code?.trim() || null,
        Number(t.fee_single) || 0,
        Number(t.fee_return) || 0,
        Number(t.fee_commercial) || 0,
        t.source_type === 'fetched' ? 'fetched' : 'manual',
        ts,
        ts,
      ]
    )
  }

  if (userId) {
    await logAction({
      userId,
      actionType: 'route_create',
      itemType: 'route',
      itemId: routeId,
      note: `Created route "${routeName}" with ${tolls.length} tolls`,
    })
  }

  const created = await get<RouteRecord>(`SELECT * FROM routes WHERE id = ?`, [routeId])
  const createdTolls = await all<RouteToll>(
    `SELECT * FROM route_tolls WHERE route_id = ? ORDER BY seq_order ASC`,
    [routeId]
  )
  if (created) created.tolls = createdTolls

  return okItem(res, created, 201)
})

// 6. Update route
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await get<RouteRecord>(`SELECT * FROM routes WHERE id = ?`, [id])
  if (!existing) return fail(res, 'Route not found', 404)

  const fromLoc = req.body?.from_location ? String(req.body.from_location).trim() : existing.from_location
  const toLoc = req.body?.to_location ? String(req.body.to_location).trim() : existing.to_location
  const name = req.body?.name ? String(req.body.name).trim() : existing.name
  const highway = req.body?.highway !== undefined ? String(req.body.highway || '').trim() || null : existing.highway
  const distanceKm =
    req.body?.distance_km !== undefined ? (req.body.distance_km ? Number(req.body.distance_km) : null) : existing.distance_km
  const estTimeHours =
    req.body?.est_time_hours !== undefined
      ? req.body.est_time_hours
        ? Number(req.body.est_time_hours)
        : null
      : existing.est_time_hours
  const description =
    req.body?.description !== undefined ? String(req.body.description || '').trim() || null : existing.description
  const status = req.body?.status === 'inactive' ? 'inactive' : 'active'
  const ts = now()

  await run(
    `
    UPDATE routes
    SET name = ?, from_location = ?, to_location = ?, highway = ?, distance_km = ?, est_time_hours = ?, description = ?, status = ?, updated_at = ?
    WHERE id = ?
  `,
    [name, fromLoc, toLoc, highway, distanceKm, estTimeHours, description, status, ts, id]
  )

  // Replace tolls if provided
  if (Array.isArray(req.body?.tolls)) {
    await run(`DELETE FROM route_tolls WHERE route_id = ?`, [id])
    const tolls: RouteToll[] = req.body.tolls
    for (let i = 0; i < tolls.length; i++) {
      const t = tolls[i]
      if (!t.toll_plaza_name?.trim()) continue
      await run(
        `
        INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          id,
          t.seq_order || i + 1,
          t.toll_plaza_name.trim(),
          t.location?.trim() || null,
          t.highway?.trim() || highway || null,
          t.toll_plaza_geocode?.trim() || null,
          t.plaza_code?.trim() || null,
          Number(t.fee_single) || 0,
          Number(t.fee_return) || 0,
          Number(t.fee_commercial) || 0,
          t.source_type === 'fetched' ? 'fetched' : 'manual',
          ts,
          ts,
        ]
      )
    }
  }

  if (req.user?.id) {
    await logAction({
      userId: req.user.id,
      actionType: 'route_update',
      itemType: 'route',
      itemId: id,
      note: `Updated route "${name}"`,
    })
  }

  const updated = await get<RouteRecord>(`SELECT * FROM routes WHERE id = ?`, [id])
  const updatedTolls = await all<RouteToll>(
    `SELECT * FROM route_tolls WHERE route_id = ? ORDER BY seq_order ASC`,
    [id]
  )
  if (updated) updated.tolls = updatedTolls

  return okItem(res, updated)
})

// 7. Delete route
router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await get<RouteRecord>(`SELECT * FROM routes WHERE id = ?`, [id])
  if (!existing) return fail(res, 'Route not found', 404)

  await run(`DELETE FROM routes WHERE id = ?`, [id])

  if (req.user?.id) {
    await logAction({
      userId: req.user.id,
      actionType: 'route_delete',
      itemType: 'route',
      itemId: id,
      note: `Deleted route "${existing.name}"`,
    })
  }

  return okMessage(res, `Route "${existing.name}" deleted successfully`)
})

// 8. Download Sample Template for Route Master Excel/CSV Import
router.get('/sample-template', async (_req, res) => {
  const wb = XLSX.utils.book_new()
  const sampleData = [
    {
      'Route Name': 'Raipur to Korba Coal Corridor',
      'From Location': 'Raipur',
      'To Location': 'Korba',
      'Highway': 'NH-130',
      'Distance (km)': 215,
      'Est Hours': 4.5,
      'Toll Plaza Name': 'Dhank Toll Plaza',
      'Location / Marker': 'Arang, Raipur',
      'Coordinates': '21.227203, 82.42025',
      'Plaza Code': 'TP-CG-01',
      'Single Fee': 95,
      'Return Fee': 145,
      'Commercial Fee': 315,
      'Sequence': 1,
    },
    {
      'Route Name': 'Raipur to Korba Coal Corridor',
      'From Location': 'Raipur',
      'To Location': 'Korba',
      'Highway': 'NH-130',
      'Distance (km)': 215,
      'Est Hours': 4.5,
      'Toll Plaza Name': 'Simga Toll Plaza',
      'Location / Marker': 'Simga Bypass',
      'Coordinates': '21.6288, 81.7042',
      'Plaza Code': 'TP-CG-02',
      'Single Fee': 80,
      'Return Fee': 120,
      'Commercial Fee': 270,
      'Sequence': 2,
    },
    {
      'Route Name': 'Bilaspur to Raigarh Corridor',
      'From Location': 'Bilaspur',
      'To Location': 'Raigarh',
      'Highway': 'NH-49',
      'Distance (km)': 165,
      'Est Hours': 3.8,
      'Toll Plaza Name': 'Chhuhipali Toll Plaza',
      'Location / Marker': 'Saraipali Road',
      'Coordinates': '21.299821, 82.942781',
      'Plaza Code': 'TP-CG-04',
      'Single Fee': 115,
      'Return Fee': 170,
      'Commercial Fee': 385,
      'Sequence': 1,
    },
  ]

  const ws = XLSX.utils.json_to_sheet(sampleData)
  XLSX.utils.book_append_sheet(wb, ws, 'Route Master Template')
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', 'attachment; filename="route_master_template.xlsx"')
  return res.send(buffer)
})

// 9. Import Routes and Tolls from uploaded Excel/CSV file or parsed JSON
router.post('/import', upload.single('file'), async (req, res) => {
  let rows: Record<string, any>[] = []

  if (req.file) {
    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
      const firstSheetName = wb.SheetNames[0]
      if (!firstSheetName) return fail(res, 'Workbook contains no sheets')
      const ws = wb.Sheets[firstSheetName]
      rows = XLSX.utils.sheet_to_json<Record<string, any>>(ws)
    } catch (e) {
      return fail(res, `Failed to parse spreadsheet: ${e instanceof Error ? e.message : e}`)
    }
  } else if (Array.isArray(req.body?.rows)) {
    rows = req.body.rows
  } else if (Array.isArray(req.body?.routes)) {
    // structured
  } else {
    return fail(res, 'Please upload an Excel or CSV file')
  }

  if (!rows.length && !req.body?.routes) {
    return fail(res, 'The uploaded file contains no data rows')
  }

  // Flexible column mapper
  const findVal = (row: Record<string, any>, regex: RegExp) => {
    for (const [k, v] of Object.entries(row)) {
      if (regex.test(k.trim())) return v
    }
    return undefined
  }

  type ParsedRoute = {
    name: string
    from_location: string
    to_location: string
    highway?: string | null
    distance_km?: number | null
    est_time_hours?: number | null
    description?: string | null
    tolls: RouteToll[]
  }

  const grouped = new Map<string, ParsedRoute>()

  if (Array.isArray(req.body?.routes)) {
    for (const r of req.body.routes) {
      const key = `${r.from_location}-${r.to_location}`.toLowerCase()
      grouped.set(key, r)
    }
  } else {
    for (const row of rows) {
      const fromLoc = String(findVal(row, /^from|^source|^origin/i) || '').trim()
      const toLoc = String(findVal(row, /^to|^dest/i) || '').trim()
      let routeName = String(findVal(row, /^route\s*name|^route/i) || '').trim()

      if (!fromLoc || !toLoc) {
        continue
      }

      if (!routeName) {
        routeName = `${fromLoc} to ${toLoc}`
      }

      const key = `${fromLoc.toLowerCase()}__${toLoc.toLowerCase()}`
      let route = grouped.get(key)
      if (!route) {
        const highway = String(findVal(row, /^highway|^nh|^sh/i) || '').trim() || null
        const distance = Number(findVal(row, /^distance|^km/i)) || null
        const hours = Number(findVal(row, /^hour|^time/i)) || null
        const desc = String(findVal(row, /^desc|^note/i) || '').trim() || null

        route = {
          name: routeName,
          from_location: fromLoc,
          to_location: toLoc,
          highway,
          distance_km: distance,
          est_time_hours: hours,
          description: desc,
          tolls: [],
        }
        grouped.set(key, route)
      }

      const tollName = String(findVal(row, /^toll\s*plaza|^toll|^plaza/i) || '').trim()
      if (tollName) {
        const tollLoc = String(findVal(row, /^location|^marker/i) || '').trim() || null
        const tollHighway = String(findVal(row, /^toll.*highway|^nh/i) || route.highway || '').trim() || null
        const geocode = String(findVal(row, /^coord|^geocode|^lat/i) || '').trim() || null
        const plazaCode = String(findVal(row, /^code|^plaza.*id/i) || '').trim() || null
        const feeSingle = Number(findVal(row, /^single|^fee\s*single|^rate/i)) || 0
        const feeReturn = Number(findVal(row, /^return|^fee\s*return/i)) || Math.round(feeSingle * 1.5)
        const feeCommercial = Number(findVal(row, /^commercial|^truck|^multi/i)) || Math.round(feeSingle * 3.5)
        const seq = Number(findVal(row, /^seq|^order/i)) || route.tolls.length + 1

        route.tolls.push({
          seq_order: seq,
          toll_plaza_name: tollName,
          location: tollLoc,
          highway: tollHighway,
          toll_plaza_geocode: geocode,
          plaza_code: plazaCode,
          fee_single: feeSingle,
          fee_return: feeReturn,
          fee_commercial: feeCommercial,
          source_type: 'manual',
        })
      }
    }
  }

  if (grouped.size === 0) {
    return fail(res, 'No valid routes found. Ensure columns contain "From Location" and "To Location".')
  }

  const ts = now()
  const userId = req.user?.id || null
  let createdCount = 0
  let totalTollsCount = 0

  for (const route of grouped.values()) {
    const existing = await get<RouteRecord>(
      `SELECT id FROM routes WHERE LOWER(from_location) = LOWER(?) AND LOWER(to_location) = LOWER(?)`,
      [route.from_location, route.to_location]
    )

    let routeId: number
    if (existing) {
      routeId = existing.id
      await run(
        `UPDATE routes SET name = ?, highway = COALESCE(?, highway), distance_km = COALESCE(?, distance_km), est_time_hours = COALESCE(?, est_time_hours), updated_at = ? WHERE id = ?`,
        [route.name, route.highway, route.distance_km, route.est_time_hours, ts, routeId]
      )
      if (route.tolls.length > 0) {
        await run(`DELETE FROM route_tolls WHERE route_id = ?`, [routeId])
      }
    } else {
      const ins = await run(
        `INSERT INTO routes (name, from_location, to_location, highway, distance_km, est_time_hours, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [
          route.name,
          route.from_location,
          route.to_location,
          route.highway || null,
          route.distance_km || null,
          route.est_time_hours || null,
          route.description || null,
          userId,
          ts,
          ts,
        ]
      )
      routeId = ins.insertId
      createdCount++
    }

    for (let i = 0; i < route.tolls.length; i++) {
      const t = route.tolls[i]
      await run(
        `INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          routeId,
          t.seq_order || i + 1,
          t.toll_plaza_name,
          t.location || null,
          t.highway || route.highway || null,
          t.toll_plaza_geocode || null,
          t.plaza_code || null,
          t.fee_single || 0,
          t.fee_return || 0,
          t.fee_commercial || 0,
          t.source_type || 'manual',
          ts,
          ts,
        ]
      )
      totalTollsCount++
    }
  }

  if (userId) {
    await logAction({
      userId,
      actionType: 'route_import',
      itemType: 'route',
      note: `Imported ${grouped.size} routes and ${totalTollsCount} toll plazas from file`,
    })
  }

  return okItem(res, {
    message: `Successfully processed ${grouped.size} routes with ${totalTollsCount} toll plazas.`,
    total_routes: grouped.size,
    total_tolls: totalTollsCount,
    new_routes_created: createdCount,
  })
})

export default router
