/**
 * Vercel Function entry for the Sly Scanner service.
 * Converts Hono's fetch handler to the Express-style (req, res) signature
 * that Vercel's Node launcher expects.
 */
import { getRequestListener } from '@hono/node-server';
import app from '../src/app.js';
import { startUsageFlush } from '../src/services/usage.js';

// Fluid Compute reuses instances across concurrent requests.
startUsageFlush();

export const config = { runtime: 'nodejs', maxDuration: 300 };

export default getRequestListener(app.fetch);
