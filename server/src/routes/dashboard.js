import { authenticate } from '../middleware/authenticate.js';

export async function dashboardRoutes(fastify, { dashboardService }) {
  fastify.get('/kpis', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const data = await dashboardService.getKPIs(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Dashboard KPIs error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/performance', { preHandler: [authenticate] }, async (request, reply) => {
    // weeks = 0  → "All time" sentinel (no date window applied)
    // weeks > 0  → trailing N weeks, clamped to a sensible upper bound
    //              (large enough to cover ~10 years of weekly buckets so
    //              the chart can render an All-time view safely).
    const raw = parseInt(request.query.weeks, 10);
    const weeks = Number.isFinite(raw) && raw === 0
      ? 0
      : Math.min(Math.max(raw || 12, 1), 520);
    const platform = request.query.platform || null;
    try {
      const data = await dashboardService.getPerformance(request.user.organization_id, weeks, platform);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Dashboard performance error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  fastify.get('/inventory-analytics', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const data = await dashboardService.getInventoryAnalytics(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Inventory analytics error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
