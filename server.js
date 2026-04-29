require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SQLite ──
const DB_PATH = path.join(__dirname, 'data', 'alerts.db');
const fs = require('fs');
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

function dbInsert(alert) {
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
}

const RETENTION_DAYS = 3;

function dbFetch({ state, severity, entity_type, from, to, limit = 500 } = {}) {
  const defaultCutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const fromDate = from || defaultCutoff;
  let sql = 'SELECT * FROM alerts WHERE received_at >= @fromDate';
  const params = { fromDate };
  if (to) { sql += ' AND received_at <= @toDate'; params.toDate = to; }
  if (state) { sql += ' AND current_state = @state'; params.state = state; }
  if (severity) { sql += ' AND severity = @severity'; params.severity = severity.toUpperCase(); }
  if (entity_type) { sql += ' AND entity_type = @entity_type'; params.entity_type = entity_type; }
  sql += ' ORDER BY id DESC LIMIT @limit';
  params.limit = parseInt(limit, 10);

  return db.prepare(sql).all(params).map(row => ({
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
  }));
}

function dbStats({ from, to } = {}) {
  const defaultCutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
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
}

// ── SSE ──
const sseClients = new Set();

function broadcastAlert(alert) {
  const data = JSON.stringify(alert);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch (_) {}
  }
}

// ── Payload extraction ──
function classifySeverity(score) {
  if (score >= 61) return 'HIGH';
  if (score >= 31) return 'MEDIUM';
  return 'LOW';
}

function tryParseJSON(str) {
  if (typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}

function deepFindAlertPayload(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (obj.alert_id) return obj;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = deepFindAlertPayload(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function extractOverwatchPayload(raw) {
  if (!raw || typeof raw !== 'object') {
    const parsed = tryParseJSON(raw);
    if (parsed) return extractOverwatchPayload(parsed);
    return null;
  }
  if (Array.isArray(raw)) return raw.length > 0 ? extractOverwatchPayload(raw[0]) : null;
  if (raw.alert_id) return raw;
  if (raw.body && typeof raw.body === 'object' && raw.body.alert_id) return raw.body;
  if (typeof raw.body === 'string') {
    const parsed = tryParseJSON(raw.body);
    if (parsed?.alert_id) return parsed;
  }
  if (raw.event && typeof raw.event === 'object') {
    if (raw.event.alert_id) return raw.event;
    if (raw.event.body && raw.event.body.alert_id) return raw.event.body;
  }
  if (raw.steps?.trigger?.event) {
    const evt = raw.steps.trigger.event;
    if (typeof evt === 'string') {
      const parsed = tryParseJSON(evt);
      if (parsed) return extractOverwatchPayload(parsed);
    }
    if (evt.alert_id) return evt;
    if (evt.body) {
      const body = typeof evt.body === 'string' ? tryParseJSON(evt.body) : evt.body;
      if (body?.alert_id) return body;
    }
    if (evt.url && typeof evt.body === 'object') return extractOverwatchPayload(evt.body);
    const nested = deepFindAlertPayload(evt);
    if (nested) return nested;
  }
  if (raw.steps?.trigger?.raw_event) {
    const rawEvt = raw.steps.trigger.raw_event;
    const parsed = typeof rawEvt === 'string' ? tryParseJSON(rawEvt) : rawEvt;
    if (parsed) return extractOverwatchPayload(parsed);
  }
  if (raw.data && typeof raw.data === 'object' && raw.data.alert_id) return raw.data;
  if (raw.payload && typeof raw.payload === 'object' && raw.payload.alert_id) return raw.payload;
  if (raw.message && typeof raw.message === 'object' && raw.message.alert_id) return raw.message;
  if (raw.record && typeof raw.record === 'object' && raw.record.alert_id) return raw.record;
  if (raw.result && typeof raw.result === 'object' && raw.result.alert_id) return raw.result;
  const deep = deepFindAlertPayload(raw);
  if (deep) return deep;
  return raw;
}

function processAlert(payload, source = 'webhook') {
  const score = payload.criticality_score ?? 0;
  return {
    received_at: new Date().toISOString(),
    alert_id: payload.alert_id || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    alert_group_id: payload.alert_group_id || null,
    notification_id: payload.notification_id || null,
    notification_triggered_at: payload.notification_triggered_at || new Date().toISOString(),
    notification_type: payload.notification_type || 'detection',
    product: payload.product || 'Unknown',
    metric: payload.metric || 'unknown',
    entity_identifier: payload.entity_identifier || 'unknown',
    entity_type: payload.entity_type || 'unknown',
    entity_name: payload.entity_name || payload.entity_identifier || 'unknown',
    started_at: payload.started_at || null,
    ended_at: payload.ended_at || null,
    current_state: payload.current_state || 'ongoing',
    criticality_score: score,
    severity: classifySeverity(score),
    stats: payload.stats || {},
    schema_version: payload.schema_version || '1.0',
    source,
    raw_payload: payload
  };
}

function storeAndBroadcast(alert) {
  dbInsert(alert);
  broadcastAlert(alert);
  console.log(`[ALERT] ${alert.severity} | ${alert.entity_name} (${alert.entity_type}) | score: ${alert.criticality_score} | state: ${alert.current_state} | src: ${alert.source}`);
}

// ── SSE endpoint ──
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const total = db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt;
  res.write(`data: ${JSON.stringify({ type: 'connected', count: total })}\n\n`);

  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 30000);
  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
});

