import * as XLSX from 'xlsx'
import { all } from '../db/index.js'

const GPS_MATCH_KM = 3
const WINDOW_PAD_MS = 6 * 60 * 60 * 1000

type TripRow = {
  id: number
  vehicle_reg_no: string
  project_name: string | null
  challan_id: string | null
  trip_id: string | null
  from_location: string | null
  to_location: string | null
  status: string
  read_count: number
  fetched_at: string | null
}

type ReadRow = {
  vehicle_id: number
  vehicle_reg_no: string
  toll_plaza_name: string | null
  toll_plaza_geocode: string | null
  reader_read_time: string | null
}

type RouteTollRow = {
  route_id: number
  route_name: string
  from_location: string
  to_location: string
  seq_order: number
  toll_plaza_name: string
  toll_plaza_geocode: string | null
}

type GpsRow = {
  vno: string
  lat: number
  lon: number
  gps_time: string
}

function clean(value: string | null | undefined) {
  const text = String(value ?? '').trim()
  return text || null
}

function stamp(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return Number.isNaN(parsed) ? null : parsed
}

function plazaKey(name: string) {
  return name.toLowerCase().replace(/toll\s*plaza/g, '').replace(/[^a-z0-9]/g, '')
}

function sitesMatch(leftRaw: string, rightRaw: string) {
  const left = leftRaw.trim().toLowerCase()
  const right = rightRaw.trim().toLowerCase()
  if (!left || !right) return false
  if (left === right) return true
  const a = parseGeocode(leftRaw)
  const b = parseGeocode(rightRaw)
  if (a && b) return distanceKm(a, b) <= 2
  const compactLeft = left.replace(/[^a-z0-9]/g, '')
  const compactRight = right.replace(/[^a-z0-9]/g, '')
  if (compactLeft.length < 4 || compactRight.length < 4) return false
  return compactLeft.includes(compactRight) || compactRight.includes(compactLeft)
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

function parseGeocode(value: string | null) {
  if (!value) return null
  const match = String(value).match(/(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)/)
  if (!match) return null
  const lat = Number(match[1])
  const lng = Number(match[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
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

function alongCorridor(point: { lat: number, lng: number }, from: { lat: number, lng: number }, to: { lat: number, lng: number }) {
  const lngScale = 111 * Math.cos((((from.lat + to.lat) / 2) * Math.PI) / 180)
  const bx = (to.lng - from.lng) * lngScale
  const by = (to.lat - from.lat) * 111
  const px = (point.lng - from.lng) * lngScale
  const py = (point.lat - from.lat) * 111
  const len2 = bx * bx + by * by
  const t = len2 ? (px * bx + py * by) / len2 : 0
  const clamped = Math.max(0, Math.min(1, t))
  return { t, km: Math.hypot(px - clamped * bx, py - clamped * by) }
}

function windowsOverlap(a: { first: number | null, last: number | null }, b: { first: number | null, last: number | null }) {
  if (a.first == null || a.last == null || b.first == null || b.last == null) return false
  return a.first <= b.last && b.first <= a.last
}

export async function tripAudit(vehicleQuery = '') {
  const compact = vehicleQuery.toUpperCase().replace(/[^A-Z0-9]/g, '')
  const vehicleFilter = compact.length >= 4 ? compact : ''
  const trips = await all<TripRow>(`
    SELECT id, vehicle_reg_no, project_name, challan_id, trip_id, from_location, to_location, status, read_count, fetched_at
    FROM fastag_vehicles
    ${vehicleFilter ? 'WHERE vehicle_reg_no LIKE ?' : ''}
    ORDER BY vehicle_reg_no, id
  `, vehicleFilter ? [`%${vehicleFilter}%`] : [])
  const reads = await all<ReadRow>(`
    SELECT vehicle_id, vehicle_reg_no, toll_plaza_name, toll_plaza_geocode, reader_read_time
    FROM fastag_reads
    WHERE toll_plaza_name IS NOT NULL AND toll_plaza_name <> ''
    ${vehicleFilter ? 'AND vehicle_reg_no LIKE ?' : ''}
  `, vehicleFilter ? [`%${vehicleFilter}%`] : [])
  const routeTolls = await all<RouteTollRow>(`
    SELECT r.id AS route_id, r.name AS route_name, r.from_location, r.to_location,
      t.seq_order, t.toll_plaza_name, t.toll_plaza_geocode
    FROM routes r
    INNER JOIN route_tolls t ON t.route_id = r.id
    WHERE r.status = 'active'
    ORDER BY r.id, t.seq_order, t.id
  `)

  const readsByVehicle = new Map<number, ReadRow[]>()
  for (const read of reads) {
    const list = readsByVehicle.get(read.vehicle_id) || []
    list.push(read)
    readsByVehicle.set(read.vehicle_id, list)
  }

  const byPlate = new Map<string, TripRow[]>()
  for (const trip of trips) {
    const list = byPlate.get(trip.vehicle_reg_no) || []
    list.push(trip)
    byPlate.set(trip.vehicle_reg_no, list)
  }

  const overlaps = []
  for (const [vehicle, vehicleTrips] of byPlate) {
    const namedTrips = vehicleTrips.filter((trip) => clean(trip.project_name))
    const projects = [...new Set(namedTrips.map((trip) => clean(trip.project_name)).filter((name): name is string => !!name))]
    if (projects.length < 2) continue
    const spans = namedTrips.map((trip) => {
      const timed = (readsByVehicle.get(trip.id) || [])
        .map((read) => ({ raw: read.reader_read_time, at: stamp(read.reader_read_time) }))
        .filter((item): item is { raw: string, at: number } => item.at != null && !!item.raw)
      const first = timed.length ? timed.reduce((best, item) => (item.at < best.at ? item : best)) : null
      const last = timed.length ? timed.reduce((best, item) => (item.at > best.at ? item : best)) : null
      return { trip, first: first?.at ?? null, last: last?.at ?? null, firstRaw: first?.raw ?? null, lastRaw: last?.raw ?? null }
    })
    const tripViews = spans.map((span) => {
      const flags: string[] = []
      const project = clean(span.trip.project_name)
      const challan = clean(span.trip.challan_id)
      const tripId = clean(span.trip.trip_id)
      for (const other of spans) {
        if (other.trip.id === span.trip.id) continue
        const otherProject = clean(other.trip.project_name) || 'another project'
        if (project && otherProject && project.toLowerCase() === otherProject.toLowerCase()) continue
        if (challan && clean(other.trip.challan_id)?.toLowerCase() === challan.toLowerCase()) {
          flags.push(`Challan ${challan} is also on ${otherProject}`)
        }
        if (tripId && clean(other.trip.trip_id)?.toLowerCase() === tripId.toLowerCase()) {
          flags.push(`Trip ID ${tripId} is also on ${otherProject}`)
        }
        if (windowsOverlap(span, other)) {
          flags.push(`Toll entry times overlap ${otherProject}`)
        }
      }
      if (!flags.length) flags.push(`Vehicle is also active on ${projects.filter((name) => name.toLowerCase() !== (project || '').toLowerCase()).join(', ')}`)
      return {
        vehicle_id: span.trip.id,
        project_name: project,
        challan_id: challan,
        trip_id: tripId,
        from_location: clean(span.trip.from_location),
        to_location: clean(span.trip.to_location),
        first_entry: span.firstRaw,
        last_entry: span.lastRaw,
        toll_count: (readsByVehicle.get(span.trip.id) || []).length,
        flags: [...new Set(flags)],
      }
    })
    overlaps.push({
      vehicle_reg_no: vehicle,
      projects,
      trips: tripViews,
      action: 'Confirm with the vendor or site team which project this trip belongs to before billing.',
    })
  }

  const skippedCandidates: Array<{
    vehicle_reg_no: string
    project_name: string | null
    challan_id: string | null
    trip_id: string | null
    route_id: number
    route_name: string
    from_location: string
    to_location: string
    first: number | null
    last: number | null
    expected: Array<{ seq_order: number, toll_plaza_name: string, geocode: string | null, recorded: boolean }>
    basis: 'route_master' | 'excel'
    missing: Array<{ seq_order: number, toll_plaza_name: string, geocode: string | null, kind: 'missed' | 'crossed' | 'outside' }>
  }> = []

  const routes = new Map<number, RouteTollRow[]>()
  for (const toll of routeTolls) {
    const list = routes.get(toll.route_id) || []
    list.push(toll)
    routes.set(toll.route_id, list)
  }

  for (const trip of trips) {
    const actual = readsByVehicle.get(trip.id) || []
    const actualNames = actual.map((read) => read.toll_plaza_name).filter((name): name is string => !!name)
    const tripFrom = clean(trip.from_location)
    const tripTo = clean(trip.to_location)
    if (tripFrom && tripTo) {
      let matchedRoute: RouteTollRow[] | null = null
      let reversed = false
      for (const rows of routes.values()) {
        const routeFrom = rows[0]?.from_location || ''
        const routeTo = rows[0]?.to_location || ''
        if (sitesMatch(routeFrom, tripFrom) && sitesMatch(routeTo, tripTo)) {
          matchedRoute = rows
          break
        }
        if (sitesMatch(routeFrom, tripTo) && sitesMatch(routeTo, tripFrom)) {
          matchedRoute = [...rows].reverse()
          reversed = true
          break
        }
      }
      const times = actual.map((read) => stamp(read.reader_read_time)).filter((value): value is number => value != null)
      if (!matchedRoute) {
        const fromPoint = parseGeocode(tripFrom)
        const toPoint = parseGeocode(tripTo)
        const crossed = new Map<string, { name: string, geocode: string | null, at: number }>()
        for (const read of actual) {
          if (!read.toll_plaza_name) continue
          const key = plazaKey(read.toll_plaza_name)
          const at = stamp(read.reader_read_time) ?? 0
          const current = crossed.get(key)
          if (!current || at < current.at) crossed.set(key, { name: read.toll_plaza_name, geocode: read.toll_plaza_geocode, at })
        }
        const crossedRows = [...crossed.values()].sort((a, b) => a.at - b.at)
        const missing: Array<{ seq_order: number, toll_plaza_name: string, geocode: string | null, kind: 'missed' | 'crossed' | 'outside' }> = []
        if (fromPoint && toPoint) {
          const seenPlaza = new Set<string>()
          const between: Array<{ name: string, geocode: string, t: number }> = []
          for (const read of reads) {
            if (!read.toll_plaza_name || !read.toll_plaza_geocode) continue
            const key = plazaKey(read.toll_plaza_name)
            if (seenPlaza.has(key)) continue
            const point = parseGeocode(read.toll_plaza_geocode)
            if (!point) continue
            const place = alongCorridor(point, fromPoint, toPoint)
            if (place.t < -0.05 || place.t > 1.05 || place.km > 25) continue
            seenPlaza.add(key)
            between.push({ name: read.toll_plaza_name, geocode: read.toll_plaza_geocode, t: place.t })
          }
          between.sort((a, b) => a.t - b.t)
          between.forEach((plaza, index) => {
            if (actualNames.some((name) => plazasMatch(plaza.name, name))) return
            missing.push({ seq_order: index + 1, toll_plaza_name: plaza.name, geocode: plaza.geocode, kind: 'missed' })
          })
          crossedRows.forEach((plaza, index) => {
            const point = parseGeocode(plaza.geocode)
            if (!point) return
            const place = alongCorridor(point, fromPoint, toPoint)
            if (place.t < -0.05 || place.t > 1.05 || place.km > 25) {
              missing.push({ seq_order: index + 1, toll_plaza_name: plaza.name, geocode: plaza.geocode, kind: 'outside' })
            }
          })
        } else if (!crossedRows.length) {
          missing.push({ seq_order: 0, toll_plaza_name: 'No tolls crossed', geocode: null, kind: 'crossed' })
        } else {
          crossedRows.forEach((plaza, index) => {
            missing.push({ seq_order: index + 1, toll_plaza_name: plaza.name, geocode: plaza.geocode, kind: 'crossed' })
          })
        }
        if (!missing.length) continue
        skippedCandidates.push({
          vehicle_reg_no: trip.vehicle_reg_no,
          project_name: clean(trip.project_name),
          challan_id: clean(trip.challan_id),
          trip_id: clean(trip.trip_id),
          route_id: 0,
          route_name: 'Excel sites',
          from_location: tripFrom,
          to_location: tripTo,
          first: times.length ? Math.min(...times) : null,
          last: times.length ? Math.max(...times) : null,
          basis: 'excel',
          expected: [],
          missing,
        })
        continue
      }
      const ordered = reversed
        ? matchedRoute.map((row, index) => ({ ...row, seq_order: index + 1 }))
        : matchedRoute
      const expected = ordered.map((row) => ({
        seq_order: row.seq_order,
        toll_plaza_name: row.toll_plaza_name,
        geocode: row.toll_plaza_geocode,
        recorded: actualNames.some((name) => plazasMatch(row.toll_plaza_name, name)),
      }))
      const missing = expected.filter((row) => !row.recorded).map((row) => ({ ...row, kind: 'missed' as const }))
      if (!missing.length) continue
      skippedCandidates.push({
        vehicle_reg_no: trip.vehicle_reg_no,
        project_name: clean(trip.project_name),
        challan_id: clean(trip.challan_id),
        trip_id: clean(trip.trip_id),
        route_id: ordered[0].route_id,
        route_name: ordered[0].route_name,
        from_location: tripFrom,
        to_location: tripTo,
        first: times.length ? Math.min(...times) : null,
        last: times.length ? Math.max(...times) : null,
        basis: 'route_master',
        expected,
        missing,
      })
      continue
    }
    if (!actualNames.length || !routes.size) continue
    let best: { rows: RouteTollRow[], matched: number, ratio: number } | null = null
    for (const rows of routes.values()) {
      const matched = rows.filter((row) => actualNames.some((name) => plazasMatch(row.toll_plaza_name, name))).length
      const ratio = rows.length ? matched / rows.length : 0
      if (!best || matched > best.matched || (matched === best.matched && ratio > best.ratio)) {
        best = { rows, matched, ratio }
      }
    }
    if (!best || best.matched < 2) continue
    const expected = best.rows.map((row) => ({
      seq_order: row.seq_order,
      toll_plaza_name: row.toll_plaza_name,
      geocode: row.toll_plaza_geocode,
      recorded: actualNames.some((name) => plazasMatch(row.toll_plaza_name, name)),
    }))
    const recordedSeq = expected.filter((row) => row.recorded).map((row) => row.seq_order)
    const firstSeq = Math.min(...recordedSeq)
    const lastSeq = Math.max(...recordedSeq)
    const missing = expected.filter((row) => !row.recorded && row.seq_order > firstSeq && row.seq_order < lastSeq).map((row) => ({ ...row, kind: 'missed' as const }))
    if (!missing.length) continue
    const times = actual.map((read) => stamp(read.reader_read_time)).filter((value): value is number => value != null)
    skippedCandidates.push({
      vehicle_reg_no: trip.vehicle_reg_no,
      project_name: clean(trip.project_name),
      challan_id: clean(trip.challan_id),
      trip_id: clean(trip.trip_id),
      route_id: best.rows[0].route_id,
      route_name: best.rows[0].route_name,
      from_location: best.rows[0].from_location,
      to_location: best.rows[0].to_location,
      basis: 'route_master',
      first: times.length ? Math.min(...times) : null,
      last: times.length ? Math.max(...times) : null,
      expected,
      missing,
    })
  }

  const plates = [...new Set(skippedCandidates.map((trip) => trip.vehicle_reg_no))]
  const gpsByPlate = new Map<string, GpsRow[]>()
  if (plates.length) {
    const marks = plates.map(() => '?').join(', ')
    const pings = await all<GpsRow>(`
      SELECT vno, lat, lon, gps_time
      FROM gps_tracking
      WHERE vno IN (${marks})
      ORDER BY gps_time
    `, plates)
    for (const ping of pings) {
      const list = gpsByPlate.get(ping.vno) || []
      list.push(ping)
      gpsByPlate.set(ping.vno, list)
    }
  }

  const skipped = skippedCandidates.map((trip) => {
    const pings = gpsByPlate.get(trip.vehicle_reg_no) || []
    const from = trip.first == null ? null : trip.first - WINDOW_PAD_MS
    const to = trip.last == null ? null : trip.last + WINDOW_PAD_MS
    const inWindow = pings.filter((ping) => {
      const time = stamp(ping.gps_time)
      if (time == null || from == null || to == null) return false
      return time >= from && time <= to
    })
    const skippedPlazas = trip.missing.map((plaza) => {
      const point = parseGeocode(plaza.geocode)
      if (plaza.kind === 'crossed') {
        return { ...plaza, gps_passed: null, gps_note: 'Toll crossed. Checked from the Excel From and To because no route master exists.' }
      }
      if (plaza.kind === 'outside') {
        return { ...plaza, gps_passed: null, gps_note: 'Toll crossed outside the Excel From and To.' }
      }
      if (!point) {
        return { ...plaza, gps_passed: null, gps_note: 'This plaza has no coordinates, so the GPS log cannot confirm the pass.' }
      }
      if (!inWindow.length) {
        return { ...plaza, gps_passed: null, gps_note: 'No GPS logs for this vehicle in the trip window.' }
      }
      const nearest = inWindow.reduce((best, ping) => {
        const km = distanceKm(point, { lat: Number(ping.lat), lng: Number(ping.lon) })
        return km < best ? km : best
      }, Number.POSITIVE_INFINITY)
      const passed = nearest <= GPS_MATCH_KM
      return {
        ...plaza,
        gps_passed: passed,
        gps_note: passed
          ? `GPS passed within ${nearest.toFixed(1)} km of this plaza, and FASTag has no entry.`
          : `GPS logs in this window stay ${nearest.toFixed(1)} km away from this plaza.`,
      }
    })
    return {
      vehicle_reg_no: trip.vehicle_reg_no,
      project_name: trip.project_name,
      challan_id: trip.challan_id,
      trip_id: trip.trip_id,
      from_location: trip.from_location,
      to_location: trip.to_location,
      route_id: trip.route_id,
      route_name: trip.route_name,
      basis: trip.basis,
      route_label: `${trip.from_location} to ${trip.to_location}`,
      expected_count: trip.expected.length,
      recorded_count: trip.expected.filter((row) => row.recorded).length,
      skipped: skippedPlazas,
      action: 'Flag this trip. Confirm each skipped toll with the site team before billing.',
    }
  })

  return {
    overlaps,
    skipped,
    summary: {
      multi_project_vehicles: overlaps.length,
      overlap_trips: overlaps.reduce((sum, item) => sum + item.trips.length, 0),
      skipped_trips: skipped.length,
      skipped_plazas: skipped.reduce((sum, item) => sum + item.skipped.length, 0),
      gps_confirmed: skipped.reduce((sum, item) => sum + item.skipped.filter((plaza) => plaza.gps_passed).length, 0),
    },
  }
}

function exportStamp() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '00'
  return `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-${part('second')}`
}

export async function exportTripChecks(vehicleQuery = '', focus = '', keys: string[] = []) {
  const report = await tripAudit(vehicleQuery)
  const picked = new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))
  const showOverlaps = focus !== 'skipped'
  const showSkipped = !focus || focus === 'skipped'
  const book = XLSX.utils.book_new()
  let count = 0

  if (showOverlaps) {
    const rows = report.overlaps.flatMap((group) => group.trips.flatMap((trip) => {
      if (picked.size && !picked.has(`overlap:${trip.vehicle_id}`)) return []
      return [{
      Vehicle: group.vehicle_reg_no,
      Project: trip.project_name || '',
      'Challan ID': trip.challan_id || '',
      'Trip ID': trip.trip_id || '',
      From: trip.from_location || '',
      To: trip.to_location || '',
      'Toll window': trip.first_entry ? `${trip.first_entry} to ${trip.last_entry}` : '',
      Flag: (trip.flags || []).join('; '),
      Action: group.action || '',
    }]
    }))
    if (!picked.size || rows.length) {
    count += rows.length
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{
      Vehicle: '', Project: '', 'Challan ID': '', 'Trip ID': '', From: '', To: '', 'Toll window': '', Flag: '', Action: '',
    }])
    XLSX.utils.book_append_sheet(book, sheet, 'Multiple projects')
    }
  }

  if (showSkipped) {
    const rows = report.skipped.flatMap((trip) => trip.skipped.flatMap((plaza) => {
      const key = `skipped:${trip.vehicle_reg_no}|${trip.challan_id || ''}|${trip.trip_id || ''}|${plaza.seq_order}|${plaza.toll_plaza_name || ''}`
      if (picked.size && !picked.has(key)) return []
      return [{
      Vehicle: trip.vehicle_reg_no,
      Project: trip.project_name || '',
      'Challan ID': trip.challan_id || '',
      'Trip ID': trip.trip_id || '',
      From: trip.from_location || '',
      To: trip.to_location || '',
      Check: trip.basis === 'excel' ? 'Excel sites' : 'Route master',
      Route: trip.route_name || '',
      'Route label': trip.route_label || '',
      Recorded: trip.basis === 'excel'
        ? `${trip.skipped.length} exception${trip.skipped.length === 1 ? '' : 's'}`
        : `${trip.recorded_count} of ${trip.expected_count}`,
      'Skipped plaza': `${plaza.seq_order ? `#${plaza.seq_order} ` : ''}${plaza.toll_plaza_name || ''}`,
      GPS: plaza.gps_note || '',
      Action: trip.action || '',
    }]
    }))
    if (!picked.size || rows.length) {
    count += rows.length
    const sheet = XLSX.utils.json_to_sheet(rows.length ? rows : [{
      Vehicle: '', Project: '', 'Challan ID': '', 'Trip ID': '', From: '', To: '', Check: '', Route: '', 'Route label': '', Recorded: '', 'Skipped plaza': '', GPS: '', Action: '',
    }])
    XLSX.utils.book_append_sheet(book, sheet, 'Skipped tolls')
    }
  }
  if (!book.SheetNames.length) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ Note: 'No selected rows' }]), 'Trip checks')
  }

  return {
    filename: `trip-checks-${exportStamp()}.xlsx`,
    count,
    buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
  }
}
