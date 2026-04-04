/**
 * UCP Profile Service
 *
 * Generates the UCP profile published at /.well-known/ucp
 * Compliant with Google/Shopify Universal Commerce Protocol spec.
 *
 * Payment handlers are now loaded dynamically from the payment_handlers DB table.
 * Falls back to hardcoded PayOS handler when DB rows are not available.
 *
 * @see Story 43.1: UCP Profile Endpoint
 * @see https://ucp.dev/specification/overview/
 */

import type {
  UCPProfile,
  UCPService,
  UCPCapability,
  UCPPaymentHandler,
  UCPCorridor,
  UCPSigningKey,
} from './types.js';
import { getSigningKey, getAllSigningKeys, initializeSigningKey } from './signing.js';
import { getDBHandlerRows } from './payment-handlers/index.js';
import type { PaymentHandlerRow } from './payment-handlers/index.js';
import { createClient } from '../../db/client.js';

// =============================================================================
// Configuration
// =============================================================================

const UCP_VERSION = '2026-01-11';
const PAYOS_VERSION = '1.0.0';

// Base URL for API (configurable via env)
const getBaseUrl = (): string => {
  return process.env.PAYOS_API_URL || process.env.API_BASE_URL || 'https://api.payos.com';
};

const getDocsUrl = (): string => {
  return process.env.PAYOS_DOCS_URL || 'https://docs.payos.com';
};

// =============================================================================
// Capability Definitions (UCP Standard Naming)
// =============================================================================

/**
 * Core UCP capabilities using dev.ucp.* namespace
 * @see https://ucp.dev/specification/overview/#capabilities
 */
const UCP_CORE_CAPABILITIES: UCPCapability[] = [
  {
    name: 'dev.ucp.shopping.checkout',
    version: UCP_VERSION,
    spec: 'https://ucp.dev/specification/checkout/',
    schema: `${getBaseUrl()}/ucp/schemas/checkout.json`,
  },
  {
    name: 'dev.ucp.shopping.fulfillment',
    version: UCP_VERSION,
    spec: 'https://ucp.dev/specification/fulfillment/',
    schema: `${getBaseUrl()}/ucp/schemas/fulfillment.json`,
    extends: 'dev.ucp.shopping.checkout',
  },
  {
    name: 'dev.ucp.shopping.order',
    version: UCP_VERSION,
    spec: 'https://ucp.dev/specification/order/',
    schema: `${getBaseUrl()}/ucp/schemas/order.json`,
  },
];

/**
 * PayOS-specific payment handler capabilities
 * These extend the core UCP checkout with payment processing
 */
const PAYOS_PAYMENT_CAPABILITIES: UCPCapability[] = [
  {
    name: 'com.payos.settlement.quote',
    version: UCP_VERSION,
    spec: `${getDocsUrl()}/ucp/capabilities/quote`,
    schema: `${getBaseUrl()}/ucp/schemas/quote.json`,
  },
  {
    name: 'com.payos.settlement.transfer',
    version: UCP_VERSION,
    spec: `${getDocsUrl()}/ucp/capabilities/settlement`,
    schema: `${getBaseUrl()}/ucp/schemas/transfer.json`,
  },
  {
    name: 'com.payos.settlement.status',
    version: UCP_VERSION,
    spec: `${getDocsUrl()}/ucp/capabilities/status`,
    schema: `${getBaseUrl()}/ucp/schemas/status.json`,
  },
  {
    name: 'com.payos.merchant_catalog',
    version: UCP_VERSION,
    spec: `${getDocsUrl()}/ucp/capabilities/merchant-catalog`,
    schema: `${getBaseUrl()}/ucp/schemas/merchant_catalog.json`,
  },
];

/**
 * Combined capabilities list
 */
const getAllCapabilities = (): UCPCapability[] => [
  ...UCP_CORE_CAPABILITIES,
  ...PAYOS_PAYMENT_CAPABILITIES,
];

// =============================================================================
// Hardcoded Fallback Corridors (used when DB is not loaded)
// =============================================================================

