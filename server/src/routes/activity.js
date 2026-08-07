import { authenticate } from '../middleware/authenticate.js';

export async function activityRoutes(fastify, { activityService }) {
  fastify.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    const limit = Math.min(parseInt(request.query.limit, 10) || 10, 50);
    try {
      const data = await activityService.getRecent(request.user.organization_id, limit);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Activity fetch error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
