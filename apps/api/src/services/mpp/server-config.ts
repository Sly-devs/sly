/**
 * MPP Server Configuration
 *
 * Per-route pricing config for the Sly API paywall.
 * Defines which routes require MPP payment and their prices.
 *
 * @see Story 71.11: Server Middleware for Hono
 */

import type { MppRoutePrice, MppServerConfig, MppPaymentMethod } from './types.js';

// ============================================
// Default Server Configuration
// ============================================

const DEFAULT_METHODS: MppPaymentMethod[] = ['tempo', 'stripe'];

/**
 * Default MPP server configuration.
 * Routes can be configured via environment or database.
 */
export function getDefaultServerConfig(): MppServerConfig {
  return {
    recipientAddress: process.env.MPP_TEMPO_RECIPIENT || '',
    network: process.env.MPP_TEMPO_TESTNET !== 'false' ? 'tempo-testnet' : 'tempo-mainnet',
    routes: {
      // Example: charge for AI inference endpoints
      '/v1/inference/*': {
        amount: '0.01',
        description: 'AI inference request',
        methods: DEFAULT_METHODS,
      },
    },
  };
}

/**
 * Match a request path to a pricing config.
 * Supports glob patterns with *.
 */
export function matchRoutePrice(
  config: MppServerConfig,
  path: string,
  method?: string
): MppRoutePrice | null {
  // Exact match first
  if (config.routes[path]) {
    return config.routes[path];
  }

  // Method-qualified match (e.g., "POST /v1/chat")
  if (method) {
    const methodPath = `${method.toUpperCase()} ${path}`;
    if (config.routes[methodPath]) {
      return config.routes[methodPath];
    }
  }

  // Glob pattern match
  for (const [pattern, price] of Object.entries(config.routes)) {
    if (matchGlob(pattern, path)) {
      return price;
    }
  }

  return config.defaultPrice || null;
}

/**
 * Simple glob matcher for route patterns.
 * Supports * (any segment) and ** (any path).
 */
function matchGlob(pattern: string, path: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___DOUBLESTAR___/g, '.*');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(path);
}
