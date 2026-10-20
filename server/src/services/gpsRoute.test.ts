import assert from 'node:assert/strict'
import test from 'node:test'
import { haversineKm, routeWindow, summarizeRoute } from './gpsRoute.js'

test('a route window covers one day or a from-to range', () => {
  assert.deepEqual(routeWindow('2026-10-13', '2026-10-15', '08:00', '18:30'), {
    start: '2026-10-13 08:00:00',
    end: '2026-10-15 18:30:59',
  })
  assert.equal(routeWindow('2026-10-15').end, '2026-10-15 23:59:59')
  assert.throws(() => routeWindow('2026-10-15', '2026-10-13'), /from date/)
})

test('estimated distance follows stored points in order and does not add extra points', () => {
  const points = [
    { lat: 21.25, lon: 81.63, gps_time: '2026-10-15 08:00:00' },
    { lat: 21.35, lon: 81.63, gps_time: '2026-10-15 10:00:00' },
    { lat: 21.45, lon: 81.63, gps_time: '2026-10-15 12:00:00' },
  ]
  const summary = summarizeRoute(points)
  assert.equal(summary.points, 3)
  assert.equal(summary.first_gps_time, '2026-10-15 08:00:00')
  assert.equal(summary.last_gps_time, '2026-10-15 12:00:00')
  const direct = haversineKm(21.25, 81.63, 21.45, 81.63)
  const stepped = haversineKm(21.25, 81.63, 21.35, 81.63) + haversineKm(21.35, 81.63, 21.45, 81.63)
  assert.ok(Math.abs(summary.estimated_distance_km - Math.round(stepped * 100) / 100) < 0.02)
  assert.ok(Math.abs(stepped - direct) < 0.2)
})
