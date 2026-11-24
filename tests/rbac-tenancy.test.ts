import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import {
  addMember,
  auth,
  createCustomer,
  createInvoice,
  createTestApp,
  registerOwner,
  sendInvoice,
} from './helpers.js';

let app: App;
let ownerA: Awaited<ReturnType<typeof registerOwner>>;
let ownerB: Awaited<ReturnType<typeof registerOwner>>;
let memberA: Awaited<ReturnType<typeof addMember>>;

beforeAll(async () => {
  app = await createTestApp();
  ownerA = await registerOwner(app);
  ownerB = await registerOwner(app);
  memberA = await addMember(app, ownerA.token);
});
afterAll(() => app.close());

describe('RBAC', () => {
  it('members can work with customers but only owners can delete them', async () => {
    const id = await createCustomer(app, memberA.token, 'Member-made Ltd');
    const asMember = await app.inject({
      method: 'DELETE',
      url: `/v1/customers/${id}`,
      headers: auth(memberA.token),
    });
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json().detail).toMatch(/owner/);
    const asOwner = await app.inject({
      method: 'DELETE',
      url: `/v1/customers/${id}`,
      headers: auth(ownerA.token),
    });
    expect(asOwner.statusCode).toBe(204);
  });

  it('only owners manage members, and the last owner cannot be demoted or removed', async () => {
    const byMember = await app.inject({
      method: 'POST',
      url: '/v1/members',
      headers: auth(memberA.token),
      payload: { email: 'x@example.com', name: 'X', initialPassword: 'whatever-123' },
    });
    expect(byMember.statusCode).toBe(403);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/v1/members/${ownerA.userId}`,
      headers: auth(ownerA.token),
      payload: { role: 'member' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().type).toMatch(/last-owner/);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/members',
      headers: auth(memberA.token),
    });
    expect(
      list
        .json()
        .map((m: { role: string }) => m.role)
        .sort(),
    ).toEqual(['member', 'owner']);
  });

  it('members may delete only their own expenses', async () => {
    const create = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/expenses',
        headers: auth(token),
        payload: {
          category: 'software',
          description: 'Figma',
          amountCents: 1500,
          spentAt: '2026-11-03',
        },
      });
    const ownersExpense = (await create(ownerA.token)).json().id as string;
    const membersExpense = (await create(memberA.token)).json().id as string;
    const del = (token: string, id: string) =>
      app.inject({ method: 'DELETE', url: `/v1/expenses/${id}`, headers: auth(token) });
    expect((await del(memberA.token, ownersExpense)).statusCode).toBe(403);
    expect((await del(memberA.token, membersExpense)).statusCode).toBe(204);
    expect((await del(ownerA.token, ownersExpense)).statusCode).toBe(204);
  });
});

describe('tenant isolation', () => {
  it("another organization's resources are invisible (404, never 403)", async () => {
    const customerId = await createCustomer(app, ownerA.token, 'Secret Client');
    const invoice = await createInvoice(app, ownerA.token, customerId);

    const get = (url: string) => app.inject({ method: 'GET', url, headers: auth(ownerB.token) });
    expect((await get(`/v1/customers/${customerId}`)).statusCode).toBe(404);
    expect((await get(`/v1/invoices/${invoice.id}`)).statusCode).toBe(404);
    expect((await get('/v1/customers')).json().total).toBe(0);
    expect((await get('/v1/invoices')).json().total).toBe(0);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      headers: auth(ownerB.token),
      payload: { name: 'Hijacked' },
    });
    expect(patch.statusCode).toBe(404);
  });

  it("cannot reference another tenant's customer or pay another tenant's invoice", async () => {
    const foreignCustomer = await createCustomer(app, ownerA.token);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: auth(ownerB.token),
      payload: {
        customerId: foreignCustomer,
        lines: [{ description: 'x', quantity: 1, unitPriceCents: 100 }],
      },
    });
    expect(res.statusCode).toBe(400);

    const invoice = await createInvoice(app, ownerA.token, foreignCustomer);
    await sendInvoice(app, ownerA.token, invoice.id);
    const pay = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: auth(ownerB.token, { 'idempotency-key': 'cross-tenant-1' }),
      payload: { invoiceId: invoice.id, amountCents: 100, method: 'card' },
    });
    expect(pay.statusCode).toBe(404);
  });

  it('invoice numbers are sequential per organization', async () => {
    const cA = await createCustomer(app, ownerA.token);
    const cB = await createCustomer(app, ownerB.token);
    const firstB = await createInvoice(app, ownerB.token, cB);
    const nextA = await createInvoice(app, ownerA.token, cA);
    expect(firstB.number).toBe('INV-00001');
    expect(nextA.number).not.toBe('INV-00001');
  });
});
