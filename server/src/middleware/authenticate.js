// Canonical 3-tier role hierarchy. Legacy tiers (super_admin, organization_admin,
// staff, operator, user) are folded into the closest canonical tier so that
// stale JWTs from before the Phase C migration still validate during rollout.
const ROLE_LEVEL = {
  admin:                3,
  // legacy aliases — collapsed to manager:
  manager:              2,
  staff:                2,
  operator:             2,
  user:                 2,
  // legacy aliases — collapsed to viewer:
  viewer:               1,
  view:                 1,
};

// Verifies the Bearer JWT and rejects non-access tokens.
// All access tokens must carry organization_id + membership_id (org-scoped).
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
    const { type, user_id, organization_id, membership_id } = request.user;
    if (type !== 'access') {
      return reply.code(401).send({ success: false, error: 'Invalid token type' });
    }
    if (!organization_id || !membership_id) {
      return reply.code(401).send({ success: false, error: 'Token missing organization context' });
    }
    request.log = request.log.child({ user_id, organization_id, membership_id });
  } catch {
    return reply.code(401).send({ success: false, error: 'Token invalid or expired' });
  }
}

// Enforces minimum role after authenticate runs.
export function requireRole(minRole) {
  return async function (request, reply) {
    const userLevel = ROLE_LEVEL[request.user?.role] ?? 0;
    const reqLevel  = ROLE_LEVEL[minRole]             ?? 0;
    if (userLevel < reqLevel) {
      return reply.code(403).send({ success: false, error: 'Insufficient permissions' });
    }
  };
}
