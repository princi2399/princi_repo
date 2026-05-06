require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createAlertStore } = require('./alert-store');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.text({ type: 'text/*', limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));

/** Learn public origin from traffic so self-wake works without manual env (runs before static). */
let requestDerivedPublicBase = '';
app.use((req, _res, next) => {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  const host = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  if (host && !/^127\.0\.0\.1$|^localhost$|^\[::1\]$/i.test(host)) {
    requestDerivedPublicBase = `${proto}://${host}`.replace(/\/$/, '');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '30', 10);
const KEEPALIVE_MINUTES = parseInt(process.env.KEEPALIVE_MINUTES || '15', 10);
const KEEPALIVE_MS = Math.max(1, KEEPALIVE_MINUTES) * 60 * 1000;
const PORT = process.env.PORT || 3000;

/** Env override, then Render default, then last seen Host from real requests */
function selfWakeBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || requestDerivedPublicBase || '')
    .trim()
    .replace(/\/$/, '');
}

const sseClients = new Set();

function broadcastAlert(alert) {
  const data = JSON.stringify(alert);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch (_) {}
  }
}

/** Tells open dashboards to refetch; also used with optional self-wake for hosting idle timers. */
function broadcastSseJson(obj) {
  const data = JSON.stringify(obj);
  for (const client of sseClients) {
    try { client.write(`data: ${data}\n\n`); } catch (_) {}
  }
}

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
  if (raw.trigger?.event) {
    const inner = extractOverwatchPayload(raw.trigger.event);
    if (inner?.alert_id) return inner;
  }
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
    if (evt && typeof evt === 'object' && evt.alert_id) return evt;
    if (evt?.body !== undefined && evt?.body !== null) {
      const body = typeof evt.body === 'string' ? tryParseJSON(evt.body) : evt.body;
      if (body?.alert_id) return body;
      if (body && typeof body === 'object') {
        const fromBody = extractOverwatchPayload(body);
        if (fromBody?.alert_id) return fromBody;
      }
    }
    if (evt?.url && typeof evt.body === 'object' && evt.body) return extractOverwatchPayload(evt.body);
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

/** Map PayU V2 states (e.g. "recovered") and compound entity types to our canonical buckets. */
function normalizeState(s) {
  if (!s) return 'ongoing';
  const v = String(s).toLowerCase();
  if (['resolved', 'recovered', 'recovery', 'closed', 'cleared'].includes(v)) return 'resolved';
  if (['ongoing', 'open', 'active', 'detected', 'firing'].includes(v)) return 'ongoing';
  return v;
}
function normalizeEntityType(t) {
  if (!t) return 'merchant';
  const v = String(t).toLowerCase().trim();
  if (v.includes('issuer')) return 'issuer';
  if (v.includes('acquirer') || v === 'pg' || v.includes('pg_id') || v.includes('acquiring_bank')) return 'acquirer';
  if (v.includes('scheme') || v.includes('network') || v === 'mode' || v.includes('card_type')) return 'scheme';
  if (v.includes('merchant') || v === 'mid' || v === 'ibibo_code') return 'merchant';
  return 'merchant';
}

function safeIso(v, nowMs) {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return new Date(Math.min(t, nowMs)).toISOString();
}

