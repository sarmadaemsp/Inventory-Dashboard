/* ============================================================
   app.js — App router, page navigation, Settings page, Users
            management, System status. Main bootstrap entry point.
   ============================================================ */

/* ── Settings page ──────────────────────────────────────────── */
const Settings = (() => {

  let _usersCache = [];
  let _orgsCache  = [];

  // 3-tier role model: admin / manager / viewer.
  // Clean labels — no descriptive text. Display "View" instead of "Viewer".
  const ROLE_COLOR = { admin: 'error', manager: 'warning', viewer: 'gray' };
  const ROLE_LABEL = {
    admin:   'Admin',
    manager: 'Manager',
    viewer:  'View',
  };

  function _roleOptions(selected = 'viewer') {
    return Object.entries(ROLE_LABEL).map(([v, l]) =>
      `<option value="${v}"${v === selected ? ' selected' : ''}>${Utils.escapeHtml(l)}</option>`
    ).join('');
  }

  /* ── SKU Structure builder v2 (Organizations tab) ──────────
     Segment-aware editor used by both the New / Edit Organization modals.
     Public API:
       _renderSkuStructureSection(struct, { required })  → HTML
       _wireSkuStructureSection(rootEl)                  → attaches listeners
       _readSkuStructureSection(rootEl)                  → v2 structure or null
     The structure object follows the canonical shape documented in
     server/src/utils/skuEngine.js (v2: { version, enabled, separators[],
     segments[], ... }). Legacy v1 input from the server is auto-coerced. */

  const SEGMENT_LABEL = Object.freeze({
    identifier:  'Identifier',
    part_number: 'Part Number',
    upc:         'UPC',
    box:         'Box',
    free_text:   'Free Text',
    wildcard:    'Wildcard',
  });

  // Friendly "Format" options shown to admins instead of raw regex fragments.
  // Each maps to a base regex character class — the segment's stored `pattern`
  // is rebuilt as `<base>+` or `<base>{min,max}` based on the Length inputs.
  // No "Custom regex" entry on purpose: regex syntax is hidden from admins by
  // policy. Unrecognized stored patterns fall back to 'any' on edit and the
  // engine normalizes the pattern next time the admin saves.
  const FORMAT_OPTIONS = Object.freeze([
    { value: 'numeric',      label: 'Numbers only',      base: '\\d'      },
    { value: 'letters',      label: 'Letters only',      base: '[A-Z]'    },
    { value: 'alphanumeric', label: 'Letters & numbers', base: '[A-Z0-9]' },
    { value: 'any',          label: 'Any (non-space)',   base: '[^\\s]'   },
  ]);

  // Extra patterns that should round-trip into the 'any' format on edit (they
  // were emitted by older defaults / by switching segment types around).
  const ANY_PATTERN_ALIASES = new Set([
    '[^\\s]+',
    '[^\\s\\-_]+',
    '.+',
    '.*',
  ]);

  // Friendly placeholders shown in the template preview (e.g. "{Part Number}").
  const SEGMENT_TEMPLATE_PLACEHOLDER = Object.freeze({
    identifier:  '{Identifier}',
    part_number: '{Part Number}',
    upc:         '{UPC}',
    box:         '{Box}',
    free_text:   '{Free Text}',
    wildcard:    '{anything}',
  });

  // Concrete sample values used to render the "Example SKU" line. Identifier
  // pulls from its admin-defined values list; the rest use sensible defaults.
  const SEGMENT_SAMPLE_VALUE = Object.freeze({
    identifier:  'ARA',
    part_number: 'ABC123',
    upc:         '998877',
    box:         '1',
    free_text:   'TEXT',
    wildcard:    'x',
  });

  // Round-trip helper: detect the friendly Format + Length from a stored
  // regex pattern. Lets the segment editor show the right preset when an
  // admin re-opens an existing structure for editing. Unrecognized patterns
  // fall back to 'any' so the dropdown stays user-friendly — the underlying
  // pattern is left alone until the admin actively edits the segment, at
  // which point it gets rebuilt from the friendly inputs.
  function _detectFormatFromPattern(pattern) {
    if (!pattern) return { format: 'numeric', min: '', max: '' };
    if (ANY_PATTERN_ALIASES.has(pattern)) return { format: 'any', min: '', max: '' };
    const tryMatch = (baseEscaped, format) => {
      let m;
      if ((m = pattern.match(new RegExp(`^${baseEscaped}\\+$`))))                  return { format, min: '',   max: '' };
      if ((m = pattern.match(new RegExp(`^${baseEscaped}\\{(\\d+)\\}$`))))        return { format, min: m[1], max: m[1] };
      if ((m = pattern.match(new RegExp(`^${baseEscaped}\\{(\\d+),(\\d+)\\}$`)))) return { format, min: m[1], max: m[2] };
      if ((m = pattern.match(new RegExp(`^${baseEscaped}\\{(\\d+),\\}$`))))       return { format, min: m[1], max: '' };
      return null;
    };
    for (const opt of FORMAT_OPTIONS) {
      if (!opt.base) continue;
      const esc = opt.base.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
      const hit = tryMatch(esc, opt.value);
      if (hit) return hit;
    }
    return { format: 'any', min: '', max: '' };
  }

  // Build a regex fragment from the friendly Format + Length inputs.
  function _patternFromFormat(format, min, max) {
    const opt = FORMAT_OPTIONS.find(o => o.value === format);
    if (!opt || !opt.base) return ''; // custom → caller uses raw pattern
    const minN = parseInt(min, 10);
    const maxN = parseInt(max, 10);
    const hasMin = Number.isFinite(minN) && minN >= 0;
    const hasMax = Number.isFinite(maxN) && maxN >= 0;
    if (hasMin && hasMax) return minN === maxN ? `${opt.base}{${minN}}` : `${opt.base}{${minN},${maxN}}`;
    if (hasMin)           return `${opt.base}{${minN},}`;
    if (hasMax)           return `${opt.base}{1,${maxN}}`;
    return `${opt.base}+`;
  }

  // Per-segment "Separator before" options. '' = concatenate directly (no
  // separator). The first segment ignores this field — there's nothing
  // preceding it. Listed in the dropdown shown on segment rows 2..N.
  const SEPARATOR_OPTIONS = Object.freeze([
    { value: '-',  label: 'Hyphen ( - )'      },
    { value: '_',  label: 'Underscore ( _ )'  },
    { value: '.',  label: 'Dot ( . )'         },
    { value: '/',  label: 'Slash ( / )'       },
    { value: ' ',  label: 'Space ( ␣ )'       },
    { value: '',   label: 'None (concatenate)' },
  ]);

  function _defaultSegmentForType(type) {
    const seg = { id: `seg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, type, required: true, values: null, pattern: null, prefix_separator: '-', allow_attached_box: false };
    if (type === 'identifier')  { seg.values = ['ARA']; seg.allow_attached_box = true; }
    if (type === 'part_number') { seg.pattern = '[A-Z0-9]+'; }      // "Letters & numbers"
    if (type === 'upc')         { seg.pattern = '\\d+';     }       // "Numbers only"
    if (type === 'box')         { seg.pattern = '\\d+';     }       // "Numbers only"
    if (type === 'free_text')   { seg.pattern = '[^\\s]+';  }       // "Any (non-space)" — clean form
    if (type === 'wildcard')    { seg.required = false; }
    return seg;
  }

  function _defaultStructure() {
    return {
      version:          2,
      enabled:          true,
      case_insensitive: true,
      separators:       ['-'],
      segments: [
        _defaultSegmentForType('identifier'),
        _defaultSegmentForType('part_number'),
        _defaultSegmentForType('upc'),
      ],
    };
  }

  function _renderSegmentRow(seg, idx) {
    const typeOpts = SkuEngine.SEGMENT_TYPES.map(t =>
      `<option value="${t}"${t === seg.type ? ' selected' : ''}>${Utils.escapeHtml(SEGMENT_LABEL[t] || t)}</option>`
    ).join('');

    // Per-type detail control.
    //   identifier → comma-separated values + attached-box toggle
    //   wildcard   → no extra inputs (matches anything by definition)
    //   other      → friendly Format dropdown + Length min/max, regex hidden
    //                behind Format = "Custom regex…"
    let detail = '';
    if (seg.type === 'identifier') {
      detail = `
        <input class="form-input" data-seg-values
          value="${Utils.escapeHtml((seg.values || []).join(', '))}"
          placeholder="ARA, BX"
          title="Allowed identifier values (comma-separated)"
          style="font-family:monospace">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--txt-3);margin-top:4px;cursor:pointer;white-space:nowrap">
          <input type="checkbox" data-seg-attach${seg.allow_attached_box ? ' checked' : ''} style="accent-color:var(--primary)">
          <span>Allow attached box (ARA1 ≡ ARA-1)</span>
        </label>`;
    } else if (seg.type === 'wildcard') {
      detail = `<div class="form-hint" style="font-family:var(--font-body);font-size:11.5px;font-weight:400;padding:8px 0">Matches anything in this position.</div>`;
    } else {
      const { format, min, max } = _detectFormatFromPattern(seg.pattern);
      const fmtOpts = FORMAT_OPTIONS.map(o =>
        `<option value="${o.value}"${o.value === format ? ' selected' : ''}>${Utils.escapeHtml(o.label)}</option>`
      ).join('');
      detail = `
        <div style="display:grid;grid-template-columns:1fr 80px 80px;gap:8px;align-items:center">
          <select class="form-select" data-seg-format style="font-family:var(--font-body);font-size:13px;font-weight:500;padding:7px 10px">${fmtOpts}</select>
          <input class="form-input" data-seg-min type="number" min="0" placeholder="Min" value="${Utils.escapeHtml(String(min))}"
                 style="font-family:var(--font-body);font-size:13px;font-weight:500;padding:7px 10px;text-align:center" title="Minimum length (optional)">
          <input class="form-input" data-seg-max type="number" min="0" placeholder="Max" value="${Utils.escapeHtml(String(max))}"
                 style="font-family:var(--font-body);font-size:13px;font-weight:500;padding:7px 10px;text-align:center" title="Maximum length (optional)">
        </div>
        <div class="form-hint" style="font-family:var(--font-body);font-size:11px;font-weight:400;margin-top:6px;color:var(--txt-4)">
          Leave Min/Max empty for any length. Identical Min and Max means exact length.
        </div>`;
    }

    // Per-segment "Separator before" — only shown for non-first segments.
    // Identifier-attached-box still makes the identifier→box gap optional,
    // but the literal character chosen here is what appears in valid SKUs.
    let separatorRow = '';
    if (idx > 0) {
      const currentSep = typeof seg.prefix_separator === 'string' ? seg.prefix_separator : '-';
      const sepOpts = SEPARATOR_OPTIONS.map(o =>
        `<option value="${Utils.escapeHtml(o.value)}"${o.value === currentSep ? ' selected' : ''}>${Utils.escapeHtml(o.label)}</option>`
      ).join('');
      separatorRow = `
        <div data-seg-separator-row
             style="grid-column:1 / -1;display:flex;align-items:center;gap:8px;margin:-2px 0 4px;padding:6px 10px;background:var(--surface-2);border:1px dashed var(--border);border-radius:var(--r-sm)">
          <span style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--txt-4)">Separator before</span>
          <select class="form-select" data-seg-separator style="flex:1;max-width:220px;font-size:12px;padding:5px 8px">${sepOpts}</select>
          <span style="font-size:11px;color:var(--txt-4)">Choose how this segment connects to the previous one.</span>
        </div>`;
    }

    return `
      <div class="sku-seg-row" data-seg-id="${Utils.escapeHtml(seg.id)}"
           style="display:grid;grid-template-columns:24px 130px 1fr auto;gap:8px;align-items:start;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm)">
        ${separatorRow}
        <div data-seg-index style="font-size:11px;font-weight:700;color:var(--txt-4);padding-top:8px;text-align:center">${idx + 1}</div>
        <div>
          <select class="form-select" data-seg-type style="font-size:12px;padding:6px 8px">${typeOpts}</select>
          <label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--txt-3);margin-top:4px;cursor:pointer">
            <input type="checkbox" data-seg-required${seg.required ? ' checked' : ''} style="accent-color:var(--primary)">
            <span>Required</span>
          </label>
        </div>
        <div data-seg-detail>${detail}</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          <button type="button" class="btn btn-ghost btn-sm" data-seg-up    title="Move up"     style="padding:2px 6px">↑</button>
          <button type="button" class="btn btn-ghost btn-sm" data-seg-down  title="Move down"   style="padding:2px 6px">↓</button>
          <button type="button" class="btn btn-ghost btn-sm" data-seg-del   title="Remove"      style="padding:2px 6px;color:var(--error)">×</button>
        </div>
      </div>`;
  }

  // Resolve the literal separator that goes BEFORE segment[i]. The first
  // segment never has one. Per-segment prefix_separator wins; structure-level
  // separators[0] is the fallback for legacy stored configs that pre-date the
  // per-segment field.
  function _resolveSepBefore(structure, i) {
    if (i <= 0) return '';
    const seg = structure.segments[i];
    if (typeof seg?.prefix_separator === 'string') return seg.prefix_separator;
    const legacy = (structure.separators || []).filter(s => s !== '');
    return legacy[0] || '-';
  }

  // Build the friendly "ARA · {Box} · {Part Number} · {UPC}" template line.
  // Each transition uses its own separator so admins can preview mixed shapes
  // like "ARA1_12345-998877" or fully concatenated SKUs like "ARA112345998877".
  function _buildStructureTemplate(structure) {
    const segs = Array.isArray(structure.segments) ? structure.segments : [];
    if (!segs.length) return '';
    return segs.map((seg, i) => {
      const open  = seg.required === false ? '[' : '';
      const close = seg.required === false ? ']' : '';
      const sep   = i === 0 ? '' : _resolveSepBefore(structure, i);
      const sepDisplay = sep === '' ? '' : ` ${sep} `;
      let label;
      if (seg.type === 'identifier') {
        const vals = (seg.values || []).filter(Boolean);
        if (vals.length === 1)      label = vals[0];
        else if (vals.length > 1)   label = `(${vals.join('|')})`;
        else                        label = SEGMENT_TEMPLATE_PLACEHOLDER.identifier;
      } else {
        label = SEGMENT_TEMPLATE_PLACEHOLDER[seg.type] || '{?}';
      }
      return `${sepDisplay}${open}${label}${close}`;
    }).join('');
  }

  // Build a concrete example SKU using each segment's literal separator and a
  // sensible sample value per segment type.
  function _buildStructureSample(structure) {
    const segs = Array.isArray(structure.segments) ? structure.segments : [];
    if (!segs.length) return '';
    return segs.map((seg, i) => {
      const sep = i === 0 ? '' : _resolveSepBefore(structure, i);
      let value;
      if (seg.type === 'identifier') {
        const vals = (seg.values || []).filter(Boolean);
        value = vals[0] || SEGMENT_SAMPLE_VALUE.identifier;
      } else {
        value = SEGMENT_SAMPLE_VALUE[seg.type] || 'X';
      }
      // Suppress sep when allow_attached_box collapses identifier→box visually.
      const prev = i > 0 ? segs[i - 1] : null;
      const attached = prev?.type === 'identifier' && prev.allow_attached_box && seg.type === 'box';
      return `${attached ? '' : sep}${value}`;
    }).join('');
  }

  function _renderSkuStructureSection(struct, { required = false } = {}) {
    const v2 = SkuEngine.coerceToV2(struct);
    // If the incoming structure was empty but the section is mandatory,
    // start with a sensible template so the admin sees concrete segments.
    const useStruct = (v2.segments?.length || !required) ? v2 : _defaultStructure();
    const segments  = useStruct.segments?.length ? useStruct.segments : _defaultStructure().segments;

    return `
      <div class="form-group" data-sku-structure
           data-required="${required ? '1' : '0'}"
           data-segments='${Utils.escapeHtml(JSON.stringify(segments))}'>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
          <label class="form-label" style="margin:0;font-family:var(--font-title);font-weight:700;font-size:15px;color:var(--txt-1)">
            SKU Structure ${required ? '<span class="req">*</span>' : ''}
          </label>
          <label style="display:inline-flex;align-items:center;gap:6px;font-family:var(--font-body);font-size:12.5px;font-weight:500;color:var(--txt-3);cursor:pointer">
            <input type="checkbox" data-sku-enabled${useStruct.enabled !== false ? ' checked' : ''} style="accent-color:var(--primary)">
            <span>Enable validation</span>
          </label>
        </div>
        <div class="form-hint" style="margin-bottom:10px;font-family:var(--font-body);font-weight:400">
          Add segments in order. Any inventory row whose SKU does not match counts as <strong style="font-weight:600">Undefined</strong> across the whole app.
        </div>

        <div style="display:grid;grid-template-columns:1fr 220px;gap:12px;margin-bottom:10px;align-items:end">
          <div class="form-hint" style="font-family:var(--font-body);font-size:12px;font-weight:400;line-height:1.55;padding:0">
            Each segment below has its own <strong style="font-weight:600">Separator before</strong> control — pick a hyphen, underscore, dot, or <em style="font-style:normal;font-weight:600">None</em> to concatenate. Mix and match to build any SKU shape.
          </div>
          <div>
            <label class="form-label" style="font-family:var(--font-body);font-size:11.5px;font-weight:600">Case</label>
            <select class="form-select" data-sku-case style="font-family:var(--font-body);font-size:13px;padding:7px 10px">
              <option value="ci"${useStruct.case_insensitive !== false ? ' selected' : ''}>Case-insensitive</option>
              <option value="cs"${useStruct.case_insensitive === false ? ' selected' : ''}>Case-sensitive</option>
            </select>
          </div>
        </div>

        <div data-sku-segments style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px"></div>
        <button type="button" class="btn btn-secondary btn-sm" data-sku-add-seg style="font-family:var(--font-body);font-size:12.5px;font-weight:500">+ Add segment</button>

        <div style="margin-top:14px;padding:14px 16px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm)">
          <div style="font-family:var(--font-body);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--txt-4);margin-bottom:6px">Your SKU structure</div>
          <div data-sku-template style="font-family:var(--font-title);font-size:15px;font-weight:700;color:var(--primary-text);word-break:break-all;min-height:22px;line-height:1.45">—</div>

          <div style="font-family:var(--font-body);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--txt-4);margin:14px 0 6px">Example</div>
          <div data-sku-sample style="font-family:var(--font-body);font-size:14px;font-weight:500;color:var(--txt-2);min-height:18px;letter-spacing:.01em">—</div>

          <div style="display:flex;align-items:center;gap:8px;margin-top:16px">
            <input class="form-input" data-sku-test placeholder="Paste a SKU to test, e.g. ARA1-12345-998877" style="flex:1;font-family:var(--font-body);font-weight:500">
            <span data-sku-test-result style="font-family:var(--font-body);font-size:13px;font-weight:600;white-space:nowrap;min-width:100px;text-align:right">—</span>
          </div>
          <div data-sku-breakdown style="margin-top:8px;font-family:var(--font-body);font-size:12px;font-weight:400;color:var(--txt-3);min-height:14px"></div>
        </div>
      </div>`;
  }

  // Read just the raw shape — used for the live preview while editing.
  // Each segment row carries its own prefix_separator dropdown (rows 2..N);
  // the per-type detail area is either the friendly Format/Length pair or
  // a custom regex textbox.
  function _readSkuStructureFromInputs(rootEl) {
    if (!rootEl) return null;
    const get = sel => rootEl.querySelector(sel);
    const enabled  = Boolean(get('[data-sku-enabled]')?.checked);
    const caseMode = get('[data-sku-case]')?.value || 'ci';

    const segments = Array.from(rootEl.querySelectorAll('.sku-seg-row')).map((row, idx) => {
      const id       = row.dataset.segId;
      const type     = row.querySelector('[data-seg-type]').value;
      const required = Boolean(row.querySelector('[data-seg-required]')?.checked);
      const seg = { id, type, required, values: null, pattern: null, allow_attached_box: false };

      // prefix_separator only applies from segment 2 onward. The dropdown's
      // value is the literal char (including '' for "concatenate").
      if (idx > 0) {
        const sepEl = row.querySelector('[data-seg-separator]');
        seg.prefix_separator = sepEl ? sepEl.value : '-';
      }

      if (type === 'identifier') {
        const valStr = row.querySelector('[data-seg-values]')?.value || '';
        seg.values = valStr.split(',').map(v => v.trim()).filter(Boolean);
        seg.allow_attached_box = Boolean(row.querySelector('[data-seg-attach]')?.checked);
      } else if (type === 'wildcard') {
        seg.pattern = null;
      } else {
        // Pattern is always rebuilt from the friendly Format + Length inputs
        // — there is no raw-regex field to read from (admins never see regex).
        const format = row.querySelector('[data-seg-format]')?.value || 'any';
        const min    = row.querySelector('[data-seg-min]')?.value || '';
        const max    = row.querySelector('[data-seg-max]')?.value || '';
        seg.pattern = _patternFromFormat(format, min, max);
      }
      return seg;
    });

    return { version: 2, enabled, case_insensitive: caseMode === 'ci', segments };
  }

  // Read + normalize for sending to the API. Returns null when the section
  // is disabled or has no valid segments — server treats null as cleared.
  function _readSkuStructureSection(rootEl) {
    const raw = _readSkuStructureFromInputs(rootEl);
    if (!raw) return null;
    const v2 = SkuEngine.coerceToV2(raw);
    if (!v2.enabled || !v2.segments?.length) return null;
    return v2;
  }

  function _renderSegmentList(rootEl) {
    const segs = JSON.parse(rootEl.dataset.segments || '[]');
    const listEl = rootEl.querySelector('[data-sku-segments]');
    listEl.innerHTML = segs.map((s, i) => _renderSegmentRow(s, i)).join('');
  }

  // Re-snapshot the current input values back into rootEl.dataset.segments so
  // re-render keeps the user's edits.
  function _snapshotSegments(rootEl) {
    const segs = _readSkuStructureFromInputs(rootEl)?.segments || [];
    rootEl.dataset.segments = JSON.stringify(segs);
  }

  function _wireSkuStructureSection(rootEl) {
    if (!rootEl) return;
    const templateEl = rootEl.querySelector('[data-sku-template]');
    const sampleEl   = rootEl.querySelector('[data-sku-sample]');
    const testEl     = rootEl.querySelector('[data-sku-test]');
    const resultEl   = rootEl.querySelector('[data-sku-test-result]');
    const breakdown  = rootEl.querySelector('[data-sku-breakdown]');

    const refresh = () => {
      const struct = SkuEngine.coerceToV2(_readSkuStructureFromInputs(rootEl));

      // Friendly template + concrete example. The compiled regex is computed
      // internally and used by the engine, but it is NEVER surfaced to the
      // admin — regex syntax is intentionally hidden from non-technical users.
      if (!struct.enabled) {
        templateEl.textContent = 'Validation disabled';
        templateEl.style.color = 'var(--txt-4)';
        sampleEl.textContent   = '—';
      } else if (!struct.segments?.length) {
        templateEl.textContent = 'Add at least one segment.';
        templateEl.style.color = 'var(--warning)';
        sampleEl.textContent   = '—';
      } else {
        templateEl.textContent = _buildStructureTemplate(struct);
        templateEl.style.color = 'var(--primary-text)';
        sampleEl.textContent   = _buildStructureSample(struct);
      }

      // Test-SKU result and parsed breakdown.
      const sku = testEl?.value || '';
      if (!sku.trim()) {
        resultEl.textContent = '—';
        resultEl.style.color = 'var(--txt-4)';
        breakdown.textContent = '';
      } else {
        const res = SkuEngine.parseSku(sku, struct);
        if (res.valid) {
          resultEl.textContent = '✓ Valid';
          resultEl.style.color = 'var(--success)';
          breakdown.innerHTML = res.segments.length
            ? `Parsed: ${res.segments.map(s => `<strong>${Utils.escapeHtml(s.value)}</strong> <span style="color:var(--txt-4)">(${SEGMENT_LABEL[s.type] || s.type})</span>`).join(' &middot; ')}`
            : `Normalized: <code>${Utils.escapeHtml(res.normalized)}</code>`;
        } else {
          resultEl.textContent = res.reason === 'empty_or_placeholder' ? '✗ Placeholder' : '✗ Mismatch';
          resultEl.style.color = 'var(--error)';
          breakdown.textContent = res.reason === 'empty_or_placeholder'
            ? 'Empty / NA / #N/A placeholder.'
            : 'Does not match the configured SKU structure.';
        }
      }
    };

    // Attach listeners on the section's inputs/buttons. Delegated so newly
    // added segment rows pick them up automatically.
    rootEl.addEventListener('input',   refresh);
    rootEl.addEventListener('change',  refresh);

    rootEl.addEventListener('click', (e) => {
      const row = e.target.closest('.sku-seg-row');
      if (e.target.matches('[data-sku-add-seg]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments);
        segs.push(_defaultSegmentForType('free_text'));
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl);
        refresh();
        return;
      }
      if (!row) return;
      if (e.target.matches('[data-seg-del]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments).filter(s => s.id !== row.dataset.segId);
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl); refresh();
        return;
      }
      if (e.target.matches('[data-seg-up]') || e.target.matches('[data-seg-down]')) {
        _snapshotSegments(rootEl);
        const segs = JSON.parse(rootEl.dataset.segments);
        const idx  = segs.findIndex(s => s.id === row.dataset.segId);
        const delta = e.target.matches('[data-seg-up]') ? -1 : 1;
        const tgt = idx + delta;
        if (tgt < 0 || tgt >= segs.length) return;
        [segs[idx], segs[tgt]] = [segs[tgt], segs[idx]];
        rootEl.dataset.segments = JSON.stringify(segs);
        _renderSegmentList(rootEl); refresh();
      }
    });

    // Re-render segment row when its type changes — and reset the pattern to
    // the new type's default. Without the reset, a segment that switches from
    // "Free Text" to "Box" would keep the free-text regex, which then shows
    // up as the wrong Format preset on the next render.
    rootEl.addEventListener('change', (e) => {
      if (!e.target.matches('[data-seg-type]')) return;
      const row = e.target.closest('.sku-seg-row');
      if (!row) return;
      const newType = e.target.value;
      _snapshotSegments(rootEl);
      const segs = JSON.parse(rootEl.dataset.segments).map(s =>
        s.id === row.dataset.segId
          ? { ...s, ..._defaultSegmentForType(newType), id: s.id, prefix_separator: s.prefix_separator }
          : s
      );
      rootEl.dataset.segments = JSON.stringify(segs);
      _renderSegmentList(rootEl);
      refresh();
    });

    _renderSegmentList(rootEl);
    refresh();
  }

  /* ── Users: load ────────────────────────────────────────── */
  // Global list (Settings is org-neutral). Columns:
  //   Name | Username | Role (global) | Organizations (dropdown) | Actions (Edit)
  async function loadUsers() {
    const tbody = document.getElementById('users-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(5, 5);
    try {
      const users  = await API.getUsers();
      _usersCache  = users;
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('users', 'No users yet', 'Add a new user to get started')}</td></tr>`;
        return;
      }
      const myUserId = Auth.getUser()?.user_id;
      tbody.innerHTML = users.map(u => {
        const uid       = Utils.escapeHtml(u.user_id || '');
        const dname     = Utils.escapeHtml(u.display_name || u.username || '?');
        const initial   = (u.display_name || u.username || '?')[0].toUpperCase();
        const isSelf    = u.user_id === myUserId;
        const isActive  = u.is_active !== false;
        const role      = u.role || 'viewer';
        const roleLabel = ROLE_LABEL[role] || Utils.capitalize(role);

        const memberships = Array.isArray(u.memberships) ? u.memberships : [];
        // Button + JS-positioned popover. The popover uses position:fixed so
        // it escapes the .table-wrap overflow:auto that would otherwise clip
        // a position:absolute dropdown. Click anywhere outside to close.
        const orgNamesAttr = Utils.escapeHtml(JSON.stringify(memberships.map(m => m.org_name || m.organization_id)));
        const orgsHtml = memberships.length === 0
          ? `<span style="font-size:12px;color:var(--txt-4);font-style:italic">No memberships</span>`
          : `<button type="button" class="user-orgs-trigger" data-orgs-popover='${orgNamesAttr}'>
               <span>${memberships.length} ${memberships.length === 1 ? 'organization' : 'organizations'}</span>
               <i data-lucide="chevron-down" class="icon user-orgs-chevron" aria-hidden="true"></i>
             </button>`;

        const inactiveTag = isActive ? '' : '<span class="user-inactive-tag" title="Account is deactivated">DEACTIVATED</span>';

        return `<tr data-user-id="${uid}"${!isActive ? ' class="user-row-inactive"' : ''}>
          <td>
            <div style="display:flex;align-items:center;gap:8px">
              <div class="user-avatar-sm">${initial}</div>
              <span style="font-weight:500">${dname}</span>
              ${isSelf ? '<span class="user-self-tag">You</span>' : ''}
              ${inactiveTag}
            </div>
          </td>
          <td><span style="font-size:12px;color:var(--txt-3);font-family:monospace">@${Utils.escapeHtml(u.username || '—')}</span></td>
          <td><span class="user-role-text">${Utils.escapeHtml(roleLabel)}</span></td>
          <td>${orgsHtml}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="edit-user" data-id="${uid}" title="Edit user">
              <i data-lucide="pencil" class="icon" style="width:13px;height:13px"></i> Edit
            </button>
          </td>
        </tr>`;
      }).join('');
      _wireOrgsPopover();
      Icons?.refresh?.();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load users')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Users: add new ─────────────────────────────────────── */
  async function _openAddNewUserModal() {
    // Fetch the full org list up-front. Settings is org-neutral — we do NOT
    // pre-select the admin's current workspace. The admin chooses explicitly.
    let allOrgs = [];
    try {
      allOrgs = await API.getOrganizations();
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const assignableOrgs = (allOrgs || []).filter(o => o.is_active);

    const m = new Modal({ title: 'Add New User', maxWidth: '480px' });
    m.setBody(`
      <form data-form="user" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="display" placeholder="Full name" autocomplete="off">
        </div>

        <div class="form-group">
          <label class="form-label">Username <span class="req">*</span></label>
          <input class="form-input" data-field="username" placeholder="login handle (e.g. john_doe)" autocomplete="off">
          <div class="form-hint">Unique across the platform. 2–32 chars: lowercase letters, numbers, underscores.</div>
          <div data-field="username-status" style="margin-top:6px;font-size:12px;display:none"></div>
        </div>

        <div class="form-group">
          <label class="form-label">Password <span class="req">*</span></label>
          <input class="form-input" data-field="password" type="password" placeholder="Minimum 8 characters" autocomplete="new-password">
        </div>

        <div class="form-group">
          <label class="form-label">Role <span class="req">*</span></label>
          <select class="form-select" data-field="role">${_roleOptions('viewer')}</select>
          <div class="form-hint">Applied to every assigned organization.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Organizations <span class="req">*</span></label>
          <div class="multiselect" data-field="orgs" data-ms-noun="organizations" data-ms-placeholder="Select organizations…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select organizations…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${assignableOrgs.length === 0
                ? '<div class="multiselect-empty">No active organizations available.</div>'
                : assignableOrgs.map(o => `
                  <label class="multiselect-option">
                    <input type="checkbox" value="${Utils.escapeHtml(o.organization_id)}">
                    <span class="multiselect-option-name">${Utils.escapeHtml(o.display_name)}</span>
                  </label>`).join('')}
            </div>
          </div>
          <div class="form-hint">Assign the user to at least one organization. Roles apply across all selected orgs.</div>
        </div>

        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="save">Create User</button>`);
    m.show();

    // CRITICAL: scope all lookups to the modal's body/footer. Multiple modals
    // can coexist in the DOM (Modal.hide() doesn't remove them), so global
    // document.getElementById would return the FIRST match — usually a stale
    // ghost from a previous modal. Querying inside the live modal's own
    // elements avoids that entirely.
    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);

    // Destroy on hide so we don't accumulate duplicate-ID nodes.
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="save"]')?.addEventListener('click', () => _doCreateUser(m, q, qf));
    q('[data-form="user"]')?.addEventListener('submit', e => { e.preventDefault(); _doCreateUser(m, q, qf); });

    _wireUsernameCheck(q);
    _wireMultiselect(q('[data-field="orgs"]'));
  }

  // Multi-select dropdown: click-to-open, position:fixed panel with checkboxes.
  // The panel overlays surrounding content (does NOT grow the form), so opening
  // it never reflows the modal layout. JS computes the trigger's viewport
  // coordinates and anchors the panel below it (or flipped above if it'd run
  // off the viewport).
  //
  // Noun for the label is taken from `data-ms-noun` on the root.
  function _wireMultiselect(root) {
    if (!root) return;
    const trigger = root.querySelector('[data-ms-trigger]');
    const panel   = root.querySelector('[data-ms-panel]');
    const label   = root.querySelector('[data-ms-label]');
    if (!trigger || !panel || !label) return;

    const noun = root.dataset.msNoun || 'items';
    const placeholder = root.dataset.msPlaceholder || `Select ${noun}…`;

    const updateLabel = () => {
      const checked = Array.from(panel.querySelectorAll('input[type=checkbox]:checked'));
      if (!checked.length) {
        label.textContent = placeholder;
        label.classList.remove('multiselect-label-active');
        return;
      }
      label.classList.add('multiselect-label-active');
      const names = checked.map(cb => cb.closest('.multiselect-option')?.querySelector('.multiselect-option-name')?.textContent || '');
      label.textContent = checked.length === 1
        ? names[0]
        : `${checked.length} ${noun} selected`;
    };

    // Position the panel using fixed coordinates derived from the trigger's
    // viewport rect. Re-run on every open + on scroll/resize while open.
    const positionPanel = () => {
      const rect = trigger.getBoundingClientRect();
      const panelWidth = rect.width;             // match trigger width
      panel.style.width = `${panelWidth}px`;
      const panelHeight = Math.min(260, panel.scrollHeight || 260);
      let top = rect.bottom + 6;
      // Flip above if it would clip the viewport bottom.
      if (top + panelHeight > window.innerHeight - 8) {
        top = Math.max(8, rect.top - panelHeight - 6);
      }
      panel.style.top  = `${top}px`;
      panel.style.left = `${rect.left}px`;
    };

    const open  = () => {
      positionPanel();
      root.classList.add('is-open');
    };
    const close = () => root.classList.remove('is-open');
    const toggle = () => (root.classList.contains('is-open') ? close() : open());

    trigger.addEventListener('click', e => { e.stopPropagation(); toggle(); });
    panel.addEventListener('click', e => e.stopPropagation());
    panel.addEventListener('change', e => {
      if (e.target?.matches('input[type=checkbox]')) updateLabel();
    });

    // Close on outside click or Esc.
    document.addEventListener('click', e => {
      if (!root.contains(e.target) && !panel.contains(e.target)) close();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
    });

    // Reposition (or close) on viewport changes while open so the panel
    // stays anchored to its trigger.
    window.addEventListener('scroll',  () => { if (root.classList.contains('is-open')) positionPanel(); }, true);
    window.addEventListener('resize',  () => { if (root.classList.contains('is-open')) positionPanel(); });

    updateLabel();
  }

  // Tracks the last username verified as available. Submit is blocked unless
  // the typed value matches this exactly.
  let _validatedUsername = null;

  function _wireUsernameCheck(q) {
    const input    = q('[data-field="username"]');
    const statusEl = q('[data-field="username-status"]');
    if (!input || !statusEl) {
      console.warn('[username-check] could not find input/status inside modal');
      return;
    }

    let timer = null;
    let seq   = 0;

    const setStatus = (html, color) => {
      statusEl.innerHTML     = html;
      statusEl.style.color   = color || 'var(--txt-3)';
      statusEl.style.display = html ? 'block' : 'none';
    };

    const onChange = () => {
      clearTimeout(timer);
      const raw = input.value.trim().toLowerCase();
      _validatedUsername = null;

      if (!raw) { setStatus('', ''); return; }
      if (raw.length < 2) {
        setStatus('Username must be at least 2 characters.', 'var(--warning)');
        return;
      }
      setStatus(`<span style="opacity:.7">Checking availability…</span>`, 'var(--txt-3)');

      const mySeq = ++seq;
      timer = setTimeout(async () => {
        try {
          const res = await API.checkUsername(raw);
          if (mySeq !== seq) return;
          if (!res.valid) {
            setStatus(`✗ Invalid: must be 2–32 chars, lowercase letters/numbers/underscores only.`, 'var(--error)');
          } else if (res.available) {
            _validatedUsername = res.username;
            setStatus(`✓ <strong>${Utils.escapeHtml(res.username)}</strong> is available.`, 'var(--success)');
          } else {
            const sugs = (res.suggestions || []).slice(0, 5);
            const sugHtml = sugs.length
              ? ` Try: ${sugs.map(s => `<a href="#" data-suggest="${Utils.escapeHtml(s)}" style="color:var(--primary);font-weight:600;text-decoration:underline;margin-right:8px">${Utils.escapeHtml(s)}</a>`).join('')}`
              : '';
            setStatus(`✗ <strong>${Utils.escapeHtml(res.username)}</strong> is taken.${sugHtml}`, 'var(--error)');
            statusEl.querySelectorAll('[data-suggest]').forEach(a => {
              a.addEventListener('click', e => {
                e.preventDefault();
                input.value = a.dataset.suggest;
                onChange();
              });
            });
          }
        } catch (err) {
          if (mySeq !== seq) return;
          const msg = err.status === 404
            ? 'Username check endpoint not available — backend needs redeploy.'
            : (err.message || 'try again');
          setStatus(`<span style="color:var(--txt-4)">Could not verify — ${Utils.escapeHtml(msg)}</span>`, '');
        }
      }, 350);
    };

    input.addEventListener('input', onChange);
  }

  async function _doCreateUser(m, q, qf) {
    const display  = q('[data-field="display"]')?.value.trim();
    const username = q('[data-field="username"]')?.value.trim().toLowerCase();
    const password = q('[data-field="password"]')?.value;
    const role     = q('[data-field="role"]')?.value;
    const orgIds   = Array.from(q('[data-field="orgs"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const errEl    = q('[data-field="error"]');
    const saveBtn  = qf('[data-action="save"]');
    const showErr  = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display)                          return showErr('Display name is required.');
    if (!username)                         return showErr('Username is required.');
    if (_validatedUsername !== username)   return showErr('Please wait for the username availability check to finish, or pick a different username.');
    if (!password || password.length < 8)  return showErr('Password must be at least 8 characters.');
    if (!role)                             return showErr('Please select a role.');
    if (!orgIds.length)                    return showErr('Assign the user to at least one organization.');

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.createUser({
        display_name:      display,
        username,
        password,
        role,
        organization_ids:  orgIds,
      });
      Notify.success('User created', `${display} has been added to ${orgIds.length} organization${orgIds.length > 1 ? 's' : ''}.`);
      m.hide();
      m.destroy();
      loadUsers();
    } catch (err) {
      const msg = err.status === 404
        ? 'Server endpoint not found — backend needs to be redeployed.'
        : (err.message || 'Failed to create user.');
      showErr(msg);
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  // Singleton popover element for the Users table's "N organizations"
  // dropdown. Uses position:fixed so it isn't clipped by the .table-wrap
  // overflow that the row sits inside.
  let _orgsPopoverEl = null;

  function _closeOrgsPopover() {
    if (_orgsPopoverEl) { _orgsPopoverEl.remove(); _orgsPopoverEl = null; }
  }

  function _wireOrgsPopover() {
    document.querySelectorAll('[data-orgs-popover]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const wasOpen = btn.classList.contains('is-open');
        document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
        _closeOrgsPopover();
        if (wasOpen) return;

        let names = [];
        try { names = JSON.parse(btn.dataset.orgsPopover) || []; } catch {}
        if (!names.length) return;

        const pop = document.createElement('div');
        pop.className = 'user-orgs-popover';
        pop.innerHTML = `<ul>${names.map(n => `<li>${Utils.escapeHtml(n)}</li>`).join('')}</ul>`;
        document.body.appendChild(pop);

        // Position relative to the button using viewport coords (fixed).
        const rect = btn.getBoundingClientRect();
        const popRect = pop.getBoundingClientRect();
        let top  = rect.bottom + 4;
        let left = rect.left;
        // If it would clip the bottom of the viewport, flip above the button.
        if (top + popRect.height > window.innerHeight - 8) {
          top = Math.max(8, rect.top - popRect.height - 4);
        }
        // Keep within the right edge.
        if (left + popRect.width > window.innerWidth - 8) {
          left = Math.max(8, window.innerWidth - popRect.width - 8);
        }
        pop.style.top  = `${top}px`;
        pop.style.left = `${left}px`;

        btn.classList.add('is-open');
        _orgsPopoverEl = pop;
      });
    });

    // One outside-click handler is enough — re-bind on every render is fine
    // because we replace the listener target each time.
    document.addEventListener('click', _onDocClickForOrgs, { once: true, capture: false });
  }

  function _onDocClickForOrgs(e) {
    if (_orgsPopoverEl && !_orgsPopoverEl.contains(e.target) && !e.target.closest('[data-orgs-popover]')) {
      document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
      _closeOrgsPopover();
    }
    document.addEventListener('click', _onDocClickForOrgs, { once: true });
  }

  // Close popover on scroll (otherwise it floats over content as the table scrolls).
  document.addEventListener('scroll', () => {
    if (_orgsPopoverEl) {
      document.querySelectorAll('.user-orgs-trigger.is-open').forEach(b => b.classList.remove('is-open'));
      _closeOrgsPopover();
    }
  }, true);

  /* ── Users: edit (consolidated) ─────────────────────────── */
  // Single modal that handles every per-user mutation:
  //   - display_name
  //   - role (admin / manager / viewer)
  //   - organization memberships (multi-select, must have ≥1)
  //   - password (optional — leave blank to keep current)
  //   - active status (Active / Inactive)
  //
  // The admin cannot demote themselves out of admin or deactivate themselves.
  async function _openEditUserModal(userId) {
    const user = _usersCache.find(u => u.user_id === userId);
    if (!user) return;
    const myUserId = Auth.getUser()?.user_id;
    const isSelf   = user.user_id === myUserId;

    // Fetch full org list for the multi-select.
    let allOrgs = [];
    try {
      allOrgs = (await API.getOrganizations() || []).filter(o => o.is_active);
    } catch (err) {
      Notify.apiError(err);
      return;
    }

    const memberOrgIds = new Set((user.memberships || []).map(m => m.organization_id));
    const currentRole  = user.role || 'viewer';
    const isActive     = user.is_active !== false;

    const m = new Modal({ title: `Edit User: ${user.display_name || user.username}`, maxWidth: '500px' });
    m.setBody(`
      <form data-form="edit-user" autocomplete="off">

        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="display" value="${Utils.escapeHtml(user.display_name || '')}" autocomplete="off">
        </div>

        <div class="form-group">
          <label class="form-label">Username</label>
          <div style="padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;color:var(--txt-3);font-family:monospace">
            @${Utils.escapeHtml(user.username || '')}
          </div>
          <div class="form-hint">Username cannot be changed.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Role <span class="req">*</span></label>
          <select class="form-select" data-field="role"${isSelf ? ' disabled' : ''}>
            ${_roleOptions(currentRole)}
          </select>
          ${isSelf ? '<div class="form-hint">You cannot change your own role.</div>' : '<div class="form-hint">Applies platform-wide across every assigned organization.</div>'}
        </div>

        <div class="form-group">
          <label class="form-label">Organizations <span class="req">*</span></label>
          <div class="multiselect" data-field="orgs" data-ms-noun="organizations" data-ms-placeholder="Select organizations…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select organizations…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${allOrgs.length === 0
                ? '<div class="multiselect-empty">No active organizations available.</div>'
                : allOrgs.map(o => `
                  <label class="multiselect-option">
                    <input type="checkbox" value="${Utils.escapeHtml(o.organization_id)}"${memberOrgIds.has(o.organization_id) ? ' checked' : ''}>
                    <span class="multiselect-option-name">${Utils.escapeHtml(o.display_name)}</span>
                  </label>`).join('')}
            </div>
          </div>
          <div class="form-hint">Must belong to at least one organization. Removing an org deactivates the membership (data is preserved).</div>
        </div>

        <div class="form-group">
          <label class="form-label">Change Password (optional)</label>
          <input class="form-input" data-field="new-password" type="password" placeholder="Leave blank to keep current password" autocomplete="new-password">
          <input class="form-input" data-field="confirm-password" type="password" placeholder="Confirm new password" autocomplete="new-password" style="margin-top:6px">
          <div class="form-hint">Minimum 8 characters. Only fills if both fields match.</div>
        </div>

        <div class="form-group">
          <label class="form-label">Account Status</label>
          <select class="form-select" data-field="status"${isSelf ? ' disabled' : ''}>
            <option value="true"  ${isActive  ? 'selected' : ''}>Active</option>
            <option value="false" ${!isActive ? 'selected' : ''}>Inactive (cannot log in)</option>
          </select>
          ${isSelf ? '<div class="form-hint">You cannot deactivate your own account.</div>' : '<div class="form-hint">Inactive users cannot log in. All memberships are preserved.</div>'}
        </div>

        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);

    // Footer: Cancel · Remove Permanently · Save Changes.
    // The status dropdown above handles soft-deactivation (Active/Inactive).
    // "Remove Permanently" is the irreversible hard-delete — only enabled
    // when the user is already inactive (server enforces this gate too).
    // To delete: set status to Inactive, click Save, re-open Edit,
    // then click Remove Permanently.
    const removeDisabled = isSelf || isActive;
    const removeTitle    = isSelf
      ? 'You cannot remove your own account'
      : (isActive
          ? 'Set status to Inactive and save first. Then re-open this dialog to remove the user permanently.'
          : 'Permanently delete this user from BigQuery (memberships + refresh tokens cascade). Irreversible.');
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-danger    btn-sm" data-action="remove"${removeDisabled ? ' disabled' : ''} title="${Utils.escapeHtml(removeTitle)}">Remove Permanently</button>
      <button class="btn btn-primary   btn-sm" data-action="save">Save Changes</button>`);
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="remove"]')?.addEventListener('click', () => _doPermanentDeleteUser(m, userId, user.display_name || user.username, isSelf, isActive));
    qf('[data-action="save"]')?.addEventListener('click', () => _doEditUser(m, q, qf, userId, isSelf));
    q('[data-form="edit-user"]')?.addEventListener('submit', e => { e.preventDefault(); _doEditUser(m, q, qf, userId, isSelf); });

    _wireMultiselect(q('[data-field="orgs"]'));
    Icons?.refresh?.();
  }

  // Permanent (irreversible) hard delete of an already-deactivated user.
  // Type-to-confirm: the operator must type the user's username exactly.
  // The server enforces the is_active=false gate and the can't-delete-self
  // gate independently — these UI checks are convenience.
  async function _doPermanentDeleteUser(m, userId, displayName, isSelf, isActive) {
    if (isSelf || isActive) return;
    const user = _usersCache.find(u => u.user_id === userId);
    const username = user?.username || displayName;
    let result;
    const confirmed = await _typeToConfirm({
      title: `Remove @${username}`,
      bodyHtml: `
        <p style="font-size:13px;color:var(--txt-2);margin-bottom:4px">
          Type <code style="background:var(--surface-2);padding:1px 6px;border-radius:4px;font-family:monospace">${Utils.escapeHtml(username)}</code> to confirm.
        </p>`,
      requiredText: username,
      confirmText:  'Remove',
      onConfirm: async () => {
        result = await API.permanentDeleteUser(userId);
      },
    });
    if (!confirmed) return;
    Notify.success(
      'User deleted',
      `@${username} removed (${result?.memberships_deleted ?? 0} memberships, ${result?.tokens_deleted ?? 0} tokens).`,
    );
    m.hide();
    m.destroy();
    loadUsers();
  }

  async function _doEditUser(m, q, qf, userId, isSelf) {
    const display     = q('[data-field="display"]')?.value.trim();
    const roleSel     = q('[data-field="role"]');
    const role        = roleSel?.disabled ? undefined : roleSel?.value;
    const statusSel   = q('[data-field="status"]');
    const isActiveStr = statusSel?.disabled ? undefined : statusSel?.value;
    const isActive    = isActiveStr === undefined ? undefined : isActiveStr === 'true';
    const newPwd      = q('[data-field="new-password"]')?.value;
    const confirmPwd  = q('[data-field="confirm-password"]')?.value;
    const orgIds      = Array.from(q('[data-field="orgs"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);

    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!display)         return showErr('Display name is required.');
    if (!orgIds.length)   return showErr('User must belong to at least one organization.');

    const payload = { display_name: display, organization_ids: orgIds };
    if (role        !== undefined) payload.role      = role;
    if (isActive    !== undefined) payload.is_active = isActive;

    if (newPwd || confirmPwd) {
      if (!newPwd || newPwd.length < 8) return showErr('New password must be at least 8 characters.');
      if (newPwd !== confirmPwd)        return showErr('New password and confirmation do not match.');
      payload.password = newPwd;
    }

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateUser(userId, payload);
      Notify.success('User updated', isSelf ? 'Your profile has been saved.' : 'Changes saved.');
      m.hide();
      m.destroy();
      loadUsers();
    } catch (err) {
      showErr(err.message || 'Failed to save.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Organizations: load ────────────────────────────────── */
  async function loadOrganizations() {
    const tbody = document.getElementById('orgs-tbody');
    if (!tbody) return;
    tbody.innerHTML = Loading.tableRows(5, 5);
    try {
      const orgs = await API.getOrganizations();
      _orgsCache  = orgs;
      if (!orgs.length) {
        tbody.innerHTML = `<tr><td colspan="5">${Loading.empty('building-2', 'No organizations', 'Create the first organization to get started')}</td></tr>`;
        return;
      }
      const currentOrgId = Auth.getOrganization()?.organization_id;
      tbody.innerHTML = orgs.map(o => {
        const oid      = Utils.escapeHtml(o.organization_id);
        const oname    = Utils.escapeHtml(o.display_name);
        const isHere   = o.organization_id === currentOrgId;
        const isActive = o.is_active !== false;
        const struct   = SkuEngine?.coerceToV2(o.sku_structure);
        const skuCell  = struct?.enabled && struct.segments?.length
          ? `<span style="font-family:monospace;font-size:11.5px;color:var(--txt-2)" title="${Utils.escapeHtml(struct.compiled || '')}">${Utils.escapeHtml(SkuEngine.summarizeStructure(struct))}</span>`
          : `<span style="font-size:11px;color:var(--error);font-weight:600">Not configured</span>`;
        return `<tr data-org-id="${oid}"${!isActive ? ' class="user-row-inactive"' : ''}>
          <td>
            <span style="font-weight:600">${oname}</span>
            ${isHere ? '<span style="font-size:11px;color:var(--primary);margin-left:6px;font-weight:600">● current</span>' : ''}
          </td>
          <td style="font-size:12px;color:var(--txt-4);font-family:monospace">${Utils.escapeHtml(o.slug)}</td>
          <td>${skuCell}</td>
          <td>${isActive ? Utils.badgeHtml('success', 'Active') : Utils.badgeHtml('gray', 'Deactivated')}</td>
          <td>
            <button class="btn btn-secondary btn-sm" data-action="edit-org" data-id="${oid}" title="Edit organization">
              <i data-lucide="pencil" class="icon" style="width:13px;height:13px"></i> Edit
            </button>
          </td>
        </tr>`;
      }).join('');
      Icons?.refresh?.();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5">${Loading.error('Failed to load organizations')}</td></tr>`;
      Notify.apiError(err);
    }
  }

  /* ── Organizations: New (create) ────────────────────────── */
  async function _openNewOrgModal() {
    // Load active users for the member picker.
    let allUsers = [];
    try {
      allUsers = (await API.getUsers() || []).filter(u => u.is_active !== false);
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const myUserId = Auth.getUser()?.user_id;

    const m = new Modal({ title: 'New Organization', maxWidth: 'min(960px, 90vw)' });
    m.setBody(`
      <form data-form="new-org" autocomplete="off">
        <div class="form-group">
          <label class="form-label">Display Name <span class="req">*</span></label>
          <input class="form-input" data-field="name" placeholder="e.g. Patman Warehouse">
        </div>
        <div class="form-group">
          <label class="form-label">Slug <span class="req">*</span></label>
          <input class="form-input" data-field="slug" placeholder="e.g. patman-warehouse" pattern="[-a-z0-9]+">
          <div class="form-hint">Lowercase letters, numbers, hyphens only. Cannot be changed after creation.</div>
        </div>
        <div class="form-group">
          <label class="form-label">Assign Members <span class="req">*</span></label>
          <div class="multiselect" data-field="members" data-ms-noun="members" data-ms-placeholder="Select members…">
            <button type="button" class="multiselect-trigger" data-ms-trigger>
              <span class="multiselect-label" data-ms-label>Select members…</span>
              <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
            </button>
            <div class="multiselect-panel" data-ms-panel>
              ${allUsers.length === 0
                ? '<div class="multiselect-empty">No active users available.</div>'
                : allUsers.map(u => {
                    const isMe = u.user_id === myUserId;
                    return `
                      <label class="multiselect-option">
                        <input type="checkbox" value="${Utils.escapeHtml(u.user_id)}"${isMe ? ' checked' : ''}>
                        <span class="multiselect-option-name">${Utils.escapeHtml(u.display_name || u.username)}${isMe ? ' (you)' : ''}</span>
                      </label>`;
                  }).join('')}
            </div>
          </div>
          <div class="form-hint">At least one member is required. You're pre-selected so you keep access to manage the new org.</div>
        </div>
        ${_renderSkuStructureSection(null, { required: true })}
        <div data-field="error" class="form-error" style="display:none"></div>
      </form>`);
    m.setFooter(`
      <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
      <button class="btn btn-primary btn-sm" data-action="save">Create Organization</button>`);
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    // Auto-derive slug from name as user types (until they manually edit slug).
    const nameEl = q('[data-field="name"]');
    const slugEl = q('[data-field="slug"]');
    nameEl?.addEventListener('input', e => {
      const auto = e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (slugEl && !slugEl.dataset.edited) slugEl.value = auto;
    });
    slugEl?.addEventListener('input', e => { e.target.dataset.edited = '1'; });

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="save"]')?.addEventListener('click', () => _doCreateOrg(m, q, qf));
    q('[data-form="new-org"]')?.addEventListener('submit', e => { e.preventDefault(); _doCreateOrg(m, q, qf); });
    _wireMultiselect(q('[data-field="members"]'));
    _wireSkuStructureSection(q('[data-sku-structure]'));
    Icons?.refresh?.();
  }

  async function _doCreateOrg(m, q, qf) {
    const name    = q('[data-field="name"]')?.value.trim();
    const slug    = q('[data-field="slug"]')?.value.trim();
    const userIds = Array.from(q('[data-field="members"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const sku_structure = _readSkuStructureSection(q('[data-sku-structure]'));
    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name)                          return showErr('Display name is required.');
    if (!slug)                          return showErr('Slug is required.');
    if (!/^[-a-z0-9]+$/.test(slug))     return showErr('Slug must be lowercase letters, numbers, hyphens only.');
    if (!userIds.length)                return showErr('Assign at least one member.');
    if (!sku_structure || !sku_structure.segments?.length) {
      return showErr('SKU structure is required. Enable validation and add at least one segment.');
    }

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.createOrganization({ display_name: name, slug, member_user_ids: userIds, sku_structure });
      Notify.success('Organization created', `${name} is ready.`);
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  /* ── Organizations: Edit (consolidated) ─────────────────── */
  async function _openEditOrgModal(orgId) {
    const org = _orgsCache.find(o => o.organization_id === orgId);
    if (!org) return;
    const isActive = org.is_active !== false;
    const isHere   = orgId === Auth.getOrganization()?.organization_id;

    // Build the member roster: every active user, with their current
    // membership status in this org pre-checked. We use the global user
    // list (org-neutral Settings) — every user is a potential member.
    let allUsers = [];
    try {
      allUsers = await API.getUsers() || [];
    } catch (err) {
      Notify.apiError(err);
      return;
    }
    const currentMemberIds = new Set(
      allUsers
        .filter(u => Array.isArray(u.memberships) && u.memberships.some(m => m.organization_id === orgId))
        .map(u => u.user_id)
    );

    const m = new Modal({ title: `Edit Organization: ${org.display_name}`, maxWidth: 'min(960px, 90vw)' });

    // Deactivated orgs render in read-only mode with a single Activate
    // action. Active orgs render the full editor with Save + Deactivate.
    if (!isActive) {
      m.setBody(`
        <div class="org-edit-deactivated-banner">
          <i data-lucide="alert-octagon" class="icon" style="width:18px;height:18px"></i>
          <div>
            <strong>This organization is deactivated.</strong>
            <div style="font-size:12.5px;color:var(--txt-3);margin-top:2px">
              Members cannot access it. Reactivate to resume editing details and roster.
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Display Name</label>
          <div class="form-readonly">${Utils.escapeHtml(org.display_name)}</div>
        </div>
        <div class="form-group">
          <label class="form-label">Slug</label>
          <div class="form-readonly" style="font-family:monospace">${Utils.escapeHtml(org.slug)}</div>
        </div>
        <div data-field="error" class="form-error" style="display:none"></div>`);
      // Footer for DEACTIVATED orgs: Cancel · Remove Permanently · Activate.
      // "Remove" here means actually delete from BigQuery (rows in
      // memberships, inventory, orders, both upload audit tables, all four
      // summary tables, organizations). Irreversible cascade. The two-step
      // gate is already satisfied (org is_active=false). Disabled when the
      // operator is currently signed into this org — switch first.
      m.setFooter(`
        <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
        <button class="btn btn-danger    btn-sm" data-action="permanent-delete"${isHere ? ' disabled title="Switch to another workspace before deleting this organization"' : ''}>Remove Permanently</button>
        <button class="btn btn-primary   btn-sm" data-action="activate">Activate Organization</button>`);
    } else {
      m.setBody(`
        <form data-form="edit-org" autocomplete="off">
          <div class="form-group">
            <label class="form-label">Display Name <span class="req">*</span></label>
            <input class="form-input" data-field="name" value="${Utils.escapeHtml(org.display_name)}">
          </div>
          <div class="form-group">
            <label class="form-label">Slug</label>
            <div class="form-readonly" style="font-family:monospace">${Utils.escapeHtml(org.slug)}</div>
            <div class="form-hint">Slug is locked after creation.</div>
          </div>
          <div class="form-group">
            <label class="form-label">Members <span class="req">*</span></label>
            <div class="multiselect" data-field="members" data-ms-noun="members" data-ms-placeholder="Select members…">
              <button type="button" class="multiselect-trigger" data-ms-trigger>
                <span class="multiselect-label" data-ms-label>Select members…</span>
                <i data-lucide="chevron-down" class="multiselect-chevron" aria-hidden="true"></i>
              </button>
              <div class="multiselect-panel" data-ms-panel>
                ${allUsers.length === 0
                  ? '<div class="multiselect-empty">No users available.</div>'
                  : allUsers.map(u => {
                      const checked = currentMemberIds.has(u.user_id);
                      const inactive = u.is_active === false;
                      return `
                        <label class="multiselect-option"${inactive ? ' style="opacity:.55"' : ''}>
                          <input type="checkbox" value="${Utils.escapeHtml(u.user_id)}"${checked ? ' checked' : ''}${inactive ? ' disabled' : ''}>
                          <span class="multiselect-option-name">${Utils.escapeHtml(u.display_name || u.username)}${inactive ? ' (deactivated)' : ''}</span>
                        </label>`;
                    }).join('')}
              </div>
            </div>
            <div class="form-hint">At least one active member is required. Removing a user deactivates their membership in this org only.</div>
          </div>
          ${_renderSkuStructureSection(org.sku_structure, { required: true })}
          <div data-field="error" class="form-error" style="display:none"></div>
        </form>`);
      // Footer for ACTIVE orgs: Cancel · Deactivate · Save Changes.
      // Deactivation is the reversible soft step (PATCH is_active=false).
      // To permanently delete the org, the operator deactivates first;
      // re-opening the modal then exposes a "Remove Permanently" button
      // in the deactivated-org footer above.
      m.setFooter(`
        <button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
        <button class="btn btn-danger    btn-sm" data-action="deactivate"${isHere ? ' disabled title="Switch to another workspace before deactivating this one"' : ''}>Deactivate</button>
        <button class="btn btn-primary   btn-sm" data-action="save">Save Changes</button>`);
    }
    m.show();

    const q  = sel => m.bodyEl.querySelector(sel);
    const qf = sel => m.footerEl.querySelector(sel);
    const _hideAndDestroy = () => { m.hide(); m.destroy(); };

    qf('[data-action="cancel"]')?.addEventListener('click', _hideAndDestroy);
    qf('[data-action="activate"]')?.addEventListener('click', () => _doToggleOrg(m, orgId, true));
    qf('[data-action="deactivate"]')?.addEventListener('click', () => _doDeactivateOrg(m, orgId, org.display_name));
    qf('[data-action="permanent-delete"]')?.addEventListener('click', () => _doPermanentDeleteOrg(m, orgId, org.display_name));
    qf('[data-action="save"]')?.addEventListener('click', () => _doSaveOrg(m, q, qf, orgId));
    q('[data-form="edit-org"]')?.addEventListener('submit', e => { e.preventDefault(); _doSaveOrg(m, q, qf, orgId); });

    if (isActive) {
      _wireMultiselect(q('[data-field="members"]'));
      _wireSkuStructureSection(q('[data-sku-structure]'));
    }
    Icons?.refresh?.();
  }

  async function _doSaveOrg(m, q, qf, orgId) {
    const name    = q('[data-field="name"]')?.value.trim();
    const userIds = Array.from(q('[data-field="members"]')?.querySelectorAll('input[type=checkbox]:checked') || []).map(cb => cb.value);
    const sku_structure = _readSkuStructureSection(q('[data-sku-structure]'));
    const errEl   = q('[data-field="error"]');
    const saveBtn = qf('[data-action="save"]');
    const showErr = msg => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!name)            return showErr('Display name is required.');
    if (!userIds.length)  return showErr('At least one member is required.');
    if (!sku_structure || !sku_structure.segments?.length) {
      return showErr('SKU structure is required. Enable validation and add at least one segment.');
    }

    if (errEl) errEl.style.display = 'none';
    Loading.btn(saveBtn, true);
    try {
      await API.updateOrganization(orgId, { display_name: name, member_user_ids: userIds, sku_structure });
      Notify.success('Organization updated');
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      showErr(err.message || 'Save failed.');
    } finally {
      Loading.btn(saveBtn, false);
    }
  }

  async function _doDeactivateOrg(m, orgId, orgName) {
    const confirmed = await Modal.confirm({
      title:       `Deactivate ${orgName}`,
      message:     '',
      confirmText: 'Deactivate',
      danger:      true,
    });
    if (!confirmed) return;
    try {
      await API.updateOrganization(orgId, { is_active: false });
      Notify.success('Organization deactivated', `"${orgName}" is no longer accessible. Data is preserved.`);
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  // Permanent (irreversible) hard delete of a deactivated org. Type-to-
  // confirm: the operator must type the exact org name to enable the
  // delete button. Server enforces is_active=false + not-current-org
  // gates independently — UI is the convenience layer.
  async function _doPermanentDeleteOrg(m, orgId, orgName) {
    let result;
    const confirmed = await _typeToConfirm({
      title: `Remove ${orgName}`,
      bodyHtml: `
        <p style="font-size:13px;color:var(--txt-2);margin-bottom:4px">
          Type <code style="background:var(--surface-2);padding:1px 6px;border-radius:4px;font-family:monospace">${Utils.escapeHtml(orgName)}</code> to confirm.
        </p>`,
      requiredText: orgName,
      confirmText:  'Remove',
      // Async mode — modal stays open with spinner during the multi-
      // second BQ cascade so the operator gets clear feedback instead
      // of wondering whether the click registered.
      onConfirm: async () => {
        result = await API.permanentDeleteOrganization(orgId);
      },
    });
    if (!confirmed) return;

    Notify.success(
      'Organization deleted',
      `"${orgName}" and all its data removed (${result?.memberships_deleted ?? 0} memberships, ${(result?.tables_cleared || []).length} tables cleared).`,
    );
    m.hide();
    m.destroy();
    loadOrganizations();
  }

  // Reusable type-to-confirm modal. Used by destructive permanent-
  // delete flows. Two modes:
  //
  //   1. Without onConfirm:  resolves Promise<boolean> when the user
  //      clicks confirm/cancel. Caller runs the async work AFTER the
  //      modal closes — older flow, leaves a gap of dead UI while
  //      the API call runs.
  //
  //   2. With onConfirm:     stays OPEN while the async onConfirm()
  //      runs. The confirm button switches to a spinner + 'Removing…'
  //      and inputs/buttons disable. On resolution the modal closes
  //      automatically. On rejection the error is surfaced and the
  //      modal restores so the operator can retry. Used by the
  //      permanent-delete flows so the operator sees clear feedback
  //      during the multi-second BQ cascade.
  function _typeToConfirm({ title, bodyHtml, requiredText, confirmText = 'Delete', onConfirm = null, inputType = 'text', inputPlaceholder = 'Type to confirm' }) {
    return new Promise(resolve => {
      const safeType = inputType === 'password' ? 'password' : 'text';
      const inputmode = safeType === 'password' ? 'inputmode="numeric" ' : '';
      const m = new Modal({
        title,
        body:   bodyHtml + `<input class="form-input" id="ttc-input" type="${safeType}" ${inputmode}placeholder="${Utils.escapeHtml(inputPlaceholder)}" autocomplete="off" style="margin-top:4px">`,
        footer: `<button class="btn btn-secondary btn-sm" data-action="cancel">Cancel</button>
                 <button class="btn btn-danger btn-sm" data-action="confirm" disabled>${Utils.escapeHtml(confirmText)}</button>`,
        maxWidth: '480px',
      });
      m.show();
      const input  = m.bodyEl.querySelector('#ttc-input');
      const okBtn  = m.footerEl.querySelector('[data-action="confirm"]');
      const cxBtn  = m.footerEl.querySelector('[data-action="cancel"]');
      input?.focus();
      // requiredText === null → any non-empty input enables the
      // confirm button; server-side validation does the real check.
      // requiredText === string → input must match exactly.
      input?.addEventListener('input', () => {
        okBtn.disabled = requiredText === null
          ? input.value.length === 0
          : input.value !== requiredText;
      });
      cxBtn.addEventListener('click', () => { m.hide(); m.destroy(); resolve(false); });

      okBtn.addEventListener('click', async () => {
        if (!onConfirm) {
          m.hide(); m.destroy(); resolve(true);
          return;
        }
        // Async mode — stay open, show loading state, run onConfirm.
        const origHtml = okBtn.innerHTML;
        okBtn.disabled = true;
        cxBtn.disabled = true;
        if (input) input.disabled = true;
        okBtn.innerHTML = `
          <span style="display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:ttc-spin .8s linear infinite;vertical-align:-2px;margin-right:8px"></span>
          Removing…`;
        // Inject the keyframe once (cheap, idempotent — same id collapses).
        if (!document.getElementById('ttc-spin-style')) {
          const s = document.createElement('style');
          s.id = 'ttc-spin-style';
          s.textContent = `@keyframes ttc-spin { to { transform: rotate(360deg); } }`;
          document.head.appendChild(s);
        }
        try {
          await onConfirm();
          m.hide();
          m.destroy();
          resolve(true);
        } catch (err) {
          Notify.apiError(err);
          // Restore so the operator can retry without re-typing.
          okBtn.disabled = false;
          cxBtn.disabled = false;
          if (input) input.disabled = false;
          okBtn.innerHTML = origHtml;
        }
      });
    });
  }

  async function _doToggleOrg(m, orgId, activate) {
    try {
      await API.updateOrganization(orgId, { is_active: activate });
      Notify.success(`Organization ${activate ? 'activated' : 'deactivated'}`);
      m.hide();
      m.destroy();
      loadOrganizations();
    } catch (err) {
      Notify.apiError(err);
    }
  }

  /* ── System tab ─────────────────────────────────────────── */
  async function loadSystemStatus() {
    const el = document.getElementById('system-status-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      const status = await API.getSystemStatus();
      const baseHtml = `
        <div style="display:grid;gap:10px">
          ${_statusRow('Cloud Run API', 'ok', 'Connected')}
          ${_statusRow('BigQuery', status.bqStatus || 'ok', status.bqMessage || 'Connected')}
          ${_statusRow('App Version', 'info', status.version || '—')}
          ${_statusRow('Last Check', 'info', Utils.formatDatetime(status.timestamp))}
        </div>`;
      el.innerHTML = baseHtml + (Auth.hasRole('admin') ? _adminOpsPanelHtml() : '');
      if (Auth.hasRole('admin')) _wireAdminOpsPanel();
      if (window.lucide) lucide.createIcons();
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load system status');
    }
  }

  function _statusRow(label, status, message) {
    const iconName  = status === 'ok' ? 'check-circle' : status === 'info' ? 'info' : 'x-circle';
    const iconColor = status === 'ok' ? 'var(--success)' : status === 'info' ? 'var(--primary)' : 'var(--error)';
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--surface-2);border-radius:var(--r-sm)">
        <span style="font-size:13px;font-weight:500;color:var(--txt-2)">${Utils.escapeHtml(label)}</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--txt-3)">
          ${Utils.escapeHtml(message || '')}
          <i data-lucide="${iconName}" class="icon" style="width:14px;height:14px;color:${iconColor}" aria-hidden="true"></i>
        </span>
      </div>`;
  }

  /* ── Admin operations panel (permanent operational diagnostics) ────
     Visible only when Auth.hasRole('admin'). Three-row responsive layout:
       Row 1 — three compact action cards for org-level data refresh state.
       Row 2 — two report cards (refresh health + drift detection).
       Row 3 — recent activity (uploads in this org).
     Buttons consume the same authenticated API client used everywhere
     else — no separate auth path, no token plumbing. Each operation
     has its own result panel beneath the button so multiple reports
     can stay on screen at once. */
  function _adminOpsPanelHtml() {
    // Layout redesigned 2026-05-18: left rail = compact action list,
    // right rail = live terminal that receives ALL result output. No
    // per-card result panel — everything flows into the single
    // terminal with a timestamped header so the operator can compare
    // recent invocations side-by-side.
    //
    // Runtime Diagnostics card removed per operator direction (the
    // /admin/diagnostics endpoint only exists on newer revisions and
    // was 404-ing on older Cloud Run builds).
    const actionRow = (id, label, kind = 'action') => `
      <button class="btn btn-primary admin-op-btn ${kind === 'danger' ? 'admin-op-btn--danger' : ''}"
              id="${id}" data-op-label="${Utils.escapeHtml(label)}">
        ${Utils.escapeHtml(label)}
      </button>`;

    return `
      ${_adminOpsPanelStyleHtml()}
      <div class="admin-ops-panel">
        <div class="admin-ops-header">
          <span class="admin-ops-chip">ADMIN</span>
          <div class="admin-ops-title">Operational Diagnostics</div>
        </div>

        <div class="admin-ops-layout">
          <div class="admin-ops-rail">
            ${actionRow('admin-op-refresh-all',    'Refresh All Summary Tables')}
            ${actionRow('admin-op-refresh-org',    'Refresh Current Organization')}
            ${actionRow('admin-op-summary-status', 'Summary Status')}
            ${actionRow('admin-op-refresh-health', 'Refresh Health (24h)')}
            ${actionRow('admin-op-parity-report',  'Drift Report (24h)')}
            ${actionRow('admin-op-recent-uploads', 'Recent Uploads')}
            ${actionRow('admin-op-purge-old-data', 'Storage Maintenance')}
          </div>

          <div class="admin-ops-terminal" id="admin-ops-terminal">
            <div class="admin-ops-terminal-header">
              <span>Output</span>
              <button class="admin-ops-terminal-clear" id="admin-ops-terminal-clear" title="Clear terminal">clear</button>
            </div>
            <div class="admin-ops-terminal-body" id="admin-ops-terminal-body">
              <div class="admin-ops-terminal-empty">Ready. Click an action.</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Self-contained styles for the admin-ops panel. Injected as a <style>
  // tag inside the panel HTML so it survives org-switch / re-renders
  // without needing a CSS file version bump. Idempotent — duplicate
  // <style> blocks with the same id collapse to the most recent.
  function _adminOpsPanelStyleHtml() {
    return `
      <style id="admin-ops-styles">
        .admin-ops-panel { margin-top: 22px; padding-top: 18px; border-top: 1px dashed var(--border); }
        .admin-ops-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .admin-ops-chip { font-size: 10px; font-weight: 700; background: var(--warning); color: #fff; padding: 2px 7px; border-radius: 999px; letter-spacing: .05em; }
        .admin-ops-title { font-size: 14px; font-weight: 700; color: var(--txt-1); }
        .admin-ops-blurb { font-size: 12px; color: var(--txt-4); margin-bottom: 14px; line-height: 1.5; }

        /* Panel and layout are flex/grid columns that consume all
           remaining vertical space in #system-status-content. That
           gives the terminal a real container-relative height (not
           a viewport approximation), so its body scrolls internally
           and the outer page never grows a scroll bar. */
        .admin-ops-panel { display: flex; flex-direction: column; min-height: 0; }
        .admin-ops-header { flex-shrink: 0; }
        .admin-ops-layout {
          flex: 1;
          min-height: 0;
          display: grid;
          grid-template-columns: 240px 1fr;
          grid-template-rows: minmax(0, 1fr);
          gap: 12px;
          align-items: stretch;
        }
        @media (max-width: 900px) {
          .admin-ops-layout {
            grid-template-columns: 1fr;
            grid-template-rows: auto minmax(0, 1fr);
          }
        }

        .admin-ops-rail { display: flex; flex-direction: column; gap: 6px; align-self: start; }
        .admin-op-btn {
          justify-content: flex-start;
          text-align: left;
          padding: 8px 12px;
          font-size: 12.5px;
          font-weight: 600;
          border-radius: 6px;
          width: 100%;
        }
        .admin-op-btn--danger { background: var(--error) !important; border-color: var(--error) !important; }
        .admin-op-btn:disabled { opacity: .6; cursor: wait; }

        /* Terminal — light theme matching the app. Height comes from
           the grid cell it lives in (which fills the ops layout
           row, which fills the panel, which fills #system-status-
           content). The terminal body scrolls internally when
           entries exceed available height — no page scroll ever. */
        .admin-ops-terminal {
          background: var(--surface);
          color: var(--txt-1);
          border: 1px solid var(--border);
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          min-height: 0;
          overflow: hidden;
          box-shadow: 0 1px 2px rgba(15,23,42,.03);
        }
        .admin-ops-terminal-header {
          background: var(--surface-2);
          border-bottom: 1px solid var(--border);
          padding: 8px 12px;
          font-size: 11px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: .08em;
          color: var(--txt-3);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .admin-ops-terminal-clear {
          background: transparent;
          border: 1px solid var(--border);
          color: var(--txt-3);
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 4px;
          cursor: pointer;
          letter-spacing: .05em;
        }
        .admin-ops-terminal-clear:hover { background: var(--surface-3); color: var(--txt-1); }
        .admin-ops-terminal-body {
          flex: 1;
          overflow-y: auto;
          padding: 8px 12px;
          font-size: 12px;
          line-height: 1.55;
        }
        .admin-ops-terminal-empty { color: var(--txt-4); font-style: italic; padding: 24px 4px; text-align: center; }

        /* Individual entry: header line + body. Newest entries appended to bottom. */
        .admin-ops-entry { border-top: 1px dashed var(--border); padding: 10px 0; }
        .admin-ops-entry:first-child { border-top: none; padding-top: 4px; }
        .admin-ops-entry-header {
          font-size: 11px;
          color: var(--txt-3);
          margin-bottom: 6px;
          font-weight: 600;
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
        }
        .admin-ops-entry-header .ts { color: var(--txt-4); }
        .admin-ops-entry-header .op { color: var(--txt-1); margin-left: 6px; }
        .admin-ops-entry-header .badge {
          display: inline-block;
          margin-left: 8px;
          padding: 1px 6px;
          border-radius: 3px;
          font-size: 9.5px;
          text-transform: uppercase;
          letter-spacing: .06em;
          font-weight: 700;
        }
        .admin-ops-entry-header .badge--info    { background: var(--primary-50, #dbeafe); color: var(--primary, #1d4ed8); }
        .admin-ops-entry-header .badge--success { background: rgba(22,163,74,.14); color: var(--success); }
        .admin-ops-entry-header .badge--error   { background: rgba(220,38,38,.14); color: var(--error); }
        .admin-ops-entry-body {
          background: var(--surface-2);
          color: var(--txt-1);
          border-radius: 4px;
          padding: 8px 10px;
          font-size: 12px;
          line-height: 1.5;
          overflow-x: auto;
        }
        .admin-ops-entry-body table { width: 100%; border-collapse: collapse; }
        .admin-ops-entry-body thead tr { background: var(--surface-3); font-size: 10.5px; text-transform: uppercase; color: var(--txt-3); }
        .admin-ops-entry-body th { padding: 5px 8px; text-align: left; font-weight: 600; }
        .admin-ops-entry-body td { padding: 4px 8px; border-top: 1px solid var(--border); }
      </style>
    `;
  }

  // Terminal output helper. All admin operations funnel their results
  // into the shared right-side terminal panel. `id` was formerly the
  // per-card result div (e.g. "admin-op-refresh-all-result"); we now
  // derive the action label from the corresponding button's
  // data-op-label attribute so entries are self-describing.
  function _showAdminResult(id, html, kind = 'info') {
    const body = document.getElementById('admin-ops-terminal-body');
    if (!body) return;
    // Drop the sentinel empty message on first entry.
    const empty = body.querySelector('.admin-ops-terminal-empty');
    if (empty) empty.remove();

    // Derive the action label. Historical ids look like
    // `admin-op-<slug>-result`; strip the -result suffix to reach the
    // button and read its data-op-label.
    const btnId = id.replace(/-result$/, '');
    const btn   = document.getElementById(btnId);
    const label = btn?.dataset.opLabel || btnId.replace(/^admin-op-/, '');

    const ts = new Date();
    const hh = String(ts.getHours()).padStart(2, '0');
    const mm = String(ts.getMinutes()).padStart(2, '0');
    const ss = String(ts.getSeconds()).padStart(2, '0');
    const badgeClass = kind === 'error' ? 'badge--error' : kind === 'success' ? 'badge--success' : 'badge--info';

    const entry = document.createElement('div');
    entry.className = 'admin-ops-entry';
    entry.innerHTML = `
      <div class="admin-ops-entry-header">
        <span class="ts">${hh}:${mm}:${ss}</span>
        <span class="op">${Utils.escapeHtml(label)}</span>
        <span class="badge ${badgeClass}">${kind}</span>
      </div>
      <div class="admin-ops-entry-body">${html}</div>`;
    body.appendChild(entry);
    body.scrollTop = body.scrollHeight;
    if (window.lucide) lucide.createIcons();
  }

  function _wireTerminalClear() {
    document.getElementById('admin-ops-terminal-clear')?.addEventListener('click', () => {
      const body = document.getElementById('admin-ops-terminal-body');
      if (body) body.innerHTML = '<div class="admin-ops-terminal-empty">Ready. Click an action.</div>';
    });
  }

  async function _runAdminOp(btnId, fn) {
    const btn   = document.getElementById(btnId);
    const resId = `${btnId}-result`;
    if (!btn) return;
    const origText = btn.innerHTML;
    btn.disabled  = true;
    btn.innerHTML = '⏳ Running…';
    try {
      const data = await fn();
      btn.disabled  = false;
      btn.innerHTML = origText;
      return data;
    } catch (err) {
      btn.disabled  = false;
      btn.innerHTML = origText;
      _showAdminResult(resId, `<strong style="color:var(--error)">Failed:</strong> ${Utils.escapeHtml(err?.message ?? String(err))}`, 'error');
      throw err;
    }
  }

  function _wireAdminOpsPanel() {
    _wireTerminalClear();

    document.getElementById('admin-op-refresh-all')?.addEventListener('click', async () => {
      const data = await _runAdminOp('admin-op-refresh-all', () => API.adminRefreshAllOrgs()).catch(() => null);
      if (!data) return;
      _showAdminResult(
        'admin-op-refresh-all-result',
        `<strong>Scheduled ${data.scheduled_count} refresh${data.scheduled_count === 1 ? '' : 'es'}.</strong> Wait ~30s, then check Summary Status to confirm. Org IDs: <code style="font-size:11px">${data.scheduled_orgs.join(', ')}</code>`,
        'success',
      );
      Notify.success?.('Scheduled', `${data.scheduled_count} org refresh${data.scheduled_count === 1 ? '' : 'es'} queued`);
    });

    document.getElementById('admin-op-refresh-org')?.addEventListener('click', async () => {
      const orgId = Auth.getOrganization()?.organization_id;
      const data  = await _runAdminOp('admin-op-refresh-org', () => API.adminRefreshOrg(orgId)).catch(() => null);
      if (!data) return;
      _showAdminResult(
        'admin-op-refresh-org-result',
        `<strong>Refresh scheduled</strong> for org <code>${Utils.escapeHtml(data.organization_id)}</code>.`,
        'success',
      );
      Notify.success?.('Scheduled', 'Org refresh queued');
    });

    document.getElementById('admin-op-summary-status')?.addEventListener('click', async () => {
      const orgId = Auth.getOrganization()?.organization_id;
      const data  = await _runAdminOp('admin-op-summary-status', () => API.adminSummaryStatus(orgId)).catch(() => null);
      if (!data) return;
      const rows = (data.tables || []).map(t => {
        const ok    = t.status === 'ok';
        const stale = ok && t.row_count === 0;
        const color = !ok ? 'var(--error)' : stale ? 'var(--warning)' : 'var(--success)';
        return `<tr>
          <td style="padding:5px 8px;font-family:monospace;font-size:11.5px">${Utils.escapeHtml(t.table)}</td>
          <td style="padding:5px 8px;font-variant-numeric:tabular-nums">${t.row_count ?? '—'}</td>
          <td style="padding:5px 8px;color:var(--txt-3);font-size:11.5px">${t.last_refreshed_at ? Utils.formatDatetime(t.last_refreshed_at) : '— never refreshed —'}</td>
          <td style="padding:5px 8px;color:${color};font-weight:600">${ok ? (stale ? 'EMPTY' : 'OK') : 'ERROR'}</td>
        </tr>`;
      }).join('');
      _showAdminResult(
        'admin-op-summary-status-result',
        `<table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface-3);font-size:11px;text-transform:uppercase;color:var(--txt-3)">
              <th style="padding:6px 8px;text-align:left">Table</th>
              <th style="padding:6px 8px;text-align:left">Rows</th>
              <th style="padding:6px 8px;text-align:left">Last refreshed</th>
              <th style="padding:6px 8px;text-align:left">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`,
      );
    });

    document.getElementById('admin-op-refresh-health')?.addEventListener('click', async () => {
      const data = await _runAdminOp('admin-op-refresh-health', () => API.adminRefreshHealth(24)).catch(() => null);
      if (!data) return;
      const orgs = data.orgs || [];
      if (!orgs.length) {
        _showAdminResult('admin-op-refresh-health-result', `<span style="color:var(--txt-4)">No refresh events in the last ${data.window_hours}h.</span>`);
        return;
      }
      const rows = orgs.map(o => {
        const failColor = o.failure_count > 0 ? 'var(--error)' : 'var(--txt-3)';
        return `<tr>
          <td style="padding:5px 8px;font-family:monospace;font-size:11px">${Utils.escapeHtml(o.organization_id.slice(0, 8))}…</td>
          <td style="padding:5px 8px;font-variant-numeric:tabular-nums">${o.refresh_count}</td>
          <td style="padding:5px 8px;font-variant-numeric:tabular-nums">${o.p50_table_ms ?? '—'} ms</td>
          <td style="padding:5px 8px;font-variant-numeric:tabular-nums">${o.p95_table_ms ?? '—'} ms</td>
          <td style="padding:5px 8px;font-weight:${o.failure_count > 0 ? '700' : '500'};color:${failColor}">${o.failure_count}</td>
          <td style="padding:5px 8px;color:var(--txt-4);font-size:11px">${o.last_failure ? Utils.escapeHtml(JSON.stringify(o.last_failure).slice(0, 80)) : '—'}</td>
        </tr>`;
      }).join('');
      _showAdminResult(
        'admin-op-refresh-health-result',
        `<div style="margin-bottom:6px;color:var(--txt-3)">
          Window: ${data.window_hours}h · Log entries scanned: ${data.log_entries_scanned}
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface-3);font-size:11px;text-transform:uppercase;color:var(--txt-3)">
              <th style="padding:6px 8px;text-align:left">Org</th>
              <th style="padding:6px 8px;text-align:left">Refreshes</th>
              <th style="padding:6px 8px;text-align:left">p50</th>
              <th style="padding:6px 8px;text-align:left">p95</th>
              <th style="padding:6px 8px;text-align:left">Failures</th>
              <th style="padding:6px 8px;text-align:left">Last failure</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`,
      );
    });

    document.getElementById('admin-op-parity-report')?.addEventListener('click', async () => {
      const data = await _runAdminOp('admin-op-parity-report', () => API.adminParityReport(24)).catch(() => null);
      if (!data) return;
      const ready = data.ready_for_cutover || {};
      const badge = (label, ok) => `
        <span style="display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:999px;font-size:11.5px;font-weight:600;
          background:${ok ? 'rgba(22,163,74,.10)' : 'rgba(220,38,38,.10)'};
          color:${ok ? 'var(--success)' : 'var(--error)'}">
          <i data-lucide="${ok ? 'check-circle' : 'x-circle'}" class="icon" style="width:13px;height:13px"></i>
          ${Utils.escapeHtml(label)}: ${ok ? 'READY' : 'NOT READY'}
        </span>`;

      const orgs = data.orgs || [];
      const rows = orgs.map(o => {
        const cell = (surface) => {
          const s = o[surface] || {};
          const bad = (s.diff || 0) > 0 || (s.missing_or_total_diff || 0) > 0;
          return `<td style="padding:5px 8px;font-variant-numeric:tabular-nums;color:${bad ? 'var(--error)' : 'var(--txt-2)'}">
            ${s.match || 0}<span style="color:var(--txt-4)"> / </span>${s.diff || 0}<span style="color:var(--txt-4)"> / </span>${s.missing_or_total_diff || 0}
          </td>`;
        };
        const lastDiff = o.dashboard?.last_diff || o.sku?.last_diff || o.box?.last_diff;
        return `<tr>
          <td style="padding:5px 8px;font-family:monospace;font-size:11px">${Utils.escapeHtml(o.organization_id.slice(0, 8))}…</td>
          ${cell('dashboard')}
          ${cell('sku')}
          ${cell('box')}
          <td style="padding:5px 8px;color:var(--txt-4);font-size:11px">${lastDiff ? Utils.escapeHtml(JSON.stringify(lastDiff).slice(0, 60)) : '—'}</td>
        </tr>`;
      }).join('');

      _showAdminResult(
        'admin-op-parity-report-result',
        `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          ${badge('Dashboard', !!ready.dashboard)}
          ${badge('SKU View',  !!ready.sku)}
          ${badge('Box Lookup',!!ready.box)}
        </div>
        <div style="margin-bottom:8px;color:var(--txt-3)">
          Window: ${data.window_hours}h · Log entries scanned: ${data.log_entries_scanned} · Orgs observed: ${orgs.length}
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface-3);font-size:11px;text-transform:uppercase;color:var(--txt-3)">
              <th style="padding:6px 8px;text-align:left">Org</th>
              <th style="padding:6px 8px;text-align:left" title="match / diff / missing or total_diff">Dashboard</th>
              <th style="padding:6px 8px;text-align:left">SKU View</th>
              <th style="padding:6px 8px;text-align:left">Box Lookup</th>
              <th style="padding:6px 8px;text-align:left">Sample last diff</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5" style="padding:8px;color:var(--txt-4)">No parity events in window — enable SUMMARY_PARITY_LOG=1 and let users hit the app.</td></tr>'}</tbody>
        </table>
        <div style="margin-top:6px;color:var(--txt-4);font-size:11px">
          Column format: <code>match / diff / missing_or_total_diff</code>. Zero in the last two columns means no drift detected between the live and materialized paths.
        </div>`,
      );
    });

    // Runtime Diagnostics handler removed 2026-05-18 — the Runtime
    // Diagnostics button was dropped from the panel because the
    // backing /admin/diagnostics endpoint only exists on newer
    // Cloud Run revisions and 404s on older builds.

    // Purge Old Data — destructive 30-day rolling retention sweep.
    // PIN-gated: server accepts only when the request body carries
    // the correct PIN in addition to a valid admin JWT. Modal stays
    // open with a spinner during the multi-second BQ round-trip so
    // the operator sees clear feedback.
    document.getElementById('admin-op-purge-old-data')?.addEventListener('click', async () => {
      let result;
      // Capture the PIN via the _typeToConfirm input closure so we
      // can forward it with the API call inside onConfirm.
      let enteredPin = '';
      const confirmed = await _typeToConfirm({
        title: 'PIN',
        bodyHtml: '',
        inputType:        'password',
        inputPlaceholder: '••••',
        requiredText:     null,
        confirmText:      'Proceed',
        onConfirm: async () => {
          const inputEl = document.getElementById('ttc-input');
          enteredPin = inputEl?.value ?? '';
          try {
            result = await API.adminPurgeOldData(30, enteredPin);
          } catch (err) {
            // Surface the specific failure mode in the terminal so
            // the operator has a clear next step. Modal stays open
            // (the throw here bubbles to _typeToConfirm's onConfirm
            // catch → error toast + modal restored for retry).
            let msg;
            if (err.status === 404) {
              msg = 'Endpoint not deployed on the current Cloud Run revision. Redeploy the backend and retry.';
            } else if (err.status === 403) {
              msg = 'Invalid PIN.';
            } else if (err.status === 400) {
              msg = err.message || 'Bad request.';
            } else {
              msg = `Failed: ${err.message || 'Unknown error'}`;
            }
            _showAdminResult('admin-op-purge-old-data-result', Utils.escapeHtml(msg), 'error');
            throw err;
          }
        },
      });
      if (!confirmed) return;

      const total =
        (result?.inventory_rows_deleted ?? 0) +
        (result?.orders_rows_deleted    ?? 0) +
        (result?.inv_uploads_deleted    ?? 0) +
        (result?.ord_uploads_deleted    ?? 0) +
        (result?.activity_rows_deleted  ?? 0) +
        (result?.expired_tokens_deleted ?? 0);
      // Minimal result panel — single "Completed" line in the terminal.
      // No toast, no per-target breakdown, no additional popups.
      _showAdminResult(
        'admin-op-purge-old-data-result',
        `<div><strong style="color:var(--success)">Completed</strong></div>`,
        'success',
      );
    });

    // Recent Uploads — reuses the existing /uploads/history endpoint
    // already used by the Uploads page, just rendered inline here for
    // quick admin diagnosis without leaving Settings.
    document.getElementById('admin-op-recent-uploads')?.addEventListener('click', async () => {
      const data = await _runAdminOp('admin-op-recent-uploads', () => API.getUploadHistory('')).catch(() => null);
      if (!data) return;
      const list = Array.isArray(data) ? data : (data.rows || data.items || []);
      if (!list.length) {
        _showAdminResult('admin-op-recent-uploads-result', `<span style="color:var(--txt-4)">No upload activity for this organization.</span>`);
        return;
      }
      const statusBadge = (status) => {
        const s = String(status || '').toLowerCase();
        const map = {
          success:    { c: 'var(--success)', bg: 'rgba(22,163,74,.10)' },
          partial:    { c: 'var(--warning)', bg: 'rgba(217,119,6,.10)' },
          failed:     { c: 'var(--error)',   bg: 'rgba(220,38,38,.10)' },
          processing: { c: 'var(--primary)', bg: 'rgba(37,99,235,.10)' },
          accepted:   { c: 'var(--txt-3)',   bg: 'var(--surface-3)' },
        };
        const v = map[s] || { c: 'var(--txt-3)', bg: 'var(--surface-3)' };
        return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${v.bg};color:${v.c}">${Utils.escapeHtml(status || '—')}</span>`;
      };
      const rows = list.slice(0, 20).map(r => `
        <tr>
          <td style="padding:5px 8px;color:var(--txt-3);font-size:11px;white-space:nowrap">${Utils.formatDatetime(r.created_at)}</td>
          <td style="padding:5px 8px;font-size:11.5px">${Utils.escapeHtml(r.type || '—')}</td>
          <td style="padding:5px 8px;font-size:11.5px;font-family:monospace;color:var(--txt-2);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escapeHtml(r.filename || '')}">${Utils.escapeHtml(r.filename || '—')}</td>
          <td style="padding:5px 8px;font-variant-numeric:tabular-nums;text-align:right">${Utils.formatNumber(r.row_count ?? 0)}</td>
          <td style="padding:5px 8px">${statusBadge(r.status)}</td>
          <td style="padding:5px 8px;color:var(--txt-4);font-size:11px">${r.has_report ? '<span style="color:var(--success)">✓</span>' : '—'}</td>
        </tr>`).join('');
      _showAdminResult(
        'admin-op-recent-uploads-result',
        `<div style="margin-bottom:6px;color:var(--txt-3)">Last ${Math.min(list.length, 20)} upload${list.length === 1 ? '' : 's'} for this organization.</div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:var(--surface-3);font-size:11px;text-transform:uppercase;color:var(--txt-3)">
              <th style="padding:6px 8px;text-align:left">When</th>
              <th style="padding:6px 8px;text-align:left">Type</th>
              <th style="padding:6px 8px;text-align:left">File</th>
              <th style="padding:6px 8px;text-align:right">Rows</th>
              <th style="padding:6px 8px;text-align:left">Status</th>
              <th style="padding:6px 8px;text-align:left">Report</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`,
      );
    });
  }

  /* ── Logs tab ─────────────────────────────────────────────── */
  let _logsItems   = [];
  let _logsPage    = 1;
  const _LOGS_PER  = 20;

  function _renderLogsPage() {
    const el    = document.getElementById('logs-content');
    const pagEl = document.getElementById('logs-pagination');
    if (!el) return;

    if (!_logsItems.length) {
      el.innerHTML = Loading.empty('clipboard-list', 'No activity found');
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    const total      = _logsItems.length;
    const totalPages = Math.ceil(total / _LOGS_PER);
    const start      = (_logsPage - 1) * _LOGS_PER;
    const slice      = _logsItems.slice(start, start + _LOGS_PER);

    el.innerHTML = slice.map(item => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--txt-4);display:flex;align-items:center">
          <i data-lucide="clock" class="icon" style="width:16px;height:16px" aria-hidden="true"></i>
        </span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;color:var(--txt-1)">${Utils.escapeHtml(item.title || item.description || '')}</div>
          <div style="font-size:11.5px;color:var(--txt-4)">${Utils.timeAgo(item.date || item.created_at || item.timestamp)}</div>
        </div>
      </div>`).join('');
    Icons.refresh();

    if (pagEl) {
      const showing = `<span class="pagination-info">Showing ${start + 1}–${Math.min(start + _LOGS_PER, total)} of ${total}</span>`;
      const prev    = `<button class="btn btn-ghost btn-sm" onclick="Settings._goLogsPage(${_logsPage - 1})"${_logsPage === 1 ? ' disabled' : ''}>&#8592; Prev</button>`;
      const next    = `<button class="btn btn-ghost btn-sm" onclick="Settings._goLogsPage(${_logsPage + 1})"${_logsPage >= totalPages ? ' disabled' : ''}>Next &#8594;</button>`;
      pagEl.innerHTML = `${showing}<div style="display:flex;gap:6px">${prev}${next}</div>`;
    }
  }

  async function loadLogs() {
    const el = document.getElementById('logs-content');
    if (!el) return;
    el.innerHTML = `<div style="display:flex;justify-content:center;padding:24px">${Loading.spinnerHtml()}</div>`;
    try {
      _logsItems = await API.getActivity(200);
      _logsPage  = 1;
      _renderLogsPage();
    } catch (err) {
      el.innerHTML = Loading.error('Failed to load activity logs');
    }
  }

  /* ── Tab init + event delegation ────────────────────────── */
  function initTabs() {
    const tabList = document.getElementById('settings-tab-list');
    if (tabList) {
      tabList.addEventListener('click', e => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tab = btn.dataset.tab;
        tabList.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('#page-settings .tab-panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`tab-${tab}`)?.classList.add('active');
        if (tab === 'users')              loadUsers();
        else if (tab === 'organizations') loadOrganizations();
        else if (tab === 'system')        loadSystemStatus();
        else if (tab === 'logs')          loadLogs();
      });
    }

    document.getElementById('add-user-btn')?.addEventListener('click', _openAddNewUserModal);
    document.getElementById('add-org-btn')?.addEventListener('click', _openNewOrgModal);

    // Users table — event delegation
    document.getElementById('users-tbody')?.addEventListener('click', e => {
      const btn    = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      if (action === 'edit-user') _openEditUserModal(id);
      // Note: change-pwd and remove-user actions were consolidated into
      // the Edit modal. The buttons no longer exist in the rendered row.
    });

    // Orgs table — event delegation. All actions (edit / deactivate / activate)
    // live inside the Edit modal now, so this only needs the edit-org handler.
    document.getElementById('orgs-tbody')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'edit-org') _openEditOrgModal(btn.dataset.id);
    });
  }

  // Clears in-memory state — called by App.resetAllState() on org switch.
  function reset() {
    const usersTbody = document.getElementById('users-tbody');
    const orgsTbody  = document.getElementById('orgs-tbody');
    const logsList   = document.getElementById('logs-list');
    if (usersTbody) usersTbody.innerHTML = '';
    if (orgsTbody)  orgsTbody.innerHTML  = '';
    if (logsList)   logsList.innerHTML   = '';
  }

  return {
    init:         initTabs,
    loadUsers,
    loadOrganizations,
    reset,
    _goLogsPage:  p => { _logsPage = p; _renderLogsPage(); },
  };
})();

