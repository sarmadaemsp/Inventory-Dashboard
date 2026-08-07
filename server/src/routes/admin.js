import { authenticate, requireRole } from '../middleware/authenticate.js';
import { TABLES } from '../config/tables.js';

// Lazy-load the Cloud Logging client. Keeps the module import-safe even
// when the @google-cloud/logging dep isn't installed yet (e.g. local
// dev), and makes the IAM/dep dependency only matter when the operator
// actually hits the parity-report or refresh-health endpoints.
let _loggingClient = null;
async function _getLoggingClient(projectId) {
  if (_loggingClient) return _loggingClient;
  try {
    const { Logging } = await import('@google-cloud/logging');
    _loggingClient = new Logging({ projectId });
    return _loggingClient;
  } catch (err) {
    const e = new Error(
      'Cloud Logging client unavailable. Install @google-cloud/logging and ' +
      'grant roles/logging.viewer to the Cloud Run service account. ' +
      `Underlying: ${err?.message ?? err}`,
    );
    e.statusCode = 503;
    throw e;
  }
}

/**
 * Admin-only operational diagnostics.
 *
 * Routes here are NOT for normal app use — they exist for production
 * debugging and Phase A/B rollout observability. Every route is gated
 * by requireRole('admin').
 *
 * Parity-report + refresh-health read structured logs from Cloud Logging.
 * Required IAM on the Cloud Run service account:
 *   - roles/logging.viewer  (to read log entries)
 *
 * For the typed-export-table approach (alternative), point the Cloud
 * Logging "Log Router" at BigQuery and query the export table — same
 * data, no Logging API call. Not implemented here.
 */
