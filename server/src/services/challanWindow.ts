export type ChallanTrip = {
  id: number
  loaded_at: string | null
  planned_tolls?: PlannedToll[] | null
}

export const MAX_PLANNED_TOLLS = 10

export type PlannedToll = {
  name: string
  geocode: string | null
  at: string | null
}

export function listedTolls(planned: PlannedToll[] | null | undefined) {
  return (planned || [])
    .filter((toll) => toll.name.trim() || toll.geocode || toll.at)
    .slice(0, MAX_PLANNED_TOLLS)
}

export function parseLoadedAt(dateRaw: unknown, timeRaw: unknown) {
  const date = parseSheetDate(dateRaw)
  if (!date) return null
  return `${date} ${parseSheetTime(timeRaw) || '00:00:00'}`
}

export function assignChallan<T extends ChallanTrip>(vehicles: T[], readTime: string | null) {
  if (!vehicles.length) return null
  const dated = vehicles
    .map((vehicle) => ({ vehicle, start: stamp(vehicle.loaded_at) }))
    .filter((item): item is { vehicle: T, start: number } => item.start != null)
    .sort((a, b) => a.start - b.start || a.vehicle.id - b.vehicle.id)
  if (!dated.length) return vehicles.length === 1 ? vehicles[0] : null
  const at = stamp(readTime)
  if (at == null) return null
  let picked: T | null = null
  for (const item of dated) {
    if (item.start <= at) picked = item.vehicle
    else break
  }
  return picked
}

export function parsePlannedTollTime(dateRaw: unknown, timeRaw: unknown, loadedAt: string | null) {
  const date = parseSheetDate(dateRaw)
  const time = parseSheetTime(timeRaw)
  if (!date || !time) return null
  let at = `${date} ${time}`
  const loaded = stamp(loadedAt)
  const planned = stamp(at)
  if (loaded != null && planned != null && planned < loaded) at = `${nextIsoDay(date)} ${time}`
  return at
}

export function assignTripReads<T extends ChallanTrip, R>(
  vehicles: T[],
  reads: { time: string | null, name: string | null, geocode?: string | null, record: R }[],
): Map<number, R[]> {
  const result = new Map<number, R[]>()
  for (const vehicle of vehicles) result.set(vehicle.id, [])
  const ordered = [...reads].sort((a, b) => (stamp(a.time) ?? Number.POSITIVE_INFINITY) - (stamp(b.time) ?? Number.POSITIVE_INFINITY))
  const dated = vehicles
    .map((vehicle) => ({ vehicle, start: stamp(vehicle.loaded_at) }))
    .filter((item): item is { vehicle: T, start: number } => item.start != null)
    .sort((a, b) => a.start - b.start || a.vehicle.id - b.vehicle.id)
  if (!dated.length) {
    if (vehicles.length === 1) result.set(vehicles[0].id, ordered.map((read) => read.record))
    return result
  }
  const used = new Set<number>()
  dated.forEach((item, index) => {
    const end = dated[index + 1]?.start ?? Number.POSITIVE_INFINITY
    const planned = listedTolls(item.vehicle.planned_tolls)
    const windowReads = ordered.filter((read, readIndex) => {
      if (used.has(readIndex)) return false
      const at = stamp(read.time)
      return at != null && at >= item.start && at < end
    })
    if (planned.length >= 2 && tollPassIsReverse(planned, windowReads)) {
      ordered.forEach((read, readIndex) => {
        if (used.has(readIndex)) return
        const at = stamp(read.time)
        if (at == null || at < item.start || at >= end) return
        used.add(readIndex)
      })
      result.set(item.vehicle.id, [])
      return
    }
    const mine: R[] = []
    if (!planned.length) {
      ordered.forEach((read, readIndex) => {
        if (used.has(readIndex)) return
        const at = stamp(read.time)
        if (at == null || at < item.start || at >= end) return
        used.add(readIndex)
        mine.push(read.record)
      })
    } else {
      let step = 0
      for (let readIndex = 0; readIndex < ordered.length && step < planned.length; readIndex += 1) {
        if (used.has(readIndex)) continue
        const read = ordered[readIndex]
        const at = stamp(read.time)
        if (at == null || at < item.start || at >= end) continue
        if (!tollSlotMatches(planned[step], read.name, read.geocode)) continue
        used.add(readIndex)
        mine.push(read.record)
        step += 1
      }
      if (step >= planned.length) {
        ordered.forEach((read, readIndex) => {
          if (used.has(readIndex)) return
          const at = stamp(read.time)
          if (at == null || at < item.start || at >= end) return
          used.add(readIndex)
        })
      }
    }
    result.set(item.vehicle.id, mine)
  })
  return result
}

