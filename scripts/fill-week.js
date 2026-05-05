#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Fill days 2-7 ago with synthetic Overwatch alerts so the 7-day view has data.
 * Each alert is prefixed [TEST] so it's easy to delete later.
 *
 *   TARGETS=http://localhost:3001,https://princi-repo.onrender.com node scripts/fill-week.js
 */
const TARGETS = (process.env.TARGETS || 'http://localhost:3001')
  .split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
const PER_DAY = parseInt(process.env.PER_DAY || '5', 10);
const DAYS_BACK = parseInt(process.env.DAYS_BACK || '7', 10);

const ENTITIES = {
  merchant: [
    ['mer_swiggy', 'Swiggy'], ['mer_zomato', 'Zomato'],
    ['mer_meesho', 'Meesho'], ['mer_flipkart', 'Flipkart'],
    ['mer_myntra', 'Myntra'], ['mer_indigo', 'IndiGo'],
    ['mer_snapdeal', 'Snapdeal'], ['mer_bbb', 'BigBasket']
  ],
  acquirer: [
    ['acq_hdfc', 'HDFC Acquirer'], ['acq_icici', 'ICICI Acquirer'],
    ['acq_axis', 'Axis Acquirer'], ['acq_sbi', 'SBI Acquirer'],
    ['acq_yes', 'Yes Bank Acquirer']
  ],
  issuer: [
    ['iss_hdfc', 'HDFC Issuer'], ['iss_icici', 'ICICI Issuer'],
    ['iss_kotak', 'Kotak Issuer'], ['iss_pnb', 'PNB Issuer'],
    ['iss_indusind', 'IndusInd Issuer']
  ],
  scheme: [
    ['sch_visa', 'VISA'], ['sch_mc', 'Mastercard'],
    ['sch_rupay', 'RuPay'], ['sch_amex', 'Amex'], ['sch_diners', 'Diners']
  ]
};
const ENTITY_TYPES = Object.keys(ENTITIES);
const products = ['PayuBizTransactionEngine', 'PayuMoney', 'PayuCheckout'];
const metrics = ['success_rate', 'failure_rate', 'srt_drop', 'latency'];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildAlert(daysAgo, forcedType) {
  const entityType = forcedType || pick(ENTITY_TYPES);
  const [id, baseName] = pick(ENTITIES[entityType]);
  const score = 5 + Math.floor(Math.random() * 95);
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setDate(dayStart.getDate() - daysAgo);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart.getTime() + 86400000 - 1);
  // never schedule beyond "now" — clamp the window for today/future days
  const upper = Math.min(dayEnd.getTime(), now.getTime());
  const window = Math.max(1, upper - dayStart.getTime());
  const offset = Math.floor(Math.random() * window);
  const startedAt = new Date(dayStart.getTime() + offset);
  const isResolved = Math.random() < 0.5;
  const maxResolutionMs = Math.max(60_000, now.getTime() - startedAt.getTime());
  const endedAt = isResolved
    ? new Date(startedAt.getTime() + Math.min(maxResolutionMs, (10 + Math.floor(Math.random() * 240)) * 60000)).toISOString()
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
    entity_name: baseName,
    merchant_name: entityType === 'merchant' ? baseName : undefined,
    started_at: startedAt.toISOString(),
    ended_at: endedAt,
    current_state: isResolved ? 'recovered' : 'ongoing',
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
  console.log(`Filling days 1..${DAYS_BACK - 1} ago with ${PER_DAY} alerts each → ${TARGETS.join(', ')}`);
  const all = [];
  for (let d = 0; d < DAYS_BACK; d++) {
    for (let i = 0; i < PER_DAY; i++) {
      // round-robin across entity types so each filter has data on each day
      const t = ENTITY_TYPES[i % ENTITY_TYPES.length];
      all.push(buildAlert(d, t));
    }
  }
  // post oldest first so insertion id ordering matches event-time DESC on old-code servers
  all.sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  let ok = 0;
  for (let i = 0; i < all.length; i++) {
    await postAll(all[i]);
    ok++;
    if ((i + 1) % 5 === 0) console.log(`  ${i + 1}/${all.length}`);
  }
  console.log(`Done. ${ok} alerts posted.`);
}

main();
