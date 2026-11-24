/**
 * Builds the static API docs site (docs-site/dist):
 *   - openapi.json generated from the live route schemas
 *   - Redoc standalone (bundled from node_modules, no CDN) rendering it
 *   - a "Try it" console replaying request/response pairs RECORDED from the real API
 *   - a test & coverage summary read from Vitest's JSON outputs
 * Run `npm run docs` (which runs the tests with coverage first).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildApp } from '../src/app.js';
import { testConfig } from '../src/config.js';
import { runScenario } from './scenario.js';

const OUT = 'docs-site/dist';
mkdirSync(OUT, { recursive: true });

const app = await buildApp(testConfig());
const openapi = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
const examples = await runScenario(app, true);
await app.close();

writeFileSync(`${OUT}/openapi.json`, `${JSON.stringify(openapi, null, 2)}\n`);
const require = createRequire(import.meta.url);
copyFileSync(require.resolve('redoc/bundles/redoc.standalone.js'), `${OUT}/redoc.standalone.js`);

interface TestFile {
  name: string;
  assertionResults: { title: string; ancestorTitles: string[]; status: string }[];
}
const results = existsSync('coverage/test-results.json')
  ? (JSON.parse(readFileSync('coverage/test-results.json', 'utf8')) as {
      numTotalTests: number;
      numPassedTests: number;
      testResults: TestFile[];
    })
  : null;
const coverage = existsSync('coverage/coverage-summary.json')
  ? (JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8')) as {
      total: Record<'lines' | 'statements' | 'functions' | 'branches', { pct: number }>;
    })
  : null;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const testsHtml = results
  ? results.testResults
      .map((f) => {
        const file = f.name.replace(/\\/g, '/').split('/tests/')[1] ?? f.name;
        const items = f.assertionResults
          .map(
            (a) =>
              `<li><span class="ok" aria-label="${a.status}">${a.status === 'passed' ? '✓' : '✗'}</span> ${esc([...a.ancestorTitles, a.title].join(' › '))}</li>`,
          )
          .join('');
        return `<details><summary><code>tests/${esc(file)}</code> <span class="muted">${f.assertionResults.length} tests</span></summary><ul class="tests">${items}</ul></details>`;
      })
      .join('')
  : '<p class="muted">Run <code>npm run docs</code> to include test results.</p>';

const metric = (label: string, pct?: number) =>
  `<div class="metric"><span>${label}</span><b>${pct === undefined ? '-' : `${pct.toFixed(1)}%`}</b><div class="bar"><i style="width:${pct ?? 0}%"></i></div></div>`;

const endpoints = Object.entries(
  openapi.paths as Record<string, Record<string, { summary?: string; tags?: string[] }>>,
).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({
    method: method.toUpperCase(),
    path,
    summary: op.summary ?? '',
    tag: op.tags?.[0] ?? '',
  })),
);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledgerly API Docs</title>
<meta name="description" content="Ledgerly API: multi-tenant invoicing & expenses REST API (Fastify, TypeScript, Drizzle). OpenAPI 3.1 reference, mock console and test coverage.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234f46e5'/%3E%3Cpath d='M9 9v14h14' stroke='white' stroke-width='3' fill='none'/%3E%3C/svg%3E">
<style>
:root{color-scheme:light;--bg:#f8fafc;--surface:#fff;--text:#0f172a;--muted:#64748b;--border:#e2e8f0;--brand:#4f46e5;--code:#0f172a;--codetext:#e2e8f0;--ok:#15803d;--warn:#b45309;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#020617;--surface:#0f172a;--text:#e2e8f0;--muted:#94a3b8;--border:#1e293b;--brand:#818cf8;--ok:#4ade80;--warn:#fbbf24;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand)}:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
.banner{background:#0f172a;color:#e2e8f0;text-align:center;font-size:13px;padding:6px 16px}
header.top{border-bottom:1px solid var(--border);background:var(--surface)}
.wrap{max-width:1180px;margin:0 auto;padding:0 16px}
.nav{display:flex;gap:18px;align-items:center;padding:14px 0;flex-wrap:wrap}.nav .logo{font-weight:800;font-size:18px;margin-right:auto;color:var(--text);text-decoration:none}
.nav a{text-decoration:none;font-weight:600;font-size:14px}
.hero{padding:40px 0 20px}.hero h1{font-size:clamp(28px,4.5vw,42px);letter-spacing:-.03em;margin:0 0 10px;line-height:1.1}
.lead{color:var(--muted);font-size:17px;max-width:820px;margin:0 0 16px}
.pills{display:flex;flex-wrap:wrap;gap:6px}.pill{border:1px solid var(--border);border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted);background:var(--surface)}
section{padding:28px 0}h2{font-size:24px;letter-spacing:-.02em;margin:0 0 6px}.sub{color:var(--muted);margin:0 0 16px;max-width:820px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px}.card h3{margin:0 0 4px;font-size:15px}.card p{margin:0;color:var(--muted);font-size:14px}
.mock-flag{display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;border-radius:6px;font-weight:700;font-size:12px;padding:1px 8px;letter-spacing:.04em}
.console{display:grid;grid-template-columns:300px 1fr;gap:0;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--surface)}
.calls{border-right:1px solid var(--border);max-height:620px;overflow:auto}
.calls button{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;border:0;border-bottom:1px solid var(--border);background:transparent;color:var(--text);padding:10px 12px;cursor:pointer;font:inherit;font-size:13px}
.calls button[aria-selected=true]{background:color-mix(in srgb,var(--brand) 12%,transparent)}
.m{font:700 11px ui-monospace,Menlo,Consolas,monospace;min-width:46px}.m.GET{color:var(--ok)}.m.POST{color:var(--brand)}.m.PATCH{color:var(--warn)}.m.DELETE{color:var(--err)}
.pane{padding:14px;min-width:0}.req{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.req code{font-size:13px;word-break:break-all}.send{border:0;background:var(--brand);color:#fff;border-radius:8px;padding:6px 14px;font-weight:700;cursor:pointer}
pre{background:var(--code);color:var(--codetext);border-radius:10px;padding:12px;overflow:auto;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:340px;margin:6px 0 12px}
.label{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.status{font-weight:800}.s2{color:var(--ok)}.s4{color:var(--warn)}.s5{color:var(--err)}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}
.metric{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px}.metric span{color:var(--muted);font-size:13px;display:block}.metric b{font-size:24px}
.bar{height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--ok)}
details{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 12px;margin-bottom:8px}summary{cursor:pointer;font-weight:600}
ul.tests{list-style:none;padding:0;margin:8px 0 0;font-size:13.5px}ul.tests li{padding:2px 0}.ok{color:var(--ok);font-weight:800}
.muted{color:var(--muted);font-weight:400}
table.ep{width:100%;border-collapse:collapse;font-size:14px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.ep th,.ep td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border)}.ep th{color:var(--muted);font-size:12px;text-transform:uppercase}
#redoc{background:#fff;border-top:1px solid var(--border)}
footer{padding:24px 16px 48px;color:var(--muted);font-size:14px;text-align:center}
@media (max-width:820px){.console{grid-template-columns:1fr}.calls{max-height:260px;border-right:0;border-bottom:1px solid var(--border)}}
</style></head>
<body>
<div class="banner">Portfolio project: fictional data. The "Try it" console is a <strong>mock</strong> that replays responses recorded from the real API's automated test run.</div>
<header class="top"><div class="wrap nav"><a class="logo" href="#">Ledgerly API</a><a href="#try">Try it (mock)</a><a href="#endpoints">Endpoints</a><a href="#tests">Tests</a><a href="./reference.html">Reference</a><a href="./openapi.json">openapi.json</a><a href="./ledgerly-source.zip" download>Source (.zip)</a></div></header>
<main>
<div class="wrap hero">
  <h1>Invoicing &amp; expenses API for small businesses</h1>
  <p class="lead">A multi-tenant REST API covering organizations, roles, customers, invoices with a status machine, idempotent payments, expenses and reports. It is production-style: typed end to end, validated with zod, documented with an OpenAPI 3.1 spec generated from the code, and covered by ${results?.numTotalTests ?? 'many'} integration and unit tests.</p>
  <div class="pills">${['Node 24', 'TypeScript (strict)', 'Fastify 5', 'zod', 'Drizzle ORM', 'SQLite (node:sqlite) / Postgres-ready', 'JWT + rotating refresh tokens', 'RBAC', 'RFC 7807 errors', 'Idempotency keys', 'Rate limiting', 'pino', 'Vitest'].map((p) => `<span class="pill">${p}</span>`).join('')}</div>
</div>

<section class="wrap" aria-labelledby="features"><h2 id="features">What's inside</h2>
<div class="grid">
<div class="card"><h3>Multi-tenant by design</h3><p>Every query is scoped to the organization in the JWT. Other tenants' records return 404, never 403, so their existence isn't leaked.</p></div>
<div class="card"><h3>Auth that holds up</h3><p>bcrypt hashing; 15-minute access JWTs; refresh tokens that rotate, are stored hashed, and revoke their whole family when reuse is detected; timing-safe login.</p></div>
<div class="card"><h3>Correct money</h3><p>Integer cents, per-line tax with half-up rounding, a server-side total, and a status machine (draft → sent → partially_paid → paid / void). Overpayments are rejected.</p></div>
<div class="card"><h3>Safe retries</h3><p><code>POST /payments</code> requires an <code>Idempotency-Key</code>. Retries replay the stored response; reusing a key with a different body returns 422. Concurrent retries are serialized.</p></div>
<div class="card"><h3>Operable</h3><p>Request IDs, pino structured logs with secrets redacted, <code>/health</code> and <code>/ready</code> probes, rate limits, graceful shutdown, Docker and Compose files, CI.</p></div>
<div class="card"><h3>Documented from code</h3><p>The same zod schemas validate requests, serialize responses and generate this OpenAPI 3.1 document, so the docs can't drift from the code.</p></div>
</div></section>

<section class="wrap" id="try" aria-labelledby="try-h"><h2 id="try-h">Try it <span class="mock-flag">MOCK</span></h2>
<p class="sub">Pick a call and press <strong>Send</strong>. Nothing hits a server: the response was recorded from the real API during <code>npm run docs</code>. That run registers an organization, invites a member, creates customers and invoices, records idempotent payments and expenses, and triggers some errors on purpose.</p>
<div class="console"><div class="calls" role="tablist" aria-label="Example requests" id="calls"></div>
<div class="pane" role="tabpanel" id="pane" aria-live="polite"></div></div></section>

<section class="wrap" id="endpoints" aria-labelledby="ep-h"><h2 id="ep-h">Endpoints</h2>
<table class="ep"><thead><tr><th>Method</th><th>Path</th><th>Summary</th><th>Tag</th></tr></thead><tbody>
${endpoints.map((e) => `<tr><td><span class="m ${e.method}">${e.method}</span></td><td><code>${esc(e.path)}</code></td><td>${esc(e.summary)}</td><td class="muted">${esc(e.tag)}</td></tr>`).join('')}
</tbody></table></section>

<section class="wrap" id="tests" aria-labelledby="tests-h"><h2 id="tests-h">Tests &amp; coverage</h2>
<p class="sub">${results ? `<strong>${results.numPassedTests}/${results.numTotalTests} tests passing.</strong> ` : ''}Integration tests call the real HTTP layer through <code>app.inject</code>, and every test file gets a fresh, migrated SQLite database.</p>
<div class="metrics">${metric('Statements', coverage?.total.statements.pct)}${metric('Branches', coverage?.total.branches.pct)}${metric('Functions', coverage?.total.functions.pct)}${metric('Lines', coverage?.total.lines.pct)}</div>
${testsHtml}</section>

<section class="wrap" id="reference" aria-labelledby="ref-h"><h2 id="ref-h">API reference</h2><p class="sub">The full OpenAPI 3.1 reference (schemas, parameters, responses) opens on its own page, rendered with Redoc bundled locally (no CDN). Keeping it separate keeps this page light and responsive.</p><p><a class="send" style="text-decoration:none;display:inline-block" href="./reference.html">Open the full API reference</a> &nbsp; <a href="./openapi.json">Download openapi.json</a></p></section>
</main>
<footer>Ledgerly API, a portfolio project by <a href="https://rafaelcarvalho.dev">Rafael Carvalho</a>. All data shown is fictional.</footer>
<script id="examples" type="application/json">${json(examples)}</script>
<script>
(function(){
  var examples = JSON.parse(document.getElementById('examples').textContent);
  var calls = document.getElementById('calls'), pane = document.getElementById('pane');
  function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; }
  function pretty(v){ return v==null ? '(empty body)' : JSON.stringify(v, null, 2); }
  function curl(x){
    var parts=['curl -X '+x.method+' "http://localhost:3000'+x.url+'"'];
    Object.keys(x.headers||{}).forEach(function(k){ parts.push('  -H "'+k+': '+x.headers[k]+'"'); });
    if(x.body!==undefined){ parts.push('  -H "content-type: application/json"'); parts.push("  -d '"+JSON.stringify(x.body)+"'"); }
    return parts.join(' \\\\\\n');
  }
  function show(i){
    var x=examples[i];
    Array.prototype.forEach.call(calls.children,function(b,j){ b.setAttribute('aria-selected', String(i===j)); b.tabIndex = i===j?0:-1; });
    pane.replaceChildren();
    var req=el('div','req'); req.append(el('span','m '+x.method,x.method), el('code',null,x.url));
    var send=el('button','send','Send (mock)'); send.type='button'; req.append(send); pane.append(el('h3',null,x.title), req);
    pane.append(el('div','label','curl'), el('pre',null,curl(x)));
    var out=el('div'); pane.append(out);
    send.addEventListener('click', function(){
      out.replaceChildren(el('p','muted','Sending...'));
      setTimeout(function(){
        out.replaceChildren();
        var st=el('div','label','Response '); var code=el('span','status s'+String(x.status)[0], x.status+' '); st.append(code, el('span','muted','(recorded, mock replay)'));
        out.append(st, el('pre',null,Object.keys(x.responseHeaders).map(function(k){return k+': '+x.responseHeaders[k];}).join('\\n')), el('pre',null,pretty(x.response)));
      }, 250 + Math.random()*250);
    });
  }
  examples.forEach(function(x,i){
    var b=el('button'); b.type='button'; b.setAttribute('role','tab'); b.append(el('span','m '+x.method,x.method), el('span',null,x.title));
    b.addEventListener('click', function(){ show(i); });
    b.addEventListener('keydown', function(e){ if(e.key==='ArrowDown'||e.key==='ArrowUp'){ e.preventDefault(); var n=(i+(e.key==='ArrowDown'?1:examples.length-1))%examples.length; show(n); calls.children[n].focus(); } });
    calls.append(b);
  });
  show(0);
})();
</script>
</body></html>
`;
writeFileSync(`${OUT}/index.html`, html);
// Full-page Redoc, the way Redoc is designed to run (its sticky sidebar and scroll-spy assume
// they own the viewport). The spec is inlined so the page also works from file://.
const reference = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ledgerly API Reference</title>
<style>body{margin:0}.back{position:fixed;z-index:20;right:16px;bottom:16px;background:#4f46e5;color:#fff;padding:6px 12px;border-radius:8px;font:600 13px system-ui,sans-serif;text-decoration:none}</style>
</head><body>
<a class="back" href="./index.html">Back to overview</a>
<div id="redoc"></div>
<script id="spec" type="application/json">${json(openapi)}</script>
<script src="./redoc.standalone.js"></script>
<script>
Redoc.init(JSON.parse(document.getElementById('spec').textContent), {
  lazyRendering: true,
  expandResponses: '200,201',
  theme: { colors: { primary: { main: '#4f46e5' } } }
}, document.getElementById('redoc'));
</script>
</body></html>
`;
writeFileSync(`${OUT}/reference.html`, reference);
console.log(
  `docs-site/dist: index.html, openapi.json (${endpoints.length} operations), ${examples.length} recorded examples`,
);
