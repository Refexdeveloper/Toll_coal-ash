import dotenv from 'dotenv'
import { createApp } from './app.js'
import { waitForDatabase } from './db/index.js'
import { ensureAppColumns } from './db/ensure.js'
import { alignUserRoles } from './db/seed.js'

dotenv.config()

const port = Number(process.env.PORT) || 4090
const host = process.env.HOST || '0.0.0.0'
const serveClient = process.env.SERVE_CLIENT === 'true'
const publicApp = (process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '').replace(/\/$/, '')

try {
  await waitForDatabase()
  await ensureAppColumns()
  await alignUserRoles()
  console.log('Database and Route Master tables ready')
} catch (e) {
  console.error('Database connection failed:', e instanceof Error ? e.message : e)
  process.exit(1)
}

const app = createApp()

app.listen(port, host, () => {
  console.log(`3i Sales Funnel API listening on http://${host}:${port}`)
  console.log(`Local:  http://localhost:${port}`)
  if (serveClient) {
    console.log(`Mode:   SERVE_CLIENT=true (API + client/out on one port)`)
    if (publicApp) console.log(`Public: ${publicApp}`)
  } else {
    console.log(`Dev:    Vite on :5173 + API on :${port}`)
  }
  console.log(`Health: http://localhost:${port}/api/v1/status`)
  console.log(`Login:  POST http://localhost:${port}/api/v1/login`)
})
