import { authenticate } from '../middleware/authenticate.js';

export async function lookupRoutes(fastify, { lookupService }) {
  // Blank query → every box for the org (Box Lookup's default view).
  // Non-blank query → exact-match search by part_number or UPC.
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = (request.query.query || '').trim();
    try {
      const data = query
        ? await lookupService.search(request.user.organization_id, query)
        : await lookupService.listAll(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Lookup search error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
