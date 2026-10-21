import { Router } from 'express'
import { requireAdmin } from '../middleware/auth.js'
import { fail, okItem } from '../utils/response.js'
import { listRoles, saveGpsRole } from '../services/roles.js'
import { ensureAppColumns } from '../db/ensure.js'
import { runPendingSchemaMigrations } from '../services/schemaMigrate.js'
import { logAction } from '../services/actionLog.js'
import { collectionStatus, runCollectionNow, saveCollectionSettings } from '../services/gpsScheduler.js'

const router = Router()
router.use(requireAdmin)

router.get('/roles', async (_req, res) => {
  return okItem(res, await listRoles())
})

router.put('/roles', async (req, res) => {
  const gps = req.body?.gps || req.body?.permissions
  if (!gps || typeof gps !== 'object') return fail(res, 'Send the GPS Team module access')
  const roles = await saveGpsRole(gps as Record<string, unknown>)
  await logAction({
    userId: req.user?.id,
    email: req.user?.email,
    actionType: 'role_update',
    itemType: 'role',
    itemId: 'gps',
    note: 'Updated GPS Team module access',
  })
  return okItem(res, roles)
})

router.get('/gps-collection', async (_req, res) => {
  return okItem(res, await collectionStatus())
})

router.put('/gps-collection', async (req, res) => {
  const enabled = req.body?.enabled !== false && req.body?.enabled !== 0 && req.body?.enabled !== '0'
  const intervalMinutes = Number(req.body?.interval_minutes ?? req.body?.intervalMinutes ?? 120)
  const speedThreshold = Number(req.body?.speed_threshold ?? req.body?.speedThreshold ?? 1)
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 15 || intervalMinutes > 1440) {
    return fail(res, 'The collection interval must be between 15 minutes and 24 hours')
  }
  if (!Number.isFinite(speedThreshold) || speedThreshold < 0 || speedThreshold > 200) {
    return fail(res, 'The movement speed must be between 0 and 200 km/h')
  }
  const settings = await saveCollectionSettings({
    enabled,
    intervalMinutes,
    speedThreshold,
    userId: req.user?.id ?? null,
  })
  await logAction({
    userId: req.user?.id,
    email: req.user?.email,
    actionType: 'update',
    itemType: 'gps_collection',
    itemId: 'settings',
    note: `Automatic GPS history ${settings.enabled ? 'enabled' : 'paused'}, every ${settings.intervalMinutes} minutes, moving at ${settings.speedThreshold} km/h or more`,
  })
  return okItem(res, await collectionStatus())
})

router.post('/gps-collection/run', async (_req, res) => {
  try {
    const result = await runCollectionNow()
    if (result && result.started === false) return fail(res, result.reason || 'A collection is already running', 409)
    return okItem(res, { ...(result || {}), status: await collectionStatus() })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GPS history collection failed'
    return fail(res, message, 500)
  }
})

router.post('/migrate', async (req, res) => {
  const schema = await runPendingSchemaMigrations()
  await ensureAppColumns()
  await logAction({
    userId: req.user?.id,
    email: req.user?.email,
    actionType: 'db_migrate',
    itemType: 'database',
    note: `Applied ${schema.applied.length} schema file${schema.applied.length === 1 ? '' : 's'}. ${schema.table_count} tables.`,
  })
  return okItem(res, {
    applied: schema.applied,
    skipped: schema.skipped,
    table_count: schema.table_count,
    columns_ready: true,
  })
})

export default router
