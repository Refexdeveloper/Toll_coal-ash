export type RoutePoint = {
  lat: number
  lon: number
  gps_time?: string | null
}

export function routeWindow(fromDate: string, toDate = '', fromTime = '', toTime = '') {
  const endDate = toDate || fromDate
  const start = fromTime
    ? `${fromDate} ${fromTime.length === 5 ? `${fromTime}:00` : fromTime}`
    : `${fromDate} 00:00:00`
  const end = toTime
    ? `${endDate} ${toTime.length === 5 ? `${toTime}:59` : toTime}`
    : `${endDate} 23:59:59`
  if (start > end) throw new Error('The from date must be on or before the to date')
  return { start, end }
}

export function validCoordinate(lat: number, lon: number) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const earthKm = 6371
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * earthKm * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function summarizeRoute(points: RoutePoint[]) {
  const usable = points.filter((point) => validCoordinate(point.lat, point.lon))
  let km = 0
  for (let index = 1; index < usable.length; index += 1) {
    km += haversineKm(usable[index - 1].lat, usable[index - 1].lon, usable[index].lat, usable[index].lon)
  }
  return {
    points: usable.length,
    first_gps_time: usable[0]?.gps_time || null,
    last_gps_time: usable[usable.length - 1]?.gps_time || null,
    estimated_distance_km: Math.round(km * 100) / 100,
  }
}
