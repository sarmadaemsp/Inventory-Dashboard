import { randomUUID } from 'crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';

import { env } from './config/env.js';
import bigqueryPlugin from './plugins/bigquery.js';
import { createTokenFactory } from './auth/tokens.js';

import { createOrganizationsRepository } from './repositories/organizationsRepository.js';
import { createUsersRepository } from './repositories/usersRepository.js';
import { createMembershipsRepository } from './repositories/membershipsRepository.js';
import { createInventoryRepository } from './repositories/inventoryRepository.js';
import { createOrdersRepository } from './repositories/ordersRepository.js';
import { createDashboardRepository } from './repositories/dashboardRepository.js';
import { createUploadsRepository } from './repositories/uploadsRepository.js';
import { createActivityRepository } from './repositories/activityRepository.js';
import { createLookupRepository } from './repositories/lookupRepository.js';
import { createRefreshTokensRepository } from './repositories/refreshTokensRepository.js';

import { createAuthService } from './services/authService.js';
import { createInventoryService } from './services/inventoryService.js';
import { createOrdersService } from './services/ordersService.js';
import { createDashboardService } from './services/dashboardService.js';
import { createInventoryMetricsService } from './services/inventoryMetricsService.js';
import { createSummaryRefreshService } from './services/summaryRefreshService.js';
import { createCloudTasksService } from './services/cloudTasksService.js';
import { createStorageService } from './services/storageService.js';
import { createDataRetentionService } from './services/dataRetentionService.js';
import { createUploadsService } from './services/uploadsService.js';
import { createUsersService } from './services/usersService.js';
import { createUsernameService } from './services/usernameService.js';
import { createActivityService } from './services/activityService.js';
import { createLookupService } from './services/lookupService.js';

import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { inventoryRoutes } from './routes/inventory.js';
import { ordersRoutes } from './routes/orders.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { uploadsRoutes } from './routes/uploads.js';
import { usersRoutes } from './routes/users.js';
import { membershipsRoutes } from './routes/memberships.js';
import { organizationsRoutes } from './routes/organizations.js';
import { activityRoutes } from './routes/activity.js';
import { lookupRoutes } from './routes/lookup.js';
import { adminRoutes } from './routes/admin.js';
import { tasksRoutes } from './routes/tasks.js';

