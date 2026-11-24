/**
 * Drizzle schema (SQLite dialect). Money is stored as integer minor units (cents); dates as
 * ISO-8601 text. The same model maps 1:1 to Postgres (see README).
 */
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const ROLES = ['owner', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const INVOICE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').notNull(),
  /** Last issued invoice sequence (migration 0002). */
  invoiceSeq: integer('invoice_seq').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: text('created_at').notNull(),
});

export const memberships = sqliteTable(
  'memberships',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ROLES }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk0: primaryKey({ columns: [t.userId, t.orgId] }),
  }),
);

export const refreshTokens = sqliteTable(
  'refresh_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    familyId: text('family_id').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    refresh_family_idx: index('refresh_family_idx').on(t.familyId),
  }),
);

export const customers = sqliteTable(
  'customers',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email'),
    taxId: text('tax_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    customers_org_idx: index('customers_org_idx').on(t.orgId, t.name),
  }),
);

export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id),
    number: text('number').notNull(),
    status: text('status', { enum: INVOICE_STATUSES }).notNull(),
    currency: text('currency').notNull(),
    issueDate: text('issue_date').notNull(),
    dueDate: text('due_date').notNull(),
    subtotalCents: integer('subtotal_cents').notNull(),
    taxCents: integer('tax_cents').notNull(),
    totalCents: integer('total_cents').notNull(),
    amountPaidCents: integer('amount_paid_cents').notNull(),
    notes: text('notes'),
    sentAt: text('sent_at'),
    voidedAt: text('voided_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({
    invoices_org_number_uq: uniqueIndex('invoices_org_number_uq').on(t.orgId, t.number),
    invoices_org_status_idx: index('invoices_org_status_idx').on(t.orgId, t.status),
  }),
);

export const invoiceLines = sqliteTable('invoice_lines', {
  id: text('id').primaryKey(),
  invoiceId: text('invoice_id')
    .notNull()
    .references(() => invoices.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  description: text('description').notNull(),
  quantity: real('quantity').notNull(),
  unitPriceCents: integer('unit_price_cents').notNull(),
  /** Tax rate in basis points (825 = 8.25%). */
  taxRateBp: integer('tax_rate_bp').notNull(),
  subtotalCents: integer('subtotal_cents').notNull(),
  taxCents: integer('tax_cents').notNull(),
});

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amountCents: integer('amount_cents').notNull(),
    method: text('method').notNull(),
    paidAt: text('paid_at').notNull(),
    reference: text('reference'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    payments_org_idx: index('payments_org_idx').on(t.orgId, t.paidAt),
  }),
);

export const idempotencyKeys = sqliteTable(
  'idempotency_keys',
  {
    orgId: text('org_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    statusCode: integer('status_code').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk0: primaryKey({ columns: [t.orgId, t.key] }),
  }),
);

export const expenses = sqliteTable(
  'expenses',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    description: text('description').notNull(),
    vendor: text('vendor'),
    amountCents: integer('amount_cents').notNull(),
    spentAt: text('spent_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    expenses_org_idx: index('expenses_org_idx').on(t.orgId, t.spentAt),
  }),
);
