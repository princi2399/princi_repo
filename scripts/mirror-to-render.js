#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Mirror alerts from a SOURCE server (default: local) to a TARGET server
 * (default: Render), normalizing PayU V2 fields so older builds on the
 * target also display them under the canonical filters
 * (entity_type: merchant/acquirer/issuer/scheme; current_state: ongoing/resolved).
 *
 *   SOURCE=http://localhost:3001 \
 *   TARGET=https://princi-repo.onrender.com \
 *   node scripts/mirror-to-render.js
 */
const SOURCE = (process.env.SOURCE || 'http://localhost:3001').replace(/\/$/, '');
const TARGET = (process.env.TARGET || 'https://princi-repo.onrender.com').replace(/\/$/, '');
const LIMIT = parseInt(process.env.LIMIT || '2000', 10);
const WIPE = process.env.WIPE !== 'false';

function normalizeState(s) {
  if (!s) return 'ongoing';
  const v = String(s).toLowerCase().trim();
  if (['recovered', 'resolved', 'closed', 'cleared', 'normal'].includes(v)) return 'resolved';
  if (['ongoing', 'open', 'active', 'firing', 'detected', 'triggered'].includes(v)) return 'ongoing';
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

async function fetchAll() {
  const r = await fetch(`${SOURCE}/api/alerts?limit=${LIMIT}`);
  if (!r.ok) throw new Error(`source ${r.status}`);
  const j = await r.json();
  return j.alerts || [];
}

function toPayload(a) {
  const raw = a.raw_payload && typeof a.raw_payload === 'object' ? a.raw_payload : {};
  return {
    ...raw,
    alert_id: a.alert_id,
    alert_group_id: a.alert_group_id || raw.alert_group_id,
    notification_id: a.notification_id || raw.notification_id,
    notification_type: a.notification_type || raw.notification_type,
    notification_triggered_at: a.notification_triggered_at || raw.notification_triggered_at,
    product: a.product || raw.product,
    metric: a.metric || raw.metric,
    entity_identifier: a.entity_identifier || raw.entity_identifier,
    entity_name: a.entity_name || raw.entity_name,
    merchant_name: a.merchant_name || raw.merchant_name,
    started_at: a.started_at || raw.started_at,
    ended_at: a.ended_at || raw.ended_at,
    criticality_score: a.criticality_score ?? raw.criticality_score,
    stats: raw.stats || a.stats,
    schema_version: a.schema_version || raw.schema_version || '2.0',
    // Canonical values so old builds on the target match the UI filters
    entity_type: normalizeEntityType(a.entity_type),
    current_state: normalizeState(a.current_state),
    // Preserve historical timestamps so the date range view is accurate
    received_at: a.received_at
  };
}

async function postOne(payload) {
  const wrapped = { steps: { trigger: { event: { method: 'POST', path: '/', body: payload } } } };
  const r = await fetch(`${TARGET}/webhook/pipedream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wrapped)
  });
  return r.ok;
}

(async () => {
  console.log(`Mirror ${SOURCE}  →  ${TARGET}`);
  const alerts = await fetchAll();
  console.log(`Fetched ${alerts.length} alerts from source.`);
  if (WIPE) {
    const r = await fetch(`${TARGET}/api/alerts`, { method: 'DELETE' });
    console.log(`Wiped target: ${r.status}`);
  }
  // post oldest first so insertion-order ties break correctly on the target
  alerts.sort((a, b) => (a.received_at || '').localeCompare(b.received_at || ''));
  let ok = 0;
  for (let i = 0; i < alerts.length; i++) {
    if (await postOne(toPayload(alerts[i]))) ok++;
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${alerts.length}`);
  }
  console.log(`Done. ${ok}/${alerts.length} posted.`);
})().catch(e => { console.error(e); process.exit(1); });