export function tollPassIsReverse(planned: PlannedToll[], reads: { time: string | null, name: string | null, geocode?: string | null }[]) {
  const named = listedTolls(planned).filter((toll) => toll.name.trim() || toll.geocode)
  if (named.length < 2) return false
  const ordered = [...reads].sort((a, b) => (stamp(a.time) ?? Number.POSITIVE_INFINITY) - (stamp(b.time) ?? Number.POSITIVE_INFINITY))
  const first = named.map(() => null as number | null)
  for (const read of ordered) {
    const at = stamp(read.time)
    if (at == null) continue
    named.forEach((toll, index) => {
      if (first[index] != null) return
      if (tollSlotMatches(toll, read.name, read.geocode)) first[index] = at
    })
  }
  for (let earlier = 0; earlier < named.length; earlier += 1) {
    for (let later = earlier + 1; later < named.length; later += 1) {
      if (first[earlier] != null && first[later] != null && first[later]! < first[earlier]!) return true
    }
  }
  return false
}

function tollSlotMatches(planned: PlannedToll, name: string | null | undefined, geocode: string | null | undefined) {
  const named = planned.name.trim()
  if (!named && !planned.geocode) return true
  if (planned.geocode && geoNear(planned.geocode, geocode)) return true
  if (named && plazaNamesMatch(named, name || '')) return true
  return false
}

function geoNear(expected: string | null | undefined, actual: string | null | undefined) {
  const left = parseCoord(expected)
  const right = parseCoord(actual)
  if (!left || !right) return false
  return distanceKm(left, right) <= 1.5
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

export function plazaNamesMatch(expected: string, actual: string) {
  const left = plazaKey(expected)
  const right = plazaKey(actual)
  if (!left || !right) return false
  if (left === right) return true
  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  return shorter.length >= 4 && longer.includes(shorter)
}

function plazaKey(name: string) {
  return name.toLowerCase().replace(/toll\s*plaza/g, '').replace(/[^a-z0-9]/g, '')
}

function nextIsoDay(iso: string) {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return iso
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  at.setUTCDate(at.getUTCDate() + 1)
  return at.toISOString().slice(0, 10)
}

function parseSheetDate(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const local = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/)
  if (!local) return null
  let day = Number(local[1])
  let month = Number(local[2])
  let year = Number(local[3])
  if (year < 100) year += 2000
  if (month > 12 && day >= 1 && day <= 12) {
    const swapped = day
    day = month
    month = swapped
  }
  if (day < 1 || day > 31 || month < 1 || month > 12) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseSheetTime(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/)
  if (!match) return null
  let hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3] || 0)
  const meridiem = match[4]?.toLowerCase()
  if (minute > 59 || second > 59) return null
  if (meridiem) {
    if (hour < 1 || hour > 12) return null
    if (meridiem === 'am') hour = hour === 12 ? 0 : hour
    if (meridiem === 'pm') hour = hour === 12 ? 12 : hour + 12
  } else if (hour > 23) {
    return null
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
}

function stamp(value: string | null | undefined) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = text.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/)
  if (!match) return null
  const clock = match[2].length === 5 ? `${match[2]}:00` : match[2]
  const at = Date.parse(`${match[1]}T${clock}`)
  return Number.isFinite(at) ? at : null
}
