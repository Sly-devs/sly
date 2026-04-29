import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timing } from 'hono/timing';
import { secureHeaders } from 'hono/secure-headers';
import { prettyJSON } from 'hono/pretty-json';
import { scanRouter } from './routes/scan.js';
import { batchRouter } from './routes/batch.js';
import { testsRouter } from './routes/tests.js';
import { observatoryRouter } from './routes/observatory.js';
import { prospectsRouter } from './routes/prospects.js';
import { healthRouter } from './routes/health.js';
import { trafficMonitorRouter } from './routes/traffic-monitor.js';
import { reportsRouter } from './routes/reports.js';
import { creditsRouter } from './routes/credits.js';
import { keysRouter } from './routes/keys.js';
import { adminRouter } from './routes/admin.js';
import { mcpRouter } from './routes/mcp.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimitMiddleware } from './middleware/rate-limit.js';
import { usageCounterMiddleware } from './middleware/usage-counter.js';
import { creditsMiddleware } from './middleware/credits.js';

const app = new Hono();

// Global middleware
app.use('*', timing());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:4000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Environment'],
}));

if (process.env.NODE_ENV === 'development') {
  app.use('*', prettyJSON());
}

// Request ID middleware — accepts inbound X-Request-ID, otherwise generates a
// UUID. Stores on ctx vars so downstream middleware (credits, usage) can tag
// debits with a consistent correlation ID.
app.use('*', async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-ID', requestId);
  await next();
});

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
  }
}

// Reports + landing — `experimentalServices` in vercel.json routes the entire
// `/` prefix to this function, so `.vercel/output/static/` is never served.
// We bundle the report HTML/MD/CSV/PDF next to the function (build-vercel.mjs)
// and serve them ourselves.
const REPORT_PATH_CANDIDATES = [
  resolve(process.cwd(), 'reports'),                       // bundled function dir
  resolve(process.cwd(), 'scanner-reports'),               // dev from repo root
  resolve(process.cwd(), '..', '..', 'scanner-reports'),   // dev from apps/scanner
];
const LANDING_FILENAME = 'baseline-q1-2026-report.html';
const REPORTS_DIR =
  REPORT_PATH_CANDIDATES.find((dir) =>
    existsSync(resolve(dir, LANDING_FILENAME)),
  ) ?? REPORT_PATH_CANDIDATES[0]!;
const LANDING_HTML = existsSync(resolve(REPORTS_DIR, LANDING_FILENAME))
  ? readFileSync(resolve(REPORTS_DIR, LANDING_FILENAME), 'utf-8')
  : null;

app.get('/', (c) => {
  if (!LANDING_HTML) {
    return c.json({ service: 'sly-scanner', status: 'ok' });
  }
  return c.html(LANDING_HTML);
});

const REPORT_FILE_RE = /^[a-z0-9_-]+\.(html|md|csv|pdf|png|jpe?g)$/i;
const REPORT_CT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

app.get('/reports', (c) => c.redirect('/reports/'));
app.get('/reports/', (c) => {
  const items = ['baseline-q1-2026-report.html', 'baseline-q1-2026-report.md', 'uk-eu-latam-africa-300-report.html', 'uk-eu-latam-africa-300-report.pdf']
    .filter((f) => existsSync(resolve(REPORTS_DIR, f)))
    .map((f) => `    <li><a href="/reports/${f}">${f}</a></li>`)
    .join('\n');
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sly Scanner Reports</title><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;line-height:1.6;color:#1e1b4b}h1{color:#7c3aed}a{color:#7c3aed;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><h1>Sly Scanner Reports</h1><ul>\n${items}\n</ul></body></html>`);
});

app.get('/reports/:file', (c) => {
  const file = c.req.param('file');
  if (!REPORT_FILE_RE.test(file)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const target = resolve(REPORTS_DIR, file);
  if (!target.startsWith(REPORTS_DIR + '/') || !existsSync(target)) {
    return c.json({ error: 'not_found' }, 404);
  }
  const ext = file.split('.').pop()!.toLowerCase();
  const ct = REPORT_CT[ext] ?? 'application/octet-stream';
  c.header('Content-Type', ct);
  return c.body(readFileSync(target));
});

// Public routes — health, readiness
app.route('/', healthRouter);

// These v1 paths must be callable without auth:
// - snippet.js is loaded by merchant sites
// - beacon receives telemetry from those sites (cross-origin)
// - /traffic/:id/embed renders a shareable widget
const PUBLIC_V1_PATHS = new Set([
  '/v1/scanner/snippet.js',
  '/v1/scanner/beacon',
]);
const PUBLIC_V1_SUFFIXES = ['/embed'];

function isPublicV1(path: string): boolean {
  if (PUBLIC_V1_PATHS.has(path)) return true;
  return PUBLIC_V1_SUFFIXES.some((s) => path.endsWith(s));
}

// Admin routes gate themselves via CRON_SECRET — mounted before the v1 auth
// group so user JWTs and partner keys can't reach them.
app.route('/v1', adminRouter);

// Gate middleware — only apply auth/rate-limit/credits/usage to non-public v1.
const v1 = new Hono();
v1.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isPublicV1(path)) return next();
  return authMiddleware(c, next);
});
v1.use('*', async (c, next) => {
  if (isPublicV1(new URL(c.req.url).pathname)) return next();
  return rateLimitMiddleware(c, next);
});
v1.use('*', async (c, next) => {
  if (isPublicV1(new URL(c.req.url).pathname)) return next();
  return creditsMiddleware(c, next);
});
v1.use('*', async (c, next) => {
  if (isPublicV1(new URL(c.req.url).pathname)) return next();
  return usageCounterMiddleware(c, next);
});

v1.route('/scanner', scanRouter);
v1.route('/scanner', batchRouter);
v1.route('/scanner', testsRouter);
v1.route('/scanner', observatoryRouter);
v1.route('/scanner', prospectsRouter);
v1.route('/scanner', trafficMonitorRouter);
v1.route('/scanner', reportsRouter);
v1.route('/scanner', creditsRouter);
v1.route('/scanner', keysRouter);
v1.route('/scanner', mcpRouter);

app.route('/v1', v1);

// Global error handler
app.onError((err, c) => {
  console.error('[Scanner Error]', err.message);
  const status = 'statusCode' in err ? (err as any).statusCode : 500;
  return c.json(
    { error: err.message || 'Internal Server Error' },
    status,
  );
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not Found', message: `Route ${c.req.method} ${c.req.path} not found` }, 404);
});

export default app;
