import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';
import { normalizeStructureForStorage } from '../utils/skuValidator.js';
import { z } from 'zod';

// Per-org SKU structure config. Two shapes are accepted:
//
//   v2 (segment-based, canonical going forward):
//     { version:2, enabled, case_insensitive, separators:[…], segments:[…] }
//
//   v1 (legacy, still accepted for back-compat with existing clients):
//     { enabled, prefixes, separator, box_pattern, upc_pattern, part_pattern }
//
// Either is normalized to v2 server-side by normalizeStructureForStorage().
const segmentSchema = z.object({
  id:                 z.string().optional(),
  type:               z.enum(['identifier', 'part_number', 'upc', 'box', 'free_text', 'wildcard']),
  required:           z.boolean().optional(),
  values:             z.array(z.string().min(1).max(40)).max(32).nullable().optional(),
  pattern:            z.string().max(200).nullable().optional(),
  allow_attached_box: z.boolean().optional(),
  // Per-segment "separator before" picker. The empty string '' is the
  // operationally meaningful value ("None / concatenate") so the schema
  // MUST accept it — z.string().max(4) does (min length defaults to 0).
  //
  // BUG FIX 2026-05-18: this field was missing from the schema before
  // today; Zod's default behavior strips unknown keys, so every save
  // silently dropped the per-segment separator and the engine fell
  // back to structure.separators[0] = '-'. Result: every save reverted
  // to hyphen, even when the admin chose None/underscore/dot.
  prefix_separator:   z.string().max(4).optional(),
});

const skuStructureSchema = z.object({
  // v2 fields
  version:          z.literal(2).optional(),
  enabled:          z.boolean().optional(),
  case_insensitive: z.boolean().optional(),
  separators:       z.array(z.string().max(4)).max(8).optional(),
  segments:         z.array(segmentSchema).max(16).optional(),
  // v1 legacy fields
  prefixes:         z.array(z.string().min(1).max(16)).max(16).optional(),
  separator:        z.string().max(4).optional(),
  box_pattern:      z.string().max(120).optional(),
  upc_pattern:      z.string().max(120).optional(),
  part_pattern:     z.string().max(120).optional(),
}).nullable().optional();

const createOrgSchema = z.object({
  display_name:    z.string().min(1).max(100),
  slug:            z.string().min(2).max(40).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with hyphens'),
  // Every org must have at least one member. The creating admin counts —
  // they're auto-included server-side if not present in this list.
  member_user_ids: z.array(z.string().uuid()).min(1),
  // sku_structure is MANDATORY on create — the platform's "Undefined SKU"
  // classification depends on every org having a defined SKU pattern. The
  // mandatory check runs after zod parsing in the handler so we can return a
  // helpful field-level error rather than a generic schema failure.
  sku_structure:   skuStructureSchema,
});

// Slug is locked after creation — it's the URL identifier and changing it
// would break bookmarks/integrations. Only display_name, member roster,
// active status, and SKU structure can change.
const updateOrgSchema = z.object({
  display_name:    z.string().min(1).max(100).optional(),
  is_active:       z.boolean().optional(),
  member_user_ids: z.array(z.string().uuid()).min(1).optional(),
  sku_structure:   skuStructureSchema,
});

/**
 * Normalize the inbound sku_structure into the JSON string we persist on
 * organizations.sku_structure. Returns:
 *   { skip: true }                       → not present in the request, leave column alone
 *   { value: null }                      → explicit clear (null on the wire)
 *   { value: '<json>' }                  → JSON-encoded normalized object
 */
function prepareSkuStructure(raw) {
  if (raw === undefined) return { skip: true };
  if (raw === null)      return { value: null };
  const normalized = normalizeStructureForStorage(raw);
  return { value: normalized ? JSON.stringify(normalized) : null };
}

