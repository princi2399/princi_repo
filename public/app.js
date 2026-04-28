(function () {
  'use strict';

  const alertsData = [];
  let stateFilter = 'all';
  let severityFilter = 'all';
  let entityFilter = 'all';
  let eventSource = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const alertsList = $('#alertsList');
  const emptyState = $('#emptyState');
  const alertCount = $('#alertCount');
  const connectionStatus = $('#connectionStatus');
  const BASE = window.location.origin;

  // ── SSE ──
  function connectSSE() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource('/api/alerts/stream');

    eventSource.onopen = () => {
      connectionStatus.className = 'connection-status connected';
      connectionStatus.querySelector('.status-text').textContent = 'Connected';
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'connected') { fetchAlerts(); return; }
        if (data.type === 'cleared') {
          alertsData.length = 0;
          render(); updateStats();
          return;
        }
        data._isNew = true;
        alertsData.unshift(data);
        render(); updateStats();
      } catch (err) { console.error('SSE parse error:', err); }
    };

    eventSource.onerror = () => {
      connectionStatus.className = 'connection-status error';
      connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
      setTimeout(connectSSE, 3000);
    };
  }

  async function fetchAlerts() {
    try {
      const res = await fetch('/api/alerts?limit=500');
      const data = await res.json();
      alertsData.length = 0;
      data.alerts.forEach(a => alertsData.push(a));
      render(); updateStats();
    } catch (err) { console.error('Fetch error:', err); }
  }

  async function updateStats() {
    try {
      const res = await fetch('/api/stats');
      const s = await res.json();
      $('#statTotal').textContent = s.total;
      $('#statOngoing').textContent = s.ongoing;
      $('#statResolved').textContent = s.resolved;
      $('#statHigh').textContent = s.high;
      $('#statMedium').textContent = s.medium;
      $('#statLow').textContent = s.low;
    } catch (_) {}
  }

  // ── Render ──
  function render() {
    let filtered = [...alertsData];
    if (stateFilter !== 'all') filtered = filtered.filter(a => a.current_state === stateFilter);
    if (severityFilter !== 'all') filtered = filtered.filter(a => a.severity === severityFilter);
    if (entityFilter !== 'all') filtered = filtered.filter(a => a.entity_type === entityFilter);

    alertCount.textContent = `${filtered.length} alert${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      alertsList.innerHTML = '';
      alertsList.appendChild(emptyState);
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    alertsList.innerHTML = '';
    filtered.forEach((alert, idx) => {
      alertsList.appendChild(createAlertRow(alert, idx === 0 && alert._isNew));
      alert._isNew = false;
    });
  }

  function createAlertRow(alert, isNew) {
    const row = document.createElement('div');
    row.className = `alert-row severity-${alert.severity}${isNew ? ' new-alert' : ''}`;

    const stats = alert.stats || {};
    const isOngoing = alert.current_state === 'ongoing';

    const failedStr = stats.failed_count != null ? `Failed: <strong>${fmtNum(stats.failed_count)}</strong>` : '';
    const srtStr = stats.success_rate_during_downtime != null ? `SRT: <strong>${stats.success_rate_during_downtime}%</strong>` : '';
    const durStr = stats.duration != null ? `Dur: <strong>${fmtDur(stats.duration)}</strong>` : '';

    const inlineStats = [failedStr, srtStr, durStr].filter(Boolean).map(s => `<span class="inline-stat">${s}</span>`).join('');

    row.innerHTML = `
      <div class="alert-summary">
        <div class="alert-entity">
          <span class="entity-name">${esc(alert.entity_name)}</span>
          <span class="entity-type-badge">${esc(alert.entity_type)}</span>
        </div>
        <span class="severity-badge ${alert.severity}">${alert.severity} · ${alert.criticality_score}</span>
        <span class="state-badge ${alert.current_state}">${isOngoing ? '<span class="live-dot"></span> ' : ''}${alert.current_state}</span>
        <div class="alert-inline-stats">${inlineStats}</div>
        <span class="alert-time-brief">${fmtTimeBrief(alert.received_at)}</span>
        <svg class="chevron" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="alert-detail">${buildDetail(alert)}</div>
    `;

    row.querySelector('.alert-summary').addEventListener('click', () => {
      row.classList.toggle('expanded');
    });

    row.querySelector('.btn-copy-curl').addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(buildCurl(alert), e.currentTarget);
    });

    row.querySelector('.btn-copy-json').addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(JSON.stringify(alert.raw_payload || alert, null, 2), e.currentTarget);
    });

    return row;
  }

  function buildDetail(alert) {
    const s = alert.stats || {};
    const isZero = s.zero_srt === true;

    const statItems = [
      s.failed_count != null ? `<div class="dstat"><span class="dstat-lbl">Failed Txns</span><span class="dstat-val">${fmtNum(s.failed_count)}</span></div>` : '',
      s.success_rate_during_downtime != null ? `<div class="dstat"><span class="dstat-lbl">SRT During Issue</span><span class="dstat-val${isZero ? ' zero-srt' : ''}">${s.success_rate_during_downtime}%</span></div>` : '',
      s.reference_srt != null ? `<div class="dstat"><span class="dstat-lbl">Reference SRT</span><span class="dstat-val">${s.reference_srt}%</span></div>` : '',
      s.srt_drop_abs != null ? `<div class="dstat"><span class="dstat-lbl">SRT Drop (Abs)</span><span class="dstat-val">${s.srt_drop_abs}%</span></div>` : '',
      s.srt_drop_rel != null ? `<div class="dstat"><span class="dstat-lbl">SRT Drop (Rel)</span><span class="dstat-val">${s.srt_drop_rel}%</span></div>` : '',
      s.duration != null ? `<div class="dstat"><span class="dstat-lbl">Duration</span><span class="dstat-val">${fmtDur(s.duration)}</span></div>` : '',
    ].filter(Boolean).join('');

    const payload = alert.raw_payload || alert;
    const cleanPayload = { ...payload };
    delete cleanPayload._isNew;

    return `
      <div class="detail-stats">${statItems}</div>
      ${isZero ? '<div class="zero-warning">⚠ Zero Success Rate — All transactions failing</div>' : ''}
      <div class="detail-meta">
        <span>ID: ${esc(alert.alert_id)}</span>
        <span>Metric: ${esc(alert.metric)}</span>
        <span>Product: ${esc(alert.product)}</span>
        <span>Started: ${fmtTime(alert.started_at)}</span>
        ${alert.ended_at ? `<span>Resolved: ${fmtTime(alert.ended_at)}</span>` : ''}
        <span>Received: ${fmtTime(alert.received_at)}</span>
      </div>
      <div class="detail-payload-label">Raw Payload</div>
      <pre class="detail-payload">${esc(JSON.stringify(cleanPayload, null, 2))}</pre>
      <div class="detail-actions">
        <button class="btn-copy btn-copy-curl">Copy curl</button>
        <button class="btn-copy btn-copy-json">Copy JSON</button>
      </div>
    `;
  }

  function buildCurl(alert) {
    const payload = alert.raw_payload || alert;
    const clean = { ...payload };
    delete clean._isNew;
    return `curl -X POST ${BASE}/webhook/overwatch \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(clean, null, 2)}'`;
  }

  function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
    });
  }

  // ── Filters ──
  $$('.filter-btn:not(.severity-filter):not(.entity-filter)').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn:not(.severity-filter):not(.entity-filter)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      stateFilter = btn.dataset.filter;
      render();
    });
  });

  $$('.filter-btn.severity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn.severity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      severityFilter = btn.dataset.severity;
      render();
    });
  });

  $$('.filter-btn.entity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn.entity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      entityFilter = btn.dataset.entity;
      render();
    });
  });

  // ── Test Alert ──
  $('#btnTestAlert').addEventListener('click', async () => {
    const entities = [
      { name: 'flipkart', type: 'merchant' },
      { name: 'amazon', type: 'merchant' },
      { name: 'swiggy', type: 'merchant' },
      { name: 'hdfc_bank', type: 'acquirer' },
      { name: 'axis_bank', type: 'acquirer' },
      { name: 'icici_bank', type: 'issuer' },
      { name: 'sbi', type: 'issuer' },
      { name: 'visa', type: 'card_scheme' },
      { name: 'mastercard', type: 'card_scheme' },
      { name: 'rupay', type: 'card_scheme' },
    ];

    const entity = entities[Math.floor(Math.random() * entities.length)];
    const score = Math.floor(Math.random() * 100);
    const isZero = Math.random() < 0.1;
    const srt = isZero ? 0 : +(Math.random() * 80 + 10).toFixed(2);
    const refSrt = +(Math.random() * 30 + 50).toFixed(2);

    const payload = {
      alert_id: crypto.randomUUID(),
      alert_group_id: crypto.randomUUID(),
      notification_id: crypto.randomUUID(),
      notification_triggered_at: new Date().toISOString(),
      notification_type: 'detection',
      product: 'PayuBizTransactionEngine',
      metric: 'success_rate',
      entity_identifier: entity.name,
      entity_type: entity.type,
      entity_name: entity.name,
      started_at: new Date(Date.now() - Math.random() * 3600000).toISOString(),
      ended_at: Math.random() < 0.3 ? new Date().toISOString() : null,
      current_state: Math.random() < 0.3 ? 'resolved' : 'ongoing',
      criticality_score: score,
      stats: {
        failed_count: Math.floor(Math.random() * 10000),
        success_rate_during_downtime: srt,
        reference_srt: refSrt,
        srt_drop_abs: +(refSrt - srt).toFixed(2),
        srt_drop_rel: +((refSrt - srt) / refSrt * 100).toFixed(2),
        zero_srt: isZero,
        duration: Math.floor(Math.random() * 500)
      },
      schema_version: '1.0'
    };

    try {
      await fetch('/webhook/overwatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) { console.error('Test alert error:', err); }
  });

  // ── Helpers ──
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = String(str ?? '');
    return d.innerHTML;
  }

  function fmtNum(n) { return Number(n).toLocaleString(); }

  function fmtDur(min) {
    if (min < 60) return `${min}m`;
    return `${Math.floor(min / 60)}h ${min % 60}m`;
  }

  function fmtTime(iso) {
    if (!iso) return 'N/A';
    try {
      return new Date(iso).toLocaleString('en-US', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      });
    } catch { return iso; }
  }

  function fmtTimeBrief(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return ''; }
  }

  // ── Init ──
  connectSSE();
  fetchAlerts();
})();
