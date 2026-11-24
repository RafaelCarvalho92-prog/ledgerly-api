import type { InvoiceStatus } from '../db/schema.js';
import { conflict } from './errors.js';

/**
 * Invoice lifecycle.
 *
 *   draft --send--> sent --payment--> partially_paid --payment--> paid
 *     |               |                                (or straight to paid)
 *     +----void-------+  (void only while nothing has been paid)
 *
 * `paid` and `void` are terminal. Line items can only change while the invoice is a draft.
 */
export type InvoiceAction = 'send' | 'void' | 'edit' | 'pay' | 'delete';

const ALLOWED: Record<InvoiceAction, readonly InvoiceStatus[]> = {
  edit: ['draft'],
  delete: ['draft'],
  send: ['draft'],
  void: ['draft', 'sent'],
  pay: ['sent', 'partially_paid'],
};

export function canPerform(status: InvoiceStatus, action: InvoiceAction): boolean {
  return ALLOWED[action].includes(status);
}

export function assertTransition(status: InvoiceStatus, action: InvoiceAction): void {
  if (!canPerform(status, action)) {
    throw conflict(
      'invalid-invoice-state',
      `Cannot ${action} an invoice with status "${status}".`,
      {
        currentStatus: status,
        allowedFrom: ALLOWED[action],
      },
    );
  }
}

/** Status after recording a payment. */
export function statusAfterPayment(totalCents: number, amountPaidCents: number): InvoiceStatus {
  return amountPaidCents >= totalCents ? 'paid' : 'partially_paid';
}

/** Overdue is derived (not stored) so it can never go stale. */
export function isOverdue(status: InvoiceStatus, dueDate: string, today: string): boolean {
  return (status === 'sent' || status === 'partially_paid') && dueDate < today;
}