const PAYOS_CORRIDORS: UCPCorridor[] = [
  {
    id: 'usd-brl-pix',
    name: 'USD to Brazil (Pix)',
    source_currency: 'USD',
    destination_currency: 'BRL',
    destination_country: 'BR',
    rail: 'pix',
    estimated_settlement: '< 1 minute',
  },
  {
    id: 'usdc-brl-pix',
    name: 'USDC to Brazil (Pix)',
    source_currency: 'USDC',
    destination_currency: 'BRL',
    destination_country: 'BR',
    rail: 'pix',
    estimated_settlement: '< 1 minute',
  },
  {
    id: 'usd-mxn-spei',
    name: 'USD to Mexico (SPEI)',
    source_currency: 'USD',
    destination_currency: 'MXN',
    destination_country: 'MX',
    rail: 'spei',
    estimated_settlement: '< 30 minutes',
  },
  {
    id: 'usdc-mxn-spei',
    name: 'USDC to Mexico (SPEI)',
    source_currency: 'USDC',
    destination_currency: 'MXN',
    destination_country: 'MX',
    rail: 'spei',
    estimated_settlement: '< 30 minutes',
  },
];

// =============================================================================
// Dynamic Handler → UCPPaymentHandler conversion
// =============================================================================

function dbRowToUCPHandler(row: PaymentHandlerRow): UCPPaymentHandler {
  const meta = row.profile_metadata || {};
  const corridors = ((meta.corridors as UCPCorridor[]) || []);

  return {
    id: row.id,
    name: row.name,
    version: row.version,
    spec: (meta.spec as string) || '',
    config_schema: (meta.config_schema as string) || '',
    instrument_schemas: (meta.instrument_schemas as string[]) || [],
    config: {
      supported_currencies: row.supported_currencies,
      supported_corridors: corridors,
    },
  };
}

// =============================================================================
// Payment Handler Definition (dynamic with fallback)
// =============================================================================

const getPaymentHandlers = (): UCPPaymentHandler[] => {
  const dbRows = getDBHandlerRows();

  // If we have DB rows, use them
  if (dbRows.length > 0) {
    return dbRows.map(dbRowToUCPHandler);
  }

  // Fallback: hardcoded PayOS handler
  const baseUrl = getBaseUrl();
  const docsUrl = getDocsUrl();

  return [{
    id: 'sly_latam',
    name: 'com.payos.latam_settlement',
    version: UCP_VERSION,
    spec: `${docsUrl}/ucp/handlers/payment`,
    config_schema: `${baseUrl}/ucp/schemas/handler_config.json`,
    instrument_schemas: [
      `${baseUrl}/ucp/schemas/pix_instrument.json`,
      `${baseUrl}/ucp/schemas/spei_instrument.json`,
    ],
    config: {
      supported_currencies: ['USD', 'USDC', 'BRL', 'MXN'],
      supported_corridors: PAYOS_CORRIDORS,
    },
  }];
};

// =============================================================================
// Service Definitions
// =============================================================================

const getServices = (): Record<string, UCPService> => {
  const baseUrl = getBaseUrl();
  const docsUrl = getDocsUrl();

  return {
    'dev.ucp.shopping.checkout': {
      version: UCP_VERSION,
      spec: 'https://ucp.dev/specification/checkout/',
      rest: {
        schema: `${baseUrl}/ucp/openapi.json`,
        endpoint: `${baseUrl}/v1/ucp/checkouts`,
      },
    },
    'dev.ucp.shopping.order': {
      version: UCP_VERSION,
      spec: 'https://ucp.dev/specification/order/',
      rest: {
        schema: `${baseUrl}/ucp/openapi.json`,
        endpoint: `${baseUrl}/v1/ucp/orders`,
      },
    },
    'com.payos.settlement': {
      version: UCP_VERSION,
      spec: `${docsUrl}/ucp/settlement`,
      rest: {
        schema: `${baseUrl}/ucp/openapi.json`,
        endpoint: `${baseUrl}/v1/ucp`,
      },
    },
    'com.payos.merchant_catalog': {
      version: UCP_VERSION,
      spec: `${docsUrl}/ucp/merchant-catalog`,
      rest: {
        schema: `${baseUrl}/ucp/openapi.json`,
        endpoint: `${baseUrl}/v1/ucp/merchants`,
      },
    },
  };
};

// =============================================================================
// Signing Keys (for webhook verification)
// =============================================================================

/**
 * Get signing keys from the signing service
 * These are real EC P-256 keys used for detached JWT signatures
 */
