import assert from 'node:assert/strict'
import test from 'node:test'
import { autoSnapshotKey, collectionIsDue, isMoving } from './gpsCollect.js'

test('an explicit movement flag is used before speed', () => {
  assert.equal(isMoving({ spd: 0, moving: true }, 1), true)
  assert.equal(isMoving({ spd: 40, status: 'stopped' }, 1), false)
  assert.equal(isMoving({ spd: 18 }, 1), true)
  assert.equal(isMoving({ spd: 0 }, 1), false)
})

test('the same automatic snapshot key is stable for a retry', () => {
  assert.equal(autoSnapshotKey('CG04NU2465', '2026-10-15 10:00:00', true, 24.1, 82.6), 'CG04NU2465|2026-10-15 10:00:00')
  assert.equal(
    autoSnapshotKey('CG04NU2465', '2026-10-15 10:00:00', true, 24.1, 82.6),
    autoSnapshotKey('CG04NU2465', '2026-10-15 10:00:00', true, 24.2, 82.7),
  )
})

test('collection waits for the configured interval and does not overlap a live run', () => {
  const now = new Date('2026-10-15T12:00:00Z')
  assert.equal(collectionIsDue({ enabled: true, intervalMinutes: 120, lastStartedAt: null, lastStatus: null, now }), true)
  assert.equal(collectionIsDue({
    enabled: true,
    intervalMinutes: 120,
    lastStartedAt: '2026-10-15 11:00:00',
    lastStatus: 'ok',
    now,
  }), false)
  assert.equal(collectionIsDue({
    enabled: true,
    intervalMinutes: 120,
    lastStartedAt: '2026-10-15 09:00:00',
    lastStatus: 'ok',
    now,
  }), true)
  assert.equal(collectionIsDue({
    enabled: true,
    intervalMinutes: 120,
    lastStartedAt: '2026-10-15 11:50:00',
    lastStatus: 'running',
    now,
  }), false)
  assert.equal(collectionIsDue({
    enabled: false,
    intervalMinutes: 120,
    lastStartedAt: '2026-10-15 09:00:00',
    lastStatus: 'ok',
    now,
  }), false)
})
