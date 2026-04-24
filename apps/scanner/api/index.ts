/**
 * Vercel Function entry for the Sly Scanner service.
 * Converts Hono's fetch handler to the Express-style (req, res) signature
 * that Vercel's Node launcher expects.
 *
 * We do NOT start a setInterval-based flush here — in serverless, interval
 * timers don't reliably fire between requests. The usage-counter middleware
 * flushes per-request via waitUntil() instead.
 */
import { getRequestListener } from '@hono/node-server';
import app from '../src/app.js';

export const config = { runtime: 'nodejs', maxDuration: 300 };

export default getRequestListener(app.fetch);
