import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { secureHeaders } from 'hono/secure-headers';

import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/error.js';
import { rateLimiter, authRateLimiter } from './middleware/rate-limit.js';
import { requestId, securityHeaders } from './middleware/security.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';
import { requestCounterMiddleware } from './middleware/request-counter.js';
import { 
  timingMiddleware, 
  responseWrapperMiddleware, 
  structuredErrorHandler 
} from './middleware/response-wrapper.js';
import { contextCacheMiddleware } from './middleware/context-cache.js';
import { createClient } from './db/client.js';

// Import routes
import authRouter from './routes/auth.js';
import organizationRouter from './routes/organization.js';
import organizationTeamRouter from './routes/organization-team.js';
import connectedAccountsRouter from './routes/organization/connected-accounts.js';
import organizationOnboardingRouter from './routes/organization/onboarding.js';
import apiKeysRouter from './routes/api-keys.js';
import accountsRouter from './routes/accounts.js';
import agentsRouter, { agentCardRouter } from './routes/agents.js';
import transfersRouter from './routes/transfers.js';
import internalTransfersRouter from './routes/internal-transfers.js';
import streamsRouter from './routes/streams.js';
import quotesRouter from './routes/quotes.js';
import reportsRouter from './routes/reports.js';
import eventsRouter from './routes/events.js';
import refundsRouter from './routes/refunds.js';
import scheduledTransfersRouter from './routes/scheduled-transfers.js';
import exportsRouter from './routes/exports.js';
import paymentMethodsRouter from './routes/payment-methods.js';
import disputesRouter from './routes/disputes.js';
import { compliance as complianceRouter } from './routes/compliance.js';
import relationshipsRouter from './routes/relationships.js';
import x402EndpointsRouter from './routes/x402-endpoints.js';
import walletsRouter from './routes/wallets.js';
import x402PaymentsRouter from './routes/x402-payments.js';
import x402AnalyticsRouter from './routes/x402-analytics.js';
import settlementRouter from './routes/settlement.js';
import agentsX402Router from './routes/agents-x402.js';
import cardTransactionsRouter from './routes/card-transactions.js';
import webhooksRouter from './routes/webhooks.js';
import agenticPaymentsRouter from './routes/agentic-payments.js';
import ap2Router from './routes/ap2.js';
import acpRouter from './routes/acp.js';
import batchTransfersRouter from './routes/batch-transfers.js';
import reconciliationRouter from './routes/reconciliation.js';
import settlementWindowsRouter from './routes/settlement-windows.js';
import treasuryRouter from './routes/treasury.js';
import contextRouter from './routes/context.js';
import x402FacilitatorRouter from './routes/x402-facilitator.js';
import capabilitiesRouter from './routes/capabilities.js';
import simulationsRouter from './routes/simulations.js';
import circleWebhooksRouter from './routes/circle-webhooks.js';
import stripeWebhooksRouter from './routes/stripe-webhooks.js';
import x402BridgeRouter from './routes/x402-bridge.js';
import wellKnownUcpRouter from './routes/well-known-ucp.js';
import wellKnownA2aRouter from './routes/well-known-a2a.js';
import { a2aPublicRouter, a2aRouter } from './routes/a2a.js';
import ucpSchemasRouter from './routes/ucp-schemas.js';
import ucpRouter from './routes/ucp.js';
import ucpCheckoutRouter from './routes/ucp-checkout.js';
import ucpOrdersRouter from './routes/ucp-orders.js';
import ucpWebhooksRouter from './routes/webhooks/ucp.js';
import ucpIdentityRouter from './routes/ucp-identity.js';
import ucpMerchantsRouter from './routes/ucp-merchants.js';
import approvalsRouter from './routes/approvals.js';
import protocolsRouter from './routes/protocols.js';
import organizationProtocolsRouter from './routes/organization/protocols.js';
import settlementRulesRouter from './routes/settlement-rules.js';
import onboardingRouter from './routes/onboarding.js';
import analyticsRouter from './routes/analytics.js';
import cardsRouter from './routes/cards/index.js';
import cardsVaultRouter from './routes/cards/vault.js';
import workflowsRouter from './routes/workflows.js';
import fundingRouter from './routes/funding.js';
import searchRouter from './routes/search.js';
import paymentHandlersListRouter from './routes/payment-handlers-list.js';
import portalTokensRouter from './routes/portal-tokens.js';
import usageRouter from './routes/usage.js';
import agentWalletsRouter from './routes/agent-wallets.js';
import betaAdminRouter from './routes/beta-admin.js';
import reputationRouter from './routes/reputation.js';
import mppRouter from './routes/mpp.js';
import compositionRouter from './routes/composition.js';
import mcpRouter from './routes/mcp.js';
import supportRouter from './routes/support.js';

