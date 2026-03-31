#!/usr/bin/env node

/**
 * Sly MCP Server — CLI Entry Point
 *
 * Model Context Protocol server for Claude Desktop integration.
 * Exposes Sly payment capabilities as MCP tools via stdio transport.
 *
 * Usage:
 *   npx @sly/mcp-server
 *
 * Configuration via environment variables:
 *   SLY_API_KEY - Your Sly API key (required)
 *   SLY_ENVIRONMENT - 'sandbox' | 'testnet' | 'production' (default: 'sandbox')
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Sly, getEnvironmentConfig } from '@sly_ai/sdk';
import { createMcpServer } from './server-factory.js';

// Re-export for external consumers (e.g., apps/api remote MCP endpoint)
export { tools } from './tools.js';
export { createMcpServer } from './server-factory.js';
export type { McpContext } from './server-factory.js';

// Get configuration from environment
const SLY_API_KEY = process.env.SLY_API_KEY;
const SLY_API_KEY_LIVE = process.env.SLY_API_KEY_LIVE;
const SLY_ENVIRONMENT = (process.env.SLY_ENVIRONMENT as 'sandbox' | 'testnet' | 'production') || 'sandbox';

if (!SLY_API_KEY) {
  console.error('Error: SLY_API_KEY environment variable is required');
  process.exit(1);
}

// Initialize Sly SDK
const sly = new Sly({
  apiKey: SLY_API_KEY,
  environment: SLY_ENVIRONMENT,
  apiUrl: process.env.SLY_API_URL,
});

// Derive API URL for direct fetch calls (batch operations)
const SLY_API_URL = process.env.SLY_API_URL || getEnvironmentConfig(SLY_ENVIRONMENT).apiUrl;

// Build keys map for runtime environment switching
const keys: Record<string, string> = { sandbox: SLY_API_KEY };
if (SLY_API_KEY_LIVE) keys.production = SLY_API_KEY_LIVE;

// Build URLs map for runtime environment switching
const SLY_API_URL_LIVE = process.env.SLY_API_URL_LIVE;
const urls: Record<string, string> = { sandbox: SLY_API_URL };
if (SLY_API_URL_LIVE) urls.production = SLY_API_URL_LIVE;

// Create MCP server with all tools
const server = createMcpServer(sly, SLY_API_URL, SLY_API_KEY, keys, urls);

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('Sly MCP server running on stdio');
  console.error(`Environment: ${SLY_ENVIRONMENT}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
