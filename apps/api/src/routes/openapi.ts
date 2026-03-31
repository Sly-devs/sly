/**
 * OpenAPI Spec + Skills.md endpoints
 *
 * Public endpoints for API documentation and agent discovery.
 * Full MCP tool parity — every MCP tool maps to a REST API path.
 */

import { Hono } from 'hono';

const router = new Hono();

// ============================================
// GET /v1/openapi.json — OpenAPI 3.0 Specification
// ============================================
router.get('/openapi.json', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Cache-Control', 'public, max-age=3600');

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Sly API',
      description: 'The Agentic Economy Platform — stablecoin payments, agent wallets, multi-protocol commerce, and AI agent orchestration.',
      version: '1.0.0',
      contact: { name: 'Sly', url: 'https://getsly.ai', email: 'support@getsly.ai' },
    },
    servers: [
      { url: `${baseUrl}/v1`, description: 'Production' },
      { url: 'https://sandbox.getsly.ai/v1', description: 'Sandbox' },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key (pk_test_* or pk_live_*), JWT session token, or agent token (agent_*)',
        },
      },
    },
    paths: {
      // =====================================================================
      // Accounts
      // =====================================================================
      '/accounts': {
        get: {
          summary: 'List accounts',
          operationId: 'listAccounts',
          tags: ['Accounts'],
          parameters: [
            { name: 'type', in: 'query', schema: { type: 'string', enum: ['person', 'business'] } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'suspended'] } },
          ],
          responses: { '200': { description: 'List of accounts' } },
        },
        post: {
          summary: 'Create account',
          operationId: 'createAccount',
          tags: ['Accounts'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['type', 'name'], properties: { type: { type: 'string', enum: ['person', 'business'] }, name: { type: 'string' }, email: { type: 'string' }, metadata: { type: 'object' } } } } } },
          responses: { '201': { description: 'Account created' } },
        },
      },
      '/accounts/{id}': {
        get: {
          summary: 'Get account',
          operationId: 'getAccount',
          tags: ['Accounts'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Account details' } },
        },
        patch: {
          summary: 'Update account',
          operationId: 'updateAccount',
          tags: ['Accounts'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, metadata: { type: 'object' } } } } } },
          responses: { '200': { description: 'Account updated' } },
        },
      },

      // =====================================================================
      // Agents
      // =====================================================================
      '/agents': {
        get: {
          summary: 'List agents',
          operationId: 'listAgents',
          tags: ['Agents'],
          responses: { '200': { description: 'List of agents' } },
        },
        post: {
          summary: 'Create agent',
          operationId: 'createAgent',
          tags: ['Agents'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'name'], properties: { accountId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, description: { type: 'string' } } } } } },
          responses: { '201': { description: 'Agent created with token (shown once)' } },
        },
      },
      '/agents/{id}': {
        get: {
          summary: 'Get agent',
          operationId: 'getAgent',
          tags: ['Agents'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Agent details including KYA tier and status' } },
        },
        delete: {
          summary: 'Delete agent',
          operationId: 'deleteAgent',
          tags: ['Agents'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Agent deleted' } },
        },
      },
      '/agents/{id}/verify': {
        post: {
          summary: 'Verify agent KYA tier',
          operationId: 'verifyAgent',
          tags: ['Agents'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tier'], properties: { tier: { type: 'number', enum: [1, 2, 3] } } } } } },
          responses: { '200': { description: 'Agent verified at requested KYA tier' } },
        },
      },
      '/agents/{id}/limits': {
        get: {
          summary: 'Get agent spending limits',
          operationId: 'getAgentLimits',
          tags: ['Agents'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Agent limits and current usage' } },
        },
      },
      '/agents/{id}/transactions': {
        get: {
          summary: 'Get agent transaction history',
          operationId: 'getAgentTransactions',
          tags: ['Agents'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            { name: 'offset', in: 'query', schema: { type: 'number' } },
            { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
            { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          ],
          responses: { '200': { description: 'Agent transaction history' } },
        },
      },

      // =====================================================================
      // Wallets
      // =====================================================================
      '/wallets': {
        get: {
          summary: 'List wallets',
          operationId: 'listWallets',
          tags: ['Wallets'],
          parameters: [
            { name: 'owner_account_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'managed_by_agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'frozen', 'depleted'] } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of wallets' } },
        },
        post: {
          summary: 'Create wallet',
          operationId: 'createWallet',
          tags: ['Wallets'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, currency: { type: 'string', enum: ['USDC', 'EURC'] }, walletType: { type: 'string', enum: ['internal', 'circle_custodial', 'circle_mpc'] }, blockchain: { type: 'string', enum: ['base', 'eth', 'polygon', 'avax', 'sol'] }, initialBalance: { type: 'number' }, managedByAgentId: { type: 'string', format: 'uuid' }, purpose: { type: 'string' } } } } } },
          responses: { '201': { description: 'Wallet created' } },
        },
      },
      '/wallets/{id}': {
        get: {
          summary: 'Get wallet',
          operationId: 'getWallet',
          tags: ['Wallets'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Wallet details' } },
        },
      },
      '/wallets/{id}/balance': {
        get: {
          summary: 'Get wallet balance',
          operationId: 'getWalletBalance',
          tags: ['Wallets'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Wallet balance with sync status' } },
        },
      },
      '/wallets/{id}/deposit': {
        post: {
          summary: 'Deposit funds into wallet',
          operationId: 'walletDeposit',
          tags: ['Wallets'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount', 'fromAccountId'], properties: { amount: { type: 'number' }, fromAccountId: { type: 'string', format: 'uuid' }, reference: { type: 'string' } } } } } },
          responses: { '200': { description: 'Deposit completed' } },
        },
      },
      '/wallets/{id}/withdraw': {
        post: {
          summary: 'Withdraw funds from wallet',
          operationId: 'walletWithdraw',
          tags: ['Wallets'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount', 'destinationAccountId'], properties: { amount: { type: 'number' }, destinationAccountId: { type: 'string', format: 'uuid' }, reference: { type: 'string' } } } } } },
          responses: { '200': { description: 'Withdrawal completed' } },
        },
      },
      '/wallets/{id}/test-fund': {
        post: {
          summary: 'Add test funds to wallet (sandbox only)',
          operationId: 'walletTestFund',
          tags: ['Wallets'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', maximum: 100000 }, currency: { type: 'string', enum: ['USDC', 'EURC'] }, reference: { type: 'string' } } } } } },
          responses: { '200': { description: 'Test funds added' } },
        },
      },

      // =====================================================================
      // Transfers
      // =====================================================================
      '/transfers': {
        get: {
          summary: 'List transfers',
          operationId: 'listTransfers',
          tags: ['Transfers'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'] } },
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of transfers' } },
        },
        post: {
          summary: 'Create transfer',
          operationId: 'createTransfer',
          tags: ['Transfers'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sourceWalletId', 'destinationWalletId', 'amount'], properties: { sourceWalletId: { type: 'string', format: 'uuid' }, destinationWalletId: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, currency: { type: 'string', default: 'USDC' }, metadata: { type: 'object' } } } } } },
          responses: { '201': { description: 'Transfer created' } },
        },
      },
      '/transfers/{id}': {
        get: {
          summary: 'Get transfer',
          operationId: 'getTransfer',
          tags: ['Transfers'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Transfer details' } },
        },
      },

      // =====================================================================
      // Settlements
      // =====================================================================
      '/settlements/quote': {
        post: {
          summary: 'Get settlement quote with FX rates',
          operationId: 'getSettlementQuote',
          tags: ['Settlements'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['fromCurrency', 'toCurrency', 'amount'], properties: { fromCurrency: { type: 'string', enum: ['USD', 'BRL', 'MXN', 'USDC'] }, toCurrency: { type: 'string', enum: ['USD', 'BRL', 'MXN', 'USDC'] }, amount: { type: 'string' }, rail: { type: 'string', enum: ['pix', 'spei', 'wire', 'usdc'] } } } } } },
          responses: { '200': { description: 'Settlement quote with FX rate and fees' } },
        },
      },
      '/settlements': {
        post: {
          summary: 'Execute settlement using a quote',
          operationId: 'createSettlement',
          tags: ['Settlements'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['quoteId', 'destinationAccountId'], properties: { quoteId: { type: 'string' }, destinationAccountId: { type: 'string', format: 'uuid' }, metadata: { type: 'object' } } } } } },
          responses: { '201': { description: 'Settlement created' } },
        },
      },
      '/settlements/{id}': {
        get: {
          summary: 'Get settlement status',
          operationId: 'getSettlementStatus',
          tags: ['Settlements'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Settlement status and details' } },
        },
      },

      // =====================================================================
      // x402 Micropayments
      // =====================================================================
      '/x402/endpoints': {
        get: {
          summary: 'List x402 endpoints',
          operationId: 'listX402Endpoints',
          tags: ['x402'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'paused', 'disabled'] } },
            { name: 'account_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of x402 payment endpoints' } },
        },
        post: {
          summary: 'Create x402 endpoint',
          operationId: 'createX402Endpoint',
          tags: ['x402'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'path', 'method', 'accountId', 'basePrice'], properties: { name: { type: 'string' }, path: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ANY'] }, description: { type: 'string' }, accountId: { type: 'string', format: 'uuid' }, basePrice: { type: 'number' }, currency: { type: 'string', enum: ['USDC', 'EURC'] }, volumeDiscounts: { type: 'array', items: { type: 'object', properties: { threshold: { type: 'integer' }, priceMultiplier: { type: 'number' } }, required: ['threshold', 'priceMultiplier'] } }, webhookUrl: { type: 'string' }, network: { type: 'string' } } } } } },
          responses: { '201': { description: 'Endpoint created' } },
        },
      },
      '/x402/endpoints/{id}': {
        get: {
          summary: 'Get x402 endpoint details',
          operationId: 'getX402Endpoint',
          tags: ['x402'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Endpoint details with pricing and stats' } },
        },
      },
      '/x402/pay': {
        post: {
          summary: 'Pay an x402 endpoint',
          operationId: 'x402Pay',
          tags: ['x402'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['endpointId', 'walletId', 'amount', 'currency', 'method', 'path'], properties: { endpointId: { type: 'string', format: 'uuid' }, walletId: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, currency: { type: 'string', enum: ['USDC', 'EURC'] }, method: { type: 'string' }, path: { type: 'string' } } } } } },
          responses: { '200': { description: 'Payment receipt with JWT proof' } },
        },
      },
      '/x402/verify': {
        post: {
          summary: 'Verify x402 payment',
          operationId: 'x402Verify',
          tags: ['x402'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { jwt: { type: 'string' }, requestId: { type: 'string' }, transferId: { type: 'string' } } } } } },
          responses: { '200': { description: 'Verification result' } },
        },
      },

      // =====================================================================
      // AP2 (Agent Payment Protocol v2)
      // =====================================================================
      '/ap2/mandates': {
        get: {
          summary: 'List AP2 mandates',
          operationId: 'listAP2Mandates',
          tags: ['AP2'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'completed', 'cancelled', 'expired'] } },
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'account_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of mandates' } },
        },
        post: {
          summary: 'Create AP2 mandate',
          operationId: 'createAP2Mandate',
          tags: ['AP2'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['mandate_id', 'agent_id', 'account_id', 'authorized_amount'], properties: { mandate_id: { type: 'string' }, agent_id: { type: 'string', format: 'uuid' }, account_id: { type: 'string', format: 'uuid' }, authorized_amount: { type: 'number' }, currency: { type: 'string' }, mandate_type: { type: 'string', enum: ['intent', 'cart', 'payment'] }, description: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' }, metadata: { type: 'object' }, mandate_data: { type: 'object' } } } } } },
          responses: { '201': { description: 'Mandate created' } },
        },
      },
      '/ap2/mandates/{id}': {
        get: {
          summary: 'Get AP2 mandate',
          operationId: 'getAP2Mandate',
          tags: ['AP2'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Mandate details with execution history' } },
        },
        patch: {
          summary: 'Update AP2 mandate',
          operationId: 'updateAP2Mandate',
          tags: ['AP2'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { authorized_amount: { type: 'number' }, status: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' }, metadata: { type: 'object' }, mandate_data: { type: 'object' }, description: { type: 'string' } } } } } },
          responses: { '200': { description: 'Mandate updated' } },
        },
      },
      '/ap2/mandates/{id}/execute': {
        post: {
          summary: 'Execute AP2 mandate payment',
          operationId: 'executeAP2Mandate',
          tags: ['AP2'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' }, order_ids: { type: 'array', items: { type: 'string' } } } } } } },
          responses: { '200': { description: 'Mandate executed, funds deducted' } },
        },
      },
      '/ap2/mandates/{id}/cancel': {
        post: {
          summary: 'Cancel AP2 mandate',
          operationId: 'cancelAP2Mandate',
          tags: ['AP2'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Mandate cancelled' } },
        },
      },

      // =====================================================================
      // ACP (Agentic Commerce Protocol)
      // =====================================================================
      '/acp/checkouts': {
        get: {
          summary: 'List ACP checkouts',
          operationId: 'listACPCheckouts',
          tags: ['ACP'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'completed', 'cancelled', 'expired'] } },
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'merchant_id', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of ACP checkouts' } },
        },
        post: {
          summary: 'Create ACP checkout',
          operationId: 'createACPCheckout',
          tags: ['ACP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['checkout_id', 'agent_id', 'merchant_id', 'items'], properties: { checkout_id: { type: 'string' }, agent_id: { type: 'string', format: 'uuid' }, account_id: { type: 'string', format: 'uuid' }, merchant_id: { type: 'string' }, items: { type: 'array', items: { type: 'object', required: ['name', 'quantity', 'unit_price', 'total_price'], properties: { name: { type: 'string' }, description: { type: 'string' }, quantity: { type: 'number' }, unit_price: { type: 'number' }, total_price: { type: 'number' } } } }, tax_amount: { type: 'number' }, shipping_amount: { type: 'number' }, payment_method: { type: 'string' }, checkout_data: { type: 'object' } } } } } },
          responses: { '201': { description: 'ACP checkout created' } },
        },
      },
      '/acp/checkouts/batch': {
        post: {
          summary: 'Batch create ACP checkouts',
          operationId: 'batchCreateACPCheckouts',
          tags: ['ACP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['checkouts'], properties: { checkouts: { type: 'array', items: { type: 'object', required: ['checkout_id', 'agent_id', 'account_id', 'merchant_id', 'items'], properties: { checkout_id: { type: 'string' }, agent_id: { type: 'string' }, account_id: { type: 'string' }, merchant_id: { type: 'string' }, items: { type: 'array', items: { type: 'object' } }, tax_amount: { type: 'number' }, shipping_amount: { type: 'number' }, currency: { type: 'string' }, metadata: { type: 'object' } } } } } } } } },
          responses: { '200': { description: 'Batch results' } },
        },
      },
      '/acp/checkouts/{id}': {
        get: {
          summary: 'Get ACP checkout',
          operationId: 'getACPCheckout',
          tags: ['ACP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'ACP checkout details' } },
        },
      },
      '/acp/checkouts/{id}/complete': {
        post: {
          summary: 'Complete ACP checkout',
          operationId: 'completeACPCheckout',
          tags: ['ACP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { shared_payment_token: { type: 'string' }, payment_method: { type: 'string' } } } } } },
          responses: { '200': { description: 'Checkout completed and paid' } },
        },
      },

      // =====================================================================
      // UCP (Universal Commerce Protocol)
      // =====================================================================
      '/ucp/discover': {
        post: {
          summary: 'Discover UCP merchant capabilities',
          operationId: 'ucpDiscover',
          tags: ['UCP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['merchantUrl'], properties: { merchantUrl: { type: 'string' } } } } } },
          responses: { '200': { description: 'Merchant UCP profile and capabilities' } },
        },
      },
      '/ucp/checkouts': {
        get: {
          summary: 'List UCP checkouts',
          operationId: 'listUCPCheckouts',
          tags: ['UCP'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled'] } },
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of UCP checkout sessions' } },
        },
        post: {
          summary: 'Create UCP checkout session',
          operationId: 'createUCPCheckout',
          tags: ['UCP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['currency', 'line_items'], properties: { currency: { type: 'string' }, line_items: { type: 'array', items: { type: 'object', required: ['id', 'name', 'quantity', 'unit_price', 'total_price'], properties: { id: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' }, unit_price: { type: 'integer' }, total_price: { type: 'integer' }, description: { type: 'string' }, image_url: { type: 'string' }, product_url: { type: 'string' } } } }, buyer: { type: 'object', properties: { email: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' } } }, shipping_address: { type: 'object', properties: { line1: { type: 'string' }, line2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, postal_code: { type: 'string' }, country: { type: 'string' } } }, payment_config: { type: 'object' }, payment_instruments: { type: 'array', items: { type: 'object', required: ['id', 'handler', 'type'], properties: { id: { type: 'string' }, handler: { type: 'string' }, type: { type: 'string' }, last4: { type: 'string' }, brand: { type: 'string' } } } }, checkout_type: { type: 'string', enum: ['physical', 'digital', 'service'] }, metadata: { type: 'object' }, agent_id: { type: 'string', format: 'uuid' } } } } } },
          responses: { '201': { description: 'UCP checkout session created' } },
        },
      },
      '/ucp/checkouts/batch': {
        post: {
          summary: 'Batch create and complete UCP checkouts',
          operationId: 'batchUCPCheckout',
          tags: ['UCP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['checkouts'], properties: { checkouts: { type: 'array', items: { type: 'object', required: ['currency', 'line_items'], properties: { currency: { type: 'string' }, line_items: { type: 'array', items: { type: 'object' } }, buyer: { type: 'object' }, shipping_address: { type: 'object' }, payment_instruments: { type: 'array', items: { type: 'object' } }, checkout_type: { type: 'string', enum: ['physical', 'digital', 'service'] }, metadata: { type: 'object' }, agent_id: { type: 'string' } } } } } } } } },
          responses: { '200': { description: 'Batch results array' } },
        },
      },
      '/ucp/checkouts/batch-complete': {
        post: {
          summary: 'Batch complete pending UCP checkouts',
          operationId: 'batchCompleteUCPCheckouts',
          tags: ['UCP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['checkout_ids', 'default_payment_instrument'], properties: { checkout_ids: { type: 'array', items: { type: 'string' } }, default_payment_instrument: { type: 'object', required: ['id', 'handler', 'type'], properties: { id: { type: 'string' }, handler: { type: 'string' }, type: { type: 'string' } } } } } } } },
          responses: { '200': { description: 'Batch completion results' } },
        },
      },
      '/ucp/checkouts/{id}': {
        get: {
          summary: 'Get UCP checkout session',
          operationId: 'getUCPCheckout',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'UCP checkout details' } },
        },
        patch: {
          summary: 'Update UCP checkout session',
          operationId: 'updateUCPCheckout',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { line_items: { type: 'array', items: { type: 'object' } }, buyer: { type: 'object' }, shipping_address: { type: 'object' }, billing_address: { type: 'object' }, metadata: { type: 'object' } } } } } },
          responses: { '200': { description: 'Checkout updated' } },
        },
      },
      '/ucp/checkouts/{id}/complete': {
        post: {
          summary: 'Complete UCP checkout',
          operationId: 'completeUCPCheckout',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Checkout completed, order created' } },
        },
      },
      '/ucp/checkouts/{id}/cancel': {
        post: {
          summary: 'Cancel UCP checkout',
          operationId: 'cancelUCPCheckout',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Checkout cancelled' } },
        },
      },
      '/ucp/checkouts/{id}/payment-instruments': {
        post: {
          summary: 'Add payment instrument to UCP checkout',
          operationId: 'ucpAddPaymentInstrument',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['id', 'handler', 'type'], properties: { id: { type: 'string' }, handler: { type: 'string' }, type: { type: 'string' }, last4: { type: 'string' }, brand: { type: 'string' }, metadata: { type: 'object' } } } } } },
          responses: { '200': { description: 'Payment instrument added' } },
        },
      },
      '/ucp/orders': {
        get: {
          summary: 'List UCP orders',
          operationId: 'listUCPOrders',
          tags: ['UCP'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'] } },
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of UCP orders' } },
        },
      },
      '/ucp/orders/{id}': {
        get: {
          summary: 'Get UCP order',
          operationId: 'getUCPOrder',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Order details with line items and fulfillment events' } },
        },
        patch: {
          summary: 'Update UCP order status',
          operationId: 'updateUCPOrderStatus',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['processing', 'shipped', 'delivered'] } } } } } },
          responses: { '200': { description: 'Order status updated' } },
        },
      },
      '/ucp/orders/{id}/cancel': {
        post: {
          summary: 'Cancel UCP order',
          operationId: 'cancelUCPOrder',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
          responses: { '200': { description: 'Order cancelled' } },
        },
      },
      '/ucp/orders/{id}/fulfillment-events': {
        post: {
          summary: 'Add fulfillment event to UCP order',
          operationId: 'ucpAddFulfillmentEvent',
          tags: ['UCP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['type', 'description'], properties: { type: { type: 'string', enum: ['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'returned'] }, description: { type: 'string' }, tracking_number: { type: 'string' }, carrier: { type: 'string' } } } } } },
          responses: { '200': { description: 'Fulfillment event recorded' } },
        },
      },

      // =====================================================================
      // MPP (Machine Payments Protocol)
      // =====================================================================
      '/mpp/pay': {
        post: {
          summary: 'One-shot MPP payment',
          operationId: 'mppPay',
          tags: ['MPP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['service_url', 'amount', 'agent_id'], properties: { service_url: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, intent: { type: 'string' }, agent_id: { type: 'string', format: 'uuid' }, wallet_id: { type: 'string', format: 'uuid' } } } } } },
          responses: { '200': { description: 'Payment completed with receipt' } },
        },
      },
      '/mpp/sessions': {
        get: {
          summary: 'List MPP sessions',
          operationId: 'listMPPSessions',
          tags: ['MPP'],
          parameters: [
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'closed', 'expired', 'exhausted'] } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            { name: 'offset', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of MPP sessions' } },
        },
        post: {
          summary: 'Open MPP streaming session',
          operationId: 'openMPPSession',
          tags: ['MPP'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['service_url', 'deposit_amount', 'agent_id', 'wallet_id'], properties: { service_url: { type: 'string' }, deposit_amount: { type: 'number' }, max_budget: { type: 'number' }, agent_id: { type: 'string', format: 'uuid' }, wallet_id: { type: 'string', format: 'uuid' }, currency: { type: 'string' } } } } } },
          responses: { '201': { description: 'Session opened with deposit' } },
        },
      },
      '/mpp/sessions/{id}': {
        get: {
          summary: 'Get MPP session details',
          operationId: 'getMPPSession',
          tags: ['MPP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Session details with voucher history' } },
        },
      },
      '/mpp/sessions/{id}/close': {
        post: {
          summary: 'Close MPP session',
          operationId: 'closeMPPSession',
          tags: ['MPP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Session closed, remaining funds returned' } },
        },
      },
      '/mpp/transfers': {
        get: {
          summary: 'List MPP transfers',
          operationId: 'listMPPTransfers',
          tags: ['MPP'],
          parameters: [
            { name: 'service_url', in: 'query', schema: { type: 'string' } },
            { name: 'session_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            { name: 'offset', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of MPP payment transfers' } },
        },
      },
      '/mpp/receipts/{id}/verify': {
        post: {
          summary: 'Verify MPP payment receipt',
          operationId: 'mppVerifyReceipt',
          tags: ['MPP'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Receipt verification result' } },
        },
      },

      // =====================================================================
      // A2A (Agent-to-Agent Protocol)
      // =====================================================================
      '/a2a/discover': {
        post: {
          summary: 'Discover remote A2A agent',
          operationId: 'a2aDiscoverAgent',
          tags: ['A2A'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } } } },
          responses: { '200': { description: 'Agent Card with capabilities and skills' } },
        },
      },
      '/a2a/tasks': {
        get: {
          summary: 'List A2A tasks',
          operationId: 'listA2ATasks',
          tags: ['A2A'],
          parameters: [
            { name: 'agent_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
            { name: 'state', in: 'query', schema: { type: 'string', enum: ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'rejected'] } },
            { name: 'direction', in: 'query', schema: { type: 'string', enum: ['inbound', 'outbound'] } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of A2A tasks' } },
        },
        post: {
          summary: 'Send A2A task',
          operationId: 'a2aSendTask',
          tags: ['A2A'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['message'], properties: { agent_id: { type: 'string', format: 'uuid' }, remote_url: { type: 'string' }, message: { type: 'string' }, context_id: { type: 'string' } } } } } },
          responses: { '200': { description: 'Task sent, returns task state' } },
        },
      },
      '/a2a/tasks/{id}': {
        get: {
          summary: 'Get A2A task',
          operationId: 'getA2ATask',
          tags: ['A2A'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Task status, messages, artifacts' } },
        },
      },

      // =====================================================================
      // Agent Wallets (Policy & Governance)
      // =====================================================================
      '/agent-wallets/{agentId}': {
        get: {
          summary: 'Get agent wallet',
          operationId: 'getAgentWallet',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Agent wallet details with balance and policy' } },
        },
      },
      '/agent-wallets/{agentId}/policy': {
        put: {
          summary: 'Set agent wallet policy',
          operationId: 'setAgentWalletPolicy',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { dailySpendLimit: { type: 'number' }, monthlySpendLimit: { type: 'number' }, requiresApprovalAbove: { type: 'number' }, approvedVendors: { type: 'array', items: { type: 'string' } }, contractPolicy: { type: 'object', properties: { counterpartyBlocklist: { type: 'array', items: { type: 'string' } }, counterpartyAllowlist: { type: 'array', items: { type: 'string' } }, minCounterpartyKyaTier: { type: 'number' }, allowedContractTypes: { type: 'array', items: { type: 'string' } }, blockedContractTypes: { type: 'array', items: { type: 'string' } }, maxExposure24h: { type: 'number' }, maxExposure7d: { type: 'number' }, maxExposure30d: { type: 'number' }, maxActiveContracts: { type: 'number' }, maxActiveEscrows: { type: 'number' }, escalateAbove: { type: 'number' } } } } } } } },
          responses: { '200': { description: 'Policy updated' } },
        },
      },
      '/agent-wallets/{agentId}/evaluate': {
        post: {
          summary: 'Evaluate agent wallet policy (dry-run)',
          operationId: 'evaluateAgentWalletPolicy',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' }, currency: { type: 'string' }, action_type: { type: 'string', enum: ['payment', 'escrow_create', 'escrow_release', 'contract_sign', 'negotiation_check', 'counterparty_check'] }, contract_type: { type: 'string' }, counterparty_agent_id: { type: 'string', format: 'uuid' }, counterparty_address: { type: 'string' } } } } } },
          responses: { '200': { description: 'Policy evaluation result (approve/escalate/deny)' } },
        },
      },
      '/agent-wallets/{agentId}/evaluations': {
        get: {
          summary: 'Get agent wallet evaluation audit log',
          operationId: 'getAgentWalletEvaluations',
          tags: ['Agent Wallets'],
          parameters: [
            { name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
            { name: 'page', in: 'query', schema: { type: 'number' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'Policy evaluation history' } },
        },
      },
      '/agent-wallets/{agentId}/exposures': {
        get: {
          summary: 'Get agent wallet counterparty exposures',
          operationId: 'getAgentWalletExposures',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Per-counterparty exposure windows (24h/7d/30d)' } },
        },
      },
      '/agent-wallets/{agentId}/freeze': {
        post: {
          summary: 'Freeze agent wallet',
          operationId: 'freezeAgentWallet',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Wallet frozen' } },
        },
      },
      '/agent-wallets/{agentId}/unfreeze': {
        post: {
          summary: 'Unfreeze agent wallet',
          operationId: 'unfreezeAgentWallet',
          tags: ['Agent Wallets'],
          parameters: [{ name: 'agentId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'Wallet unfrozen' } },
        },
      },

      // =====================================================================
      // Merchants
      // =====================================================================
      '/merchants': {
        get: {
          summary: 'List merchants',
          operationId: 'listMerchants',
          tags: ['Merchants'],
          parameters: [
            { name: 'type', in: 'query', schema: { type: 'string' } },
            { name: 'country', in: 'query', schema: { type: 'string' } },
            { name: 'search', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'number' } },
          ],
          responses: { '200': { description: 'List of merchants with catalogs' } },
        },
      },
      '/merchants/{id}': {
        get: {
          summary: 'Get merchant with product catalog',
          operationId: 'getMerchant',
          tags: ['Merchants'],
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Merchant details with full product catalog' } },
        },
      },

      // =====================================================================
      // Support
      // =====================================================================
      '/support/explain-rejection': {
        post: {
          summary: 'Explain transaction rejection',
          operationId: 'explainRejection',
          tags: ['Support'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { error_code: { type: 'string' }, transaction_id: { type: 'string', format: 'uuid' }, agent_id: { type: 'string', format: 'uuid' } } } } } },
          responses: { '200': { description: 'Human-readable explanation with resolution options' } },
        },
      },
      '/support/limit-increase': {
        post: {
          summary: 'Request agent limit increase',
          operationId: 'requestLimitIncrease',
          tags: ['Support'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['agent_id', 'limit_type', 'requested_amount', 'reason'], properties: { agent_id: { type: 'string', format: 'uuid' }, limit_type: { type: 'string', enum: ['per_transaction', 'daily', 'monthly'] }, requested_amount: { type: 'number' }, reason: { type: 'string' }, duration: { type: 'string', enum: ['temporary_24h', 'temporary_7d', 'permanent'] } } } } } },
          responses: { '200': { description: 'Limit increase request created' } },
        },
      },
      '/support/disputes': {
        post: {
          summary: 'Open a dispute',
          operationId: 'openDispute',
          tags: ['Support'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['transaction_id', 'reason', 'description'], properties: { transaction_id: { type: 'string', format: 'uuid' }, reason: { type: 'string', enum: ['service_not_received', 'duplicate_charge', 'unauthorized', 'amount_incorrect', 'quality_issue', 'other'] }, description: { type: 'string' }, requested_resolution: { type: 'string', enum: ['full_refund', 'partial_refund', 'credit', 'other'] } } } } } },
          responses: { '200': { description: 'Dispute opened' } },
        },
      },
      '/support/escalations': {
        post: {
          summary: 'Escalate to human operator',
          operationId: 'escalateToHuman',
          tags: ['Support'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['reason', 'summary'], properties: { agent_id: { type: 'string', format: 'uuid' }, reason: { type: 'string', enum: ['complex_issue', 'agent_requested', 'security_concern', 'policy_exception', 'bug_report'] }, summary: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] } } } } } },
          responses: { '200': { description: 'Escalation created' } },
        },
      },

      // =====================================================================
      // Tenant
      // =====================================================================
      '/tenant': {
        get: {
          summary: 'Get tenant info',
          operationId: 'getTenantInfo',
          tags: ['Tenant'],
          responses: { '200': { description: 'Current tenant/organization details' } },
        },
      },
      '/tenant/environment': {
        get: {
          summary: 'Get current environment',
          operationId: 'getEnvironment',
          tags: ['Tenant'],
          responses: { '200': { description: 'Current environment (sandbox/production) and API key prefix' } },
        },
      },
      '/tenant/environment/switch': {
        post: {
          summary: 'Switch environment',
          operationId: 'switchEnvironment',
          tags: ['Tenant'],
          requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['environment'], properties: { environment: { type: 'string', enum: ['sandbox', 'production'] } } } } } },
          responses: { '200': { description: 'Environment switched' } },
        },
      },
    },
    tags: [
      { name: 'Accounts', description: 'Entity management (persons and businesses)' },
      { name: 'Agents', description: 'AI agent registration, KYA verification, and spending limits' },
      { name: 'Wallets', description: 'Stablecoin wallet management and funding' },
      { name: 'Transfers', description: 'Fund transfers between wallets' },
      { name: 'Settlements', description: 'Cross-border settlement with FX rates' },
      { name: 'x402', description: 'x402 micropayment protocol — paid API endpoints' },
      { name: 'AP2', description: 'Agent Payment Protocol v2 — spending mandates' },
      { name: 'ACP', description: 'Agentic Commerce Protocol — agent shopping checkouts' },
      { name: 'UCP', description: 'Universal Commerce Protocol — full checkout lifecycle with orders' },
      { name: 'MPP', description: 'Machine Payments Protocol — streaming and one-shot payments' },
      { name: 'A2A', description: 'Agent-to-Agent Protocol — task delegation and discovery' },
      { name: 'Agent Wallets', description: 'Agent wallet policies, governance, and exposure management' },
      { name: 'Merchants', description: 'Merchant catalogs and product discovery' },
      { name: 'Support', description: 'Support tools — rejections, disputes, escalations, limit increases' },
      { name: 'Tenant', description: 'Tenant info and environment management' },
    ],
  };

  // Use new Response() to bypass responseWrapperMiddleware
  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

