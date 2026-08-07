/**
 * skuEngine — segment-aware SKU parsing, normalization, and validation.
 *
 * Single source of truth for SKU structure logic across the server.
 * Mirrored on the frontend by js/skuEngine.js — keep both in lockstep.
 *
 *
 * ── Structure JSON (canonical v2 shape) ──────────────────────────────
 *
 *   {
 *     version:          2,
 *     enabled:          true,
 *     case_insensitive: true,
 *     separators:       ["-", "_", ""],   // "" allowed → optional separators
 *     segments: [
 *       {
 *         id:                 "seg_1",
 *         type:               "identifier",
 *         required:           true,
 *         values:             ["ARA", "BX"],  // identifier-only
 *         pattern:            null,           // ignored for identifier with values
 *         allow_attached_box: true            // identifier-only: ARA1 ≡ ARA-1
 *       },
 *       { id:"seg_2", type:"box",         required:false, pattern:"\\d+"      },
 *       { id:"seg_3", type:"part_number", required:true,  pattern:"[A-Z0-9]+" },
 *       { id:"seg_4", type:"upc",         required:true,  pattern:"\\d{6,14}" }
 *     ],
 *     compiled: "^(?:ARA|BX)(?:[-_]?\\d+)?[-_]?(?:[A-Z0-9]+)[-_]?(?:\\d{6,14})$"
 *   }
 *
 *
 * ── Segment types ────────────────────────────────────────────────────
 *
 *   identifier   admin-allowed identifier values (e.g. ARA, BX). Optional
 *                allow_attached_box collapses ARA1 / ARA-1 / ARA_1 to the
 *                same logical (identifier + box) pair.
 *   part_number  free-form pattern (default [A-Z0-9]+)
 *   upc          free-form pattern (default \d+)
 *   box          free-form pattern (default \d+)
 *   free_text    free-form pattern (default [^\s-_]+)
 *   wildcard     .*  (greedy any; used as a flexible filler)
 *
 *
 * ── Separators ───────────────────────────────────────────────────────
 *
 *   separators is a list of single-char strings, optionally containing
 *   "" to mark separators as OPTIONAL between segments.
 *
 *   ["-"]            required, must be "-"
 *   ["-", "_"]       required, must be "-" or "_"
 *   ["-", "_", ""]   optional, can be "-" or "_" or empty
 *   [""]             always empty (segments concatenate directly)
 *
 *
 * ── Backward compat with v1 shape ────────────────────────────────────
 *
 *   v1 stored:
 *     { enabled, prefixes:[…], separator, box_pattern, upc_pattern, part_pattern }
 *
 *   coerceToV2() promotes a v1 object to the v2 segment list:
 *     [identifier(values=prefixes, attached_box=false), box, upc, part_number]
 *
 *   …with separators = [v1.separator]. Same dashboard regex effectively
 *   emerges so existing Phase-1 configs keep working untouched.
 *
 *
 * ── Validation result shape ──────────────────────────────────────────
 *
 *   {
 *     valid:      boolean,
 *     reason:     null | 'empty_or_placeholder' | 'structure_mismatch',
 *     normalized: string,         // canonical-separator form, upper-cased if config says so
 *     segments:   [{ type, value }]  // populated when valid
 *   }
 *
 *
 * The compiled regex is RE2-compatible (BigQuery's regex engine) AND
 * JS-RegExp-compatible — same string works in SQL REGEXP_CONTAINS and
 * `new RegExp(...)` on the frontend.
 */

const PLACEHOLDER_VALUES = new Set(['', '"', '""', 'NA', 'N/A', '#NA', '#N/A']);
const RE_META            = /[.*+?^${}()|[\]\\]/g;

export const SEGMENT_TYPES = Object.freeze(['identifier', 'part_number', 'upc', 'box', 'free_text', 'wildcard']);

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

/**
 * Coerce any accepted input shape (v1 legacy or v2) into a fully-normalized v2
 * structure object. Always returns an object — callers should check
 * `enabled === true && segments.length > 0` before treating it as active.
 */
