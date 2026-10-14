import { Router } from 'express'
import multer from 'multer'
import { fail, okItem, okList } from '../utils/response.js'
import { countActivity, listActivity, logAction } from '../services/actionLog.js'
import { exportTripChecks, tripAudit } from '../services/audit.js'
import { can, hasPermission } from '../middleware/auth.js'
import {
  createBatch,
  extractSheetRows,
  getBatch,
  exportBatchExcel,
  exportReadsByIds,
  rejectedRowsWorkbook,
  getBatchDetail,
  isBatchRunning,
  listBatches,
  normalizePlate,
  searchStoredReads,
  listEnteredVehicles,
  queueBatch,
  queueRetryFailed,
  runBatch,
  readFetchWindow,
} from '../services/fastag.js'

const router = Router()
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
})

function actorOf(req: { user?: { id: number, email: string | null } }) {
  return { id: req.user!.id, email: req.user!.email ?? null }
}

router.post('/reads/export', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
  const file = await exportReadsByIds(ids, hasPermission(req.user?.permissions, 'admin'))
  if (!file) return fail(res, 'Select at least one toll record')
  await logAction({
    userId: req.user?.id,
    email: req.user?.email,
    actionType: 'export',
    itemType: 'fastag_reads',
    itemId: 'selected',
    note: `Exported ${file.count} selected toll records to ${file.filename}`,
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  return res.send(file.buffer)
})

router.get('/audit/export', async (req, res) => {
  try {
    const vehicle = String(req.query.vehicle || '')
    const focus = String(req.query.focus || '')
    const file = await exportTripChecks(vehicle, focus)
    await logAction({
      userId: req.user?.id,
      email: req.user?.email,
      actionType: 'export',
      itemType: 'trip_checks',
      itemId: vehicle || 'all',
      note: `Exported ${file.count} trip check rows to ${file.filename}`,
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    return res.send(file.buffer)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trip check export failed'
    return fail(res, message, 500)
  }
})

router.post('/audit/export', async (req, res) => {
  try {
    const vehicle = String(req.body?.vehicle || '')
    const focus = String(req.body?.focus || '')
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map((key: unknown) => String(key)) : []
    const file = await exportTripChecks(vehicle, focus, keys)
    await logAction({
      userId: req.user?.id,
      email: req.user?.email,
      actionType: 'export',
      itemType: 'trip_checks',
      itemId: vehicle || 'all',
      note: `Exported ${file.count} selected trip check rows to ${file.filename}`,
    })
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
    return res.send(file.buffer)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trip check export failed'
    return fail(res, message, 500)
  }
})

router.get('/audit', async (req, res) => {
  try {
    const result = await tripAudit(String(req.query.vehicle || ''))
    return okItem(res, result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Trip check failed'
    return fail(res, message, 500)
  }
})

router.get('/activity', can('activity'), async (req, res) => {
  const limit = Number(req.query.limit || 8)
  const offset = Number(req.query.offset || 0)
  const [rows, total] = await Promise.all([listActivity(limit, offset), countActivity()])
  return okList(res, rows, total)
})

router.post('/preview', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return fail(res, 'Choose an Excel or CSV file')
  const name = file.originalname || 'vehicles.xlsx'
  if (!/\.(xlsx|xls|csv)$/i.test(name)) return fail(res, 'Upload an .xlsx, .xls, or .csv file')
  try {
    const extracted = extractSheetRows(file.buffer)
    return okItem(res, {
      filename: name,
      total_rows: extracted.totalRows,
      valid_rows: extracted.rows.length,
      invalid_rows: extracted.errors.length,
      duplicate_rows: extracted.duplicates.length,
      rows: extracted.rows.slice(0, 25),
      errors: extracted.errors,
      duplicates: extracted.duplicates,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read the sheet'
    return fail(res, message)
  }
})

router.post('/rejected-export', async (req, res) => {
  const errors = Array.isArray(req.body?.errors) ? req.body.errors : []
  const duplicates = Array.isArray(req.body?.duplicates) ? req.body.duplicates : []
  const file = rejectedRowsWorkbook([...errors, ...duplicates])
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  return res.send(file.buffer)
})

router.get('/batches', async (_req, res) => {
  const rows = await listBatches()
  return okList(res, rows)
})

router.get('/entered', async (req, res) => {
  try {
    const rows = await listEnteredVehicles({
      vehicle: String(req.query.vehicle || req.query.q || ''),
      challan: String(req.query.challan || ''),
      project: String(req.query.project || ''),
      date: String(req.query.date || ''),
    })
    return okList(res, rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list vehicles'
    return fail(res, message)
  }
})

router.get('/records', async (req, res) => {
  try {
    const result = await searchStoredReads(String(req.query.vehicle || ''))
    return okList(res, result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed'
    return fail(res, message)
  }
})

router.get('/batches/:id/export', async (req, res) => {
  const file = await exportBatchExcel(Number(req.params.id), {
    q: String(req.query.q || ''),
    project: String(req.query.project || ''),
    plaza: String(req.query.plaza || ''),
    from: String(req.query.from || ''),
    to: String(req.query.to || ''),
    fromTime: String(req.query.fromTime || ''),
    toTime: String(req.query.toTime || ''),
    vehicles: String(req.query.vehicles || ''),
    heading: String(req.query.heading || ''),
  }, hasPermission(req.user?.permissions, 'admin'))
  if (!file) return fail(res, 'Sheet not found', 404)
  await logAction({
    userId: req.user?.id,
    email: req.user?.email,
    actionType: 'export',
    itemType: 'fastag_batch',
    itemId: req.params.id,
    note: file.filtered ? `Exported ${file.count} filtered rows to ${file.filename}` : `Exported ${file.filename}`,
  })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`)
  return res.send(file.buffer)
})

router.get('/batches/:id', async (req, res) => {
  const detail = await getBatchDetail(Number(req.params.id))
  if (!detail) return fail(res, 'Sheet not found', 404)
  return okItem(res, detail)
})

router.post('/batches', upload.single('file'), async (req, res) => {
  const file = req.file
  if (!file) return fail(res, 'Choose an Excel or CSV file')
  const name = file.originalname || 'vehicles.xlsx'
  if (!/\.(xlsx|xls|csv)$/i.test(name)) {
    return fail(res, 'Upload an .xlsx, .xls, or .csv file')
  }
  try {
    const extracted = extractSheetRows(file.buffer)
    if (!extracted.rows.length) {
      if (extracted.errors.length) return fail(res, extracted.errors.map((item) => item.message))
      return fail(res, 'No vehicle numbers found. Each row needs a vehicle number and a challan ID.')
    }
    const detail = await createBatch({
      filename: name,
      source: 'excel',
      uploadedBy: req.user?.id ?? null,
      rows: extracted.rows,
    })
    await logAction({
      userId: req.user?.id,
      email: req.user?.email,
      actionType: 'upload',
      itemType: 'fastag_batch',
      itemId: detail.batch.id,
      note: `Uploaded ${name} with ${detail.batch.vehicle_count} vehicles. Skipped ${extracted.errors.length} rows.`,
    })
    return okItem(res, { ...detail, rejected: extracted.errors }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not read the sheet'
    return fail(res, message)
  }
})

router.post('/batches/:id/fetch', async (req, res) => {
  const id = Number(req.params.id)
  const batch = await getBatch(id)
  if (!batch) return fail(res, 'Sheet not found', 404)
  if (batch.status === 'running' && isBatchRunning(id)) {
    return fail(res, 'This sheet is already being fetched', 409)
  }
  if (!String(process.env.FASTAG_ACCESS_TOKEN || '').trim()) {
    return fail(res, 'FASTAG_ACCESS_TOKEN is not set on the server', 500)
  }
  const started = await queueBatch(id, actorOf(req))
  if (!started) return fail(res, 'This sheet is already being fetched', 409)
  const fresh = await getBatch(id)
  return okItem(res, { started: true, batch: fresh }, 202)
})

router.post('/batches/:id/retry-failed', async (req, res) => {
  const id = Number(req.params.id)
  const batch = await getBatch(id)
  if (!batch) return fail(res, 'Sheet not found', 404)
  if (batch.status === 'running' && isBatchRunning(id)) {
    return fail(res, 'This sheet is already being fetched', 409)
  }
  if (!String(process.env.FASTAG_ACCESS_TOKEN || '').trim()) {
    return fail(res, 'FASTAG_ACCESS_TOKEN is not set on the server', 500)
  }
  const count = await queueRetryFailed(id, actorOf(req))
  if (!count) return fail(res, 'No failed vehicles to re-run')
  const fresh = await getBatch(id)
  return okItem(res, { started: true, count, batch: fresh }, 202)
})

router.post('/lookup', async (req, res) => {
  const plate = normalizePlate(req.body?.vehicleRegNo ?? req.body?.vehicle ?? '')
  if (!plate) return fail(res, 'Enter a vehicle number like CG13BF6032')
  const projectName = String(req.body?.projectName ?? req.body?.project_name ?? '').trim()
  const challanId = String(req.body?.challanId ?? req.body?.challan_id ?? '').trim()
  if (!projectName) return fail(res, 'Enter a project name')
  if (!challanId) return fail(res, 'Enter a challan ID')
  const tripId = String(req.body?.tripId ?? req.body?.trip_id ?? '').trim() || null
  if (!String(process.env.FASTAG_ACCESS_TOKEN || '').trim()) {
    return fail(res, 'FASTAG_ACCESS_TOKEN is not set on the server', 500)
  }
  let window
  try {
    window = readFetchWindow(req.body?.fromDate, req.body?.toDate)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Enter a valid date range'
    return fail(res, message)
  }
  try {
    const detail = await createBatch({
      filename: plate,
      source: 'manual',
      uploadedBy: req.user?.id ?? null,
      rows: [{
        vehicle_reg_no: plate,
        project_name: projectName,
        challan_id: challanId,
        trip_id: tripId,
        from_location: String(req.body?.fromLocation ?? req.body?.from_location ?? '').trim() || null,
        to_location: String(req.body?.toLocation ?? req.body?.to_location ?? '').trim() || null,
      }],
    })
    await runBatch(detail.batch.id, actorOf(req), window)
    const range = [window.from, window.to].filter(Boolean).join(' to ')
    await logAction({
      userId: req.user?.id,
      email: req.user?.email,
      actionType: 'lookup',
      itemType: 'vehicle',
      itemId: plate,
      note: range ? `Single lookup for ${plate} from ${range}` : `Single lookup for ${plate}`,
    })
    const done = await getBatchDetail(detail.batch.id)
    return okItem(res, done)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lookup failed'
    return fail(res, message, 500)
  }
})

export default router
