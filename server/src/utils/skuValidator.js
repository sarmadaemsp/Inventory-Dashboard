/**
 * skuValidator — thin compatibility wrapper around skuEngine.
 *
 * Phase-1 callers used:
 *   parseStructure, compileStructureRegex, normalizeStructureForStorage,
 *   isPlaceholderValue, validateSku
 *
 * Those APIs are preserved here so existing code (orgsRepository, routes,
 * frontend) keeps working. New code should import directly from skuEngine.js.
 */
import {
  coerceToV2,
  compileSegmentsRegex,
  parseSku,
} from './skuEngine.js';

const PLACEHOLDER_VALUES = new Set(['', '"', '""', 'NA', 'N/A', '#NA', '#N/A']);

export function parseStructure(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object')   return raw;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}

/**
 * Returns the compiled RE2-compatible regex string for the org's SKU
 * structure, or null when no structure is configured.
 */
export function compileStructureRegex(structure) {
  const v2 = coerceToV2(structure);
  return compileSegmentsRegex(v2);
}

/**
 * Coerce any accepted structure shape to the canonical v2 form for storage.
 * Returns null when the input cannot be promoted into an enabled structure.
 */
export function normalizeStructureForStorage(structure) {
  if (structure == null) return null;
  const v2 = coerceToV2(structure);
  // Drop the wrapper if it ends up empty / disabled — empty structures are
  // stored as NULL on the column rather than a JSON object with no segments.
  if (!v2.enabled || !v2.segments?.length) return null;
  return v2;
}

export function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUES.has(String(value ?? '').trim().toUpperCase());
}

/**
 * Phase-1 API preserved. Returns { valid, reason } only — drop the segments
 * and normalized fields for callers that don't expect them.
 */
export function validateSku(sku, compiledRegex) {
  if (isPlaceholderValue(sku)) {
    return { valid: false, reason: 'empty_or_placeholder' };
  }
  if (!compiledRegex) return { valid: true, reason: null };
  let re;
  try { re = new RegExp(compiledRegex); }
  catch { return { valid: true, reason: null }; }
  return re.test(String(sku ?? '').trim())
    ? { valid: true, reason: null }
    : { valid: false, reason: 'structure_mismatch' };
}

// Re-export the engine entry points for code that wants the richer result.
export { coerceToV2, parseSku };
