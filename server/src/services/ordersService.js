export function createOrdersService({ ordersRepo }) {
  async function list(organizationId, filters) {
    const { items, total } = await ordersRepo.findAll({ organizationId, ...filters });
    return {
      items,
      total,
      page:     filters.page,
      pageSize: filters.pageSize,
      pages:    Math.ceil(total / filters.pageSize),
    };
  }

  async function getPlatforms(organizationId) {
    return ordersRepo.getPlatforms(organizationId);
  }

  async function deleteRows(organizationId, { rowIds, filters }) {
    if (rowIds?.length) {
      const deleted = await ordersRepo.deleteByRowIds(organizationId, rowIds);
      return { deleted };
    }
    if (filters) {
      const deleted = await ordersRepo.deleteByFilters(organizationId, filters);
      return { deleted };
    }
    throw Object.assign(new Error('No selection criteria provided'), { code: 400 });
  }

  async function updateRow(organizationId, rowId, updates) {
    await ordersRepo.updateRow(organizationId, rowId, updates);
  }

  async function exportAll(organizationId, filters) {
    return ordersRepo.exportAll({ organizationId, ...filters });
  }

  return { list, exportAll, getPlatforms, deleteRows, updateRow };
}
