#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Generate synthetic alerts for acquirer / issuer / scheme entity types
 * so all four UI filter categories have visible data.
 *
 *   TARGETS=http://localhost:3001,https://princi-repo.onrender.com \
 *   PER_TYPE=10 DAYS_BACK=7 \
 *   node scripts/fill-entity-types.js
 */
const TARGETS = (process.env.TARGETS || 'http://localhost:3001,https://princi-repo.onrender.com')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const PER_TYPE = parseInt(process.env.PER_TYPE || '10', 10);
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '7', 10);

const ENTITIES = {
  acquirer: [
    ['acq_hdfc', 'HDFC Bank'], ['acq_icici', 'ICICI Bank'],
    ['acq_axis', 'Axis Bank'], ['acq_sbi', 'State Bank of India'],
    ['acq_kotak', 'Kotak Mahindra Bank'], ['acq_yes', 'Yes Bank']
  ],
  issuer: [
    ['iss_hdfc', 'HDFC Issuer'], ['iss_sbi', 'SBI Card'],
    ['iss_amex', 'American Express'], ['iss_icici', 'ICICI Cards'],
    ['iss_axis', 'Axis Bank Cards'], ['iss_rbl', 'RBL Bank']
  ],
  scheme: [
    ['sch_visa', 'Visa'], ['sch_mc', 'Mastercard'],
    ['sch_rupay', 'RuPay'], ['sch_amex', 'Amex Network'],
    ['sch_diners', 'Diners Club']
  ]
};

const products = ['PayuBizTransactionEngine', 'PayuMoney', 'PayuCheckout'];
const metrics = ['success_rate', 'failure_rate', 'srt_drop', 'latency'];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildAlert(entityType, daysAgo) {
  const [id, baseName] = pick(ENTITIES[entityType]);
  const score = 5 + Math.floor(Math.random() * 95);
  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() - daysAgo);
  dayStart.setHours(0, 0, 0, 0);
  const offset = Math.floor(Math.random() * 86400000);
  const startedAt = new Date(dayStart.getTime() + offset);
  const isResolved = Math.random() < 0.5;
  const endedAt = isResolved
    ? new Date(startedAt.getTime() + (10 + Math.floor(Math.random() * 240)) * 60000).toISOString()
    : null;
  const refSrt = +(80 + Math.random() * 18).toFixed(2);
  const srtDuring = +(refSrt - (5 + Math.random() * 35)).toFixed(2);

  return {
    alert_id: uuid(),
    alert_group_id: uuid(),
    notification_id: uuid(),
    notification_triggered_at: startedAt.toISOString(),
    notification_type: isResolved ? 'recovery' : 'detection',
    product: pick(products),
    metric: pick(metrics),
    entity_identifier: id,
    entity_type: entityType,
    entity_name: `[TEST] ${baseName}`,
    started_at: startedAt.toISOString(),
    ended_at: endedAt,
    current_state: isResolved ? 'resolved' : 'ongoing',
    criticality_score: score,
    stats: {
      failed_count: 100 + Math.floor(Math.random() * 8000),
      success_rate_during_downtime: srtDuring,
      reference_srt: refSrt,
      srt_drop_abs: +(refSrt - srtDuring).toFixed(2),
      srt_drop_rel: +((refSrt - srtDuring) / refSrt * 100).toFixed(2),
      zero_srt: false,
      duration: Math.floor((Date.now() - startedAt.getTime()) / 60000)
    },
    schema_version: '2.0',
    received_at: startedAt.toISOString()
  };
}

async function postAll(alert) {
  const wrapped = { steps: { trigger: { event: { method: 'POST', path: '/', body: alert } } } };
  await Promise.all(TARGETS.map(t =>
    fetch(`${t}/webhook/pipedream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wrapped)
    }).catch(() => null)
  ));
}

(async () => {
  console.log(`Targets: ${TARGETS.join(', ')}`);
  const all = [];
  for (const type of Object.keys(ENTITIES)) {
    for (let i = 0; i < PER_TYPE; i++) {
      const day = Math.floor(Math.random() * DAYS_BACK);
      all.push(buildAlert(type, day));
    }
  }
  all.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  for (let i = 0; i < all.length; i++) {
    await postAll(all[i]);
    if ((i + 1) % 5 === 0) console.log(`  ${i + 1}/${all.length}`);
  }
  console.log(`Done. ${all.length} alerts (${PER_TYPE} per type × ${Object.keys(ENTITIES).length} types).`);
})();
