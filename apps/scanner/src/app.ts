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
