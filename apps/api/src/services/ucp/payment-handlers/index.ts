/**
 * UCP Payment Handlers Registry
 *
 * Hybrid registry: DB-driven handlers + code plugins.
 * - DB rows with integration_mode='demo' or 'webhook' get a generic DatabaseHandler
 * - DB rows with integration_mode='custom' delegate to a registered code handler
 * - Code-only handlers can still be registered directly (backwards compat)
 *
 * @see Phase 2: Payment Handlers Architecture
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  PaymentHandler,
  HandlerRegistration,
  AcquireInstrumentRequest,
  AcquireInstrumentResult,
  ProcessPaymentRequest,
  ProcessPaymentResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  PaymentStatus,
} from './types.js';
import { payosHandler, clearPayosStores } from './sly.js';
import { createDatabaseHandler, type PaymentHandlerRow } from './database-handler.js';

// Re-export types
export * from './types.js';
export type { PaymentHandlerRow } from './database-handler.js';

// =============================================================================
// Handler Registry
// =============================================================================

const handlers = new Map<string, PaymentHandler>();

/** Code-only plugins registered for 'custom' mode delegation */
const customPlugins = new Map<string, PaymentHandler>();

/** Cached DB handler rows for profile generation */
let dbHandlerRows: PaymentHandlerRow[] = [];

/**
 * Register a payment handler (code handler)
 */
export function registerHandler(handler: PaymentHandler): void {
  if (handlers.has(handler.id)) {
    console.warn(`[Payment Handlers] Handler ${handler.id} is being re-registered`);
  }
  handlers.set(handler.id, handler);
  console.log(`[Payment Handlers] Registered handler: ${handler.id} (${handler.name})`);
}

/**
 * Register a custom code plugin (for 'custom' integration_mode handlers)
 */
export function registerCustomPlugin(handlerId: string, handler: PaymentHandler): void {
  customPlugins.set(handlerId, handler);
  console.log(`[Payment Handlers] Registered custom plugin for: ${handlerId}`);
}

/**
 * Get a handler by ID
 */
export function getHandler(handlerId: string): PaymentHandler | undefined {
  return handlers.get(handlerId);
}

/**
 * Get all registered handlers
 */
export function getAllHandlers(): PaymentHandler[] {
  return Array.from(handlers.values());
}

/**
 * Get handler registrations (for profile/discovery)
 */
export function getHandlerRegistrations(): HandlerRegistration[] {
  return getAllHandlers().map((h) => ({
    id: h.id,
    name: h.name,
    version: h.version,
    supportedTypes: h.supportedTypes,
    supportedCurrencies: h.supportedCurrencies,
  }));
}

/**
 * Get cached DB handler rows (for profile generation)
 */
export function getDBHandlerRows(): PaymentHandlerRow[] {
  return dbHandlerRows;
}

/**
 * Check if a handler is registered
 */
export function hasHandler(handlerId: string): boolean {
  return handlers.has(handlerId);
}

// =============================================================================
// Handler Operations (Convenience wrappers)
// =============================================================================

/**
 * Acquire a payment instrument using a specific handler
 */
export async function acquireInstrument(
  handlerId: string,
  request: AcquireInstrumentRequest
): Promise<AcquireInstrumentResult> {
  const handler = getHandler(handlerId);
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'HANDLER_NOT_FOUND',
        message: `Payment handler not found: ${handlerId}`,
        retryable: false,
      },
    };
  }
  return handler.acquireInstrument(request);
}

/**
 * Process a payment using a specific handler
 */
export async function processPayment(
  handlerId: string,
  request: ProcessPaymentRequest
): Promise<ProcessPaymentResult> {
  const handler = getHandler(handlerId);
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'HANDLER_NOT_FOUND',
        message: `Payment handler not found: ${handlerId}`,
        retryable: false,
      },
    };
  }
  return handler.processPayment(request);
}

