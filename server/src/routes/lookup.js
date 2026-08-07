import { authenticate } from '../middleware/authenticate.js';

export async function lookupRoutes(fastify, { lookupService }) {
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const query = (request.query.query || '').trim();
    if (!query) {
      return reply.send({ success: true, data: { query: '', byPartNumber: [], byUpc: [] } });
    }
    try {
      const data = await lookupService.search(request.user.organization_id, query);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Lookup search error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
