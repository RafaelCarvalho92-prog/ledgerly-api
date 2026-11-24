/**
 * A realistic end-to-end scenario driven through the real HTTP layer (app.inject). Used by:
 *   - scripts/seed.ts        to fill a local database with fictional data
 *   - scripts/build-docs.ts  to record request/response examples for the docs "Try it" mock
 */
import type { App } from '../src/app.js';

export interface Exchange {
  id: string;
  title: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  status: number;
  responseHeaders: Record<string, string>;
  response: unknown;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function runScenario(app: App, record = false): Promise<Exchange[]> {
  const log: Exchange[] = [];
  let token = '';

  async function call(
    id: string,
    title: string,
    method: string,
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    const response = res.body ? (res.json() as Json) : null;
    if (record) {
      const shown: Record<string, string> = {};
      for (const h of ['content-type', 'x-request-id', 'idempotent-replayed', 'retry-after']) {
        const v = res.headers[h];
        if (typeof v === 'string') shown[h] = v;
      }
      log.push({
        id,
        title,
        method,
        url,
        headers: Object.fromEntries(
          Object.entries(headers).map(([k, v]) => [
            k,
            k === 'authorization' ? 'Bearer eyJhbGciOiJIUzI1NiIs...' : v,
          ]),
        ),
        body,
        status: res.statusCode,
        responseHeaders: shown,
        response,
      });
    }
    return response as Json;
  }

  const reg = await call(
    'register',
    'Create an account + organization',
    'POST',
    '/v1/auth/register',
    {
      email: 'maria@northwind-studio.example',
      password: 'correct-horse-42',
      name: 'Maria Lopes',
      organizationName: 'Northwind Studio',
      currency: 'USD',
    },
  );
  token = reg.tokens.accessToken;

  await call('member', 'Invite a team member (owner only)', 'POST', '/v1/members', {
    email: 'dev@northwind-studio.example',
    name: 'Dev Patel',
    role: 'member',
    initialPassword: 'member-pass-123',
  });

  const customers: Json[] = [];
  for (const [i, c] of [
    { name: 'Blue Harbor Coffee', email: 'ap@blueharbor.example', taxId: 'US-84-1234567' },
    { name: 'Cedar & Pine Architects', email: 'billing@cedarpine.example' },
    { name: 'Lumen Health Clinic', email: 'finance@lumenhealth.example' },
  ].entries()) {
    customers.push(
      await call(
        i === 0 ? 'customer' : `customer-${i}`,
        'Create a customer',
        'POST',
        '/v1/customers',
        c,
      ),
    );
  }

  const invoiceSpecs = [
    { c: 0, issueDate: '2026-10-01', dueDate: '2026-10-31', lines: [{ description: 'Brand identity package', quantity: 1, unitPriceCents: 480000, taxRateBp: 825 }, { description: 'Extra revision rounds', quantity: 3, unitPriceCents: 12500, taxRateBp: 825 }] },
    { c: 1, issueDate: '2026-10-15', dueDate: '2026-11-14', lines: [{ description: 'Website design (12 pages)', quantity: 12, unitPriceCents: 35000, taxRateBp: 825 }, { description: 'Hosting setup', quantity: 1, unitPriceCents: 15000, taxRateBp: 0 }] },
    { c: 2, issueDate: '2026-11-02', dueDate: '2026-12-02', lines: [{ description: 'Patient portal UX audit', quantity: 16, unitPriceCents: 14000, taxRateBp: 825 }] },
    { c: 0, issueDate: '2026-11-10', dueDate: '2026-12-10', lines: [{ description: 'Menu redesign', quantity: 1, unitPriceCents: 90000, taxRateBp: 825 }] },
  ]; // prettier-ignore
  const invoices: Json[] = [];
  for (const [i, spec] of invoiceSpecs.entries()) {
    invoices.push(
      await call(
        i === 0 ? 'invoice-create' : `invoice-${i}`,
        'Create a draft invoice',
        'POST',
        '/v1/invoices',
        {
          customerId: customers[spec.c]!.id,
          issueDate: spec.issueDate,
          dueDate: spec.dueDate,
          notes: 'Thank you for your business!',
          lines: spec.lines,
        },
      ),
    );
  }
  for (const [i, inv] of invoices.slice(0, 3).entries()) {
    await call(
      i === 0 ? 'invoice-send' : `send-${i}`,
      'Send (finalize) an invoice',
      'POST',
      `/v1/invoices/${inv.id}/send`,
    );
  }

  const paymentBody = {
    invoiceId: invoices[0]!.id,
    amountCents: 300000,
    method: 'bank_transfer',
    paidAt: '2026-10-20T14:00:00Z',
    reference: 'WIRE-2210',
  };
  await call('payment', 'Record a payment (idempotent)', 'POST', '/v1/payments', paymentBody, {
    'idempotency-key': 'pay-northwind-0001',
  });
  await call(
    'payment-replay',
    'Retry the same payment (replayed, not charged twice)',
    'POST',
    '/v1/payments',
    paymentBody,
    { 'idempotency-key': 'pay-northwind-0001' },
  );
  await call(
    'payment-rest',
    'Pay the remaining balance',
    'POST',
    '/v1/payments',
    {
      ...paymentBody,
      amountCents: invoices[0]!.totalCents - 300000,
      paidAt: '2026-10-28T09:30:00Z',
      reference: 'WIRE-2234',
    },
    { 'idempotency-key': 'pay-northwind-0002' },
  );
  await call(
    'payment-overpay',
    'Overpayment is rejected (409)',
    'POST',
    '/v1/payments',
    { invoiceId: invoices[1]!.id, amountCents: 99999999, method: 'card' },
    { 'idempotency-key': 'pay-northwind-0003' },
  );

  for (const e of [
    {
      category: 'software',
      description: 'Figma Professional (annual)',
      vendor: 'Figma',
      amountCents: 18000,
      spentAt: '2026-10-03',
    },
    {
      category: 'office',
      description: 'Coworking desk - October',
      vendor: 'Harbor Works',
      amountCents: 32000,
      spentAt: '2026-10-01',
    },
    {
      category: 'contractors',
      description: 'Illustration freelancer',
      vendor: 'J. Okafor',
      amountCents: 95000,
      spentAt: '2026-10-22',
    },
    {
      category: 'software',
      description: 'Hosting',
      vendor: 'CloudHost',
      amountCents: 4500,
      spentAt: '2026-11-01',
    },
  ].entries()) {
    await call(
      e[0] === 0 ? 'expense' : `expense-${e[0]}`,
      'Record an expense',
      'POST',
      '/v1/expenses',
      e[1],
    );
  }

  await call(
    'invoice-list',
    'List invoices (filter + sort + paginate)',
    'GET',
    '/v1/invoices?status=sent&sort=-issueDate&pageSize=10',
  );
  await call(
    'invoice-get',
    'Get an invoice with lines and payments',
    'GET',
    `/v1/invoices/${invoices[0]!.id}`,
  );
  await call(
    'report',
    'Financial summary',
    'GET',
    '/v1/reports/summary?from=2026-10-01&to=2026-11-30',
  );
  await call(
    'edit-sent',
    'Editing a sent invoice is rejected (409)',
    'PATCH',
    `/v1/invoices/${invoices[1]!.id}`,
    { notes: 'changed' },
  );
  await call('validation', 'Validation error (400, problem+json)', 'POST', '/v1/customers', {
    name: '',
    email: 'not-an-email',
  });
  const saved = token;
  token = '';
  await call('unauthorized', 'Missing token (401)', 'GET', '/v1/invoices');
  token = saved;
  await call('me', 'Who am I', 'GET', '/v1/auth/me');
  return log;
}
