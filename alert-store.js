/**
 * Persistent alerts: PostgreSQL when DATABASE_URL is set (Render),
 * otherwise SQLite on disk (local). Render web dynos have ephemeral
 * filesystem — SQLite alone loses data on restart without a disk mount.
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

function mapRow(row) {
  const iso = v => (v instanceof Date ? v.toISOString() : v);
  return {
    alert_id: row.alert_id,
    alert_group_id: row.alert_group_id,
    notification_id: row.notification_id,
    notification_triggered_at: row.notification_triggered_at,
    notification_type: row.notification_type,
    product: row.product,
    metric: row.metric,
    entity_identifier: row.entity_identifier,
    entity_type: row.entity_type,
    entity_name: row.entity_name,
    started_at: row.started_at,
    ended_at: row.ended_at,
    current_state: row.current_state,
    criticality_score: row.criticality_score,
    severity: row.severity,
    stats: typeof row.stats_json === 'string' ? JSON.parse(row.stats_json || '{}') : (row.stats_json || {}),
    schema_version: row.schema_version,
    source: row.source,
    raw_payload: typeof row.raw_payload_json === 'string'
      ? JSON.parse(row.raw_payload_json || '{}')
      : (row.raw_payload_json || {}),
    received_at: iso(row.received_at)
  };
}

function createSqliteStore(retentionDays) {
  const envPath = (process.env.SQLITE_PATH || '').trim();
  const DB_PATH = envPath
    ? (path.isAbsolute(envPath) ? envPath : path.join(__dirname, envPath))
    : path.join(__dirname, 'data', 'alerts.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id TEXT UNIQUE NOT NULL,
      alert_group_id TEXT,
      notification_id TEXT,
      notification_triggered_at TEXT,
      notification_type TEXT,
      product TEXT,
      metric TEXT,
      entity_identifier TEXT,
      entity_type TEXT,
      entity_name TEXT,
      started_at TEXT,
      ended_at TEXT,
      current_state TEXT,
      criticality_score INTEGER DEFAULT 0,
      severity TEXT,
      stats_json TEXT,
      schema_version TEXT,
      source TEXT,
      raw_payload_json TEXT,
      received_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts (received_at DESC)');

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO alerts
      (alert_id, alert_group_id, notification_id, notification_triggered_at,
       notification_type, product, metric, entity_identifier, entity_type,
       entity_name, started_at, ended_at, current_state, criticality_score,
       severity, stats_json, schema_version, source, raw_payload_json, received_at)
    VALUES
      (@alert_id, @alert_group_id, @notification_id, @notification_triggered_at,
       @notification_type, @product, @metric, @entity_identifier, @entity_type,
       @entity_name, @started_at, @ended_at, @current_state, @criticality_score,
       @severity, @stats_json, @schema_version, @source, @raw_payload_json, @received_at)
  `);

  return {
    kind: 'sqlite',
    retentionDays,
    location: DB_PATH,
    async insert(alert) {
      insertStmt.run({
        alert_id: alert.alert_id,
        alert_group_id: alert.alert_group_id,
        notification_id: alert.notification_id,
        notification_triggered_at: alert.notification_triggered_at,
        notification_type: alert.notification_type,
        product: alert.product,
        metric: alert.metric,
        entity_identifier: alert.entity_identifier,
        entity_type: alert.entity_type,
        entity_name: alert.entity_name,
        started_at: alert.started_at,
        ended_at: alert.ended_at,
        current_state: alert.current_state,
        criticality_score: alert.criticality_score,
        severity: alert.severity,
        stats_json: JSON.stringify(alert.stats),
        schema_version: alert.schema_version,
        source: alert.source,
        raw_payload_json: JSON.stringify(alert.raw_payload),
        received_at: alert.received_at
      });
    },
    async fetch({ state, severity, entity_type, from, to, limit = 2000 } = {}) {
      const defaultCutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const fromDate = from || defaultCutoff;
      let sql = 'SELECT * FROM alerts WHERE received_at >= @fromDate';
      const params = { fromDate };
      if (to) { sql += ' AND received_at <= @toDate'; params.toDate = to; }
      if (state) { sql += ' AND current_state = @state'; params.state = state; }
      if (severity) { sql += ' AND severity = @severity'; params.severity = severity.toUpperCase(); }
      if (entity_type) { sql += ' AND entity_type = @entity_type'; params.entity_type = entity_type; }
      sql += ' ORDER BY received_at DESC, id DESC LIMIT @limit';
      params.limit = parseInt(limit, 10);
      return db.prepare(sql).all(params).map(mapRow);
    },
    async stats({ from, to } = {}) {
      const defaultCutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const fromDate = from || defaultCutoff;
      let where = 'WHERE received_at >= ?';
      const p = [fromDate];
      if (to) { where += ' AND received_at <= ?'; p.push(to); }
      const row = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN current_state='ongoing' THEN 1 ELSE 0 END) as ongoing,
          SUM(CASE WHEN current_state='resolved' THEN 1 ELSE 0 END) as resolved,
          SUM(CASE WHEN severity='HIGH' THEN 1 ELSE 0 END) as high,
          SUM(CASE WHEN severity='MEDIUM' THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN severity='LOW' THEN 1 ELSE 0 END) as low
        FROM alerts ${where}
      `).get(...p);
      const etRows = db.prepare(`
        SELECT entity_type, COUNT(*) as cnt FROM alerts ${where} GROUP BY entity_type
      `).all(...p);
      const entity_types = {};
      etRows.forEach(r => { entity_types[r.entity_type || 'unknown'] = r.cnt; });
      return { ...row, entity_types };
    },
    async count() {
      return db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt;
    },
    async deleteAll() {
      db.prepare('DELETE FROM alerts').run();
    },
    async purge() {
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const { changes } = db.prepare('DELETE FROM alerts WHERE received_at < ?').run(cutoff);
      return changes;
    },
    async tables() {
      return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    },
    async schema(table = 'alerts') {
      if (!/^[a-zA-Z_][\w]*$/.test(table)) throw new Error('Invalid table name');
      return db.prepare(`PRAGMA table_info(${table})`).all().map(c => ({
        name: c.name,
        type: c.type,
        nullable: c.notnull === 0,
        default: c.dflt_value,
        primary_key: c.pk === 1
      }));
    },
    async rows({ table = 'alerts', limit = 50, offset = 0, orderBy = 'received_at', dir = 'DESC' } = {}) {
      if (!/^[a-zA-Z_][\w]*$/.test(table)) throw new Error('Invalid table name');
      if (!/^[a-zA-Z_][\w]*$/.test(orderBy)) orderBy = 'received_at';
      const direction = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      const total = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c;
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy} ${direction} LIMIT ? OFFSET ?`).all(lim, off);
      const cols = rows.length ? Object.keys(rows[0]) : (await this.schema(table)).map(c => c.name);
      return { table, total, limit: lim, offset: off, orderBy, dir: direction, columns: cols, rows };
    },
    async query(sql) {
      const t0 = Date.now();
      const stmt = db.prepare(sql);
      const rows = stmt.all();
      const cols = rows.length ? Object.keys(rows[0]) : (stmt.columns ? stmt.columns().map(c => c.name) : []);
      return { columns: cols, rows, rowCount: rows.length, executionMs: Date.now() - t0 };
    }
  };
}

function createPgStore(pool, retentionDays) {
  const upsertSql = `
    INSERT INTO alerts (
      alert_id, alert_group_id, notification_id, notification_triggered_at,
      notification_type, product, metric, entity_identifier, entity_type,
      entity_name, started_at, ended_at, current_state, criticality_score,
      severity, stats_json, schema_version, source, raw_payload_json, received_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (alert_id) DO UPDATE SET
      alert_group_id = EXCLUDED.alert_group_id,
      notification_id = EXCLUDED.notification_id,
      notification_triggered_at = EXCLUDED.notification_triggered_at,
      notification_type = EXCLUDED.notification_type,
      product = EXCLUDED.product,
      metric = EXCLUDED.metric,
      entity_identifier = EXCLUDED.entity_identifier,
      entity_type = EXCLUDED.entity_type,
      entity_name = EXCLUDED.entity_name,
      started_at = EXCLUDED.started_at,
      ended_at = EXCLUDED.ended_at,
      current_state = EXCLUDED.current_state,
      criticality_score = EXCLUDED.criticality_score,
      severity = EXCLUDED.severity,
      stats_json = EXCLUDED.stats_json,
      schema_version = EXCLUDED.schema_version,
      source = EXCLUDED.source,
      raw_payload_json = EXCLUDED.raw_payload_json,
      received_at = EXCLUDED.received_at
  `;

  return {
    kind: 'postgres',
    retentionDays,
    pool,
    async insert(alert) {
      const vals = [
        alert.alert_id,
        alert.alert_group_id,
        alert.notification_id,
        alert.notification_triggered_at,
        alert.notification_type,
        alert.product,
        alert.metric,
        alert.entity_identifier,
        alert.entity_type,
        alert.entity_name,
        alert.started_at,
        alert.ended_at,
        alert.current_state,
        alert.criticality_score,
        alert.severity,
        JSON.stringify(alert.stats || {}),
        alert.schema_version,
        alert.source,
        JSON.stringify(alert.raw_payload || {}),
        alert.received_at
      ];
      await pool.query(upsertSql, vals);
    },
    async fetch({ state, severity, entity_type, from, to, limit = 2000 } = {}) {
      const defaultCutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const fromDate = from || defaultCutoff;
      const params = [fromDate];
      let i = 2;
      let sql = 'SELECT * FROM alerts WHERE received_at >= $1';
      if (to) { sql += ` AND received_at <= $${i++}`; params.push(to); }
      if (state) { sql += ` AND current_state = $${i++}`; params.push(state); }
      if (severity) { sql += ` AND severity = $${i++}`; params.push(severity.toUpperCase()); }
      if (entity_type) { sql += ` AND entity_type = $${i++}`; params.push(entity_type); }
      sql += ` ORDER BY received_at DESC, id DESC LIMIT $${i}`;
      params.push(parseInt(limit, 10));
      const { rows } = await pool.query(sql, params);
      return rows.map(mapRow);
    },
    async stats({ from, to } = {}) {
      const defaultCutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const fromDate = from || defaultCutoff;
      const params = [fromDate];
      let i = 2;
      let where = 'WHERE received_at >= $1';
      if (to) { where += ` AND received_at <= $${i++}`; params.push(to); }
      const agg = await pool.query(`
        SELECT
          COUNT(*)::int as total,
          COALESCE(SUM(CASE WHEN current_state='ongoing' THEN 1 ELSE 0 END),0)::int as ongoing,
          COALESCE(SUM(CASE WHEN current_state='resolved' THEN 1 ELSE 0 END),0)::int as resolved,
          COALESCE(SUM(CASE WHEN severity='HIGH' THEN 1 ELSE 0 END),0)::int as high,
          COALESCE(SUM(CASE WHEN severity='MEDIUM' THEN 1 ELSE 0 END),0)::int as medium,
          COALESCE(SUM(CASE WHEN severity='LOW' THEN 1 ELSE 0 END),0)::int as low
        FROM alerts ${where}
      `, params);
      const et = await pool.query(`
        SELECT entity_type, COUNT(*)::int as cnt FROM alerts ${where} GROUP BY entity_type
      `, params);
      const entity_types = {};
      et.rows.forEach(r => { entity_types[r.entity_type || 'unknown'] = r.cnt; });
      return { ...agg.rows[0], entity_types };
    },
    async count() {
      const { rows } = await pool.query('SELECT COUNT(*)::int as cnt FROM alerts');
      return rows[0].cnt;
    },
    async deleteAll() {
      await pool.query('DELETE FROM alerts');
    },
    async purge() {
      const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
      const r = await pool.query('DELETE FROM alerts WHERE received_at < $1', [cutoff]);
      return r.rowCount ?? 0;
    },
    async tables() {
      const r = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
      return r.rows.map(x => x.tablename);
    },
    async schema(table = 'alerts') {
      if (!/^[a-zA-Z_][\w]*$/.test(table)) throw new Error('Invalid table name');
      const r = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position
      `, [table]);
      return r.rows.map(c => ({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        primary_key: false
      }));
    },
    async rows({ table = 'alerts', limit = 50, offset = 0, orderBy = 'received_at', dir = 'DESC' } = {}) {
      if (!/^[a-zA-Z_][\w]*$/.test(table)) throw new Error('Invalid table name');
      if (!/^[a-zA-Z_][\w]*$/.test(orderBy)) orderBy = 'received_at';
      const direction = String(dir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
      const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
      const off = Math.max(parseInt(offset, 10) || 0, 0);
      const totalR = await pool.query(`SELECT COUNT(*)::int AS c FROM ${table}`);
      const total = totalR.rows[0].c;
      const r = await pool.query(`SELECT * FROM ${table} ORDER BY ${orderBy} ${direction} LIMIT $1 OFFSET $2`, [lim, off]);
      const cols = r.fields.map(f => f.name);
      return { table, total, limit: lim, offset: off, orderBy, dir: direction, columns: cols, rows: r.rows };
    },
    async query(sql) {
      const t0 = Date.now();
      const r = await pool.query(sql);
      const cols = r.fields.map(f => f.name);
      return { columns: cols, rows: r.rows, rowCount: r.rowCount ?? r.rows.length, executionMs: Date.now() - t0 };
    }
  };
}

async function initPgSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alerts (
      id BIGSERIAL PRIMARY KEY,
      alert_id TEXT NOT NULL UNIQUE,
      alert_group_id TEXT,
      notification_id TEXT,
      notification_triggered_at TEXT,
      notification_type TEXT,
      product TEXT,
      metric TEXT,
      entity_identifier TEXT,
      entity_type TEXT,
      entity_name TEXT,
      started_at TEXT,
      ended_at TEXT,
      current_state TEXT,
      criticality_score INTEGER DEFAULT 0,
      severity TEXT,
      stats_json TEXT NOT NULL DEFAULT '{}',
      schema_version TEXT,
      source TEXT,
      raw_payload_json TEXT NOT NULL DEFAULT '{}',
      received_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_alerts_received_at ON alerts (received_at DESC)');
}

async function createAlertStore(retentionDays) {
  const forceSqlite = /^(1|true|yes)$/i.test(process.env.USE_SQLITE || '');
  const url = forceSqlite ? '' : process.env.DATABASE_URL;
  if (url) {
    const { Pool } = require('pg');
    let useSsl = false;
    if (process.env.DATABASE_SSL === 'true') useSsl = true;
    else if (process.env.DATABASE_SSL === 'false') useSsl = false;
    else {
      useSsl = /\.render\.com|amazonaws\.com|neon\.tech|supabase\.co|aiven\.io|sslmode=require/i.test(url);
    }
    const pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined
    });
    await initPgSchema(pool);
    console.log('[DB] Using PostgreSQL (DATABASE_URL) — alerts survive deploys/restarts.');
    return createPgStore(pool, retentionDays);
  }
  const sqliteStore = createSqliteStore(retentionDays);
  console.log(`[DB] Using SQLite at ${sqliteStore.location} | retention ${retentionDays}d${forceSqlite ? ' (USE_SQLITE=1)' : ''}`);
  return sqliteStore;
}

module.exports = { createAlertStore };
