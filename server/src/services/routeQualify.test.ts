import assert from 'node:assert/strict'
import test from 'node:test'
import { qualifyCrossings, type SequenceToll } from './routeQualify.js'

const tolls: SequenceToll[] = [
  { seq_order: 1, toll_plaza_name: 'Dhank Toll Plaza', toll_plaza_geocode: '21.30, 81.70' },
  { seq_order: 2, toll_plaza_name: 'Simga Toll Plaza', toll_plaza_geocode: '21.60, 81.70' },
  { seq_order: 3, toll_plaza_name: 'Pali Toll Plaza', toll_plaza_geocode: '21.90, 81.70' },
]

const route = { route_id: 1, tolls }

function read(id: number, name: string, time: string, heading: 'loading' | 'unloading' | 'unknown', seq = String(id), geo?: string) {
  const toll = tolls.find((item) => item.toll_plaza_name.startsWith(name))
  return {
    id,
    vehicle_reg_no: 'CG01AB1234',
    seq_no: seq,
    reader_read_time: time,
    toll_plaza_name: toll?.toll_plaza_name || name,
    toll_plaza_geocode: geo === undefined ? toll?.toll_plaza_geocode : geo,
    heading_code: heading,
  }
}

test('forward sequence qualifies in configured order', () => {
  const rows = qualifyCrossings([
    read(1, 'Dhank', '2026-10-14 08:00:00', 'unloading'),
    read(2, 'Simga', '2026-10-14 09:00:00', 'unloading'),
    read(3, 'Pali', '2026-10-14 10:00:00', 'unloading'),
  ], route)
  assert.deepEqual(rows.map((row) => row.route_match), ['qualifying', 'qualifying', 'qualifying'])
})

test('reverse sequence is excluded', () => {
  const rows = qualifyCrossings([
    read(1, 'Pali', '2026-10-14 08:00:00', 'loading'),
    read(2, 'Simga', '2026-10-14 09:00:00', 'loading'),
    read(3, 'Dhank', '2026-10-14 10:00:00', 'loading'),
  ], route)
  assert.ok(rows.every((row) => row.route_match === 'reverse'))
})

test('a later return crossing of the same toll is not counted again', () => {
  const rows = qualifyCrossings([
    read(1, 'Simga', '2026-10-14 08:00:00', 'unloading'),
    read(2, 'Simga', '2026-10-14 18:00:00', 'loading', '2'),
  ], route)
  assert.equal(rows[0].route_match, 'qualifying')
  assert.equal(rows[1].route_match, 'reverse')
})

test('a partial journey keeps the crossings that were made', () => {
  const rows = qualifyCrossings([
    read(1, 'Dhank', '2026-10-14 08:00:00', 'unloading'),
    read(2, 'Pali', '2026-10-14 11:00:00', 'unloading'),
  ], route)
  assert.deepEqual(rows.map((row) => row.route_match), ['qualifying', 'qualifying'])
})

test('duplicate sequence numbers are not counted twice', () => {
  const rows = qualifyCrossings([
    read(1, 'Dhank', '2026-10-14 08:00:00', 'unloading', 'SAME'),
    read(2, 'Dhank', '2026-10-14 08:05:00', 'unloading', 'SAME'),
  ], route)
  assert.equal(rows[0].route_match, 'qualifying')
  assert.equal(rows[1].route_match, 'repeat')
})

test('an unverified direction is not treated as valid', () => {
  const rows = qualifyCrossings([
    read(1, 'Dhank', '2026-10-14 08:00:00', 'unknown'),
  ], route)
  assert.equal(rows[0].route_match, 'unverified')
})

test('a missing route stays unverified', () => {
  const rows = qualifyCrossings([
    read(1, 'Dhank', '2026-10-14 08:00:00', 'unloading'),
  ], null)
  assert.equal(rows[0].route_match, 'unverified')
})

test('geocode identifies the plaza when the name does not', () => {
  const rows = qualifyCrossings([
    read(1, 'Unknown Plaza', '2026-10-14 08:00:00', 'unloading', '1', '21.30, 81.70'),
  ], route)
  assert.equal(rows[0].route_match, 'qualifying')
})

test('a strictly reverse series is excluded even without a heading', () => {
  const rows = qualifyCrossings([
    { ...read(1, 'Pali', '2026-10-14 08:00:00', 'unloading'), heading_code: undefined },
    { ...read(2, 'Simga', '2026-10-14 09:00:00', 'unloading'), heading_code: undefined },
    { ...read(3, 'Dhank', '2026-10-14 10:00:00', 'unloading'), heading_code: undefined },
  ], route, { requireDirection: false })
  assert.ok(rows.every((row) => row.route_match === 'reverse'))
})
