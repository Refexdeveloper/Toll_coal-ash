import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { assignChallan, parseLoadedAt } from './challanWindow.js'
import { extractSheetRows } from './fastag.js'

test('sheet date and loading time become a trip start', () => {
  assert.equal(parseLoadedAt('11-10-26', '12:35 AM'), '2026-10-11 00:35:00')
  assert.equal(parseLoadedAt('11-10-26', '2:01 AM'), '2026-10-11 02:01:00')
  assert.equal(parseLoadedAt('11-10-26', '12:40 PM'), '2026-10-11 12:40:00')
  assert.equal(parseLoadedAt('11-10-26', '5:40 PM'), '2026-10-11 17:40:00')
})

test('a toll is given to one challan and does not overlap the next trip', () => {
  const trips = [
    { id: 1, challan_id: '1937', loaded_at: '2026-10-11 02:01:00' },
    { id: 2, challan_id: '1947', loaded_at: '2026-10-11 07:45:00' },
  ]
  assert.equal(assignChallan(trips, '2026-10-11 01:30:00'), null)
  assert.equal(assignChallan(trips, '2026-10-11 02:01:00')?.id, 1)
  assert.equal(assignChallan(trips, '2026-10-11 03:10:00')?.id, 1)
  assert.equal(assignChallan(trips, '2026-10-11 07:45:00')?.id, 2)
  assert.equal(assignChallan(trips, '2026-10-12 06:00:00')?.id, 2)
})

test('two challans without a loading time are not both given the same toll', () => {
  const trips = [
    { id: 1, loaded_at: null },
    { id: 2, loaded_at: null },
  ]
  assert.equal(assignChallan(trips, '2026-10-11 03:10:00'), null)
  assert.equal(assignChallan([{ id: 9, loaded_at: null }], '2026-10-11 03:10:00')?.id, 9)
})

test('an imported sheet keeps each challan on its own vehicle and loading time', () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['S.No.', 'Date', 'Project Name', 'Project Site', 'Challan No', 'Vehicle No.', 'Vehicle Owner', 'Loading Time', 'Chainage', 'From', 'To'],
    ['1', '11-10-26', 'NTPC Lara LL4', 'LARA', '1937', 'CG13BC9715', 'Outsourced', '2:01 AM', '200 Kms', 'NTPC Lara', 'Palari'],
    ['2', '11-10-26', 'NTPC Lara LL4', 'LARA', '1947', 'CG13BC9715', 'Outsourced', '7:45 AM', '200 Kms', 'NTPC Lara', 'Palari'],
    ['3', '11-10-26', 'NTPC Lara LL4', 'LARA', '1937', 'CG13BA9146', 'Outsourced', '2:05 AM', '200 Kms', 'NTPC Lara', 'Palari'],
  ])
  XLSX.utils.book_append_sheet(book, sheet, 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.deepEqual(extracted.rows.map((row) => [row.vehicle_reg_no, row.challan_id, row.project_name, row.loaded_at]), [
    ['CG13BC9715', '1937', 'NTPC Lara LL4', '2026-10-11 02:01:00'],
    ['CG13BC9715', '1947', 'NTPC Lara LL4', '2026-10-11 07:45:00'],
  ])
  assert.equal(extracted.duplicates.length, 1)
  assert.match(extracted.duplicates[0].message, /already used by CG13BC9715/)
})
