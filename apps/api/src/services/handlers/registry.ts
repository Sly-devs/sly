/**
 * Payment Handler Registry
 * Epic 48, Story 48.4: Registry for managing payment handlers
 *
 * Handles:
 * - Creating handler instances from credentials
 * - Routing payments to correct handler
 * - Handler capability queries
 */

import { createClient } from '../../db/client.js';
import { deserializeAndDecrypt } from '../credential-vault/index.js';
import type {
  PaymentHandler,
  PaymentMethod,
  Currency,
  StripeCredentials,
  PayPalCredentials,
  CircleCredentials,
  PayOSNativeCredentials,
} from './interface.js';
import { createStripeHandler } from './stripe.js';
import { createPayPalHandler } from './paypal.js';
import { createCircleHandler } from './circle.js';

export type HandlerType = 'stripe' | 'paypal' | 'circle' | 'sly_native' | 'visa_vic' | 'mastercard_agent_pay';

interface ConnectedAccount {
  id: string;
  tenant_id: string;
  handler_type: HandlerType;
  handler_name: string;
  credentials_encrypted: string;
  status: string;
}

/**
 * Create a handler instance from a connected account
 */
export function createHandlerFromAccount(
  account: ConnectedAccount,
  credentials: Record<string, unknown>
): PaymentHandler | null {
  switch (account.handler_type) {
    case 'stripe':
      return createStripeHandler(credentials as StripeCredentials);

    case 'paypal':
      return createPayPalHandler(credentials as PayPalCredentials);

    case 'circle':
      return createCircleHandler(credentials as CircleCredentials);

    case 'sly_native':
      // TODO: Implement PayOS native handler (Pix/SPEI)
      console.warn('PayOS Native handler not yet implemented');
      return null;

    case 'visa_vic':
      // Epic 53: Visa VIC handler
      // Card network handlers use different interface - return null for payment handler
      // Use VisaVICClient directly from @sly/cards package
      console.log('Visa VIC configured - use @sly/cards for operations');
      return null;

    case 'mastercard_agent_pay':
      // Epic 53: Mastercard Agent Pay handler
      // Card network handlers use different interface - return null for payment handler
      // Use MastercardAgentPayClient directly from @sly/cards package
      console.log('Mastercard Agent Pay configured - use @sly/cards for operations');
      return null;

    default:
      console.error(`Unknown handler type: ${account.handler_type}`);
      return null;
  }
}

/**
 * Get a handler for a tenant by handler type
 */
export async function getHandler(
  tenantId: string,
  handlerType: HandlerType
): Promise<PaymentHandler | null> {
  const supabase = createClient();

  const { data: account, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('handler_type', handlerType)
    .eq('status', 'active')
    .single();

  if (error || !account) {
    console.warn(`No active ${handlerType} handler found for tenant ${tenantId}`);
    return null;
  }

  // Decrypt credentials
  let credentials: Record<string, unknown>;
  try {
    credentials = deserializeAndDecrypt(account.credentials_encrypted);
  } catch (decryptError) {
    console.error(`Failed to decrypt credentials for account ${account.id}:`, decryptError);
    return null;
  }

  return createHandlerFromAccount(account, credentials);
}

/**
 * Get all active handlers for a tenant
 */
export async function getActiveHandlers(
  tenantId: string
): Promise<Array<{ type: HandlerType; handler: PaymentHandler }>> {
  const supabase = createClient();

  const { data: accounts, error } = await supabase
    .from('connected_accounts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  if (error || !accounts) {
    return [];
  }

  const handlers: Array<{ type: HandlerType; handler: PaymentHandler }> = [];

  for (const account of accounts) {
    try {
      const credentials = deserializeAndDecrypt(account.credentials_encrypted);
      const handler = createHandlerFromAccount(account, credentials);
      if (handler) {
        handlers.push({ type: account.handler_type, handler });
      }
    } catch (err) {
      console.error(`Failed to initialize handler for account ${account.id}:`, err);
    }
  }

  return handlers;
}

/**
 * Find the best handler for a given payment method and currency
 */
export async function findHandler(
  tenantId: string,
  method: PaymentMethod,
  currency: Currency
): Promise<PaymentHandler | null> {
  const handlers = await getActiveHandlers(tenantId);

  for (const { handler } of handlers) {
    if (handler.supportsMethod(method) && handler.supportsCurrency(currency)) {
      return handler;
    }
  }

  return null;
}

/**
 * Get handler capabilities summary for a tenant
 */
export async function getHandlerCapabilities(tenantId: string): Promise<{
  supportedMethods: PaymentMethod[];
  supportedCurrencies: Currency[];
  handlers: Array<{
    type: HandlerType;
    name: string;
    methods: PaymentMethod[];
    currencies: Currency[];
  }>;
}> {
  const handlers = await getActiveHandlers(tenantId);

  const allMethods = new Set<PaymentMethod>();
  const allCurrencies = new Set<Currency>();
  const handlerDetails: Array<{
    type: HandlerType;
    name: string;
    methods: PaymentMethod[];
    currencies: Currency[];
  }> = [];

  for (const { type, handler } of handlers) {
    const methods = handler.capabilities.supportedMethods;
    const currencies = handler.capabilities.supportedCurrencies;

    methods.forEach((m) => allMethods.add(m));
    currencies.forEach((c) => allCurrencies.add(c));

    handlerDetails.push({
      type,
      name: handler.name,
      methods,
      currencies,
    });
  }

  return {
    supportedMethods: Array.from(allMethods),
    supportedCurrencies: Array.from(allCurrencies),
    handlers: handlerDetails,
  };
}

/**
 * Check if tenant has any active handlers
 */
export async function hasActiveHandlers(tenantId: string): Promise<boolean> {
  const supabase = createClient();

  const { count, error } = await supabase
    .from('connected_accounts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  return !error && (count || 0) > 0;
}

export default {
  createHandlerFromAccount,
  getHandler,
  getActiveHandlers,
  findHandler,
  getHandlerCapabilities,
  hasActiveHandlers,
};
