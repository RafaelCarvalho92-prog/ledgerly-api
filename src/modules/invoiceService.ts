import { and, asc, desc, eq } from 'drizzle-orm';
import type { App } from '../app.js';
import { invoiceLines, invoices, payments } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { isOverdue } from '../lib/invoiceStatus.js';
import { today } from '../lib/util.js';

export type InvoiceRow = typeof invoices.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

export function toSummary(row: InvoiceRow, now = today()) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    customerId: row.customerId,
    currency: row.currency,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    amountPaidCents: row.amountPaidCents,
    balanceCents: row.status === 'void' ? 0 : row.totalCents - row.amountPaidCents,
    overdue: isOverdue(row.status, row.dueDate, now),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPaymentDto(p: PaymentRow) {
  return {
    id: p.id,
    invoiceId: p.invoiceId,
    amountCents: p.amountCents,
    method: p.method as 'card' | 'bank_transfer' | 'cash' | 'other',
    paidAt: p.paidAt,
    reference: p.reference,
    createdAt: p.createdAt,
  };
}

/** Loads an invoice of the caller's organization (404 for other tenants' invoices). */
export async function findInvoice(app: App, orgId: string, id: string): Promise<InvoiceRow> {
  const [row] = await app.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.orgId, orgId)));
  if (!row) throw notFound('Invoice');
  return row;
}

export async function invoiceDetail(app: App, row: InvoiceRow) {
  const [lines, pays] = await Promise.all([
    app.db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, row.id))
      .orderBy(asc(invoiceLines.position)),
    app.db
      .select()
      .from(payments)
      .where(eq(payments.invoiceId, row.id))
      .orderBy(desc(payments.paidAt)),
  ]);
  return {
    ...toSummary(row),
    notes: row.notes,
    sentAt: row.sentAt,
    voidedAt: row.voidedAt,
    lines: lines.map((l) => ({
      id: l.id,
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      taxRateBp: l.taxRateBp,
      subtotalCents: l.subtotalCents,
      taxCents: l.taxCents,
    })),
    payments: pays.map(toPaymentDto),
  };
}
