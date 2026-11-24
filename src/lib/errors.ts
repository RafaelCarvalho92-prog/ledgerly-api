/**
 * Application errors rendered as RFC 7807 "problem details" (application/problem+json).
 * `type` URIs are stable identifiers that clients can switch on.
 */
export const PROBLEM_BASE = 'https://ledgerly.example/problems/';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; message: string }[];
  [extension: string]: unknown;
}

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    detail?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'AppError';
  }
}

export const badRequest = (detail: string, ext?: Record<string, unknown>) =>
  new AppError(400, 'bad-request', 'Bad request', detail, ext);
export const unauthorized = (detail = 'Authentication required') =>
  new AppError(401, 'unauthorized', 'Unauthorized', detail);
export const forbidden = (detail = 'You do not have permission to perform this action') =>
  new AppError(403, 'forbidden', 'Forbidden', detail);
export const notFound = (resource: string) =>
  new AppError(404, 'not-found', 'Not found', `${resource} not found`);
export const conflict = (code: string, detail: string, ext?: Record<string, unknown>) =>
  new AppError(409, code, 'Conflict', detail, ext);
export const unprocessable = (code: string, detail: string, ext?: Record<string, unknown>) =>
  new AppError(422, code, 'Unprocessable entity', detail, ext);
