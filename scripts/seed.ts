/**
 * Seeds DATABASE_URL (default ./ledgerly.db) with a fictional design studio: members, customers,
 * invoices in several states, payments and expenses. Login: maria@northwind-studio.example / correct-horse-42
 */
import { existsSync, rmSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { runScenario } from './scenario.js';

const config = loadConfig({ ...process.env, LOG_LEVEL: 'warn' });
if (
  config.DATABASE_URL !== ':memory:' &&
  process.argv.includes('--reset') &&
  existsSync(config.DATABASE_URL)
) {
  rmSync(config.DATABASE_URL);
}
const app = await buildApp({ ...config, RATE_LIMIT_MAX: 10_000, AUTH_RATE_LIMIT_MAX: 10_000 });
await runScenario(app);
console.log(
  `Seeded ${config.DATABASE_URL}. Login: maria@northwind-studio.example / correct-horse-42`,
);
await app.close();
