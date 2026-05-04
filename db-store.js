'use strict';

const path = require('path');
const fs = require('fs');

let mode = 'sqlite';
let sqliteDb = null;
let pgPool = null;

function mapRow(row) {
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
    stats: JSON.parse(row.stats_json || '{}'),
    schema_version: row.schema_version,
    source: row.source,
    raw_payload: JSON.parse(row.raw_payload_json || '{}'),
    received_at: row.received_at
  };
}

function rowToInsertParams(alert) {
  return {
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
  };
}

async function initSqlite() {
  const Database = require('better-sqlite3');
  const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'alerts.db');
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('busy_timeout = 5000');
  sqliteDb.exec(`
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
  mode = 'sqlite';
}

const PG_DDL = `
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
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
)`;

async function initPostgres() {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10
  });
  await pgPool.query(PG_DDL);
  mode = 'postgres';
}

async function init() {
  if (process.env.DATABASE_URL) {
    await initPostgres();
    console.log('[DB] Using PostgreSQL (persistent on Render)');
    return mode;
  }
  await initSqlite();
  console.log('[DB] Using SQLite at', process.env.SQLITE_PATH || path.join(__dirname, 'data', 'alerts.db'));
  console.log('[DB] Tip: set DATABASE_URL (Render Postgres) for persistence on free web dynos');
  return mode;
}

function getMode() {
  return mode;
}

const SQLITE_INSERT = `
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
`;

const PG_INSERT = `
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

async function insertAlert(alert) {
  const p = rowToInsertParams(alert);
  if (mode === 'sqlite') {
    sqliteDb.prepare(SQLITE_INSERT).run(p);
    return;
  }
  await pgPool.query(PG_INSERT, [
    p.alert_id, p.alert_group_id, p.notification_id, p.notification_triggered_at,
    p.notification_type, p.product, p.metric, p.entity_identifier, p.entity_type,
    p.entity_name, p.started_at, p.ended_at, p.current_state, p.criticality_score,
    p.severity, p.stats_json, p.schema_version, p.source, p.raw_payload_json, p.received_at
  ]);
}

async function fetchAlerts({ state, severity, entity_type, from, to, limit = 500, retentionCutoff }) {
  const defaultCutoff = retentionCutoff;
  const fromDate = from || defaultCutoff;
  if (mode === 'sqlite') {
    let sql = 'SELECT * FROM alerts WHERE received_at >= @fromDate';
    const params = { fromDate };
    if (to) { sql += ' AND received_at <= @toDate'; params.toDate = to; }
    if (state) { sql += ' AND current_state = @state'; params.state = state; }
    if (severity) { sql += ' AND severity = @severity'; params.severity = severity.toUpperCase(); }
    if (entity_type) { sql += ' AND entity_type = @entity_type'; params.entity_type = entity_type; }
    sql += ' ORDER BY id DESC LIMIT @limit';
    params.limit = parseInt(limit, 10);
    return sqliteDb.prepare(sql).all(params).map(mapRow);
  }
  const vals = [fromDate];
  let n = 2;
  let sql = 'SELECT * FROM alerts WHERE received_at >= $1';
  if (to) { sql += ` AND received_at <= $${n}`; vals.push(to); n++; }
  if (state) { sql += ` AND current_state = $${n}`; vals.push(state); n++; }
  if (severity) { sql += ` AND severity = $${n}`; vals.push(severity.toUpperCase()); n++; }
  if (entity_type) { sql += ` AND entity_type = $${n}`; vals.push(entity_type); n++; }
  sql += ` ORDER BY id DESC LIMIT $${n}`;
  vals.push(parseInt(limit, 10));
  const { rows } = await pgPool.query(sql, vals);
  return rows.map(mapRow);
}

async function fetchStats({ from, to, retentionCutoff }) {
  const fromDate = from || retentionCutoff;
  if (mode === 'sqlite') {
    let where = 'WHERE received_at >= ?';
    const p = [fromDate];
    if (to) { where += ' AND received_at <= ?'; p.push(to); }
    const row = sqliteDb.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN current_state='ongoing' THEN 1 ELSE 0 END) as ongoing,
        SUM(CASE WHEN current_state='resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN severity='HIGH' THEN 1 ELSE 0 END) as high,
        SUM(CASE WHEN severity='MEDIUM' THEN 1 ELSE 0 END) as medium,
        SUM(CASE WHEN severity='LOW' THEN 1 ELSE 0 END) as low
      FROM alerts ${where}
    `).get(...p);
    const etRows = sqliteDb.prepare(`
      SELECT entity_type, COUNT(*) as cnt FROM alerts ${where} GROUP BY entity_type
    `).all(...p);
    const entity_types = {};
    etRows.forEach(r => { entity_types[r.entity_type || 'unknown'] = r.cnt; });
    return { ...row, entity_types };
  }
  const vals = [fromDate];
  let where = 'WHERE received_at >= $1';
  let n = 2;
  if (to) { where += ` AND received_at <= $${n}`; vals.push(to); n++; }
  const q = `
    SELECT
      COUNT(*)::int as total,
      COALESCE(SUM(CASE WHEN current_state='ongoing' THEN 1 ELSE 0 END), 0)::int as ongoing,
      COALESCE(SUM(CASE WHEN current_state='resolved' THEN 1 ELSE 0 END), 0)::int as resolved,
      COALESCE(SUM(CASE WHEN severity='HIGH' THEN 1 ELSE 0 END), 0)::int as high,
      COALESCE(SUM(CASE WHEN severity='MEDIUM' THEN 1 ELSE 0 END), 0)::int as medium,
      COALESCE(SUM(CASE WHEN severity='LOW' THEN 1 ELSE 0 END), 0)::int as low
    FROM alerts ${where}
  `;
  const { rows: [row] } = await pgPool.query(q, vals);
  const { rows: etRows } = await pgPool.query(
    `SELECT entity_type, COUNT(*)::int as cnt FROM alerts ${where} GROUP BY entity_type`,
    vals
  );
  const entity_types = {};
  etRows.forEach(r => { entity_types[r.entity_type || 'unknown'] = r.cnt; });
  return { ...row, entity_types };
}

async function countAlerts() {
  if (mode === 'sqlite') {
    return sqliteDb.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt;
  }
  const { rows } = await pgPool.query('SELECT COUNT(*)::int as cnt FROM alerts');
  return rows[0].cnt;
}

async function deleteAllAlerts() {
  if (mode === 'sqlite') {
    sqliteDb.prepare('DELETE FROM alerts').run();
    return;
  }
  await pgPool.query('DELETE FROM alerts');
}

async function purgeBefore(cutoffIso) {
  if (mode === 'sqlite') {
    return sqliteDb.prepare('DELETE FROM alerts WHERE received_at < ?').run(cutoffIso).changes;
  }
  const { rowCount } = await pgPool.query('DELETE FROM alerts WHERE received_at < $1', [cutoffIso]);
  return rowCount;
}

module.exports = {
  init,
  getMode,
  insertAlert,
  fetchAlerts,
  fetchStats,
  countAlerts,
  deleteAllAlerts,
  purgeBefore
};
