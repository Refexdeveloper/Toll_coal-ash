import assert from 'node:assert/strict'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { assignChallan, assignTripReads, parseLoadedAt, tollPassIsReverse } from './challanWindow.js'
import { extractSheetRows } from './fastag.js'

test('sheet date and loading time become a trip start', () => {
  assert.equal(parseLoadedAt('11-10-26', '12:35 AM'), '2026-10-11 00:35:00')
  assert.equal(parseLoadedAt('11-10-26', '2:01 AM'), '2026-10-11 02:01:00')
  assert.equal(parseLoadedAt('11-10-26', '12:40 PM'), '2026-10-11 12:40:00')
  assert.equal(parseLoadedAt('11-10-26', '5:40 PM'), '2026-10-11 17:40:00')
  assert.equal(parseLoadedAt('10/23/26', '2:19'), '2026-10-23 02:19:00')
  assert.equal(parseLoadedAt('10/25/26', '3:03'), '2026-10-25 03:03:00')
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

test('a trip closes when the tolls listed on that row have been passed', () => {
  const trips = [
    {
      id: 1,
      loaded_at: '2026-10-22 06:00:00',
      planned_tolls: [
        { name: 'Chandrapur', geocode: null, at: '2026-10-22 07:10:00' },
        { name: 'Ballarpur', geocode: null, at: '2026-10-22 08:20:00' },
      ],
    },
    {
      id: 2,
      loaded_at: '2026-10-22 18:00:00',
      planned_tolls: [{ name: 'Wani', geocode: null, at: null }],
    },
  ]
  const reads = [
    { time: '2026-10-22 05:00:00', name: 'Chandrapur', record: 'before' },
    { time: '2026-10-22 07:05:00', name: 'Chandrapur Toll Plaza', record: 'first' },
    { time: '2026-10-22 08:15:00', name: 'Ballarpur', record: 'second' },
    { time: '2026-10-22 09:00:00', name: 'Wani', record: 'early-next' },
    { time: '2026-10-22 19:10:00', name: 'Wani Toll Plaza', record: 'next' },
  ]
  const assigned = assignTripReads(trips, reads)
  assert.deepEqual(assigned.get(1), ['first', 'second'])
  assert.deepEqual(assigned.get(2), ['next'])
})

test('outbound toll 1 then toll 2 completes and the return pass is ignored', () => {
  const trips = [
    {
      id: 1,
      loaded_at: '2026-11-02 06:09:00',
      planned_tolls: [
        { name: 'Khairamunda Toll Plaza', geocode: null, at: null },
        { name: 'Srirampur Toll Plaza', geocode: null, at: null },
      ],
    },
    {
      id: 2,
      loaded_at: '2026-11-02 20:00:00',
      planned_tolls: [
        { name: 'Khairamunda Toll Plaza', geocode: null, at: null },
        { name: 'Srirampur Toll Plaza', geocode: null, at: null },
      ],
    },
  ]
  const reads = [
    { time: '2026-11-02 07:00:00', name: 'Khairamunda Toll Plaza', record: 'out-1' },
    { time: '2026-11-02 08:00:00', name: 'Srirampur Toll Plaza', record: 'out-2' },
    { time: '2026-11-02 18:00:00', name: 'Srirampur Toll Plaza', record: 'back-2' },
    { time: '2026-11-02 19:00:00', name: 'Khairamunda Toll Plaza', record: 'back-1' },
  ]
  const assigned = assignTripReads(trips, reads)
  assert.deepEqual(assigned.get(1), ['out-1', 'out-2'])
  assert.deepEqual(assigned.get(2), [])
})

test('toll 2 before toll 1 is not kept for the Excel', () => {
  const trips = [
    {
      id: 1,
      loaded_at: '2026-10-22 06:00:00',
      planned_tolls: [
        { name: 'Chandrapur', geocode: null, at: null },
        { name: 'Ballarpur', geocode: null, at: null },
      ],
    },
  ]
  const reads = [
    { time: '2026-10-22 07:00:00', name: 'Ballarpur', record: 'toll-2' },
    { time: '2026-10-22 08:00:00', name: 'Chandrapur Toll Plaza', record: 'toll-1' },
  ]
  const assigned = assignTripReads(trips, reads)
  assert.deepEqual(assigned.get(1), [])
  assert.equal(tollPassIsReverse(trips[0].planned_tolls, reads), true)
})

test('a trip can list up to ten tolls and closes after the ones that are filled', () => {
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
  const trips = [{
    id: 1,
    loaded_at: '2026-10-22 06:00:00',
    planned_tolls: names.map((name) => ({ name, geocode: null, at: null })),
  }]
  const reads = names.map((name, index) => ({
    time: `2026-10-22 ${String(7 + index).padStart(2, '0')}:00:00`,
    name,
    record: name,
  }))
  reads.push({ time: '2026-10-22 18:00:00', name: 'Extra', record: 'Extra' })
  const assigned = assignTripReads(trips, reads)
  assert.deepEqual(assigned.get(1), names)

  const header = ['S.No', 'Date', 'Project Name', 'Challan No', 'Vehicle No', 'Loading time', 'From', 'To']
  const filled = ['1', '22-10-2026', 'YTC Tachnir', '1', 'MH12AB1234', '6:00', 'YTC Tachnir', 'Chandrapur']
  for (let index = 1; index <= 10; index += 1) {
    header.push(`TOLL NAME ${index}`, `GEOCODE ${index}`, `TIMING ${index}`)
    filled.push(index <= 7 ? names[index - 1] : '', index <= 7 ? `19.${index},79.${index}` : '', index <= 7 ? `${6 + index}:10` : '')
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([header, filled]), 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.equal(extracted.rows[0].planned_tolls?.length, 7)
  assert.equal(extracted.rows[0].planned_tolls?.[6].name, 'Seven')
  const seven = assignTripReads(
    [{ id: 1, loaded_at: extracted.rows[0].loaded_at ?? null, planned_tolls: extracted.rows[0].planned_tolls }],
    reads,
  )
  assert.deepEqual(seven.get(1), names.slice(0, 7))

  const reverse = [...reads].reverse().map((read, index) => ({ ...read, time: `2026-10-22 ${String(7 + index).padStart(2, '0')}:30:00` }))
  assert.deepEqual(assignTripReads(trips, reverse).get(1), [])
})

test('Toll 1 to Toll 3 columns are kept and Update columns are ignored on upload', () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['S.No.', 'Date', 'Project Name', 'Project Site', 'Challan No', 'Vehicle No.', 'Vehicle Owner', 'Loading Time', 'Chainage', 'From', 'To', 'Toll 1', 'Toll 2', 'Toll 3', 'Toll 1 Update', 'Toll 2 Update', 'Toll 3 Update', 'Status'],
    ['1', '02-11-2026', 'NTPC Talchar B2B', 'Talchar', '612', 'OD35K0971', 'Outsourced', '06:09', '', 'NTPC Talchar', 'Chandikole-Paradip Package 4', 'Khairamunda Toll Plaza', 'Srirampur Toll Plaza', '', '', '', '', ''],
  ])
  XLSX.utils.book_append_sheet(book, sheet, 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.equal(extracted.rows.length, 1)
  assert.equal(extracted.rows[0].loaded_at, '2026-11-02 06:09:00')
  assert.deepEqual(extracted.rows[0].planned_tolls, [
    { name: 'Khairamunda Toll Plaza', geocode: null, at: null },
    { name: 'Srirampur Toll Plaza', geocode: null, at: null },
  ])
})

test('a sheet keeps the tolls written on each trip row', () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['S.No', 'Date', 'Project Name', 'Challan No', 'Vehicle No', 'Loading time', 'From', 'To', 'TOLL NAME 1', 'TIMING', 'TOLL NAME 2', 'TIMING'],
    ['1', '22-10-2026', 'YTC Tachnir', '1', 'MH12AB1234', '6:00', 'YTC Tachnir', 'Chandrapur', 'Chandrapur', '7:10', 'Ballarpur', '8:20'],
  ])
  XLSX.utils.book_append_sheet(book, sheet, 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.equal(extracted.rows.length, 1)
  assert.equal(extracted.rows[0].loaded_at, '2026-10-22 06:00:00')
  assert.deepEqual(extracted.rows[0].planned_tolls, [
    { name: 'Chandrapur', geocode: null, at: '2026-10-22 07:10:00' },
    { name: 'Ballarpur', geocode: null, at: '2026-10-22 08:20:00' },
  ])
})

