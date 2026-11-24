import bcrypt from 'bcryptjs';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { memberships, users } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/util.js';
import { errors, memberSchema, roleSchema } from './schemas.js';

const security = [{ bearerAuth: [] }];

export const memberRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  const listMembers = (orgId: string) =>
    app.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        joinedAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(memberships.createdAt));

  async function ownerCount(orgId: string) {
    const owners = await app.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.role, 'owner')));
    return owners.length;
  }

  app.get(
    '/',
    {
      schema: {
        tags: ['Members'],
        summary: 'List organization members',
        security,
        response: { 200: z.array(memberSchema), ...errors(401) },
      },
    },
    async (req) => listMembers(req.auth.orgId),
  );

  app.post(
    '/',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['Members'],
        summary: 'Add a member (owner only)',
        description:
          'Adds an existing user by email, or creates the account with the given initial password.',
        security,
        body: z.object({
          email: z.string().trim().toLowerCase().email(),
          name: z.string().trim().min(1).max(120),
          role: roleSchema.default('member'),
          initialPassword: z.string().min(10).max(128).optional(),
        }),
        response: { 201: memberSchema, ...errors(400, 401, 403, 409, 422) },
      },
    },
    async (req, reply) => {
      const { email, name, role, initialPassword } = req.body;
      const member = await app.database.tx(async () => {
        let [user] = await app.db.select().from(users).where(eq(users.email, email));
        if (!user) {
          if (!initialPassword) {
            throw conflict(
              'initial-password-required',
              'This email has no account yet; provide initialPassword to create it.',
            );
          }
          user = {
            id: newId('usr'),
            email,
            name,
            passwordHash: await bcrypt.hash(initialPassword, app.config.BCRYPT_ROUNDS),
            createdAt: nowIso(),
          };
          await app.db.insert(users).values(user);
        }
        const [existing] = await app.db
          .select()
          .from(memberships)
          .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, req.auth.orgId)));
        if (existing)
          throw conflict('already-member', 'This user is already a member of the organization.');
        const joinedAt = nowIso();
        await app.db
          .insert(memberships)
          .values({ userId: user.id, orgId: req.auth.orgId, role, createdAt: joinedAt });
        return { userId: user.id, email: user.email, name: user.name, role, joinedAt };
      });
      return reply.status(201).send(member);
    },
  );

  app.patch(
    '/:userId',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['Members'],
        summary: "Change a member's role (owner only)",
        security,
        params: z.object({ userId: z.string() }),
        body: z.object({ role: roleSchema }),
        response: { 200: memberSchema, ...errors(400, 401, 403, 404, 409) },
      },
    },
    async (req) => {
      return app.database.tx(async () => {
        const where = and(
          eq(memberships.userId, req.params.userId),
          eq(memberships.orgId, req.auth.orgId),
        );
        const [current] = await app.db.select().from(memberships).where(where);
        if (!current) throw notFound('Member');
        if (
          current.role === 'owner' &&
          req.body.role !== 'owner' &&
          (await ownerCount(req.auth.orgId)) === 1
        ) {
          throw conflict('last-owner', 'An organization must keep at least one owner.');
        }
        await app.db.update(memberships).set({ role: req.body.role }).where(where);
        const updated = (await listMembers(req.auth.orgId)).find(
          (m) => m.userId === req.params.userId,
        );
        if (!updated) throw notFound('Member');
        return updated;
      });
    },
  );

  app.delete(
    '/:userId',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['Members'],
        summary: 'Remove a member (owner only)',
        security,
        params: z.object({ userId: z.string() }),
        response: { 204: z.null(), ...errors(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      await app.database.tx(async () => {
        const where = and(
          eq(memberships.userId, req.params.userId),
          eq(memberships.orgId, req.auth.orgId),
        );
        const [current] = await app.db.select().from(memberships).where(where);
        if (!current) throw notFound('Member');
        if (current.role === 'owner' && (await ownerCount(req.auth.orgId)) === 1) {
          throw conflict('last-owner', 'An organization must keep at least one owner.');
        }
        await app.db.delete(memberships).where(where);
      });
      return reply.status(204).send(null);
    },
  );
};
