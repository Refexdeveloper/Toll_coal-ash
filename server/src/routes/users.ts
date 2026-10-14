import { Router } from 'express'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'
import { all, get, now, run } from '../db/index.js'
import { clock } from '../utils/clock.js'
import { fail, okItem, okList, okMessage } from '../utils/response.js'
import { transformUser } from '../services/users.js'
import { requireAdmin } from '../middleware/auth.js'
import { permissionsFor } from '../services/roles.js'
import { logAction } from '../services/actionLog.js'

const router = Router()
router.use(requireAdmin)

router.get('/', async (_req, res) => {
  const rows = await all<{ id: number }>(`
    SELECT id FROM users WHERE deleted_at IS NULL ORDER BY id
  `)
  const users = []
  for (const r of rows) {
    users.push(await transformUser(r.id))
  }
  return okList(res, users)
})

router.post('/export', async (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0))] as number[]
  if (!ids.length) return fail(res, 'Select at least one user')
  const users = (await Promise.all(ids.map((id) => transformUser(id)))).filter((user) => user != null)
  if (!users.length) return fail(res, 'Select at least one user')
  const sheet = XLSX.utils.json_to_sheet(users.map((user) => ({
    Name: user.name,
    Email: user.email || '',
    Username: user.username || '',
    Role: user.is_admin ? 'Admin' : 'GPS Team',
    Title: user.jobtitle || '',
    Region: user.region_key || '',
    Status: user.activated ? 'Active' : 'Inactive',
    'Last login': user.last_login || '',
  })))
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Users')
  const filename = `users-${clock().replace(/[: ]/g, '-')}.xlsx`
  await logAction({ userId: req.user?.id, email: req.user?.email, actionType: 'export', itemType: 'users', itemId: 'selected', note: `Exported ${users.length} users to ${filename}` })
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
  return res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
})

router.get('/:id', async (req, res) => {
  const user = await transformUser(Number(req.params.id))
  if (!user) return fail(res, 'Not found', 404)
  return okItem(res, user)
})

router.post('/', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const username = String(req.body?.username || email.split('@')[0] || '').trim()
  const first = String(req.body?.first_name || '').trim()
  const last = String(req.body?.last_name || '').trim()
  const password = String(req.body?.password || 'Sales@3i')
  if (!email || !first) return fail(res, 'Email and first name are required')
  const exists = await get(`SELECT id FROM users WHERE email = ? OR username = ?`, [email, username])
  if (exists) return fail(res, 'Email or username already exists')

  const role = String(req.body?.role || '')
  const perms = JSON.stringify(role === 'admin' || role === 'gps'
    ? await permissionsFor(role)
    : (req.body?.permissions || await permissionsFor('gps')))
  const jobtitle = role === 'admin' ? 'Administrator' : (role === 'gps' ? 'GPS Team' : String(req.body?.jobtitle || 'GPS Team'))
  const ts = now()
  const info = await run(`
    INSERT INTO users (first_name, last_name, username, email, password, jobtitle, region_key, activated, permissions, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)
  `, [
    first,
    last,
    username,
    email,
    bcrypt.hashSync(password, 10),
    jobtitle,
    req.body?.region_key || null,
    perms,
    ts,
    ts,
  ])
  await logAction({ userId: req.user!.id, actionType: 'user_create', itemType: 'user', itemId: info.insertId })
  return okItem(res, await transformUser(info.insertId), 201)
})

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id)
  const existing = await get(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [id])
  if (!existing) return fail(res, 'Not found', 404)
  const fields: string[] = []
  const params: unknown[] = []
  const map: Record<string, string> = {
    first_name: 'first_name',
    last_name: 'last_name',
    jobtitle: 'jobtitle',
    region_key: 'region_key',
    phone: 'phone',
    activated: 'activated',
  }
  for (const [k, col] of Object.entries(map)) {
    if (req.body?.[k] !== undefined) {
      fields.push(`${col} = ?`)
      params.push(req.body[k])
    }
  }
  const role = String(req.body?.role || '')
  if (role === 'admin' || role === 'gps') {
    fields.push('permissions = ?')
    params.push(JSON.stringify(await permissionsFor(role)))
    fields.push('jobtitle = ?')
    params.push(role === 'admin' ? 'Administrator' : 'GPS Team')
  } else if (req.body?.permissions) {
    fields.push('permissions = ?')
    params.push(JSON.stringify(req.body.permissions))
  }
  if (req.body?.password) {
    fields.push('password = ?')
    params.push(bcrypt.hashSync(String(req.body.password), 10))
  }
  if (!fields.length) return okItem(res, await transformUser(id))
  fields.push('updated_at = ?')
  params.push(now(), id)
  await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params)
  return okItem(res, await transformUser(id))
})

router.post('/:id/reset-password', async (req, res) => {
  const id = Number(req.params.id)
  const password = String(req.body?.password || '').trim()
  if (!password || password.length < 6) {
    return fail(res, 'Password must be at least 6 characters')
  }
  const existing = await get<{ id: number; username: string; email: string }>(
    `SELECT id, username, email FROM users WHERE id = ? AND deleted_at IS NULL`,
    [id]
  )
  if (!existing) return fail(res, 'User not found', 404)

  const mustChange = req.body?.must_change_password ? 1 : 0
  const ts = now()
  await run(
    `UPDATE users SET password = ?, must_change_password = ?, updated_at = ? WHERE id = ?`,
    [bcrypt.hashSync(password, 10), mustChange, ts, id]
  )
  await logAction({
    userId: req.user!.id,
    actionType: 'password_reset',
    itemType: 'user',
    itemId: id,
    note: `Password reset for user ${id}`,
  })
  return okMessage(res, `Password reset successfully for ${existing.username || existing.email}`)
})

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id)
  if (id === req.user!.id) return fail(res, 'You cannot delete your own account')
  await run(`UPDATE users SET deleted_at = ?, activated = 0 WHERE id = ?`, [now(), id])
  await logAction({ userId: req.user!.id, actionType: 'user_delete', itemType: 'user', itemId: id })
  return okMessage(res, 'User deactivated')
})

export default router
