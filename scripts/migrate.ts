/** Applies pending SQL migrations to DATABASE_URL (default ./ledgerly.db). */
import { loadConfig } from '../src/config.js';
import { migrate, openDatabase } from '../src/db/client.js';

const config = loadConfig();
const db = openDatabase(config.DATABASE_URL);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
db.close();