/* ── App router ─────────────────────────────────────────────── */
const App = (() => {
  // minRole gates page access on the JS side — same hierarchy that
  // Auth.applyRoleVisibility() uses for sidebar items. Box Lookup is the
  // only page available to viewers; everything else requires manager+.
  const PAGES = {
    dashboard:   { label: 'Dashboard',      minRole: 'manager', init: () => Dashboard.load() },
    inventory:   { label: 'SKU View',       minRole: 'manager', init: () => InventoryList.load() },
    orders:      { label: 'Orders',         minRole: 'manager', init: () => Orders.load() },
    uploads:     { label: 'Uploads',        minRole: 'manager', init: () => Uploads.loadHistory() },
    settings:    { label: 'Settings',       minRole: 'admin',   init: () => Settings.loadUsers() },
    'box-lookup':{ label: 'Box Lookup',     minRole: 'viewer',  init: () => {} },
  };

  // First page the user lands on after login. Honors the URL hash when
  // it points at a page the user can actually access — otherwise falls
  // back to the first page their role allows (Dashboard for staff+,
  // Box Lookup for viewers).
  function _defaultLandingPage() {
    if (Auth.hasRole('manager')) return 'dashboard';
    return 'box-lookup';
  }

  let _currentPage  = null;
  let _initialized  = {};

  function navigate(pageId) {
    if (!PAGES[pageId]) return;
    // Role gate: bounce to the user's default landing page if they don't have
    // access to the requested page. This catches bookmarked URLs as well as
    // stale hashes left over from before a role change.
    const required = PAGES[pageId].minRole;
    if (required && !Auth.hasRole(required)) {
      const fallback = _defaultLandingPage();
      if (pageId !== fallback) { navigate(fallback); return; }
    }

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const pageEl = document.getElementById(`page-${pageId}`);
    const navEl  = document.querySelector(`.nav-item[data-page="${pageId}"]`);

    if (pageEl) pageEl.classList.add('active');
    if (navEl)  navEl.classList.add('active');

    const topbarTitle = document.getElementById('topbar-title');
    if (topbarTitle) topbarTitle.textContent = PAGES[pageId].label;

    _currentPage = pageId;

    if (!_initialized[pageId]) {
      _initialized[pageId] = true;
      PAGES[pageId].init?.();
    } else if (pageId === 'dashboard') {
      PAGES[pageId].init?.();
    }

    window.location.hash = pageId;
  }

  function _initSidebarToggle() {
    const STORAGE_KEY = 'patman_sidebar_collapsed';
    const toggleBtn   = document.getElementById('sidebar-toggle');
    const expandBtn   = document.getElementById('sidebar-expand-btn');
    const mobileBtn   = document.getElementById('topbar-menu-btn');
    const backdrop    = document.getElementById('sidebar-backdrop');
    const MOBILE_BREAKPOINT = 768;
    // Tablet / narrow-desktop band: default to icon-only so the sidebar
    // doesn't eat half the canvas. Above this the user's stored preference
    // (or the expanded default) takes over.
    const TABLET_BREAKPOINT = 1100;

    const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
    const isTablet = () => window.matchMedia(`(max-width: ${TABLET_BREAKPOINT}px)`).matches
                        && !isMobile();

    // Initial state:
    //   • mobile  → leave sidebar expanded markup (off-canvas drawer handles visibility)
    //   • tablet  → auto-collapse if user hasn't explicitly stored a preference
    //   • desktop → honor stored preference
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === '1') {
      document.body.classList.add('sidebar-collapsed');
    } else if (stored === null && isTablet()) {
      document.body.classList.add('sidebar-collapsed');
    }

    // Desktop/tablet collapse toggle — collapses to icon-only rail.
    const toggleDesktopCollapse = () => {
      const collapsed = document.body.classList.toggle('sidebar-collapsed');
      localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    };

    // Mobile off-canvas open/close — slides the sidebar in over the page.
    const openMobile  = () => document.body.classList.add('sidebar-mobile-open');
    const closeMobile = () => document.body.classList.remove('sidebar-mobile-open');

    toggleBtn?.addEventListener('click', () => {
      if (isMobile()) closeMobile();
      else            toggleDesktopCollapse();
    });

    expandBtn?.addEventListener('click', () => {
      if (isMobile()) closeMobile();
      else            toggleDesktopCollapse();
    });

    mobileBtn?.addEventListener('click', openMobile);
    backdrop?.addEventListener('click', closeMobile);

    // Close offcanvas after navigating on mobile so the page is visible.
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => { if (isMobile()) closeMobile(); });
    });

    // Escape closes the mobile offcanvas.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.body.classList.contains('sidebar-mobile-open')) {
        closeMobile();
      }
    });

    // If the viewport crosses the breakpoint, drop the mobile-open state so the
    // sidebar doesn't get stuck in an inappropriate visibility on resize.
    // Also re-apply the tablet auto-collapse when crossing the tablet band so
    // that resizing from desktop down to tablet collapses the rail.
    let _lastTablet = isTablet();
    window.addEventListener('resize', () => {
      if (!isMobile()) closeMobile();
      const nowTablet = isTablet();
      if (nowTablet !== _lastTablet) {
        const userPref = localStorage.getItem(STORAGE_KEY);
        // Only auto-flip when the user hasn't pinned a preference for this
        // session. Once they toggle the rail manually the stored value wins.
        if (userPref === null) {
          document.body.classList.toggle('sidebar-collapsed', nowTablet);
        }
        _lastTablet = nowTablet;
      }
    });
  }

  function _bindNav() {
    document.querySelectorAll('.nav-item[data-page]').forEach(item => {
      item.addEventListener('click', () => navigate(item.dataset.page));
    });

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
      const confirmed = await Modal.confirm({
        title:       'Sign out',
        message:     'Are you sure you want to sign out?',
        confirmText: 'Sign out',
        danger:      false,
      });
      if (confirmed) Auth.logout();
    });

    _initSidebarToggle();
  }

  function _bindSidebarUser() {
    const user = Auth.getUser();
    const org  = Auth.getOrganization();
    if (!user) return;
    Utils.setText('.sidebar-user-name', user.display_name || user.username || '?');
    Utils.setText('.sidebar-user-role', org ? Utils.capitalize(org.role) : '—');
    const av = document.querySelector('.sidebar-avatar');
    if (av) av.textContent = (user.display_name || user.username || '?')[0].toUpperCase();

    // Org switcher
    const memberships = Auth.getMemberships();
    const switcherEl  = document.getElementById('org-switcher');
    const orgNameEl   = document.getElementById('current-org-name');
    if (orgNameEl) orgNameEl.textContent = org?.display_name || '—';
    if (switcherEl) switcherEl.style.display = memberships.length > 1 ? '' : 'none';
  }

  // Idempotent — binds the org switcher once per session, even if showApp()
  // is called multiple times (e.g., after switching orgs).
  let _orgSwitcherBound = false;
  function _bindOrgSwitcher() {
    if (_orgSwitcherBound) return;
    const switcher = document.getElementById('org-switcher');
    const dropdown = document.getElementById('org-switcher-dropdown');
    const trigger  = document.getElementById('org-switcher-trigger');
    if (!switcher || !dropdown || !trigger) return;
    _orgSwitcherBound = true;

    function _renderDropdown() {
      const memberships = Auth.getMemberships();
      const currentOrg  = Auth.getOrganization();
      dropdown.innerHTML = memberships.map(m => {
        const active = m.membership_id === currentOrg?.membership_id;
        return `
          <div class="org-switch-item${active ? ' active' : ''}"
               data-membership-id="${Utils.escapeHtml(m.membership_id)}">
            <div class="org-switch-item-text">
              <div class="org-switch-item-name">${Utils.escapeHtml(m.display_name)}</div>
              <div class="org-switch-item-role">${Utils.escapeHtml(Utils.capitalize(m.role || ''))}</div>
            </div>
            ${active ? '<i data-lucide="check" class="icon org-switch-item-check" aria-hidden="true"></i>' : ''}
          </div>`;
      }).join('');
      // The icons MutationObserver picks up the new <i data-lucide> nodes,
      // but call refresh() anyway to render them on the same tick.
      Icons?.refresh?.();
    }

    function _open() {
      _renderDropdown();
      switcher.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }
    function _close() {
      switcher.classList.remove('is-open');
      trigger.setAttribute('aria-expanded', 'false');
    }
    function _toggle() {
      if (switcher.classList.contains('is-open')) _close(); else _open();
    }

    // Trigger button toggles the dropdown
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      _toggle();
    });

    // Dropdown item click → switch org
    dropdown.addEventListener('click', async e => {
      const item = e.target.closest('[data-membership-id]');
      if (!item) return;
      e.stopPropagation();
      _close();
      const mid = item.dataset.membershipId;
      if (mid && mid !== Auth.getOrganization()?.membership_id) {
        await Auth.switchOrg(mid);
        _bindSidebarUser();
      }
    });

    // Click anywhere outside → close
    document.addEventListener('click', e => {
      if (!switcher.contains(e.target)) _close();
    });

    // Esc to close
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') _close();
    });
  }

  function showApp() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('login-screen')?.style.setProperty('display', 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', 'none');
    const shell = document.getElementById('app-shell');
    if (shell) shell.style.display = 'flex';

    _bindSidebarUser();
    _bindOrgSwitcher();
    Auth.applyRoleVisibility();
    Auth.startIdleWatch();

    const hash = window.location.hash.replace('#', '');
    navigate(PAGES[hash] ? hash : _defaultLandingPage());
  }

  // Full frontend state reset. Called on org switch BEFORE rendering the new org.
  // Clears: KPI cache, page init memory, current-page pointer, and each module's
  // in-memory state. After this call, the next navigate() will fetch fresh data.
  function resetAllState() {
    try { MetricsEngine.invalidate(); } catch {}
    _initialized = {};
    _currentPage = null;
    [Dashboard, InventoryList, BoxLookup, Orders, Uploads, Settings].forEach(mod => {
      try { mod?.reset?.(); } catch (err) { console.warn('module reset failed', err); }
    });
  }

  function showLogin() {
    document.getElementById('loading-screen')?.style.setProperty('display', 'none');
    document.getElementById('app-shell')?.style.setProperty('display', 'none');
    document.getElementById('org-selector-screen')?.style.setProperty('display', 'none');
    const login = document.getElementById('login-screen');
    if (login) login.style.display = 'flex';
  }

  function _bindFilterHighlights() {
    // Event delegation: highlight any filter-bar select/date-input when non-default
    document.addEventListener('change', e => {
      const el = e.target;
      if (!el.closest('.filter-bar')) return;
      if (el.tagName === 'SELECT') {
        const def = el.options[0]?.value ?? '';
        el.classList.toggle('filter-active', el.value !== def);
      } else if (el.type === 'date') {
        el.classList.toggle('filter-active', el.value !== '');
      }
    });
  }

  // Clears filter-active state on all filter-bar elements (call after programmatic resets)
  function syncFilterHighlights() {
    document.querySelectorAll('.filter-bar .form-select').forEach(sel => {
      const def = sel.options[0]?.value ?? '';
      sel.classList.toggle('filter-active', sel.value !== def);
    });
    document.querySelectorAll('.filter-bar input[type="date"]').forEach(inp => {
      inp.classList.toggle('filter-active', inp.value !== '');
    });
  }

  async function boot() {
    const loading = document.getElementById('loading-screen');
    if (loading) loading.style.display = 'flex';

    Icons.init(); // process static <i data-lucide> tags + start MutationObserver

    Auth.init();
    Dashboard.init();
    BoxLookup.init();
    InventoryList.init();
    Orders.init();
    Uploads.init();
    Settings.init();
    _bindNav();
    _bindFilterHighlights();

    const ok = await Auth.checkSession();
    if (ok) {
      console.log('[AUTH] app initialized');
      showApp();
    } else {
      console.log('[AUTH] redirecting to login');
      showLogin();
    }
  }

  return { navigate, showApp, showLogin, boot, syncFilterHighlights, resetAllState };
})();

/* ── Entry point ────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.boot());
