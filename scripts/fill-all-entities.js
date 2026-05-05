#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Generate synthetic alerts across all four entity types
 * (merchant / acquirer / issuer / scheme) so the UI filters all have data.
 *
 *   TARGETS=http://localhost:3001,https://princi-repo.onrender.com \
 *   PER_TYPE_PER_DAY=3 DAYS_BACK=7 \
 *   node scripts/fill-all-entities.js
 */
const TARGETS = (process.env.TARGETS || 'http://localhost:3001,https://princi-repo.onrender.com')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const PER_TYPE_PER_DAY = parseInt(process.env.PER_TYPE_PER_DAY || '3', 10);
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '7', 10);

const entitySets = {
  merchant: [
    ['mer_swiggy', 'Swiggy'], ['mer_zomato', 'Zomato'],
    ['mer_meesho', 'Meesho'], ['mer_flipkart', 'Flipkart'],
    ['mer_myntra', 'Myntra'], ['mer_indigo', 'IndiGo'],
    ['mer_snapdeal', 'Snapdeal'], ['mer_bbb', 'BigBasket']
  ],
  acquirer: [
    ['acq_hdfc', 'HDFC Bank'], ['acq_icici', 'ICICI Bank'],
    ['acq_axis', 'Axis Bank'], ['acq_sbi', 'SBI'],
    ['acq_kotak', 'Kotak Mahindra'], ['acq_yes', 'Yes Bank']
  ],
  issuer: [
    ['iss_hdfc', 'HDFC Issuer'], ['iss_icici', 'ICICI Issuer'],
    ['iss_sbi', 'SBI Issuer'], ['iss_axis', 'Axis Issuer'],
    ['iss_pnb', 'PNB Issuer'], ['iss_idfc', 'IDFC First']
  ],
  scheme: [
    ['sch_visa', 'Visa'], ['sch_mc', 'Mastercard'],
    ['sch_rupay', 'RuPay'], ['sch_amex', 'American Express'],
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

function buildAlert(daysAgo, entityType) {
  const [id, baseName] = pick(entitySets[entityType]);
  const score = 5 + Math.floor(Math.random() * 95);
  const dayStart = new Date();
  dayStart.setDate(dayStart.getDate() - daysAgo);
  dayStart.setHours(0, 0, 0, 0);
  const offset = Math.floor(Math.random() * 86400000);
  const startedAt = new Date(dayStart.getTime() + offset);
  const isResolved = Math.random() < 0.45;
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
    merchant_name: entityType === 'merchant' ? `[TEST] ${baseName}` : undefined,
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

async function main() {
  console.log(`Targets: ${TARGETS.join(', ')}`);
  console.log(`Filling ${DAYS_BACK} days × ${PER_TYPE_PER_DAY} alerts × 4 entity types`);
  const all = [];
  for (let d = 0; d < DAYS_BACK; d++) {
    for (const type of Object.keys(entitySets)) {
      for (let i = 0; i < PER_TYPE_PER_DAY; i++) all.push(buildAlert(d, type));
    }
  }
  all.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  let ok = 0;
  for (let i = 0; i < all.length; i++) {
    await postAll(all[i]);
    ok++;
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${all.length}`);
  }
  console.log(`Done. ${ok} alerts posted to each target.`);
}

main();
