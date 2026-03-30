/**
 * OpenAPI Spec + Skills.md + Docs endpoints
 *
 * Public endpoints for API documentation and agent discovery.
 */

import { Hono } from 'hono';

const router = new Hono();

// ============================================
// GET /v1/openapi.json — OpenAPI 3.0 Specification
// ============================================
router.get('/openapi.json', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  const spec = {
    openapi: '3.0.3',
    info: {
      title: 'Sly API',
      description: 'The Agentic Economy Platform — stablecoin payments, agent wallets, and multi-protocol commerce for AI agents.',
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
          description: 'API key (pk_test_* or pk_live_*) or JWT session token',
        },
      },
    },
    paths: {
      '/accounts': {
        get: { summary: 'List accounts', operationId: 'listAccounts', tags: ['Accounts'], parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'suspended'] } }, { name: 'type', in: 'query', schema: { type: 'string', enum: ['person', 'business'] } }], responses: { '200': { description: 'List of accounts' } } },
        post: { summary: 'Create account', operationId: 'createAccount', tags: ['Accounts'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['type', 'name'], properties: { type: { type: 'string', enum: ['person', 'business'] }, name: { type: 'string' }, email: { type: 'string' }, currency: { type: 'string', default: 'USDC' } } } } } }, responses: { '201': { description: 'Account created' } } },
      },
      '/agents': {
        post: { summary: 'Create agent', operationId: 'createAgent', tags: ['Agents'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId', 'name'], properties: { accountId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { '201': { description: 'Agent created with token (shown once)' } } },
      },
      '/agents/{id}': {
        get: { summary: 'Get agent', operationId: 'getAgent', tags: ['Agents'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Agent details' } } },
        delete: { summary: 'Delete agent', operationId: 'deleteAgent', tags: ['Agents'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Agent deleted' } } },
      },
      '/wallets': {
        get: { summary: 'List wallets', operationId: 'listWallets', tags: ['Wallets'], responses: { '200': { description: 'List of wallets' } } },
        post: { summary: 'Create wallet', operationId: 'createWallet', tags: ['Wallets'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['accountId'], properties: { accountId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, blockchain: { type: 'string', enum: ['base', 'eth', 'polygon', 'avax', 'sol', 'tempo'] }, walletType: { type: 'string', enum: ['internal', 'circle_custodial', 'circle_mpc'] }, currency: { type: 'string', default: 'USDC' } } } } } }, responses: { '201': { description: 'Wallet created' } } },
      },
      '/wallets/{id}/balance': {
        get: { summary: 'Get wallet balance', operationId: 'getWalletBalance', tags: ['Wallets'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Wallet balance' } } },
      },
      '/transfers': {
        get: { summary: 'List transfers', operationId: 'listTransfers', tags: ['Transfers'], responses: { '200': { description: 'List of transfers' } } },
        post: { summary: 'Create transfer', operationId: 'createTransfer', tags: ['Transfers'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['sourceWalletId', 'destinationWalletId', 'amount'], properties: { sourceWalletId: { type: 'string', format: 'uuid' }, destinationWalletId: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, currency: { type: 'string', default: 'USDC' } } } } } }, responses: { '201': { description: 'Transfer created' } } },
      },
      '/x402/endpoints': {
        get: { summary: 'List x402 endpoints', operationId: 'listX402Endpoints', tags: ['x402'] , responses: { '200': { description: 'List of x402 payment endpoints' } } },
        post: { summary: 'Create x402 endpoint', operationId: 'createX402Endpoint', tags: ['x402'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['url', 'price'], properties: { url: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string', default: 'USDC' }, description: { type: 'string' } } } } } }, responses: { '201': { description: 'Endpoint created' } } },
      },
      '/x402/pay': {
        post: { summary: 'Pay an x402 endpoint', operationId: 'x402Pay', tags: ['x402'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['endpointId'], properties: { endpointId: { type: 'string', format: 'uuid' }, walletId: { type: 'string', format: 'uuid' } } } } } }, responses: { '200': { description: 'Payment receipt' } } },
      },
      '/ap2/mandates': {
        get: { summary: 'List AP2 mandates', operationId: 'listAP2Mandates', tags: ['AP2'], responses: { '200': { description: 'List of mandates' } } },
        post: { summary: 'Create AP2 mandate', operationId: 'createAP2Mandate', tags: ['AP2'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['payerAccountId', 'amount'], properties: { payerAccountId: { type: 'string', format: 'uuid' }, amount: { type: 'number' }, currency: { type: 'string' }, description: { type: 'string' } } } } } }, responses: { '201': { description: 'Mandate created' } } },
      },
      '/ap2/mandates/{id}/execute': {
        post: { summary: 'Execute AP2 mandate', operationId: 'executeAP2Mandate', tags: ['AP2'], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }], responses: { '200': { description: 'Mandate executed' } } },
      },
      '/settlements/quote': {
        post: { summary: 'Get settlement quote', operationId: 'getSettlementQuote', tags: ['Settlements'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['fromCurrency', 'toCurrency', 'amount'], properties: { fromCurrency: { type: 'string', enum: ['USD', 'BRL', 'MXN', 'USDC'] }, toCurrency: { type: 'string', enum: ['USD', 'BRL', 'MXN', 'USDC'] }, amount: { type: 'string' } } } } } }, responses: { '200': { description: 'Settlement quote' } } },
      },
      '/mpp/sessions': {
        get: { summary: 'List MPP sessions', operationId: 'listMPPSessions', tags: ['MPP'], responses: { '200': { description: 'List of streaming payment sessions' } } },
        post: { summary: 'Open MPP session', operationId: 'openMPPSession', tags: ['MPP'], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['payerWalletId', 'payeeWalletId'], properties: { payerWalletId: { type: 'string', format: 'uuid' }, payeeWalletId: { type: 'string', format: 'uuid' }, maxAmount: { type: 'number' }, ratePerSecond: { type: 'string' } } } } } }, responses: { '201': { description: 'Session opened' } } },
      },
    },
    tags: [
      { name: 'Accounts', description: 'Entity management (persons and businesses)' },
      { name: 'Agents', description: 'AI agent registration and KYA verification' },
      { name: 'Wallets', description: 'Stablecoin wallet management' },
      { name: 'Transfers', description: 'Fund transfers between wallets' },
      { name: 'x402', description: 'x402 micropayment protocol' },
      { name: 'AP2', description: 'Agent Payment Protocol v2 — mandate-based payments' },
      { name: 'Settlements', description: 'Cross-border settlement with FX' },
      { name: 'MPP', description: 'Machine Payments Protocol — real-time streaming payments' },
    ],
  };

  return c.json(spec);
});

