import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { migrate, openDatabase, type Database, type DB } from './db/client.js';
import { authRoutes } from './modules/auth.js';
import { customerRoutes } from './modules/customers.js';
import { expenseRoutes } from './modules/expenses.js';
import { healthRoutes } from './modules/health.js';
import { invoiceRoutes } from './modules/invoices.js';
import { memberRoutes } from './modules/members.js';
import { paymentRoutes } from './modules/payments.js';
import { reportRoutes } from './modules/reports.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    database: Database;
    db: DB;
  }
}

export type App = FastifyInstance;

const REQUEST_ID_RE = /^[\w.-]{8,128}$/;

export async function buildApp(config: Config, database?: Database): Promise<App> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.refreshToken'],
      ...(config.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
    },
    // Propagate a caller's X-Request-Id (if sane) or generate one; echoed on every response.
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    bodyLimit: 256 * 1024,
    ajv: { customOptions: { coerceTypes: false } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = database ?? openDatabase(config.DATABASE_URL);
  migrate(db);
  app.decorate('config', config);
  app.decorate('database', db);
  app.decorate('db', db.db);
  if (!database) app.addHook('onClose', async () => db.close());

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.CORS_ORIGINS ? config.CORS_ORIGINS.split(',').map((o) => o.trim()) : false,
    exposedHeaders: ['x-request-id', 'idempotent-replayed', 'retry-after'],
  });
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    // Authenticated clients are limited per organization, anonymous ones per IP.
    keyGenerator: (req) => req.ip,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Ledgerly API',
        version: '1.0.0',
        description:
          'Multi-tenant invoicing & expenses API. All amounts are integer minor units (cents). ' +
          'Errors use RFC 7807 application/problem+json. Fictional demo project.',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      tags: [
        { name: 'Health' },
        { name: 'Auth' },
        { name: 'Members' },
        { name: 'Customers' },
        { name: 'Invoices' },
        { name: 'Payments' },
        { name: 'Expenses' },
        { name: 'Reports' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(errorsPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/v1/auth' });
  await app.register(memberRoutes, { prefix: '/v1/members' });
  await app.register(customerRoutes, { prefix: '/v1/customers' });
  await app.register(invoiceRoutes, { prefix: '/v1/invoices' });
  await app.register(paymentRoutes, { prefix: '/v1/payments' });
  await app.register(expenseRoutes, { prefix: '/v1/expenses' });
  await app.register(reportRoutes, { prefix: '/v1/reports' });

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  await app.ready();
  return app;
}
