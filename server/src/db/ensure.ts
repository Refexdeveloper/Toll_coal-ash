import { all, get, run, now } from './index.js'

async function columnExists(table: string, column: string) {
  const rows = await all<{ Field: string }>(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column])
  return rows.length > 0
}

async function indexExists(table: string, name: string) {
  const rows = await all<{ Key_name: string }>(
    `SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`,
    [name],
  )
  return rows.length > 0
}

export async function ensureAppColumns() {
  if (!(await columnExists('fastag_reads', 'run_id'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN run_id INT UNSIGNED NULL AFTER vehicle_id`)
  }
  if (!(await columnExists('fastag_reads', 'fetched_at'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN fetched_at DATETIME NULL AFTER created_at`)
  }
  if (!(await columnExists('fastag_vehicles', 'project_name'))) {
    await run(`ALTER TABLE fastag_vehicles ADD COLUMN project_name VARCHAR(191) NULL AFTER vehicle_reg_no`)
  }
  if (!(await columnExists('fastag_vehicles', 'challan_id'))) {
    await run(`ALTER TABLE fastag_vehicles ADD COLUMN challan_id VARCHAR(100) NULL AFTER project_name`)
  }
  if (!(await columnExists('fastag_vehicles', 'trip_id'))) {
    await run(`ALTER TABLE fastag_vehicles ADD COLUMN trip_id VARCHAR(100) NULL AFTER challan_id`)
  }
  if (!(await columnExists('fastag_vehicles', 'from_location'))) {
    await run(`ALTER TABLE fastag_vehicles ADD COLUMN from_location VARCHAR(191) NULL AFTER trip_id`)
  }
  if (!(await columnExists('fastag_vehicles', 'to_location'))) {
    await run(`ALTER TABLE fastag_vehicles ADD COLUMN to_location VARCHAR(191) NULL AFTER from_location`)
  }
  if (!(await columnExists('fastag_reads', 'project_name'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN project_name VARCHAR(191) NULL AFTER vehicle_reg_no`)
  }
  if (!(await columnExists('fastag_reads', 'challan_id'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN challan_id VARCHAR(100) NULL AFTER project_name`)
  }
  if (!(await columnExists('fastag_reads', 'trip_id'))) {
    await run(`ALTER TABLE fastag_reads ADD COLUMN trip_id VARCHAR(100) NULL AFTER challan_id`)
  }
  if (!(await columnExists('action_logs', 'email'))) {
    await run(`ALTER TABLE action_logs ADD COLUMN email VARCHAR(191) NULL AFTER user_id`)
  }
  if (await indexExists('fastag_reads', 'uk_fastag_batch_seq')) {
    await run(`ALTER TABLE fastag_reads DROP INDEX uk_fastag_batch_seq`)
  }
  if (await indexExists('fastag_reads', 'uk_fastag_run_seq')) {
    await run(`ALTER TABLE fastag_reads DROP INDEX uk_fastag_run_seq`)
  }
  if (await indexExists('fastag_reads', 'uk_fastag_run_vehicle_seq')) {
    await run(`ALTER TABLE fastag_reads DROP INDEX uk_fastag_run_vehicle_seq`)
  }
  await run(`
    DELETE older FROM fastag_reads older
    INNER JOIN fastag_reads newer
      ON newer.vehicle_reg_no = older.vehicle_reg_no
     AND newer.seq_no = older.seq_no
     AND newer.id > older.id
    WHERE older.seq_no IS NOT NULL AND older.seq_no <> ''
  `)
  if (!(await indexExists('fastag_reads', 'uk_fastag_vehicle_seq'))) {
    await run(`ALTER TABLE fastag_reads ADD UNIQUE KEY uk_fastag_vehicle_seq (vehicle_reg_no, seq_no)`)
  }
  await run(`
    UPDATE fastag_vehicles v
    SET read_count = (SELECT COUNT(*) FROM fastag_reads r WHERE r.vehicle_id = v.id)
  `)
  await run(`
    UPDATE fastag_batches b
    SET read_count = (SELECT COUNT(*) FROM fastag_reads r WHERE r.batch_id = b.id)
  `)
  if (!(await indexExists('fastag_vehicles', 'uk_fastag_batch_vehicle_trip_challan'))) {
    await run(`
      DELETE older FROM fastag_reads older
      INNER JOIN fastag_vehicles dropped ON dropped.id = older.vehicle_id
      INNER JOIN fastag_vehicles kept
        ON kept.batch_id = dropped.batch_id
       AND kept.vehicle_reg_no = dropped.vehicle_reg_no
       AND kept.trip_id <=> dropped.trip_id
       AND kept.challan_id <=> dropped.challan_id
       AND kept.id > dropped.id
    `)
    await run(`
      DELETE dropped FROM fastag_vehicles dropped
      INNER JOIN fastag_vehicles kept
        ON kept.batch_id = dropped.batch_id
       AND kept.vehicle_reg_no = dropped.vehicle_reg_no
       AND kept.trip_id <=> dropped.trip_id
       AND kept.challan_id <=> dropped.challan_id
       AND kept.id > dropped.id
    `)
    await run(`ALTER TABLE fastag_vehicles ADD UNIQUE KEY uk_fastag_batch_vehicle_trip_challan (batch_id, vehicle_reg_no, trip_id, challan_id)`)
  }
  if (await indexExists('fastag_vehicles', 'uk_fastag_batch_vehicle_trip')) {
    await run(`ALTER TABLE fastag_vehicles DROP INDEX uk_fastag_batch_vehicle_trip`)
  }
  if (await indexExists('fastag_vehicles', 'uk_fastag_batch_vehicle')) {
    await run(`ALTER TABLE fastag_vehicles DROP INDEX uk_fastag_batch_vehicle`)
  }

  // Ensure Route Master tables exist
  await run(`
    CREATE TABLE IF NOT EXISTS routes (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(191) NOT NULL,
      from_location VARCHAR(191) NOT NULL,
      to_location VARCHAR(191) NOT NULL,
      highway VARCHAR(100) NULL,
      distance_km DECIMAL(8, 2) NULL,
      est_time_hours DECIMAL(4, 1) NULL,
      description TEXT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'active',
      created_by INT UNSIGNED NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY idx_routes_from_to (from_location, to_location)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await run(`
    CREATE TABLE IF NOT EXISTS route_tolls (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      route_id INT UNSIGNED NOT NULL,
      seq_order INT NOT NULL DEFAULT 1,
      toll_plaza_name VARCHAR(191) NOT NULL,
      location VARCHAR(191) NULL,
      highway VARCHAR(100) NULL,
      toll_plaza_geocode VARCHAR(80) NULL,
      plaza_code VARCHAR(64) NULL,
      fee_single DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      fee_return DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      fee_commercial DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
      source_type VARCHAR(32) NOT NULL DEFAULT 'manual',
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      KEY idx_route_tolls_route (route_id),
      CONSTRAINT fk_route_tolls_route FOREIGN KEY (route_id) REFERENCES routes (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  // Ensure GPS Tracking table exists
  await run(`
    CREATE TABLE IF NOT EXISTS gps_tracking (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      vid         INT UNSIGNED    NULL,
      vno         VARCHAR(30)     NOT NULL,
      lat         DECIMAL(11, 8)  NOT NULL,
      lon         DECIMAL(11, 8)  NOT NULL,
      spd         DECIMAL(6, 2)   NOT NULL DEFAULT 0,
      crs         INT             NOT NULL DEFAULT 0,
      ign         TINYINT(1)      NOT NULL DEFAULT 0,
      fuel        VARCHAR(30)     NOT NULL DEFAULT 'unknown',
      gps_time    DATETIME        NOT NULL,
      recorded_at DATETIME        NOT NULL,
      PRIMARY KEY (id),
      KEY idx_gps_vno     (vno),
      KEY idx_gps_vid     (vid),
      KEY idx_gps_vno_ts  (vno, gps_time DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)


  // Seed sample GPS tracking data if empty
  const countGps = await get<{ c: number }>(`SELECT COUNT(*) as c FROM gps_tracking`)
  if (!countGps || countGps.c === 0) {
    const ts = now()
    await run(`
      INSERT INTO gps_tracking (vid, vno, lat, lon, spd, crs, ign, fuel, gps_time, recorded_at)
      VALUES 
        (81509, 'CG04NU2465', 24.195430, 82.665120, 38.50, 4, 1, 'connected', '2026-09-16 01:45:10', ?),
        (81509, 'CG04NU2465', 24.198900, 82.668340, 22.00, 4, 1, 'connected', '2026-09-16 02:00:25', ?),
        (81509, 'CG04NU2465', 24.201772, 82.670205, 0.00, 4, 0, 'disconnected', '2026-09-16 02:12:43', ?)
    `, [ts, ts, ts])
  }

  // Seed sample routes if empty
  const countRoutes = await get<{ c: number }>(`SELECT COUNT(*) as c FROM routes`)
  if (!countRoutes || countRoutes.c === 0) {
    const ts = now()
    const r1 = await run(`
      INSERT INTO routes (name, from_location, to_location, highway, distance_km, est_time_hours, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `, ['Raipur to Korba Coal Corridor', 'Raipur', 'Korba', 'NH-130', 215.00, 4.5, 'Key coal & fly ash transit route between Raipur and Korba industrial corridor', ts, ts])

    if (r1.insertId) {
      await run(`
        INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
        VALUES 
          (?, 1, 'Dhank Toll Plaza', 'NH-53 / NH-130 Arang-Simga', 'NH-130', '21.227203, 82.42025', 'TP-CG-01', 95.00, 145.00, 315.00, 'fetched', ?, ?),
          (?, 2, 'Simga Toll Plaza', 'Simga Bypass, Baloda Bazar', 'NH-130', '21.6288, 81.7042', 'TP-CG-02', 80.00, 120.00, 270.00, 'fetched', ?, ?),
          (?, 3, 'Pali Toll Plaza', 'Pali, Korba District', 'NH-130', '22.3595, 82.3278', 'TP-CG-03', 110.00, 165.00, 370.00, 'manual', ?, ?)
      `, [r1.insertId, ts, ts, r1.insertId, ts, ts, r1.insertId, ts, ts])
    }

    const r2 = await run(`
      INSERT INTO routes (name, from_location, to_location, highway, distance_km, est_time_hours, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `, ['Bilaspur to Raigarh Corridor', 'Bilaspur', 'Raigarh', 'NH-49', 165.00, 3.8, 'Ash supply transit between Bilaspur thermal power plants and Raigarh cement works', ts, ts])

    if (r2.insertId) {
      await run(`
        INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
        VALUES 
          (?, 1, 'Chhuhipali Toll Plaza', 'Chhuhipali, Saraipali Highway', 'NH-49', '21.299821, 82.942781', 'TP-CG-04', 115.00, 170.00, 385.00, 'fetched', ?, ?),
          (?, 2, 'Jhalmala Toll Plaza', 'Jhalmala, Raigarh border', 'NH-49', '21.817222, 83.434444', 'TP-CG-05', 130.00, 195.00, 435.00, 'fetched', ?, ?)
      `, [r2.insertId, ts, ts, r2.insertId, ts, ts])
    }

    const r3 = await run(`
      INSERT INTO routes (name, from_location, to_location, highway, distance_km, est_time_hours, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `, ['Raipur to Sambalpur Interstate', 'Raipur', 'Sambalpur', 'NH-53', 260.00, 5.2, 'Interstate transit corridor connecting Chhattisgarh power plants to Odisha cement clusters', ts, ts])

    if (r3.insertId) {
      await run(`
        INSERT INTO route_tolls (route_id, seq_order, toll_plaza_name, location, highway, toll_plaza_geocode, plaza_code, fee_single, fee_return, fee_commercial, source_type, created_at, updated_at)
        VALUES 
          (?, 1, 'Dhank Toll Plaza', 'Arang, Raipur', 'NH-53', '21.227203, 82.42025', 'TP-CG-01', 95.00, 145.00, 315.00, 'fetched', ?, ?),
          (?, 2, 'Chhuhipali Toll Plaza', 'Saraipali, Mahasamund', 'NH-53', '21.299821, 82.942781', 'TP-CG-04', 115.00, 170.00, 385.00, 'fetched', ?, ?),
          (?, 3, 'Bargarh Toll Plaza', 'Bargarh, Odisha Border', 'NH-53', '21.3340, 83.6210', 'TP-OD-01', 125.00, 185.00, 420.00, 'manual', ?, ?)
      `, [r3.insertId, ts, ts, r3.insertId, ts, ts])
    }
  }
}
