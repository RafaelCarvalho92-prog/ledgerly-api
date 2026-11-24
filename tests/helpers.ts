import { buildApp, type App } from '../src/app.js';
import { testConfig, type Config } from '../src/config.js';

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Fresh app + fresh in-memory SQLite database (migrated) for each test file. */
export async function createTestApp(overrides: Partial<Config> = {}): Promise<App> {
  return buildApp(testConfig(overrides));
}

let counter = 0;

export async function registerOwner(app: App, overrides: Partial<Json> = {}) {
  counter += 1;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: `owner${counter}@example.com`,
      password: 'correct-horse-42',
      name: `Owner ${counter}`,
      organizationName: `Org ${counter}`,
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as Json;
  return {
    body,
    token: body.tokens.accessToken as string,
    refreshToken: body.tokens.refreshToken as string,
    orgId: body.organization.id as string,
    userId: body.user.id as string,
    email: body.user.email as string,
  };
}

export async function addMember(app: App, ownerToken: string, role: 'owner' | 'member' = 'member') {
  counter += 1;
  const email = `member${counter}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/members',
    headers: auth(ownerToken),
    payload: { email, name: `Member ${counter}`, role, initialPassword: 'member-pass-123' },
  });
  if (res.statusCode !== 201) throw new Error(`add member failed: ${res.body}`);
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: 'member-pass-123' },
  });
  return {
    token: (login.json() as Json).accessToken as string,
    userId: (res.json() as Json).userId as string,
  };
}

export const auth = (token: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${token}`,
  ...extra,
});

export async function createCustomer(app: App, token: string, name = 'Acme Corp') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: auth(token),
    payload: { name, email: 'billing@acme.example' },
  });
  return (res.json() as Json).id as string;
}

export async function createInvoice(app: App, token: string, customerId: string, extra: Json = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/invoices',
    headers: auth(token),
    payload: {
      customerId,
      issueDate: '2026-11-01',
      dueDate: '2026-11-30',
      lines: [
        { description: 'Design work', quantity: 10, unitPriceCents: 12_500, taxRateBp: 825 },
        { description: 'Hosting', quantity: 1, unitPriceCents: 4_999, taxRateBp: 0 },
      ],
      ...extra,
    },
  });
  if (res.statusCode !== 201) throw new Error(`invoice failed: ${res.body}`);
  return res.json() as Json;
}

export async function sendInvoice(app: App, token: string, id: string) {
  return app.inject({ method: 'POST', url: `/v1/invoices/${id}/send`, headers: auth(token) });
}
