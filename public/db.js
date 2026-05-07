(function () {
  'use strict';

  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const state = {
    tables: [],
    table: 'alerts',
    schema: [],
    limit: 50,
    offset: 0,
    orderBy: 'received_at',
    dir: 'DESC',
    total: 0
  };

  function esc(v) {
    const d = document.createElement('div');
    d.textContent = String(v ?? '');
    return d.innerHTML;
  }

  const TZ = 'Asia/Kolkata';
  function fmtIst(v) {
    try {
      return new Date(v).toLocaleString('en-GB', {
        timeZone: TZ,
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }) + ' IST';
    } catch { return v; }
  }

  function formatCellValue(v, colName) {
    if (v === null || v === undefined) {
      return { html: 'NULL', cls: 'null-cell' };
    }
    // ISO timestamps in *_at columns -> render in IST
    if (typeof v === 'string' && /_at$/i.test(colName) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      return { html: esc(fmtIst(v)), cls: 'date-cell', raw: v };
    }
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && !/_at$|_id$|_at|date/i.test(colName))) {
      return { html: esc(v), cls: 'num-cell' };
    }
    if (typeof v === 'object') {
      return { html: '{...} ' + Object.keys(v).length + ' keys', cls: 'json-cell', raw: v };
    }
    if (typeof v === 'string' && (v.startsWith('{') || v.startsWith('['))) {
      try {
        const parsed = JSON.parse(v);
        return { html: '{...} ' + (Array.isArray(parsed) ? parsed.length + ' items' : Object.keys(parsed).length + ' keys'), cls: 'json-cell', raw: parsed };
      } catch (_) {}
    }
    if (typeof v === 'string' && v.length > 60) {
      return { html: esc(v.slice(0, 60)) + '…', cls: 'json-cell', raw: v };
    }
    return { html: esc(v), cls: '' };
  }

  function renderTable(container, columns, rows) {
    if (!rows.length) {
      container.innerHTML = '<div class="db-empty">No rows.</div>';
      return;
    }
    let html = '<table class="db-table"><thead><tr>';
    for (const c of columns) html += `<th>${esc(c)}</th>`;
    html += '</tr></thead><tbody>';
    for (const r of rows) {
      html += '<tr>';
      for (const c of columns) {
        const cell = formatCellValue(r[c], c);
        const dataAttr = cell.raw !== undefined
          ? ` data-raw='${esc(typeof cell.raw === 'string' ? cell.raw : JSON.stringify(cell.raw, null, 2))}' data-col='${esc(c)}'`
          : '';
        html += `<td class="${cell.cls}"${dataAttr} title="${esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}">${cell.html}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    container.querySelectorAll('td.json-cell').forEach(td => {
      td.addEventListener('click', () => openModal(td.dataset.col || 'value', td.dataset.raw || ''));
    });
  }

  function openModal(name, raw) {
    let modal = $('#dbModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'dbModal';
      modal.className = 'db-modal';
      modal.innerHTML = `
        <div class="db-modal-inner">
          <div class="db-modal-head">
            <span class="col-name" id="modalColName"></span>
            <button class="db-modal-close" id="modalClose">×</button>
          </div>
          <div class="db-modal-body"><pre id="modalContent"></pre></div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
      $('#modalClose').addEventListener('click', () => modal.classList.remove('open'));
    }
    $('#modalColName').textContent = name;
    let pretty = raw;
    try {
      pretty = JSON.stringify(JSON.parse(raw), null, 2);
    } catch (_) {}
    $('#modalContent').textContent = pretty;
    modal.classList.add('open');
  }

  async function loadInfo() {
    const r = await fetch('/api/db/info');
    const j = await r.json();
    state.tables = j.tables;
    $('#dbMeta').innerHTML = `
      <strong>${esc(j.engine.toUpperCase())}</strong>
      · ${esc(j.location || 'remote')}
      · ${j.total_alerts.toLocaleString()} rows
      · retention ${j.retention_days}d`;

    const tl = $('#tableList');
    tl.innerHTML = '';
    j.tables.forEach(t => {
      const b = document.createElement('button');
      b.textContent = t;
      if (t === state.table) b.classList.add('active');
      b.onclick = () => switchTable(t);
      tl.appendChild(b);
    });
  }

  async function loadSchema() {
    const r = await fetch(`/api/db/schema?table=${encodeURIComponent(state.table)}`);
    const j = await r.json();
    state.schema = j.columns;
    $('#schemaTable').textContent = state.table;

    const sl = $('#schemaList');
    sl.innerHTML = '';
    j.columns.forEach(c => {
      const row = document.createElement('div');
      row.className = 'db-schema-row';
      row.innerHTML = `
        <span class="col-name${c.primary_key ? ' pk' : ''}">${esc(c.name)}</span>
        <span class="col-type">${esc(c.type)}</span>`;
      sl.appendChild(row);
    });

    const ob = $('#orderBy');
    ob.innerHTML = '';
    j.columns.forEach(c => {
      const o = document.createElement('option');
      o.value = c.name; o.textContent = c.name;
      if (c.name === state.orderBy) o.selected = true;
      ob.appendChild(o);
    });
  }

  async function loadRows() {
    const params = new URLSearchParams({
      table: state.table,
      limit: state.limit,
      offset: state.offset,
      order_by: state.orderBy,
      dir: state.dir
    });
    const r = await fetch('/api/db/rows?' + params);
    const j = await r.json();
    if (j.error) {
      $('#rowsWrap').innerHTML = `<div class="db-empty">Error: ${esc(j.error)}</div>`;
      return;
    }
    state.total = j.total;
    renderTable($('#rowsWrap'), j.columns, j.rows);
    const start = j.total === 0 ? 0 : j.offset + 1;
    const end = Math.min(j.offset + j.limit, j.total);
    $('#pageInfo').textContent = `${start}–${end} of ${j.total.toLocaleString()}`;
    $('#prevBtn').disabled = j.offset === 0;
    $('#nextBtn').disabled = end >= j.total;
  }

  function switchTable(t) {
    state.table = t;
    state.offset = 0;
    state.orderBy = 'received_at';
    $$('#tableList button').forEach(b => b.classList.toggle('active', b.textContent === t));
    loadSchema().then(() => {
      // pick a sensible default order column if 'received_at' not present
      if (!state.schema.find(c => c.name === state.orderBy)) {
        state.orderBy = state.schema[0]?.name || 'id';
      }
      loadRows();
    });
  }

  function bindRowsControls() {
    $('#orderBy').addEventListener('change', e => { state.orderBy = e.target.value; state.offset = 0; loadRows(); });
    $('#dir').addEventListener('change', e => { state.dir = e.target.value; state.offset = 0; loadRows(); });
    $('#limit').addEventListener('change', e => { state.limit = parseInt(e.target.value, 10); state.offset = 0; loadRows(); });
    $('#prevBtn').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); loadRows(); });
    $('#nextBtn').addEventListener('click', () => { state.offset += state.limit; loadRows(); });
  }

  function bindTabs() {
    $$('.db-tab').forEach(t => t.addEventListener('click', () => {
      $$('.db-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const which = t.dataset.tab;
      $('#paneRows').classList.toggle('hidden', which !== 'rows');
      $('#paneQuery').classList.toggle('hidden', which !== 'query');
    }));
  }

  function bindQuery() {
    $('#runBtn').addEventListener('click', async () => {
      const sql = $('#sqlBox').value.trim();
      const status = $('#queryStatus');
      status.className = 'db-query-status';
      if (/^\s*delete\b/i.test(sql)) {
        if (!confirm('You are about to run a DELETE statement.\n\nThis will permanently remove rows. Continue?')) {
          status.textContent = 'Cancelled.';
          return;
        }
      }
      status.textContent = 'Running…';
      try {
        const r = await fetch('/api/db/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql })
        });
        const j = await r.json();
        if (!r.ok) {
          status.className = 'db-query-status error';
          status.textContent = j.error || 'Query failed';
          $('#queryWrap').innerHTML = '';
          return;
        }
        status.className = 'db-query-status ok';
        if (j.deleted) {
          status.textContent = `Deleted ${j.rowCount} row${j.rowCount === 1 ? '' : 's'} from ${j.table} · ${j.executionMs}ms`;
          await loadRows();
          await loadInfo();
        } else {
          status.textContent = `${j.rowCount} row${j.rowCount === 1 ? '' : 's'} · ${j.executionMs}ms`;
        }
        renderTable($('#queryWrap'), j.columns, j.rows);
      } catch (e) {
        status.className = 'db-query-status error';
        status.textContent = e.message;
      }
    });
    $('#sqlBox').addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        $('#runBtn').click();
      }
    });
  }

  (async function init() {
    bindTabs();
    bindRowsControls();
    bindQuery();
    await loadInfo();
    await loadSchema();
    await loadRows();
  })();
})();
