import { z } from 'zod';

const DEV_SECRET = 'dev-only-insecure-secret-change-me-0123456789abcdef';

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** SQLite file path or ":memory:". (Postgres: see README "Running on Postgres".) */
    DATABASE_URL: z.string().default('./ledgerly.db'),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters').default(DEV_SECRET),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET === DEV_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'Set a real JWT_SECRET in production',
      });
    }
  });

export type Config = z.infer<typeof schema>;

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<Config> = {},
): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return { ...parsed.data, ...overrides };
}

/** Fast, isolated settings for tests: in-memory DB, cheap hashing, quiet logs. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig(
    { NODE_ENV: 'test' },
    {
      DATABASE_URL: ':memory:',
      BCRYPT_ROUNDS: 4,
      LOG_LEVEL: 'silent',
      RATE_LIMIT_MAX: 10_000,
      AUTH_RATE_LIMIT_MAX: 10_000,
      ...overrides,
    },
  );
}
