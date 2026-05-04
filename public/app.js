(function () {
  'use strict';

  const alerts = [];
  let stateF = 'all', sevF = 'all', entF = 'all';
  let dateFrom = '', dateTo = '';
  let es = null;

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const list = $('#alertsList');
  const empty = $('#emptyState');
  const count = $('#alertCount');
  const conn = $('#connectionStatus');
  const BASE = location.origin;

  function setDefaultDates(days) {
    if (days === 0) {
      dateFrom = ''; dateTo = '';
      $('#dateFrom').value = ''; $('#dateTo').value = '';
    } else {
      const to = new Date();
      const from = new Date(Date.now() - days * 86400000);
      dateFrom = from.toISOString();
      dateTo = '';
      $('#dateFrom').value = from.toISOString().slice(0, 10);
      $('#dateTo').value = to.toISOString().slice(0, 10);
    }
  }

  function dateParams() {
    const p = new URLSearchParams();
    if (dateFrom) p.set('from', dateFrom);
    if (dateTo) p.set('to', dateTo);
    return p.toString();
  }

  function connectSSE() {
    if (es) es.close();
    es = new EventSource('/api/alerts/stream');
    es.onopen = () => {
      conn.className = 'connection-status connected';
      conn.querySelector('.status-text').textContent = 'Connected';
    };
    es.onmessage = e => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === 'connected') { fetchAll(); return; }
        if (d.type === 'cleared') { alerts.length = 0; render(); stats(); return; }
        if (d.type === 'refresh') { fetchAll(); stats(); return; }
        d._new = true;
        alerts.unshift(d);
        render(); stats();
      } catch (_) {}
    };
    es.onerror = () => {
      conn.className = 'connection-status error';
      conn.querySelector('.status-text').textContent = 'Disconnected';
      setTimeout(connectSSE, 3000);
    };
  }

  async function fetchAll() {
    try {
      const dp = dateParams();
      const r = await fetch(`/api/alerts?limit=500${dp ? '&' + dp : ''}`);
      const d = await r.json();
      alerts.length = 0;
      d.alerts.forEach(a => alerts.push(a));
      render(); stats();
    } catch (_) {}
  }

  async function stats() {
    try {
      const dp = dateParams();
      const r = await fetch(`/api/stats${dp ? '?' + dp : ''}`);
      const s = await r.json();
      $('#statTotal').childNodes[0].textContent = s.total;
      $('#statOngoing').childNodes[0].textContent = s.ongoing;
      $('#statResolved').childNodes[0].textContent = s.resolved;
      $('#statHigh').childNodes[0].textContent = s.high;
      $('#statMedium').childNodes[0].textContent = s.medium;
      $('#statLow').childNodes[0].textContent = s.low;
    } catch (_) {}
  }

  function render() {
    let f = [...alerts];
    if (stateF !== 'all') f = f.filter(a => a.current_state === stateF);
    if (sevF !== 'all') f = f.filter(a => a.severity === sevF);
    if (entF !== 'all') f = f.filter(a => a.entity_type === entF);

    count.textContent = `${f.length} alert${f.length !== 1 ? 's' : ''}`;

    if (!f.length) {
      list.innerHTML = '';
      list.appendChild(empty);
      empty.style.display = 'flex';
      return;
    }

    empty.style.display = 'none';
    list.innerHTML = '';
    f.forEach((a, i) => {
      list.appendChild(makeRow(a, i === 0 && a._new));
      a._new = false;
    });
  }

  function makeRow(a, flash) {
    const el = document.createElement('div');
    el.className = `arow sev-${a.severity}${flash ? ' flash' : ''}`;

    const s = a.stats || {};
    const on = a.current_state === 'ongoing';

    const inl = [];
    if (s.failed_count != null) inl.push(`Failed: <strong>${fmtN(s.failed_count)}</strong>`);
    if (s.success_rate_during_downtime != null) inl.push(`SRT: <strong>${s.success_rate_during_downtime}%</strong>`);
    if (s.duration != null) inl.push(`Dur: <strong>${fmtD(s.duration)}</strong>`);

    el.innerHTML = `
      <div class="arow-sum">
        <div class="arow-entity">
          <span class="ename">${esc(a.entity_name)}</span>
          <span class="etype">${esc(a.entity_type)}</span>
        </div>
        <span class="sev-badge ${a.severity}">${a.severity} · ${a.criticality_score}</span>
        <span class="state-badge ${a.current_state}">${on ? '<span class="live-dot"></span>' : ''}${a.current_state}</span>
        <div class="arow-stats">${inl.map(s => `<span>${s}</span>`).join('')}</div>
        <span class="arow-time">${fmtBrief(a.received_at)}</span>
        <svg class="chevron" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="arow-detail">${detail(a)}</div>
    `;

    el.querySelector('.arow-sum').onclick = () => el.classList.toggle('open');
    el.querySelector('.btn-curl').onclick = e => { e.stopPropagation(); clip(curl(a), e.currentTarget); };
    el.querySelector('.btn-json').onclick = e => { e.stopPropagation(); clip(JSON.stringify(a.raw_payload || a, null, 2), e.currentTarget); };

    return el;
  }

  function detail(a) {
    const s = a.stats || {};
    const z = s.zero_srt === true;

    const items = [
      s.failed_count != null ? m('Failed Txns', fmtN(s.failed_count)) : '',
      s.success_rate_during_downtime != null ? m('SRT During Issue', s.success_rate_during_downtime + '%', z) : '',
      s.reference_srt != null ? m('Reference SRT', s.reference_srt + '%') : '',
      s.srt_drop_abs != null ? m('SRT Drop (Abs)', s.srt_drop_abs + '%') : '',
      s.srt_drop_rel != null ? m('SRT Drop (Rel)', s.srt_drop_rel + '%') : '',
      s.duration != null ? m('Duration', fmtD(s.duration)) : '',
    ].filter(Boolean).join('');

    const raw = a.raw_payload || a;
    const clean = { ...raw }; delete clean._new;

    return `
      <div class="det-grid">${items}</div>
      ${z ? '<div class="zero-warn">⚠ Zero Success Rate — All transactions failing</div>' : ''}
      <div class="det-meta">
        <span>ID: <strong>${esc(a.alert_id)}</strong></span>
        <span>Metric: <strong>${esc(a.metric)}</strong></span>
        <span>Product: <strong>${esc(a.product)}</strong></span>
        <span>Started: <strong>${fmtT(a.started_at)}</strong></span>
        ${a.ended_at ? `<span>Ended: <strong>${fmtT(a.ended_at)}</strong></span>` : ''}
        <span>Received: <strong>${fmtT(a.received_at)}</strong></span>
      </div>
      <div class="det-label">Raw Payload</div>
      <pre class="det-json">${esc(JSON.stringify(clean, null, 2))}</pre>
      <div class="det-actions">
        <button class="btn-cp btn-curl"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy curl</button>
        <button class="btn-cp btn-json"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy JSON</button>
      </div>
    `;
  }

  function m(lbl, val, zero) {
    return `<div class="det-stat"><span class="det-lbl">${lbl}</span><span class="det-val${zero ? ' zero' : ''}">${val}</span></div>`;
  }

  function curl(a) {
    const p = a.raw_payload || a;
    const c = { ...p }; delete c._new;
    return `curl -X POST ${BASE}/webhook/overwatch \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(c, null, 2)}'`;
  }

  function clip(txt, btn) {
    navigator.clipboard.writeText(txt).then(() => {
      const o = btn.innerHTML;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = o; btn.classList.remove('copied'); }, 1200);
    });
  }

  // Filters
  $$('.fbtn:not(.sev-filter):not(.ent-filter)').forEach(b => b.onclick = () => {
    $$('.fbtn:not(.sev-filter):not(.ent-filter)').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); stateF = b.dataset.filter; render();
  });
  $$('.fbtn.sev-filter').forEach(b => b.onclick = () => {
    $$('.fbtn.sev-filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); sevF = b.dataset.severity; render();
  });
  $$('.fbtn.ent-filter').forEach(b => b.onclick = () => {
    $$('.fbtn.ent-filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active'); entF = b.dataset.entity; render();
  });

  // Test alert
  $('#btnTestAlert').onclick = async () => {
    const ents = [
      { name: 'flipkart', type: 'merchant' }, { name: 'amazon', type: 'merchant' },
      { name: 'swiggy', type: 'merchant' }, { name: 'hdfc_bank', type: 'acquirer' },
      { name: 'axis_bank', type: 'acquirer' }, { name: 'icici_bank', type: 'issuer' },
      { name: 'sbi', type: 'issuer' }, { name: 'visa', type: 'card_scheme' },
      { name: 'mastercard', type: 'card_scheme' }, { name: 'rupay', type: 'card_scheme' },
    ];
    const e = ents[Math.floor(Math.random() * ents.length)];
    const sc = Math.floor(Math.random() * 100);
    const zr = Math.random() < 0.1;
    const srt = zr ? 0 : +(Math.random() * 80 + 10).toFixed(2);
    const ref = +(Math.random() * 30 + 50).toFixed(2);

    await fetch('/webhook/overwatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alert_id: crypto.randomUUID(),
        alert_group_id: crypto.randomUUID(),
        notification_id: crypto.randomUUID(),
        notification_triggered_at: new Date().toISOString(),
        notification_type: 'detection',
        product: 'PayuBizTransactionEngine',
        metric: 'success_rate',
        entity_identifier: e.name, entity_type: e.type, entity_name: e.name,
        started_at: new Date(Date.now() - Math.random() * 3600000).toISOString(),
        ended_at: Math.random() < 0.3 ? new Date().toISOString() : null,
        current_state: Math.random() < 0.3 ? 'resolved' : 'ongoing',
        criticality_score: sc,
        stats: {
          failed_count: Math.floor(Math.random() * 10000),
          success_rate_during_downtime: srt, reference_srt: ref,
          srt_drop_abs: +(ref - srt).toFixed(2),
          srt_drop_rel: +((ref - srt) / ref * 100).toFixed(2),
          zero_srt: zr, duration: Math.floor(Math.random() * 500)
        },
        schema_version: '1.0'
      })
    }).catch(() => {});
  };

  // Helpers
  function esc(s) { const d = document.createElement('div'); d.textContent = String(s ?? ''); return d.innerHTML; }
  function fmtN(n) { return Number(n).toLocaleString(); }
  function fmtD(m) { return m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`; }
  function fmtT(iso) {
    if (!iso) return 'N/A';
    try { return new Date(iso).toLocaleString('en-US', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }); }
    catch { return iso; }
  }
  function fmtBrief(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit', hour12:false }); }
    catch { return ''; }
  }

  $('#btnApplyDate').onclick = () => {
    const f = $('#dateFrom').value;
    const t = $('#dateTo').value;
    dateFrom = f ? new Date(f).toISOString() : '';
    dateTo = t ? new Date(t + 'T23:59:59').toISOString() : '';
    $$('.dr-quick').forEach(b => b.classList.remove('active'));
    fetchAll();
  };

  $$('.dr-quick').forEach(b => b.onclick = () => {
    $$('.dr-quick').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    setDefaultDates(parseInt(b.dataset.days, 10));
    fetchAll();
  });

  setDefaultDates(30);

  let keepalivePollTimer = null;

  async function scheduleKeepaliveFromServer() {
    try {
      const r = await fetch('/api/config');
      const c = await r.json();
      const interval = Number(c.refresh_interval_ms) > 0 ? Number(c.refresh_interval_ms) : 15 * 60 * 1000;
      if (keepalivePollTimer) clearInterval(keepalivePollTimer);
      keepalivePollTimer = setInterval(() => { fetchAll(); stats(); }, interval);
    } catch (_) {
      if (!keepalivePollTimer) {
        keepalivePollTimer = setInterval(() => { fetchAll(); stats(); }, 15 * 60 * 1000);
      }
    }
  }

  scheduleKeepaliveFromServer();
  connectSSE();
  fetchAll();
})();
