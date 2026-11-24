import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { canPerform, isOverdue, statusAfterPayment } from '../src/lib/invoiceStatus.js';
import { computeInvoice, roundHalfUp } from '../src/lib/money.js';
import { stableStringify } from '../src/lib/util.js';
import { agingBuckets } from '../src/modules/reports.js';
import { createTestApp } from './helpers.js';

describe('domain logic (unit)', () => {
  it('rounds half-up robustly and totals invoices line by line', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(1.005 * 100)).toBe(101);
    expect(roundHalfUp(-2.5)).toBe(-3);
    const totals = computeInvoice([
      { description: 'a', quantity: 1, unitPriceCents: 1999, taxRateBp: 825 },
      { description: 'b', quantity: 2, unitPriceCents: 1, taxRateBp: 2500 },
    ]);
    expect(totals).toMatchObject({ subtotalCents: 2001, taxCents: 165 + 1, totalCents: 2167 });
  });

  it('encodes the invoice state machine', () => {
    expect(canPerform('draft', 'edit')).toBe(true);
    expect(canPerform('sent', 'edit')).toBe(false);
    expect(canPerform('paid', 'void')).toBe(false);
    expect(canPerform('partially_paid', 'pay')).toBe(true);
    expect(statusAfterPayment(1000, 999)).toBe('partially_paid');
    expect(statusAfterPayment(1000, 1000)).toBe('paid');
    expect(isOverdue('sent', '2026-01-01', '2026-01-02')).toBe(true);
    expect(isOverdue('paid', '2026-01-01', '2026-01-02')).toBe(false);
  });

  it('buckets receivables by days past due', () => {
    const buckets = agingBuckets(
      [
        { dueDate: '2026-11-30', balanceCents: 100 }, // not yet due
        { dueDate: '2026-11-01', balanceCents: 200 }, // 11 days
        { dueDate: '2026-09-01', balanceCents: 300 }, // 72 days
        { dueDate: '2026-01-01', balanceCents: 400 }, // 315 days
      ],
      '2026-11-12',
    );
    expect(buckets.map((b) => [b.bucket, b.balanceCents])).toEqual([
      ['current', 100],
      ['1-30', 200],
      ['31-60', 0],
      ['61-90', 300],
      ['90+', 400],
    ]);
  });

  it('fingerprints request bodies independent of key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: null } })).toBe(
      stableStringify({ a: { c: null, d: [1, 2] }, b: 1 }),
    );
  });

  it('refuses to boot in production with the development JWT secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }).NODE_ENV).toBe(
      'production',
    );
  });
});

describe('OpenAPI', () => {
  it('generates an OpenAPI 3.1 document from the route schemas', async () => {
    const app = await createTestApp();
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/v1/auth/register',
        '/v1/invoices/',
        '/v1/invoices/{id}/send',
        '/v1/payments/',
        '/v1/reports/summary',
      ]),
    );
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    const createPayment = doc.paths['/v1/payments/'].post;
    expect(
      createPayment.parameters.some(
        (p: { name: string; in: string }) => p.name === 'idempotency-key' && p.in === 'header',
      ),
    ).toBe(true);
    expect(createPayment.responses['422']).toBeDefined();
    await app.close();
  });
});
