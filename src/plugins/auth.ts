import fp from 'fastify-plugin';
import { jwtVerify, SignJWT } from 'jose';
import type { FastifyRequest } from 'fastify';
import type { Role } from '../db/schema.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
    requireRole: (...roles: Role[]) => (req: FastifyRequest) => Promise<void>;
    signAccessToken: (ctx: AuthContext) => Promise<string>;
  }
}

const ISSUER = 'ledgerly-api';
const AUDIENCE = 'ledgerly-clients';

/**
 * Stateless access tokens (short-lived JWT, HS256) carrying user, organization and role.
 * Every protected route gets `request.auth`; queries are scoped by `request.auth.orgId`.
 */
export const authPlugin = fp(async (app) => {
  const key = new TextEncoder().encode(app.config.JWT_SECRET);

  app.decorateRequest('auth', null as unknown as AuthContext);

  app.decorate('signAccessToken', (ctx: AuthContext) =>
    new SignJWT({ org: ctx.orgId, role: ctx.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(ctx.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${app.config.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(key),
  );

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');
    try {
      const { payload } = await jwtVerify(header.slice(7), key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ['HS256'],
      });
      const role = payload.role;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.org !== 'string' ||
        (role !== 'owner' && role !== 'member')
      ) {
        throw new Error('bad claims');
      }
      req.auth = { userId: payload.sub, orgId: payload.org, role };
    } catch {
      throw unauthorized('Invalid or expired access token');
    }
  });

  app.decorate('requireRole', (...roles: Role[]) => async (req: FastifyRequest) => {
    if (!roles.includes(req.auth.role)) {
      throw forbidden(`This action requires one of these roles: ${roles.join(', ')}`);
    }
  });
});
