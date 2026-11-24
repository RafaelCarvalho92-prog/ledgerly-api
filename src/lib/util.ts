import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const nowIso = () => new Date().toISOString();
export const today = () => new Date().toISOString().slice(0, 10);
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');

/** Stable JSON stringify (sorted keys) used to fingerprint idempotent requests. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---- Pagination / sorting -------------------------------------------------------------------

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date as YYYY-MM-DD');

export function pageQuery<S extends readonly [string, ...string[]]>(sortFields: S) {
  const sortValues = sortFields.flatMap((f) => [f, `-${f}`]) as [string, ...string[]];
  return z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z
      .enum(sortValues)
      .default(`-${sortFields[0]}`)
      .describe(`Sort field; prefix with "-" for descending. One of: ${sortFields.join(', ')}`),
  });
}

export function parseSort<F extends string>(sort: string): { field: F; desc: boolean } {
  return sort.startsWith('-')
    ? { field: sort.slice(1) as F, desc: true }
    : { field: sort as F, desc: false };
}

export interface Page<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function pageOf<T>(data: T[], total: number, page: number, pageSize: number): Page<T> {
  return { data, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const pageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  });
