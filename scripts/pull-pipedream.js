#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Pull events from a Pipedream HTTP-trigger source (real PayU Overwatch alerts)
 * and forward them to one or more Overwatch webhook URLs.
 *
 * Auth: OAuth client_credentials (preferred) or personal API key.
 *
 * Required env (one of):
 *   PD_CLIENT_ID + PD_CLIENT_SECRET   – OAuth client (workspace-level)
 *   PIPEDREAM_API_KEY                 – personal API key (pd_…)
 *
 * Identifiers:
 *   PD_SOURCE_ID    – the HTTP-trigger source id (e.g. hi_nlHnL6g) [recommended]
 *   PD_WORKFLOW_ID  – workflow id (e.g. p_KwCojKR) – auto-resolves source id
 *   PD_WORKSPACE_ID – workspace/org id (e.g. o_kPIZkXx) – required with API key
 *
 * Targets: comma-separated URLs (defaults to local + Render):
 *   TARGETS="http://localhost:3001,https://princi-repo.onrender.com"
 *
 * Behavior:
 *   - On start, backfills last LIMIT events.
 *   - Then polls every INTERVAL_MS (default 30s) and forwards new ones.
 *   - INTERVAL_MS=0 to run once and exit.
 */
const CLIENT_ID = (process.env.PD_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.PD_CLIENT_SECRET || '').trim();
const API_KEY = (process.env.PIPEDREAM_API_KEY || '').trim();
const WORKSPACE_ID = (process.env.PD_WORKSPACE_ID || '').trim();
const WORKFLOW_ID = (process.env.PD_WORKFLOW_ID || '').trim();
let SOURCE_ID = (process.env.PD_SOURCE_ID || '').trim();
const TARGETS = (process.env.TARGETS || 'http://localhost:3001,https://princi-repo.onrender.com')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const LIMIT = parseInt(process.env.LIMIT || '50', 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? '30000', 10);

if (!API_KEY && !(CLIENT_ID && CLIENT_SECRET)) {
  console.error('Need PD_CLIENT_ID+PD_CLIENT_SECRET, or PIPEDREAM_API_KEY.');
  process.exit(1);
}
if (!SOURCE_ID && !WORKFLOW_ID) {
  console.error('Need PD_SOURCE_ID or PD_WORKFLOW_ID.');
  process.exit(1);
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (API_KEY) return API_KEY;
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) return cachedToken;
  const r = await fetch('https://api.pipedream.com/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET
    })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OAuth token failed ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = await r.json();
  cachedToken = j.access_token;
  tokenExpiresAt = Date.now() + (j.expires_in || 3600) * 1000;
  return cachedToken;
}

async function pdGet(pathname) {
  const token = await getAccessToken();
  const sep = pathname.includes('?') ? '&' : '?';
  const url = `https://api.pipedream.com${pathname}${WORKSPACE_ID ? `${sep}org_id=${WORKSPACE_ID}` : ''}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Pipedream ${r.status} on ${pathname}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function resolveSourceId() {
  if (SOURCE_ID) return SOURCE_ID;
  const data = await pdGet(`/v1/workflows/${WORKFLOW_ID}`);
  const trigger = (data.triggers || []).find(t => t.id?.startsWith('hi_'))
    || (data.triggers || [])[0];
  if (!trigger) throw new Error('No trigger found on workflow ' + WORKFLOW_ID);
  SOURCE_ID = trigger.id;
  console.log(`Resolved source: ${SOURCE_ID}  (endpoint ${trigger.endpoint_url || ''})`);
  return SOURCE_ID;
}

async function listEvents() {
  const id = await resolveSourceId();
  const d = await pdGet(`/v1/sources/${id}/event_summaries?expand=event&limit=${LIMIT}`);
  return Array.isArray(d.data) ? d.data : [];
}

async function forward(target, body) {
  try {
    const r = await fetch(`${target}/webhook/pipedream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return r.ok;
  } catch (e) {
    return false;
  }
}

const seen = new Set();

async function tick(initial) {
  try {
    const events = await listEvents();
    let fwd = 0;
    for (const e of events) {
      const id = e.id || e.event?.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const wrapped = { steps: { trigger: { event: e.event } } };
      const results = await Promise.all(TARGETS.map(t => forward(t, wrapped)));
      const okList = TARGETS.filter((_, i) => results[i]);
      const aid = e.event?.body?.alert_id || '?';
      console.log(`[fwd] ${id}  alert=${aid}  → ${okList.join(', ')}`);
      fwd++;
    }
    if (initial) console.log(`[backfill] forwarded ${fwd} of ${events.length} events`);
    else if (fwd === 0) console.log(`[poll] ${new Date().toISOString().slice(11, 19)}  no new events`);
    else console.log(`[poll] forwarded ${fwd} new event(s)`);
  } catch (err) {
    console.error('[err]', err.message);
  }
}

(async () => {
  console.log(`Targets: ${TARGETS.join(', ')}`);
  console.log(`Source : ${SOURCE_ID || `(via workflow ${WORKFLOW_ID})`}`);
  console.log(`Workspace: ${WORKSPACE_ID || '(none)'}`);
  await tick(true);
  if (INTERVAL_MS > 0) {
    console.log(`Polling every ${INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
    setInterval(() => tick(false), INTERVAL_MS);
  }
})();
