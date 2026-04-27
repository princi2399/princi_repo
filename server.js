require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MAX_ALERTS = 1000;
const alerts = [];
const sseClients = new Set();
const webhookLog = [];

function classifySeverity(score) {
  if (score >= 61) return 'HIGH';
  if (score >= 31) return 'MEDIUM';
  return 'LOW';
}

function broadcastAlert(alert) {
  const data = JSON.stringify(alert);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch (_) {}
  }
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

  if (Array.isArray(raw)) {
    return raw.length > 0 ? extractOverwatchPayload(raw[0]) : null;
  }

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
  alerts.unshift(alert);
  if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
  broadcastAlert(alert);
  webhookLog.push({
    timestamp: new Date().toISOString(),
    alert_id: alert.alert_id,
    source: alert.source,
    severity: alert.severity,
    entity: alert.entity_name
  });
  if (webhookLog.length > 200) webhookLog.splice(0, webhookLog.length - 200);
  console.log(`[ALERT] ${alert.severity} | ${alert.entity_name} (${alert.entity_type}) | score: ${alert.criticality_score} | state: ${alert.current_state} | src: ${alert.source}`);
}

// SSE endpoint for real-time alert streaming
app.get('/api/alerts/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: 'connected', count: alerts.length })}\n\n`);

  sseClients.add(res);

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 30000);
  req.on('close', () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  });
});

function handleWebhook(source) {
  return (req, res) => {
    let body = req.body;
    if (typeof body === 'string') body = tryParseJSON(body) || body;
    if (Buffer.isBuffer(body)) body = tryParseJSON(body.toString()) || body;

    const payload = extractOverwatchPayload(body);

    if (!payload || typeof payload !== 'object') {
      console.log(`[WARN] Invalid payload from ${source}:`, typeof body, body);
      return res.status(200).json({
        status: 'received_raw',
        warning: 'Could not extract Overwatch alert structure, stored as raw',
        source
      });
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

// REST API to fetch stored alerts
app.get('/api/alerts', (req, res) => {
  const { state, severity, entity_type, limit = 100 } = req.query;
  let filtered = [...alerts];

  if (state) filtered = filtered.filter(a => a.current_state === state);
  if (severity) filtered = filtered.filter(a => a.severity === severity.toUpperCase());
  if (entity_type) filtered = filtered.filter(a => a.entity_type === entity_type);

  res.json({
    total: filtered.length,
    alerts: filtered.slice(0, parseInt(limit, 10))
  });
});

app.get('/api/stats', (_req, res) => {
  const ongoing = alerts.filter(a => a.current_state === 'ongoing').length;
  const resolved = alerts.filter(a => a.current_state === 'resolved').length;
  const high = alerts.filter(a => a.severity === 'HIGH').length;
  const medium = alerts.filter(a => a.severity === 'MEDIUM').length;
  const low = alerts.filter(a => a.severity === 'LOW').length;
  const sources = {};
  alerts.forEach(a => { sources[a.source || 'unknown'] = (sources[a.source || 'unknown'] || 0) + 1; });

  res.json({ total: alerts.length, ongoing, resolved, high, medium, low, connected_clients: sseClients.size, sources });
});

app.get('/api/webhook-log', (_req, res) => res.json({ log: webhookLog }));

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  alerts_count: alerts.length,
  connected_clients: sseClients.size,
  memory: process.memoryUsage()
}));

app.delete('/api/alerts', (_req, res) => {
  alerts.length = 0;
  webhookLog.length = 0;
  for (const client of sseClients) {
    try { client.write(`data: ${JSON.stringify({ type: 'cleared' })}\n\n`); } catch (_) {}
  }
  res.json({ status: 'cleared' });
});

// Serve frontend
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  PayU Overwatch Alerts running on port ${PORT}`);
  console.log(`  Webhook endpoints:`);
  console.log(`    POST /webhook/overwatch   — direct Overwatch alerts`);
  console.log(`    POST /webhook/pipedream   — Pipedream forwarded events`);
  console.log(`    POST /webhook/:any        — catch-all for any source`);
  console.log(`  API:`);
  console.log(`    GET  /api/alerts           — fetch stored alerts`);
  console.log(`    GET  /api/alerts/stream    — SSE real-time stream`);
  console.log(`    GET  /api/stats            — dashboard stats`);
  console.log(`    GET  /api/health           — health check`);
  console.log(`    GET  /api/webhook-log      — recent webhook log`);
  console.log(`    DELETE /api/alerts          — clear all alerts\n`);
});
