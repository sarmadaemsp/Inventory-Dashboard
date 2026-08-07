// ============================================================
// cloudTasksService — Cloud Tasks wrapper with in-process fallback
// ------------------------------------------------------------
// Phase A (2026-05-18) async upload lifecycle uses Cloud Tasks to
// run the summary-refresh step out-of-band from the upload request.
// The flow:
//
//   Upload route                       Cloud Tasks queue                  Worker route
//   ─────────────                      ─────────────────                  ─────────────
//   POST /uploads/inventory            createTask({                       POST /tasks/refresh-summaries
//     → parse multipart                  url: workerBaseUrl                  - OIDC bearer auth
//     → createUploadJob (status=         + '/tasks/refresh-summaries',       - summaryRefreshService.refresh()
//        accepted)                       body: { orgId, uploadId },          - markUploadRefreshed()
//     → setImmediate(_processInBackground):  oidcToken: { sa, audience }
//         - pipelineRunner Phase 2-4   })
//         - finalizeUploadJob          (queued)
//         - cloudTasksService.enqueue
//           Refresh()
//     → 202 + upload_id
//
// Fallback behavior:
//   If TASKS_QUEUE_NAME / TASKS_LOCATION / WORKER_BASE_URL are unset
//   (e.g. local dev, or operator hasn't created the queue yet), the
//   `enabled` flag stays false and `enqueueRefresh()` runs the refresh
//   inline via summaryRefreshService.refresh() instead. That makes
//   this code shippable BEFORE the GCP infra exists — operator can
//   create the queue and flip env vars at any later point without a
//   code change.
//
// OIDC auth:
//   When `invokerSA` is set, the task carries an OIDC token signed by
//   that service account. The worker route validates the token's
//   issuer (accounts.google.com), email (=invokerSA), and audience
//   (=workerBaseUrl + '/tasks/refresh-summaries'). See routes/tasks.js.
// ============================================================

export function createCloudTasksService({
  projectId, location, queueName, workerBaseUrl, invokerSA,
  summaryRefreshService, uploadsRepo, logger,
}) {
  const enabled = !!(projectId && location && queueName && workerBaseUrl);
  let _client = null;
  let _queuePath = null;

  // Lazy-construct the client so we don't pull in @google-cloud/tasks
  // (and its grpc bundle) when running with the in-process fallback.
  async function _getClient() {
    if (_client) return _client;
    const mod = await import('@google-cloud/tasks');
    _client = new mod.CloudTasksClient();
    _queuePath = _client.queuePath(projectId, location, queueName);
    return _client;
  }

  // Enqueue a summary-refresh task. Returns { ok, mode } where:
  //   mode = 'queued'   → Cloud Task created, worker will pick it up
  //   mode = 'inline'   → fallback ran refresh in-process this turn
  //   mode = 'failed'   → couldn't schedule; surfaced for log/audit
  async function enqueueRefresh({ organizationId, uploadId, type }) {
    if (!organizationId) return { ok: false, mode: 'failed', reason: 'missing organizationId' };

    if (!enabled) {
      // In-process fallback — same effect, just blocks the calling
      // background task. Acceptable when Cloud Tasks isn't wired yet.
      logger?.info?.(
        { event: 'cloud_tasks_inline_fallback', organization_id: organizationId, upload_id: uploadId },
        'Cloud Tasks not configured — running summary refresh inline',
      );
      try {
        await summaryRefreshService.refresh(organizationId);
        if (uploadId && type) {
          await uploadsRepo?.markUploadRefreshed?.({ type, uploadId, organizationId });
        }
        return { ok: true, mode: 'inline' };
      } catch (err) {
        logger?.warn?.(
          { event: 'inline_refresh_failed', organization_id: organizationId, err: err?.message },
          'Inline summary refresh failed',
        );
        return { ok: false, mode: 'failed', reason: err?.message };
      }
    }

    try {
      const client = await _getClient();
      const url = `${workerBaseUrl.replace(/\/+$/, '')}/tasks/refresh-summaries`;
      const body = Buffer
        .from(JSON.stringify({ organizationId, uploadId: uploadId ?? null, type: type ?? null }))
        .toString('base64');

      const httpRequest = {
        httpMethod: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        body,
      };
      // OIDC auth: Cloud Tasks signs a token as `invokerSA` with the
      // worker URL as audience. The worker validates the signature +
      // claims before running anything.
      if (invokerSA) {
        httpRequest.oidcToken = { serviceAccountEmail: invokerSA, audience: url };
      }

      const [response] = await client.createTask({ parent: _queuePath, task: { httpRequest } });
      logger?.info?.(
        { event: 'cloud_tasks_enqueued', organization_id: organizationId, upload_id: uploadId, task_name: response.name },
        'Summary refresh task enqueued',
      );
      return { ok: true, mode: 'queued', taskName: response.name };
    } catch (err) {
      // Fall back to inline so a transient Cloud Tasks outage doesn't
      // strand the upload with stale summaries. The summary-refresh
      // path is idempotent (MERGE-based), so doing it twice is safe.
      logger?.warn?.(
        { event: 'cloud_tasks_enqueue_failed', organization_id: organizationId, err: err?.message },
        'Cloud Tasks createTask failed — running refresh inline as fallback',
      );
      try {
        await summaryRefreshService.refresh(organizationId);
        if (uploadId && type) {
          await uploadsRepo?.markUploadRefreshed?.({ type, uploadId, organizationId });
        }
        return { ok: true, mode: 'inline_after_failure' };
      } catch (e2) {
        return { ok: false, mode: 'failed', reason: e2?.message };
      }
    }
  }

  return { enabled, enqueueRefresh };
}
