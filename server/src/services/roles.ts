import { all, get, now, run } from '../db/index.js'

export const MODULES = [
  { key: 'routes', label: 'Route Master' },
  { key: 'fastag', label: 'FASTag' },
  { key: 'checks', label: 'Trip checks' },
  { key: 'gps', label: 'GPS Tracking' },
  { key: 'activity', label: 'Activity log' },
] as const

const ADMIN_PERMS: Record<string, string> = {
  superuser: '1',
  admin: '1',
  routes: '1',
  fastag: '1',
  checks: '1',
  gps: '1',
  activity: '1',
  users: '1',
}

const GPS_DEFAULT: Record<string, string> = {
  routes: '1',
  fastag: '1',
  checks: '1',
  gps: '0',
  activity: '0',
}

function readPerms(raw: unknown): Record<string, string> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, string>
  try { return JSON.parse(String(raw)) } catch { return {} }
}

function flag(value: unknown) {
  return value === '1' || value === 1 || value === true || value === 'true' ? '1' : '0'
}

export function gpsPermissions(input: Record<string, unknown> = {}) {
  const perms: Record<string, string> = {}
  for (const mod of MODULES) perms[mod.key] = flag(input[mod.key])
  perms.gps = '0'
  return perms
}

export async function ensureRoleRows() {
  await run(`
    CREATE TABLE IF NOT EXISTS app_roles (
      role_key VARCHAR(32) NOT NULL,
      label VARCHAR(64) NOT NULL,
      permissions JSON NOT NULL,
      locked TINYINT NOT NULL DEFAULT 0,
      updated_at DATETIME NULL,
      PRIMARY KEY (role_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
  const ts = now()
  const admin = await get(`SELECT role_key FROM app_roles WHERE role_key = 'admin'`)
  if (!admin) {
    await run(
      `INSERT INTO app_roles (role_key, label, permissions, locked, updated_at) VALUES ('admin', 'Admin', ?, 1, ?)`,
      [JSON.stringify(ADMIN_PERMS), ts],
    )
  } else {
    await run(
      `UPDATE app_roles SET label = 'Admin', permissions = ?, locked = 1 WHERE role_key = 'admin'`,
      [JSON.stringify(ADMIN_PERMS)],
    )
  }
  const gps = await get(`SELECT role_key FROM app_roles WHERE role_key = 'gps'`)
  if (!gps) {
    await run(
      `INSERT INTO app_roles (role_key, label, permissions, locked, updated_at) VALUES ('gps', 'GPS Team', ?, 0, ?)`,
      [JSON.stringify(GPS_DEFAULT), ts],
    )
  }
}

export async function permissionsFor(role: string) {
  await ensureRoleRows()
  if (role === 'admin') return { ...ADMIN_PERMS }
  const row = await get<{ permissions: unknown }>(`SELECT permissions FROM app_roles WHERE role_key = 'gps'`)
  return gpsPermissions(readPerms(row?.permissions))
}

export async function listRoles() {
  await ensureRoleRows()
  return {
    modules: MODULES.map((mod) => ({ ...mod })),
    roles: [
      { role_key: 'admin', label: 'Admin', locked: true, permissions: { ...ADMIN_PERMS } },
      { role_key: 'gps', label: 'GPS Team', locked: false, permissions: await permissionsFor('gps') },
    ],
  }
}

export async function applyRoleTemplates() {
  const gps = await permissionsFor('gps')
  const users = await all<{ id: number, email: string | null, permissions: unknown }>(
    `SELECT id, email, permissions FROM users WHERE deleted_at IS NULL`,
  )
  const ts = now()
  for (const user of users) {
    const current = readPerms(user.permissions)
    const email = String(user.email || '').toLowerCase()
    const salesUser = email === 'rajlaxmi.s@refex.co.in'
    const admin = !salesUser && (
      email === 'raghul.je@refex.co.in'
      || email === 'dickson.g@refex.co.in'
      || current.admin === '1'
      || current.superuser === '1'
    )
    await run(
      `UPDATE users SET permissions = ?, jobtitle = ?, updated_at = ? WHERE id = ?`,
      [JSON.stringify(admin ? ADMIN_PERMS : gps), admin ? 'Administrator' : 'GPS Team', ts, user.id],
    )
  }
}

export async function saveGpsRole(input: Record<string, unknown>) {
  await ensureRoleRows()
  const perms = gpsPermissions(input)
  await run(
    `UPDATE app_roles SET permissions = ?, updated_at = ? WHERE role_key = 'gps'`,
    [JSON.stringify(perms), now()],
  )
  await applyRoleTemplates()
  return listRoles()
}