export async function adminRoutes(fastify, {
  bq, projectId, summaryRefreshService, orgsRepo,
  storageService, cloudTasksService, refreshTokensRepo, env,
  dataRetentionService,
}) {
  const dashboardSummary = `\`${projectId}.${TABLES.DASHBOARD_SUMMARY}\``;
  const inventorySummary = `\`${projectId}.${TABLES.INVENTORY_SUMMARY}\``;
  const boxSummaryByUpc  = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_UPC}\``;
  const boxSummaryByPart = `\`${projectId}.${TABLES.BOX_SUMMARY_BY_PART}\``;

  // ───────────────────────────────────────────────────────────────────
  // GET /admin/diagnostics
  // ───────────────────────────────────────────────────────────────────
  // One-stop runtime state for the operator to verify infrastructure
  // wiring after running setup scripts. Returns enabled flags +
  // configured names for each optional subsystem so the operator
  // doesn't need to log-grep boot output.
  fastify.get('/diagnostics', { preHandler: [authenticate, requireRole('admin')] }, async (_request, reply) => {
    return reply.send({
      success: true,
      data: {
        project_id: projectId,
        gcs_staging: {
          enabled: !!storageService?.enabled,
          bucket:  env?.UPLOAD_BUCKET || null,
          // When enabled, the upload pipeline takes the LOAD JOB
          // fast path. When false, it falls back to chunked DML.
          fast_path_active: !!storageService?.enabled,
        },
        cloud_tasks: {
          enabled:        !!cloudTasksService?.enabled,
          queue_name:     env?.TASKS_QUEUE_NAME || null,
          queue_location: env?.TASKS_LOCATION   || null,
          worker_url:     env?.WORKER_BASE_URL  || null,
          invoker_sa:     env?.TASKS_INVOKER_SA || null,
        },
        refresh_tokens: {
          // false when the migration hasn't been applied; auth still
          // works in JWT-only legacy mode but revocation is disabled.
          enabled:        !(refreshTokensRepo?.isLegacyMode?.() ?? false),
          legacy_jwt_only: !!(refreshTokensRepo?.isLegacyMode?.() ?? false),
        },
        read_paths: {
          dashboard_from_summary: env?.READ_DASHBOARD_FROM_SUMMARY !== '0',
          sku_from_summary:       env?.READ_SKU_FROM_SUMMARY       !== '0',
          // Box Lookup still on live CTE — cutover pending.
          box_from_summary:       env?.READ_BOX_FROM_SUMMARY       !== '0',
        },
        parity_logging: env?.SUMMARY_PARITY_LOG === '1',
        data_retention: {
          default_days: 30,
          preserved_tables: ['users', 'organizations', 'memberships'],
          purged_tables:    ['inventory', 'orders', 'inventory_uploads', 'order_uploads', 'activity_log', 'refresh_tokens'],
        },
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /admin/purge-old-data
  // ───────────────────────────────────────────────────────────────────
  // Rolling N-day retention purge. Gated by a PIN in addition to the
  // admin role so a stolen access token alone can't trigger it.
  //
  // Body: { days?: number, pin: string }
  //   days — 1..3650, defaults to 30 when omitted
  //   pin  — must match env.RETENTION_PIN (default '1224')
  //
  // Route logs are SILENCED (logLevel: 'silent') and the service
  // logs nothing on success. Only unhandled errors emit a log line,
  // and even those omit any purge-specific identifiers. This is by
  // request — the action is intended to leave no operational trace
  // beyond the returned response body which stays in the caller's
  // browser session.
  fastify.post('/purge-old-data', {
    preHandler: [authenticate, requireRole('admin')],
    logLevel:   'silent',
  }, async (request, reply) => {
    // PIN check first so wrong-PIN attempts don't touch the service.
    // If RETENTION_PIN is unset in the environment, the endpoint is
    // disabled — the second condition still fails because we compare
    // against a non-empty supplied PIN, which can never equal the
    // empty configured one via the equality above (and we explicitly
    // reject the empty-config case here too as belt-and-suspenders).
    const suppliedPin = String(request.body?.pin ?? '');
    const configuredPin = String(env.RETENTION_PIN ?? '');
    if (!configuredPin || !suppliedPin || suppliedPin !== configuredPin) {
      return reply.code(403).send({ success: false, error: 'Invalid PIN' });
    }

    const rawDays = Number(request.body?.days ?? 30);
    const days = Number.isFinite(rawDays) && rawDays >= 1 && rawDays <= 3650
      ? Math.floor(rawDays)
      : 30;

    if (!dataRetentionService) {
      return reply.code(503).send({ success: false, error: 'Retention service unavailable' });
    }

    // Scope: the caller's current organization only. Sourced from
    // the authenticated JWT (never from the request body) so the
    // scope can't be spoofed. Cross-org data is untouchable via
    // this endpoint by design.
    const organizationId = request.user.organization_id;
    if (!organizationId) {
      return reply.code(400).send({ success: false, error: 'No organization context' });
    }

    try {
      const summary = await dataRetentionService.purgeOldData(days, organizationId);

      // Refresh only THIS org's summaries so aggregates converge.
      // Fire-and-forget — no correlating log line emitted.
      summaryRefreshService?.refresh(organizationId).catch(() => {});

      return reply.send({ success: true, data: summary });
    } catch (err) {
      request.log.error({ err: err?.message }, 'Retention purge failed');
      return reply.code(500).send({ success: false, error: err?.message || 'Purge failed' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // GET /admin/summary-status?org=<orgId>
  // ───────────────────────────────────────────────────────────────────
  // Per-table row count + most-recent refreshed_at for one org. Use this
  // to confirm summary state before flipping read paths during Phase B
  // cutover, and to diagnose stale or missing summaries.
  fastify.get('/summary-status', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const orgId = request.query.org || request.user.organization_id;
    if (!orgId) return reply.code(400).send({ success: false, error: 'org is required' });

    const tables = [
      { name: 'dashboard_summary',    ref: dashboardSummary  },
      { name: 'inventory_summary',    ref: inventorySummary  },
      { name: 'box_summary_by_upc',   ref: boxSummaryByUpc   },
      { name: 'box_summary_by_part',  ref: boxSummaryByPart  },
    ];

    const results = await Promise.all(tables.map(async ({ name, ref }) => {
      try {
        const [rows] = await bq.query({
          query: `
            SELECT
              COUNT(*) AS row_count,
              MAX(refreshed_at) AS last_refreshed_at
            FROM ${ref}
            WHERE organization_id = @organizationId
          `,
          params: { organizationId: orgId },
        });
        const r = rows[0] ?? {};
        return {
          table:             name,
          row_count:         Number(r.row_count ?? 0),
          last_refreshed_at: r.last_refreshed_at?.value ?? r.last_refreshed_at ?? null,
          status:            'ok',
        };
      } catch (err) {
        return {
          table:             name,
          row_count:         null,
          last_refreshed_at: null,
          status:            'error',
          err:               err?.message ?? String(err),
        };
      }
    }));

    return reply.send({ success: true, data: { organization_id: orgId, tables: results } });
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /admin/summary-refresh — force rebuild for one org
  // ───────────────────────────────────────────────────────────────────
  fastify.post('/summary-refresh', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const orgId = request.body?.organization_id || request.user.organization_id;
    if (!orgId) return reply.code(400).send({ success: false, error: 'organization_id is required' });
    summaryRefreshService?.refresh(orgId).catch(() => {});
    return reply.send({ success: true, data: { organization_id: orgId, scheduled: true } });
  });

  // ───────────────────────────────────────────────────────────────────
  // POST /admin/refresh-all-orgs — force rebuild for every active org
  // ───────────────────────────────────────────────────────────────────
  // Eliminates the "parity_*_missing because org never had a mutation
  // since the migration" class of parity issues. Fires refreshes
  // sequentially with the same coalescing protection used elsewhere,
  // returning the scheduled org count immediately. Operator polls
  // /admin/summary-status to confirm population.
  fastify.post('/refresh-all-orgs', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    try {
      const orgs = await orgsRepo.findAll();
      const activeOrgIds = (orgs || [])
        .filter(o => o?.is_active !== false)
        .map(o => o.organization_id)
        .filter(Boolean);

      // Fire-and-forget per org. The coalescing inside summaryRefreshService
      // means rapid repeated mutations on one org collapse to one refresh,
      // so calling all orgs at once is safe — at most we get one refresh
      // per org plus one trailing if any of them gets mutated mid-flight.
      for (const id of activeOrgIds) {
        summaryRefreshService?.refresh(id).catch(() => {});
      }
      return reply.send({
        success: true,
        data: {
          scheduled_count:    activeOrgIds.length,
          scheduled_orgs:     activeOrgIds,
        },
      });
    } catch (err) {
      request.log.error({ err }, 'refresh-all-orgs failed');
      return reply.code(500).send({ success: false, error: err?.message ?? 'Internal server error' });
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // GET /admin/parity-report?hours=24
  // ───────────────────────────────────────────────────────────────────
  // Reads parity_* events from Cloud Logging for the requested window
  // and returns a per-org structured summary. This is the go/no-go
  // signal for Phase B read-path cutover.
  //
  // Response shape:
  //   {
  //     window_hours: 24,
  //     window_start_iso: '...',
  //     ready_for_cutover: <boolean per surface>,
  //     orgs: [{
  //       organization_id, dashboard: {...}, sku: {...}, box: {...},
  //     }]
  //   }
  //
  // ready_for_cutover.dashboard = true when no parity_diff or
  // parity_summary_missing events for ANY org in the window. Same for
  // sku and box surfaces.
  fastify.get('/parity-report', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const hours = Math.max(1, Math.min(720, parseInt(request.query.hours, 10) || 24));
    const cutoff = new Date(Date.now() - hours * 3600 * 1000);
    const cutoffIso = cutoff.toISOString();

    let logging;
    try { logging = await _getLoggingClient(projectId); }
    catch (err) {
      return reply.code(err.statusCode ?? 500).send({ success: false, error: err.message });
    }

    // Events of interest. Cloud Logging structured logs use jsonPayload.event
    // as the discriminator (we emit it from pino — fastify.log routes through
    // jsonPayload by default for structured fields).
    const events = [
      'parity_match', 'parity_diff', 'parity_summary_missing',
      'parity_sku_match', 'parity_sku_diff', 'parity_sku_total_diff', 'parity_sku_summary_empty',
      'parity_box_match', 'parity_box_diff', 'parity_box_summary_empty',
    ];
    const eventFilter = events.map(e => `jsonPayload.event="${e}"`).join(' OR ');
    const filter = `(${eventFilter}) AND timestamp >= "${cutoffIso}"`;

    let entries = [];
    try {
      // Pagination loop. Cap at 10k entries to bound memory + latency.
      // For a busy 24h window this is sufficient — the report aggregates
      // counts, not individual entries.
      const MAX_ENTRIES = 10000;
      const pageSize = 1000;
      let pageToken = undefined;
      do {
        const [batch, , response] = await logging.getEntries({
          filter, pageSize, pageToken, orderBy: 'timestamp desc',
        });
        entries.push(...batch);
        pageToken = response?.nextPageToken;
        if (entries.length >= MAX_ENTRIES) break;
      } while (pageToken);
    } catch (err) {
      request.log.error({ err }, 'parity-report log query failed');
      return reply.code(503).send({
        success: false,
        error: 'Cloud Logging query failed — check service account roles/logging.viewer permission.',
        details: err?.message ?? String(err),
      });
    }

    // Aggregate per (orgId, surface, outcome).
    // surface ∈ { dashboard, sku, box }
    // outcome ∈ { match, diff, missing }
    const _surfaceFor = (event) => {
      if (event.startsWith('parity_sku_')) return 'sku';
      if (event.startsWith('parity_box_')) return 'box';
      return 'dashboard';
    };
    const _outcomeFor = (event) => {
      if (event.includes('diff'))   return 'diff';
      if (event.includes('match'))  return 'match';
      if (event.includes('missing') || event.includes('empty') || event.includes('total_diff')) return 'missing_or_total_diff';
      return 'other';
    };

    const perOrg = new Map(); // orgId -> { dashboard, sku, box }
    for (const entry of entries) {
      const payload = entry?.data ?? entry?.metadata?.jsonPayload ?? {};
      const event   = payload.event;
      const orgId   = payload.organization_id;
      if (!event || !orgId) continue;
      const surface = _surfaceFor(event);
      const outcome = _outcomeFor(event);
      if (!perOrg.has(orgId)) {
        perOrg.set(orgId, {
          dashboard: { match: 0, diff: 0, missing_or_total_diff: 0, last_diff: null },
          sku:       { match: 0, diff: 0, missing_or_total_diff: 0, last_diff: null },
          box:       { match: 0, diff: 0, missing_or_total_diff: 0, last_diff: null },
        });
      }
      const s = perOrg.get(orgId)[surface];
      if (outcome === 'match') s.match++;
      else if (outcome === 'diff') {
        s.diff++;
        if (!s.last_diff) s.last_diff = { event, when: entry.metadata?.timestamp ?? null, payload };
      } else if (outcome === 'missing_or_total_diff') s.missing_or_total_diff++;
    }

    const orgsArr = [...perOrg.entries()].map(([organization_id, s]) => ({ organization_id, ...s }));
    const anyDiff = (surface) => orgsArr.some(o => o[surface].diff > 0 || o[surface].missing_or_total_diff > 0);

    return reply.send({
      success: true,
      data: {
        window_hours:     hours,
        window_start_iso: cutoffIso,
        log_entries_scanned: entries.length,
        ready_for_cutover: {
          dashboard: !anyDiff('dashboard'),
          sku:       !anyDiff('sku'),
          box:       !anyDiff('box'),
        },
        orgs: orgsArr,
      },
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // GET /admin/refresh-health?hours=24
  // ───────────────────────────────────────────────────────────────────
  // Aggregates summary_refresh_table + summary_refresh_complete events:
  // per-org refresh count, p50/p95 duration, failure count, last failure.
  fastify.get('/refresh-health', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const hours = Math.max(1, Math.min(720, parseInt(request.query.hours, 10) || 24));
    const cutoffIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    let logging;
    try { logging = await _getLoggingClient(projectId); }
    catch (err) {
      return reply.code(err.statusCode ?? 500).send({ success: false, error: err.message });
    }

    const filter =
      `(jsonPayload.event="summary_refresh_table" OR jsonPayload.event="summary_refresh_complete") ` +
      `AND timestamp >= "${cutoffIso}"`;

    let entries = [];
    try {
      const MAX_ENTRIES = 10000;
      const pageSize = 1000;
      let pageToken = undefined;
      do {
        const [batch, , response] = await logging.getEntries({
          filter, pageSize, pageToken, orderBy: 'timestamp desc',
        });
        entries.push(...batch);
        pageToken = response?.nextPageToken;
        if (entries.length >= MAX_ENTRIES) break;
      } while (pageToken);
    } catch (err) {
      request.log.error({ err }, 'refresh-health log query failed');
      return reply.code(503).send({
        success: false,
        error: 'Cloud Logging query failed — check roles/logging.viewer permission.',
        details: err?.message ?? String(err),
      });
    }

    // Aggregate per org. Track table-level durations (from
    // summary_refresh_table) and overall refresh counts (from
    // summary_refresh_complete).
    const perOrg = new Map();
    const _ensure = (orgId) => {
      if (!perOrg.has(orgId)) {
        perOrg.set(orgId, {
          refresh_count: 0,
          table_durations_ms: [],
          failure_count: 0,
          last_failure: null,
        });
      }
      return perOrg.get(orgId);
    };

    for (const entry of entries) {
      const payload = entry?.data ?? entry?.metadata?.jsonPayload ?? {};
      const orgId   = payload.organization_id;
      if (!orgId) continue;
      const s = _ensure(orgId);
      if (payload.event === 'summary_refresh_complete') {
        s.refresh_count++;
        const allOk = payload.dashboard_ok && payload.inventory_ok && payload.box_ok;
        if (!allOk) {
          s.failure_count++;
          if (!s.last_failure) {
            s.last_failure = {
              when: entry.metadata?.timestamp ?? null,
              dashboard_ok: !!payload.dashboard_ok,
              inventory_ok: !!payload.inventory_ok,
              box_ok:       !!payload.box_ok,
            };
          }
        }
      } else if (payload.event === 'summary_refresh_table') {
        if (typeof payload.duration_ms === 'number') s.table_durations_ms.push(payload.duration_ms);
        if (payload.status === 'failed' && !s.last_failure) {
          s.last_failure = {
            when: entry.metadata?.timestamp ?? null,
            table: payload.table,
            err: payload.err,
          };
        }
      }
    }

    const _pct = (arr, p) => {
      if (!arr.length) return null;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
      return sorted[idx];
    };

    const orgsArr = [...perOrg.entries()].map(([organization_id, s]) => ({
      organization_id,
      refresh_count: s.refresh_count,
      p50_table_ms:  _pct(s.table_durations_ms, 0.5),
      p95_table_ms:  _pct(s.table_durations_ms, 0.95),
      failure_count: s.failure_count,
      last_failure:  s.last_failure,
    }));

    return reply.send({
      success: true,
      data: {
        window_hours:     hours,
        window_start_iso: cutoffIso,
        log_entries_scanned: entries.length,
        orgs: orgsArr,
      },
    });
  });
}
