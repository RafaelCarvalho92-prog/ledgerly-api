import { and, asc, count, desc, eq, gte, lte } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { expenses } from '../db/schema.js';
import { forbidden, notFound } from '../lib/errors.js';
import { isoDate, newId, nowIso, pageOf, pageQuery, pageSchema, parseSort } from '../lib/util.js';
import { errors, expenseSchema, idParam } from './schemas.js';

const security = [{ bearerAuth: [] }];
export const EXPENSE_CATEGORIES = [
  'software',
  'travel',
  'office',
  'marketing',
  'contractors',
  'taxes',
  'other',
] as const;

const toDto = (e: typeof expenses.$inferSelect) => ({
  id: e.id,
  category: e.category,
  description: e.description,
  vendor: e.vendor,
  amountCents: e.amountCents,
  spentAt: e.spentAt,
  createdBy: e.createdBy,
  createdAt: e.createdAt,
});

export const expenseRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'List expenses',
        security,
        querystring: pageQuery(['spentAt', 'amountCents'] as const).extend({
          category: z.enum(EXPENSE_CATEGORIES).optional(),
          from: isoDate.optional(),
          to: isoDate.optional(),
        }),
        response: { 200: pageSchema(expenseSchema), ...errors(400, 401) },
      },
    },
    async (req) => {
      const { page, pageSize, sort, category, from, to } = req.query;
      const where = and(
        eq(expenses.orgId, req.auth.orgId),
        category ? eq(expenses.category, category) : undefined,
        from ? gte(expenses.spentAt, from) : undefined,
        to ? lte(expenses.spentAt, to) : undefined,
      );
      const { field, desc: isDesc } = parseSort<'spentAt' | 'amountCents'>(sort);
      const column = expenses[field];
      const [rows, [{ total } = { total: 0 }]] = await Promise.all([
        app.db
          .select()
          .from(expenses)
          .where(where)
          .orderBy(isDesc ? desc(column) : asc(column), asc(expenses.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        app.db.select({ total: count() }).from(expenses).where(where),
      ]);
      return pageOf(rows.map(toDto), total, page, pageSize);
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Record an expense',
        security,
        body: z.object({
          category: z.enum(EXPENSE_CATEGORIES),
          description: z.string().trim().min(1).max(500),
          vendor: z.string().trim().max(200).nullable().optional(),
          amountCents: z.number().int().positive().max(1_000_000_000),
          spentAt: isoDate,
        }),
        response: { 201: expenseSchema, ...errors(400, 401) },
      },
    },
    async (req, reply) => {
      const row = {
        id: newId('exp'),
        orgId: req.auth.orgId,
        category: req.body.category,
        description: req.body.description,
        vendor: req.body.vendor ?? null,
        amountCents: req.body.amountCents,
        spentAt: req.body.spentAt,
        createdBy: req.auth.userId,
        createdAt: nowIso(),
      };
      await app.db.insert(expenses).values(row);
      return reply.status(201).send(toDto(row));
    },
  );

  app.delete(
    '/:id',
    {
      schema: {
        tags: ['Expenses'],
        summary: 'Delete an expense',
        description: 'Owners can delete any expense; members only the ones they created.',
        security,
        params: idParam,
        response: { 204: z.null(), ...errors(401, 403, 404) },
      },
    },
    async (req, reply) => {
      const [row] = await app.db
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, req.params.id), eq(expenses.orgId, req.auth.orgId)));
      if (!row) throw notFound('Expense');
      if (req.auth.role !== 'owner' && row.createdBy !== req.auth.userId) {
        throw forbidden('Members can only delete expenses they created');
      }
      await app.db.delete(expenses).where(eq(expenses.id, row.id));
      return reply.status(204).send(null);
    },
  );
};
