require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const dbStore = require('./db-store');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const RETENTION_DAYS = 30;

function retentionCutoffIso() {
  return new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
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

async function storeAndBroadcast(alert) {
  await dbStore.insertAlert(alert);
  broadcastAlert(alert);
  console.log(`[ALERT] ${alert.severity} | ${alert.entity_name} (${alert.entity_type}) | score: ${alert.criticality_score} | state: ${alert.current_state} | src: ${alert.source}`);
}

// ── SSE endpoint ──
app.get('/api/alerts/stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const total = await dbStore.countAlerts();
    res.write(`data: ${JSON.stringify({ type: 'connected', count: total })}\n\n`);
  } catch (e) {
    res.write(`data: ${JSON.stringify({ type: 'connected', count: 0, error: String(e.message) })}\n\n`);
  }

  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 30000);
  req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
});

// ── Webhook handlers ──
function handleWebhook(source) {
  return async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') body = tryParseJSON(body) || body;
    if (Buffer.isBuffer(body)) body = tryParseJSON(body.toString()) || body;

    const payload = extractOverwatchPayload(body);
    if (!payload || typeof payload !== 'object') {
      console.log(`[WARN] Invalid payload from ${source}:`, typeof body);
      return res.status(200).json({ status: 'received_raw', warning: 'Could not extract alert structure', source });
    }

    const alert = processAlert(payload, source);
    try {
      await storeAndBroadcast(alert);
      res.status(200).json({ status: 'received', alert_id: alert.alert_id, source });
    } catch (err) {
      console.error('[ERR] store alert:', err);
      res.status(500).json({ status: 'error', message: 'Failed to persist alert' });
    }
  };
}

app.post('/webhook/overwatch', handleWebhook('overwatch'));
app.post('/webhook/pipedream', handleWebhook('pipedream'));
app.post('/webhook/:source', handleWebhook('dynamic'));
app.put('/webhook/:source?', handleWebhook('put'));
app.patch('/webhook/:source?', handleWebhook('patch'));

// ── REST API ──
app.get('/api/alerts', async (req, res) => {
  try {
    const { state, severity, entity_type, from, to, limit = 500 } = req.query;
    const alerts = await dbStore.fetchAlerts({
      state, severity, entity_type, from, to, limit,
      retentionCutoff: retentionCutoffIso()
    });
    res.json({ total: alerts.length, alerts });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const { from, to } = req.query;
    const stats = await dbStore.fetchStats({ from, to, retentionCutoff: retentionCutoffIso() });
    res.json({ ...stats, connected_clients: sseClients.size, storage: dbStore.getMode() });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

app.get('/api/health', async (_req, res) => {
  try {
    const alerts_count = await dbStore.countAlerts();
    res.json({
      status: 'ok',
      storage: dbStore.getMode(),
      retention_days: RETENTION_DAYS,
      uptime: process.uptime(),
      alerts_count,
      connected_clients: sseClients.size,
      memory: process.memoryUsage()
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.delete('/api/alerts', async (_req, res) => {
  try {
    await dbStore.deleteAllAlerts();
    for (const client of sseClients) {
      try { client.write(`data: ${JSON.stringify({ type: 'cleared' })}\n\n`); } catch (_) {}
    }
    res.json({ status: 'cleared' });
  } catch (e) {
    res.status(500).json({ error: String(e.message) });
  }
});

async function purgeOld() {
  const cutoff = retentionCutoffIso();
  const changes = await dbStore.purgeBefore(cutoff);
  if (changes > 0) console.log(`[PURGE] Removed ${changes} alerts older than ${RETENTION_DAYS} days`);
}

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

(async function start() {
  await dbStore.init();
  setInterval(() => { purgeOld().catch(e => console.error('[PURGE]', e)); }, 3600000);
  purgeOld().catch(e => console.error('[PURGE]', e));

  app.listen(PORT, '0.0.0.0', async () => {
    const count = await dbStore.countAlerts().catch(() => 0);
    console.log(`\n  PayU Overwatch Alerts on port ${PORT} | ${count} alerts in DB | retention ${RETENTION_DAYS}d | storage: ${dbStore.getMode()}`);
    console.log(`  POST /webhook/overwatch | POST /webhook/pipedream | POST /webhook/:any`);
    console.log(`  GET  /api/alerts | /api/alerts/stream | /api/stats | /api/health\n`);
  });
})().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
