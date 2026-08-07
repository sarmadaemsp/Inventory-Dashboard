/* ============================================================
   dashboard.js — Dashboard: KPI cards + analytics charts
   ============================================================ */

const Dashboard = (() => {

  /* ── KPI card field map ──────────────────────────────────────
     Two cards, 50% width each.

     Card 1 (Inventory): Total SKUs + In Stock / OOS / Undefined + Total
     Units / Remaining. Math invariants:
         Total Units = Fulfilled + Remaining
       (Fulfilled lives on Card 2; the inventory card just shows totals
        and the remaining slice.)

     Card 2 (Orders):    Total Orders + Units Sold / Phantom / Fulfilled /
     Wrong Part / Unknown. Math invariant:
         Units Sold (raw) = Fulfilled + Phantom + Unknown
       Wrong Part is a SUBSET of Fulfilled (operator shipped a different
       part/UPC than ordered) — it is informational, NOT additive.
     */
  const KPI_MAP = [
    // [elementId,              dataField,                 colorClass or fn]
    ['kpi-total-skus',         'totalSkus',               null],
    ['kpi-instock-skus',       'inStockSkus',             'green'],
    ['kpi-oos-skus',           'oosSkus',                 d => d > 0 ? 'orange' : null],
    ['kpi-undef-skus',         'undefinedSkus',           d => d > 0 ? 'error'  : null],
    ['kpi-total-units',        'totalUnits',              null],
    ['kpi-remaining',          'physicalRemainingUnits',  'green'],
    ['kpi-total-orders',       'totalOrders',             null],
    ['kpi-orders-units-sold',  'unitsSold',               null],
    ['kpi-phantom',            'phantomUnits',            d => d > 0 ? 'warn'   : null],
    ['kpi-fulfilled',          'actualUnitsSold',         'teal'],
    ['kpi-wrong-part',         'wrongPartUnits',          d => d > 0 ? 'error'  : null],
    ['kpi-unknown-orders',     'unknownOrders',           d => d > 0 ? 'error'  : null],
    ['kpi-unknown-units',      'unknownUnitsSold',        d => d > 0 ? 'error'  : null],
  ];

  /* ── Chart + filter state ────────────────────────────────── */
  let _weeklyChart   = null;
  let _platformChart = null;
  let _mode          = 'wow'; // 'wow' | 'mom'
  let _weeks         = 12;
  let _months        = 6;
  let _platform      = '';

  const PLATFORM_COLORS = ['#2563eb','#16a34a','#d97706','#dc2626','#7c3aed','#0891b2','#db2777','#64748b'];

  // value:0 = "All time" sentinel — backend route accepts weeks=0 and
  // drops the trailing-N-weeks date filter entirely.
  const WOW_RANGES = [
    { value: 4,  label: 'Last 4 weeks'  },
    { value: 8,  label: 'Last 8 weeks'  },
    { value: 12, label: 'Last 12 weeks' },
    { value: 24, label: 'Last 24 weeks' },
    { value: 52, label: 'Last 52 weeks' },
    { value: 0,  label: 'All time'      },
  ];
  const MOM_RANGES = [
    { value: 2,  label: 'Last 2 months'  },
    { value: 4,  label: 'Last 4 months'  },
    { value: 6,  label: 'Last 6 months'  },
    { value: 12, label: 'Last 12 months' },
    { value: 0,  label: 'All time'       },
  ];

  function _weeksParam() {
    if (_mode === 'wow') return _weeks;       // 0 → all-time sentinel
    if (_months === 0)   return 0;            // MoM all-time
    return Math.round(_months * 4.33);
  }

  function _updateRangeSelect() {
    const sel = document.getElementById('dash-range-select');
    if (!sel) return;
    const ranges  = _mode === 'wow' ? WOW_RANGES : MOM_RANGES;
    const current = _mode === 'wow' ? _weeks : _months;
    sel.innerHTML = ranges.map(r =>
      `<option value="${r.value}"${r.value === current ? ' selected' : ''}>${Utils.escapeHtml(r.label)}</option>`
    ).join('');
  }

  /* ── KPI card rendering ─────────────────────────────────── */
  function _renderKPICards(data) {
    const area = document.getElementById('dash-kpi-area');

    if (!data) {
      area?.classList.add('kpi-loading');
      return;
    }

    area?.classList.remove('kpi-loading');

    KPI_MAP.forEach(([elId, field, colorSpec]) => {
      const el  = document.getElementById(elId);
      if (!el) return;
      const val = data[field] ?? null;
      el.textContent = val != null ? Utils.formatNumber(val) : '—';

      // apply / remove color classes
      el.classList.remove('green', 'orange', 'teal', 'warn', 'error');
      const cls = typeof colorSpec === 'function' ? colorSpec(val ?? 0) : colorSpec;
      if (cls) el.classList.add(cls);
    });
  }

  function _wireKPICards() {
    document.querySelectorAll('.kpi-card[data-navigate]').forEach(card => {
      const go = () => App.navigate(card.dataset.navigate);
      card.addEventListener('click', go);
      // The cards have role="button" + tabindex="0" — wire Enter/Space too.
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    });
  }

  /* ── Chart rendering ─────────────────────────────────────── */
  function _populatePlatformSelect(platforms) {
    const sel = document.getElementById('dash-platform-select');
    if (!sel || sel.options.length > 1) return;
    platforms.forEach(p => {
      const opt = document.createElement('option');
      opt.value       = p;
      opt.textContent = p;
      sel.appendChild(opt);
    });
    sel.value = _platform;
  }

  function _renderTrendChart(data) {
    const canvas = document.getElementById('chart-weekly');
    if (!canvas) return;
    if (_weeklyChart) _weeklyChart.destroy();

    let labels, sold, orders;
    if (_mode === 'wow') {
      const weekly = data.weekly || [];
      labels = weekly.map(w => w.week_label || w.week_start || '');
      sold   = weekly.map(w => w.units_sold  || 0);
      orders = weekly.map(w => w.order_count || 0);
    } else {
      // _months === 0 → "All time": show every month the backend returned.
      const monthsAll = data.monthly || [];
      const take      = _months === 0 ? monthsAll.length : _months;
      const monthly   = [...monthsAll].slice(0, take).reverse();
      labels = monthly.map(m => m.month_label || m.month || '');
      sold   = monthly.map(m => m.units_sold  || 0);
      orders = monthly.map(m => m.order_count || 0);
    }

    const titleEl = document.getElementById('chart-trend-title');
    if (titleEl) {
      const isAll = (_mode === 'wow' && _weeks === 0) || (_mode === 'mom' && _months === 0);
      titleEl.textContent = isAll
        ? (_mode === 'wow' ? 'Weekly Sales — All time' : 'Monthly Sales — All time')
        : (_mode === 'wow' ? 'Weekly Sales'             : 'Monthly Sales');
    }

    _weeklyChart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Units Sold',
            data: sold,
            backgroundColor: 'rgba(37,99,235,0.15)',
            borderColor: '#2563eb',
            borderWidth: 2,
            borderRadius: 4,
            yAxisID: 'y',
          },
          {
            label: 'Order Count',
            data: orders,
            type: 'line',
            borderColor: '#16a34a',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#16a34a',
            tension: 0.3,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: true } },
        scales: {
          y:  { position: 'left',  beginAtZero: true, grid: { color: 'rgba(0,0,0,.05)' }, title: { display: true, text: 'Units Sold' } },
          y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false },   title: { display: true, text: 'Orders' } },
        },
      },
    });
  }

  function _renderPlatformChart(platforms) {
    const canvas   = document.getElementById('chart-platform');
    const legendEl = document.getElementById('platform-legend');
    if (!canvas) return;
    if (_platformChart) _platformChart.destroy();

    if (!platforms.length) {
      if (legendEl) legendEl.innerHTML = '<div style="color:var(--txt-4);font-size:13px;padding:12px 0">No platform data</div>';
      return;
    }

    const total = platforms.reduce((s, p) => s + p.units_sold, 0);

    _platformChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels:   platforms.map(p => p.platform),
        datasets: [{
          data:            platforms.map(p => p.units_sold),
          backgroundColor: platforms.map((_, i) => PLATFORM_COLORS[i % PLATFORM_COLORS.length]),
          borderWidth:     3,
          borderColor:     '#fff',
          hoverOffset:     10,
        }],
      },
      options: {
        responsive:          true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => {
                const pct = total > 0 ? Math.round(ctx.parsed / total * 100) : 0;
                return ` ${Utils.formatNumber(ctx.parsed)} units (${pct}%)`;
              },
            },
          },
        },
        cutout: '68%',
      },
    });

    if (legendEl) {
      legendEl.innerHTML = platforms.map((p, i) => {
        const pct   = total > 0 ? Math.round(p.units_sold / total * 100) : 0;
        const color = PLATFORM_COLORS[i % PLATFORM_COLORS.length];
        return `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border)">
            <span style="display:flex;align-items:center;gap:8px">
              <span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0"></span>
              <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(p.platform)}</span>
            </span>
            <span style="display:flex;align-items:center;gap:12px">
              <span style="font-size:12px;color:var(--txt-4);min-width:28px;text-align:right">${pct}%</span>
              <span style="font-size:14px;font-weight:700;color:var(--txt-1);min-width:56px;text-align:right">${Utils.formatNumber(p.units_sold)}</span>
            </span>
          </div>`;
      }).join('');
    }
  }

  /* ── Data loaders ────────────────────────────────────────── */
  async function _loadKPIs() {
    _renderKPICards(null);
    try {
      const kpiData = await MetricsEngine.load();
      _renderKPICards(kpiData);
    } catch (err) {
      document.getElementById('dash-kpi-area')?.classList.remove('kpi-loading');
      Notify.apiError(err);
    }
  }

  function _showChartSkeletons() {
    const trendWrap = document.getElementById('chart-weekly')?.closest('.chart-wrap');
    const platBody  = document.getElementById('chart-platform')?.closest('.dash-platform-body');
    if (trendWrap) trendWrap.innerHTML = `<div class="skel skel-rect" style="width:100%;min-height:220px;border-radius:6px;display:block"></div>`;
    if (platBody)  platBody.innerHTML  = `<div class="skel skel-rect" style="width:100%;min-height:220px;border-radius:6px;display:block"></div>`;
  }

  function _restoreChartContainers() {
    const trendWrap = document.querySelector('.chart-wrap');
    const platBody  = document.querySelector('.dash-platform-body');
    if (trendWrap && !document.getElementById('chart-weekly')) {
      trendWrap.innerHTML = '<canvas id="chart-weekly"></canvas>';
    }
    if (platBody && !document.getElementById('chart-platform')) {
      platBody.innerHTML = `
        <div class="dash-platform-doughnut"><canvas id="chart-platform"></canvas></div>
        <div id="platform-legend" class="dash-platform-legend"></div>`;
    }
  }

  async function _loadCharts() {
    _showChartSkeletons();
    try {
      const [data, platforms] = await Promise.all([
        API.getPerformanceData(_weeksParam(), _platform),
        API.getPlatforms().catch(() => []),
      ]);
      _restoreChartContainers();
      _populatePlatformSelect(platforms);
      _renderTrendChart(data);
      _renderPlatformChart(data.platforms || []);
    } catch (err) {
      _restoreChartContainers();
      Notify.apiError(err);
    }
  }

  async function load() {
    await Promise.all([_loadKPIs(), _loadCharts()]);
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    if (_weeklyChart)   { try { _weeklyChart.destroy(); }   catch {} _weeklyChart = null; }
    if (_platformChart) { try { _platformChart.destroy(); } catch {} _platformChart = null; }
    _mode     = 'wow';
    _weeks    = 12;
    _months   = 6;
    _platform = '';
    // Reset KPI value spans to '—' so we never momentarily show prior org figures.
    document.querySelectorAll('#dash-kpi-area .kpi-card-value, #dash-kpi-area .kpi-sub-value')
      .forEach(el => { el.textContent = '—'; el.classList.remove('green','orange','teal','warn','error'); });
    document.getElementById('dash-kpi-area')?.classList.remove('kpi-loading');
  }

  function init() {
    _wireKPICards();

    const platSel  = document.getElementById('dash-platform-select');
    const rangeSel = document.getElementById('dash-range-select');
    const modeWow  = document.getElementById('dash-mode-wow');
    const modeMom  = document.getElementById('dash-mode-mom');

    _updateRangeSelect();

    if (platSel) platSel.addEventListener('change', e => {
      _platform = e.target.value || '';
      _loadCharts();
    });

    if (rangeSel) rangeSel.addEventListener('change', e => {
      // value="0" is the All-time sentinel — don't fall back to 12 (the `|| 12`
      // bug that 0 is falsy in JS would silently swallow this choice).
      const parsed = parseInt(e.target.value, 10);
      const v = Number.isFinite(parsed) ? parsed : 12;
      if (_mode === 'wow') _weeks = v; else _months = v;
      _loadCharts();
    });

    if (modeWow) modeWow.addEventListener('click', () => {
      if (_mode === 'wow') return;
      _mode = 'wow';
      modeWow.classList.add('active');
      modeMom.classList.remove('active');
      _updateRangeSelect();
      _loadCharts();
    });

    if (modeMom) modeMom.addEventListener('click', () => {
      if (_mode === 'mom') return;
      _mode = 'mom';
      modeMom.classList.add('active');
      modeWow.classList.remove('active');
      _updateRangeSelect();
      _loadCharts();
    });
  }

  return { load, init, reset };
})();