export function coerceToV2(input) {
  const raw = parseStructure(input);
  if (!raw) return { ...DEFAULT_STRUCTURE_V2 };

  // Detect v2 shape: presence of an array `segments` field is the marker.
  if (Array.isArray(raw.segments)) return _normalizeV2(raw);

  // Legacy v1: { prefixes, separator, box_pattern, upc_pattern, part_pattern }
  const prefixes = Array.isArray(raw.prefixes)
    ? raw.prefixes.map(p => String(p ?? '').trim()).filter(Boolean)
    : [];

  const segments = [];
  if (prefixes.length) {
    segments.push({
      id:                 _segId(),
      type:               'identifier',
      required:           true,
      values:             prefixes,
      pattern:            null,
      allow_attached_box: false,
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
    // Per-segment "separator before". Empty string = no separator (segments
    // concatenate directly). Ignored on the first segment. Falls back to the
    // structure-level separators[0] in _separatorBetween() when absent — that
    // preserves Phase-2 backward compatibility for stored structures that
    // pre-date this field.
    prefix_separator:   typeof seg.prefix_separator === 'string' ? seg.prefix_separator : undefined,
    allow_attached_box: type === 'identifier' && seg.allow_attached_box === true,
  };
}

let _segCounter = 0;
function _segId() { _segCounter += 1; return `seg_${Date.now().toString(36)}_${_segCounter}`; }

/**
 * Build the segment's intrinsic regex body (no surrounding separators, no
 * grouping). Returns a single non-capturing group string ready to drop in.
 */
function _segmentBody(seg) {
  if (seg.type === 'identifier') {
    if (seg.values?.length) return `(?:${seg.values.map(escapeRegexLiteral).join('|')})`;
    return `(?:${DEFAULT_PATTERNS.identifier})`;
  }
  if (seg.type === 'wildcard') return DEFAULT_PATTERNS.wildcard;
  const pat = seg.pattern || DEFAULT_PATTERNS[seg.type];
  return `(?:${pat})`;
}

/**
 * Build the separator regex piece between two segments.
 *
 * Resolution rules (in priority order):
 *   1. If nextSeg.prefix_separator is defined: use it literally. Empty string
 *      means "no separator" (segments concatenate directly).
 *   2. Otherwise fall back to structure.separators (legacy v2 behavior — any
 *      one of the listed chars is allowed; "" in the list makes it optional).
 *
 * Special-cased: when prevSeg is an identifier with allow_attached_box AND
 * nextSeg is "box", the separator is forced optional regardless of the rule
 * above — that's the ARA1 ≡ ARA-1 collapse the admin opted into.
 */
function _separatorBetween(prevSeg, nextSeg, structure) {
  const attachedBoxRelax = prevSeg?.type === 'identifier' && prevSeg.allow_attached_box && nextSeg?.type === 'box';

  // Per-segment field takes priority. typeof check distinguishes "explicitly
  // empty" from "absent" — the former is a positive instruction to concatenate.
  if (typeof nextSeg.prefix_separator === 'string') {
    const sep = nextSeg.prefix_separator;
    if (sep === '') return attachedBoxRelax ? '' : '';
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

/**
 * Compile the segment list into a single anchored regex usable by both
 * BigQuery's REGEXP_CONTAINS and JS `new RegExp(...)`. Returns null when
 * the structure is disabled / empty.
 */
export function compileSegmentsRegex(structure) {
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

    if (seg.required) {
      body += sepPiece + segBody;
    } else {
      // Wrap (separator + body) in an optional non-capturing group. For the
      // first segment we just wrap the body since there's no leading separator.
      body += prev ? `(?:${sepPiece}${segBody})?` : `(?:${segBody})?`;
    }
  }

  return `^${body}$`;
}

/**
 * Normalize a SKU: case-fold (if configured), and collapse all admin-allowed
 * separators to the FIRST element of structure.separators (the canonical
 * separator). When the only separator is "", separators are stripped entirely.
 */
export function normalizeSku(rawSku, structure) {
  const s = (structure && typeof structure === 'object') ? structure : null;
  let sku = String(rawSku ?? '').trim();
  if (!sku) return sku;
  if (!s) return sku;

  if (s.case_insensitive !== false) sku = sku.toUpperCase();

  const seps = Array.isArray(s.separators) ? s.separators : ['-'];
  const allowed = seps.filter(c => c !== '');
  const canonical = allowed.length ? allowed[0] : '';

  if (!allowed.length) {
    // Strip every known separator-ish character (the v2 canonical "no separator" case).
    return sku.replace(/[-_]/g, '');
  }
  if (allowed.length === 1) return sku; // single separator — nothing to canonicalize

  // Multiple separators allowed → swap them all for the canonical one.
  const swapRe = new RegExp(`[${allowed.map(escapeRegexLiteral).join('')}]`, 'g');
  return sku.replace(swapRe, canonical);
}

function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUES.has(String(value ?? '').trim().toUpperCase());
}

/**
 * Full parse + validate. Returns the canonical ValidationResult shape:
 *   { valid, reason, normalized, segments }
 */
export function parseSku(rawSku, structure) {
  const s = (structure && typeof structure === 'object') ? structure : null;

  if (isPlaceholderValue(rawSku)) {
    return { valid: false, reason: 'empty_or_placeholder', normalized: '', segments: [] };
  }

  const normalized = normalizeSku(rawSku, s);

  // No active structure → placeholder check was the only gate, and it passed.
  const compiled = s?.compiled || compileSegmentsRegex(s);
  if (!compiled) return { valid: true, reason: null, normalized, segments: [] };

  const re = safeRegex(compiled);
  if (!re) return { valid: true, reason: null, normalized, segments: [] }; // fail-open

  const ok = re.test(normalized);
  if (!ok) return { valid: false, reason: 'structure_mismatch', normalized, segments: [] };

  // Best-effort segment extraction. We don't carry capture groups in the
  // compiled regex (it's intentionally non-capturing to stay light), so we
  // re-parse against a per-segment shaped regex here. Used by the admin UI
  // preview to show the segment breakdown.
  const segments = _extractSegments(normalized, s);
  return { valid: true, reason: null, normalized, segments };
}

function _extractSegments(sku, structure) {
  const segs = structure?.segments || [];
  if (!segs.length) return [];

  // Build a capture-group version of the compiled regex.
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
  return segs.map((seg, idx) => ({ type: seg.type, value: m[idx + 1] ?? '' })).filter(s => s.value);
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
