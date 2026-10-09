import type { AuthUser } from '../middleware/auth.js'
import { get } from '../db/index.js'

function isTruthy(v: unknown) {
  return v === '1' || v === 1 || v === true || v === 'true'
}

function parsePerms(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return {} }
  }
  if (typeof raw === 'object') return raw as Record<string, unknown>
  return {}
}

export async function transformUser(id: number) {
  const row = await get<Record<string, unknown>>(`
    SELECT id, username, first_name, last_name, email, phone, jobtitle, region_key,
           permissions, activated, must_change_password, employee_num, created_at, last_login
    FROM users WHERE id = ? AND deleted_at IS NULL
  `, [id])
  if (!row) return null
  const permissions = parsePerms(row.permissions)
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
  return {
    id: Number(row.id),
    username: row.username,
    first_name: row.first_name,
    last_name: row.last_name,
    name,
    email: row.email,
    phone: row.phone,
    jobtitle: row.jobtitle,
    region_key: row.region_key,
    employee_num: row.employee_num,
    activated: row.activated,
    must_change_password: Boolean(row.must_change_password),
    permissions,
    is_admin: isTruthy(permissions.admin) || isTruthy(permissions.superuser),
    created_at: row.created_at,
    last_login: row.last_login,
  }
}

export function publicUser(user: AuthUser) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim()
  return {
    id: user.id,
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
    name,
    email: user.email,
    jobtitle: user.jobtitle,
    region_key: user.region_key,
    permissions: user.permissions,
    must_change_password: Boolean(user.must_change_password),
  }
}