// ── Webhook handlers ──
function handleWebhook(source) {
  return (req, res) => {
    let body = req.body;
    if (typeof body === 'string') body = tryParseJSON(body) || body;
    if (Buffer.isBuffer(body)) body = tryParseJSON(body.toString()) || body;

    const payload = extractOverwatchPayload(body);
    if (!payload || typeof payload !== 'object') {
      console.log(`[WARN] Invalid payload from ${source}:`, typeof body);
      return res.status(200).json({ status: 'received_raw', warning: 'Could not extract alert structure', source });
    }

    const alert = processAlert(payload, source);
    storeAndBroadcast(alert);
    res.status(200).json({ status: 'received', alert_id: alert.alert_id, source });
  };
}

app.post('/webhook/overwatch', handleWebhook('overwatch'));
app.post('/webhook/pipedream', handleWebhook('pipedream'));
app.post('/webhook/:source', handleWebhook('dynamic'));
app.put('/webhook/:source?', handleWebhook('put'));
app.patch('/webhook/:source?', handleWebhook('patch'));

// ── REST API ──
app.get('/api/alerts', (req, res) => {
  const { state, severity, entity_type, from, to, limit = 500 } = req.query;
  const alerts = dbFetch({ state, severity, entity_type, from, to, limit });
  res.json({ total: alerts.length, alerts });
});

app.get('/api/stats', (req, res) => {
  const { from, to } = req.query;
  const stats = dbStats({ from, to });
  res.json({ ...stats, connected_clients: sseClients.size });
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  alerts_count: db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt,
  connected_clients: sseClients.size,
  memory: process.memoryUsage()
}));

app.delete('/api/alerts', (_req, res) => {
  db.prepare('DELETE FROM alerts').run();
  for (const client of sseClients) {
    try { client.write(`data: ${JSON.stringify({ type: 'cleared' })}\n\n`); } catch (_) {}
  }
  res.json({ status: 'cleared' });
});

function purgeOld() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const { changes } = db.prepare('DELETE FROM alerts WHERE received_at < ?').run(cutoff);
  if (changes > 0) console.log(`[PURGE] Removed ${changes} alerts older than ${RETENTION_DAYS} days`);
}
setInterval(purgeOld, 3600000);
purgeOld();

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const count = db.prepare('SELECT COUNT(*) as cnt FROM alerts').get().cnt;
  console.log(`\n  PayU Overwatch Alerts on port ${PORT} | ${count} alerts in DB`);
  console.log(`  POST /webhook/overwatch | POST /webhook/pipedream | POST /webhook/:any`);
  console.log(`  GET  /api/alerts | /api/alerts/stream | /api/stats | /api/health\n`);
});