const app = new Hono();

// ============================================
// GLOBAL MIDDLEWARE (applies to all routes)
// ============================================

// Request ID for tracing (must be first)
app.use('*', requestId);

// Timing tracking (must be early to track full request time)
app.use('*', timingMiddleware);

// Response wrapper (wraps all responses in structured format)
app.use('*', responseWrapperMiddleware);

// Context caching (caches context endpoint responses)
app.use('*', contextCacheMiddleware);

// Security headers
app.use('*', secureHeaders());
app.use('*', securityHeaders);

// Request logging (disable in production or use structured logging)
if (process.env.NODE_ENV !== 'production') {
  app.use('*', logger());
}

// Pretty JSON in development
if (process.env.NODE_ENV !== 'production') {
  app.use('*', prettyJSON());
}

// CORS configuration
app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGINS?.split(',') || [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:3001',
      'https://payos-web.vercel.app', // Production dashboard (legacy)
      'https://sly-ai.vercel.app',    // Production dashboard
      'https://app.getsly.ai',        // Production dashboard (primary)
    ],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-Request-ID', 'X-Environment'],
    exposeHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'X-Request-ID'],
    credentials: true,
    maxAge: 86400, // 24 hours
  })
);

// ============================================
// PUBLIC ROUTES (no auth required)
// ============================================

// Health check - verifies API is running and can connect to database
app.get('/health', async (c) => {
  console.log('📍 Health check requested');
  try {
    const supabase = createClient();
    
    // Quick DB connectivity check (just verify we can query)
    const { error } = await supabase
      .from('accounts')
      .select('id')
      .limit(1);
    
    // PGRST116 = no rows found (this is OK, just means empty table)
    if (error && error.code !== 'PGRST116') {
      console.error('❌ Health check - DB error:', error);
      return c.json({
        status: 'unhealthy',
        error: 'Database connection failed',
        timestamp: new Date().toISOString(),
        version: '0.1.0',
      }, 503);
    }
    
    console.log('✅ Health check passed - DB connected');

    // Optional Gas Station health check (non-blocking)
    let gasStation: any = undefined;
    try {
      const { checkGasStationHealth } = await import('./services/circle/index.js');
      gasStation = await checkGasStationHealth();
    } catch {
      // Gas Station check is optional — don't fail health on it
    }

    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
      checks: {
        api: 'running',
        database: 'connected',
        ...(gasStation ? { gasStation } : {}),
      },
    });
  } catch (error: any) {
    console.error('Health check failed:', error);
    return c.json({
      status: 'unhealthy',
      error: error.message || 'Unknown error',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    }, 503);
  }
});

// Ready check (for k8s readiness probes)
app.get('/ready', (c) =>
  c.json({
    status: 'ready',
    timestamp: new Date().toISOString(),
  })
);

// Organization routes (JWT-based auth inside route handlers)
app.route('/v1/organization', organizationRouter);
app.route('/v1/organization/team', organizationTeamRouter);
app.route('/v1/organization/connected-accounts', connectedAccountsRouter); // Epic 48
app.route('/v1/organization/onboarding-status', organizationOnboardingRouter); // Epic 51

// API keys routes (JWT-based auth inside route handlers)
app.route('/v1/api-keys', apiKeysRouter);

// Auth routes (public - no auth middleware)
app.route('/v1/auth', authRouter);