test('a trip row keeps toll name, geocode, and passed time together', () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['S.No', 'Date', 'Project Name', 'Challan No', 'Vehicle No', 'Loading time', 'From', 'To', 'TOLL NAME 1', 'GEOCODE', 'TIMING', 'TOLL NAME 2', 'GEOCODE', 'TIMING'],
    ['1', '22-10-2026', 'YTC Tachnir', '1', 'MH12AB1234', '6:00', 'YTC Tachnir', 'Chandrapur', 'Chandrapur', '19.9612,79.2965', '7:10', 'Ballarpur', '19.8500,79.3500', '8:20'],
  ])
  XLSX.utils.book_append_sheet(book, sheet, 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.deepEqual(extracted.rows[0].planned_tolls, [
    { name: 'Chandrapur', geocode: '19.9612,79.2965', at: '2026-10-22 07:10:00' },
    { name: 'Ballarpur', geocode: '19.8500,79.3500', at: '2026-10-22 08:20:00' },
  ])
})

test('a month-first sheet date and a spaced To heading are kept', () => {
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([
    ['S.No.', 'Date', 'Project Name', 'Challan No', 'Vehicle No.', 'Loading Time', 'From', 'To '],
    ['1', '10/23/26', 'CSPGCL-2', '2577', 'CG12BQ9917', '2:19', 'CSPGCL Marwa', 'MBPL Drug'],
  ])
  XLSX.utils.book_append_sheet(book, sheet, 'Trips')
  const extracted = extractSheetRows(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer)
  assert.equal(extracted.rows.length, 1)
  assert.equal(extracted.rows[0].loaded_at, '2026-10-23 02:19:00')
  assert.equal(extracted.rows[0].to_location, 'MBPL Drug')
})
