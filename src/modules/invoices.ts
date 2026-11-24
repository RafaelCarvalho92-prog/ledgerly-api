import { and, asc, count, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { customers, invoiceLines, invoices, organizations } from '../db/schema.js';
import { badRequest } from '../lib/errors.js';
import { assertTransition } from '../lib/invoiceStatus.js';
import { computeInvoice } from '../lib/money.js';
import {
  isoDate,
  newId,
  nowIso,
  pageOf,
  pageQuery,
  pageSchema,
  parseSort,
  today,
} from '../lib/util.js';
import { findInvoice, invoiceDetail, toSummary } from './invoiceService.js';
import {
  errors,
  idParam,
  invoiceDetailSchema,
  invoiceStatusSchema,
  invoiceSummarySchema,
  lineInputSchema,
} from './schemas.js';

const security = [{ bearerAuth: [] }];

const createBody = z
  .object({
    customerId: z.string().min(1),
    issueDate: isoDate.optional().describe('Defaults to today'),
    dueDate: isoDate.optional().describe('Defaults to issueDate + 30 days'),
    notes: z.string().max(2000).nullable().optional(),
    lines: z.array(lineInputSchema).min(1).max(200),
  })
  .refine((b) => !b.issueDate || !b.dueDate || b.dueDate >= b.issueDate, {
    message: 'dueDate must be on or after issueDate',
    path: ['dueDate'],
  });

const updateBody = z.object({
  customerId: z.string().min(1).optional(),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  notes: z.string().max(2000).nullable().optional(),
  lines: z.array(lineInputSchema).min(1).max(200).optional(),
});

const SORTABLE = ['issueDate', 'dueDate', 'totalCents', 'number', 'createdAt'] as const;
type SortField = (typeof SORTABLE)[number];

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const invoiceRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  async function assertCustomer(orgId: string, customerId: string) {
    const [c] = await app.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.orgId, orgId)));
    if (!c)
      throw badRequest('customerId does not reference a customer of this organization', {
        field: 'customerId',
      });
  }

  async function writeLines(invoiceId: string, lines: z.infer<typeof lineInputSchema>[]) {
    const totals = computeInvoice(lines);
    await app.db.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    await app.db.insert(invoiceLines).values(
      totals.lines.map((l, i) => ({
        id: newId('lin'),
        invoiceId,
        position: i + 1,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        taxRateBp: l.taxRateBp,
        subtotalCents: l.subtotalCents,
        taxCents: l.taxCents,
      })),
    );
    return totals;
  }

  app.get(
    '/',
    {
      schema: {
        tags: ['Invoices'],
        summary: 'List invoices',
        description:
          'Filter by status, customer, overdue flag and issue-date range; paginate and sort.',
        security,
        querystring: pageQuery(SORTABLE).extend({
          status: invoiceStatusSchema.optional(),
          customerId: z.string().optional(),
          overdue: z.enum(['true', 'false']).optional(),
          issuedFrom: isoDate.optional(),
          issuedTo: isoDate.optional(),
        }),
        response: { 200: pageSchema(invoiceSummarySchema), ...errors(400, 401) },
      },
    },
    async (req) => {
      const { page, pageSize, sort, status, customerId, overdue, issuedFrom, issuedTo } = req.query;
      const now = today();
      const filters = [eq(invoices.orgId, req.auth.orgId)];
      if (status) filters.push(eq(invoices.status, status));
      if (customerId) filters.push(eq(invoices.customerId, customerId));
      if (issuedFrom) filters.push(gte(invoices.issueDate, issuedFrom));
      if (issuedTo) filters.push(lte(invoices.issueDate, issuedTo));
      if (overdue === 'true') {
        filters.push(
          inArray(invoices.status, ['sent', 'partially_paid']),
          lt(invoices.dueDate, now),
        );
      } else if (overdue === 'false') {
        filters.push(
          sql`NOT (${invoices.status} IN ('sent', 'partially_paid') AND ${invoices.dueDate} < ${now})`,
        );
      }
      const where = and(...filters);
      const { field, desc: isDesc } = parseSort<SortField>(sort);
      const column = invoices[field];
      const [rows, [{ total } = { total: 0 }]] = await Promise.all([
        app.db
          .select()
          .from(invoices)
          .where(where)
          .orderBy(isDesc ? desc(column) : asc(column), asc(invoices.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        app.db.select({ total: count() }).from(invoices).where(where),
      ]);
      return pageOf(
        rows.map((r) => toSummary(r, now)),
        total,
        page,
        pageSize,
      );
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Invoices'],
        summary: 'Create a draft invoice',
        description:
          'Totals are computed server-side (per-line tax, half-up rounding). Numbers are sequential per organization.',
        security,
        body: createBody,
        response: { 201: invoiceDetailSchema, ...errors(400, 401) },
      },
    },
    async (req, reply) => {
      const issueDate = req.body.issueDate ?? today();
      const dueDate = req.body.dueDate ?? addDays(issueDate, 30);
      const row = await app.database.tx(async () => {
        await assertCustomer(req.auth.orgId, req.body.customerId);
        // Atomic per-organization counter: numbers are never reused, even after deleting drafts.
        const [org] = await app.db
          .update(organizations)
          .set({ invoiceSeq: sql`${organizations.invoiceSeq} + 1` })
          .where(eq(organizations.id, req.auth.orgId))
          .returning({ currency: organizations.currency, seq: organizations.invoiceSeq });
        const n = (org?.seq ?? 1) - 1;
        const id = newId('inv');
        const now = nowIso();
        const totals = computeInvoice(req.body.lines);
        const invoice = {
          id,
          orgId: req.auth.orgId,
          customerId: req.body.customerId,
          number: `INV-${String(n + 1).padStart(5, '0')}`,
          status: 'draft' as const,
          currency: org?.currency ?? 'USD',
          issueDate,
          dueDate,
          subtotalCents: totals.subtotalCents,
          taxCents: totals.taxCents,
          totalCents: totals.totalCents,
          amountPaidCents: 0,
          notes: req.body.notes ?? null,
          sentAt: null,
          voidedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        await app.db.insert(invoices).values(invoice);
        await writeLines(id, req.body.lines);
        return invoice;
      });
      return reply.status(201).send(await invoiceDetail(app, row));
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Invoices'],
        summary: 'Get an invoice with lines and payments',
        security,
        params: idParam,
        response: { 200: invoiceDetailSchema, ...errors(401, 404) },
      },
    },
    async (req) => invoiceDetail(app, await findInvoice(app, req.auth.orgId, req.params.id)),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['Invoices'],
        summary: 'Update a draft invoice',
        description:
          'Only drafts can be edited (409 otherwise). Passing `lines` replaces all line items.',
        security,
        params: idParam,
        body: updateBody,
        response: { 200: invoiceDetailSchema, ...errors(400, 401, 404, 409) },
      },
    },
    async (req) => {
      const row = await app.database.tx(async () => {
        const current = await findInvoice(app, req.auth.orgId, req.params.id);
        assertTransition(current.status, 'edit');
        if (req.body.customerId) await assertCustomer(req.auth.orgId, req.body.customerId);
        const issueDate = req.body.issueDate ?? current.issueDate;
        const dueDate = req.body.dueDate ?? current.dueDate;
        if (dueDate < issueDate)
          throw badRequest('dueDate must be on or after issueDate', { field: 'dueDate' });
        const totals = req.body.lines ? await writeLines(current.id, req.body.lines) : null;
        const next = {
          ...current,
          customerId: req.body.customerId ?? current.customerId,
          issueDate,
          dueDate,
          notes: req.body.notes === undefined ? current.notes : req.body.notes,
          ...(totals
            ? {
                subtotalCents: totals.subtotalCents,
                taxCents: totals.taxCents,
                totalCents: totals.totalCents,
              }
            : {}),
          updatedAt: nowIso(),
        };
        await app.db.update(invoices).set(next).where(eq(invoices.id, current.id));
        return next;
      });
      return invoiceDetail(app, row);
    },
  );

  const transition = (action: 'send' | 'void', summary: string, description: string) =>
    app.post(
      `/:id/${action}`,
      {
        schema: {
          tags: ['Invoices'],
          summary,
          description,
          security,
          params: idParam,
          response: { 200: invoiceDetailSchema, ...errors(401, 404, 409) },
        },
      },
      async (req) => {
        const row = await app.database.tx(async () => {
          const current = await findInvoice(app, req.auth.orgId, req.params.id);
          assertTransition(current.status, action);
          if (action === 'void' && current.amountPaidCents > 0) {
            assertTransition('paid', 'void'); // paid money must be refunded first
          }
          const now = nowIso();
          const next =
            action === 'send'
              ? { ...current, status: 'sent' as const, sentAt: now, updatedAt: now }
              : { ...current, status: 'void' as const, voidedAt: now, updatedAt: now };
          await app.db.update(invoices).set(next).where(eq(invoices.id, current.id));
          return next;
        });
        return invoiceDetail(app, row);
      },
    );
  transition(
    'send',
    'Send (finalize) a draft invoice',
    'draft -> sent. After sending, line items are locked.',
  );
  transition(
    'void',
    'Void an invoice',
    'draft|sent -> void, only while no payments have been recorded.',
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['Invoices'],
        summary: 'Delete a draft invoice (owner only)',
        description: 'Sent invoices are part of the ledger: void them instead.',
        security,
        params: idParam,
        response: { 204: z.null(), ...errors(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      await app.database.tx(async () => {
        const current = await findInvoice(app, req.auth.orgId, req.params.id);
        assertTransition(current.status, 'delete');
        await app.db
          .delete(invoices)
          .where(and(eq(invoices.id, current.id), ne(invoices.status, 'sent')));
      });
      return reply.status(204).send(null);
    },
  );
};
