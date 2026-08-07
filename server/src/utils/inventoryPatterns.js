/**
 * inventoryPatterns — single source of truth for "undefined SKU" detection.
 *
 * An inventory row is classified as undefined when EITHER:
 *
 *   (a) ANY of its identifying columns (sku, upc, part_number) contains an
 *       empty / placeholder value — common artifacts of CSV exports (Excel,
 *       Google Sheets, Amazon Seller Central) and tab-delimited uploads.
 *
 *   (b) The SKU fails the organization's configured structure regex (see
 *       server/src/utils/skuValidator.js). When the org has no structure
 *       configured, only check (a) applies — legacy behavior.
 *
 * Placeholder values (case-insensitive, whitespace-trimmed):
 *   ''         — empty / null
 *   '"'        — single double-quote (CSV import remnant)
 *   '""'       — double double-quote (CSV import remnant)
 *   'NA'       — common shorthand for "not available"
 *   'N/A'      — same, with slash
 *   '#NA'      — Excel error-code variant
 *   '#N/A'     — Excel error-code variant
 *
 * IMPORTANT: every SQL query that classifies undefined rows MUST use
 * isUndefinedSql() / isUndefinedRowSql() so the rules stay consistent
 * across pages. Frontend mirror lives in js/inventory.js.
 *
 * Structure-regex param contract:
 *   - Pass { regexParam: 'sku_regex' } to add a "OR NOT REGEXP_CONTAINS(sku, @sku_regex)"
 *     clause that fires only when the SKU column is the one being checked AND
 *     the regex parameter is non-empty. The caller MUST bind @sku_regex when
 *     using this option; the SQL is COALESCE-guarded so a NULL/empty param
 *     leaves the predicate equivalent to the placeholder-only check.
 */

const UNDEFINED_PATTERN_LIST = ["''", "'\"'", "'\"\"'", "'NA'", "'N/A'", "'#NA'", "'#N/A'"];

/**
 * Build the IN-clause comparison SQL fragment for a single column.
 *
 *   isUndefinedSql('sku')
 *     → UPPER(TRIM(COALESCE(sku, ''))) IN ('','"','""','NA','N/A','#NA','#N/A')
 *
 *   isUndefinedSql('sku', { regexParam: 'sku_regex' })
 *     → (
 *         UPPER(TRIM(COALESCE(sku, ''))) IN ('','"','""','NA','N/A','#NA','#N/A')
 *         OR (
 *           COALESCE(@sku_regex, '') != ''
 *           AND NOT REGEXP_CONTAINS(UPPER(IFNULL(sku, '')), @sku_regex)
 *         )
 *       )
 *
 * D1 fix (Option A): the regex check ALWAYS uppercases the SKU before
 * matching. This pairs with `compileSegmentsRegex` emitting uppercase-only
 * character classes (`[A-Z0-9]+`, never `[A-Za-z0-9]+`) so that the
 * BigQuery RE2 case-sensitive default never falsely classifies a
 * mixed-case SKU as "undefined". The JS-side modal validator already does
 * this via `normalizeSku().toUpperCase()` — now backend matches.
 *
 * The regex addendum only fires for the SKU column — UPC and part-number
 * have their own validation domain and are not subject to the SKU pattern.
 * Caller indicates "this is the SKU column" by passing the `isSku: true`
 * option (default true when the column literal ends with 'sku').
 */
export function isUndefinedSql(column, opts = {}) {
  const placeholderClause = `UPPER(TRIM(COALESCE(${column}, ''))) IN (${UNDEFINED_PATTERN_LIST.join(', ')})`;

  const isSku = opts.isSku !== undefined
    ? Boolean(opts.isSku)
    : /(^|\.)sku$/i.test(String(column));

  if (!opts.regexParam || !isSku) return placeholderClause;

  const param = String(opts.regexParam).replace(/[^a-zA-Z0-9_]/g, '');
  return `(
    ${placeholderClause}
    OR (
      COALESCE(@${param}, '') != ''
      AND NOT REGEXP_CONTAINS(UPPER(IFNULL(${column}, '')), @${param})
    )
  )`;
}

/**
 * Build the full "row is undefined" predicate across sku, upc, part_number.
 *
 *   isUndefinedRowSql('i')
 *     → (i.sku placeholder OR i.upc placeholder OR i.part_number placeholder)
 *
 *   isUndefinedRowSql('i', { regexParam: 'sku_regex' })
 *     → adds the structure-regex check onto the i.sku clause only.
 *
 * @param {string} alias - table alias (e.g. 'i') or empty string for unqualified columns.
 * @param {{ regexParam?: string }} opts
 */
export function isUndefinedRowSql(alias = '', opts = {}) {
  const p = alias ? `${alias}.` : '';
  return `(
    ${isUndefinedSql(`${p}sku`, { ...opts, isSku: true })}
    OR ${isUndefinedSql(`${p}upc`, { isSku: false })}
    OR ${isUndefinedSql(`${p}part_number`, { isSku: false })}
  )`;
}
