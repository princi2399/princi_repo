const TZ = 'Asia/Kolkata';
let currentOffset = 0;
let currentTotal = 0;
let expandedRows = new Set();

function fmtIst(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString('en-IN', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  } catch { return ts; }
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function prettyJson(obj) {
  if (obj == null) return '(none)';
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); } catch { return esc(obj); }
  }
  return esc(JSON.stringify(obj, null, 2));
}

function sourceClass(s) {
  const v = (s || '').toLowerCase();
  if (v === 'overwatch') return 'log-source-overwatch';
  if (v === 'pipedream') return 'log-source-pipedream';
  if (v === 'put') return 'log-source-put';
  if (v === 'patch') return 'log-source-patch';
  return 'log-source-dynamic';
}

function statusClass(s) {
  const v = (s || '').toLowerCase();
  if (v === 'success') return 'log-status-success';
  if (v === 'rejected') return 'log-status-rejected';
  if (v === 'error') return 'log-status-error';
  return 'log-status-pending';
}

function getLimit() {
  return parseInt(document.getElementById('logLimit').value, 10) || 50;
}

function getStatusFilter() {
  return document.getElementById('logStatusFilter').value;
}

async function fetchLogs() {
  const limit = getLimit();
  const wrap = document.getElementById('logsWrap');
  wrap.innerHTML = '<div class="logs-loading">Loading webhook logs…</div>';

  try {
    const url = `/api/webhook-logs?limit=${limit}&offset=${currentOffset}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    currentTotal = data.total || 0;
    document.getElementById('logsMeta').textContent = `${currentTotal} total webhook requests logged`;
    renderLogs(data.rows || []);
    updatePager();
  } catch (err) {
    wrap.innerHTML = `<div class="logs-loading" style="color:#f87171">Error: ${esc(err.message)}</div>`;
  }
}

function renderLogs(rows) {
  const wrap = document.getElementById('logsWrap');
  const statusFilter = getStatusFilter();

  const filtered = statusFilter === 'all'
    ? rows
    : rows.filter(r => (r.processing_status || '').toLowerCase() === statusFilter);

  if (filtered.length === 0) {
    wrap.innerHTML = '<div class="logs-loading">No webhook logs found</div>';
    return;
  }

  const colCount = 9;
  let html = `<table class="logs-table"><thead><tr>
    <th></th>
    <th>Timestamp (IST)</th>
    <th>Method</th>
    <th>Path</th>
    <th>Source</th>
    <th>Status</th>
    <th>Alert ID</th>
    <th>Code</th>
    <th>IP</th>
  </tr></thead><tbody>`;

  filtered.forEach((row, idx) => {
    const id = row.id || idx;
    const isExpanded = expandedRows.has(id);
    html += `<tr>
      <td><button class="log-expand-btn" data-id="${id}">${isExpanded ? '▾' : '▸'}</button></td>
      <td class="log-ts">${fmtIst(row.timestamp)}</td>
      <td><span class="log-method">${esc(row.method)}</span></td>
      <td class="log-path">${esc(row.path)}</td>
      <td><span class="log-source ${sourceClass(row.source)}">${esc(row.source)}</span></td>
      <td><span class="log-status ${statusClass(row.processing_status)}">${esc(row.processing_status)}</span></td>
      <td class="log-alert-id" title="${esc(row.extracted_alert_id)}">${esc(row.extracted_alert_id || '—')}</td>
      <td><span class="log-code log-code-${row.response_code}">${row.response_code}</span></td>
      <td class="log-ip">${esc(row.ip)}</td>
    </tr>`;

    if (isExpanded) {
      html += `<tr class="log-detail-row"><td colspan="${colCount}">
        <div class="log-detail-content">
          <div class="log-detail-section">
            <h4>Request Headers</h4>
            <pre>${prettyJson(row.headers_json)}</pre>
          </div>
          <div class="log-detail-section">
            <h4>Request Body (Raw Payload)</h4>
            <pre>${prettyJson(row.body_json)}</pre>
          </div>
          <div class="log-detail-section">
            <h4>Processing Details</h4>
            <pre>${prettyJson({
              status: row.processing_status,
              message: row.processing_message,
              response_code: row.response_code,
              extracted_alert_id: row.extracted_alert_id,
              content_type: row.content_type
            })}</pre>
          </div>
        </div>
      </td></tr>`;
    }
  });

  html += '</tbody></table>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.log-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rowId = parseInt(btn.dataset.id, 10) || btn.dataset.id;
      if (expandedRows.has(rowId)) expandedRows.delete(rowId);
      else expandedRows.add(rowId);
      renderLogs(rows);
    });
  });
}

function updatePager() {
  const limit = getLimit();
  const start = currentOffset + 1;
  const end = Math.min(currentOffset + limit, currentTotal);
  document.getElementById('pageInfo').textContent = currentTotal
    ? `${start}–${end} of ${currentTotal}`
    : 'No logs';
  document.getElementById('prevBtn').disabled = currentOffset === 0;
  document.getElementById('nextBtn').disabled = currentOffset + limit >= currentTotal;
}

document.getElementById('prevBtn').addEventListener('click', () => {
  currentOffset = Math.max(0, currentOffset - getLimit());
  fetchLogs();
});

document.getElementById('nextBtn').addEventListener('click', () => {
  currentOffset += getLimit();
  fetchLogs();
});

document.getElementById('logLimit').addEventListener('change', () => {
  currentOffset = 0;
  fetchLogs();
});

document.getElementById('logStatusFilter').addEventListener('change', () => {
  fetchLogs();
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  fetchLogs();
});

fetchLogs();

setInterval(fetchLogs, 30000);
