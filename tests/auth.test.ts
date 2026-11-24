import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import { auth, createTestApp, registerOwner, type Json } from './helpers.js';

let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());

describe('auth', () => {
  it('registers an owner with a new organization and returns tokens', async () => {
    const { body, token } = await registerOwner(app, {
      email: 'Founder@Example.com',
      currency: 'EUR',
    });
    expect(body.user.email).toBe('founder@example.com'); // normalized
    expect(body.organization.currency).toBe('EUR');
    expect(body.role).toBe('owner');
    expect(body.tokens).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });

    const me = await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().role).toBe('owner');
    expect(me.json().organizations).toHaveLength(1);
  });

  it('rejects duplicate emails with 409 problem+json', async () => {
    await registerOwner(app, { email: 'dup@example.com' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'dup@example.com',
        password: 'correct-horse-42',
        name: 'X',
        organizationName: 'Y',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      type: 'https://ledgerly.example/problems/email-taken',
      status: 409,
    });
  });

  it('returns field-level validation errors for weak passwords and bad emails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'not-an-email', password: 'short', name: '', organizationName: 'Org' },
    });
    expect(res.statusCode).toBe(400);
    const problem = res.json() as Json;
    expect(problem.title).toBe('Validation failed');
    const paths = problem.errors.map((e: Json) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.password', 'body.name']));
    expect(problem.requestId).toBe(res.headers['x-request-id']);
  });

  it('uses the same 401 for unknown email and wrong password (no user enumeration)', async () => {
    const { email } = await registerOwner(app);
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'nope-nope-1' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'ghost@example.com', password: 'nope-nope-1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().detail).toBe(unknown.json().detail);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'correct-horse-42' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().role).toBe('owner');
  });

  it('rotates refresh tokens and revokes the whole family when an old token is replayed', async () => {
    const { refreshToken } = await registerOwner(app);
    const first = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().refreshToken as string;
    expect(rotated).not.toBe(refreshToken);

    // Attacker replays the stolen (already used) token: everything in the family dies.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().detail).toMatch(/reuse detected/);
    const legit = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(legit.statusCode).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { refreshToken } = await registerOwner(app);
    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      payload: { refreshToken },
    });
    expect(out.statusCode).toBe(204);
    const after = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken },
    });
    expect(after.statusCode).toBe(401);
  });

  it('rejects missing, malformed and tampered access tokens', async () => {
    const { token } = await registerOwner(app);
    const none = await app.inject({ method: 'GET', url: '/v1/customers' });
    const garbage = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: auth('abc.def.ghi'),
    });
    const [h, p, s] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p!, 'base64url').toString()),
        role: 'owner',
        org: 'org_other',
      }),
    ).toString('base64url');
    const tampered = await app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: auth(`${h}.${forged}.${s}`),
    });
    for (const res of [none, garbage, tampered]) {
      expect(res.statusCode).toBe(401);
      expect(res.json().type).toBe('https://ledgerly.example/problems/unauthorized');
    }
  });
});

describe('platform', () => {
  it('exposes liveness and readiness probes', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(health.json().status).toBe('ok');
    expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('propagates a valid X-Request-Id and generates one otherwise', async () => {
    const mine = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-12345678' },
    });
    expect(mine.headers['x-request-id']).toBe('trace-12345678');
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id!' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers unknown routes and malformed JSON with problem+json', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().type).toBe('https://ledgerly.example/problems/route-not-found');
    const broken = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.headers['content-type']).toContain('application/problem+json');
  });

  it('rate-limits the auth endpoints', async () => {
    const limited = await createTestApp({ AUTH_RATE_LIMIT_MAX: 3 });
    const attempt = () =>
      limited.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'a@b.example', password: 'whatever-123' },
      });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await attempt()).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    const last = await attempt();
    expect(last.json().type).toBe('https://ledgerly.example/problems/rate-limited');
    expect(last.headers['retry-after']).toBeDefined();
    await limited.close();
  });
});