export async function buildApp() {
  const fastify = Fastify({
    bodyLimit: 20 * 1024 * 1024, // 20 MB — covers large JSON payloads
    logger: {
      level:     env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
      serializers: {
        err: (err) => ({ type: err.name, message: err.message, stack: err.stack }),
      },
    },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  fastify.addHook('onSend', (request, reply, _payload, done) => {
    reply.header('x-request-id', request.id);
    done();
  });

  fastify.addHook('onRequest', (request, _reply, done) => {
    const traceHeader = request.headers['x-cloud-trace-context'];
    if (traceHeader) {
      const traceId = traceHeader.split('/')[0];
      request.log = request.log.child({
        'logging.googleapis.com/trace': `projects/${env.GCP_PROJECT_ID}/traces/${traceId}`,
      });
    }
    done();
  });

  fastify.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? error.status ?? 500;
    const isServer   = statusCode >= 500;

    if (isServer) request.log.error({ err: error }, 'Unhandled server error');

    const body = {
      success:    false,
      error:      isServer && env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      request_id: request.id,
    };
    if (env.NODE_ENV !== 'production' && error.stack) body.stack = error.stack;

    return reply.code(statusCode).send(body);
  });

  // ── Fingerprint route — registered before ALL plugins and after() blocks.
  // If this 404s, the container image itself is wrong (not a code bug).
  const BUILD_TS  = new Date().toISOString();
  const BUILD_TAG = 'memberships-v2-uploads-pipeline';
  console.log(`[BOOT] buildApp() started  build=${BUILD_TAG}  ts=${BUILD_TS}`);

  fastify.get('/debug/version', async (_req, reply) => {
    return reply.send({
      build_tag:   BUILD_TAG,
      build_ts:    BUILD_TS,
      jwt_version: 'memberships-v2',
      node_env:    env.NODE_ENV,
      project_id:  env.GCP_PROJECT_ID,
    });
  });

  fastify.register(helmet, { global: true });

  // ── CORS ────────────────────────────────────────────────────────────
  // The production GitHub Pages frontend is pinned here so a missing /
  // misconfigured Cloud Run env var can never break the live site. Any
  // additional origins (dev, preview deployments) come from CORS_ORIGIN.
  // No `credentials` — we use JWT in the Authorization header, no cookies.
  const HARDCODED_ALLOWED = new Set([
    'https://mughalfaizan0034-dotcom.github.io',
    'https://sarmadaemsp.github.io',
  ]);
  const envAllowed     = new Set(env.CORS_ORIGIN.filter(o => o !== '*'));
  const wildcardAllowed = env.CORS_ORIGIN.includes('*');
  console.log(`[BOOT] CORS allowlist  hardcoded=[${[...HARDCODED_ALLOWED].join(',')}]  env=[${[...envAllowed].join(',')}]  wildcard=${wildcardAllowed}`);

  fastify.register(cors, {
    origin: (origin, cb) => {
      // Non-browser requests (curl, server-to-server) carry no Origin —
      // allow so health checks and internal probes pass through cleanly.
      if (!origin) return cb(null, true);
      if (wildcardAllowed) return cb(null, true);
      if (HARDCODED_ALLOWED.has(origin) || envAllowed.has(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  fastify.register(jwt, { secret: env.JWT_SECRET });
  fastify.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB per file
  });
  fastify.register(sensible);
  fastify.register(bigqueryPlugin);

  fastify.after(() => {
    // console.log goes straight to Cloud Run stdout, bypasses pino formatting.
    console.log(`[BOOT] after() entered  build=${BUILD_TAG}  ts=${BUILD_TS}`);

    const deps = { bq: fastify.bq, projectId: env.GCP_PROJECT_ID };

    // Repositories
    const orgsRepo         = createOrganizationsRepository(deps);
    const usersRepo        = createUsersRepository(deps);
    const membershipsRepo  = createMembershipsRepository(deps);
    const inventoryRepo    = createInventoryRepository({ ...deps });
    const ordersRepo       = createOrdersRepository(deps);
    const dashboardRepo    = createDashboardRepository(deps);
    const uploadsRepo      = createUploadsRepository(deps);
    const activityRepo     = createActivityRepository(deps);
    const lookupRepo       = createLookupRepository({ ...deps, logger: fastify.log });
    const refreshTokensRepo = createRefreshTokensRepository({ ...deps, logger: fastify.log });
    // Boot-time probe: fire a cheap getActive() against a never-used
    // JTI. This forces the repo to discover whether the
    // refresh_tokens table exists before any auth request hits the
    // server. If missing, the structured warning surfaces in startup
    // logs (instead of being deferred to the first user-facing 500
    // that we then degrade from). Non-blocking — auth boots either way.
    refreshTokensRepo.getActive('__boot_probe__').catch(() => {});

    // Services
    const usernameService  = createUsernameService({ usersRepo });
    const authService      = createAuthService({ usersRepo, membershipsRepo });
    const inventoryService = createInventoryService({ inventoryRepo });
    const ordersService    = createOrdersService({ ordersRepo });
    const metricsService   = createInventoryMetricsService({ ...deps, orgsRepo, logger: fastify.log });
    // summaryRefreshService rebuilds the materialized summary tables for one
    // org after every mutating operation. It is the ONLY writer to those
    // tables. Inject `fastify.log` as the structured logger so its non-fatal
    // failures show up in Cloud Run logs alongside the originating request.
    const summaryRefreshService = createSummaryRefreshService({ ...deps, orgsRepo, logger: fastify.log });
    // dashboardService also reads dashboard_summary for Phase A parity logging
    // (only fires when env SUMMARY_PARITY_LOG=1). The bq + projectId injection
    // lets it run the comparison read without depending on the metrics service.
    const dashboardService = createDashboardService({ dashboardRepo, metricsService, ...deps, logger: fastify.log });
    // Phase B (2026-05-18): GCS staging service for BigQuery LOAD JOB
    // ingest. When UPLOAD_BUCKET isn't set, `enabled` stays false and
    // the upload pipeline falls back to the pre-Phase-B DML chunked
    // path — same correctness, slower. Operator wires this once.
    const storageService = createStorageService({
      bucketName: env.UPLOAD_BUCKET,
      projectId:  env.GCP_PROJECT_ID,
      logger:     fastify.log,
    });
    console.log(`[BOOT] GCS staging  enabled=${storageService.enabled}  bucket=${env.UPLOAD_BUCKET || '(unset)'}`);
    const uploadsService   = createUploadsService({ uploadsRepo, storageService, logger: fastify.log });
    // usersService receives refreshTokensRepo so password changes /
    // deactivations revoke every active refresh token for that user
    // (audit C2 fix). Wired here so the service has the dependency
    // before any route handler can call updateGlobalUser.
    // cloudTasksService enqueues summary-refresh tasks for the async
    // upload lifecycle. When the 4 TASKS_* env vars aren't all set, it
    // automatically falls back to inline refresh — same correctness,
    // just no out-of-band scheduling. See createCloudTasksService docs.
    const cloudTasksService = createCloudTasksService({
      projectId:      env.GCP_PROJECT_ID,
      location:       env.TASKS_LOCATION,
      queueName:      env.TASKS_QUEUE_NAME,
      workerBaseUrl:  env.WORKER_BASE_URL,
      invokerSA:      env.TASKS_INVOKER_SA,
      summaryRefreshService,
      uploadsRepo,
      logger:         fastify.log,
    });
    console.log(`[BOOT] Cloud Tasks  enabled=${cloudTasksService.enabled}  queue=${env.TASKS_QUEUE_NAME || '(unset)'}  worker=${env.WORKER_BASE_URL || '(unset)'}`);
    // Rolling N-day retention purge (default 30 days). Preserves
    // users / organizations / memberships; purges everything else
    // older than the cutoff. Exposed via POST /admin/purge-old-data;
    // recommended cadence is daily via Cloud Scheduler.
    const dataRetentionService = createDataRetentionService({
      bq:        deps.bq,
      projectId: deps.projectId,
      logger:    fastify.log,
    });
    const usersService     = createUsersService({ usersRepo, membershipsRepo, usernameService, refreshTokensRepo });
    const activityService  = createActivityService({ activityRepo });
    const lookupService    = createLookupService({ lookupRepo });

    const tokenFactory = createTokenFactory(fastify);

    console.log('[BOOT] registering routes');
    fastify.register(healthRoutes);
    fastify.register(authRoutes,          { prefix: '/auth',          authService, usersRepo, membershipsRepo, tokenFactory, refreshTokensRepo });
    fastify.register(inventoryRoutes,     { prefix: '/inventory',     inventoryService, metricsService, activityService, dashboardService, summaryRefreshService });
    fastify.register(ordersRoutes,        { prefix: '/orders',        ordersService,    activityService, dashboardService, summaryRefreshService });
    fastify.register(dashboardRoutes,     { prefix: '/dashboard',     dashboardService });
    fastify.register(uploadsRoutes,       { prefix: '/uploads',       uploadsService, dashboardService, summaryRefreshService, uploadsRepo, cloudTasksService });
    fastify.register(usersRoutes,         { prefix: '/users',         usersService });
    fastify.register(membershipsRoutes,   { prefix: '/memberships',   membershipsRepo });
    fastify.register(organizationsRoutes, { prefix: '/organizations', orgsRepo, membershipsRepo, usersRepo, summaryRefreshService });
    fastify.register(activityRoutes,      { prefix: '/activity',      activityService });
    fastify.register(lookupRoutes,        { prefix: '/lookup',        lookupService });
    fastify.register(adminRoutes,         { prefix: '/admin',         ...deps, summaryRefreshService, orgsRepo, storageService, cloudTasksService, refreshTokensRepo, env, dataRetentionService });
    // Cloud Tasks worker routes — protected by OIDC verification
    // (verifies the JWT was signed by TASKS_INVOKER_SA with the
    // expected audience). Not user-callable.
    fastify.register(tasksRoutes,         { prefix: '/tasks',         summaryRefreshService, uploadsRepo, env });
    console.log('[BOOT] all route plugins registered');

    if (process.env.DEBUG_ROUTES === 'true') {
      fastify.get('/debug/routes', async () => ({ routes: fastify.printRoutes({ commonPrefix: false }) }));
    }
  });

  fastify.addHook('onReady', async () => {
    const routeTable = fastify.printRoutes({ commonPrefix: false });
    console.log('[onReady] route table:\n' + routeTable);
  });

  return fastify;
}

async function start() {
  const app = await buildApp();

  const shutdown = async (signal) => {
    app.log.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
