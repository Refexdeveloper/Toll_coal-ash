import { Router } from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import { authRequired, signToken } from '../middleware/auth.js'
import { fail, okItem, okMessage } from '../utils/response.js'
import { transformUser } from '../services/users.js'
import { logAction } from '../services/actionLog.js'
import { mailConfigured, sendMail } from '../services/mail.js'
import { get, run } from '../db/index.js'
import { clock } from '../utils/clock.js'

const router = Router()
const RESET_TTL_MS = 60 * 60 * 1000

function clientOrigin() {
  const fromEnv = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').trim()
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const first = String(process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')[0]
    .trim()
  return first.replace(/\/$/, '')
}

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || req.body?.username || '').trim()
  const { password } = req.body || {}
  if (!email || !password) return fail(res, 'Email and password required')

  const emailNorm = email.toLowerCase()
  const user = await get<{ id: number, username: string, email: string, password: string, activated: number }>(`
    SELECT id, username, email, password, activated FROM users
    WHERE LOWER(email) = ? AND deleted_at IS NULL
  `, [emailNorm])

  if (!user || !user.activated || !bcrypt.compareSync(String(password), user.password)) {
    await logAction({ email: emailNorm, actionType: 'login_failed', itemType: 'user', note: 'Invalid credentials' })
    return fail(res, 'Invalid credentials', 401)
  }

  const token = signToken({ id: Number(user.id), username: String(user.username) })
  await run(`UPDATE users SET last_login = ? WHERE id = ?`, [clock(), user.id])
  await logAction({
    userId: user.id,
    email: user.email,
    actionType: 'login',
    itemType: 'user',
    itemId: user.id,
    note: 'Signed in',
  })

  return okItem(res, {
    status: 'success',
    token,
    token_type: 'Bearer',
    expires_in: 604800,
    user: await transformUser(Number(user.id)),
  })
})

router.get('/user', authRequired, async (req, res) => {
  return okItem(res, await transformUser(req.user!.id))
})

router.post('/logout', authRequired, async (req, res) => {
  await logAction({
    userId: req.user!.id,
    email: req.user!.email,
    actionType: 'logout',
    itemType: 'user',
    itemId: req.user!.id,
    note: 'Signed out',
  })
  return okMessage(res, 'Logged out')
})

router.post('/password/forgot', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  if (!email) return fail(res, 'Email is required')

  const generic = 'If that email is registered, a reset link has been sent.'

  try {
    const user = await get<{ id: number, email: string, first_name: string, activated: number }>(`
      SELECT id, email, first_name, activated FROM users
      WHERE LOWER(email) = ? AND deleted_at IS NULL
    `, [email])

    if (!user || !user.activated) {
      return okMessage(res, generic)
    }

    if (!mailConfigured()) {
      console.error('[password/forgot] SMTP is not configured')
      return fail(res, 'Email service is not configured. Contact an administrator.', 503)
    }

    const plain = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(plain).digest('hex')
    const expires = new Date(Date.now() + RESET_TTL_MS)
    const expiresSql = clock(expires)
    await run(`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, [clock(), user.id])
    await run(`
      INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `, [user.id, tokenHash, expiresSql, clock()])

    const link = `${clientOrigin()}/reset-password?token=${plain}`
    const name = user.first_name || 'there'
    await sendMail({
      to: String(user.email),
      subject: 'Reset your 3i Sales Funnel password',
      text: [
        `Hi ${name},`,
        '',
        'We received a request to reset your password for 3i Sales Funnel.',
        'Open this link to choose a new password (valid for 1 hour):',
        '',
        link,
        '',
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: `
        <p>Hi ${name},</p>
        <p>We received a request to reset your password for <strong>3i Sales Funnel</strong>.</p>
        <p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#2879B6;color:#fff;text-decoration:none;border-radius:8px;font-weight:700">Reset password</a></p>
        <p style="color:#64748b;font-size:13px">This link expires in 1 hour.</p>
      `,
    })

    await logAction({ userId: Number(user.id), actionType: 'password_reset_request', itemType: 'user', itemId: Number(user.id) })
  } catch (e) {
    console.error('[password/forgot]', e)
    return fail(res, 'Could not send reset email. Try again later.', 500)
  }

  return okMessage(res, generic)
})

router.get('/password/reset/:token', async (req, res) => {
  const plain = String(req.params.token || '').trim()
  if (!plain) return fail(res, 'Invalid token', 400)
  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex')
  const row = await get<{ id: number }>(`
    SELECT id FROM password_reset_tokens
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    LIMIT 1
  `, [tokenHash, clock()])
  if (!row) return fail(res, 'This reset link is invalid or has expired', 400)
  return okMessage(res, 'Token is valid')
})

router.post('/password/reset', async (req, res) => {
  const plain = String(req.body?.token || '').trim()
  const password = String(req.body?.password || '')
  const confirm = req.body?.password_confirmation != null ? String(req.body.password_confirmation) : password

  if (!plain) return fail(res, 'Reset token is required')
  if (password.length < 8) return fail(res, 'Password must be at least 8 characters')
  if (password !== confirm) return fail(res, 'Passwords do not match')

  const tokenHash = crypto.createHash('sha256').update(plain).digest('hex')
  const row = await get<{ id: number, user_id: number }>(`
    SELECT id, user_id FROM password_reset_tokens
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
    LIMIT 1
  `, [tokenHash, clock()])

  if (!row) return fail(res, 'This reset link is invalid or has expired', 400)

  const ts = clock()
  await run(`UPDATE users SET password = ?, must_change_password = 0, updated_at = ? WHERE id = ?`, [
    bcrypt.hashSync(password, 10), ts, row.user_id,
  ])
  await run(`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, [ts, row.user_id])

  await logAction({ userId: Number(row.user_id), actionType: 'password_reset', itemType: 'user', itemId: Number(row.user_id) })
  return okMessage(res, 'Password has been reset. You can sign in now.')
})

export default router
