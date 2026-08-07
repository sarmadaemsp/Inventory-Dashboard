import { TABLES } from '../config/tables.js';
import { ordersAggCTE } from '../utils/skuPivots.js';

// Inventory repo. The canonical inventory READ path (SKU View + dashboard
// KPIs) lives in inventoryMetricsService, which owns the centralized
// allocation pivot. This repo owns:
//   - mutating ops (PATCH / DELETE by row_uid)
//   - the per-SKU drilldown (raw upload rows behind a single SKU)
//   - the same-part-box alternatives lookup for order-row reassignment
//
// The legacy findAll/exportAll raw-list paths were removed when the
// inventory page switched to SKU-aggregate mode (audit M6).
export function createInventoryRepository({ bq, projectId }) {
  const invTable = `\`${projectId}.${TABLES.INVENTORY}\``;
  const ordTable = `\`${projectId}.${TABLES.ORDERS}\``;

  // Delete by row_uid — the canonical tracker. SKU is NOT the row key
  // anymore (multiple rows can share a SKU).
  async function deleteByRowUids(organizationId, rowUids) {
    if (!rowUids?.length) return 0;
    const query = `
      DELETE FROM ${invTable}
      WHERE organization_id = @organizationId AND row_uid IN UNNEST(@rowUids)
    `;
    await bq.query({ query, params: { organizationId, rowUids } });
    return rowUids.length;
  }

  async function updateRow(organizationId, rowUid, updates) {
    const query = `
      UPDATE ${invTable}
      SET
        sku         = @sku,
        upc         = @upc,
        quantity    = @quantity,
        part_number = @partNumber,
        box_number  = @boxNumber,
        notes       = @notes,
        date_added  = @dateAdded,
        updated_at  = CURRENT_TIMESTAMP()
      WHERE row_uid = @rowUid AND organization_id = @organizationId
    `;
    await bq.query({
      query,
      params: {
        organizationId,
        rowUid,
        sku:        updates.sku,
        upc:        updates.upc,
        quantity:   updates.quantity,
        partNumber: updates.part_number ?? null,
        boxNumber:  updates.box_number  ?? null,
        notes:      updates.notes       ?? null,
        dateAdded:  updates.date_added  ?? null,
      },
      types: { partNumber: 'STRING', boxNumber: 'STRING', notes: 'STRING', dateAdded: 'STRING' },
    });
  }

  async function findAlternativeBoxes(organizationId, sku) {
    const match = sku?.match(/^ARA(\d+)-(.+)-(.+)$/);
    if (!match) return { originalBox: null, alternatives: [] };

    const [, boxNum, partNumber, upc] = match;
    // CANONICAL: bare digits, matching the form used by alternatives[].box_number
    // below and by the database columns inventory.box_number and orders.shipped_sku
    // (when stored as box-only). Returning "ARA667" here caused the popover's
    // .find() to miss the original row (Original showed Qty 0) AND the !==
    // filter to fail (original SKU appeared a second time at the bottom).
    const originalBox = boxNum;

    const query = `
      WITH inv_agg AS (
        SELECT
          box_number,
          SUM(quantity) AS total_quantity,
          ARRAY_AGG(DISTINCT sku) AS skus
        FROM ${invTable}
        WHERE organization_id = @organizationId
          AND part_number = @partNumber
          AND upc         = @upc
          AND box_number IS NOT NULL
          AND TRIM(box_number) != ''
        GROUP BY box_number
      ),
      ${ordersAggCTE({ ordTable })},
      box_orders AS (
        SELECT
          inv.box_number,
          SUM(COALESCE(o.ordered, 0)) AS total_sold
        FROM inv_agg inv,
        UNNEST(inv.skus) AS inv_sku
        LEFT JOIN orders_agg o ON o.effective_sku = inv_sku
        GROUP BY inv.box_number
      )
      SELECT
        i.box_number,
        GREATEST(i.total_quantity - COALESCE(bo.total_sold, 0), 0) AS remaining_stock
      FROM inv_agg i
      LEFT JOIN box_orders bo ON bo.box_number = i.box_number
      ORDER BY remaining_stock DESC
    `;
    const [rows] = await bq.query({
      query,
      params: { organizationId, partNumber, upc },
    });

    // Some older inventory rows may have box_number stored as "ARA20" or even
    // a full SKU "ARA20-part-upc" due to past user-entry errors. Canonicalize
    // to bare digits before exposing to the frontend popover, otherwise
    // selecting the box would store the bad form into shipped_sku.
    const _bareBox = (v) => {
      const s = String(v ?? '').trim();
      const m = s.match(/^ARA(\d+)(?:-.*)?$/i);
      return m ? m[1] : s;
    };
    const all = rows.map(r => {
      const box = _bareBox(r.box_number);
      return {
        box_number:      box,
        effective_sku:   `ARA${box}-${partNumber}-${upc}`,
        remaining_stock: Number(r.remaining_stock ?? 0),
      };
    });

    return {
      originalBox,
      originalSku: sku,
      alternatives: all,
    };
  }

  // Raw inventory rows for a single SKU — used by the Inventory (SKU View)
  // drilldown. Returns every upload entry behind the aggregated row so the
  // operator can audit / edit / delete individual rows. This is the ONLY
  // surface that exposes raw rows now that the main list is SKU-aggregated.
  async function findRawRowsBySku(organizationId, sku) {
    if (!sku) return [];
    // Order is STABLE across edits. The previous `updated_at DESC` ordering
    // shuffled rows after every save (the just-edited row jumped to the
    // top), which made operators believe a previous edit had "reverted"
    // when in fact the SAME row had just repositioned. row_uid is the
    // stable tiebreaker — never changes for a row's lifetime.
    const query = `
      SELECT
        row_uid, sku, upc, part_number, box_number, quantity,
        date_added, notes, updated_at
      FROM ${invTable}
      WHERE organization_id = @organizationId AND sku = @sku
      ORDER BY date_added DESC, row_uid ASC
    `;
    const [rows] = await bq.query({ query, params: { organizationId, sku } });
    return rows.map(r => ({
      ...r,
      updated_at: r.updated_at?.value ?? r.updated_at ?? null,
    }));
  }

  return { deleteByRowUids, updateRow, findAlternativeBoxes, findRawRowsBySku };
}
