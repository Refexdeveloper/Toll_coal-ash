import { Router } from 'express'
import { requireAdmin } from '../middleware/auth.js'
import { fail, okItem } from '../utils/response.js'
import { listRoles, saveGpsRole } from '../services/roles.js'
import { ensureAppColumns } from '../db/ensure.js'
import { runPendingSchemaMigrations } from '../services/schemaMigrate.js'
import { logAction } from '../services/actionLog.js'

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
