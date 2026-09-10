import { authenticate } from '../middleware/authenticate.js';
import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const listAllQuerySchema = z.object({
  page:     positiveInt.optional().default(1),
  pageSize: positiveInt.max(1000).optional().default(50),
  status:   z.enum(['all', 'in_stock', 'oos', 'phantom']).optional().default('all'),
});

export async function lookupRoutes(fastify, { lookupService }) {
  // Non-blank query → exact/substring search by part_number / UPC / SKU,
  //   returned as the byPartNumber / byUpc card tree (unchanged).
  // Blank query → Box Lookup's default view: one paginated page of every
  //   box for the org, flat, numerically ordered by box_number, with an
  //   optional status filter (all / in_stock / oos / phantom).
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = (request.query.query || '').trim();
    try {
      if (query) {
        const data = await lookupService.search(request.user.organization_id, query);
        return reply.send({ success: true, data });
      }

      const parsed = listAllQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, error: 'Invalid query parameters', details: parsed.error.flatten() });
      }
      const { page, pageSize, status } = parsed.data;
      const { items, total } = await lookupService.listAllPaged(request.user.organization_id, { page, pageSize, status });
      return reply.send({
        success: true,
        data: { items, total, page, pageSize, pages: Math.ceil(total / pageSize) || 1 },
      });
    } catch (err) {
      request.log.error({ err }, 'Lookup search error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