// Circle webhook receiver (public - verifies Circle signatures internally)
// Story 40.5: Circle Webhook Handler Implementation
app.route('/webhooks/circle', circleWebhooksRouter);

// Stripe webhook receiver (public - verifies Stripe signatures internally)
// Story 40.12: Stripe Test Mode Setup
app.route('/webhooks/stripe', stripeWebhooksRouter);

// UCP Well-Known endpoint (public - for protocol discovery)
// Story 43.1: UCP Profile Endpoint
app.route('/.well-known/ucp', wellKnownUcpRouter);

// A2A Well-Known endpoint (public - for Google A2A protocol discovery)
// Epic 57: Google A2A Protocol Integration
app.route('/.well-known/agent.json', wellKnownA2aRouter);

// A2A public routes (agent card discovery + JSON-RPC endpoint)
// Epic 57: Google A2A Protocol Integration
app.route('/a2a', a2aPublicRouter);

// Remote MCP endpoint (Streamable HTTP transport, bearer token auth inside route)
// Enables external MCP clients (e.g., Intercom Fin) to connect
app.route('/mcp', mcpRouter);

// UCP Schemas (public - for capability discovery)
// Story 43.2: UCP Capability Definitions
app.route('/ucp', ucpSchemasRouter);

// UCP Webhooks (public - verifies signatures internally)
// Story 43.11: UCP Webhook Handler
app.route('/webhooks/ucp', ucpWebhooksRouter);

// Agent card (public - ERC-8004 on-chain identity metadata)
// Epic 63: On-chain agent registration — mounted outside /v1 to bypass auth
app.route('/agents', agentCardRouter);

// Protocol Discovery API (public - for discovering available protocols)
// Epic 49: Protocol Discovery & Management
app.route('/v1/protocols', protocolsRouter);

// OpenAPI spec + Skills.md (public - for agent discovery and API documentation)
import { openapiRouter } from './routes/openapi.js';
app.route('/v1', openapiRouter);

// Swagger UI redirect
app.get('/docs', (c) => {
  const specUrl = encodeURIComponent(`${process.env.API_BASE_URL || 'https://api.getsly.ai'}/v1/openapi.json`);
  return c.redirect(`https://petstore.swagger.io/?url=${specUrl}`);
});

// Beta admin routes (platform admin auth, NOT tenant auth)
app.route('/admin/beta', betaAdminRouter);

// NOTE: UCP Identity routes moved to v1 router for auth middleware

// ============================================
// API v1 ROUTES (auth required)
// ============================================

const v1 = new Hono();

// Rate limiting for all API routes
v1.use('*', rateLimiter());

// Stricter rate limit for auth (applied before auth middleware)
v1.use('*', authRateLimiter);

// Authentication
v1.use('*', authMiddleware);

// Request counter (after auth to have tenant context) — Epic 65
v1.use('*', requestCounterMiddleware);

// Idempotency (after auth to have tenant context)
v1.use('*', idempotencyMiddleware);

