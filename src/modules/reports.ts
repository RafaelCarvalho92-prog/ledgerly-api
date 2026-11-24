import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { expenses, invoices, payments } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { isoDate, today } from '../lib/util.js';
import { errors, money } from './schemas.js';

const AGING = [
  { bucket: 'current', min: Number.NEGATIVE_INFINITY, max: 0 },
  { bucket: '1-30', min: 1, max: 30 },
  { bucket: '31-60', min: 31, max: 60 },
  { bucket: '61-90', min: 61, max: 90 },
  { bucket: '90+', min: 91, max: Number.POSITIVE_INFINITY },
] as const;

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Pure aging calculation, exported for unit tests. */
export function agingBuckets(open: { dueDate: string; balanceCents: number }[], asOf: string) {
  return AGING.map(({ bucket, min, max }) => {
    const rows = open.filter((i) => {
      const late = daysBetween(i.dueDate, asOf);
      return late >= min && late <= max;
    });
    return {
      bucket,
      count: rows.length,
      balanceCents: rows.reduce((s, r) => s + r.balanceCents, 0),
    };
  });
}

export const reportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/summary',
    {
      schema: {
        tags: ['Reports'],
        summary: 'Financial summary for a period',
        description:
          'Invoiced (non-void invoices issued in the period), collected (payments in the period), ' +
          'expenses by category, net cash flow, and receivables aging as of `to`.',
        security: [{ bearerAuth: [] }],
        querystring: z.object({
          from: isoDate.optional().describe('Defaults to Jan 1 of the current year'),
          to: isoDate.optional().describe('Defaults to today'),
        }),
        response: {
          200: z.object({
            period: z.object({ from: isoDate, to: isoDate }),
            invoicedCents: money,
            invoiceCount: z.number().int(),
            collectedCents: money,
            expensesCents: money,
            netCashFlowCents: money.describe('collected - expenses'),
            outstandingCents: money,
            overdueCount: z.number().int(),
            expensesByCategory: z.array(z.object({ category: z.string(), amountCents: money })),
            aging: z.array(
              z.object({ bucket: z.string(), count: z.number().int(), balanceCents: money }),
            ),
          }),
          ...errors(400, 401),
        },
      },
    },
    async (req) => {
      const to = req.query.to ?? today();
      const from = req.query.from ?? `${to.slice(0, 4)}-01-01`;
      if (from > to) throw badRequest('`from` must be on or before `to`');
      const orgId = req.auth.orgId;

      const [[invoiced], [collected], byCategory, open] = await Promise.all([
        app.db
          .select({ total: sql<number>`COALESCE(SUM(${invoices.totalCents}), 0)`, n: sql<number>`COUNT(*)` })
          .from(invoices)
          .where(and(eq(invoices.orgId, orgId), ne(invoices.status, 'void'), ne(invoices.status, 'draft'), gte(invoices.issueDate, from), lte(invoices.issueDate, to))),
        app.db
          .select({ total: sql<number>`COALESCE(SUM(${payments.amountCents}), 0)` })
          .from(payments)
          .where(and(eq(payments.orgId, orgId), gte(payments.paidAt, from), lte(payments.paidAt, `${to}T23:59:59.999Z`))),
        app.db
          .select({ category: expenses.category, amountCents: sql<number>`SUM(${expenses.amountCents})` })
          .from(expenses)
          .where(and(eq(expenses.orgId, orgId), gte(expenses.spentAt, from), lte(expenses.spentAt, to)))
          .groupBy(expenses.category)
          .orderBy(sql`2 DESC`),
        app.db
          .select({ dueDate: invoices.dueDate, total: invoices.totalCents, paid: invoices.amountPaidCents })
          .from(invoices)
          .where(and(eq(invoices.orgId, orgId), sql`${invoices.status} IN ('sent', 'partially_paid')`)),
      ]); // prettier-ignore

      const expensesCents = byCategory.reduce((s, c) => s + Number(c.amountCents), 0);
      const openRows = open.map((o) => ({ dueDate: o.dueDate, balanceCents: o.total - o.paid }));
      const collectedCents = Number(collected?.total ?? 0);
      return {
        period: { from, to },
        invoicedCents: Number(invoiced?.total ?? 0),
        invoiceCount: Number(invoiced?.n ?? 0),
        collectedCents,
        expensesCents,
        netCashFlowCents: collectedCents - expensesCents,
        outstandingCents: openRows.reduce((s, o) => s + o.balanceCents, 0),
        overdueCount: openRows.filter((o) => o.dueDate < to).length,
        expensesByCategory: byCategory.map((c) => ({
          category: c.category,
          amountCents: Number(c.amountCents),
        })),
        aging: agingBuckets(openRows, to),
      };
    },
  );
};