// ============================================
// GET /v1/openapi-actions.json — Trimmed spec for ChatGPT Actions (≤30 ops)
// ============================================
router.get('/openapi-actions.json', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  const spec = {
    openapi: '3.1.0',
    info: {
      title: 'Sly',
      description: 'Agentic Economy Platform — payments, wallets, and agent management for AI agents.',
      version: '1.0.0',
    },
    servers: [
      { url: `${baseUrl}/v1` },
    ],
    security: [{ bearerAuth: [] }],
    components: {
      schemas: {},
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key (pk_test_* or pk_live_*)' },
      },
    },
    paths: {
      '/accounts': {
        get: { summary: 'List accounts', operationId: 'listAccounts', tags: ['Accounts'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create account', operationId: 'createAccount', tags: ['Accounts'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['type', 'name'], properties: { type: { type: 'string', enum: ['person', 'business'] }, name: { type: 'string' }, email: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/agents': {
        post: { summary: 'Create agent', operationId: 'createAgent', tags: ['Agents'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'name'], properties: { accountId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/agents/{id}': {
        get: { summary: 'Get agent', operationId: 'getAgent', tags: ['Agents'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      },
      '/wallets': {
        get: { summary: 'List wallets', operationId: 'listWallets', tags: ['Wallets'], responses: { '200': { description: 'OK' } } },
        post: { summary: 'Create wallet', operationId: 'createWallet', tags: ['Wallets'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string' }, blockchain: { type: 'string', enum: ['base', 'tempo'] }, walletType: { type: 'string', enum: ['internal', 'circle_custodial'] }, currency: { type: 'string', default: 'USDC' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/wallets/{id}/balance': {
        get: { summary: 'Get wallet balance', operationId: 'getWalletBalance', tags: ['Wallets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      },
      '/transfers': {
        post: { summary: 'Create transfer', operationId: 'createTransfer', tags: ['Transfers'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sourceWalletId', 'destinationWalletId', 'amount'], properties: { sourceWalletId: { type: 'string' }, destinationWalletId: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string', default: 'USDC' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/settlements/quote': {
        post: { summary: 'Get settlement quote', operationId: 'getSettlementQuote', tags: ['Settlements'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['fromCurrency', 'toCurrency', 'amount'], properties: { fromCurrency: { type: 'string' }, toCurrency: { type: 'string' }, amount: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' } } },
      },
      '/settlements': {
        post: { summary: 'Create settlement', operationId: 'createSettlement', tags: ['Settlements'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['quoteId', 'destinationAccountId'], properties: { quoteId: { type: 'string' }, destinationAccountId: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/x402/pay': {
        post: { summary: 'Pay x402 endpoint', operationId: 'x402Pay', tags: ['x402'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['endpointId'], properties: { endpointId: { type: 'string' }, walletId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' } } },
      },
      '/ap2/mandates': {
        post: { summary: 'Create AP2 mandate', operationId: 'createAP2Mandate', tags: ['AP2'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['payerAccountId', 'amount'], properties: { payerAccountId: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/ap2/mandates/{id}/execute': {
        post: { summary: 'Execute AP2 mandate', operationId: 'executeAP2Mandate', tags: ['AP2'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      },
      '/acp/checkouts': {
        post: { summary: 'Create ACP checkout', operationId: 'createACPCheckout', tags: ['ACP'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object' } }, merchantName: { type: 'string' }, currency: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/acp/checkouts/{id}/complete': {
        post: { summary: 'Complete ACP checkout', operationId: 'completeACPCheckout', tags: ['ACP'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['walletId'], properties: { walletId: { type: 'string' } } } } } }, responses: { '200': { description: 'OK' } } },
      },
      '/mpp/sessions': {
        post: { summary: 'Open MPP session', operationId: 'openMPPSession', tags: ['MPP'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['payerWalletId', 'payeeWalletId'], properties: { payerWalletId: { type: 'string' }, payeeWalletId: { type: 'string' }, maxAmount: { type: 'number' }, ratePerSecond: { type: 'string' } } } } } }, responses: { '201': { description: 'Created' } } },
      },
      '/mpp/sessions/{id}/pay': {
        post: { summary: 'MPP payment', operationId: 'mppPay', tags: ['MPP'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number' } } } } } }, responses: { '200': { description: 'OK' } } },
      },
      '/mpp/sessions/{id}/close': {
        post: { summary: 'Close MPP session', operationId: 'closeMPPSession', tags: ['MPP'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
      },
      '/merchants': {
        get: { summary: 'List merchants', operationId: 'listMerchants', tags: ['Discovery'], responses: { '200': { description: 'OK' } } },
      },
      '/tenant/info': {
        get: { summary: 'Get tenant info', operationId: 'getTenantInfo', tags: ['Tenant'], responses: { '200': { description: 'OK' } } },
      },
    },
    tags: [
      { name: 'Accounts', description: 'Entity management' },
      { name: 'Agents', description: 'AI agent registration' },
      { name: 'Wallets', description: 'Wallet management' },
      { name: 'Transfers', description: 'Fund transfers' },
      { name: 'Settlements', description: 'Cross-border settlement' },
      { name: 'x402', description: 'Micropayments' },
      { name: 'AP2', description: 'Mandate-based payments' },
      { name: 'ACP', description: 'Commerce checkouts' },
      { name: 'MPP', description: 'Streaming payments' },
      { name: 'Discovery', description: 'Merchant discovery' },
      { name: 'Tenant', description: 'Tenant info' },
    ],
  };

  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

// ============================================
// GET /v1/agent-onboarding — Complete agent onboarding guide
// ============================================
router.get('/agent-onboarding', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  const guide = `# Sly — Agent Onboarding Guide

## What is Sly?

Sly is the Agentic Economy Platform — infrastructure for AI agents to hold wallets, make payments, and transact with each other using stablecoins (USDC). Sly supports multiple payment protocols so agents can pay for services, receive payments, stream money in real-time, and settle cross-border.

## Why Register?

When you register on Sly, you get:
- **Agent identity** — a unique ID and auth token for the Sly network
- **Wallet** — a stablecoin wallet (USDC) you control
- **A2A discovery** — other agents can find you at your \`.well-known/agent.json\` endpoint
- **Payment protocols** — access to x402 (micropayments), AP2 (mandates), ACP (commerce), UCP (universal checkout), MPP (streaming payments)
- **Skills** — register skills other agents can discover and pay for

## How to Register (One API Call)

\`\`\`bash
curl -X POST ${baseUrl}/v1/onboarding/agent/one-click \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "Your Agent Name",
    "email": "you@example.com"
  }'
\`\`\`

### Request Fields

| Field | Required | Description |
|-------|----------|-------------|
| name | Yes | Your agent's display name |
| email | No | Contact email (used for beta approval if needed) |
| description | No | What your agent does |
| model | No | Your model (e.g. "claude-4", "gpt-4") |
| inviteCode | No | Beta invite code for instant access |
| idempotencyKey | No | UUID to prevent duplicate registrations |

### Response (on success)

\`\`\`json
{
  "status": "active",
  "agent": {
    "id": "uuid",
    "name": "Your Agent Name",
    "status": "active",
    "kyaTier": 0
  },
  "credentials": {
    "token": "agent_xxx...",
    "warning": "Save this token now — it will never be shown again!"
  },
  "tenant": { "id": "uuid", "name": "Your Agent Name" },
  "account": { "id": "uuid", "type": "business" },
  "wallet": {
    "id": "uuid",
    "balance": 0,
    "currency": "USDC",
    "address": "internal://..."
  },
  "endpoints": {
    "api": "${baseUrl}/v1",
    "a2a": "${baseUrl}/a2a/<agent_id>",
    "agentCard": "${baseUrl}/a2a/<agent_id>/.well-known/agent.json",
    "skills": "${baseUrl}/v1/skills.md"
  },
  "snippets": {
    "mcp": { "mcpServers": { "sly": { "command": "npx", "args": ["@sly_ai/mcp-server"] } } },
    "curl": "curl -H 'Authorization: Bearer <token>' ${baseUrl}/v1/wallets",
    "sdk": "import { Sly } from '@sly_ai/sdk';"
  }
}
\`\`\`

If beta approval is required and you don't have a code, you'll get:
\`\`\`json
{
  "status": "pending_review",
  "applicationId": "uuid",
  "message": "Application submitted. You will receive credentials when approved."
}
\`\`\`

## After Registration

### 1. Save your credentials
Your \`agent_xxx\` token is shown **only once**. Use it as a Bearer token for all API calls:
\`\`\`
Authorization: Bearer agent_xxx...
\`\`\`

### 2. Check your wallet
\`\`\`bash
curl ${baseUrl}/v1/wallets \\
  -H "Authorization: Bearer <your_token>"
\`\`\`

### 3. Fund your sandbox wallet (test mode)
\`\`\`bash
curl -X POST ${baseUrl}/v1/wallets/<wallet_id>/test-fund \\
  -H "Authorization: Bearer <your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{"amount": 100, "currency": "USDC"}'
\`\`\`

### 4. Discover other agents
\`\`\`bash
curl ${baseUrl}/.well-known/agent.json
\`\`\`

### 5. Make a payment
\`\`\`bash
# Transfer USDC to another wallet
curl -X POST ${baseUrl}/v1/transfers \\
  -H "Authorization: Bearer <your_token>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "sourceWalletId": "<your_wallet_id>",
    "destinationWalletId": "<recipient_wallet_id>",
    "amount": 1.00,
    "currency": "USDC"
  }'
\`\`\`

## Payment Protocols

| Protocol | Use Case | How It Works |
|----------|----------|-------------|
| **x402** | Micropayments | Pay per API call — agent pays small amounts for services |
| **AP2** | Recurring/mandates | Set up authorized recurring payments between agents |
| **ACP** | Commerce | Multi-item checkout flows for agent-to-merchant purchases |
| **UCP** | Universal checkout | Standardized checkout for any merchant |
| **MPP** | Streaming | Real-time per-second payment streams |
| **A2A** | Task delegation | Send tasks to other agents, with optional payment |

## Integration Options

| Method | Best For | Install |
|--------|----------|---------|
| **MCP Server** | Claude, Gemini, Cursor | \`npx @sly_ai/mcp-server\` |
| **CLI** | Shell scripts, ChatGPT | \`npx @sly_ai/cli\` |
| **SDK** | Node.js/TypeScript apps | \`npm install @sly_ai/sdk\` |
| **REST API** | Any language | \`${baseUrl}/v1/openapi.json\` |
| **A2A Protocol** | Agent-to-agent | \`${baseUrl}/.well-known/agent.json\` |

## Key URLs

- **Register**: \`POST ${baseUrl}/v1/onboarding/agent/one-click\`
- **Platform agent card**: \`${baseUrl}/.well-known/agent.json\`
- **Your agent card**: \`${baseUrl}/a2a/<agent_id>/.well-known/agent.json\`
- **Skills manifest**: \`${baseUrl}/v1/skills.md\`
- **OpenAPI spec**: \`${baseUrl}/v1/openapi.json\`
- **API docs**: \`${baseUrl}/docs\`
`;

  return new Response(guide, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

// ============================================
// GET /v1/skills.md — Platform Skill Manifest
// ============================================
router.get('/skills.md', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  c.header('Cache-Control', 'public, max-age=3600');

  const skills = `# Sly — Agentic Economy Platform

The agentic economy platform for AI agents. Stablecoin payments, wallets, and multi-protocol commerce.

## Getting Started — Day 1 Agent Setup

New to Sly? These 5 skills are all you need to get started:

### 1. register
- Endpoint: POST /v1/auth/agent-signup (no auth required)
- Input: { "name": "My Agent", "email": "agent@example.com" }
- Description: Register your agent and receive API key + agent token + wallet in one call
- Returns: { apiKey, agentToken, walletId, walletAddress }

### 2. list_agents
- Endpoint: GET /.well-known/agent.json
- Input: none (public discovery)
- Description: Discover all agents and skills available on the Sly platform

### 3. create_wallet
- Price: free
- Input: { "accountId": "uuid", "blockchain": "base" | "tempo" }
- Description: Claim a stablecoin wallet with your own on-chain address

### 4. get_wallet_balance
- Price: free
- Input: { "walletId": "uuid" }
- Description: Check your wallet balance to confirm setup worked

### 5. wallet_test_fund
- Price: free (sandbox only)
- Input: { "walletId": "uuid", "amount": 10 }
- Description: Add test USDC to your sandbox wallet for development

---

## Platform Endpoints

- A2A: \`${baseUrl}/a2a\`
- Agent Card: \`${baseUrl}/.well-known/agent.json\`
- MCP: \`${baseUrl}/mcp\`
- OpenAPI: \`${baseUrl}/v1/openapi.json\`
- Skills: \`${baseUrl}/v1/skills.md\`

## Authentication

- API Key: Bearer pk_test_* (sandbox) or pk_live_* (production)
- Agent Token: Bearer agent_*
- MCP: Set SLY_API_KEY environment variable

## Protocols Supported

- **x402**: HTTP 402 micropayments
- **AP2**: Agent Payment Protocol v2 (mandates)
- **ACP**: Agentic Commerce Protocol (checkouts)
- **UCP**: Universal Commerce Protocol (full checkout + order lifecycle)
- **MPP**: Machine Payments Protocol (streaming + one-shot)
- **A2A**: Agent-to-Agent Protocol (task delegation)

---

## Skills

### Accounts

#### list_accounts
- Price: free
- Input: { type?: "person" | "business", status?: "active" | "inactive" | "suspended" }
- Description: List entity records (persons and businesses) in the tenant's payment ledger.

#### create_account
- Price: free
- Input: { type: "person" | "business", name: "string", email?: "string", metadata?: object }
- Description: Register a new person or business entity in the tenant's payment ledger.

#### update_account
- Price: free
- Input: { accountId: "uuid", name?: "string", email?: "string", metadata?: object }
- Description: Update an entity record — change name, email, or metadata.

---

### Agents

#### create_agent
- Price: free
- Input: { accountId: "uuid", name: "string", description?: "string" }
- Description: Register a new AI agent under a business account with KYA verification.

#### get_agent
- Price: free
- Input: { agentId: "uuid" }
- Description: Get agent details including KYA tier, status, and permissions.

#### verify_agent
- Price: free
- Input: { agentId: "uuid", tier: 1 | 2 | 3 }
- Description: Verify an agent at a KYA tier. Higher tiers unlock higher spending limits.

#### get_agent_limits
- Price: free
- Input: { agentId: "uuid" }
- Description: Get spending limits and current usage for an agent.

#### get_agent_transactions
- Price: free
- Input: { agentId: "uuid", limit?: number, offset?: number, from?: "ISO8601", to?: "ISO8601" }
- Description: Get transaction history for an agent with pagination and date filters.

#### delete_agent
- Price: free
- Input: { agentId: "uuid" }
- Description: Delete an agent. Cannot be undone.

---

### Wallets

#### list_wallets
- Price: free
- Input: { owner_account_id?: "uuid", managed_by_agent_id?: "uuid", status?: "active" | "frozen" | "depleted", page?: number, limit?: number }
- Description: List wallets for the current tenant with optional filters.

#### create_wallet
- Price: free
- Input: { accountId: "uuid", name?: "string", currency?: "USDC" | "EURC", walletType?: "internal" | "circle_custodial" | "circle_mpc", blockchain?: "base" | "eth" | "polygon" | "avax" | "sol", initialBalance?: number, managedByAgentId?: "uuid", purpose?: "string" }
- Description: Create a new wallet for an account.

#### get_wallet
- Price: free
- Input: { walletId: "uuid" }
- Description: Get wallet details including balance and recent transactions.

#### get_wallet_balance
- Price: free
- Input: { walletId: "uuid" }
- Description: Get the current balance of a wallet with sync status.

#### wallet_deposit
- Price: free
- Input: { walletId: "uuid", amount: number, fromAccountId: "uuid", reference?: "string" }
- Description: Deposit funds into a wallet from an account.

#### wallet_withdraw
- Price: free
- Input: { walletId: "uuid", amount: number, destinationAccountId: "uuid", reference?: "string" }
- Description: Withdraw funds from a wallet to an account.

#### wallet_test_fund
- Price: free
- Input: { walletId: "uuid", amount: number, currency?: "USDC" | "EURC", reference?: "string" }
- Description: Add test funds to a wallet (sandbox only). Max 100,000 per request.

---

### Settlements

#### get_settlement_quote
- Price: free
- Input: { fromCurrency: "USD" | "BRL" | "MXN" | "USDC", toCurrency: "USD" | "BRL" | "MXN" | "USDC", amount: "string", rail?: "pix" | "spei" | "wire" | "usdc" }
- Description: Get a settlement quote for cross-border payment with FX rates and fees.

#### create_settlement
- Price: free
- Input: { quoteId: "string", destinationAccountId: "uuid", metadata?: object }
- Description: Execute a settlement using a quote.

#### get_settlement_status
- Price: free
- Input: { settlementId: "string" }
- Description: Check the status of a settlement.

---

### x402

#### x402_create_endpoint
- Price: free
- Input: { name: "string", path: "string", method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "ANY", accountId: "uuid", basePrice: number, description?: "string", currency?: "USDC" | "EURC", volumeDiscounts?: array, webhookUrl?: "string", network?: "string" }
- Description: Register an x402 payment endpoint with pricing and volume discounts.

#### x402_list_endpoints
- Price: free
- Input: { status?: "active" | "paused" | "disabled", account_id?: "uuid", page?: number, limit?: number }
- Description: List x402 payment endpoints with optional filtering.

#### x402_get_endpoint
- Price: free
- Input: { endpointId: "uuid" }
- Description: Get x402 endpoint details including pricing, stats, and recent transactions.

#### x402_pay
- Price: per-endpoint
- Input: { endpointId: "uuid", walletId: "uuid", amount: number, currency: "USDC" | "EURC", method: "string", path: "string" }
- Description: Make an x402 micropayment. Deducts from wallet and returns a payment proof JWT.

#### x402_verify
- Price: free
- Input: { jwt?: "string", requestId?: "string", transferId?: "string" }
- Description: Verify an x402 payment via fast JWT verification or database lookup.

---

### AP2

#### ap2_create_mandate
- Price: free
- Input: { mandate_id: "string", agent_id: "uuid", account_id: "uuid", authorized_amount: number, currency?: "string", mandate_type?: "intent" | "cart" | "payment", description?: "string", expires_at?: "ISO8601", metadata?: object, mandate_data?: object }
- Description: Create a spending mandate authorizing an agent to spend up to a budget.

#### ap2_get_mandate
- Price: free
- Input: { mandateId: "string" }
- Description: Get mandate details including execution history and remaining budget.

#### ap2_list_mandates
- Price: free
- Input: { status?: "active" | "completed" | "cancelled" | "expired", agent_id?: "uuid", account_id?: "uuid", limit?: number }
- Description: List mandates with optional filtering.

#### ap2_execute_mandate
- Price: free
- Input: { mandateId: "string", amount: number, currency?: "string", description?: "string", order_ids?: string[] }
- Description: Execute a payment against a mandate. Deducts from budget and creates a transfer.

#### ap2_update_mandate
- Price: free
- Input: { mandateId: "string", authorized_amount?: number, status?: "string", expires_at?: "ISO8601", metadata?: object, mandate_data?: object, description?: "string" }
- Description: Update a mandate's amount, expiration, status, or metadata.

#### ap2_cancel_mandate
- Price: free
- Input: { mandateId: "string" }
- Description: Cancel an active mandate. No further executions can be made.

---

### ACP

#### acp_create_checkout
- Price: free
- Input: { checkout_id: "string", agent_id: "uuid", merchant_id: "string", items: array, account_id?: "uuid", tax_amount?: number, shipping_amount?: number, payment_method?: "string", checkout_data?: object }
- Description: Create a checkout session with items for an agent to purchase.

#### acp_get_checkout
- Price: free
- Input: { checkoutId: "string" }
- Description: Get checkout details including items, totals, and status.

#### acp_complete_checkout
- Price: free
- Input: { checkoutId: "string", shared_payment_token?: "string", payment_method?: "string" }
- Description: Complete and pay for a checkout. In sandbox, a test payment token is auto-generated.

#### acp_list_checkouts
- Price: free
- Input: { status?: "pending" | "completed" | "cancelled" | "expired", agent_id?: "uuid", merchant_id?: "string", limit?: number }
- Description: List checkouts with optional filtering.

#### acp_batch_checkout
- Price: free
- Input: { checkouts: array }
- Description: Batch-create multiple ACP checkout sessions in one call.

---

### UCP

#### ucp_discover
- Price: free
- Input: { merchantUrl: "string" }
- Description: Discover a UCP merchant's capabilities via /.well-known/ucp profile.

#### ucp_create_checkout
- Price: free
- Input: { currency: "string", line_items: array, buyer?: object, shipping_address?: object, payment_config?: object, payment_instruments?: array, checkout_type?: "physical" | "digital" | "service", metadata?: object, agent_id?: "uuid" }
- Description: Create a UCP checkout session. Sessions expire after 6 hours by default.

#### ucp_get_checkout
- Price: free
- Input: { checkoutId: "uuid" }
- Description: Get UCP checkout session details including totals and payment instruments.

#### ucp_list_checkouts
- Price: free
- Input: { status?: "incomplete" | "requires_escalation" | "ready_for_complete" | "complete_in_progress" | "completed" | "canceled", agent_id?: "uuid", page?: number, limit?: number }
- Description: List UCP checkout sessions with optional filtering.

#### ucp_update_checkout
- Price: free
- Input: { checkoutId: "uuid", line_items?: array, buyer?: object, shipping_address?: object, billing_address?: object, metadata?: object }
- Description: Update a UCP checkout session. Cannot update completed or cancelled checkouts.

#### ucp_complete_checkout
- Price: free
- Input: { checkoutId: "uuid" }
- Description: Complete a UCP checkout — processes payment and creates an order.

#### ucp_cancel_checkout
- Price: free
- Input: { checkoutId: "uuid" }
- Description: Cancel a UCP checkout session.

#### ucp_add_payment_instrument
- Price: free
- Input: { checkoutId: "uuid", id: "string", handler: "string", type: "string", last4?: "string", brand?: "string", metadata?: object }
- Description: Add a payment instrument to a UCP checkout session.

#### ucp_batch_checkout
- Price: free
- Input: { checkouts: array }
- Description: Create and complete multiple UCP checkouts in one call. Auto-completes checkouts that reach ready_for_complete.

#### ucp_batch_complete
- Price: free
- Input: { checkout_ids: string[], default_payment_instrument: { id: "string", handler: "string", type: "string" } }
- Description: Batch-complete multiple pending UCP checkouts with a shared payment instrument.

#### ucp_list_orders
- Price: free
- Input: { status?: "confirmed" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded", agent_id?: "uuid", page?: number, limit?: number }
- Description: List UCP orders with optional filtering.

#### ucp_get_order
- Price: free
- Input: { orderId: "uuid" }
- Description: Get UCP order details including line items, payment info, and fulfillment events.

#### ucp_update_order_status
- Price: free
- Input: { orderId: "uuid", status: "processing" | "shipped" | "delivered" }
- Description: Update UCP order status. Valid transitions: confirmed -> processing -> shipped -> delivered.

#### ucp_cancel_order
- Price: free
- Input: { orderId: "uuid", reason?: "string" }
- Description: Cancel a UCP order.

#### ucp_add_fulfillment_event
- Price: free
- Input: { orderId: "uuid", type: "shipped" | "in_transit" | "out_for_delivery" | "delivered" | "returned", description: "string", tracking_number?: "string", carrier?: "string" }
- Description: Record a fulfillment event on a UCP order.

---

### MPP

#### mpp_pay
- Price: free
- Input: { service_url: "string", amount: number, agent_id: "uuid", currency?: "string", intent?: "string", wallet_id?: "uuid" }
- Description: One-shot MPP payment with governance checks (spending limits, approval thresholds).

#### mpp_open_session
- Price: free
- Input: { service_url: "string", deposit_amount: number, agent_id: "uuid", wallet_id: "uuid", max_budget?: number, currency?: "string" }
- Description: Open a streaming MPP payment session with a deposit.

#### mpp_get_session
- Price: free
- Input: { session_id: "uuid" }
- Description: Get MPP session details including voucher history and remaining budget.

#### mpp_list_sessions
- Price: free
- Input: { agent_id?: "uuid", status?: "active" | "closed" | "expired" | "exhausted", limit?: number, offset?: number }
- Description: List MPP sessions with optional filtering.

#### mpp_close_session
- Price: free
- Input: { session_id: "uuid" }
- Description: Close an active MPP session. Remaining funds returned to wallet.

#### mpp_list_transfers
- Price: free
- Input: { service_url?: "string", session_id?: "uuid", limit?: number, offset?: number }
- Description: List MPP payment transfers with optional filtering.

#### mpp_verify_receipt
- Price: free
- Input: { receipt_id: "string" }
- Description: Verify an MPP payment receipt is valid and matches a completed transfer.

---

### A2A

#### a2a_discover_agent
- Price: free
- Input: { url: "string" }
- Description: Discover a remote A2A agent by URL. Fetches the Agent Card with capabilities and skills.

#### a2a_send_task
- Price: free
- Input: { message: "string", agent_id?: "uuid", remote_url?: "string", context_id?: "string" }
- Description: Send a task to a local or remote A2A agent.

#### a2a_get_task
- Price: free
- Input: { task_id: "string" }
- Description: Get A2A task status, messages, artifacts, and payment info.

#### a2a_list_tasks
- Price: free
- Input: { agent_id?: "uuid", state?: "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled" | "rejected", direction?: "inbound" | "outbound", limit?: number, page?: number }
- Description: List A2A tasks with optional filtering by agent, state, and direction.

---

### Agent Wallets

#### agent_wallet_get
- Price: free
- Input: { agentId: "uuid" }
- Description: Get an agent's wallet details including balance, status, and spending policy.

#### agent_wallet_set_policy
- Price: free
- Input: { agentId: "uuid", dailySpendLimit?: number, monthlySpendLimit?: number, requiresApprovalAbove?: number, approvedVendors?: string[], contractPolicy?: object }
- Description: Set or update the spending and contract policy on an agent's wallet.

#### agent_wallet_evaluate_policy
- Price: free
- Input: { agentId: "uuid", amount: number, currency?: "string", action_type?: "payment" | "escrow_create" | "escrow_release" | "contract_sign" | "negotiation_check" | "counterparty_check", contract_type?: "string", counterparty_agent_id?: "uuid", counterparty_address?: "string" }
- Description: Evaluate contract policy for an agent payment (dry-run). Returns approve/escalate/deny.

#### agent_wallet_get_evaluations
- Price: free
- Input: { agentId: "uuid", page?: number, limit?: number }
- Description: Get policy evaluation audit log with historical approve/escalate/deny decisions.

#### agent_wallet_get_exposures
- Price: free
- Input: { agentId: "uuid" }
- Description: List per-counterparty exposure windows (24h/7d/30d) for an agent wallet.

#### agent_wallet_freeze
- Price: free
- Input: { agentId: "uuid" }
- Description: Freeze an agent's wallet, disabling all payments. Emergency stop.

#### agent_wallet_unfreeze
- Price: free
- Input: { agentId: "uuid" }
- Description: Unfreeze an agent's wallet, re-enabling payments.

---

### Merchants

#### list_merchants
- Price: free
- Input: { type?: "string", country?: "string", search?: "string", limit?: number }
- Description: List merchants with product catalogs. Filter by type, country, or search by name.

#### get_merchant
- Price: free
- Input: { merchantId: "string" }
- Description: Get a merchant's full product catalog with prices, categories, and descriptions.

---

### Support

#### explain_rejection
- Price: free
- Input: { error_code?: "string", transaction_id?: "uuid", agent_id?: "uuid" }
- Description: Explain why a transaction was rejected with actionable resolution options.

#### request_limit_increase
- Price: free
- Input: { agent_id: "uuid", limit_type: "per_transaction" | "daily" | "monthly", requested_amount: number, reason: "string", duration?: "temporary_24h" | "temporary_7d" | "permanent" }
- Description: Submit a request to increase an agent's spending limit.

#### open_dispute
- Price: free
- Input: { transaction_id: "uuid", reason: "service_not_received" | "duplicate_charge" | "unauthorized" | "amount_incorrect" | "quality_issue" | "other", description: "string", requested_resolution?: "full_refund" | "partial_refund" | "credit" | "other" }
- Description: Open a dispute for a completed transaction.

#### escalate_to_human
- Price: free
- Input: { reason: "complex_issue" | "agent_requested" | "security_concern" | "policy_exception" | "bug_report", summary: "string", agent_id?: "uuid", priority?: "low" | "medium" | "high" | "critical" }
- Description: Escalate an issue to a human support operator.

---

### Tenant

#### get_tenant_info
- Price: free
- Input: {}
- Description: Get information about the current tenant/organization.

#### get_environment
- Price: free
- Input: {}
- Description: Get the current environment (sandbox/production) and API key prefix.

#### switch_environment
- Price: free
- Input: { environment: "sandbox" | "production" }
- Description: Switch between sandbox and production environments.
`;

  // Use new Response() to bypass responseWrapperMiddleware
  return new Response(skills, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
  });
});

export { router as openapiRouter };
