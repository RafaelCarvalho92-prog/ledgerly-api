import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../src/app.js';
import {
  auth,
  createCustomer,
  createInvoice,
  createTestApp,
  registerOwner,
  sendInvoice,
  type Json,
} from './helpers.js';

let app: App;
let owner: Awaited<ReturnType<typeof registerOwner>>;
let customerId: string;

beforeAll(async () => {
  app = await createTestApp();
  owner = await registerOwner(app);
  customerId = await createCustomer(app, owner.token);
});
afterAll(() => app.close());

const pay = (invoiceId: string, amountCents: number, key: string, extra: Json = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/payments',
    headers: auth(owner.token, key ? { 'idempotency-key': key } : {}),
    payload: { invoiceId, amountCents, method: 'bank_transfer', ...extra },
  });

describe('invoices', () => {
  it('computes per-line tax with half-up rounding and server-side totals', async () => {
    const invoice = await createInvoice(app, owner.token, customerId, {
      lines: [
        { description: 'Consulting', quantity: 3, unitPriceCents: 3333, taxRateBp: 825 }, // 9999 -> tax 824.92 -> 825
        { description: 'Workshop', quantity: 1.5, unitPriceCents: 10001, taxRateBp: 2000 }, // 15001.5 -> 15002, tax 3000.4 -> 3000
        { description: 'Expenses (no tax)', quantity: 1, unitPriceCents: 1234 },
      ],
    });
    expect(invoice.lines.map((l: Json) => [l.subtotalCents, l.taxCents])).toEqual([
      [9999, 825],
      [15002, 3000],
      [1234, 0],
    ]);
    expect(invoice).toMatchObject({
      status: 'draft',
      subtotalCents: 26235,
      taxCents: 3825,
      totalCents: 30060,
      balanceCents: 30060,
      currency: 'USD',
    });
  });

  it('validates the body (lines required, dates ordered, positive quantities)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: auth(owner.token),
      payload: {
        customerId,
        issueDate: '2026-11-10',
        dueDate: '2026-11-01',
        lines: [{ description: '', quantity: -1, unitPriceCents: 1.5 }],
      },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().errors.map((e: Json) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'body.lines.0.description',
        'body.lines.0.quantity',
        'body.lines.0.unitPriceCents',
      ]),
    );
    const noLines = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: auth(owner.token),
      payload: { customerId, lines: [] },
    });
    expect(noLines.statusCode).toBe(400);
  });

  it('enforces the status machine: edit only drafts, send once, void only unpaid', async () => {
    const invoice = await createInvoice(app, owner.token, customerId);
    const edit = await app.inject({
      method: 'PATCH',
      url: `/v1/invoices/${invoice.id}`,
      headers: auth(owner.token),
      payload: {
        lines: [{ description: 'Replaced', quantity: 2, unitPriceCents: 500, taxRateBp: 1000 }],
      },
    });
    expect(edit.json()).toMatchObject({ totalCents: 1100, lines: [{ description: 'Replaced' }] });

    expect((await sendInvoice(app, owner.token, invoice.id)).json().status).toBe('sent');
    const again = await sendInvoice(app, owner.token, invoice.id);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ currentStatus: 'sent', allowedFrom: ['draft'] });
    const lateEdit = await app.inject({
      method: 'PATCH',
      url: `/v1/invoices/${invoice.id}`,
      headers: auth(owner.token),
      payload: { notes: 'x' },
    });
    expect(lateEdit.statusCode).toBe(409);

    await pay(invoice.id, 100, 'void-test-pay-1');
    const voidPaid = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoice.id}/void`,
      headers: auth(owner.token),
    });
    expect(voidPaid.statusCode).toBe(409);

    const draft = await createInvoice(app, owner.token, customerId);
    const voided = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${draft.id}/void`,
      headers: auth(owner.token),
    });
    expect(voided.json()).toMatchObject({ status: 'void', balanceCents: 0 });
  });

  it('deletes drafts only and never reuses invoice numbers', async () => {
    const a = await createInvoice(app, owner.token, customerId);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/invoices/${a.id}`,
      headers: auth(owner.token),
    });
    expect(del.statusCode).toBe(204);
    const b = await createInvoice(app, owner.token, customerId);
    expect(b.number).not.toBe(a.number);
    await sendInvoice(app, owner.token, b.id);
    const delSent = await app.inject({
      method: 'DELETE',
      url: `/v1/invoices/${b.id}`,
      headers: auth(owner.token),
    });
    expect(delSent.statusCode).toBe(409);
  });

  it('paginates, filters and sorts the invoice list', async () => {
    const fresh = await registerOwner(app);
    const cust = await createCustomer(app, fresh.token);
    for (let i = 0; i < 5; i++) {
      await createInvoice(app, fresh.token, cust, {
        issueDate: `2026-0${i + 1}-10`,
        dueDate: `2026-0${i + 1}-20`,
        lines: [{ description: 'Item', quantity: 1, unitPriceCents: (i + 1) * 1000 }],
      });
    }
    const list = (q: string) =>
      app.inject({ method: 'GET', url: `/v1/invoices?${q}`, headers: auth(fresh.token) });
    const page2 = (await list('pageSize=2&page=2&sort=totalCents')).json();
    expect(page2).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
    expect(page2.data.map((i: Json) => i.totalCents)).toEqual([3000, 4000]);
    const range = (await list('issuedFrom=2026-02-01&issuedTo=2026-03-31&sort=-issueDate')).json();
    expect(range.data.map((i: Json) => i.issueDate)).toEqual(['2026-03-10', '2026-02-10']);

    const all = (await list('pageSize=100')).json().data as Json[];
    await sendInvoice(app, fresh.token, all[0]!.id); // due in the past -> overdue
    const overdue = (await list('overdue=true')).json();
    expect(overdue.total).toBe(1);
    expect(overdue.data[0].overdue).toBe(true);

    const bad = await list('pageSize=500&sort=password');
    expect(bad.statusCode).toBe(400);
  });
});

describe('payments', () => {
  it('requires an Idempotency-Key header', async () => {
    const invoice = await createInvoice(app, owner.token, customerId);
    await sendInvoice(app, owner.token, invoice.id);
    const res = await pay(invoice.id, 100, '');
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toBe('headers.idempotency-key');
  });

  it('replays the original response for a retried request and never double-charges', async () => {
    const invoice = await createInvoice(app, owner.token, customerId);
    await sendInvoice(app, owner.token, invoice.id);
    const first = await pay(invoice.id, 5000, 'retry-key-0001');
    const retry = await pay(invoice.id, 5000, 'retry-key-0001');
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());

    const concurrent = await Promise.all(
      [1, 2, 3].map(() => pay(invoice.id, 700, 'race-key-0001')),
    );
    expect(new Set(concurrent.map((r) => r.json().payment.id)).size).toBe(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/invoices/${invoice.id}`,
      headers: auth(owner.token),
    });
    expect(detail.json().payments).toHaveLength(2);
    expect(detail.json().amountPaidCents).toBe(5700);
  });

  it('rejects reusing a key with a different body (422)', async () => {
    const invoice = await createInvoice(app, owner.token, customerId);
    await sendInvoice(app, owner.token, invoice.id);
    await pay(invoice.id, 1000, 'reused-key-01');
    const other = await pay(invoice.id, 2000, 'reused-key-01');
    expect(other.statusCode).toBe(422);
    expect(other.json().type).toMatch(/idempotency-key-reused/);
  });

  it('moves invoices to partially_paid then paid, and blocks overpayment and draft payments', async () => {
    const invoice = await createInvoice(app, owner.token, customerId);
    const draftPay = await pay(invoice.id, 100, 'draft-pay-0001');
    expect(draftPay.statusCode).toBe(409);
    await sendInvoice(app, owner.token, invoice.id);

    const partial = await pay(invoice.id, 10_000, 'partial-0001');
    expect(partial.json().invoice).toMatchObject({
      status: 'partially_paid',
      amountPaidCents: 10_000,
    });
    const over = await pay(invoice.id, invoice.totalCents, 'over-0001');
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ balanceCents: invoice.totalCents - 10_000 });
    const rest = await pay(invoice.id, invoice.totalCents - 10_000, 'rest-0001');
    expect(rest.json().invoice).toMatchObject({ status: 'paid', balanceCents: 0 });
  });

  it('summarizes invoiced, collected, expenses and aging in the report', async () => {
    const org = await registerOwner(app);
    const cust = await createCustomer(app, org.token);
    const inv = await createInvoice(app, org.token, cust, {
      issueDate: '2026-11-01',
      dueDate: '2026-11-05',
      lines: [{ description: 'Retainer', quantity: 1, unitPriceCents: 100_000 }],
    });
    await sendInvoice(app, org.token, inv.id);
    await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: auth(org.token, { 'idempotency-key': 'report-pay-1' }),
      payload: {
        invoiceId: inv.id,
        amountCents: 40_000,
        method: 'card',
        paidAt: '2026-11-06T10:00:00Z',
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/expenses',
      headers: auth(org.token),
      payload: {
        category: 'software',
        description: 'Hosting',
        amountCents: 15_000,
        spentAt: '2026-11-02',
      },
    });
    const report = await app.inject({
      method: 'GET',
      url: '/v1/reports/summary?from=2026-11-01&to=2026-11-30',
      headers: auth(org.token),
    });
    expect(report.json()).toMatchObject({
      invoicedCents: 100_000,
      invoiceCount: 1,
      collectedCents: 40_000,
      expensesCents: 15_000,
      netCashFlowCents: 25_000,
      outstandingCents: 60_000,
      overdueCount: 1,
      expensesByCategory: [{ category: 'software', amountCents: 15_000 }],
    });
    expect(report.json().aging.find((a: Json) => a.bucket === '1-30')).toEqual({
      bucket: '1-30',
      count: 1,
      balanceCents: 60_000,
    });
  });
});