const getSigningKeys = (): UCPSigningKey[] => {
  // Initialize signing key if not already done
  initializeSigningKey();

  // Get all keys (current + rotated for verification)
  return getAllSigningKeys();
};

// =============================================================================
// Profile Generation
// =============================================================================

/**
 * Generate the complete UCP profile for PayOS
 *
 * The profile is published at /.well-known/ucp and enables:
 * - Discovery by Google AI agents (Gemini, Search AI Mode)
 * - Capability negotiation with platforms
 * - Webhook signature verification via signing_keys
 *
 * Payment handlers are now loaded dynamically from the DB.
 *
 * @see https://ucp.dev/specification/overview/#profile-structure
 */
export async function generateUCPProfile(): Promise<UCPProfile> {
  const signingKeys = getSigningKeys();
  const capabilities = getAllCapabilities();

  const profile: UCPProfile = {
    ucp: {
      version: UCP_VERSION,
      services: getServices(),
      capabilities,
    },
    payment: {
      handlers: getPaymentHandlers(),
    },
    // Always include signing keys - they're generated if not configured
    signing_keys: signingKeys,
  };

  // Load merchant catalog for discovery (all tenants with pos_provider)
  try {
    const supabase = createClient();
    const { data: merchants } = await supabase
      .from('accounts')
      .select('id, name, currency, metadata')
      .not('metadata->pos_provider', 'is', null)
      .order('name')
      .limit(100);

    if (merchants && merchants.length > 0) {
      (profile as any).x_catalog = {
        description: 'Merchant catalog preview (use com.payos.merchant_catalog service for full API)',
        service: 'com.payos.merchant_catalog',
        merchants: merchants.map((m: any) => ({
          id: m.id,
          name: m.name,
          merchant_id: m.metadata?.invu_merchant_id,
          type: m.metadata?.merchant_type,
          country: m.metadata?.country,
          city: m.metadata?.city,
          currency: m.currency,
          description: m.metadata?.description,
          pos_provider: m.metadata?.pos_provider,
          catalog: Array.isArray(m.metadata?.catalog) ? m.metadata.catalog : [],
        })),
      };
    }
  } catch (err: any) {
    // Non-fatal: discovery still works without merchants
    console.error('[UCP Profile] Failed to load merchants:', err.message);
  }

  return profile;
}

/**
 * Get all capabilities (core UCP + PayOS payment)
 */
export function getCapabilities(): UCPCapability[] {
  return getAllCapabilities();
}

/**
 * Get core UCP capabilities only
 */
export function getCoreCapabilities(): UCPCapability[] {
  return UCP_CORE_CAPABILITIES;
}

/**
 * Get PayOS payment capabilities only
 */
export function getPaymentCapabilities(): UCPCapability[] {
  return PAYOS_PAYMENT_CAPABILITIES;
}

/**
 * Get supported corridors (from DB or fallback)
 */
export function getCorridors(): UCPCorridor[] {
  const dbRows = getDBHandlerRows();
  if (dbRows.length > 0) {
    // Aggregate corridors from all DB handlers
    const corridors: UCPCorridor[] = [];
    for (const row of dbRows) {
      const meta = row.profile_metadata || {};
      const rowCorridors = (meta.corridors as UCPCorridor[]) || [];
      corridors.push(...rowCorridors);
    }
    return corridors;
  }
  return PAYOS_CORRIDORS;
}

/**
 * Get payment handler info
 */
export function getPaymentHandlerInfo(): UCPPaymentHandler {
  return getPaymentHandlers()[0];
}

/**
 * Check if a corridor is supported
 */
export function isCorridorSupported(
  sourceCurrency: string,
  destinationCurrency: string,
  rail: string
): boolean {
  return getCorridors().some(
    (c) =>
      c.source_currency === sourceCurrency &&
      c.destination_currency === destinationCurrency &&
      c.rail === rail
  );
}

/**
 * Get corridor by ID
 */
export function getCorridorById(corridorId: string): UCPCorridor | undefined {
  return getCorridors().find((c) => c.id === corridorId);
}

/**
 * Get UCP version
 */
export function getUCPVersion(): string {
  return UCP_VERSION;
}

/**
 * Get PayOS version
 */
export function getPayOSVersion(): string {
  return PAYOS_VERSION;
}
