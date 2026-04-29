import { Context } from 'hono';

// ============================================
// Story 51.2: Enhanced Error Types
// ============================================

/**
 * Related endpoint suggestion
 */
export interface RelatedEndpoint {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
}

/**
 * Enhanced error response structure (Story 51.2)
 */
export interface EnhancedErrorResponse {
  error: {
    code: string;
    message: string;
    suggestion?: string;
    docs_url?: string;
    related_endpoints?: RelatedEndpoint[];
    details?: unknown;
  };
}

/**
 * Base API error with enhanced fields
 */
export class ApiError extends Error {
  public code: string;
  public suggestion?: string;
  public docsUrl?: string;
  public relatedEndpoints?: RelatedEndpoint[];

  constructor(
    message: string,
    public statusCode: number = 500,
    public details?: unknown,
    options?: {
      code?: string;
      suggestion?: string;
      docsUrl?: string;
      relatedEndpoints?: RelatedEndpoint[];
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = options?.code || 'INTERNAL_ERROR';
    this.suggestion = options?.suggestion;
    this.docsUrl = options?.docsUrl;
    this.relatedEndpoints = options?.relatedEndpoints;
  }
}

export class NotFoundError extends ApiError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id '${id}' not found` : `${resource} not found`;
    const resourceLower = resource.toLowerCase().replace(/\s+/g, '-');

    // Story 51.2: Add helpful suggestions based on resource type
    const suggestions = getNotFoundSuggestions(resource, id);

    super(message, 404, undefined, {
      code: `${resourceLower.toUpperCase().replace(/-/g, '_')}_NOT_FOUND`,
      suggestion: suggestions.suggestion,
      docsUrl: suggestions.docsUrl,
      relatedEndpoints: suggestions.relatedEndpoints,
    });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: unknown) {
    super(message, 400, details, {
      code: 'VALIDATION_ERROR',
      suggestion: 'Check the request body against the API documentation',
      docsUrl: 'https://docs.payos.ai/api/validation',
    });
    this.name = 'ValidationError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401, undefined, {
      code: 'UNAUTHORIZED',
      suggestion: 'Ensure you are providing a valid API key or JWT token in the Authorization header',
      docsUrl: 'https://docs.payos.ai/authentication',
      relatedEndpoints: [
        { method: 'POST', path: '/v1/auth/login', description: 'Login to get a JWT token' },
      ],
    });
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string = 'Forbidden') {
    super(message, 403, undefined, {
      code: 'FORBIDDEN',
      suggestion: 'Your account does not have permission to perform this action',
      docsUrl: 'https://docs.payos.ai/permissions',
    });
    this.name = 'ForbiddenError';
  }
}

export class InsufficientBalanceError extends ApiError {
  constructor(available: number, required: number) {
    super(`Insufficient balance: available ${available}, required ${required}`, 400, {
      available,
      required,
    }, {
      code: 'INSUFFICIENT_BALANCE',
      suggestion: 'Fund your wallet with additional USDC before making this payment',
      docsUrl: 'https://docs.payos.ai/wallets/funding',
      relatedEndpoints: [
        { method: 'POST', path: '/v1/wallets/:id/deposit', description: 'Deposit funds to wallet' },
        { method: 'POST', path: '/v1/wallets/:id/test-fund', description: 'Add test funds (sandbox only)' },
      ],
    });
    this.name = 'InsufficientBalanceError';
  }
}

export class QuoteExpiredError extends ApiError {
  constructor(quoteId: string, expiresAt: string) {
    super('Quote has expired', 400, { quoteId, expiresAt }, {
      code: 'QUOTE_EXPIRED',
      suggestion: 'Request a new quote and retry the transfer.',
    });
    this.name = 'QuoteExpiredError';
  }
}

/**
 * Bazaar extension validation failure (One-click Publish).
 *
 * Thrown by `apps/api/src/services/bazaar-extension.ts` when the extension
 * payload would be rejected by Coinbase's Bazaar indexer (description too
 * short/long, schema invalid, example doesn't match schema, etc.).
 *
 * `details` carries `{ field, reason }[]` so the publish dialog can render
 * a per-field error list without re-running the validators in the UI.
 */
export class BazaarValidationError extends ApiError {
  constructor(
    message: string,
    details: Array<{ field: string; reason: string }>
  ) {
    super(message, 400, details, {
      code: 'BAZAAR_VALIDATION_ERROR',
      suggestion: 'Fix the listed metadata fields and re-run validation before publishing.',
      docsUrl: 'https://docs.cdp.coinbase.com/x402/bazaar',
    });
    this.name = 'BazaarValidationError';
  }
}

/**
 * No on-chain payout wallet bound for a (tenant, account, network) tuple.
 *
 * Published x402 endpoints need a real EVM payTo address — Sly's default
 * `internal://payos/...` placeholder isn't usable on agentic.market. Either
 * the caller must bind one (`POST /v1/x402/wallets`) or auto-provision must
 * be enabled at the tenant level.
 */
export class WalletRequiredError extends ApiError {
  constructor(network: string, accountId: string) {
    super(`No payout wallet bound for account ${accountId} on ${network}`, 400, {
      network,
      accountId,
    }, {
      code: 'WALLET_REQUIRED',
      suggestion: 'Bind an on-chain wallet for this account+network or enable auto-provisioning before publishing.',
      docsUrl: 'https://docs.payos.ai/x402/publish',
      relatedEndpoints: [
        { method: 'POST', path: '/v1/x402/wallets', description: 'Bind a payout wallet' },
      ],
    });
    this.name = 'WalletRequiredError';
  }
}

/**
 * Slug already used by another endpoint in the same tenant.
 *
 * Service slugs are the path component of the gateway URL
 * (`{tenant.slug}.x402.getsly.ai/{service_slug}`) and must be unique per
 * tenant — see the `idx_x402_endpoints_tenant_service_slug` partial index.
 */
export class SlugConflictError extends ApiError {
  constructor(slug: string) {
    super(`Service slug '${slug}' is already in use by another endpoint`, 409, { slug }, {
      code: 'SLUG_CONFLICT',
      suggestion: 'Pick a different service_slug — it must be unique within your tenant.',
    });
    this.name = 'SlugConflictError';
  }
}

export class LimitExceededError extends ApiError {
  constructor(
    limitType: string,
    limit: number,
    requested: number,
    current?: number
  ) {
    super(`${limitType} limit exceeded`, 403, {
      limitType,
      limit,
      requested,
      current,
    }, {
      code: 'LIMIT_EXCEEDED',
      suggestion: `Your ${limitType} limit is ${limit}. Upgrade your verification tier for higher limits.`,
      docsUrl: 'https://docs.payos.ai/limits',
      relatedEndpoints: [
        { method: 'GET', path: '/v1/limits', description: 'View your current limits' },
        { method: 'GET', path: '/v1/verification-tiers', description: 'View available tiers' },
      ],
    });
    this.name = 'LimitExceededError';
  }
}

// ============================================
// Story 51.2: Error Suggestions Helper
// ============================================

function getNotFoundSuggestions(resource: string, _id?: string): {
  suggestion: string;
  docsUrl?: string;
  relatedEndpoints?: RelatedEndpoint[];
} {
  const resourceLower = resource.toLowerCase();

  switch (resourceLower) {
    case 'account':
    case 'parent account':
      return {
        suggestion: 'Create an account first using POST /v1/accounts',
        docsUrl: 'https://docs.payos.ai/accounts/create',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/accounts', description: 'Create a new account' },
          { method: 'POST', path: '/v1/accounts/onboard', description: 'Onboard a new entity' },
          { method: 'GET', path: '/v1/accounts', description: 'List all accounts' },
        ],
      };

    case 'agent':
      return {
        suggestion: 'Create an agent first using POST /v1/agents',
        docsUrl: 'https://docs.payos.ai/agents/create',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/agents', description: 'Create a new agent' },
          { method: 'GET', path: '/v1/agents', description: 'List all agents' },
        ],
      };

