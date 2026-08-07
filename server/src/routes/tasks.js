// ============================================================
// Cloud Tasks worker routes (Phase A — 2026-05-18)
// ------------------------------------------------------------
// These routes are invoked by Cloud Tasks, NOT by the browser. They
// must be protected against arbitrary public POSTs because Cloud Run
// runs with --allow-unauthenticated. The protection layer is OIDC:
//
//   1. Cloud Tasks signs an OIDC token as the configured invoker SA
//      (TASKS_INVOKER_SA env var on the queue task config).
//   2. Cloud Tasks sends the token in `Authorization: Bearer <jwt>`.
//   3. This route verifies the token via Google's tokeninfo endpoint
//      (no extra deps), checking:
//        - signature valid (Google-signed)
//        - email claim matches TASKS_INVOKER_SA
//        - audience claim matches the expected worker URL
//        - issuer claim is accounts.google.com / https://accounts.google.com
//
// We use the tokeninfo HTTP endpoint to keep dependencies thin —
// no google-auth-library required. The endpoint validates signature
// and returns claims, so we just check the claim values.
//
// Local-dev / not-yet-configured behavior:
//   When TASKS_INVOKER_SA is unset, the route refuses ALL requests
//   (401). This is safer than open access. The cloudTasksService
//   already auto-falls-back to inline refresh when the queue isn't
//   configured, so the route never gets called in that scenario.
// ============================================================

const TOKEN_INFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const ALLOWED_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

async function _verifyOidcToken({ token, expectedAudience, expectedEmail }) {
  if (!token) return { ok: false, reason: 'missing token' };
  if (!expectedEmail) return { ok: false, reason: 'TASKS_INVOKER_SA not configured' };

  // Google's tokeninfo endpoint validates the signature server-side
  // and returns the decoded claims. Simpler than wiring a JWKS verifier.
  const url = `${TOKEN_INFO_URL}?id_token=${encodeURIComponent(token)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    return { ok: false, reason: `tokeninfo fetch failed: ${err?.message}` };
  }
  if (!res.ok) return { ok: false, reason: `tokeninfo HTTP ${res.status}` };

  let claims;
  try { claims = await res.json(); }
  catch { return { ok: false, reason: 'tokeninfo non-JSON response' }; }

  if (!ALLOWED_ISSUERS.has(claims.iss)) {
    return { ok: false, reason: `bad issuer: ${claims.iss}` };
  }
  if (claims.email !== expectedEmail) {
    return { ok: false, reason: `bad email claim: ${claims.email}` };
  }
  if (expectedAudience && claims.aud !== expectedAudience) {
    return { ok: false, reason: `bad audience: ${claims.aud}` };
  }
  if (!claims.email_verified || claims.email_verified === 'false') {
    return { ok: false, reason: 'email not verified' };
  }
  return { ok: true, claims };
}

export async function tasksRoutes(fastify, {
  summaryRefreshService, uploadsRepo, env,
}) {
  const expectedEmail    = env.TASKS_INVOKER_SA;
  const expectedAudience = env.WORKER_BASE_URL
    ? `${env.WORKER_BASE_URL.replace(/\/+$/, '')}/tasks/refresh-summaries`
    : null;

  fastify.post('/refresh-summaries', { logLevel: 'info' }, async (request, reply) => {
    const auth = request.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      request.log.warn({ event: 'tasks_auth_missing' }, '/tasks/refresh-summaries: no bearer token');
      return reply.code(401).send({ success: false, error: 'Missing bearer token' });
    }
    const token = auth.slice('Bearer '.length).trim();
    const verify = await _verifyOidcToken({ token, expectedAudience, expectedEmail });
    if (!verify.ok) {
      request.log.warn({ event: 'tasks_auth_failed', reason: verify.reason }, '/tasks/refresh-summaries: OIDC verification failed');
      return reply.code(401).send({ success: false, error: 'OIDC verification failed' });
    }

    const { organizationId, uploadId, type } = request.body || {};
    if (!organizationId) {
      return reply.code(400).send({ success: false, error: 'Missing organizationId' });
    }

    const start = Date.now();
    try {
      await summaryRefreshService.refresh(organizationId);
      if (uploadId && type) {
        await uploadsRepo.markUploadRefreshed({ type, uploadId, organizationId });
      }
      request.log.info(
        {
          event:           'tasks_refresh_complete',
          organization_id: organizationId,
          upload_id:       uploadId,
          duration_ms:     Date.now() - start,
        },
        'Summary refresh worker complete',
      );
      return reply.send({ success: true });
    } catch (err) {
      request.log.error(
        { event: 'tasks_refresh_failed', err: err?.message, organization_id: organizationId },
        'Summary refresh worker failed',
      );
      // Return 5xx so Cloud Tasks retries with backoff. The refresh is
      // idempotent (MERGE-based), so duplicate execution is safe.
      return reply.code(500).send({ success: false, error: err?.message ?? 'Refresh failed' });
    }
  });
}
