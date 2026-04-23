import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { startUsageFlush, stopUsageFlush } from './services/usage.js';

const port = parseInt(process.env.SCANNER_PORT || process.env.PORT || '4100');
const host = process.env.SCANNER_HOST || '0.0.0.0';

console.log(`
╔══════════════════════════════════════════════════╗
║          Sly Scanner Service                     ║
╠══════════════════════════════════════════════════╣
║  Starting on http://${host}:${port}               ║
║  Health: http://${host}:${port}/health            ║
║  NODE_ENV: ${(process.env.NODE_ENV || 'development').padEnd(35)}║
╚══════════════════════════════════════════════════╝
`);

startUsageFlush();

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down...`);
  try {
    await stopUsageFlush();
  } catch (err) {
    console.error('[shutdown] usage flush stop failed:', err);
  }
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
  console.log(`Scanner is listening on ${host}:${port}`);
} catch (error) {
  console.error('Failed to start scanner:', error);
  process.exit(1);
}
