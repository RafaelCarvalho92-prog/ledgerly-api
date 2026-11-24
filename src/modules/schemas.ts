/** Shared zod schemas: request validation, response serialization and the OpenAPI document. */
import { z } from 'zod';
import { INVOICE_STATUSES, ROLES } from '../db/schema.js';
import { isoDate } from '../lib/util.js';

export const problemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().optional(),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .passthrough()
  .describe('RFC 7807 problem details (application/problem+json)');

/** Standard error responses for the OpenAPI document. */
export const errors = (...codes: (400 | 401 | 403 | 404 | 409 | 422 | 429)[]) =>
  Object.fromEntries(codes.map((c) => [c, problemSchema])) as Record<number, typeof problemSchema>;

export const idParam = z.object({ id: z.string().min(1).max(64) });
export const money = z.number().int().describe('Amount in minor units (cents)');
export const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Use an ISO 4217 code such as USD')
  .describe('ISO 4217 currency code');

export const userSchema = z.object({ id: z.string(), email: z.string().email(), name: z.string() });
export const orgSchema = z.object({ id: z.string(), name: z.string(), currency });
export const roleSchema = z.enum(ROLES);

export const tokensSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().describe('Access token lifetime in seconds'),
  refreshToken: z.string(),
  refreshExpiresAt: z.string(),
});

export const customerSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  taxId: z.string().nullable(),
  createdAt: z.string(),
});

export const lineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPriceCents: z.number().int().min(0).max(1_000_000_000),
  taxRateBp: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(0)
    .describe('Tax rate in basis points (825 = 8.25%)'),
});

export const lineSchema = lineInputSchema.extend({
  id: z.string(),
  position: z.number().int(),
  subtotalCents: money,
  taxCents: money,
});

export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);

export const invoiceSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  status: invoiceStatusSchema,
  customerId: z.string(),
  currency,
  issueDate: isoDate,
  dueDate: isoDate,
  subtotalCents: money,
  taxCents: money,
  totalCents: money,
  amountPaidCents: money,
  balanceCents: money,
  overdue: z.boolean().describe('Derived: past due date and not fully paid'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const paymentSchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  amountCents: money,
  method: z.enum(['card', 'bank_transfer', 'cash', 'other']),
  paidAt: z.string(),
  reference: z.string().nullable(),
  createdAt: z.string(),
});

export const invoiceDetailSchema = invoiceSummarySchema.extend({
  notes: z.string().nullable(),
  sentAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  lines: z.array(lineSchema),
  payments: z.array(paymentSchema),
});

export const expenseSchema = z.object({
  id: z.string(),
  category: z.string(),
  description: z.string(),
  vendor: z.string().nullable(),
  amountCents: money,
  spentAt: isoDate,
  createdBy: z.string(),
  createdAt: z.string(),
});

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
  joinedAt: z.string(),
});
