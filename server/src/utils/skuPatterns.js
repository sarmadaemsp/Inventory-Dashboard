/**
 * skuPatterns — SQL fragments for SKU resolution.
 *
 * Every order has an "effective SKU" — the SKU that inventory is actually
 * deducted from. This differs from the ordered SKU when the operator
 * supplied a fulfillment override in the `shipped_sku` column. The column
 * accepts three operator-typed forms; SQL parses intent at query time:
 *
 *   "352"                              → box-only override
 *                                        effective_sku = ARA352-{original part-upc}
 *   "ARA352"                           → box-only override (same outcome)
 *   "ARA352-4060537-037256090684"      → full SKU override (verbatim)
 *
 * A row counts as "Shipped Wrong Part Number" when shipped_sku's
 * part-UPC suffix differs from the ordered SKU's part-UPC suffix
 * (i.e. the operator shipped a different part, not just a different box).
 *
 * Every analytic / lookup query that needs the effective SKU MUST use
 * effectiveSkuSql() so resolution stays consistent across pages.
 */

/**
 * Build the CASE expression that resolves to the effective SKU.
 *
 * @param {object} opts
 * @param {string} [opts.skuCol='sku']         — column / expression for ordered SKU
 * @param {string} [opts.shippedCol='shipped_sku'] — column / expression for the override
 * @returns {string} SQL CASE expression (NOT aliased — caller appends AS effective_sku)
 */
export function effectiveSkuSql({
  skuCol     = 'sku',
  shippedCol = 'shipped_sku',
} = {}) {
  // Override priority:
  //   1. Full SKU input "ARA{n}-{part}-{upc}" → use verbatim.
  //   2. Bare digits "{n}" or "ARA{n}" → rebuild ARA{n}{-original-part-upc}.
  //   3. Empty / null → original ordered SKU.
  //
  // The COALESCE(REGEXP_EXTRACT(..., r'^(?:ARA)?([0-9]+)$'), trimmed) on
  // the box-only branch handles the bare-digits and "ARA20" forms uniformly.
  return `
    CASE
      WHEN ${shippedCol} IS NOT NULL
           AND TRIM(CAST(${shippedCol} AS STRING)) != ''
           AND REGEXP_CONTAINS(TRIM(CAST(${shippedCol} AS STRING)), r'^ARA[0-9]+-.+-.+$')
      THEN TRIM(CAST(${shippedCol} AS STRING))
      WHEN ${shippedCol} IS NOT NULL
           AND TRIM(CAST(${shippedCol} AS STRING)) != ''
           AND REGEXP_CONTAINS(${skuCol}, r'^ARA[0-9]+-.+$')
      THEN CONCAT(
             'ARA',
             COALESCE(
               REGEXP_EXTRACT(TRIM(CAST(${shippedCol} AS STRING)), r'^(?:ARA)?([0-9]+)$'),
               TRIM(CAST(${shippedCol} AS STRING))
             ),
             REGEXP_EXTRACT(${skuCol}, r'^ARA[0-9]+(.+)$')
           )
      ELSE ${skuCol}
    END
  `.trim();
}

/**
 * SQL boolean expression: TRUE when shipped_sku is a full-SKU override
 * whose part-UPC suffix differs from the ordered SKU's part-UPC suffix
 * — i.e. the operator shipped a DIFFERENT part, not just a different box.
 *
 * @param {object} opts
 * @param {string} [opts.skuCol='o.sku']
 * @param {string} [opts.shippedCol='o.shipped_sku']
 * @returns {string} SQL boolean expression
 */
export function wrongPartSql({
  skuCol     = 'o.sku',
  shippedCol = 'o.shipped_sku',
} = {}) {
  return `(
    ${shippedCol} IS NOT NULL
    AND TRIM(CAST(${shippedCol} AS STRING)) != ''
    AND REGEXP_CONTAINS(TRIM(CAST(${shippedCol} AS STRING)), r'^ARA[0-9]+-.+-.+$')
    AND COALESCE(REGEXP_EXTRACT(TRIM(CAST(${shippedCol} AS STRING)), r'^ARA[0-9]+(.+)$'), ${shippedCol})
        != COALESCE(REGEXP_EXTRACT(${skuCol}, r'^ARA[0-9]+(.+)$'), ${skuCol})
  )`.trim();
}
