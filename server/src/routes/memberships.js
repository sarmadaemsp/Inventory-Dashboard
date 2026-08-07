import { authenticate, requireRole } from '../middleware/authenticate.js';
import { AppError } from '../utils/errors.js';
import { z } from 'zod';

const addMemberSchema = z.object({
  user_id: z.string().uuid(),
  role:    z.enum(['admin', 'manager', 'viewer']).default('viewer'),
});

const updateSchema = z.object({
  role:      z.enum(['admin', 'manager', 'viewer']).optional(),
  is_active: z.boolean().optional(),
});

export async function membershipsRoutes(fastify, { membershipsRepo }) {
  const { randomUUID } = await import('crypto');

  // List all members of the current org.
  fastify.get('/', { preHandler: [authenticate, requireRole('manager')] }, async (request, reply) => {
    try {
      const data = await membershipsRepo.getMembersByOrg(request.user.organization_id);
      return reply.send({ success: true, data });
    } catch (err) {
      request.log.error({ err }, 'Memberships list error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Add an existing global user to the current org.
  fastify.post('/', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = addMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }
    try {
      const existing = await membershipsRepo.getMembership(
        parsed.data.user_id, request.user.organization_id
      );
      if (existing) {
        return reply.code(409).send({ success: false, error: 'User is already a member of this organization' });
      }
      await membershipsRepo.createMembership({
        membership_id:   randomUUID(),
        user_id:         parsed.data.user_id,
        organization_id: request.user.organization_id,
        role:            parsed.data.role,
      });
      return reply.code(201).send({ success: true });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ success: false, error: err.message });
      }
      request.log.error({ err }, 'Add membership error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Update membership role or status.
  fastify.patch('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ success: false, error: 'Invalid request body' });
    }
    try {
      const membership = await membershipsRepo.getMembershipById(request.params.id);
      if (!membership || membership.organization_id !== request.user.organization_id) {
        return reply.code(404).send({ success: false, error: 'Membership not found' });
      }
      await membershipsRepo.updateMembership(request.params.id, parsed.data);
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Update membership error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });

  // Remove a membership from the current org.
  fastify.delete('/:id', { preHandler: [authenticate, requireRole('admin')] }, async (request, reply) => {
    if (request.params.id === request.user.membership_id) {
      return reply.code(400).send({ success: false, error: 'Cannot remove your own membership' });
    }
    try {
      const membership = await membershipsRepo.getMembershipById(request.params.id);
      if (!membership || membership.organization_id !== request.user.organization_id) {
        return reply.code(404).send({ success: false, error: 'Membership not found' });
      }
      await membershipsRepo.updateMembership(request.params.id, { is_active: false });
      return reply.send({ success: true });
    } catch (err) {
      request.log.error({ err }, 'Remove membership error');
      return reply.code(500).send({ success: false, error: 'Internal server error' });
    }
  });
}
