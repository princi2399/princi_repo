(function () {
  'use strict';

  const alertsData = [];
  let stateFilter = 'all';
  let severityFilter = 'all';
  let entityFilter = 'all';
  let tlFilter = 'all';
  let eventSource = null;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const alertsContainer = $('#alertsContainer');
  const emptyState = $('#emptyState');
  const alertCount = $('#alertCount');
  const connectionStatus = $('#connectionStatus');
  const modalOverlay = $('#modalOverlay');
  const modalBody = $('#modalBody');
  const timelineContainer = $('#timelineContainer');

  const BASE = window.location.origin;

  // ── Curl Payloads ──
  const curlPayloads = {
    merchant: {
      entity_name: 'flipkart', entity_identifier: 'flipkart', entity_type: 'merchant',
      criticality_score: 72, current_state: 'ongoing',
      stats: { failed_count: 3500, success_rate_during_downtime: 12.5, reference_srt: 68.2, srt_drop_abs: 55.7, srt_drop_rel: 81.67, zero_srt: false, duration: 45 }
    },
    acquirer: {
      entity_name: 'hdfc_bank', entity_identifier: 'hdfc_bank', entity_type: 'acquirer',
      criticality_score: 55, current_state: 'ongoing',
      stats: { failed_count: 8200, success_rate_during_downtime: 42.3, reference_srt: 75.1, srt_drop_abs: 32.8, srt_drop_rel: 43.67, zero_srt: false, duration: 120 }
    },
    issuer: {
      entity_name: 'icici_bank', entity_identifier: 'icici_bank', entity_type: 'issuer',
      criticality_score: 88, current_state: 'ongoing',
      stats: { failed_count: 12400, success_rate_during_downtime: 0, reference_srt: 82.5, srt_drop_abs: 82.5, srt_drop_rel: 100, zero_srt: true, duration: 18 }
    },
    card_scheme: {
      entity_name: 'visa', entity_identifier: 'visa', entity_type: 'card_scheme',
      criticality_score: 35, current_state: 'resolved',
      stats: { failed_count: 1500, success_rate_during_downtime: 61.2, reference_srt: 78.9, srt_drop_abs: 17.7, srt_drop_rel: 22.43, zero_srt: false, duration: 90 }
    }
  };

  function buildFullPayload(base) {
    return {
      alert_id: crypto.randomUUID(),
      alert_group_id: crypto.randomUUID(),
      notification_id: crypto.randomUUID(),
      notification_triggered_at: new Date().toISOString(),
      notification_type: 'detection',
      product: 'PayuBizTransactionEngine',
      metric: 'success_rate',
      ...base,
      started_at: new Date(Date.now() - (base.stats.duration || 30) * 60000).toISOString(),
      ended_at: base.current_state === 'resolved' ? new Date().toISOString() : null,
      schema_version: '1.0'
    };
  }

  function buildCurl(type) {
    const p = buildFullPayload(curlPayloads[type]);
    return `curl -X POST ${BASE}/webhook/overwatch \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(p, null, 2)}'`;
  }

  function initCurls() {
    ['merchant', 'acquirer', 'issuer', 'card_scheme'].forEach(type => {
      const elId = type === 'card_scheme' ? 'curlScheme' :
                   type === 'merchant' ? 'curlMerchant' :
                   type === 'acquirer' ? 'curlAcquirer' : 'curlIssuer';
      const el = $(`#${elId}`);
      if (el) el.textContent = buildCurl(type);
    });
  }

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
          renderAlerts(); updateStats(); renderTimeline();
          return;
        }
        addAlert(data, true);
        updateStats(); renderTimeline();
      } catch (err) { console.error('SSE error:', err); }
    };

    eventSource.onerror = () => {
      connectionStatus.className = 'connection-status error';
      connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
      setTimeout(connectSSE, 3000);
    };
  }

  async function fetchAlerts() {
    try {
      const res = await fetch('/api/alerts?limit=200');
      const data = await res.json();
      alertsData.length = 0;
      data.alerts.forEach(a => alertsData.push(a));
      renderAlerts(); updateStats(); renderTimeline();
    } catch (err) { console.error('Fetch error:', err); }
  }

  function addAlert(alert, isNew) {
    alert._isNew = isNew;
    alertsData.unshift(alert);
    renderAlerts();
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

    const merchant = alertsData.filter(a => a.entity_type === 'merchant').length;
    const acquirer = alertsData.filter(a => a.entity_type === 'acquirer').length;
    const issuer = alertsData.filter(a => a.entity_type === 'issuer').length;
    const scheme = alertsData.filter(a => a.entity_type === 'card_scheme').length;
    $('#statMerchant').textContent = merchant;
    $('#statAcquirer').textContent = acquirer;
    $('#statIssuer').textContent = issuer;
    $('#statScheme').textContent = scheme;
  }

  // ── Render Alert Feed ──
  function renderAlerts() {
    let filtered = [...alertsData];
    if (stateFilter !== 'all') filtered = filtered.filter(a => a.current_state === stateFilter);
    if (severityFilter !== 'all') filtered = filtered.filter(a => a.severity === severityFilter);
    if (entityFilter !== 'all') filtered = filtered.filter(a => a.entity_type === entityFilter);

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

    const stats = alert.stats || {};
    const isOngoing = alert.current_state === 'ongoing';
    const isZeroSrt = stats.zero_srt === true;
    const ntype = alert.notification_type || 'detection';
    const metric = alert.metric || 'success_rate';

    card.innerHTML = `
      <div class="alert-top">
        <div class="alert-entity">
          <span class="entity-name">${esc(alert.entity_name)}</span>
          <span class="entity-type-badge">${esc(alert.entity_type).toUpperCase()}</span>
        </div>
        <div class="alert-badges">
          ${isOngoing ? '<span class="live-indicator"><span class="live-dot"></span> LIVE</span>' : ''}
          <span class="severity-badge ${alert.severity}">${alert.severity} &middot; ${alert.criticality_score}</span>
          <span class="state-badge ${alert.current_state}">${alert.current_state}</span>
          <span class="metric-badge">${esc(metric)} &middot; ${esc(ntype)}</span>
        </div>
      </div>
      <div class="alert-id">ID: ${esc(alert.alert_id)}</div>
      <div class="alert-stats">
        ${stats.failed_count != null ? `<div class="alert-stat"><span class="alert-stat-label">FAILED TXNS</span><span class="alert-stat-value">${fmtNum(stats.failed_count)}</span></div>` : ''}
        ${stats.success_rate_during_downtime != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT DURING ISSUE</span><span class="alert-stat-value${isZeroSrt ? ' zero-srt' : ''}">${stats.success_rate_during_downtime}%</span></div>` : ''}
        ${stats.srt_drop_abs != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT DROP (ABS)</span><span class="alert-stat-value">${stats.srt_drop_abs}%</span></div>` : ''}
        ${stats.srt_drop_rel != null ? `<div class="alert-stat"><span class="alert-stat-label">SRT DROP (REL)</span><span class="alert-stat-value">${stats.srt_drop_rel}%</span></div>` : ''}
        ${stats.duration != null ? `<div class="alert-stat"><span class="alert-stat-label">DURATION</span><span class="alert-stat-value">${fmtDur(stats.duration)}</span></div>` : ''}
        ${stats.reference_srt != null ? `<div class="alert-stat"><span class="alert-stat-label">REFERENCE SRT</span><span class="alert-stat-value">${stats.reference_srt}%</span></div>` : ''}
      </div>
      ${isZeroSrt ? '<div class="alert-warning">Zero Success Rate Detected — All transactions failing</div>' : ''}
      <div class="alert-bottom">
        <div class="alert-time">
          <span>Started: ${fmtTime(alert.started_at)}</span>
          ${alert.ended_at ? `<span>Resolved: ${fmtTime(alert.ended_at)}</span>` : ''}
          <span>Received: ${fmtTime(alert.received_at)}</span>
        </div>
        <button class="btn-view-payload" data-alert-id="${esc(alert.alert_id)}">View Webhook Payload</button>
      </div>
    `;

    card.querySelector('.btn-view-payload').addEventListener('click', (e) => {
      e.stopPropagation();
      showAlertDetail(alert);
    });

    card.onclick = () => showAlertDetail(alert);
    return card;
  }

  // ── Timeline ──
  function renderTimeline() {
    let items = [...alertsData];
    if (tlFilter !== 'all') items = items.filter(a => a.current_state === tlFilter);

    if (items.length === 0) {
      timelineContainer.innerHTML = '<div class="timeline-empty">No timeline data yet.</div>';
      return;
    }

    timelineContainer.innerHTML = items.slice(0, 20).map(a => {
      const isOngoing = a.current_state === 'ongoing';
      const dur = a.stats?.duration;
      const durStr = dur != null ? ` · ${fmtDur(dur)}` : '';
      return `
        <div class="tl-item" data-id="${esc(a.alert_id)}">
          <span class="tl-entity">${esc(a.entity_name)}</span>
          <span class="tl-type">${esc(a.entity_type)}</span>
          ${isOngoing ? '<span class="tl-live">LIVE</span>' : ''}
          <span class="tl-meta">${fmtTime(a.started_at)}${durStr}</span>
          <span class="tl-severity ${a.severity}">${a.severity} &middot; ${a.criticality_score}</span>
        </div>`;
    }).join('');

    timelineContainer.querySelectorAll('.tl-item').forEach(item => {
      item.addEventListener('click', () => {
        const alert = alertsData.find(a => a.alert_id === item.dataset.id);
        if (alert) showAlertDetail(alert);
      });
    });
  }

  // ── Field Explorer ──
  function initExplorer() {
    const fields = [
      { name: 'alert_id', type: 'string (UUID)', desc: 'Unique identifier for the alert instance.', example: '"e58a1a37-..."' },
      { name: 'alert_group_id', type: 'string (UUID)', desc: 'Groups related alerts under a parent ID.', example: '"7595875a-..."' },
      { name: 'notification_id', type: 'string (UUID)', desc: 'Unique ID for this notification delivery.', example: '"8cf84511-..."' },
      { name: 'notification_triggered_at', type: 'string (ISO 8601)', desc: 'Timestamp when alert was triggered.', example: '"2025-05-03T10:14:23+05:30"' },
      { name: 'notification_type', type: 'string', desc: "Type of notification: 'detection'.", example: '"detection"' },
      { name: 'product', type: 'string', desc: 'PayU product that generated the alert.', example: '"PayuBizTransactionEngine"' },
      { name: 'metric', type: 'string', desc: 'Monitored metric that triggered the alert.', example: '"success_rate"' },
      { name: 'entity_identifier', type: 'string', desc: 'Identifier of impacted entity.', example: '"flipkart"' },
      { name: 'entity_type', type: 'string', desc: 'Category: merchant | acquirer | issuer | card_scheme', example: '"merchant"' },
      { name: 'entity_name', type: 'string', desc: 'Human-readable entity name.', example: '"flipkart"' },
      { name: 'started_at', type: 'string (ISO 8601)', desc: 'When anomaly was first detected.', example: '"2025-05-03T05:17:00+05:30"' },
      { name: 'ended_at', type: 'string | null', desc: 'When resolved. Null if ongoing.', example: 'null' },
      { name: 'current_state', type: 'string', desc: "'ongoing' or 'resolved'.", example: '"ongoing"' },
      { name: 'criticality_score', type: 'number (0–100)', desc: '0–30: Low, 31–60: Medium, 61–100: High.', example: '45' },
      { name: 'stats', type: 'object', desc: 'Detailed anomaly metrics.', example: '{...}' },
      { name: 'schema_version', type: 'string', desc: 'Alert payload schema version.', example: '"1.0"' },
    ];

    const list = $('#explorerList');
    list.innerHTML = fields.map(f => `
      <div class="explorer-item">
        <div class="explorer-head">
          <span class="explorer-name">${f.name}</span>
          <span class="explorer-type">${f.type}</span>
          <span class="explorer-toggle">&#9660;</span>
        </div>
        <div class="explorer-body">
          <div>${f.desc}</div>
          <div class="explorer-example">Example: <code>${f.example}</code></div>
        </div>
      </div>
    `).join('');

    list.querySelectorAll('.explorer-head').forEach(head => {
      head.addEventListener('click', () => head.parentElement.classList.toggle('open'));
    });
  }

  // ── Modal ──
  function showAlertDetail(alert) {
    const payload = alert.raw_payload || alert;
    const clean = { ...payload };
    delete clean._isNew;
    delete clean.raw_payload;
    modalBody.innerHTML = `<pre>${esc(JSON.stringify(clean, null, 2))}</pre>`;
    modalOverlay.classList.add('visible');
  }

  // ── Webhook Details ──
  async function loadWebhookDetails() {
    try {
      const [logRes, healthRes] = await Promise.all([
        fetch('/api/webhook-log'),
        fetch('/api/health')
      ]);
      const logData = await logRes.json();
      const health = await healthRes.json();

      const logEl = $('#webhookLog');
      if (!logData.log || logData.log.length === 0) {
        logEl.innerHTML = '<div class="timeline-empty">No webhook activity yet.</div>';
      } else {
        logEl.innerHTML = logData.log.slice().reverse().map(e => `
          <div class="wh-log-entry">
            <span class="wh-log-time">${new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
            <span class="wh-log-source">${esc(e.source)}</span>
            <span class="wh-log-entity">${esc(e.entity)}</span>
            <span class="wh-log-sev ${e.severity}">${e.severity}</span>
            <span class="wh-log-id">${esc(e.alert_id).slice(0, 12)}...</span>
          </div>
        `).join('');
      }

      const upSec = Math.floor(health.uptime);
      const upMin = Math.floor(upSec / 60);
      const upH = Math.floor(upMin / 60);
      const memMB = (health.memory.heapUsed / 1048576).toFixed(1);

      $('#webhookHealth').innerHTML = `
        <div class="wh-health-row"><span class="wh-health-label">Status</span><span class="wh-health-val" style="color:var(--low)">${health.status}</span></div>
        <div class="wh-health-row"><span class="wh-health-label">Uptime</span><span class="wh-health-val">${upH}h ${upMin % 60}m ${upSec % 60}s</span></div>
        <div class="wh-health-row"><span class="wh-health-label">Alerts Stored</span><span class="wh-health-val">${health.alerts_count}</span></div>
        <div class="wh-health-row"><span class="wh-health-label">Connected Clients</span><span class="wh-health-val">${health.connected_clients}</span></div>
        <div class="wh-health-row"><span class="wh-health-label">Memory (Heap)</span><span class="wh-health-val">${memMB} MB</span></div>
      `;
    } catch (err) {
      console.error('Webhook details error:', err);
    }
  }

  // ── Event Listeners ──

  // State filters
  $$('.filter-btn:not(.severity-filter):not(.entity-filter)').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn:not(.severity-filter):not(.entity-filter)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      stateFilter = btn.dataset.filter;
      renderAlerts();
    });
  });

  // Severity filters
  $$('.filter-btn.severity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn.severity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      severityFilter = btn.dataset.severity;
      renderAlerts();
    });
  });

  // Entity type filters
  $$('.filter-btn.entity-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn.entity-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      entityFilter = btn.dataset.entity;
      renderAlerts();
    });
  });

  // Entity stat cards also act as filters
  $$('.entity-stat-card').forEach(card => {
    card.addEventListener('click', () => {
      const etype = card.dataset.etype;
      const isActive = card.classList.contains('active');
      $$('.entity-stat-card').forEach(c => c.classList.remove('active'));

      if (isActive) {
        entityFilter = 'all';
        $$('.filter-btn.entity-filter').forEach(b => b.classList.remove('active'));
        $$('.filter-btn.entity-filter[data-entity="all"]').forEach(b => b.classList.add('active'));
      } else {
        card.classList.add('active');
        const mapped = etype === 'card_scheme' ? 'card_scheme' : etype;
        entityFilter = mapped;
        $$('.filter-btn.entity-filter').forEach(b => b.classList.remove('active'));
        $$(`.filter-btn.entity-filter[data-entity="${mapped}"]`).forEach(b => b.classList.add('active'));
      }
      renderAlerts();
    });
  });

  // Timeline filters
  $$('.tl-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tl-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      tlFilter = btn.dataset.tl;
      renderTimeline();
    });
  });

  // Modals
  $('#modalClose').addEventListener('click', () => modalOverlay.classList.remove('visible'));
  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.classList.remove('visible'); });

  const webhookModal = $('#webhookModal');
  $('#btnWebhookDetails').addEventListener('click', () => {
    webhookModal.classList.add('visible');
    loadWebhookDetails();
  });
  $('#webhookModalClose').addEventListener('click', () => webhookModal.classList.remove('visible'));
  webhookModal.addEventListener('click', (e) => { if (e.target === webhookModal) webhookModal.classList.remove('visible'); });
  $('#btnRefreshLog').addEventListener('click', loadWebhookDetails);

  // Clear
  $('#btnClear').addEventListener('click', async () => {
    if (!confirm('Clear all alerts?')) return;
    try {
      await fetch('/api/alerts', { method: 'DELETE' });
      alertsData.length = 0;
      renderAlerts(); updateStats(); renderTimeline();
    } catch (err) { console.error('Clear error:', err); }
  });

  // Copy endpoint URLs
  $$('.copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ep = btn.dataset.ep;
      const url = `${BASE}/webhook/${ep}`;
      navigator.clipboard.writeText(url).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy URL'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  // Copy curl commands
  $$('.curl-copy').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.curl;
      const curl = buildCurl(type);
      navigator.clipboard.writeText(curl).then(() => {
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = 'Copy curl'; btn.classList.remove('copied'); }, 2000);
      });
    });
  });

  // Fire buttons - directly send alert
  $$('.btn-fire').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.type;
      const payload = buildFullPayload(curlPayloads[type]);
      btn.textContent = 'Sent!';
      btn.classList.add('fired');
      try {
        await fetch('/webhook/overwatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (err) { console.error('Fire error:', err); }
      setTimeout(() => { btn.innerHTML = '&#9889; Fire'; btn.classList.remove('fired'); }, 1500);
    });
  });

  // Test alert (random)
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
      { name: 'myntra', type: 'merchant' },
      { name: 'zomato', type: 'merchant' },
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
    if (min < 60) return `${min} min`;
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

  // ── Init ──
  initExplorer();
  initCurls();
  connectSSE();
  fetchAlerts();
})();