export async function organizationsRoutes(fastify, { orgsRepo, membershipsRepo, usersRepo, summaryRefreshService }) {
  const { randomUUID } = await import('crypto');

  // Reconcile an org's member roster with a target list of user_ids.
  //   - Deactivate memberships not in target.
  //   - Reactivate (and re-role to mirror users.role) existing memberships in target.
  //   - Create new memberships for users newly added.
  async function syncOrgMembers(organizationId, targetUserIds) {
    const current = await membershipsRepo.findAllByOrg(organizationId);
    const targetSet = new Set(targetUserIds);
    const currentByUser = new Map();
    for (const m of current) currentByUser.set(m.user_id, m);

    // Deactivate active memberships not in target.
    for (const m of current) {
      if (m.is_active && !targetSet.has(m.user_id)) {
        await membershipsRepo.updateMembership(m.membership_id, { is_active: false });
      }
    }

    // Add or reactivate memberships in target. Each new/updated membership
    // mirrors the user's global users.role for legacy consistency.
    for (const userId of targetUserIds) {
      const user = await usersRepo.findById(userId);
      if (!user) throw new AppError(400, `User ${userId} does not exist`);
      const role = user.role || 'viewer';

      const existing = currentByUser.get(userId);
      if (existing) {
        const patch = {};
        if (!existing.is_active)         patch.is_active = true;
        if (existing.role     !== role)  patch.role      = role;
        if (Object.keys(patch).length) {
          await membershipsRepo.updateMembership(existing.membership_id, patch);
        }
      } else {
        await membershipsRepo.createMembership({
          membership_id:   randomUUID(),
          user_id:         userId,
          organization_id: organizationId,
          role,
        });
      }
    }
  }

  // List all organizations (super_admin only for now).
  fastify.get('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    try {
      const data = await orgsRepo.findAll();
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Orgs list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Create a new organization. Requires at least one member; the creating
  // admin is auto-included if not in the list (admins need access to manage
  // what they create).
  fastify.post('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = createOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }
    try {
      const existing = await orgsRepo.findBySlug(parsed.data.slug);
      if (existing) return reply.code(409).send({ success: false, error: 'Organization slug already exists' });

      // sku_structure is MANDATORY on create. prepareSkuStructure returns
      // { value: null } when the input is null OR fails to normalize into a
      // usable v2 structure (e.g. enabled=false / segments=[]). Reject so
      // every org in the system has a defined SKU pattern from day one.
      const skuPrep    = prepareSkuStructure(parsed.data.sku_structure);
      if (skuPrep.skip || !skuPrep.value) {
        return reply.code(400).send({
          success: false,
          error:   'SKU structure is required when creating an organization. Define at least one segment.',
          details: { fieldErrors: { sku_structure: ['Required'] } },
        });
      }

      const orgId      = randomUUID();
      await orgsRepo.insert({
        organization_id: orgId,
        slug:            parsed.data.slug,
        display_name:    parsed.data.display_name,
        is_active:       true,
        sku_structure:   skuPrep.value,
      });

      const memberIds = [...new Set([
        ...parsed.data.member_user_ids.filter(Boolean),
        request.user.user_id,  // creating admin always included
      ])];

      await syncOrgMembers(orgId, memberIds);

      request.log.info(
        { event: 'org_created', organization_id: orgId, by: request.user.user_id, members: memberIds.length },
        'Organization created'
      );
      return reply.code(201).send({
        success: true,
        data: { organization_id: orgId, display_name: parsed.data.display_name, slug: parsed.data.slug, is_active: true },
      });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Create org error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  // Permanently delete an organization and everything it owns.
  //
  // Irreversible cascade — deletes from:
  //   - memberships (all org rows)
  //   - inventory, orders (all org data)
  //   - inventory_uploads, order_uploads (audit history)
  //   - dashboard_summary, inventory_summary, box_summary_by_upc,
  //     box_summary_by_part (materialized views)
  //   - organizations (the row itself, last)
  //
  // Two-step gate: the org MUST already be is_active=false. Operators
  // must Remove (deactivate) first, re-open the modal, then explicitly
  // confirm permanent delete. The caller's own current org is also
  // forbidden — switch to a different workspace first.
  fastify.delete('/:id/permanent', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const orgId = request.params.id;
    try {
      const org = await orgsRepo.findById(orgId);
      if (!org) {
        return reply.code(404).send({ success: false, error: 'Organization not found' });
      }
      if (org.is_active !== false) {
        return reply.code(409).send({
          success: false,
          error:   'Organization must be removed (deactivated) first. Open the Edit dialog, click Remove, then return to delete permanently.',
        });
      }
      if (orgId === request.user.organization_id) {
        return reply.code(409).send({
          success: false,
          error:   "You can't delete the organization you're currently signed into. Switch workspaces and try again.",
        });
      }

      // Memberships and org-scoped data tables are deleted in PARALLEL —
      // there's no FK constraint between them, and parallelizing cuts
      // total wall-clock from sequential ~14s to a single ~2-4s window.
      // The organizations row itself is deleted LAST inside
      // deleteAllOrgData, after its parallel batch has fully succeeded.
      const [mDeleted, result] = await Promise.all([
        membershipsRepo.deleteAllByOrgId(orgId),
        orgsRepo.deleteAllOrgData(orgId),
      ]);

      request.log.warn(
        {
          event:               'org_permanently_deleted',
          target_id:           orgId,
          by:                  request.user.user_id,
          display_name:        org.display_name,
          tables_cleared:      result.tables_cleared,
          memberships_deleted: mDeleted,
        },
        'Organization permanently deleted (irreversible cascade)',
      );
      return reply.send({
        success: true,
        data: {
          organization_id:     orgId,
          display_name:        org.display_name,
          tables_cleared:      result.tables_cleared,
          memberships_deleted: mDeleted,
        },
      });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Organization permanent-delete error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });

  // Update organization metadata + member roster.
  // Slug is NOT accepted — it's locked after creation.
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = updateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body', details: parsed.error.flatten() });
    }
    try {
      const org = await orgsRepo.findById(request.params.id);
      if (!org) return reply.code(404).send({ success: false, error: 'Organization not found' });

      const profile = {};
      if (parsed.data.display_name !== undefined) profile.display_name = parsed.data.display_name;
      if (parsed.data.is_active    !== undefined) profile.is_active    = parsed.data.is_active;

      const skuPrep = prepareSkuStructure(parsed.data.sku_structure);
      if (!skuPrep.skip) profile.sku_structure = skuPrep.value;

      if (Object.keys(profile).length) {
        await orgsRepo.update(request.params.id, profile);
      }

      if (parsed.data.member_user_ids !== undefined) {
        await syncOrgMembers(request.params.id, parsed.data.member_user_ids);
      }

      // sku_structure update changes how SKUs are classified as Undefined.
      // Rebuild summaries so the new classification is reflected immediately.
      if (parsed.data.sku_structure !== undefined) {
        summaryRefreshService?.refresh(request.params.id).catch(() => {});
      }

      request.log.info({ event: 'org_updated', organization_id: request.params.id, by: request.user.user_id }, 'Organization updated');
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Update org error');
      return reply.code(500).send({ success: false, error: err?.message || 'Internal server error' });
    }
  });
}
