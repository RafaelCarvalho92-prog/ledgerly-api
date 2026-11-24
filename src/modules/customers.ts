import { and, asc, count, desc, eq, like, or, type SQL } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { customers, invoices } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { newId, nowIso, pageOf, pageQuery, pageSchema, parseSort } from '../lib/util.js';
import { customerSchema, errors, idParam } from './schemas.js';

const security = [{ bearerAuth: [] }];
const body = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  taxId: z.string().trim().max(50).nullable().optional(),
});

const toDto = (c: typeof customers.$inferSelect) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  taxId: c.taxId,
  createdAt: c.createdAt,
});

export const customerRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  /** Tenant-scoped lookup: another organization's customer is indistinguishable from a missing one. */
  async function findCustomer(orgId: string, id: string) {
    const [row] = await app.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.orgId, orgId)));
    if (!row) throw notFound('Customer');
    return row;
  }

  app.get(
    '/',
    {
      schema: {
        tags: ['Customers'],
        summary: 'List customers',
        security,
        querystring: pageQuery(['name', 'createdAt'] as const).extend({
          q: z.string().trim().max(100).optional().describe('Search in name and email'),
        }),
        response: { 200: pageSchema(customerSchema), ...errors(400, 401) },
      },
    },
    async (req) => {
      const { page, pageSize, sort, q } = req.query;
      const filters: (SQL | undefined)[] = [eq(customers.orgId, req.auth.orgId)];
      if (q) {
        // Wildcards are stripped so user input is a plain substring search.
        const pattern = `%${q.replace(/[%_\\]/g, '')}%`;
        filters.push(or(like(customers.name, pattern), like(customers.email, pattern)));
      }
      const where = and(...filters);
      const { field, desc: isDesc } = parseSort<'name' | 'createdAt'>(sort);
      const column = field === 'name' ? customers.name : customers.createdAt;
      const [rows, [{ total } = { total: 0 }]] = await Promise.all([
        app.db
          .select()
          .from(customers)
          .where(where)
          .orderBy(isDesc ? desc(column) : asc(column), asc(customers.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        app.db.select({ total: count() }).from(customers).where(where),
      ]);
      return pageOf(rows.map(toDto), total, page, pageSize);
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Create a customer',
        security,
        body,
        response: { 201: customerSchema, ...errors(400, 401) },
      },
    },
    async (req, reply) => {
      const row = {
        id: newId('cus'),
        orgId: req.auth.orgId,
        name: req.body.name,
        email: req.body.email ?? null,
        taxId: req.body.taxId ?? null,
        createdAt: nowIso(),
      };
      await app.db.insert(customers).values(row);
      return reply.status(201).send(toDto(row));
    },
  );

  app.get(
    '/:id',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Get a customer',
        security,
        params: idParam,
        response: { 200: customerSchema, ...errors(401, 404) },
      },
    },
    async (req) => toDto(await findCustomer(req.auth.orgId, req.params.id)),
  );

  app.patch(
    '/:id',
    {
      schema: {
        tags: ['Customers'],
        summary: 'Update a customer',
        security,
        params: idParam,
        body: body.partial().refine((b) => Object.keys(b).length > 0, 'Provide at least one field'),
        response: { 200: customerSchema, ...errors(400, 401, 404) },
      },
    },
    async (req) => {
      const current = await findCustomer(req.auth.orgId, req.params.id);
      const next = { ...current, ...req.body };
      await app.db
        .update(customers)
        .set({ name: next.name, email: next.email ?? null, taxId: next.taxId ?? null })
        .where(eq(customers.id, current.id));
      return toDto({ ...next, email: next.email ?? null, taxId: next.taxId ?? null });
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['Customers'],
        summary: 'Delete a customer (owner only)',
        description: 'Customers with invoices cannot be deleted (409), to keep the ledger intact.',
        security,
        params: idParam,
        response: { 204: z.null(), ...errors(401, 403, 404, 409) },
      },
    },
    async (req, reply) => {
      await app.database.tx(async () => {
        const customer = await findCustomer(req.auth.orgId, req.params.id);
        const [{ n } = { n: 0 }] = await app.db
          .select({ n: count() })
          .from(invoices)
          .where(eq(invoices.customerId, customer.id));
        if (n > 0)
          throw conflict(
            'customer-has-invoices',
            `Customer has ${n} invoice(s) and cannot be deleted.`,
          );
        await app.db.delete(customers).where(eq(customers.id, customer.id));
      });
      return reply.status(204).send(null);
    },
  );
};