/**
 * Refund a payment using a specific handler
 */
export async function refundPayment(
  handlerId: string,
  request: RefundPaymentRequest
): Promise<RefundPaymentResult> {
  const handler = getHandler(handlerId);
  if (!handler) {
    return {
      success: false,
      error: {
        code: 'HANDLER_NOT_FOUND',
        message: `Payment handler not found: ${handlerId}`,
        retryable: false,
      },
    };
  }
  return handler.refundPayment(request);
}

/**
 * Get payment status from a specific handler
 */
export async function getPaymentStatus(
  handlerId: string,
  paymentId: string
): Promise<PaymentStatus> {
  const handler = getHandler(handlerId);
  if (!handler) {
    throw new Error(`Payment handler not found: ${handlerId}`);
  }
  return handler.getPaymentStatus(paymentId);
}

// =============================================================================
// Handler Selection
// =============================================================================

/**
 * Find handlers that support a specific type and currency
 */
export function findHandlers(options: {
  type?: string;
  currency?: string;
}): PaymentHandler[] {
  const { type, currency } = options;

  return getAllHandlers().filter((handler) => {
    if (type && !handler.supportedTypes.includes(type)) {
      return false;
    }
    if (currency && !handler.supportedCurrencies.includes(currency)) {
      return false;
    }
    return true;
  });
}

/**
 * Get the default handler for a type and currency
 */
export function getDefaultHandler(options: {
  type?: string;
  currency?: string;
}): PaymentHandler | undefined {
  const matching = findHandlers(options);
  return matching.find((h) => h.id === 'sly_latam') || matching[0];
}

// =============================================================================
// DB Loading
// =============================================================================

/**
 * Load handlers from the payment_handlers DB table.
 * Creates DatabaseHandler instances for each active row.
 * 'custom' mode rows delegate to registered code plugins.
 */
export async function loadHandlersFromDB(supabase: SupabaseClient): Promise<void> {
  const { data: rows, error } = await supabase
    .from('payment_handlers')
    .select('*')
    .eq('status', 'active');

  if (error) {
    console.error('[Payment Handlers] Failed to load from DB:', error.message);
    return;
  }

  if (!rows || rows.length === 0) {
    console.log('[Payment Handlers] No active handlers in DB, using code-only handlers');
    return;
  }

  // Cache rows for profile generation
  dbHandlerRows = rows as PaymentHandlerRow[];

  for (const row of rows as PaymentHandlerRow[]) {
    const customPlugin = customPlugins.get(row.id);
    const handler = createDatabaseHandler(row, supabase, customPlugin);
    handlers.set(row.id, handler);
    console.log(`[Payment Handlers] Loaded from DB: ${row.id} (${row.integration_mode})`);
  }

  console.log(`[Payment Handlers] Loaded ${rows.length} handler(s) from DB`);
}

/**
 * Refresh handlers from DB (call without restart)
 */
export async function refreshHandlers(supabase: SupabaseClient): Promise<void> {
  // Keep custom plugins, clear DB-loaded handlers
  const pluginIds = new Set(customPlugins.keys());
  for (const [id] of handlers) {
    if (!pluginIds.has(id)) {
      handlers.delete(id);
    }
  }
  await loadHandlersFromDB(supabase);
}

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize built-in handlers (code-only, before DB is available)
 */
export function initializeHandlers(): void {
  // Register PayOS as a custom plugin for 'custom' mode delegation
  registerCustomPlugin('sly_latam', payosHandler);

  // Also register it directly so it works before DB loads
  registerHandler(payosHandler);

  console.log(`[Payment Handlers] Initialized ${handlers.size} handler(s)`);
}

/**
 * Clear all handlers and stores (for testing)
 */
export function clearHandlers(): void {
  handlers.clear();
  customPlugins.clear();
  dbHandlerRows = [];
  clearPayosStores();
}

// Auto-initialize on module load
initializeHandlers();
