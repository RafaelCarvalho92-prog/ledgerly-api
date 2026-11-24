import { and, count, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { idempotencyKeys, invoices, payments } from '../db/schema.js';
import { badRequest, conflict, unprocessable } from '../lib/errors.js';
import { assertTransition, statusAfterPayment } from '../lib/invoiceStatus.js';
import {
  newId,
  nowIso,
  pageOf,
  pageQuery,
  pageSchema,
  sha256,
  stableStringify,
} from '../lib/util.js';
import { findInvoice, toPaymentDto, toSummary } from './invoiceService.js';
import { errors, invoiceSummarySchema, paymentSchema } from './schemas.js';

const security = [{ bearerAuth: [] }];
const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;

const body = z.object({
  invoiceId: z.string().min(1),
  amountCents: z.number().int().positive().max(1_000_000_000),
  method: z.enum(['card', 'bank_transfer', 'cash', 'other']),
  paidAt: z.string().datetime({ offset: true }).optional().describe('Defaults to now'),
  reference: z.string().max(200).nullable().optional(),
});

const responseSchema = z.object({ payment: paymentSchema, invoice: invoiceSummarySchema });

export const paymentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate);

  app.post(
    '/',
    {
      schema: {
        tags: ['Payments'],
        summary: 'Record a payment (idempotent)',
        description:
          'Requires an `Idempotency-Key` header. Retrying with the same key and body returns the ' +
          'original response (header `Idempotent-Replayed: true`) without charging twice; reusing a ' +
          'key with a different body returns 422. Payments move the invoice to partially_paid / paid ' +
          'and can never exceed the outstanding balance.',
        security,
        headers: z.object({
          'idempotency-key': z
            .string()
            .regex(KEY_RE, 'Idempotency-Key must be 8-100 URL-safe characters'),
        }),
        body,
        response: { 201: responseSchema, ...errors(400, 401, 404, 409, 422) },
      },
    },
    async (req, reply) => {
      const key = req.headers['idempotency-key'];
      const requestHash = sha256(stableStringify(req.body));
      const orgId = req.auth.orgId;

      // The whole check-execute-store sequence runs in one serialized transaction, so two
      // concurrent retries with the same key cannot both create a payment.
      const result = await app.database.tx(async () => {
        const [stored] = await app.db
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.orgId, orgId), eq(idempotencyKeys.key, key)));
        if (stored) {
          if (stored.requestHash !== requestHash) {
            throw unprocessable(
              'idempotency-key-reused',
              'This Idempotency-Key was already used with a different request body.',
            );
          }
          return {
            replayed: true,
            status: stored.statusCode,
            body: JSON.parse(stored.responseBody) as unknown,
          };
        }

        const invoice = await findInvoice(app, orgId, req.body.invoiceId);
        assertTransition(invoice.status, 'pay');
        const balance = invoice.totalCents - invoice.amountPaidCents;
        if (req.body.amountCents > balance) {
          throw conflict(
            'overpayment',
            `Payment exceeds the outstanding balance of ${balance} cents.`,
            {
              balanceCents: balance,
            },
          );
        }
        const now = nowIso();
        const payment = {
          id: newId('pay'),
          orgId,
          invoiceId: invoice.id,
          amountCents: req.body.amountCents,
          method: req.body.method,
          paidAt: req.body.paidAt ? new Date(req.body.paidAt).toISOString() : now,
          reference: req.body.reference ?? null,
          createdAt: now,
        };
        const amountPaidCents = invoice.amountPaidCents + payment.amountCents;
        const updated = {
          ...invoice,
          amountPaidCents,
          status: statusAfterPayment(invoice.totalCents, amountPaidCents),
          updatedAt: now,
        };
        await app.db.insert(payments).values(payment);
        await app.db
          .update(invoices)
          .set({ amountPaidCents, status: updated.status, updatedAt: now })
          .where(eq(invoices.id, invoice.id));
        const responseBody = { payment: toPaymentDto(payment), invoice: toSummary(updated) };
        await app.db.insert(idempotencyKeys).values({
          orgId,
          key,
          requestHash,
          statusCode: 201,
          responseBody: JSON.stringify(responseBody),
          createdAt: now,
        });
        return { replayed: false, status: 201, body: responseBody };
      });

      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(201).send(result.body as z.infer<typeof responseSchema>);
    },
  );

  app.get(
    '/',
    {
      schema: {
        tags: ['Payments'],
        summary: 'List payments',
        security,
        querystring: pageQuery(['paidAt'] as const).extend({ invoiceId: z.string().optional() }),
        response: { 200: pageSchema(paymentSchema), ...errors(400, 401) },
      },
    },
    async (req) => {
      const { page, pageSize, sort, invoiceId } = req.query;
      if (sort !== '-paidAt' && sort !== 'paidAt') throw badRequest('Invalid sort');
      const where = and(
        eq(payments.orgId, req.auth.orgId),
        invoiceId ? eq(payments.invoiceId, invoiceId) : undefined,
      );
      const [rows, [{ total } = { total: 0 }]] = await Promise.all([
        app.db
          .select()
          .from(payments)
          .where(where)
          .orderBy(sort === '-paidAt' ? desc(payments.paidAt) : payments.paidAt)
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        app.db.select({ total: count() }).from(payments).where(where),
      ]);
      return pageOf(rows.map(toPaymentDto), total, page, pageSize);
    },
  );
};
