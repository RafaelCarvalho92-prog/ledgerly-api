import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const started = Date.now();

export const healthRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/health',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Returns 200 while the process is up. Does not touch the database.',
        response: { 200: z.object({ status: z.literal('ok'), uptimeSeconds: z.number() }) },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
    }),
  );

  app.get(
    '/ready',
    {
      config: { rateLimit: false },
      schema: {
        tags: ['Health'],
        summary: 'Readiness probe',
        description: 'Returns 200 when the database answers, 503 otherwise.',
        response: {
          200: z.object({
            status: z.literal('ready'),
            checks: z.object({ database: z.literal('ok') }),
          }),
          503: z.object({
            status: z.literal('unavailable'),
            checks: z.object({ database: z.literal('down') }),
          }),
        },
      },
    },
    async (_req, reply) => {
      let ok = false;
      try {
        ok = app.database.ping();
      } catch {
        ok = false;
      }
      return ok
        ? { status: 'ready' as const, checks: { database: 'ok' as const } }
        : reply
            .status(503)
            .send({ status: 'unavailable' as const, checks: { database: 'down' as const } });
    },
  );
};
