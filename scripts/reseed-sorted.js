#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Clears the target server, then re-posts alerts in ascending start time
 * so that the existing `ORDER BY id DESC` puts the newest first.
 *
 *   TARGET=https://princi-repo.onrender.com node scripts/reseed-sorted.js
 */
const TARGET = (process.env.TARGET || 'http://localhost:3001').replace(/\/$/, '');
const COUNT = parseInt(process.env.COUNT || '40', 10);
const DAYS = parseInt(process.env.DAYS || '3', 10);

const merchants = [
  ['mer_swiggy', 'Swiggy'], ['mer_zomato', 'Zomato'],
  ['mer_meesho', 'Meesho'], ['mer_flipkart', 'Flipkart'],
  ['mer_myntra', 'Myntra'], ['mer_snapdeal', 'Snapdeal']
];
const acquirers = [
  ['acq_hdfc', 'HDFC Acquirer'], ['acq_icici', 'ICICI Acquirer'],
  ['acq_axis', 'Axis Acquirer'], ['acq_sbi', 'SBI Acquirer']
];
const issuers = [
  ['iss_kotak', 'Kotak Issuer'], ['iss_yes', 'YES Bank Issuer'],
  ['iss_bob', 'Bank of Baroda Issuer'], ['iss_pnb', 'PNB Issuer']
];
const schemes = [
  ['scheme_visa', 'VISA'], ['scheme_mc', 'Mastercard'],
  ['scheme_rupay', 'RuPay'], ['scheme_amex', 'AMEX']
];
const products = ['PayuBizTransactionEngine', 'PayuMoney', 'PayuCheckout', 'PayuLoans'];
const metrics = ['success_rate', 'failure_rate', 'srt_drop', 'latency'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function buildAlert() {
  const entityKind = pick(['merchant', 'acquirer', 'issuer', 'card_scheme']);
  let id, name;
  if (entityKind === 'merchant') [id, name] = pick(merchants);
  else if (entityKind === 'acquirer') [id, name] = pick(acquirers);
  else if (entityKind === 'issuer') [id, name] = pick(issuers);
  else [id, name] = pick(schemes);

  const score = 5 + Math.floor(Math.random() * 95);
  const ageMs = Math.floor(Math.random() * DAYS * 86400000);
  const startedAt = new Date(Date.now() - ageMs);
  const isResolved = Math.random() < 0.55;
  const endedAt = isResolved
    ? new Date(startedAt.getTime() + (10 + Math.floor(Math.random() * 240)) * 60000).toISOString()
    : null;
  const failed = 100 + Math.floor(Math.random() * 8000);
  const refSrt = +(80 + Math.random() * 18).toFixed(2);
  const srtDuring = +(refSrt - (5 + Math.random() * 35)).toFixed(2);
  const dropAbs = +(refSrt - srtDuring).toFixed(2);
  const dropRel = +((dropAbs / refSrt) * 100).toFixed(2);
  const duration = Math.max(1, Math.floor((Date.now() - startedAt.getTime()) / 60000));

  return {
    _sortKey: startedAt.getTime(),
    alert_id: uuid(),
    alert_group_id: uuid(),
    notification_id: uuid(),
    notification_triggered_at: startedAt.toISOString(),
    notification_type: isResolved ? 'resolution' : 'detection',
    product: pick(products),
    metric: pick(metrics),
    entity_identifier: id,
    entity_type: entityKind,
    entity_name: name,
    started_at: startedAt.toISOString(),
    ended_at: endedAt,
    current_state: isResolved ? 'resolved' : 'ongoing',
    criticality_score: score,
    stats: {
      failed_count: failed,
      success_rate_during_downtime: srtDuring,
      reference_srt: refSrt,
      srt_drop_abs: dropAbs,
      srt_drop_rel: dropRel,
      zero_srt: dropRel > 80,
      duration
    },
    schema_version: '1.0',
    received_at: startedAt.toISOString()
  };
}

async function main() {
  console.log(`Clearing ${TARGET}/api/alerts ...`);
  try {
    const r = await fetch(`${TARGET}/api/alerts`, { method: 'DELETE' });
    console.log('  clear status:', r.status);
  } catch (e) {
    console.error('  clear failed:', e.message);
  }

  const batch = Array.from({ length: COUNT }, buildAlert)
    .sort((a, b) => a._sortKey - b._sortKey);
  console.log(`Posting ${batch.length} alerts in ascending start-time order so newest is at top...`);

  let ok = 0, fail = 0;
  for (let i = 0; i < batch.length; i++) {
    const a = batch[i];
    delete a._sortKey;
    try {
      const r = await fetch(`${TARGET}/webhook/overwatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(a)
      });
      if (r.ok) ok++; else fail++;
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${batch.length}`);
    } catch (e) {
      fail++;
      console.error('  POST failed:', e.message);
    }
  }
  console.log(`Done. ok=${ok} fail=${fail}`);
}

main();
