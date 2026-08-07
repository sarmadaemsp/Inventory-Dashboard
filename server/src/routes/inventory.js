import { authenticate, requireRole } from '../middleware/authenticate.js';
import { z } from 'zod';

// SKU View (canonical inventory page): one row per SKU, with the dashboard
// engine's pivot fields. Sort/filter happen on the pivot so the per-row
// figures stay consistent with the dashboard sums.
const positiveInt = z.coerce.number().int().positive();
const skuSummaryQuerySchema = z.object({
  page:     positiveInt.optional().default(1),
  pageSize: positiveInt.max(10000).optional().default(50),
  search:   z.string().optional(),
  sort_by:  z.enum(['sku','initial','sold','fulfilled','phantom','remaining','boxes','last_added']).optional().default('sku'),
  sort_dir: z.enum(['asc','desc']).optional().default('asc'),
  status:   z.enum(['all','in_stock','oos','phantom','undefined']).optional().default('all'),
});

const inventoryPatchSchema = z.object({
  sku:        z.string().min(1),
  upc:        z.string().min(1),
  quantity:   z.coerce.number().int(),
  part_number: z.string().optional().default(''),
  box_number:  z.string().optional().default(''),
  notes:       z.string().optional().default(''),
  date_added:  z.string().optional().default(''),
});

const deleteBodySchema = z.object({
  row_uids: z.array(z.string().min(1)).min(1),
});

export async function inventoryRoutes(fastify, { inventoryService, metricsService, activityService, dashboardService, summaryRefreshService }) {
  // SKU-aggregated view — single source of truth for the Inventory page.
  // Backed by inventoryMetricsService.getSkuSummary which reuses the
  // SAME CTEs that drive dashboard KPI sums.
  fastify.get('/sku-summary', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = skuSummaryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten() });
    }
    const { sort_by, sort_dir, ...rest } = parsed.data;
    try {
      const { items, total } = await metricsService.getSkuSummary(request.user.organization_id, {
        ...rest, sortBy: sort_by, sortDir: sort_dir,
      });
      return reply.send({
        success: true,
        data: {
          items, total,
          page: rest.page, pageSize: rest.pageSize,
          pages: Math.ceil(total / rest.pageSize) || 1,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Inventory SKU summary error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // SKU summary export (CSV) — same canonical aggregate as the page, served
  // unpaginated so the operator gets the full SKU-level dataset.
  // Deliberately separate from /export (which still serves raw upload rows
  // for backwards compatibility and legacy operational audits).
  fastify.get('/sku-summary/export', { preHandler: [authenticate] }, async (request, reply) => {
    const exportSchema = skuSummaryQuerySchema.extend({
      pageSize: positiveInt.max(100000).optional().default(100000),
    });
    const parsed = exportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }
    const { sort_by, sort_dir, ...rest } = parsed.data;
    try {
      const { items } = await metricsService.getSkuSummary(request.user.organization_id, {
        ...rest, sortBy: sort_by, sortDir: sort_dir,
      });
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'SKU,Part #,UPC,Total Stock,Sold,Fulfilled,Phantom,Remaining,Boxes,Last Added';
      const lines = items.map(r => [
        r.sku, r.part_number, r.upc,
        r.total_stock, r.sold_units, r.fulfilled_units, r.phantom_units, r.remaining_units,
        r.boxes_count, r.last_added_at,
      ].map(esc).join(','));
      const isFiltered = rest.search || rest.status !== 'all';
      const filename   = `sku_view_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0,10)}.csv`;
      const csv        = '﻿' + [header, ...lines].join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      request.log.error({ err }, 'SKU summary export error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Raw-rows export for every SKU under the SKU View's current filter.
  // Backs the "Inventory List" option in the export chooser modal — the
  // operator stays in the SKU intelligence view but downloads the full
  // audit trail (every raw upload row with its UID).
  fastify.get('/sku-summary/export-raw', { preHandler: [authenticate] }, async (request, reply) => {
    const rawExportSchema = z.object({
      search: z.string().optional(),
      status: z.enum(['all','in_stock','oos','phantom','undefined']).optional().default('all'),
    });
    const parsed = rawExportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }
    try {
      const rows = await metricsService.getRawRowsForFilteredSkus(request.user.organization_id, parsed.data);
      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'UID,SKU,Box #,Part #,UPC,Initial Stock,Date Added,Notes';
      const lines  = rows.map(r => [
        r.row_uid, r.sku, r.box_number, r.part_number, r.upc,
        r.quantity, r.date_added, r.notes,
      ].map(esc).join(','));
      const isFiltered = parsed.data.search || parsed.data.status !== 'all';
      const filename   = `inventory_list_${isFiltered ? 'filtered_' : ''}export_${new Date().toISOString().slice(0,10)}.csv`;
      const csv        = '﻿' + [header, ...lines].join('\n');
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      request.log.error({ err }, 'Inventory List (raw) export error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Raw inventory rows for a single SKU — drives the SKU-row drilldown.
  fastify.get('/by-sku', { preHandler: [authenticate] }, async (request, reply) => {
    const sku = (request.query.sku || '').trim();
    if (!sku) return reply.code(400).send({ success: false, error: 'sku is required' });
    try {
      const data = await inventoryService.listRawBySku(request.user.organization_id, sku);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Inventory by-sku error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/alternatives', { preHandler: [authenticate] }, async (request, reply) => {
    const sku = request.query.sku;
    if (!sku) return reply.code(400).send({ success: false, error: 'sku is required' });
    try {
      const data = await inventoryService.findAlternatives(request.user.organization_id, sku);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Inventory alternatives error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // :id is the inventory row_uid — the canonical tracker.
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    const rowUid = decodeURIComponent(request.params.id);
    const parsed = inventoryPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    try {
      await inventoryService.updateRow(request.user.organization_id, rowUid, parsed.data);
      dashboardService?.invalidateKPICache(request.user.organization_id);
      summaryRefreshService?.refresh(request.user.organization_id).catch(() => {});
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'edit_inventory',
        entityType:     'inventory',
        description:    `Updated inventory row ${rowUid.slice(0, 8)} (SKU ${parsed.data.sku})`,
      }).catch(() => {});
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Inventory update error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  fastify.delete('/rows', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: parsed.error.errors[0]?.message || 'Invalid body' });
    }
    try {
      const result = await inventoryService.deleteRows(request.user.organization_id, parsed.data.row_uids);
      dashboardService?.invalidateKPICache(request.user.organization_id);
      summaryRefreshService?.refresh(request.user.organization_id).catch(() => {});
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'delete_inventory',
        entityType:     'inventory',
        description:    `Deleted ${result.deleted} inventory ${result.deleted === 1 ? 'row' : 'rows'}`,
      }).catch(() => {});
      return reply.send({ success: true, data: result });
    } catch (err) {
      request.log.error({ err }, 'Inventory delete error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