    case 'wallet':
      return {
        suggestion: 'Create a wallet first using POST /v1/wallets',
        docsUrl: 'https://docs.payos.ai/wallets/create',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/wallets', description: 'Create a new wallet' },
          { method: 'GET', path: '/v1/wallets', description: 'List all wallets' },
        ],
      };

    case 'transfer':
      return {
        suggestion: 'The transfer may have been cancelled or does not exist',
        docsUrl: 'https://docs.payos.ai/transfers',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/transfers', description: 'Create a new transfer' },
          { method: 'GET', path: '/v1/transfers', description: 'List all transfers' },
        ],
      };

    case 'stream':
      return {
        suggestion: 'Create a payment stream first using POST /v1/streams',
        docsUrl: 'https://docs.payos.ai/streams/create',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/streams', description: 'Create a new stream' },
          { method: 'GET', path: '/v1/streams', description: 'List all streams' },
        ],
      };

    case 'mandate':
      return {
        suggestion: 'Create a mandate first using POST /v1/ap2/mandates',
        docsUrl: 'https://docs.payos.ai/ap2/mandates',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/ap2/mandates', description: 'Create a new mandate' },
          { method: 'GET', path: '/v1/ap2/mandates', description: 'List all mandates' },
        ],
      };

    case 'connected account':
    case 'handler':
      return {
        suggestion: 'Connect a payment handler first in Settings → Payment Handlers',
        docsUrl: 'https://docs.payos.ai/connected-accounts',
        relatedEndpoints: [
          { method: 'POST', path: '/v1/organization/connected-accounts', description: 'Connect a payment handler' },
          { method: 'GET', path: '/v1/organization/connected-accounts', description: 'List connected accounts' },
        ],
      };

    default:
      return {
        suggestion: `The ${resourceLower} does not exist or you do not have access to it`,
        docsUrl: 'https://docs.payos.ai',
      };
  }
}

