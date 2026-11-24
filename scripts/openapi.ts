/** Writes the generated OpenAPI 3.1 document to openapi.json (no server or DB file needed). */
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';

const app = await buildApp(testConfig());
const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
writeFileSync('openapi.json', `${JSON.stringify(doc, null, 2)}\n`);
console.log(`openapi.json written: ${Object.keys(doc.paths).length} paths`);
await app.close();
