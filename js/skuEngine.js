/* ============================================================
   skuEngine.js — Segment-aware SKU parser / normalizer / validator.

   Mirror of server/src/utils/skuEngine.js. The two MUST stay in
   lockstep — same input produces the same compiled regex, the
   same normalization, and the same validation verdict on both
   sides of the wire.

   Public surface (window.SkuEngine.*):
     SEGMENT_TYPES                 readonly list of supported segment types
     coerceToV2(input)             accept v1-or-v2 → return canonical v2 object
     compileSegmentsRegex(struct)  → string | null (RE2-compatible regex)
     normalizeSku(sku, struct)     → canonical-form string
     parseSku(sku, struct)         → { valid, reason, normalized, segments }

   See server/src/utils/skuEngine.js for the full structure shape doc.
   ============================================================ */

const SkuEngine = (() => {

  const PLACEHOLDER_VALUES = new Set(['', '"', '""', 'NA', 'N/A', '#NA', '#N/A']);
  const RE_META            = /[.*+?^${}()|[\]\\]/g;

  const SEGMENT_TYPES = Object.freeze(['identifier', 'part_number', 'upc', 'box', 'free_text', 'wildcard']);

  const DEFAULT_PATTERNS = Object.freeze({
    identifier:  '[A-Z][A-Z0-9]*',
    part_number: '[A-Z0-9]+',
    upc:         '\\d+',
    box:         '\\d+',
    free_text:   '[^\\s\\-_]+',
    wildcard:    '.*',
  });

  const DEFAULT_STRUCTURE_V2 = Object.freeze({
    version:          2,
    enabled:          false,
    case_insensitive: true,
    separators:       ['-'],
    segments:         [],
    compiled:         '',
  });

  function escapeRegexLiteral(s) {
    return String(s ?? '').replace(RE_META, '\\$&');
  }

  function safeRegex(pattern) {
    if (!pattern) return null;
    try { return new RegExp(pattern); } catch { return null; }
  }

  function parseStructure(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object')   return raw;
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch { return null; }
  }

  let _segCounter = 0;
  function _segId() { _segCounter += 1; return `seg_${Date.now().toString(36)}_${_segCounter}`; }

  function _normalizeSegment(seg) {
    if (!seg || typeof seg !== 'object') return null;
    const type = SEGMENT_TYPES.includes(seg.type) ? seg.type : null;
    if (!type) return null;
    return {
      id:                 typeof seg.id === 'string' && seg.id ? seg.id : _segId(),
      type,
      required:           seg.required !== false,
      values:             Array.isArray(seg.values)
        ? seg.values.map(v => String(v ?? '').trim()).filter(Boolean)
        : null,
      pattern:            typeof seg.pattern === 'string' && seg.pattern ? seg.pattern : null,
      // Per-segment "separator before". '' = no separator, undefined = fall
      // back to structure.separators[0] in _separatorBetween (legacy data).
      prefix_separator:   typeof seg.prefix_separator === 'string' ? seg.prefix_separator : undefined,
      allow_attached_box: type === 'identifier' && seg.allow_attached_box === true,
    };
  }

  function _normalizeV2(raw) {
    const out = {
      version:          2,
      enabled:          raw.enabled !== false,
      case_insensitive: raw.case_insensitive !== false,
      separators:       Array.isArray(raw.separators) && raw.separators.length
        ? raw.separators.map(s => typeof s === 'string' ? s : '')
        : ['-'],
      segments:         (Array.isArray(raw.segments) ? raw.segments : []).map(_normalizeSegment).filter(Boolean),
      compiled:         '',
    };
    out.compiled = compileSegmentsRegex(out) || '';
    return out;
  }

  function coerceToV2(input) {
    const raw = parseStructure(input);
    if (!raw) return { ...DEFAULT_STRUCTURE_V2 };

    if (Array.isArray(raw.segments)) return _normalizeV2(raw);

    // Legacy v1 → expand to v2 segment list
    const prefixes = Array.isArray(raw.prefixes)
      ? raw.prefixes.map(p => String(p ?? '').trim()).filter(Boolean)
      : [];

    const segments = [];
    if (prefixes.length) {
      segments.push({
        id: _segId(), type: 'identifier', required: true,
        values: prefixes, pattern: null, allow_attached_box: false,
      });
    }
    segments.push({ id: _segId(), type: 'box',         required: true, pattern: raw.box_pattern  || DEFAULT_PATTERNS.box,         values: null, allow_attached_box: false });
    segments.push({ id: _segId(), type: 'upc',         required: true, pattern: raw.upc_pattern  || DEFAULT_PATTERNS.upc,         values: null, allow_attached_box: false });
    segments.push({ id: _segId(), type: 'part_number', required: true, pattern: raw.part_pattern || DEFAULT_PATTERNS.part_number, values: null, allow_attached_box: false });

    return _normalizeV2({
      enabled:          raw.enabled !== false && prefixes.length > 0,
      case_insensitive: true,
      separators:       [typeof raw.separator === 'string' ? raw.separator : '-'],
      segments,
    });
  }

  function _segmentBody(seg) {
    if (seg.type === 'identifier') {
      if (seg.values?.length) return `(?:${seg.values.map(escapeRegexLiteral).join('|')})`;
      return `(?:${DEFAULT_PATTERNS.identifier})`;
    }
    if (seg.type === 'wildcard') return DEFAULT_PATTERNS.wildcard;
    const pat = seg.pattern || DEFAULT_PATTERNS[seg.type];
    return `(?:${pat})`;
  }

  function _capturingSegmentBody(seg) {
    if (seg.type === 'identifier') {
      if (seg.values?.length) return `(${seg.values.map(escapeRegexLiteral).join('|')})`;
      return `(${DEFAULT_PATTERNS.identifier})`;
    }
    if (seg.type === 'wildcard') return `(${DEFAULT_PATTERNS.wildcard})`;
    const pat = seg.pattern || DEFAULT_PATTERNS[seg.type];
    return `(${pat})`;
  }

  function _separatorBetween(prevSeg, nextSeg, structure) {
    const attachedBoxRelax = prevSeg?.type === 'identifier' && prevSeg.allow_attached_box && nextSeg?.type === 'box';

    // Per-segment field takes priority. typeof check distinguishes "explicitly
    // empty" (= concatenate) from "absent" (= fall through to legacy global).
    if (typeof nextSeg.prefix_separator === 'string') {
      const sep = nextSeg.prefix_separator;
      if (sep === '') return '';
      const lit = escapeRegexLiteral(sep);
      return attachedBoxRelax ? `(?:${lit})?` : lit;
    }

    // Legacy: structure-level separator list.
    const seps    = Array.isArray(structure.separators) ? structure.separators : ['-'];
    const allowed = seps.filter(s => s !== '');
    const allowEmpty = seps.includes('') || attachedBoxRelax;
    if (!allowed.length) return '';
    const charClass = allowed.length === 1
      ? escapeRegexLiteral(allowed[0])
      : `[${allowed.map(escapeRegexLiteral).join('')}]`;
    return allowEmpty ? `(?:${charClass})?` : `(?:${charClass})`;
  }

  function compileSegmentsRegex(structure) {
    const s = (structure && typeof structure === 'object') ? structure : null;
    if (!s || s.enabled === false) return null;
    const segs = Array.isArray(s.segments) ? s.segments.filter(seg => seg && SEGMENT_TYPES.includes(seg.type)) : [];
    if (!segs.length) return null;

    let body = '';
    for (let i = 0; i < segs.length; i++) {
      const seg     = segs[i];
      const prev    = i > 0 ? segs[i - 1] : null;
      const sepPiece = prev ? _separatorBetween(prev, seg, s) : '';
      const segBody  = _segmentBody(seg);
      if (seg.required) body += sepPiece + segBody;
      else              body += prev ? `(?:${sepPiece}${segBody})?` : `(?:${segBody})?`;
    }
    return `^${body}$`;
  }

  function normalizeSku(rawSku, structure) {
    const s = (structure && typeof structure === 'object') ? structure : null;
    let sku = String(rawSku ?? '').trim();
    if (!sku) return sku;
    if (!s) return sku;
    if (s.case_insensitive !== false) sku = sku.toUpperCase();

    const seps    = Array.isArray(s.separators) ? s.separators : ['-'];
    const allowed = seps.filter(c => c !== '');
    const canonical = allowed.length ? allowed[0] : '';

    if (!allowed.length) return sku.replace(/[-_]/g, '');
    if (allowed.length === 1) return sku;
    const swapRe = new RegExp(`[${allowed.map(escapeRegexLiteral).join('')}]`, 'g');
    return sku.replace(swapRe, canonical);
  }

  function isPlaceholderValue(value) {
    return PLACEHOLDER_VALUES.has(String(value ?? '').trim().toUpperCase());
  }

  function _extractSegments(sku, structure) {
    const segs = structure?.segments || [];
    if (!segs.length) return [];

    let body = '';
    for (let i = 0; i < segs.length; i++) {
      const seg     = segs[i];
      const prev    = i > 0 ? segs[i - 1] : null;
      const sepPiece = prev ? _separatorBetween(prev, seg, structure) : '';
      const segBody  = _capturingSegmentBody(seg);
      if (seg.required) body += sepPiece + segBody;
      else              body += prev ? `(?:${sepPiece}${segBody})?` : `(?:${segBody})?`;
    }
    const re = safeRegex(`^${body}$`);
    if (!re) return [];
    const m = re.exec(sku);
    if (!m) return [];
    return segs.map((seg, idx) => ({ type: seg.type, value: m[idx + 1] ?? '' })).filter(x => x.value);
  }

  function parseSku(rawSku, structure) {
    const s = (structure && typeof structure === 'object') ? structure : null;
    if (isPlaceholderValue(rawSku)) {
      return { valid: false, reason: 'empty_or_placeholder', normalized: '', segments: [] };
    }
    const normalized = normalizeSku(rawSku, s);
    const compiled = s?.compiled || compileSegmentsRegex(s);
    if (!compiled) return { valid: true, reason: null, normalized, segments: [] };
    const re = safeRegex(compiled);
    if (!re) return { valid: true, reason: null, normalized, segments: [] };
    if (!re.test(normalized)) return { valid: false, reason: 'structure_mismatch', normalized, segments: [] };
    return { valid: true, reason: null, normalized, segments: _extractSegments(normalized, s) };
  }

  // Friendly one-line summary of a structure for the Organizations table
  // column. Uses each segment's prefix_separator (falling back to legacy
  // structure.separators for older stored configs). Renders identifier
  // values inline so admins can see the pattern at a glance, e.g.
  //   "ARA - box - part_number - upc"
  function summarizeStructure(structure) {
    const s = coerceToV2(structure);
    if (!s.enabled || !s.segments?.length) return '';
    const legacySep = (s.separators || []).filter(c => c !== '')[0] || '';
    return s.segments.map((seg, i) => {
      const label = (seg.type === 'identifier' && seg.values?.length)
        ? seg.values.join('|')
        : seg.type.replace('_', ' ');
      if (i === 0) return label;
      const sep = typeof seg.prefix_separator === 'string' ? seg.prefix_separator : legacySep;
      return sep ? `${sep} ${label}` : label;
    }).join(' ');
  }

  return {
    SEGMENT_TYPES,
    coerceToV2,
    compileSegmentsRegex,
    normalizeSku,
    parseSku,
    isPlaceholderValue,
    summarizeStructure,
  };
})();
