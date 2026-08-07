/* ============================================================
   inventory.js — Box Lookup page + Inventory List page
   ============================================================ */

const BoxLookup = (() => {
  let _lastData  = null;
  let _activeTab = 'instock';

  /* ── Status pill ─────────────────────────────────────────── */
  function _statusPill(rem, phantom = 0, large = false) {
    const pad = large ? '4px 14px' : '2px 9px';
    const fs  = large ? '12.5px'   : '11.5px';
    if (phantom > 0)
      return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(220,38,38,.1);color:#dc2626;white-space:nowrap">Phantom</span>`;
    if (rem > 0)
      return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(22,163,74,.12);color:#15803d;white-space:nowrap">In Stock</span>`;
    return `<span style="display:inline-flex;align-items:center;padding:${pad};border-radius:9999px;font-size:${fs};font-weight:600;background:rgba(234,88,12,.1);color:#c2410c;white-space:nowrap">OOS</span>`;
  }

  /* ── Remaining colour ────────────────────────────────────── */
  function _remColor(rem) {
    return rem > 0 ? '#15803d' : 'var(--txt-4)';
  }

  /* ── UPC totals card ─────────────────────────────────────── */
  function _upcSummaryCard(upc, totalInitial, totalFulfilled, totalPhantom, totalRemaining) {
    const rem     = Number(totalRemaining);
    const phantom = Number(totalPhantom);
    return `
      <div style="margin-bottom:14px">
        <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:10px">
          <span style="font-size:10.5px;font-weight:700;color:var(--txt-4);letter-spacing:.08em;text-transform:uppercase">UPC</span>
          <span style="font-size:14px;font-weight:700;color:var(--txt-1);font-family:var(--font-number);font-variant-numeric:tabular-nums;letter-spacing:.04em">${Utils.escapeHtml(upc || '—')}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Initial</div>
            <div style="font-size:22px;font-weight:700;color:var(--txt-2);line-height:1">${Utils.formatNumber(totalInitial)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Fulfilled</div>
            <div style="font-size:22px;font-weight:700;color:var(--txt-2);line-height:1">${Utils.formatNumber(totalFulfilled)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Phantom</div>
            <div style="font-size:22px;font-weight:700;color:${phantom > 0 ? '#dc2626' : 'var(--txt-4)'};line-height:1">${Utils.formatNumber(phantom)}</div>
          </div>
          <div style="padding:12px 16px;border-right:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:600;color:var(--txt-4);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Remaining</div>
            <div style="font-size:22px;font-weight:700;color:${_remColor(rem)};line-height:1">${Utils.formatNumber(rem)}</div>
          </div>
          <div style="padding:12px 16px;display:flex;align-items:center;justify-content:center;min-width:90px">
            ${_statusPill(rem, phantom, true)}
          </div>
        </div>
      </div>`;
  }

  /* ── Box-level table row ─────────────────────────────────── */
  function _boxRow(box) {
    const rem     = Number(box.remaining_stock ?? 0);
    const phantom = Number(box.phantom_units   ?? 0);
    const rowClass = phantom > 0 ? ' class="row-phantom"' : '';
    const rowStyle = rem === 0 && phantom === 0 ? ' style="background:rgba(0,0,0,.02)"' : '';
    return `
      <tr${rowClass}${rowStyle}>
        <td style="font-weight:600;color:var(--txt-1)">${Utils.escapeHtml(box.box_number || '—')}</td>
        <td class="num">${Utils.formatNumber(box.initial_stock)}</td>
        <td class="num">${Utils.formatNumber(box.fulfilled_units)}</td>
        <td class="num" style="font-weight:600;color:${phantom > 0 ? '#dc2626' : 'var(--txt-4)'}">${Utils.formatNumber(phantom)}</td>
        <td class="num" style="font-weight:600;color:${_remColor(rem)}">${Utils.formatNumber(rem)}</td>
        <td>${_statusPill(rem, phantom)}</td>
      </tr>`;
  }

  /* ── Merge boxes with same (box_number, part_number, upc) ── */
  // All fields come from the backend canonical calculation engine.
  // remaining_stock is always GREATEST(initial - fulfilled, 0) — never negative.
  function _mergeByBox(boxes) {
    const map = new Map();
    for (const b of (boxes || [])) {
      const key       = `${b.box_number}|${b.part_number}|${b.upc}`;
      const initial   = Number(b.initial_stock   ?? 0);
      const fulfilled = Number(b.fulfilled_units  ?? 0);
      const phantom   = Number(b.phantom_units    ?? 0);
      const remaining = Number(b.remaining_stock  ?? Math.max(initial - fulfilled, 0));

      if (map.has(key)) {
        const m = map.get(key);
        m.initial_stock   += initial;
        m.fulfilled_units += fulfilled;
        m.phantom_units   += phantom;
        m.remaining_stock  = Math.max(m.initial_stock - m.fulfilled_units, 0);
      } else {
        map.set(key, { ...b, initial_stock: initial, fulfilled_units: fulfilled, phantom_units: phantom, remaining_stock: remaining });
      }
    }
    return Array.from(map.values());
  }

  /* ── Render one UPC block (summary card + box table) ─────── */
  function _renderUpcBlock(upcLabel, totalInitial, totalFulfilled, totalPhantom, totalRemaining, visibleBoxes) {
    return `
      <div>
        ${_upcSummaryCard(upcLabel, totalInitial, totalFulfilled, totalPhantom, totalRemaining)}
        <div class="table-wrap" style="border:none;margin:0">
          <table class="data-table">
            <thead>
              <tr>
                <th>Box #</th>
                <th class="num">Initial</th>
                <th class="num">Fulfilled</th>
                <th class="num">Phantom</th>
                <th class="num">Remaining</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${visibleBoxes.map(b => _boxRow(b)).join('')}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ── Build section HTML for one part-number or UPC group ─── */
  function _renderGroup(group, tab) {
    const isInstockTab = tab === 'instock';
    const sectionHtml  = [];

    for (const section of group) {
      const subSections = section.upcs || section.part_numbers || [];

      const headerLabel = section.part_number != null
        ? section.part_number
        : section.upc != null ? section.upc : '—';
      const headerType = section.part_number != null ? 'Part Number' : 'UPC';

      const upcBlocks = [];

      for (const sub of subSections) {
        const allBoxes        = _mergeByBox(sub.boxes);
        const totalInitial    = allBoxes.reduce((s, b) => s + Number(b.initial_stock   ?? 0), 0);
        const totalFulfilled  = allBoxes.reduce((s, b) => s + Number(b.fulfilled_units  ?? 0), 0);
        const totalPhantom    = allBoxes.reduce((s, b) => s + Number(b.phantom_units    ?? 0), 0);
        const totalRemaining  = allBoxes.reduce((s, b) => s + Math.max(Number(b.remaining_stock ?? 0), 0), 0);

        // In Stock tab: show UPC if ANY individual box has remaining > 0
        const hasAnyInStock = allBoxes.some(b => Number(b.remaining_stock ?? 0) > 0);
        if (isInstockTab && !hasAnyInStock) continue;

        const visibleBoxes = isInstockTab
          ? allBoxes.filter(b => Number(b.remaining_stock ?? 0) > 0)
          : allBoxes;

        if (!visibleBoxes.length) continue;

        const upcLabel = sub.upc ?? sub.part_number ?? '—';
        upcBlocks.push(_renderUpcBlock(upcLabel, totalInitial, totalFulfilled, totalPhantom, totalRemaining, visibleBoxes));
      }

      if (!upcBlocks.length) continue;

      // Separate multiple UPC blocks with a subtle divider
      const blocksHtml = upcBlocks.join(`
        <div style="border-top:1px solid var(--border);margin:20px 0"></div>`);

      sectionHtml.push(`
        <div class="card" style="margin-bottom:16px;padding:0;overflow:hidden">
          <div style="background:var(--surface-2);padding:10px 20px;border-bottom:1px solid var(--border)">
            <div style="font-size:10.5px;font-weight:700;color:var(--txt-4);letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px">${headerType}</div>
            <div style="font-size:17px;font-weight:700;color:var(--txt-1);letter-spacing:.01em">${Utils.escapeHtml(headerLabel)}</div>
          </div>
          <div style="padding:18px 20px 20px">
            ${blocksHtml}
          </div>
        </div>`);
    }

    return sectionHtml.join('');
  }

  /* ── Render results into a tab panel ─────────────────────── */
  function _renderResults(data, tab) {
    const group = data.byPartNumber?.length ? data.byPartNumber : data.byUpc || [];
    const html  = _renderGroup(group, tab);
    const el    = tab === 'instock'
      ? document.getElementById('lookup-instock')
      : document.getElementById('lookup-all');
    if (!el) return;
    el.innerHTML = html || Loading.empty(
      'package',
      tab === 'instock' ? 'No in-stock inventory found' : 'No inventory found',
      'Try a different Part Number or UPC'
    );
  }

  function _showResults(data) {
    _lastData = data;
    const hasResults = (data.byPartNumber?.length || data.byUpc?.length);

    const tabsEl = document.getElementById('lookup-tabs');
    if (tabsEl) tabsEl.style.display = hasResults ? 'block' : 'none';

    _renderResults(data, 'instock');
    _renderResults(data, 'all');

    const inStockEl = document.getElementById('lookup-instock');
    const allEl     = document.getElementById('lookup-all');
    if (inStockEl) inStockEl.style.display = _activeTab === 'instock' ? '' : 'none';
    if (allEl)     allEl.style.display     = _activeTab === 'all'     ? '' : 'none';

    _updateTabUI();
  }

  function _updateTabUI() {
    document.querySelectorAll('.lookup-tab').forEach(btn => {
      const isActive = btn.dataset.tab === _activeTab;
      btn.style.color        = isActive ? 'var(--primary)' : 'var(--txt-3)';
      btn.style.fontWeight   = isActive ? '600' : '500';
      btn.style.borderBottom = isActive ? '2px solid var(--primary)' : '2px solid transparent';
    });
  }

  async function search(query) {
    query = (query || '').trim();
    const clearBtn  = document.getElementById('box-clear-btn');
    const inStockEl = document.getElementById('lookup-instock');
    const allEl     = document.getElementById('lookup-all');
    const tabsEl    = document.getElementById('lookup-tabs');

    if (!query) {
      if (inStockEl) inStockEl.innerHTML = Loading.empty('search', 'Search for box inventory', 'Enter a Part Number or UPC above to view inventory allocation across boxes');
      if (allEl)     allEl.innerHTML     = '';
      if (tabsEl)    tabsEl.style.display = 'none';
      if (clearBtn)  clearBtn.style.display = 'none';
      return;
    }
    if (clearBtn) clearBtn.style.display = '';

    if (inStockEl) inStockEl.innerHTML = `<div style="display:flex;justify-content:center;padding:40px">${Loading.spinnerHtml()}</div>`;
    if (allEl)     allEl.innerHTML     = '';
    if (tabsEl)    tabsEl.style.display = 'none';

    try {
      const data = await API.lookup(query);
      _showResults(data);
    } catch (err) {
      if (inStockEl) inStockEl.innerHTML = Loading.error('Search failed. Please try again.');
      Notify.apiError(err);
    }
  }

  function init() {
    const input    = document.getElementById('box-search-input');
    const clearBtn = document.getElementById('box-clear-btn');
    const tabsEl   = document.getElementById('lookup-tabs');
    if (!input) return;

    let _debounce;
    input.addEventListener('input', () => {
      clearTimeout(_debounce);
      _debounce = setTimeout(() => search(input.value), 300);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); search(input.value); }
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.style.display = 'none';
      search('');
    });

    if (tabsEl) {
      tabsEl.addEventListener('click', e => {
        const tab = e.target.closest('.lookup-tab')?.dataset.tab;
        if (!tab || tab === _activeTab) return;
        _activeTab = tab;
        _updateTabUI();
        const is  = document.getElementById('lookup-instock');
        const all = document.getElementById('lookup-all');
        if (is)  is.style.display  = tab === 'instock' ? '' : 'none';
        if (all) all.style.display = tab === 'all'     ? '' : 'none';
        if (_lastData) _renderResults(_lastData, tab);
      });
    }
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    _lastData  = null;
    _activeTab = 'instock';
    const searchInput = document.getElementById('box-search-input');
    if (searchInput) searchInput.value = '';
    const tabsEl   = document.getElementById('lookup-tabs');
    const resultsEl = document.getElementById('lookup-results');
    if (tabsEl)    tabsEl.style.display = 'none';
    if (resultsEl) resultsEl.innerHTML = '';
  }

  return { init, search, reset };
})();

/* ── SKU View page (centralized SKU-level inventory analytics) ───────
   Single source of truth: backend metricsService.getSkuSummary, which
   reuses the SAME pivot CTEs that drive dashboard KPIs. The frontend is
   a rendering layer only — no grouping, no aggregate math, no row-level
   phantom assignment. Click a row to drill into the raw upload entries
   behind that SKU (the one place raw rows are still surfaced). */
const InventoryList = (() => {
  let _page          = 1;
  let _search        = '';
  let _total         = 0;
  let _loading       = false;
  // SKU view sorts on pivot fields, not raw row fields.
  let _sortBy        = 'sku';
  let _sortDir       = 'asc';
  let _statusFilter  = 'all';

  // Header columns: chevron · SKU · Total · Sold · Phantom · Remaining · Boxes · Last Added
  const COL_COUNT = 9;
  // Cache of raw rows per SKU so re-expanding a row doesn't refetch.
  const _rawCache = new Map();

  /* ── Undefined SKU check ─────────────────────────────────── */
  // Mirror of server/src/utils/inventoryPatterns.js. Keep in sync.
  // An identifier is undefined when blank, a CSV-export remnant ("/""),
  // or one of the common NA placeholders.
  const _UNDEFINED_PATTERNS = new Set(['', '"', '""', 'NA', 'N/A', '#NA', '#N/A']);
  function _isUndefined(val) {
    return _UNDEFINED_PATTERNS.has((val || '').trim().toUpperCase());
  }

  /* ── Sort headers ────────────────────────────────────────── */
  function _initSortHeaders() {
    const table = document.getElementById('inventory-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      th.style.cursor = 'pointer';
      th.style.userSelect = 'none';
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.style.cssText = 'margin-left:4px;opacity:.3;font-size:11px';
      arrow.textContent = '↕';
      th.appendChild(arrow);
      th.addEventListener('click', () => {
        const field = th.dataset.sort;
        if (_sortBy === field) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        else { _sortBy = field; _sortDir = 'desc'; }
        _page = 1;
        _updateSortHeaders();
        load();
      });
    });
    _updateSortHeaders();
  }

  function _updateSortHeaders() {
    const table = document.getElementById('inventory-table');
    if (!table) return;
    table.querySelectorAll('th[data-sort]').forEach(th => {
      const arrow = th.querySelector('.sort-arrow');
      if (!arrow) return;
      if (th.dataset.sort === _sortBy) {
        arrow.textContent = _sortDir === 'asc' ? '↑' : '↓';
        arrow.style.opacity = '1';
        arrow.style.color = 'var(--primary)';
      } else {
        arrow.textContent = '↕';
        arrow.style.opacity = '0.3';
        arrow.style.color = '';
      }
    });
  }

  /* ── Render: one row per SKU ────────────────────────────── */
  function _renderTable(items, total) {
    _total = total || 0;
    const tbody = document.getElementById('inventory-tbody');
    const info  = document.getElementById('inventory-info');
    if (!tbody) return;

    if (!items || !items.length) {
      tbody.innerHTML = `<tr><td colspan="${COL_COUNT}" style="padding:0">${Loading.empty('package', 'No SKUs found', 'Upload inventory data or adjust your filters')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('inventory-pagination', 1, 0, () => {});
      return;
    }

    tbody.innerHTML = items.map(item => {
      const sku        = item.sku || '';
      const initial    = Number(item.total_stock     ?? 0);
      const sold       = Number(item.sold_units      ?? 0);
      const phantom    = Number(item.phantom_units   ?? 0);
      const remaining  = Number(item.remaining_units ?? 0);
      const boxes      = Number(item.boxes_count     ?? 0);
      const isUndef    = !!item.is_undefined;
      const isPhantom  = phantom > 0;
      const isOOS      = remaining === 0 && !isUndef;

      // Row tint priority: undefined > phantom > OOS > none. Each tint maps
      // to a distinct semantic (validation issue · oversold · sold out).
      const rowClass = isUndef ? 'sku-row sku-row--undef'
                     : isPhantom ? 'sku-row sku-row--phantom'
                     : isOOS     ? 'sku-row sku-row--oos'
                     :             'sku-row';

      const undefBadge = isUndef
        ? ' <span style="font-size:10px;background:#fef9c3;color:#854d0e;padding:1px 5px;border-radius:3px;font-weight:600;vertical-align:middle">UNDEFINED</span>'
        : '';

      const remColor = remaining === 0
        ? 'color:var(--txt-4)'
        : 'color:var(--success);font-weight:600';
      const phantomColor = phantom > 0 ? 'color:#dc2626;font-weight:600' : 'color:var(--txt-4)';

      const canEdit = Auth.hasRole('manager');
      const editBtnCell = canEdit
        ? `<button class="btn btn-ghost btn-sm sku-edit-boxes" title="View & edit all boxes for this SKU" style="padding:4px 8px">
             <i data-lucide="pencil" class="icon" style="width:13px;height:13px"></i>
           </button>`
        : `<span style="color:var(--txt-4);font-size:11px">—</span>`;

      return `<tr class="${rowClass}" data-sku="${Utils.escapeHtml(sku)}">
        <td class="sku-row-chevron" style="text-align:center;color:var(--txt-4);cursor:pointer;user-select:none">
          <i data-lucide="chevron-right" class="icon sku-chevron-icon" style="width:14px;height:14px;transition:transform .15s"></i>
        </td>
        <td style="font-weight:600;color:var(--txt-1);cursor:pointer">${Utils.escapeHtml(sku || '—')}${undefBadge}</td>
        <td class="num">${Utils.stockBadge(initial)}</td>
        <td class="num" style="color:var(--txt-2)">${Utils.formatNumber(sold)}</td>
        <td class="num" style="${phantomColor}">${Utils.formatNumber(phantom)}</td>
        <td class="num" style="${remColor}">${Utils.formatNumber(remaining)}</td>
        <td class="num" style="color:var(--txt-3)">${Utils.formatNumber(boxes)}</td>
        <td style="color:var(--txt-3)">${Utils.formatDate(item.last_added_at)}</td>
        <td style="text-align:center">${editBtnCell}</td>
      </tr>`;
    }).join('');

    // Click anywhere on the row (except the edit button cell) toggles drilldown.
    tbody.querySelectorAll('.sku-row').forEach(tr => {
      tr.addEventListener('click', (e) => {
        // Don't toggle if the click landed on the Edit Boxes button or
        // anywhere inside the drilldown sub-table.
        if (e.target.closest('.sku-edit-boxes') || e.target.closest('.sku-drill-row')) return;
        _toggleDrilldown(tr);
      });
    });
    // Edit Boxes button → bulk-edit modal. Stop propagation so the row's
    // toggle handler doesn't also fire and expand the inline drilldown.
    tbody.querySelectorAll('.sku-edit-boxes').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr.sku-row');
        const sku = tr?.dataset.sku || '';
        if (sku) _openBoxesEditModal(sku);
      });
    });

    const ps = CONFIG.getPageSize();
    if (info) {
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)} SKUs`;
    }

    Pagination.render('inventory-pagination', _page, Math.ceil(_total / ps), p => { _page = p; load(); });
  }

  /* ── Drilldown: raw upload rows behind one SKU ──────────── */
  async function _toggleDrilldown(tr) {
    const sku       = tr.dataset.sku || '';
    if (!sku) return;
    const nextRow   = tr.nextElementSibling;
    const isOpen    = nextRow?.classList.contains('sku-drill-row');
    const chevron   = tr.querySelector('.sku-chevron-icon');

    if (isOpen) {
      nextRow.remove();
      if (chevron) chevron.style.transform = '';
      return;
    }
    if (chevron) chevron.style.transform = 'rotate(90deg)';

    // Insert a placeholder row, then fill from cache or fetch.
    const drillTr = document.createElement('tr');
    drillTr.className = 'sku-drill-row';
    drillTr.innerHTML = `<td colspan="${COL_COUNT}" style="padding:0;background:#f8fafc;border-top:1px solid var(--border)"><div style="padding:12px 16px;font-size:12px;color:var(--txt-4)">Loading raw rows&hellip;</div></td>`;
    tr.parentNode.insertBefore(drillTr, tr.nextSibling);

    const renderRows = (rows) => {
      if (!rows.length) {
        drillTr.querySelector('div').innerHTML = '<span style="color:var(--txt-4)">No raw rows for this SKU.</span>';
        return;
      }
      // The inline drilldown is READ-ONLY (2026-05-18). Editing is via the
      // bulk "Edit Boxes" modal accessible from the action column on the
      // SKU row — that lets the operator change multiple rows and Save All
      // in one go, without the page collapsing/reloading between edits.
      const head = `<thead><tr>
        <th style="width:110px;font-size:11px">UID</th>
        <th style="width:80px;font-size:11px">Box #</th>
        <th style="width:120px;font-size:11px">Part #</th>
        <th style="width:160px;font-size:11px">UPC</th>
        <th style="width:120px;font-size:11px;text-align:center">Initial Stock</th>
        <th style="width:130px;font-size:11px">Date Added</th>
        <th style="font-size:11px">Notes</th>
      </tr></thead>`;
      const body = rows.map(r => {
        const uid     = r.row_uid || '';
        const shortId = uid ? uid.slice(0, 8) : '—';
        const uidCell = uid
          ? `<span class="row-uid" title="Click to copy full UID&#10;${Utils.escapeHtml(uid)}" style="font-family:var(--font-number);font-variant-numeric:tabular-nums;font-size:11px;color:var(--txt-3);cursor:pointer;user-select:all">${Utils.escapeHtml(shortId)}</span>`
          : `<span style="color:var(--txt-4)">—</span>`;
        return `<tr data-uid="${Utils.escapeHtml(uid)}">
          <td>${uidCell}</td>
          <td>${Utils.escapeHtml(r.box_number || '—')}</td>
          <td style="font-family:var(--font-number);font-variant-numeric:tabular-nums;font-size:12px;color:var(--txt-2)">${Utils.escapeHtml(r.part_number || '—')}</td>
          <td style="font-family:var(--font-number);font-variant-numeric:tabular-nums;font-size:12px;color:var(--txt-2)">${Utils.escapeHtml(r.upc || '—')}</td>
          <td style="text-align:center;font-weight:600">${Utils.formatNumber(r.quantity ?? 0)}</td>
          <td style="white-space:nowrap;color:var(--txt-3)">${Utils.formatDate(r.date_added)}</td>
          <td style="font-size:12px;color:var(--txt-4)">${Utils.escapeHtml(r.notes || '—')}</td>
        </tr>`;
      }).join('');

      drillTr.querySelector('td').innerHTML = `
        <div style="padding:8px 14px 12px 38px">
          <table class="data-table" style="width:100%;background:#fff;border:1px solid var(--border);border-radius:6px;overflow:hidden">${head}<tbody>${body}</tbody></table>
        </div>`;

      const sub = drillTr.querySelector('tbody');
      sub.querySelectorAll('.row-uid').forEach(el => {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          const fullId = el.closest('tr')?.dataset.uid || '';
          if (!fullId) return;
          try {
            await navigator.clipboard.writeText(fullId);
            Notify.success('Copied', `UID ${fullId.slice(0, 8)}… copied`);
          } catch { Notify.warning('Copy failed', 'Could not access clipboard'); }
        });
      });
      drillTr.addEventListener('click', e => e.stopPropagation());

      if (window.lucide) lucide.createIcons();
    };

    try {
      let rows = _rawCache.get(sku);
      if (!rows) {
        const res  = await API.getRawRowsBySku(sku);
        rows       = res?.items || [];
        _rawCache.set(sku, rows);
      }
      renderRows(rows);
    } catch (err) {
      drillTr.querySelector('div').innerHTML = `<span style="color:var(--error)">Failed to load raw rows.</span>`;
      Notify.apiError(err);
    }
  }

  /* ── Bulk-edit modal: "Edit Boxes" ─────────────────────────────
     Replaces the per-row edit modal (2026-05-18). Lets the operator
     edit ANY combination of rows under one SKU and Save All in one
     pass. Key UX improvements over the previous flow:

       1. No page refresh between row edits — the SKU View table is
          only reloaded ONCE on modal close, and only if at least one
          row was saved.
       2. No row-reorder confusion — the inline drilldown's sort was
          stabilized to (date_added DESC, row_uid ASC) so visual
          position never changes mid-session. Inside this modal the
          order is locked to the fetched array.
       3. Single round-trip per dirty row — only changed rows are
          PATCHed; untouched rows are skipped.

     Tracking: each table row holds the ORIGINAL field values on
     `data-orig-*`. The current value is read from its <input>. A
     row is "dirty" when any input's value differs from its original.
  */
  async function _openBoxesEditModal(sku) {
    if (!sku) return;

    const m = new Modal({
      title:    `Edit Boxes — ${sku}`,
      body:     `<div id="boxes-edit-body"><div style="display:flex;justify-content:center;padding:40px">${Loading.spinnerHtml()}</div></div>`,
      footer:   `<div style="flex:1;font-size:12px;color:var(--txt-3)" id="boxes-edit-status">Loading rows…</div>
                 <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
                 <button class="btn btn-primary btn-sm" data-action="save" disabled>Save All</button>`,
      maxWidth: '1100px',
    });
    m.show();

    let _savesCommitted = 0; // tracks whether any save happened during this modal session

    const bodyEl   = m.bodyEl.querySelector('#boxes-edit-body');
    const statusEl = m.footerEl.querySelector('#boxes-edit-status');
    const saveBtn  = m.footerEl.querySelector('[data-action="save"]');
    const cancelBtn= m.footerEl.querySelector('[data-action="cancel"]');

    function _setStatus(text, isError = false) {
      if (statusEl) {
        statusEl.textContent = text;
        statusEl.style.color = isError ? 'var(--error)' : 'var(--txt-3)';
      }
    }

    function _renderTableForRows(rows) {
      if (!rows.length) {
        bodyEl.innerHTML = `<div style="padding:24px;color:var(--txt-4);text-align:center">No raw rows for this SKU.</div>`;
        return;
      }
      const head = `<thead><tr>
        <th style="width:90px;font-size:11px">UID</th>
        <th style="width:110px;font-size:11px">Box #</th>
        <th style="width:130px;font-size:11px">Part #</th>
        <th style="width:160px;font-size:11px">UPC</th>
        <th style="width:90px;font-size:11px;text-align:center">Qty</th>
        <th style="width:140px;font-size:11px">Date Added</th>
        <th style="font-size:11px">Notes</th>
        <th style="width:140px;font-size:11px">SKU</th>
      </tr></thead>`;
      const inputStyle = 'padding:5px 8px;border:1px solid var(--border);border-radius:5px;font-size:12px;width:100%;box-sizing:border-box;background:#fff';
      const body = rows.map(r => {
        const uid     = r.row_uid || '';
        const shortId = uid ? uid.slice(0, 8) : '—';
        return `<tr data-uid="${Utils.escapeHtml(uid)}"
                    data-orig-sku="${Utils.escapeHtml(r.sku || '')}"
                    data-orig-upc="${Utils.escapeHtml(r.upc || '')}"
                    data-orig-qty="${Utils.escapeHtml(String(r.quantity ?? 0))}"
                    data-orig-part="${Utils.escapeHtml(r.part_number || '')}"
                    data-orig-box="${Utils.escapeHtml(r.box_number || '')}"
                    data-orig-notes="${Utils.escapeHtml(r.notes || '')}"
                    data-orig-date="${Utils.escapeHtml(r.date_added || '')}">
          <td style="font-family:var(--font-number);font-size:11px;color:var(--txt-3)" title="${Utils.escapeHtml(uid)}">${Utils.escapeHtml(shortId)}</td>
          <td><input data-field="box_number" style="${inputStyle}" value="${Utils.escapeHtml(r.box_number || '')}"></td>
          <td><input data-field="part_number" style="${inputStyle}" value="${Utils.escapeHtml(r.part_number || '')}"></td>
          <td><input data-field="upc" style="${inputStyle}" value="${Utils.escapeHtml(r.upc || '')}"></td>
          <td><input data-field="quantity" type="number" min="0" style="${inputStyle};text-align:center" value="${Utils.escapeHtml(String(r.quantity ?? 0))}"></td>
          <td><input data-field="date_added" type="date" style="${inputStyle}" value="${Utils.toDateInputValue(r.date_added) || ''}"></td>
          <td><input data-field="notes" style="${inputStyle}" value="${Utils.escapeHtml(r.notes || '')}" placeholder="—"></td>
          <td><input data-field="sku" style="${inputStyle}" value="${Utils.escapeHtml(r.sku || '')}"></td>
        </tr>`;
      }).join('');

      bodyEl.innerHTML = `
        <div style="max-height:60vh;overflow:auto;border:1px solid var(--border);border-radius:6px">
          <table class="data-table" style="width:100%;background:#fff;table-layout:fixed">${head}<tbody>${body}</tbody></table>
        </div>
        <div style="margin-top:10px;font-size:12px;color:var(--txt-4)">
          Edit any cell. Only rows you change are saved. Quantity 0 marks a box as out of stock.
        </div>`;

      // Track dirty rows: any input event recomputes the dirty count and
      // tints the affected row.
      const tbody = bodyEl.querySelector('tbody');
      tbody.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('input', _recountDirty);
      });
      _recountDirty();
    }

    function _isRowDirty(tr) {
      for (const inp of tr.querySelectorAll('input[data-field]')) {
        const field = inp.dataset.field;
        const orig  = String(tr.dataset[`orig${_capitalize(_camel(field))}`] ?? '');
        const cur   = String(inp.value ?? '');
        if (orig !== cur) return true;
      }
      return false;
    }

    function _camel(s) { return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
    function _capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

    function _recountDirty() {
      const rows = bodyEl.querySelectorAll('tbody tr');
      let dirtyCount = 0;
      rows.forEach(tr => {
        const dirty = _isRowDirty(tr);
        tr.style.background = dirty ? '#fff7ed' : '';
        if (dirty) dirtyCount++;
      });
      if (dirtyCount === 0) {
        _setStatus('No unsaved changes.');
        saveBtn.disabled = true;
      } else {
        _setStatus(`${dirtyCount} row${dirtyCount === 1 ? '' : 's'} with unsaved changes.`);
        saveBtn.disabled = false;
      }
    }

    async function _saveAll() {
      saveBtn.disabled = true;
      cancelBtn.disabled = true;
      const rows = [...bodyEl.querySelectorAll('tbody tr')].filter(_isRowDirty);
      if (!rows.length) { saveBtn.disabled = true; cancelBtn.disabled = false; return; }

      let okCount = 0;
      let failed  = [];
      let i = 0;
      for (const tr of rows) {
        i++;
        _setStatus(`Saving ${i} of ${rows.length}…`);
        const updates = {};
        tr.querySelectorAll('input[data-field]').forEach(inp => {
          if (inp.dataset.field === 'quantity') {
            updates.quantity = parseInt(inp.value, 10);
          } else {
            updates[inp.dataset.field] = (inp.value ?? '').trim();
          }
        });
        if (!updates.sku || !updates.upc || isNaN(updates.quantity)) {
          failed.push({ uid: tr.dataset.uid, reason: 'SKU, UPC, and quantity are required' });
          continue;
        }
        try {
          await API.updateInventory(tr.dataset.uid, updates);
          okCount++;
          _savesCommitted++;
          // Rewrite the row's original-data attributes so subsequent
          // edits compare against the freshly-saved baseline.
          tr.dataset.origSku   = updates.sku;
          tr.dataset.origUpc   = updates.upc;
          tr.dataset.origQty   = String(updates.quantity);
          tr.dataset.origPart  = updates.part_number ?? '';
          tr.dataset.origBox   = updates.box_number ?? '';
          tr.dataset.origNotes = updates.notes ?? '';
          tr.dataset.origDate  = updates.date_added ?? '';
        } catch (err) {
          failed.push({ uid: tr.dataset.uid, reason: err.message || 'Save failed' });
        }
      }

      MetricsEngine.invalidate();

      if (failed.length === 0) {
        // Full success → close the modal + trigger the single deferred
        // load() so the SKU View aggregate row updates.
        Notify.success('Saved', `${okCount} row${okCount === 1 ? '' : 's'} updated`);
        m.hide();
        m.destroy();
        if (_savesCommitted > 0) load();
        return;
      }

      // Partial or full failure → keep modal open so the operator can
      // see which rows failed (still tinted orange) and retry without
      // re-opening. Toast carries the first failure reason.
      if (okCount > 0) {
        Notify.warning('Partial save', `${okCount} saved · ${failed.length} failed (${failed[0].reason})`);
      } else {
        Notify.error('Save failed', failed[0]?.reason || 'No rows saved');
      }

      _recountDirty();
      cancelBtn.disabled = false;
    }

    saveBtn.addEventListener('click', _saveAll);
    cancelBtn.addEventListener('click', () => {
      m.hide();
      m.destroy();
      // Single deferred reload — only if a save actually happened. The
      // SKU aggregates are stale until inventory_summary refreshes; the
      // load() call kicks the live read path or summary read path to
      // pick up the new totals.
      if (_savesCommitted > 0) load();
    });

    // Initial fetch.
    try {
      const res  = await API.getRawRowsBySku(sku);
      const rows = res?.items || [];
      _renderTableForRows(rows);
      if (window.lucide) lucide.createIcons();
    } catch (err) {
      bodyEl.innerHTML = `<div style="padding:24px;color:var(--error);text-align:center">${Utils.escapeHtml(err.message || 'Failed to load rows')}</div>`;
      _setStatus('Failed to load rows.', true);
    }
  }

  /* ── Set filter programmatically (from dashboard KPI clicks) */
  function setStatusFilter(status) {
    _statusFilter = status || 'all';
    _page = 1;
    _search = '';
    const searchEl = document.getElementById('inventory-search');
    if (searchEl) searchEl.value = '';
    const sel = document.getElementById('filter-inventory-status');
    if (sel) sel.value = _statusFilter;
    load();
  }

  /* ── Export chooser ──────────────────────────────────────────
     Two distinct exports for this page, both respecting the active
     status/search filter so the download mirrors what's on screen:

       • SKU View       → one row per SKU with aggregated metrics
                          (the intelligence dataset).
       • Inventory List → every raw upload row underneath the matching
                          SKUs, with UIDs intact (the audit dataset
                          needed for feed-file CRUD).

     A professional modal forces the operator to declare intent — the
     two datasets answer different questions and accidental swaps
     have caused operational confusion in the past. */
  let _exporting = false;

  function _openExportChooser() {
    if (_exporting) return;
    const isFiltered = !!_search || _statusFilter !== 'all';
    const filterSummary = (() => {
      const parts = [];
      if (_search) parts.push(`search "${Utils.escapeHtml(_search)}"`);
      if (_statusFilter && _statusFilter !== 'all') {
        const lbl = ({ in_stock:'In Stock', oos:'Out of Stock', phantom:'Phantom', undefined:'Undefined' })[_statusFilter] || _statusFilter;
        parts.push(`filter: <strong>${lbl}</strong>`);
      }
      return parts.length
        ? `<div style="font-size:12px;color:var(--txt-3);background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:14px">Applies to current view: ${parts.join(' · ')}.</div>`
        : `<div style="font-size:12px;color:var(--txt-4);margin-bottom:14px">Exports the full dataset (no filters applied).</div>`;
    })();

    const optionHtml = (key, icon, title, sub, badge) => `
      <button class="export-choice" data-choice="${key}" type="button"
        style="all:unset;box-sizing:border-box;display:flex;align-items:flex-start;gap:14px;width:100%;padding:14px 16px;border:1.5px solid var(--border);border-radius:10px;cursor:pointer;background:#fff;transition:border-color .12s, background .12s, transform .08s">
        <span style="flex-shrink:0;width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;border-radius:9px;background:var(--primary-50);color:var(--primary-text)">
          <i data-lucide="${icon}" class="icon" style="width:18px;height:18px"></i>
        </span>
        <span style="flex:1;display:flex;flex-direction:column;gap:3px;min-width:0">
          <span style="display:flex;align-items:center;gap:8px">
            <span style="font-size:14px;font-weight:700;color:var(--txt-1)">${title}</span>
            ${badge ? `<span style="font-size:10px;font-weight:700;background:var(--surface-3);color:var(--txt-3);padding:2px 7px;border-radius:999px;letter-spacing:.04em;text-transform:uppercase">${badge}</span>` : ''}
          </span>
          <span style="font-size:12.5px;color:var(--txt-3);line-height:1.45">${sub}</span>
        </span>
        <span style="flex-shrink:0;color:var(--txt-4);display:flex;align-items:center;align-self:center">
          <i data-lucide="arrow-right" class="icon" style="width:16px;height:16px"></i>
        </span>
      </button>`;

    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:6px">
        <p style="font-size:13.5px;color:var(--txt-2);line-height:1.55;margin-bottom:8px">
          Choose the dataset to download. Both options respect the active filters and search on the SKU View.
        </p>
        ${filterSummary}
        <div style="display:flex;flex-direction:column;gap:10px">
          ${optionHtml('summary', 'layout-grid',
             'SKU View',
             'One row per SKU with Total Stock, Sold, Phantom, Remaining, Boxes, Last Added. The intelligence dataset for reporting and analysis.',
             'Aggregated')}
          ${optionHtml('raw', 'list',
             'Inventory List',
             'Every raw upload row behind the matching SKUs, with UIDs for feed-file CRUD. The audit dataset for operational traceability.',
             'Raw · with UIDs')}
        </div>
      </div>`;

    const m = new Modal({
      title:    'Export inventory data',
      body:     bodyHtml,
      footer:   `<button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>`,
      maxWidth: '540px',
    });
    m.show();
    if (window.lucide) lucide.createIcons();

    // Hover/active feedback for the choice cards.
    m.bodyEl.querySelectorAll('.export-choice').forEach(btn => {
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = 'var(--primary)';
        btn.style.background  = 'var(--primary-50)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = 'var(--border)';
        btn.style.background  = '#fff';
      });
      btn.addEventListener('click', async () => {
        const choice = btn.dataset.choice;
        m.hide(); m.destroy();
        if      (choice === 'summary') await _doExportSkuSummary(isFiltered);
        else if (choice === 'raw')     await _doExportInventoryListRaw(isFiltered);
      });
    });

    m.footerEl.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'cancel') { m.hide(); m.destroy(); }
    });
  }

  async function _doExportSkuSummary(isFiltered) {
    if (_exporting) return;
    _exporting = true;
    const btn = document.getElementById('inventory-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    try {
      const filters = {};
      if (_sortBy)                                  filters.sort_by  = _sortBy;
      if (_sortDir)                                 filters.sort_dir = _sortDir;
      if (_search)                                  filters.search   = _search;
      if (_statusFilter && _statusFilter !== 'all') filters.status   = _statusFilter;
      const blob = await API.exportSkuSummary(filters);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `sku_view_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { Notify.apiError(err); }
    finally {
      _exporting = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download" class="icon" style="width:14px;height:14px"></i> Export'; if (window.lucide) lucide.createIcons(); }
    }
  }

  async function _doExportInventoryListRaw(isFiltered) {
    if (_exporting) return;
    _exporting = true;
    const btn = document.getElementById('inventory-export-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    try {
      const filters = {};
      if (_search)                                  filters.search = _search;
      if (_statusFilter && _statusFilter !== 'all') filters.status = _statusFilter;
      const blob = await API.exportInventoryListRaw(filters);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `inventory_list_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { Notify.apiError(err); }
    finally {
      _exporting = false;
      if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download" class="icon" style="width:14px;height:14px"></i> Export'; if (window.lucide) lucide.createIcons(); }
    }
  }

  /* ── Load (centralized SKU summary endpoint) ──────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    const tbody = document.getElementById('inventory-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(COL_COUNT, 6);

    // Drilldown cache invalidates on every list reload — a fresh aggregate
    // means raw rows may have moved too (uploads, edits, deletes).
    _rawCache.clear();

    const ps = CONFIG.getPageSize();

    try {
      const options = { sort_by: _sortBy, sort_dir: _sortDir, status: _statusFilter || 'all' };
      const res    = await API.getSkuSummary(_page, ps, _search, options);
      const data   = res?.data ?? res;
      _renderTable(data.items || [], data.total || 0);
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="${COL_COUNT}">${Loading.error('Failed to load SKU view')}</td></tr>`;
      Notify.apiError(err);
    } finally {
      _loading = false;
    }
  }

  function init() {
    const searchInput = document.getElementById('inventory-search');
    const statusSel   = document.getElementById('filter-inventory-status');
    const exportBtn   = document.getElementById('inventory-export-btn');

    if (searchInput) {
      let _debounce;
      searchInput.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => { _search = searchInput.value.trim(); _page = 1; load(); }, 300);
      });
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); _search = searchInput.value.trim(); _page = 1; load(); }
      });
    }

    if (statusSel) {
      statusSel.addEventListener('change', () => { _statusFilter = statusSel.value; _page = 1; load(); });
    }

    if (exportBtn) exportBtn.addEventListener('click', _openExportChooser);

    _initSortHeaders();
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    _page         = 1;
    _search       = '';
    _total        = 0;
    _loading      = false;
    _sortBy       = 'sku';
    _sortDir      = 'asc';
    _statusFilter = 'all';
    _rawCache.clear();
    const tbody = document.querySelector('#page-inventory tbody');
    if (tbody) tbody.innerHTML = '';
    const searchInput = document.getElementById('inventory-search');
    if (searchInput) searchInput.value = '';
    const statusSel = document.getElementById('filter-inventory-status');
    if (statusSel) statusSel.value = 'all';
  }

  return { init, load, reset, setUndefinedFilter: () => setStatusFilter('undefined'), setStatusFilter };
})();

/* ── Pagination helper ──────────────────────────────────────── */
const Pagination = {
  render(containerId, currentPage, totalPages, onPageChange) {
    const el = document.getElementById(containerId);
    if (!el || totalPages <= 1) { if (el) el.innerHTML = ''; return; }

    const MAX_VISIBLE = 5;
    const pages = [];

    if (totalPages <= MAX_VISIBLE + 2) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      const start = Math.max(2, currentPage - 1);
      const end   = Math.min(totalPages - 1, currentPage + 1);

      if (start > 2)           pages.push('...');
      for (let i = start; i <= end; i++) pages.push(i);
      if (end < totalPages - 1) pages.push('...');
      pages.push(totalPages);
    }

    el.innerHTML = `
      <div class="page-controls">
        <button class="page-btn" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''}>‹</button>
        ${pages.map(p =>
          p === '...'
            ? `<span class="page-sep">…</span>`
            : `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`
        ).join('')}
        <button class="page-btn" data-page="${currentPage + 1}" ${currentPage >= totalPages ? 'disabled' : ''}>›</button>
      </div>`;

    el.querySelectorAll('.page-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page);
        if (p >= 1 && p <= totalPages && p !== currentPage) onPageChange(p);
      });
    });
  },
};