/**
 * Story 51.2: Enhanced error handler with actionable suggestions
 */
export function errorHandler(err: Error, c: Context) {
  console.error('Error:', err);

  if (err instanceof ApiError) {
    // Story 51.2: Build enhanced error response
    const response: EnhancedErrorResponse = {
      error: {
        code: err.code,
        message: err.message,
      },
    };

    // Add optional fields if present
    if (err.suggestion) {
      response.error.suggestion = err.suggestion;
    }
    if (err.docsUrl) {
      response.error.docs_url = err.docsUrl;
    }
    if (err.relatedEndpoints && err.relatedEndpoints.length > 0) {
      response.error.related_endpoints = err.relatedEndpoints;
    }
    if (err.details) {
      response.error.details = err.details;
    }

    return c.json(response, err.statusCode as 400 | 401 | 403 | 404 | 500);
  }

  // Supabase errors - enhance with suggestions
  if ('code' in err && typeof (err as any).code === 'string') {
    const supabaseErr = err as any;

    if (supabaseErr.code === 'PGRST116') {
      const response: EnhancedErrorResponse = {
        error: {
          code: 'RESOURCE_NOT_FOUND',
          message: 'Resource not found',
          suggestion: 'Check that the resource ID is correct and belongs to your tenant',
        },
      };
      return c.json(response, 404);
    }

    if (supabaseErr.code === '23505') {
      const response: EnhancedErrorResponse = {
        error: {
          code: 'DUPLICATE_ENTRY',
          message: 'Duplicate entry',
          suggestion: 'A resource with this identifier already exists. Use a different identifier or update the existing resource.',
          details: supabaseErr.message,
        },
      };
      return c.json(response, 409);
    }

    if (supabaseErr.code === '23503') {
      const response: EnhancedErrorResponse = {
        error: {
          code: 'REFERENCED_RESOURCE_NOT_FOUND',
          message: 'Referenced resource not found',
          suggestion: 'Ensure the referenced resource (account, wallet, etc.) exists before creating this resource.',
          details: supabaseErr.message,
        },
      };
      return c.json(response, 400);
    }
  }

  // Zod validation errors
  if (err.name === 'ZodError') {
    const response: EnhancedErrorResponse = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        suggestion: 'Check the request body against the API documentation',
        docs_url: 'https://docs.payos.ai/api/validation',
        details: (err as any).errors || (err as any).issues,
      },
    };
    return c.json(response, 400);
  }

  // Generic error
  const response: EnhancedErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
      suggestion: 'If this error persists, please contact support',
    },
  };
  return c.json(response, 500);
}


