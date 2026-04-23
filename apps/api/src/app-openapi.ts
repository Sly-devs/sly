/**
 * OpenAPIHono app builder for spec generation.
 *
 * This module builds the same route structure as app.ts, but using the
 * @hono/zod-openapi variant so that every migrated route's schema is
 * registered for spec export.
 *
 * During the incremental migration, both worlds coexist: the live app.ts
 * continues to serve requests from the un-migrated plain-Hono routers, while
 * this file only imports OpenAPIHono-migrated routers. Each migrated router
 * exports from its own module; we add the import below as each protocol
 * migrates.
 *
 * To regenerate specs:  pnpm --filter @sly/api generate:openapi
 */

import { OpenAPIHono } from '@hono/zod-openapi';

// ---- migrated protocol routers ----
import x402OpenAPIRouter from './routes/openapi/x402.js';
import ucpOpenAPIRouter from './routes/openapi/ucp.js';
import acpOpenAPIRouter from './routes/openapi/acp.js';
import ap2OpenAPIRouter from './routes/openapi/ap2.js';
import a2aOpenAPIRouter from './routes/openapi/a2a.js';
import mcpOpenAPIRouter from './routes/openapi/mcp.js';

// ---- migrated core CRUD routers ----
import accountsOpenAPIRouter from './routes/openapi/accounts.js';
import transfersOpenAPIRouter from './routes/openapi/transfers.js';
import agentsOpenAPIRouter from './routes/openapi/agents.js';
import walletsOpenAPIRouter from './routes/openapi/wallets.js';

export function buildOpenAPIApp(): OpenAPIHono {
  const app = new OpenAPIHono();

  // Register shared security scheme
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description:
      'API key (pk_test_* or pk_live_*), JWT session, agent token (agent_*), Ed25519 session (sess_*), or portal token (portal_*).',
  });

  // Mount migrated routers under their real paths
  app.route('/v1/x402', x402OpenAPIRouter);
  app.route('/v1/ucp', ucpOpenAPIRouter);
  app.route('/v1/acp', acpOpenAPIRouter);
  app.route('/v1/ap2', ap2OpenAPIRouter);
  app.route('/v1/a2a', a2aOpenAPIRouter);
  app.route('/mcp', mcpOpenAPIRouter);

  // Core CRUD
  app.route('/v1/accounts', accountsOpenAPIRouter);
  app.route('/v1/transfers', transfersOpenAPIRouter);
  app.route('/v1/agents', agentsOpenAPIRouter);
  app.route('/v1/wallets', walletsOpenAPIRouter);

  return app;
}
