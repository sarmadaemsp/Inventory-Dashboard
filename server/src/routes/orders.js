import { authenticate, requireRole } from '../middleware/authenticate.js';
import { z } from 'zod';
import { normalizeShippedSku } from '../uploads/core/rowNormalizer.js';

const positiveInt = z.coerce.number().int().positive();

const STATUS_VALUES = z.enum(['all', 'normal', 'unknown', 'wrong_part']).optional().default('all');

// Reconstruct the effective shipped SKU for display / CSV export.
// Mirrors the SQL effectiveSkuSql logic for the single shipped_sku column:
//   - empty / null            → original ordered SKU
//   - full SKU "ARA{n}-..."   → verbatim
//   - bare digits / "ARA{n}"  → ARA{n}-{original part-upc}
const effectiveShippedSku = (sku, shippedSku) => {
  const v = String(shippedSku ?? '').trim();
  if (!v) return sku || '';
  if (/^ARA\d+-.+-.+$/i.test(v)) return v;
  const box = v.match(/^(?:ARA)?(\d+)$/i)?.[1];
  if (!box || !sku) return sku || v;
  const m = sku.match(/^ARA\d+(-.+)$/);
  if (!m) return sku;
  return `ARA${box}${m[1]}`;
};

const ordersExportSchema = z.object({
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
  sort_by:    z.enum(['order_date','sku','quantity_sold','platform','shipped_sku']).optional().default('order_date'),
  sort_dir:   z.enum(['asc','desc']).optional().default('desc'),
  status:     STATUS_VALUES,
});

const ordersQuerySchema = z.object({
  page:       positiveInt.optional().default(1),
  pageSize:   positiveInt.max(10000).optional().default(50),
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
  sort_by:    z.enum(['order_date', 'sku', 'quantity_sold', 'platform', 'shipped_sku']).optional().default('order_date'),
  sort_dir:   z.enum(['asc', 'desc']).optional().default('desc'),
  status:     STATUS_VALUES,
});

const deleteFiltersSchema = z.object({
  platform:   z.string().optional(),
  start_date: z.string().optional(),
  end_date:   z.string().optional(),
  search:     z.string().optional(),
});

const deleteBodySchema = z.object({
  row_ids: z.array(z.string()).min(1).optional(),
  filters: deleteFiltersSchema.optional(),
}).refine(
  data => (data.row_ids?.length > 0) || (data.filters && Object.values(data.filters).some(v => v)),
  { message: 'Provide row_ids or at least one filter criterion' }
);

const patchSchema = z.object({
  order_date:    z.string().min(1),
  quantity_sold: z.coerce.number().int().positive(),
  platform:      z.string().min(1),
  // Accepts the canonical `shipped_sku` field, with `shipped_from_box` kept
  // as a fallback for any in-flight clients still on the v=66 dashboard.
  shipped_sku:      z.string().optional(),
  shipped_from_box: z.string().optional(),
  original_sku:     z.string().optional().default(''),
});

export async function ordersRoutes(fastify, { ordersService, activityService, dashboardService, summaryRefreshService }) {
  fastify.get('/export', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = ordersExportSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }
    try {
      const { sort_by, sort_dir, status, start_date, end_date, ...rest } = parsed.data;
      const rows = await ordersService.exportAll(request.user.organization_id, {
        ...rest,
        startDate: start_date || null,
        endDate:   end_date   || null,
        sortBy:    sort_by,
        sortDir:   sort_dir,
        status:    status     || 'all',
      });

      const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = 'UID,Order ID,Order Date,SKU,Qty Sold,Shipped SKU,Status,Platform';
      const lines  = rows.map(r => [
        r.order_row_id,
        r.order_id,
        r.order_date,
        r.sku,
        r.quantity_sold,
        effectiveShippedSku(r.sku, r.shipped_sku),
        r.is_wrong_part ? 'Shipped Wrong Part Number' : (r.is_unknown ? 'Unknown' : 'Normal'),
        r.platform,
      ].map(esc).join(','));

      const filename = `orders-export-${new Date().toISOString().slice(0,10)}.csv`;
      const csv      = '﻿' + [header, ...lines].join('\n');

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      request.log.error({ err }, 'Orders export error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = ordersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid query parameters' });
    }

    const { page, pageSize, platform, start_date, end_date, search, sort_by, sort_dir, status } = parsed.data;
    try {
      const data = await ordersService.list(request.user.organization_id, {
        page, pageSize,
        platform:  platform   || null,
        startDate: start_date || null,
        endDate:   end_date   || null,
        search:    search     || null,
        sortBy:    sort_by,
        sortDir:   sort_dir,
        status:    status     || 'all',
      });
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Orders list error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  fastify.get('/platforms', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const data = await ordersService.getPlatforms(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Platforms error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  fastify.patch('/:rowId', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    const rowId  = request.params.rowId;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
    }
    const { original_sku, shipped_sku, shipped_from_box, ...rowUpdates } = parsed.data;
    // Canonical input is `shipped_sku`. `shipped_from_box` is accepted as a
    // legacy alias from any in-flight clients pre-rename.
    const shippedInput = (shipped_sku ?? '') || (shipped_from_box ?? '');
    const normalizedShippedSku = normalizeShippedSku(shippedInput);
    const updates = { ...rowUpdates, shipped_sku: normalizedShippedSku };

    try {
      await ordersService.updateRow(request.user.organization_id, rowId, updates);
      dashboardService?.invalidateKPICache(request.user.organization_id);
      summaryRefreshService?.refresh(request.user.organization_id).catch(() => {});
      const originalLabel = original_sku || rowId;
      const isFullSku     = normalizedShippedSku && /^ARA\d+-.+-.+$/i.test(normalizedShippedSku);
      const desc = !normalizedShippedSku
        ? `Reverted to original fulfillment SKU for ${originalLabel} (order ${rowId})`
        : isFullSku
          ? `Reassigned fulfillment SKU: ${originalLabel} → shipped ${normalizedShippedSku} (order ${rowId})`
          : `Reassigned fulfillment box: ${originalLabel} → box ${normalizedShippedSku} (order ${rowId})`;
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'reassign_fulfillment_sku',
        entityType:     'orders',
        description:    desc,
      }).catch(() => {});
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Order update error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.delete('/rows', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    const parsed = deleteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const msg = parsed.error.errors[0]?.message || 'Invalid request body';
      return reply.code(400).send({ success: false, error: msg });
    }

    const { row_ids, filters } = parsed.data;
    try {
      const data = await ordersService.deleteRows(request.user.organization_id, {
        rowIds:  row_ids || null,
        filters: filters ? {
          platform:  filters.platform  || null,
          startDate: filters.start_date || null,
          endDate:   filters.end_date   || null,
          search:    filters.search     || null,
        } : null,
      });
      dashboardService?.invalidateKPICache(request.user.organization_id);
      summaryRefreshService?.refresh(request.user.organization_id).catch(() => {});
      activityService?.log({
        organizationId: request.user.organization_id,
        userId:         request.user.user_id,
        actionType:     'delete_orders',
        entityType:     'orders',
        description:    `Deleted ${data.deleted} order${data.deleted !== 1 ? 's' : ''}`,
      }).catch(() => {});
      return reply.send({ success: true, data });
    } catch (err) {
      if (err.code === 400) return reply.code(400).send({ success: false, error: err.message });
      request.log.error({ err }, 'Orders delete error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
