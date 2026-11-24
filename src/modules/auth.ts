import bcrypt from 'bcryptjs';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { memberships, organizations, refreshTokens, users } from '../db/schema.js';
import { conflict, unauthorized } from '../lib/errors.js';
import { newId, nowIso, randomToken, sha256 } from '../lib/util.js';
import type { App } from '../app.js';
import type { AuthContext } from '../plugins/auth.js';
import { currency, errors, orgSchema, roleSchema, tokensSchema, userSchema } from './schemas.js';

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');
const email = z.string().trim().toLowerCase().email().max(254);

// A real bcrypt hash used to keep "unknown email" as slow as "wrong password" (no user enumeration).
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8n1Rl9yyAWNa1hIPfGEwYpq0C8w5w2';

export async function issueTokens(app: App, ctx: AuthContext, familyId = newId('fam')) {
  const refreshToken = randomToken();
  const expiresAt = new Date(
    Date.now() + app.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  ).toISOString();
  await app.db.insert(refreshTokens).values({
    id: newId('rt'),
    userId: ctx.userId,
    orgId: ctx.orgId,
    tokenHash: sha256(refreshToken),
    familyId,
    expiresAt,
    createdAt: nowIso(),
  });
  return {
    accessToken: await app.signAccessToken(ctx),
    tokenType: 'Bearer' as const,
    expiresIn: app.config.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
    refreshExpiresAt: expiresAt,
  };
}

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const authLimit = { rateLimit: { max: app.config.AUTH_RATE_LIMIT_MAX, timeWindow: '1 minute' } };

  app.post(
    '/register',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Create an account and its organization',
        description: 'The new user becomes the owner of a new organization (tenant).',
        body: z.object({
          email,
          password,
          name: z.string().trim().min(1).max(120),
          organizationName: z.string().trim().min(1).max(120),
          currency: currency.default('USD'),
        }),
        response: {
          201: z.object({
            user: userSchema,
            organization: orgSchema,
            role: roleSchema,
            tokens: tokensSchema,
          }),
          ...errors(400, 409, 429),
        },
      },
    },
    async (req, reply) => {
      const { email: mail, password: pw, name, organizationName, currency: cur } = req.body;
      const passwordHash = await bcrypt.hash(pw, app.config.BCRYPT_ROUNDS);
      const user = { id: newId('usr'), email: mail, name };
      const organization = { id: newId('org'), name: organizationName, currency: cur };
      await app.database.tx(async () => {
        const [existing] = await app.db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, mail));
        if (existing) throw conflict('email-taken', 'An account with this email already exists.');
        const createdAt = nowIso();
        await app.db.insert(users).values({ ...user, passwordHash, createdAt });
        await app.db.insert(organizations).values({ ...organization, createdAt });
        await app.db
          .insert(memberships)
          .values({ userId: user.id, orgId: organization.id, role: 'owner', createdAt });
      });
      const tokens = await issueTokens(app, {
        userId: user.id,
        orgId: organization.id,
        role: 'owner',
      });
      return reply.status(201).send({ user, organization, role: 'owner' as const, tokens });
    },
  );

  app.post(
    '/login',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Exchange credentials for tokens',
        description:
          'Pass organizationId to sign into a specific organization when you belong to several.',
        body: z.object({
          email,
          password: z.string().min(1).max(128),
          organizationId: z.string().optional(),
        }),
        response: {
          200: tokensSchema.extend({ organizationId: z.string(), role: roleSchema }),
          ...errors(400, 401, 429),
        },
      },
    },
    async (req) => {
      const [user] = await app.db.select().from(users).where(eq(users.email, req.body.email));
      const valid = await bcrypt.compare(req.body.password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !valid) throw unauthorized('Invalid email or password');
      const rows = await app.db
        .select({ orgId: memberships.orgId, role: memberships.role })
        .from(memberships)
        .where(eq(memberships.userId, user.id))
        .orderBy(asc(memberships.createdAt));
      const membership = req.body.organizationId
        ? rows.find((m) => m.orgId === req.body.organizationId)
        : rows[0];
      if (!membership) throw unauthorized('You are not a member of that organization');
      const tokens = await issueTokens(app, {
        userId: user.id,
        orgId: membership.orgId,
        role: membership.role,
      });
      return { ...tokens, organizationId: membership.orgId, role: membership.role };
    },
  );

  app.post(
    '/refresh',
    {
      config: authLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Rotate a refresh token',
        description:
          'Returns a new access/refresh pair and revokes the old refresh token. Re-using a revoked ' +
          'token revokes the whole token family (theft detection).',
        body: z.object({ refreshToken: z.string().min(20) }),
        response: { 200: tokensSchema, ...errors(400, 401, 429) },
      },
    },
    async (req) => {
      const hash = sha256(req.body.refreshToken);
      // The revocation must be committed, so the reuse check returns a marker instead of throwing
      // inside the transaction (a throw would roll the revocation back).
      const result = await app.database.tx(async () => {
        const [token] = await app.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenHash, hash));
        if (!token) throw unauthorized('Unknown refresh token');
        const now = nowIso();
        if (token.revokedAt) {
          await app.db
            .update(refreshTokens)
            .set({ revokedAt: now })
            .where(
              and(eq(refreshTokens.familyId, token.familyId), isNull(refreshTokens.revokedAt)),
            );
          return { reuse: true as const };
        }
        if (token.expiresAt < now) throw unauthorized('Refresh token expired');
        const [membership] = await app.db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, token.userId), eq(memberships.orgId, token.orgId)));
        if (!membership) throw unauthorized('Membership no longer exists');
        await app.db
          .update(refreshTokens)
          .set({ revokedAt: now })
          .where(eq(refreshTokens.id, token.id));
        return issueTokens(
          app,
          { userId: token.userId, orgId: token.orgId, role: membership.role },
          token.familyId,
        );
      });
      if ('reuse' in result) {
        throw unauthorized(
          'Refresh token reuse detected; all sessions in this family were revoked',
        );
      }
      return result;
    },
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke a refresh token (and its family)',
        body: z.object({ refreshToken: z.string().min(20) }),
        response: { 204: z.null(), ...errors(400) },
      },
    },
    async (req, reply) => {
      const [token] = await app.db
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, sha256(req.body.refreshToken)));
      if (token) {
        await app.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso() })
          .where(and(eq(refreshTokens.familyId, token.familyId), isNull(refreshTokens.revokedAt)));
      }
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/me',
    {
      onRequest: app.authenticate,
      schema: {
        tags: ['Auth'],
        summary: 'Current user, organization and role',
        security: [{ bearerAuth: [] }],
        response: {
          200: z.object({
            user: userSchema,
            organization: orgSchema,
            role: roleSchema,
            organizations: z.array(orgSchema.extend({ role: roleSchema })),
          }),
          ...errors(401),
        },
      },
    },
    async (req) => {
      const [user] = await app.db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.id, req.auth.userId));
      if (!user) throw unauthorized('User no longer exists');
      const orgs = await app.db
        .select({
          id: organizations.id,
          name: organizations.name,
          currency: organizations.currency,
          role: memberships.role,
        })
        .from(memberships)
        .innerJoin(organizations, eq(organizations.id, memberships.orgId))
        .where(eq(memberships.userId, user.id));
      const current = orgs.find((o) => o.id === req.auth.orgId);
      if (!current) throw unauthorized('Membership no longer exists');
      const { role, ...organization } = current;
      return { user, organization, role, organizations: orgs };
    },
  );
};