// Mount route handlers
v1.route('/context', contextRouter);
v1.route('/accounts', accountsRouter);
v1.route('/agents', agentsRouter);
// NOTE: Batch transfers must be mounted BEFORE /transfers to avoid route conflicts
v1.route('/transfers/batch', batchTransfersRouter);
v1.route('/transfers', transfersRouter);
v1.route('/internal-transfers', internalTransfersRouter);
v1.route('/streams', streamsRouter);
v1.route('/quotes', quotesRouter);
v1.route('/reports', reportsRouter);
v1.route('/events', eventsRouter);
v1.route('/refunds', refundsRouter);
v1.route('/scheduled-transfers', scheduledTransfersRouter);
v1.route('/exports', exportsRouter);
v1.route('/disputes', disputesRouter);
v1.route('/payment-methods', paymentMethodsRouter);
v1.route('/card-transactions', cardTransactionsRouter);
v1.route('/compliance', complianceRouter);
v1.route('/x402/endpoints', x402EndpointsRouter);
v1.route('/x402/analytics', x402AnalyticsRouter);
v1.route('/x402', x402PaymentsRouter);
v1.route('/settlement', settlementRouter);
v1.route('/wallets', walletsRouter);
v1.route('/agents/x402', agentsX402Router);
v1.route('/webhooks', webhooksRouter);
v1.route('/agentic-payments', agenticPaymentsRouter);
v1.route('/ap2', ap2Router);
v1.route('/a2a', a2aRouter); // Google A2A protocol management (Epic 57)
v1.route('/acp', acpRouter);
v1.route('/reconciliation', reconciliationRouter);
v1.route('/settlement-windows', settlementWindowsRouter);
v1.route('/treasury', treasuryRouter);
v1.route('/x402/facilitator', x402FacilitatorRouter); // Sandbox facilitator (Story 36.8)
v1.route('/x402/bridge', x402BridgeRouter); // x402 → Circle bridge (Story 40.10)
v1.route('/capabilities', capabilitiesRouter); // Tool discovery (Story 36.9)
v1.route('/simulate', simulationsRouter); // Simulation engine (Epic 28)
v1.route('/ucp', ucpRouter); // UCP settlement endpoints (Epic 43)
v1.route('/ucp/checkouts', ucpCheckoutRouter); // UCP checkout capability (Phase 2)
v1.route('/ucp/orders', ucpOrdersRouter); // UCP order capability (Phase 3)
v1.route('/ucp/identity', ucpIdentityRouter); // UCP identity linking (Phase 4)
v1.route('/ucp/merchants', ucpMerchantsRouter); // UCP merchant catalog (Invu demo)
v1.route('/approvals', approvalsRouter); // Agent payment approvals (Story 18.R2)
v1.route('/accounts', relationshipsRouter); // For /accounts/:accountId/relationships routes
v1.route('/organization', organizationProtocolsRouter); // Protocol enablement (Epic 49)
v1.route('/settlement-rules', settlementRulesRouter); // Settlement rules (Epic 50)
v1.route('/onboarding', onboardingRouter); // Onboarding (Epic 51)
v1.route('/analytics', analyticsRouter); // Dashboard analytics (Epic 52)
v1.route('/cards', cardsRouter); // Card networks (Epic 53)
v1.route('/cards/vault', cardsVaultRouter); // Card vaulting (Epic 54)
v1.route('/workflows', workflowsRouter); // Workflow engine (Epic 29)
v1.route('/funding', fundingRouter); // On-ramp integrations (Epic 41)
v1.route('/search', searchRouter); // Unified global search
v1.route('/payment-handlers', paymentHandlersListRouter); // DB-driven handler registry
v1.route('/portal-tokens', portalTokensRouter); // Portal token CRUD (Epic 65)
v1.route('/usage', usageRouter); // Usage API (Epic 65)
v1.route('/agents', agentWalletsRouter); // Agent wallet policy & exposure (Epic 18)
v1.route('/reputation', reputationRouter); // Reputation bridge (Epic 63)
v1.route('/mpp', mppRouter); // Machine Payments Protocol (Epic 71)
v1.route('/composition', compositionRouter); // Multi-protocol composition (Epic 71)
v1.route('/support', supportRouter); // Support tools for Intercom Fin
// NOTE: Removed catch-all payment-methods mount to prevent route conflicts
// Payment methods are already accessible at /v1/payment-methods
// Account-specific payment methods handled via accounts router

app.route('/v1', v1);

// ============================================
// ERROR HANDLING
// ============================================

// Global error handler (Epic 30 structured errors)
app.onError(structuredErrorHandler);

// 404 handler
app.notFound((c) => {
  const requestId = c.get('requestId') || crypto.randomUUID();
  return c.json({
    success: false,
    error: {
      code: 'ENDPOINT_NOT_FOUND',
      category: 'resource',
      message: 'Endpoint not found',
      documentation_url: 'https://docs.payos.com/errors/ENDPOINT_NOT_FOUND',
    },
    request_id: requestId,
    timestamp: new Date().toISOString(),
  }, 404);
});

export default app;
