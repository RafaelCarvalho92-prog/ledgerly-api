import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, PROBLEM_BASE, type ProblemDetails } from '../lib/errors.js';

function send(reply: FastifyReply, req: FastifyRequest, problem: ProblemDetails) {
  return reply
    .status(problem.status)
    .type('application/problem+json')
    .send({ ...problem, instance: req.url, requestId: req.id });
}

/** Centralized RFC 7807 error responses. Internal errors never leak details to clients. */
export const errorsPlugin = fp(async (app) => {
  app.setErrorHandler((error: FastifyError | AppError, req, reply) => {
    if (error instanceof AppError) {
      return send(reply, req, {
        type: `${PROBLEM_BASE}${error.code}`,
        title: error.title,
        status: error.status,
        detail: error.message,
        ...error.extensions,
      });
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      return send(reply, req, {
        type: `${PROBLEM_BASE}validation-error`,
        title: 'Validation failed',
        status: 400,
        detail: 'The request contains invalid fields.',
        errors: error.validation.map((v) => ({
          path: [
            String(error.validationContext ?? ''),
            v.instancePath.replace(/^\//, '').replace(/\//g, '.'),
          ]
            .filter(Boolean)
            .join('.'),
          message: v.message ?? 'Invalid value',
        })),
      });
    }

    const status = error.statusCode ?? 500;
    if (status === 429) {
      return send(reply, req, {
        type: `${PROBLEM_BASE}rate-limited`,
        title: 'Too many requests',
        status,
        detail: error.message,
      });
    }
    if (status >= 400 && status < 500) {
      // Malformed JSON, payload too large, unsupported media type, ...
      return send(reply, req, {
        type: `${PROBLEM_BASE}bad-request`,
        title: 'Bad request',
        status,
        detail: error.message,
      });
    }

    req.log.error({ err: error }, 'unhandled error');
    return send(reply, req, {
      type: `${PROBLEM_BASE}internal`,
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred. Quote the requestId when contacting support.',
    });
  });

  app.setNotFoundHandler((req, reply) =>
    send(reply, req, {
      type: `${PROBLEM_BASE}route-not-found`,
      title: 'Not found',
      status: 404,
      detail: `Route ${req.method} ${req.url.split('?')[0]} does not exist`,
    }),
  );
});
