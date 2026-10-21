export type ChallanTrip = {
  id: number
  loaded_at: string | null
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

function parseSheetDate(value: unknown) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const local = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/)
  if (!local) return null
  const day = Number(local[1])
  const month = Number(local[2])
  let year = Number(local[3])
  if (year < 100) year += 2000
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
