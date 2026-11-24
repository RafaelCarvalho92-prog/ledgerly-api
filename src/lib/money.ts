/**
 * Invoice math in integer minor units. Tax is computed per line (rounded half-up), which is how
 * most invoicing systems print it, so the document always adds up line by line.
 */

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** Basis points: 825 = 8.25%. */
  taxRateBp: number;
}

export interface LineTotals extends LineInput {
  subtotalCents: number;
  taxCents: number;
}

export interface InvoiceTotals {
  lines: LineTotals[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/** Half-up rounding that is robust to binary floating-point noise (2.675 * 100 etc.). */
export function roundHalfUp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value) + 1e-9);
}

export function computeLine(line: LineInput): LineTotals {
  const subtotalCents = roundHalfUp(line.quantity * line.unitPriceCents);
  const taxCents = roundHalfUp((subtotalCents * line.taxRateBp) / 10_000);
  return { ...line, subtotalCents, taxCents };
}

export function computeInvoice(lines: LineInput[]): InvoiceTotals {
  const computed = lines.map(computeLine);
  const subtotalCents = computed.reduce((s, l) => s + l.subtotalCents, 0);
  const taxCents = computed.reduce((s, l) => s + l.taxCents, 0);
  return { lines: computed, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
