export type RouteMatch = 'qualifying' | 'reverse' | 'repeat' | 'unmatched' | 'unverified' | 'ambiguous'

export type QualifyRead = {
  id?: number | string
  vehicle_reg_no?: string
  vehicle_id?: number | null
  seq_no?: string | null
  reader_read_time?: string | null
  toll_plaza_name?: string | null
  toll_plaza_geocode?: string | null
  heading_code?: 'loading' | 'unloading' | 'unknown'
}

export type SequenceToll = {
  seq_order: number
  toll_plaza_name: string
  toll_plaza_geocode?: string | null
}

export type RouteSequence = {
  route_id: number
  tolls: SequenceToll[]
}

type Options = {
  requireDirection?: boolean
}

const GEO_KM = 1.5

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

function distanceKm(a: { lat: number, lng: number }, b: { lat: number, lng: number }) {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

function stamp(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed
}

function matchToll(read: QualifyRead, tolls: SequenceToll[]) {
  const point = parseCoord(read.toll_plaza_geocode)
  if (point) {
    const near = tolls
      .map((toll) => {
        const plaza = parseCoord(toll.toll_plaza_geocode)
        return plaza ? { toll, km: distanceKm(point, plaza) } : null
      })
      .filter((item): item is { toll: SequenceToll, km: number } => !!item && item.km <= GEO_KM)
      .sort((a, b) => a.km - b.km)
    if (near.length === 1 || (near.length > 1 && near[1].km - near[0].km >= 0.4)) {
      return { kind: 'one' as const, toll: near[0].toll }
    }
    if (near.length > 1) return { kind: 'ambiguous' as const }
  }
  const named = tolls.filter((toll) => plazasMatch(toll.toll_plaza_name, read.toll_plaza_name || ''))
  if (named.length === 1) return { kind: 'one' as const, toll: named[0] }
  if (named.length > 1) return { kind: 'ambiguous' as const }
  return { kind: 'none' as const }
}

function tag<T extends QualifyRead>(row: T, route_match: RouteMatch, route_note: string) {
  return { ...row, route_match, route_note }
}

export function qualifyCrossings<T extends QualifyRead>(
  reads: T[],
  route: RouteSequence | null,
  options: Options = {},
): Array<T & { route_match: RouteMatch, route_note: string }> {
  const requireDirection = options.requireDirection !== false
  if (!route || !route.tolls.length) {
    const note = route
      ? 'This route has no configured toll sequence.'
      : 'Route could not be identified from the From and To locations.'
    return reads.map((row) => tag(row, 'unverified', note))
  }

  const tolls = [...route.tolls].sort((a, b) => a.seq_order - b.seq_order)
  const ordered = [...reads].sort((a, b) => stamp(a.reader_read_time) - stamp(b.reader_read_time) || Number(a.id || 0) - Number(b.id || 0))
  const seenSeq = new Set<string>()
  const result = new Map<T, { route_match: RouteMatch, route_note: string }>()
  const candidates: Array<{ row: T, seq: number }> = []

  for (const row of ordered) {
    const seqNo = String(row.seq_no || '').trim()
    if (seqNo) {
      if (seenSeq.has(seqNo)) {
        result.set(row, { route_match: 'repeat', route_note: 'Duplicate transaction for the same sequence number.' })
        continue
      }
      seenSeq.add(seqNo)
    }
    const matched = matchToll(row, tolls)
    if (matched.kind === 'ambiguous') {
      result.set(row, { route_match: 'ambiguous', route_note: 'This crossing matches more than one configured toll.' })
      continue
    }
    if (matched.kind === 'none') {
      result.set(row, { route_match: 'unmatched', route_note: 'This plaza is not on the configured route.' })
      continue
    }
    if (requireDirection && row.heading_code !== 'unloading') {
      const reverse = row.heading_code === 'loading'
      result.set(row, {
        route_match: reverse ? 'reverse' : 'unverified',
        route_note: reverse
          ? 'This crossing is towards the loading point, opposite the configured route.'
          : 'Direction could not be verified for this crossing.',
      })
      continue
    }
    if (requireDirection === false && row.heading_code === 'loading') {
      result.set(row, { route_match: 'reverse', route_note: 'This crossing is towards the loading point, opposite the configured route.' })
      continue
    }
    candidates.push({ row, seq: matched.toll.seq_order })
  }

  const strictlyReverse = candidates.length >= 2
    && candidates.every((item, index) => index === 0 || item.seq <= candidates[index - 1].seq)
    && candidates[candidates.length - 1].seq < candidates[0].seq
  let last = 0
  if (strictlyReverse) {
    for (const item of candidates) {
      result.set(item.row, { route_match: 'reverse', route_note: 'These crossings follow the route in reverse order.' })
    }
  } else {
    for (const item of candidates) {
      if (item.seq > last) {
        result.set(item.row, { route_match: 'qualifying', route_note: 'This crossing follows the configured route towards the unloading point.' })
        last = item.seq
      } else if (item.seq === last) {
        result.set(item.row, { route_match: 'repeat', route_note: 'This toll was already counted on the way to the unloading point.' })
      } else {
        result.set(item.row, { route_match: 'reverse', route_note: 'This crossing is out of the configured toll order.' })
      }
    }
  }

  return reads.map((row) => {
    const found = result.get(row)
    return found ? { ...row, ...found } : tag(row, 'unverified', 'This crossing was not checked.')
  })
}

export function qualifyReads<T extends QualifyRead>(
  reads: T[],
  routeFor: (row: T) => RouteSequence | null,
  options: Options = {},
) {
  const groups = new Map<string, { route: RouteSequence | null, rows: T[] }>()
  for (const row of reads) {
    const route = routeFor(row)
    const key = `${row.vehicle_reg_no || ''}|${row.vehicle_id ?? ''}|${route?.route_id ?? 'none'}`
    const group = groups.get(key) || { route, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  const tagged = new Map<T, T & { route_match: RouteMatch, route_note: string }>()
  for (const group of groups.values()) {
    const checked = qualifyCrossings(group.rows, group.route, options)
    group.rows.forEach((row, index) => tagged.set(row, checked[index]))
  }
  return reads.map((row) => tagged.get(row) || { ...row, route_match: 'unverified' as const, route_note: 'This crossing was not checked.' })
}
