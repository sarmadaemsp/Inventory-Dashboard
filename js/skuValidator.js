/* ============================================================
   skuValidator.js — Phase-1 compatibility wrapper.

   New code should use window.SkuEngine.* directly. This file
   preserves the original Phase-1 surface so existing call sites
   keep working untouched.
   ============================================================ */

const SkuValidator = (() => {

  const PLACEHOLDER_VALUES = new Set(['', '"', '""', 'NA', 'N/A', '#NA', '#N/A']);
  const RE_META = /[.*+?^${}()|[\]\\]/g;

  function escapeRegexLiteral(s) {
    return String(s ?? '').replace(RE_META, '\\$&');
  }

  function parseStructure(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object')   return raw;
    try {
      const parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch { return null; }
  }

  function compileStructureRegex(struct) {
    return window.SkuEngine?.compileSegmentsRegex(window.SkuEngine.coerceToV2(struct)) ?? null;
  }

  function normalizeStructureForStorage(struct) {
    if (struct == null) return null;
    const v2 = window.SkuEngine?.coerceToV2(struct);
    if (!v2 || !v2.enabled || !v2.segments?.length) return null;
    return v2;
  }

  function isPlaceholderValue(value) {
    return PLACEHOLDER_VALUES.has(String(value ?? '').trim().toUpperCase());
  }

  function validateSku(sku, compiledRegex) {
    if (isPlaceholderValue(sku)) return { valid: false, reason: 'empty_or_placeholder' };
    if (!compiledRegex)          return { valid: true,  reason: null };
    let re;
    try { re = new RegExp(compiledRegex); }
    catch { return { valid: true, reason: null }; }
    return re.test(String(sku ?? '').trim())
      ? { valid: true, reason: null }
      : { valid: false, reason: 'structure_mismatch' };
  }

  return {
    escapeRegexLiteral,
    parseStructure,
    compileStructureRegex,
    normalizeStructureForStorage,
    isPlaceholderValue,
    validateSku,
  };
})();
