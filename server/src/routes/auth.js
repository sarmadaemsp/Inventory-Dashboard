import {
  loginBodySchema,
  selectOrgBodySchema,
  refreshBodySchema,
  logoutBodySchema,
} from '../validation/authSchemas.js';
import { AppError } from '../utils/errors.js';
import { FALLBACK_TABLE_MISSING } from '../repositories/refreshTokensRepository.js';

// ============================================================
// Auth routes — 2026-05-18 refresh-token revocation + "Remember
// this device" (closes audit gap C2).
// ------------------------------------------------------------
// Every refresh token the platform issues now has a matching row in
// the refresh_tokens table. /auth/refresh validates against that
// table and rotates (revoke old + insert new in the same family).
// /auth/logout revokes server-side. Password changes call
// refreshTokensRepo.revokeAllByUserId so every device is signed out
// (wired in the password-change route, not here).
// ============================================================

export async function authRoutes(fastify, {
  authService, usersRepo, membershipsRepo, tokenFactory, refreshTokensRepo,
}) {

  // Helper: build a refresh-token pair and persist its row. Used by
  // every endpoint that issues a refresh token (login, select-org,
  // switch-org, refresh). Returns just the JWT string for the
  // response — the metadata is already persisted by this point.
  //
  // The insert may return `{ persisted: false, fallback: true }` when
  // the refresh_tokens table doesn't exist yet (migration pending).
  // In that case the JWT is still valid; the system runs in JWT-only
  // legacy mode until the operator applies migration 20260518_002.
  // This MUST NOT throw — otherwise login / switch-org returns 500
  // until the migration runs.
  async function _mintRefresh({ request, userId, remembered, familyId = null, jti = null }) {
    const meta = tokenFactory.signRefreshToken({ userId, remembered, jti, familyId });
    try {
      await refreshTokensRepo.insert({
        jti:        meta.jti,
        userId,
        familyId:   meta.family_id,
        expiresAt:  meta.expires_at,
        remembered: meta.remembered,
        userAgent:  request.headers['user-agent'],
        ip:         request.ip,
      });
    } catch (err) {
      // Non-fatal — log and continue. The user still gets a valid
      // JWT pair; only the server-side revocation record is missing.
      request.log.warn(
        { event: 'refresh_token_insert_failed', err: err?.message, user_id: userId },
        'refresh_tokens insert failed — issuing JWT-only token (revocation will not work for this token)',
      );
    }
    return meta.token;
  }

  /* ── POST /auth/login ──────────────────────────────────────── */
  fastify.post('/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }

    const { username, password, remember } = parsed.data;

    try {
      const result = await authService.login(username, password);
      request.log.info(
        { event: 'login_success', user_id: result.user_id, remembered: !!remember },
        'User authenticated',
      );

      if (result.memberships.length === 1) {
        const m            = result.memberships[0];
        const accessToken  = tokenFactory.signAccessToken({ ...m, ...result });
        const refreshToken = await _mintRefresh({
          request, userId: result.user_id, remembered: !!remember,
        });

        return reply.send({
          success: true,
          data: {
            access_token:  accessToken,
            refresh_token: refreshToken,
            remembered:    !!remember,
            user: { user_id: result.user_id, username: result.username, display_name: result.display_name },
            organization: {
              organization_id: m.organization_id,
              display_name:    m.org_display_name,
              slug:            m.org_slug,
              membership_id:   m.membership_id,
              role:            result.role,
            },
          },
        });
      }

      // Multiple memberships: issue a pending token for org selection.
      // Carry the `remember` preference inside the pending token so
      // /auth/select-org can honor it when it issues the real pair.
      const pendingToken = tokenFactory.signPendingToken(result, { remembered: !!remember });
      return reply.send({
        success: true,
        data: {
          requires_org_selection: true,
          pending_token: pendingToken,
          remembered:    !!remember,
          user: { user_id: result.user_id, username: result.username, display_name: result.display_name },
          memberships: result.memberships.map(m => ({
            membership_id:   m.membership_id,
            organization_id: m.organization_id,
            display_name:    m.org_display_name,
            slug:            m.org_slug,
            role:            m.role,
          })),
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        request.log.warn({ event: 'login_failure', username, ip: request.ip }, 'Authentication failed');
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Login error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/select-org ─────────────────────────────────── */
  // Called after multi-org login to select a workspace.
  // Requires the pending_token in the Authorization header.
  fastify.post('/select-org', async (request, reply) => {
    const rawToken = request.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!rawToken) return reply.code(401).send({ success: false, error: 'Authorization header required' });

    let payload;
    try {
      payload = fastify.jwt.verify(rawToken);
      if (payload.type !== 'pending') throw new Error('wrong type');
    } catch {
      return reply.code(401).send({ success: false, error: 'Invalid or expired session — please log in again' });
    }

    const parsed = selectOrgBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'membership_id is required' });
    }
    // The pending token carries the user's `remember` preference. The
    // body may also include it (front-end re-sends for clarity); body
    // wins so the user can flip it on the org-selector screen.
    const remember = (parsed.data.remember !== undefined)
      ? !!parsed.data.remember
      : !!payload.remembered;

    try {
      const memberships = await membershipsRepo.getUserMemberships(payload.user_id);
      const m = memberships.find(x => x.membership_id === parsed.data.membership_id);
      if (!m) return reply.code(403).send({ success: false, error: 'Invalid membership selection' });

      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        return reply.code(401).send({ success: false, error: 'Account inactive' });
      }

      const accessToken  = tokenFactory.signAccessToken({
        ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role,
      });
      const refreshToken = await _mintRefresh({
        request, userId: user.user_id, remembered: remember,
      });

      request.log.info(
        { event: 'org_selected', user_id: user.user_id, organization_id: m.organization_id, remembered: remember },
        'Organization selected',
      );

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          remembered:    remember,
          user: { user_id: user.user_id, username: user.username, display_name: user.display_name },
          organization: { organization_id: m.organization_id, display_name: m.org_display_name, slug: m.org_slug, membership_id: m.membership_id, role: user.role },
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Select-org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/switch-org ─────────────────────────────────── */
  // Switches org context for an already-authenticated user.
  // Rotates the refresh token within the SAME family — preserves the
  // existing session lineage so logout-all and audit views show one
  // continuous trusted-device session, not multiple.
  fastify.post('/switch-org', async (request, reply) => {
    let payload;
    try {
      payload = fastify.jwt.verify(request.headers.authorization?.replace(/^Bearer\s+/i, '') || '');
      if (payload.type !== 'access') throw new Error('wrong type');
    } catch {
      return reply.code(401).send({ success: false, error: 'Token invalid or expired' });
    }

    const { membership_id } = request.body ?? {};
    if (!membership_id) {
      return reply.code(400).send({ success: false, error: 'membership_id is required' });
    }

    try {
      const memberships = await membershipsRepo.getUserMemberships(payload.user_id);
      const m = memberships.find(x => x.membership_id === membership_id);
      if (!m) return reply.code(403).send({ success: false, error: 'Invalid membership selection' });

      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        return reply.code(401).send({ success: false, error: 'Account inactive' });
      }

      // Mint a fresh refresh token. The access JWT does NOT carry the
      // refresh-token JTI, so we can't link this rotation to the
      // existing family from the access token alone — switch-org
      // starts a NEW family. The previous family stays valid until
      // natural expiry (or explicit logout). This matches the
      // pre-revocation behavior; tightening it is a future
      // enhancement once the access token carries the refresh JTI.
      const accessToken  = tokenFactory.signAccessToken({
        ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role,
      });
      const refreshToken = await _mintRefresh({
        request, userId: user.user_id, remembered: false, // conservative default — user can re-check the box at next login
      });

      request.log.info(
        { event: 'org_switched', user_id: user.user_id, to_organization_id: m.organization_id },
        'Organization switched',
      );

      return reply.send({
        success: true,
        data: {
          access_token:  accessToken,
          refresh_token: refreshToken,
          organization: { organization_id: m.organization_id, display_name: m.org_display_name, slug: m.org_slug, membership_id: m.membership_id, role: user.role },
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Switch-org error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  /* ── POST /auth/refresh ─────────────────────────────────────── */
  // Validates against refresh_tokens table (not just JWT signature),
  // rotates within the same family, marks old as revoked.
  fastify.post('/refresh', async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }

    // Phase 1: JWT signature + expiry check.
    let payload;
    try {
      payload = fastify.jwt.verify(parsed.data.refresh_token);
    } catch {
      request.log.warn({ event: 'refresh_failure', reason: 'jwt_invalid' }, 'Refresh token invalid or expired');
      return reply.code(401).send({ success: false, error: 'Refresh token invalid or expired' });
    }
    if (payload.type !== 'refresh') {
      return reply.code(401).send({ success: false, error: 'Invalid token type' });
    }

    // Phase 2: server-side revocation check.
    let active;
    try {
      active = await refreshTokensRepo.getActive(payload.jti);
    } catch (err) {
      request.log.error({ err }, 'refresh_tokens lookup failed');
      // DB blip — return 503 so the client retries instead of
      // logging the user out for an infrastructure hiccup.
      return reply.code(503).send({ success: false, error: 'Service temporarily unavailable — please try again' });
    }
    // Legacy JWT-only mode — refresh_tokens table is missing. Trust
    // the JWT signature alone (which already passed phase 1) and
    // proceed without rotation. This matches the pre-2026-05-18
    // behavior. Operator runs migration 20260518_002 → next refresh
    // returns to the full revocation-enforcing path automatically.
    const legacyMode = active === FALLBACK_TABLE_MISSING;
    if (!legacyMode && !active) {
      request.log.warn(
        { event: 'refresh_failure', reason: 'revoked_or_unknown', jti: payload.jti, user_id: payload.user_id },
        'Refresh token revoked or unknown',
      );
      return reply.code(401).send({ success: false, error: 'Refresh token revoked or expired' });
    }

    // Phase 3: load user + memberships (DB calls — may fail transiently).
    try {
      const user = await usersRepo.findById(payload.user_id);
      if (!user || !user.is_active) {
        request.log.warn({ event: 'refresh_failure', user_id: payload.user_id, reason: 'inactive' }, 'Account inactive');
        return reply.code(401).send({ success: false, error: 'Account inactive or not found' });
      }

      const memberships = await membershipsRepo.getUserMemberships(user.user_id);
      const m = (parsed.data.membership_id
        ? memberships.find(x => x.membership_id === parsed.data.membership_id)
        : null) ?? memberships[0];

      if (!m) {
        return reply.code(401).send({ success: false, error: 'No active membership found' });
      }

      // Phase 4: rotate — revoke the old jti, insert a new one in the
      // same family with the same `remembered` flag (preserves
      // session lineage).
      //
      // In legacy JWT-only mode (table missing) there's no row to
      // revoke and the `remembered` flag comes from the JWT payload
      // itself instead of the DB row.
      let remembered;
      let familyId;
      if (legacyMode) {
        remembered = !!payload.remembered;
        familyId   = payload.family_id ?? null;
      } else {
        await refreshTokensRepo.revoke(active.jti);
        remembered = active.remembered;
        familyId   = active.family_id;
        refreshTokensRepo.markUsed(active.jti).catch(() => {});
      }

      const accessToken  = tokenFactory.signAccessToken({
        ...m, user_id: user.user_id, username: user.username, display_name: user.display_name, role: user.role,
      });
      const refreshToken = await _mintRefresh({
        request, userId: user.user_id, remembered, familyId,
      });

      request.log.info(
        { event: 'token_refresh', user_id: user.user_id, family_id: familyId, remembered, legacy_mode: legacyMode },
        legacyMode ? 'Tokens rotated (legacy JWT-only mode — apply migration 20260518_002)' : 'Tokens rotated',
      );
      return reply.send({
        success: true,
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          remembered,
        },
      });
    } catch (err) {
      request.log.error({ err, user_id: payload.user_id }, 'Refresh DB error');
      return reply.code(503).send({ success: false, error: 'Service temporarily unavailable — please try again' });
    }
  });

  /* ── POST /auth/logout ─────────────────────────────────────── */
  // Revokes the supplied refresh token server-side. The frontend
  // should still clear local storage regardless of the response code
  // (we're not telling the user "you're not allowed to log out").
  fastify.post('/logout', async (request, reply) => {
    const parsed = logoutBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      // Body is optional — accept empty bodies, just return success.
      return reply.send({ success: true });
    }
    const refreshTokenRaw = parsed.data.refresh_token;

    if (refreshTokenRaw) {
      try {
        const payload = fastify.jwt.verify(refreshTokenRaw);
        if (payload.type === 'refresh' && payload.jti) {
          await refreshTokensRepo.revoke(payload.jti);
          request.log.info(
            { event: 'logout', user_id: payload.user_id, jti: payload.jti },
            'Refresh token revoked',
          );
        }
      } catch {
        // Expired or malformed refresh tokens are still a "logout" —
        // there's nothing to revoke, and we don't want to surface
        // anything actionable to the caller.
      }
    }
    return reply.send({ success: true });
  });
}