// ============================================
// GET /v1/skills.md — Platform Skill Manifest
// ============================================
router.get('/skills.md', (c) => {
  const baseUrl = process.env.API_BASE_URL || 'https://api.getsly.ai';

  const skills = `# Sly — Agentic Economy Platform

The agentic economy platform for AI agents. Stablecoin payments, wallets, and multi-protocol commerce.

## Platform Endpoint

- A2A: \`${baseUrl}/a2a\`
- Agent Card: \`${baseUrl}/.well-known/agent.json\`
- MCP: \`${baseUrl}/mcp\`
- OpenAPI: \`${baseUrl}/v1/openapi.json\`

## Skills

### create_wallet
- Price: free
- Input: { "accountId": "uuid", "blockchain": "base|tempo", "walletType": "circle_custodial|internal" }
- Description: Create a stablecoin wallet on Base or Tempo

### wallet_balance
- Price: free
- Input: { "walletId": "uuid" }
- Description: Check wallet USDC balance

### transfer
- Price: free
- Input: { "sourceWalletId": "uuid", "destinationWalletId": "uuid", "amount": "number" }
- Description: Transfer USDC between wallets

### x402_pay
- Price: per-endpoint
- Input: { "endpointId": "uuid" }
- Description: Pay an x402 micropayment endpoint

### settlement_quote
- Price: free
- Input: { "fromCurrency": "USD|BRL|MXN|USDC", "toCurrency": "USD|BRL|MXN|USDC", "amount": "string" }
- Description: Get cross-border settlement quote with FX rates

### create_agent
- Price: free
- Input: { "accountId": "uuid", "name": "string", "description": "string" }
- Description: Register an AI agent with KYA verification

### ap2_create_mandate
- Price: free
- Input: { "payerAccountId": "uuid", "amount": "number", "description": "string" }
- Description: Create a recurring payment mandate

### mpp_open_session
- Price: free
- Input: { "payerWalletId": "uuid", "payeeWalletId": "uuid", "ratePerSecond": "string" }
- Description: Open a real-time streaming payment session

### a2a_send_task
- Price: free
- Input: { "agentId": "uuid", "message": "string" }
- Description: Send a task to another agent via A2A protocol

## Authentication

- API Key: Bearer pk_test_* (sandbox) or pk_live_* (production)
- Agent Token: Bearer agent_*
- MCP: Set SLY_API_KEY environment variable

## Protocols Supported

- **x402**: HTTP 402 micropayments
- **AP2**: Agent Payment Protocol v2 (mandates)
- **ACP**: Agentic Commerce Protocol (checkouts)
- **UCP**: Universal Commerce Protocol
- **MPP**: Machine Payments Protocol (streaming)
- **A2A**: Agent-to-Agent Protocol (task delegation)
`;

  c.header('Content-Type', 'text/markdown; charset=utf-8');
  return c.body(skills);
});

export { router as openapiRouter };
