(function () {
  'use strict';

  const alertsData = [];
  let stateFilter = 'all';
  let severityFilter = 'all';
  let eventSource = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // DOM refs
  const alertsContainer = $('#alertsContainer');
  const emptyState = $('#emptyState');
  const alertCount = $('#alertCount');
  const connectionStatus = $('#connectionStatus');
  const modalOverlay = $('#modalOverlay');
  const modalBody = $('#modalBody');

  // Connect to SSE stream
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
        if (data.type === 'connected') {
          fetchAlerts();
          fetchWebhookLog();
          return;
        }
        if (data.type === 'cleared') {
          alertsData.length = 0;
          renderAlerts();
          updateStats();
          fetchWebhookLog();
          return;
        }
        addAlert(data, true);
        updateStats();
        fetchWebhookLog();
      } catch (err) {
        console.error('SSE parse error:', err);
      }
    };

    eventSource.onerror = () => {
      connectionStatus.className = 'connection-status error';
      connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
      setTimeout(connectSSE, 3000);
    };
  }

  // Fetch all existing alerts
  async function fetchAlerts() {
    try {
      const res = await fetch('/api/alerts?limit=200');
      const data = await res.json();
      alertsData.length = 0;
      data.alerts.forEach(a => alertsData.push(a));
      renderAlerts();
      updateStats();
    } catch (err) {
      console.error('Fetch alerts error:', err);
    }
  }

  function addAlert(alert, isNew) {
    alert._isNew = isNew;
    alertsData.unshift(alert);
    renderAlerts();
  }

  // Update stats display
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
    } catch (err) {
      // Fallback: compute from local data
      $('#statTotal').textContent = alertsData.length;
      $('#statOngoing').textContent = alertsData.filter(a => a.current_state === 'ongoing').length;
      $('#statResolved').textContent = alertsData.filter(a => a.current_state === 'resolved').length;
      $('#statHigh').textContent = alertsData.filter(a => a.severity === 'HIGH').length;
      $('#statMedium').textContent = alertsData.filter(a => a.severity === 'MEDIUM').length;
      $('#statLow').textContent = alertsData.filter(a => a.severity === 'LOW').length;
    }
  }

  // Render alerts list
  function renderAlerts() {
    let filtered = [...alertsData];

    if (stateFilter !== 'all') {
      filtered = filtered.filter(a => a.current_state === stateFilter);
    }
    if (severityFilter !== 'all') {
      filtered = filtered.filter(a => a.severity === severityFilter);
    }

    alertCount.textContent = `${filtered.length} alert${filtered.length !== 1 ? 's' : ''}`;

    if (filtered.length === 0) {
      alertsContainer.innerHTML = '';
      alertsContainer.appendChild(emptyState);
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    alertsContainer.innerHTML = '';

    filtered.forEach((alert, idx) => {
      alertsContainer.appendChild(createAlertCard(alert, idx === 0 && alert._isNew));
      alert._isNew = false;
    });
  }

  function createAlertCard(alert, isNew) {
    const card = document.createElement('div');
    card.className = `alert-card severity-${alert.severity}${isNew ? ' new-alert' : ''}`;
    card.onclick = () => showAlertDetail(alert);

    const stats = alert.stats || {};
    const isOngoing = alert.current_state === 'ongoing';
    const isZeroSrt = stats.zero_srt === true;

    card.innerHTML = `
      <div class="alert-top">
        <div class="alert-entity">
          <span class="entity-name">${escHtml(alert.entity_name)}</span>
          <span class="entity-type">${escHtml(alert.entity_type)}</span>
        </div>
        <div class="alert-badges">
          ${isOngoing ? '<span class="live-indicator">LIVE</span>' : ''}
          <span class="severity-badge ${alert.severity}">${alert.severity} &middot; ${alert.criticality_score}</span>
          <span class="state-badge ${alert.current_state}">${alert.current_state}</span>
          <span class="entity-type">${escHtml(alert.metric)}</span>
        </div>
      </div>
      <div class="alert-id">ID: ${escHtml(alert.alert_id)}</div>
      <div class="alert-stats">
        ${stats.failed_count != null ? `<div class="alert-stat"><span class="alert-stat-label">Failed Txns</span><span class="alert-stat-value">${formatNumber(stats.failed_count)}</span></div>` : ''}
        ${stats.success_rate_during_downtime != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT During Issue</span><span class="alert-stat-value${isZeroSrt ? ' zero-srt' : ''}">${stats.success_rate_during_downtime}%</span></div>` : ''}
        ${stats.srt_drop_abs != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT Drop (abs)</span><span class="alert-stat-value">${stats.srt_drop_abs}%</span></div>` : ''}
        ${stats.srt_drop_rel != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT Drop (rel)</span><span class="alert-stat-value">${stats.srt_drop_rel}%</span></div>` : ''}
        ${stats.duration != null ? `<div class="alert-stat"><span class="alert-stat-label">Duration</span><span class="alert-stat-value">${formatDuration(stats.duration)}</span></div>` : ''}
        ${stats.reference_srt != null ? `<div class="alert-stat"><span class="alert-stat-label">Reference SRT</span><span class="alert-stat-value">${stats.reference_srt}%</span></div>` : ''}
      </div>
      ${isZeroSrt ? '<div class="alert-warning">Zero Success Rate Detected — All transactions failing</div>' : ''}
      <div class="alert-time">
        <span>Started: ${formatTime(alert.started_at)}</span>
        ${alert.ended_at ? `<span>Resolved: ${formatTime(alert.ended_at)}</span>` : ''}
        <span>Received: ${formatTime(alert.received_at)}</span>
      </div>
    `;

    return card;
  }

  function showAlertDetail(alert) {
    modalBody.innerHTML = `<pre>${escHtml(JSON.stringify(alert.raw_payload || alert, null, 2))}</pre>`;
    modalOverlay.classList.add('visible');
  }

  // Filter handlers
  $$('.filter-btn:not(.severity-filter)').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn:not(.severity-filter)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      stateFilter = btn.dataset.filter;
      renderAlerts();
    });
  });

  $$('.filter-btn.severity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn.severity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      severityFilter = btn.dataset.severity;
      renderAlerts();
    });
  });

  $('#modalClose').addEventListener('click', () => modalOverlay.classList.remove('visible'));
  modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) modalOverlay.classList.remove('visible');
  });

  $('#btnClear').addEventListener('click', async () => {
    if (!confirm('Clear all alerts?')) return;
    try {
      await fetch('/api/alerts', { method: 'DELETE' });
      alertsData.length = 0;
      renderAlerts();
      updateStats();
      fetchWebhookLog();
    } catch (err) { console.error('Clear error:', err); }
  });

  $$('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = btn.dataset.endpoint;
      const base = window.location.origin;
      const url = `${base}/webhook/${ep}`;
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  $('#btnRefreshLog').addEventListener('click', fetchWebhookLog);

  async function fetchWebhookLog() {
    try {
      const res = await fetch('/api/webhook-log');
      const data = await res.json();
      const container = $('#webhookLogContainer');
      if (!data.log || data.log.length === 0) {
        container.innerHTML = '<div class="log-empty">No webhook activity yet. Send a test alert or trigger a real webhook.</div>';
        return;
      }
      container.innerHTML = data.log.slice().reverse().map(entry => `
        <div class="log-entry">
          <span class="log-time">${new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
          <span class="log-source">${escHtml(entry.source)}</span>
          <span class="log-entity">${escHtml(entry.entity)}</span>
          <span class="log-severity ${entry.severity}">${entry.severity}</span>
          <span class="log-id">${escHtml(entry.alert_id).slice(0, 12)}...</span>
        </div>
      `).join('');
    } catch (err) { console.error('Log fetch error:', err); }
  }

  // Test alert button
  $('#btnTestAlert').addEventListener('click', async () => {
    const entities = [
      { name: 'flipkart', type: 'merchant' },
      { name: 'amazon', type: 'merchant' },
      { name: 'swiggy', type: 'merchant' },
      { name: 'hdfc_bank', type: 'acquirer' },
      { name: 'visa', type: 'card_scheme' },
      { name: 'myntra', type: 'merchant' },
      { name: 'zomato', type: 'merchant' },
      { name: 'icici_bank', type: 'acquirer' },
    ];

    const entity = entities[Math.floor(Math.random() * entities.length)];
    const score = Math.floor(Math.random() * 100);
    const isZero = Math.random() < 0.15;
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
      const res = await fetch('/webhook/overwatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('Test alert error:', err);
    }
  });

  // Helpers
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }

  function formatNumber(n) {
    return Number(n).toLocaleString();
  }

  function formatDuration(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h}h ${m}m`;
  }

  function formatTime(isoStr) {
    if (!isoStr) return 'N/A';
    try {
      const d = new Date(isoStr);
      return d.toLocaleString('en-US', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      });
    } catch {
      return isoStr;
    }
  }

  connectSSE();
  fetchAlerts();
  fetchWebhookLog();
})();