function processAlert(payload, source = 'webhook') {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const score = payload.criticality_score ?? 0;
  const received =
    safeIso(payload.received_at, nowMs) ||
    safeIso(payload.notification_triggered_at, nowMs) ||
    safeIso(payload.started_at, nowMs) ||
    nowIso;
  return {
    received_at: received,
    alert_id: payload.alert_id || `auto-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
    alert_group_id: payload.alert_group_id || null,
    notification_id: payload.notification_id || null,
    notification_triggered_at: safeIso(payload.notification_triggered_at, nowMs) || nowIso,
    notification_type: payload.notification_type || 'detection',
    product: payload.product || 'Unknown',
    metric: payload.metric || 'unknown',
    entity_identifier: payload.entity_identifier || 'unknown',
    entity_type: normalizeEntityType(payload.entity_type),
    entity_name: payload.entity_name || payload.merchant_name || payload.entity_identifier || 'unknown',
    started_at: safeIso(payload.started_at, nowMs),
    ended_at: safeIso(payload.ended_at, nowMs),
    current_state: normalizeState(payload.current_state),
    criticality_score: score,
    severity: classifySeverity(score),
    stats: payload.stats || {},
    schema_version: payload.schema_version || '1.0',
    source,
    raw_payload: payload
  };
}

async function bootstrap() {
  const store = await createAlertStore(RETENTION_DAYS);

  async function persistAndBroadcast(alert) {
    await store.insert(alert);
    broadcastAlert(alert);
    console.log(`[ALERT] ${alert.severity} | ${alert.entity_name} (${alert.entity_type}) | score: ${alert.criticality_score} | state: ${alert.current_state} | src: ${alert.source}`);
  }

  app.get('/api/alerts/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (req.socket) {
      req.socket.setTimeout(0);
      if (typeof req.socket.setNoDelay === 'function') req.socket.setNoDelay(true);
    }
    res.flushHeaders();
    res.write(': stream\n\n');

    (async () => {
      let total = 0;
      try {
        total = await store.count();
      } catch (e) {
        console.error('[SSE] count', e);
      }
      if (req.aborted || res.writableEnded) return;
      try {
        res.write(`data: ${JSON.stringify({ type: 'connected', count: total })}\n\n`);
      } catch (_) {
        return;
      }
      sseClients.add(res);
      let cleaned = false;
      let keepAlive = null;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (keepAlive) clearInterval(keepAlive);
        sseClients.delete(res);
      };
      keepAlive = setInterval(() => {
        try {
          res.write(': keep-alive\n\n');
        } catch (_) {
          cleanup();
        }
      }, 25000);
      req.on('close', cleanup);
      res.on('close', cleanup);
    })();
  });

  function handleWebhook(source) {
    return async (req, res) => {
      const logEntry = {
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.originalUrl || req.path,
        source,
        ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '',
        content_type: req.headers['content-type'] || '',
        headers: {
          'content-type': req.headers['content-type'],
          'user-agent': req.headers['user-agent'],
          'x-forwarded-for': req.headers['x-forwarded-for'],
          'host': req.headers['host']
        },
        body: null,
        extracted_alert_id: null,
        processing_status: 'pending',
        processing_message: null,
        response_code: 200
      };

      let body = req.body;
      if (typeof body === 'string') body = tryParseJSON(body) || body;
      if (Buffer.isBuffer(body)) body = tryParseJSON(body.toString()) || body;
      logEntry.body = body;

      const payload = extractOverwatchPayload(body);
      if (!payload || typeof payload !== 'object') {
        console.log(`[WARN] Invalid payload from ${source}:`, typeof body);
        logEntry.processing_status = 'rejected';
        logEntry.processing_message = 'Could not extract alert structure';
        logEntry.response_code = 200;
        try { await store.insertLog(logEntry); } catch (e) { console.error('[LOG]', e.message); }
        return res.status(200).json({ status: 'received_raw', warning: 'Could not extract alert structure', source });
      }

      const alert = processAlert(payload, source);
      logEntry.extracted_alert_id = alert.alert_id;
      try {
        await persistAndBroadcast(alert);
        logEntry.processing_status = 'success';
        logEntry.processing_message = `Stored alert ${alert.alert_id}`;
        logEntry.response_code = 200;
        try { await store.insertLog(logEntry); } catch (e) { console.error('[LOG]', e.message); }
        res.status(200).json({ status: 'received', alert_id: alert.alert_id, source });
      } catch (err) {
        console.error('[ERR] store.insert', err);
        logEntry.processing_status = 'error';
        logEntry.processing_message = err.message;
        logEntry.response_code = 500;
        try { await store.insertLog(logEntry); } catch (e) { console.error('[LOG]', e.message); }
        res.status(500).json({ status: 'error', message: err.message });
      }
    };
  }

  app.post('/webhook/overwatch', handleWebhook('overwatch'));
  app.post('/webhook/pipedream', handleWebhook('pipedream'));
  app.post('/webhook/:source', handleWebhook('dynamic'));
  app.put('/webhook/:source?', handleWebhook('put'));
  app.patch('/webhook/:source?', handleWebhook('patch'));

  app.get('/api/config', (req, res) => {
    const proto = (req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = (req.get('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
    const base = (selfWakeBaseUrl() || `${proto}://${host}`).replace(/\/$/, '');
    res.json({
      public_base: base,
      webhook_overwatch: `${base}/webhook/overwatch`,
      webhook_pipedream: `${base}/webhook/pipedream`,
      alerts_stream_sse: `${base}/api/alerts/stream`,
      refresh_interval_ms: KEEPALIVE_MS,
      refresh_interval_minutes: KEEPALIVE_MINUTES,
      self_wake_enabled: Boolean(selfWakeBaseUrl() && process.env.DISABLE_SELF_WAKE !== '1')
    });
  });

  app.get('/api/alerts', async (req, res) => {
    try {
      const { state, severity, entity_type, from, to, limit = 2000 } = req.query;
      const lim = Math.min(Math.max(parseInt(limit, 10) || 2000, 1), 5000);
      const alerts = await store.fetch({ state, severity, entity_type, from, to, limit: lim });
      res.json({ total: alerts.length, alerts });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      const { from, to } = req.query;
      const stats = await store.stats({ from, to });
      res.json({ ...stats, connected_clients: sseClients.size });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/health', async (_req, res) => {
    try {
      const alerts_count = await store.count();
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        alerts_count,
        connected_clients: sseClients.size,
        memory: process.memoryUsage(),
        database: store.kind,
        database_location: store.location || null,
        retention_days: RETENTION_DAYS
      });
    } catch (err) {
      res.status(500).json({ status: 'error', message: err.message });
    }
  });

  app.get('/api/db/info', async (_req, res) => {
    try {
      const tables = await store.tables();
      res.json({
        engine: store.kind,
        location: store.location || (store.kind === 'postgres' ? 'remote (DATABASE_URL)' : null),
        retention_days: RETENTION_DAYS,
        total_alerts: await store.count(),
        tables
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/db/schema', async (req, res) => {
    try {
      const table = req.query.table || 'alerts';
      res.json({ table, columns: await store.schema(table) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/db/rows', async (req, res) => {
    try {
      const result = await store.rows({
        table: req.query.table || 'alerts',
        limit: req.query.limit,
        offset: req.query.offset,
        orderBy: req.query.order_by,
        dir: req.query.dir
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  function isReadOnlySql(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const stripped = raw
      .replace(/--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
      .replace(/;+\s*$/, '');
    if (!stripped) return false;
    if (/;/.test(stripped)) return false;
    if (!/^(select|with|pragma\s+table_info|explain)\b/i.test(stripped)) return false;
    if (/\b(insert|update|delete|drop|alter|create|attach|detach|truncate|grant|revoke|vacuum|reindex|replace)\b/i.test(stripped)) return false;
    return true;
  }

  app.post('/api/db/query', async (req, res) => {
    try {
      const sql = (req.body && req.body.sql) || '';
      if (!isReadOnlySql(sql)) {
        return res.status(400).json({ error: 'Only single read-only SELECT/WITH queries are allowed.' });
      }
      const limited = /\blimit\b/i.test(sql) ? sql : `${sql.replace(/;\s*$/, '')} LIMIT 500`;
      const out = await store.query(limited);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/webhook-logs', async (req, res) => {
    try {
      const { limit, offset, from, to } = req.query;
      const result = await store.fetchLogs({ limit, offset, from, to });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/webhook-logs/stats', async (_req, res) => {
    try {
      const result = await store.fetchLogs({ limit: 1 });
      res.json({ total: result.total });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/alerts', async (_req, res) => {
    try {
      await store.deleteAll();
      for (const client of sseClients) {
        try { client.write(`data: ${JSON.stringify({ type: 'cleared' })}\n\n`); } catch (_) {}
      }
      res.json({ status: 'cleared' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  async function purgeOld() {
    try {
      const n = await store.purge();
      if (n > 0) console.log(`[PURGE] Removed ${n} alerts older than ${RETENTION_DAYS} days`);
      const nLogs = await store.purgeLogs();
      if (nLogs > 0) console.log(`[PURGE] Removed ${nLogs} webhook logs older than ${RETENTION_DAYS} days`);
    } catch (e) {
      console.error('[PURGE]', e.message);
    }
  }
  setInterval(purgeOld, 3600000);
  await purgeOld();

  async function selfWakePing() {
    const base = selfWakeBaseUrl();
    if (!base || process.env.DISABLE_SELF_WAKE === '1') return;
    try {
      const u = new URL('/api/health', `${base}/`);
      const r = await fetch(u, { headers: { 'user-agent': 'overwatch-alerts-self-wake' } });
      if (!r.ok) console.warn('[SELF-WAKE] HTTP', r.status);
    } catch (e) {
      console.warn('[SELF-WAKE]', e.message);
    }
  }

  setInterval(async () => {
    broadcastSseJson({
      type: 'refresh',
      reason: 'keepalive',
      at: new Date().toISOString()
    });
    if (sseClients.size) {
      console.log(`[KEEPALIVE] SSE refresh → ${sseClients.size} client(s)`);
    }
    await selfWakePing();
  }, KEEPALIVE_MS);
  setTimeout(() => { selfWakePing(); }, 60000);

  app.get('/db', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'db.html'));
  });

  app.get('/logs', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
  });

  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, '0.0.0.0', async () => {
    const count = await store.count();
    console.log(`\n  PayU Overwatch Alerts on port ${PORT} | ${count} alerts | DB: ${store.kind} | retention ${RETENTION_DAYS}d`);
    console.log(`  POST /webhook/overwatch | POST /webhook/pipedream | POST /webhook/:any`);
    console.log(`  GET  /api/config | /api/alerts | /api/alerts/stream | /api/stats | /api/health`);
    const wake = selfWakeBaseUrl();
    console.log(`  Keepalive: every ${KEEPALIVE_MINUTES}m → SSE refresh${wake ? ' + self-wake → ' + wake + '/api/health' : ''}\n`);
  });
}

bootstrap().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
