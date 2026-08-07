/* ============================================================
   orders.js — Orders page: filter bar, table, pagination, bulk delete, inline edit
   ============================================================ */

const Orders = (() => {
  let _page        = 1;
  let _filters     = {};
  let _total       = 0;
  let _loading     = false;
  let _platforms   = [];
  let _sortBy      = 'order_date';
  let _sortDir     = 'desc';

  const COL_COUNT = 7; // UID, Order ID, Order Date, SKU, Qty Sold, Shipped SKU, Platform

  /* ── SKU parser ──────────────────────────────────────────── */
  function _parseSku(sku) {
    const m = (sku || '').match(/^ARA(\d+)-(.+)-(.+)$/);
    if (!m) return null;
    return { box: m[1], partNumber: m[2], upc: m[3] };
  }

  // shipped_sku may arrive as bare digits ("20"), prefix-only ("ARA20"), or
  // a full SKU ("ARA20-4060915-037256018282"). For the box-only forms we
  // strip down to digits so we never render "ARAARA20-..." again.
  function _bareBox(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return '';
    const m = s.match(/^ARA(\d+)(?:-.*)?$/i);
    return m ? m[1] : s;
  }

  // Resolve the effective shipped SKU for display. Mirrors the SQL
  // effectiveSkuSql() logic for the single shipped_sku column.
  function _getEffectiveSku(sku, shippedSku) {
    const v = (shippedSku ?? '').toString().trim();
    // Full SKU override (e.g. wrong-part scenario) → verbatim.
    if (v && /^ARA\d+-.+-.+$/i.test(v)) return v;
    if (!sku) return v || '';
    const parsed = _parseSku(sku);
    if (!parsed) return sku;
    const box = _bareBox(v) || parsed.box;
    return `ARA${box}-${parsed.partNumber}-${parsed.upc}`;
  }

  /* ── Platform badge ──────────────────────────────────────── */
  function _platformBadge(platform) {
    if (!platform) return '<span style="color:var(--txt-4)">-</span>';
    const colors = { amazon: 'info', ebay: 'warning', walmart: 'primary', shopify: 'success' };
    return Utils.badgeHtml(colors[platform.toLowerCase()] || 'gray', platform);
  }

  /* ── Sort headers ────────────────────────────────────────── */
  function _initSortHeaders() {
    const table = document.getElementById('orders-table');
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
    const table = document.getElementById('orders-table');
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

  /* ── Action menu (kebab) ─────────────────────────────────── */
  let _activeMenu = null;

  function _closeActionMenu() {
    if (_activeMenu) { _activeMenu.remove(); _activeMenu = null; }
  }


  /* ── Render table ────────────────────────────────────────── */
  function _renderTable(rows, total) {
    _total = total || 0;
    const tbody   = document.getElementById('orders-tbody');
    const info    = document.getElementById('orders-info');
    const canEdit = Auth.hasRole('manager');
    if (!tbody) return;

    if (!rows || !rows.length) {
      tbody.innerHTML = `<tr><td colspan="${COL_COUNT}" style="padding:0">${Loading.empty('shopping-cart', 'No orders found', 'Adjust your filters or upload order data')}</td></tr>`;
      if (info) info.textContent = '';
      Pagination.render('orders-pagination', 1, 0, () => {});
      return;
    }

    tbody.innerHTML = rows.map(row => {
      const id          = row.order_row_id || '';
      const isUnknown   = !!row.is_unknown;
      const isWrongPart = !!row.is_wrong_part;

      const parsedSku   = _parseSku(row.sku || '');
      const origBox     = parsedSku?.box || '';
      const shippedSku  = row.shipped_sku || '';
      const effectiveShippedSku = _getEffectiveSku(row.sku || '', shippedSku);
      // "Override" badge: box differs from the ordered SKU's box but the
      // part-UPC matches (server's is_wrong_part = false).
      const effectiveBox = _parseSku(effectiveShippedSku)?.box || '';
      const isBoxOverride = !isWrongPart && !!origBox && !!effectiveBox && effectiveBox !== origBox;
      let rowClass = isUnknown ? 'row-unknown' : '';
      if (isWrongPart) rowClass = rowClass ? `${rowClass} row-wrong-part` : 'row-wrong-part';
      else if (isBoxOverride) rowClass = rowClass ? `${rowClass} row-override` : 'row-override';
      const trAttr = rowClass ? ` class="${rowClass}"` : '';

      const badgeHtml = isWrongPart
        ? '<span style="font-size:10px;background:#fee2e2;color:#b91c1c;padding:1px 5px;border-radius:3px;font-weight:700;margin-left:5px;vertical-align:middle">Wrong Part</span>'
        : (isBoxOverride
          ? '<span style="font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle">Override</span>'
          : '');

      let shippedHtml;
      if (!canEdit) {
        shippedHtml = `<span style="font-weight:500">${Utils.escapeHtml(effectiveShippedSku || '—')}</span>${badgeHtml}`;
      } else if (isWrongPart || isBoxOverride) {
        shippedHtml = `<span style="font-weight:500">${Utils.escapeHtml(effectiveShippedSku)}</span>${badgeHtml}<button class="order-edit-btn" style="background:none;border:none;opacity:.45;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle;display:inline-flex;align-items:center" title="Change fulfillment SKU"><i data-lucide="pencil" class="icon" style="width:12px;height:12px"></i></button>`;
      } else {
        shippedHtml = `<span class="order-edit-btn" style="display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer" title="Click to change fulfillment SKU">&bull; ${Utils.escapeHtml(effectiveShippedSku || '&mdash;')}</span>`;
      }

      const shortId = id ? id.slice(0, 8) : '—';
      const uidCell = id
        ? `<span class="row-uid" title="Click to copy full UID&#10;${Utils.escapeHtml(id)}" style="font-family:var(--font-number);font-variant-numeric:tabular-nums;font-size:11.5px;color:var(--txt-3);cursor:pointer;user-select:all">${Utils.escapeHtml(shortId)}</span>`
        : `<span style="color:var(--txt-4)">—</span>`;

      const orderIdRaw  = row.order_id || '';
      const orderIdCell = orderIdRaw
        ? `<span style="font-family:var(--font-number);font-variant-numeric:tabular-nums;font-size:12px;color:var(--txt-1);font-weight:500" title="${Utils.escapeHtml(orderIdRaw)}">${Utils.escapeHtml(orderIdRaw)}</span>`
        : `<span style="color:var(--txt-4)">—</span>`;

      return `<tr data-row-id="${Utils.escapeHtml(id)}"
                data-order-date="${Utils.escapeHtml(row.order_date || '')}"
                data-order-id="${Utils.escapeHtml(orderIdRaw)}"
                data-sku="${Utils.escapeHtml(row.sku || '')}"
                data-qty="${Utils.escapeHtml(String(row.quantity_sold ?? ''))}"
                data-shipped-sku="${Utils.escapeHtml(shippedSku)}"
                data-platform="${Utils.escapeHtml(row.platform || '')}"${trAttr}>
        <td>${uidCell}</td>
        <td>${orderIdCell}</td>
        <td>${Utils.escapeHtml(row.order_date || '-')}</td>
        <td style="font-weight:500">${Utils.escapeHtml(row.sku || '-')}</td>
        <td class="num"><strong>${Utils.formatNumber(row.quantity_sold)}</strong></td>
        <td class="shipped-cell" style="white-space:nowrap">
          ${shippedHtml}
        </td>
        <td>${_platformBadge(row.platform)}</td>
      </tr>`;
    }).join('');

    if (canEdit) {
      tbody.querySelectorAll('.order-edit-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          _openInlineSkuSelector(btn.closest('tr'));
        });
      });
    }

    // Click-to-copy full UID
    tbody.querySelectorAll('.row-uid').forEach(el => {
      el.addEventListener('click', async e => {
        e.stopPropagation();
        const fullId = el.closest('tr')?.dataset.rowId || '';
        if (!fullId) return;
        try {
          await navigator.clipboard.writeText(fullId);
          Notify.success('Copied', `UID ${fullId.slice(0, 8)}… copied`);
        } catch {
          Notify.warning('Copy failed', 'Could not access clipboard');
        }
      });
    });

    const ps = CONFIG.getPageSize();
    if (info) {
      const start = ((_page - 1) * ps) + 1;
      const end   = Math.min(_page * ps, _total);
      info.textContent = `Showing ${start}–${end} of ${Utils.formatNumber(_total)} orders`;
    }

    Pagination.render('orders-pagination', _page, Math.ceil(_total / ps), p => { _page = p; load(); });
  }

  /* ── Fulfillment SKU popover ─────────────────────────────── */
  let _activePopover    = null;
  let _popoverListeners = { outside: null, keydown: null };

  function _closeBoxPopover() {
    if (_activePopover) { _activePopover.remove(); _activePopover = null; }
    if (_popoverListeners.outside) { document.removeEventListener('mousedown', _popoverListeners.outside); _popoverListeners.outside = null; }
    if (_popoverListeners.keydown) { document.removeEventListener('keydown',   _popoverListeners.keydown);  _popoverListeners.keydown  = null; }
  }

  function _restoreShippedCell(cell, shippedSkuValue) {
    const sku = cell.closest('tr')?.dataset.sku || '';
    const origBox    = _parseSku(sku)?.box || '';
    const shippedSku = _getEffectiveSku(sku, shippedSkuValue || '');
    const effBox     = _parseSku(shippedSku)?.box || '';
    const isOverride = !!effBox && !!origBox && effBox !== origBox;
    cell.innerHTML   = '';

    if (isOverride) {
      const text = document.createElement('span');
      text.style.fontWeight = '500';
      text.textContent = shippedSku;
      const badge = document.createElement('span');
      badge.textContent = 'Override';
      badge.style.cssText = 'font-size:10px;background:#fef3c7;color:#d97706;padding:1px 5px;border-radius:3px;font-weight:600;margin-left:5px;vertical-align:middle';
      const btn = document.createElement('button');
      btn.style.cssText = 'background:none;border:none;opacity:.45;font-size:11px;padding:0 3px;margin-left:4px;cursor:pointer;vertical-align:middle';
      btn.title = 'Change fulfillment SKU';
      btn.innerHTML = '<i data-lucide="pencil" class="icon" style="width:12px;height:12px"></i>';
      btn.addEventListener('click', e => { e.stopPropagation(); _openInlineSkuSelector(cell.closest('tr')); });
      text.appendChild(badge);
      cell.appendChild(text);
      cell.appendChild(btn);
    } else {
      const chip = document.createElement('span');
      chip.style.cssText = 'display:inline-flex;align-items:center;gap:3px;background:#dbeafe;border:1.5px solid #93c5fd;border-radius:6px;padding:2px 9px;font-size:12px;font-weight:700;color:#1d4ed8;cursor:pointer';
      chip.title = 'Click to change fulfillment SKU';
      chip.textContent = shippedSku ? `• ${shippedSku}` : '—';
      chip.addEventListener('click', e => { e.stopPropagation(); _openInlineSkuSelector(cell.closest('tr')); });
      cell.appendChild(chip);
    }
  }

  function _showSkuPopover(cell, allOptions, pendingBoxInit, onConfirm) {
    _closeBoxPopover();
    // initialBox = what the row currently uses (either the feed-file SKU or
    // a prior popover override). Confirm stays disabled until the operator
    // picks something different — both the "only one option" case AND the
    // "clicked the already-selected option" case collapse to: nothing to save.
    const initialBox = pendingBoxInit;
    let pendingBox   = pendingBoxInit;
    const pop = document.createElement('div');
    pop.style.cssText = 'position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,.13),0 2px 8px rgba(0,0,0,.07);width:320px;display:flex;flex-direction:column;z-index:10001;font-family:inherit;font-size:13px;overflow:hidden';

    const rect = cell.getBoundingClientRect();
    pop.style.top  = (rect.bottom + 6) + 'px';
    pop.style.left = Math.min(rect.left, window.innerWidth - 336) + 'px';

    function _makeOptEl(opt) {
      const isSel = opt.box_number === pendingBox;
      const el = document.createElement('div');
      el.style.cssText = [
        'display:flex;justify-content:space-between;align-items:center',
        'padding:8px 10px;border-radius:7px;cursor:pointer;margin-bottom:2px;transition:background .1s',
        isSel ? 'background:#fef3d8;border:1.5px solid #fbbf24' : 'background:transparent;border:1.5px solid transparent',
      ].join(';');

      const nameEl = document.createElement('span');
      nameEl.style.cssText = opt.isOriginal ? 'font-weight:700;color:#1d4ed8' : 'font-weight:500;color:#1e293b';
      nameEl.textContent = opt.effective_sku;

      const meta = document.createElement('span');
      meta.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:12px';
      const qtyEl = document.createElement('span');
      qtyEl.style.cssText = 'color:' + (isSel ? '#92400e' : '#64748b');
      qtyEl.textContent = `Qty ${opt.remaining_stock}`;
      meta.appendChild(qtyEl);
      if (opt.isOriginal) {
        const badge = document.createElement('span');
        badge.textContent = 'Original';
        badge.style.cssText = 'background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:999px;font-size:11px;font-weight:600';
        meta.appendChild(badge);
      }

      el.appendChild(nameEl);
      el.appendChild(meta);
      el.addEventListener('mouseenter', () => { if (!isSel) el.style.background = '#f8fafc'; });
      el.addEventListener('mouseleave', () => { if (!isSel) el.style.background = 'transparent'; });
      el.addEventListener('click', () => { pendingBox = opt.box_number; _render(); });
      return el;
    }

    function _render() {
      pop.innerHTML = '';

      const title = document.createElement('div');
      title.style.cssText = 'padding:12px 14px;font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #e2e8f0;background:#f8fafc';
      title.textContent = 'Select fulfillment SKU';
      pop.appendChild(title);

      const list = document.createElement('div');
      list.style.cssText = 'padding:10px 12px;overflow-y:auto;max-height:280px';
      if (allOptions.length) {
        allOptions.forEach(opt => list.appendChild(_makeOptEl(opt)));
      } else {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#94a3b8;font-size:12px;text-align:center;padding:24px 0';
        empty.textContent = 'No fulfillment SKUs found for this part or UPC';
        list.appendChild(empty);
      }
      pop.appendChild(list);

      const footer = document.createElement('div');
      footer.style.cssText = 'padding:10px 12px;border-top:1px solid #f1f5f9;display:flex;gap:8px;justify-content:flex-end;background:#f8fafc';
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-secondary btn-sm';
      cancelBtn.style.fontSize = '12px';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', e => { e.stopPropagation(); _closeBoxPopover(); });
      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'btn btn-primary btn-sm';
      confirmBtn.style.fontSize = '12px';
      confirmBtn.textContent = 'Confirm';
      // No-change guard: when pendingBox equals what the row already uses,
      // there's nothing to save — disable Confirm and explain via tooltip.
      const noChange = pendingBox === initialBox;
      confirmBtn.disabled = noChange;
      if (noChange) {
        confirmBtn.title         = allOptions.length <= 1
          ? 'No alternative fulfillment SKUs available for this part / UPC'
          : 'Pick a different SKU to enable Confirm';
        confirmBtn.style.opacity = '0.5';
        confirmBtn.style.cursor  = 'not-allowed';
      }
      confirmBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (confirmBtn.disabled) return;
        _closeBoxPopover();
        onConfirm(pendingBox);
      });
      footer.appendChild(cancelBtn);
      footer.appendChild(confirmBtn);
      pop.appendChild(footer);
    }

    _render();
    document.body.appendChild(pop);
    _activePopover = pop;

    _popoverListeners.outside = e => { if (!pop.contains(e.target) && !cell.contains(e.target)) _closeBoxPopover(); };
    setTimeout(() => document.addEventListener('mousedown', _popoverListeners.outside), 0);
    _popoverListeners.keydown = e => { if (e.key === 'Escape') { e.preventDefault(); _closeBoxPopover(); } };
    document.addEventListener('keydown', _popoverListeners.keydown);
  }

  async function _openInlineSkuSelector(tr) {
    const rowId       = tr.dataset.rowId;
    const sku         = tr.dataset.sku;
    const parsed      = _parseSku(sku);
    // Current stored value is the canonical shipped_sku (bare box for legacy /
    // popover-driven overrides, full SKU only for wrong-part rows from feed).
    const currentBox  = _bareBox(tr.dataset.shippedSku || '');
    const cell        = tr.querySelector('td.shipped-cell');
    if (!cell) return;

    if (_activePopover?.dataset?.rowId === rowId) { _closeBoxPopover(); return; }
    _closeBoxPopover();

    if (!parsed) { Notify.warning('Cannot edit', 'SKU format not recognized'); return; }

    const trigger = cell.firstElementChild;
    if (trigger) { trigger.style.opacity = '0.5'; trigger.style.pointerEvents = 'none'; }

    try {
      const result = await API.getInventoryAlternatives(sku);
      const { originalBox, originalSku, alternatives } = result || {};
      const effectiveOrigBox = originalBox || parsed.box;
      const effectiveOrigSku = originalSku || _getEffectiveSku(sku, effectiveOrigBox);

      const origData   = (alternatives || []).find(a => a.box_number === effectiveOrigBox);
      const allOptions = [
        { box_number: effectiveOrigBox, effective_sku: effectiveOrigSku, remaining_stock: origData?.remaining_stock ?? 0, isOriginal: true },
        ...(alternatives || [])
          .filter(a => a.box_number !== effectiveOrigBox && a.remaining_stock > 0)
          .sort((a, b) => b.remaining_stock - a.remaining_stock)
          .map(a => ({
            ...a,
            effective_sku: a.effective_sku || _getEffectiveSku(sku, a.box_number) || a.sku || `Box ${a.box_number}`,
            isOriginal: false,
          })),
      ];

      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }

      _showSkuPopover(cell, allOptions, currentBox || effectiveOrigBox, async selectedBox => {
        const isOriginalSelected = selectedBox === effectiveOrigBox;
        const newShipped = isOriginalSelected ? '' : selectedBox;
        const prevLabel  = currentBox && currentBox !== effectiveOrigBox ? _getEffectiveSku(sku, currentBox) : `• ${_getEffectiveSku(sku, effectiveOrigBox)}`;
        const nextLabel  = isOriginalSelected ? `• ${_getEffectiveSku(sku, effectiveOrigBox)} (Original)` : _getEffectiveSku(sku, selectedBox);

        _restoreShippedCell(cell, newShipped);
        try {
          await API.updateOrder(rowId, {
            order_date:    tr.dataset.orderDate,
            quantity_sold: parseInt(tr.dataset.qty, 10),
            platform:      tr.dataset.platform,
            shipped_sku:   newShipped,
            original_sku:  tr.dataset.sku || '',
          });
          tr.dataset.shippedSku = newShipped;
          // Reassignment changes inventory deductions → invalidate canonical KPIs.
          MetricsEngine.invalidate();
          Notify.success('Saved', `Fulfillment SKU: ${prevLabel} → ${nextLabel}`);
        } catch (err) {
          Notify.apiError(err);
          _restoreShippedCell(cell, currentBox);
        }
      });

      if (_activePopover) _activePopover.dataset.rowId = rowId;

    } catch {
      if (trigger) { trigger.style.opacity = ''; trigger.style.pointerEvents = ''; }
      Notify.error('Failed', 'Could not load fulfillment SKU alternatives');
    }
  }

  /* ── Load ────────────────────────────────────────────────── */
  async function load() {
    if (_loading) return;
    _loading = true;

    if (_platforms.length === 0) await _loadPlatforms();

    const tbody = document.getElementById('orders-tbody');
    if (tbody) tbody.innerHTML = Loading.tableRows(COL_COUNT, 8);

    const ps = CONFIG.getPageSize();

    try {
      const data = await API.getOrders(_page, ps, {
        ..._filters,
        sort_by:  _sortBy,
        sort_dir: _sortDir,
      });
      _renderTable(data.items || [], data.total || 0);
    } catch (err) {
      if (tbody) tbody.innerHTML = `<tr><td colspan="${COL_COUNT}">${Loading.error('Failed to load orders')}</td></tr>`;
      Notify.apiError(err);
    } finally {
      _loading = false;
    }
  }

  /* ── Platform select ─────────────────────────────────────── */
  async function _loadPlatforms() {
    const sel = document.getElementById('filter-platform');
    if (!sel) return;
    try {
      _platforms = await API.getPlatforms();
      const opts = _platforms.map(p => `<option value="${Utils.escapeHtml(p)}">${Utils.escapeHtml(p)}</option>`).join('');
      sel.innerHTML = `<option value="">All Platforms</option>${opts}`;
    } catch { /* not critical */ }
  }

  /* ── Filter helpers ──────────────────────────────────────── */
  function _collectFilters() {
    _filters = {};
    const search    = document.getElementById('orders-search')?.value.trim();
    const platform  = document.getElementById('filter-platform')?.value;
    const dateFrom  = document.getElementById('filter-date-from')?.value;
    const dateTo    = document.getElementById('filter-date-to')?.value;
    const statusSel = document.getElementById('filter-order-status');

    if (search)   _filters.search     = search;
    if (platform) _filters.platform   = platform;
    if (dateFrom) _filters.start_date = dateFrom;
    if (dateTo)   _filters.end_date   = dateTo;
    const status = statusSel?.value || 'all';
    if (status !== 'all') _filters.status = status;
  }

  function _resetFilters() {
    ['orders-search', 'filter-platform', 'filter-date-from', 'filter-date-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const statusSel = document.getElementById('filter-order-status');
    if (statusSel) statusSel.value = 'all';
    _filters = {};
    _page = 1;
    App.syncFilterHighlights?.();
    load();
  }

  /* ── Set filter programmatically (from dashboard KPI clicks) */
  function setStatusFilter(status) {
    _filters = {};
    if (status && status !== 'all') _filters.status = status;
    _page = 1;
    const statusSel = document.getElementById('filter-order-status');
    if (statusSel) statusSel.value = status || 'all';
    load();
  }

  /* ── Export — exports exactly what is currently filtered/visible ──
     UI affordance mirrors the SKU View export: a per-click guard
     prevents double-fires, the button swaps to "⏳ Exporting…" while
     the blob is downloading, and the icon + label restore on settle. */
  let _exporting = false;

  async function _doExport() {
    if (_exporting) return;
    _exporting = true;
    const btn = document.getElementById('orders-export');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…'; }
    try {
      const filters = { ..._filters, sort_by: _sortBy, sort_dir: _sortDir };
      const blob = await API.exportOrders(filters);
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `orders-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      Notify.apiError(err);
    } finally {
      _exporting = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="download" class="icon" style="width:14px;height:14px"></i> Export Orders';
        if (window.lucide) lucide.createIcons();
      }
    }
  }

  /* ── Init ────────────────────────────────────────────────── */
  function init() {
    const resetBtn  = document.getElementById('orders-reset-filters');
    const exportBtn = document.getElementById('orders-export');
    const searchEl  = document.getElementById('orders-search');
    const statusSel = document.getElementById('filter-order-status');
    const platSel   = document.getElementById('filter-platform');
    const dateFrom  = document.getElementById('filter-date-from');
    const dateTo    = document.getElementById('filter-date-to');

    if (resetBtn)  resetBtn.addEventListener('click',  _resetFilters);
    if (exportBtn) exportBtn.addEventListener('click', _doExport);
    if (statusSel) statusSel.addEventListener('change', () => { _collectFilters(); _page = 1; load(); });
    if (platSel)   platSel.addEventListener('change',   () => { _collectFilters(); _page = 1; load(); });
    if (dateFrom)  dateFrom.addEventListener('change',  () => { _collectFilters(); _page = 1; load(); });
    if (dateTo)    dateTo.addEventListener('change',    () => { _collectFilters(); _page = 1; load(); });

    if (searchEl) {
      let _debounce;
      searchEl.addEventListener('input', () => {
        clearTimeout(_debounce);
        _debounce = setTimeout(() => { _collectFilters(); _page = 1; load(); }, 300);
      });
      searchEl.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debounce); _collectFilters(); _page = 1; load(); }
      });
    }

    _initSortHeaders();
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    _page      = 1;
    _filters   = {};
    _total     = 0;
    _loading   = false;
    _platforms = [];
    _sortBy    = 'order_date';
    _sortDir   = 'desc';
    const tbody = document.querySelector('#page-orders tbody');
    if (tbody) tbody.innerHTML = '';
    ['orders-search','orders-platform','orders-start-date','orders-end-date','orders-status-filter']
      .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  }

  return { init, load, reset, setStatusFilter };
})();
