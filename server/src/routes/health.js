// Full build tag — bumped on every shipped architecture milestone.
// Used by /health, logs, and CLAUDE.md → "Build version log".
const APP_VERSION = '2026-05-18-purge-keeps-uploads-history';

// Short semantic version shown in the Settings → System Status "App
// Version" row. Bump the minor on any user-visible change, the
// major on a breaking release. The long tag above stays as the
// build identifier for logs / diagnostics.
const APP_VERSION_DISPLAY = 'v1.4';

export async function healthRoutes(fastify) {
  fastify.get('/health', { logLevel: 'warn' }, async () => {
    return {
      status:          'ok',
      version:         APP_VERSION_DISPLAY,  // short — for UI
      build:           APP_VERSION,          // full  — for logs / debugging
      timestamp:       new Date().toISOString(),
    };
  });

  fastify.get('/health/ready', { logLevel: 'warn' }, async (request, reply) => {
    try {
      await fastify.bq.query({ query: 'SELECT 1' });
      return { status: 'ok', bigquery: 'reachable', timestamp: new Date().toISOString() };
    } catch (err) {
      request.log.error({ err }, 'Readiness check failed');
      return reply.code(503).send({ status: 'error', bigquery: 'unreachable' });
    }
  });
}
