// Inventory service — operations that touch raw inventory rows.
//
// The canonical inventory READ path (SKU View) is handled by
// inventoryMetricsService.getSkuSummary, which reuses the same pivot CTEs
// that drive the dashboard. This service owns the mutating operations
// (PATCH / DELETE), the drilldown raw-rows query, and the same-part-box
// alternatives lookup for the order-row reassignment popover.
export function createInventoryService({ inventoryRepo }) {
  // rowUids is the canonical tracker — SKU is no longer the row key.
  async function deleteRows(organizationId, rowUids) {
    const deleted = await inventoryRepo.deleteByRowUids(organizationId, rowUids);
    return { deleted };
  }

  async function updateRow(organizationId, rowUid, updates) {
    await inventoryRepo.updateRow(organizationId, rowUid, updates);
  }

  async function findAlternatives(organizationId, sku) {
    const { originalBox, originalSku, alternatives } = await inventoryRepo.findAlternativeBoxes(organizationId, sku);
    return {
      originalBox,
      originalSku,
      alternatives,
      inStock:  alternatives.filter(a => a.remaining_stock > 0),
    };
  }

  // Raw upload rows for a single SKU (drilldown under the SKU summary).
  async function listRawBySku(organizationId, sku) {
    const items = await inventoryRepo.findRawRowsBySku(organizationId, sku);
    return { items, total: items.length };
  }

  return { deleteRows, updateRow, findAlternatives, listRawBySku };
}
