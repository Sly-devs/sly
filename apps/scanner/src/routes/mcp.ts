import { Hono } from 'hono';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { SCANNER_TOOLS } from '../mcp/tools.js';
import { handleToolCall, type McpCallContext } from '../mcp/handlers.js';

/**
 * Remote MCP endpoint for partners.
 *
 * Uses the MCP SDK's Web-Standard Streamable HTTP transport in **stateless**
 * mode (new server + transport per request) so each tool call lands on the
 * caller's tenant, not a shared process-level env var. That same stateless
 * design is serverless-friendly — no cross-request state on Vercel.
 *
 * Auth is the same as the REST API: `Authorization: Bearer psk_live_*` or a
 * Supabase JWT. The caller's tenant gets threaded into handleToolCall so
 * write-toolcalls (scan_merchant, batch_scan, run_agent_shopping_test) are
 * tagged correctly.
 */
export const mcpRouter = new Hono();

mcpRouter.all('/mcp', async (c) => {
  const ctx = c.get('ctx');
  if (!ctx?.tenantId) {
    // Auth middleware should have handled this, but double-check.
    return c.json({ error: 'unauthorized' }, 401);
  }

  const callCtx: McpCallContext = {
    tenantId: ctx.tenantId,
    scannerKeyId: ctx.scannerKeyId,
  };

  const server = new Server(
    { name: 'sly-scanner', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SCANNER_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    handleToolCall(request, callCtx),
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless — each request is independent. No session persistence,
    // which is the right default for serverless.
    sessionIdGenerator: undefined,
    // JSON response rather than SSE stream — simpler, works with Vercel's
    // response-buffering model, and partner MCP clients handle both.
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});
