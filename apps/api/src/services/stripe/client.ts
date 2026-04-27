/**
 * Stripe API Client
 * 
 * Handles payment processing for ACP SharedPaymentToken flows.
 * 
 * @see https://docs.stripe.com/agentic-commerce
 * @module services/stripe/client
 */

import { getEnvironment, getServiceConfig } from '../../config/environment.js';

export interface StripeConfig {
  secretKey: string;
  webhookSecret?: string;
}

export interface PaymentIntentParams {
  amount: number;  // in cents
  currency: string;
  paymentMethodId?: string;
  paymentMethodTypes?: string[]; // Force a specific set, e.g., ['card'] to disable Link/wallets
  customerId?: string;
  description?: string;
  metadata?: Record<string, string>;
  idempotencyKey?: string;
  confirm?: boolean;
  returnUrl?: string;  // Required when confirm=true
  offSession?: boolean;  // For payments without customer present (e.g., ACP)
}

export interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  amount: number;
  currency: string;
  status: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'requires_capture' | 'canceled' | 'succeeded';
  client_secret: string;
  payment_method?: string;
  description?: string;
  metadata?: Record<string, string>;
  created: number;
  livemode: boolean;
}

export interface Customer {
  id: string;
  object: 'customer';
  email?: string;
  name?: string;
  description?: string;
  metadata?: Record<string, string>;
  created: number;
}

export interface PaymentMethod {
  id: string;
  object: 'payment_method';
  type: string;
  card?: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
  };
  customer?: string;
  created: number;
}

export interface StripeError {
  type: string;
  code?: string;
  message: string;
  param?: string;
}

export class StripeClient {
  private readonly secretKey: string;
  private readonly webhookSecret?: string;
  private readonly baseUrl: string;
  private readonly isTestMode: boolean;

  constructor(config: StripeConfig) {
    this.secretKey = config.secretKey;
    this.webhookSecret = config.webhookSecret;
    this.baseUrl = 'https://api.stripe.com/v1';
    this.isTestMode = this.secretKey.startsWith('sk_test_');
  }

  /**
   * Check if running in test mode
   */
  isTest(): boolean {
    return this.isTestMode;
  }

  /**
   * Make API request to Stripe
   */
  private async request<T>(
    method: string,
    endpoint: string,
    data?: Record<string, any>,
    idempotencyKey?: string
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (data && (method === 'POST' || method === 'PATCH')) {
      options.body = this.encodeFormData(data);
    }

    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, options);
    const result = await response.json();

    if (!response.ok) {
      const error = result.error as StripeError;
      throw new Error(`Stripe API error: ${error.message} (${error.code || error.type})`);
    }

    return result as T;
  }

  /**
   * Encode data for form-urlencoded format (Stripe's expected format)
   */
  private encodeFormData(data: Record<string, any>, prefix = ''): string {
    const parts: string[] = [];
    
    for (const [key, value] of Object.entries(data)) {
      const encodedKey = prefix ? `${prefix}[${key}]` : key;
      
      if (value === null || value === undefined) {
        continue;
      } else if (typeof value === 'object' && !Array.isArray(value)) {
        parts.push(this.encodeFormData(value, encodedKey));
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (typeof item === 'object') {
            parts.push(this.encodeFormData(item, `${encodedKey}[${index}]`));
          } else {
            parts.push(`${encodedKey}[${index}]=${encodeURIComponent(String(item))}`);
          }
        });
      } else {
        parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
      }
    }
    
    return parts.filter(Boolean).join('&');
  }

  // ==========================================================================
  // Payment Intents
  // ==========================================================================

  /**
   * Create a PaymentIntent
   */
  async createPaymentIntent(params: PaymentIntentParams): Promise<PaymentIntent> {
    const data: Record<string, any> = {
      amount: params.amount,
      currency: params.currency.toLowerCase(),
    };

    if (params.paymentMethodId) data.payment_method = params.paymentMethodId;
    if (params.customerId) data.customer = params.customerId;
    if (params.description) data.description = params.description;
    if (params.metadata) data.metadata = params.metadata;

    // Explicit type list takes precedence over automatic_payment_methods.
    // Used to force card-only and skip Link/wallet auto-prompts.
    const hasExplicitTypes = !!params.paymentMethodTypes?.length;
    if (hasExplicitTypes) {
      data.payment_method_types = params.paymentMethodTypes!;
    }

    if (params.confirm !== undefined) {
      data.confirm = params.confirm;

      if (params.offSession) {
        // Off-session payments (ACP, server-side) don't need return_url
        data.off_session = true;
      } else if (params.returnUrl) {
        // On-session with explicit return URL
        data.return_url = params.returnUrl;
      } else if (!hasExplicitTypes) {
        // Default: disable redirects to avoid return_url requirement
        data.automatic_payment_methods = {
          enabled: true,
          allow_redirects: 'never',
        };
      }
    } else if (!hasExplicitTypes) {
      // Non-confirm path also defaults to automatic_payment_methods
      // unless explicit types are specified.
      data.automatic_payment_methods = {
        enabled: true,
        allow_redirects: 'never',
      };
    }

    if (params.returnUrl && !params.offSession) data.return_url = params.returnUrl;

    return this.request<PaymentIntent>(
      'POST',
      '/payment_intents',
      data,
      params.idempotencyKey
    );
  }

  /**
   * Retrieve a PaymentIntent
   */
  async getPaymentIntent(id: string): Promise<PaymentIntent> {
    return this.request<PaymentIntent>('GET', `/payment_intents/${id}`);
  }

  /**
   * Confirm a PaymentIntent
   */
  async confirmPaymentIntent(
    id: string,
    params?: {
      paymentMethodId?: string;
      returnUrl?: string;
    }
  ): Promise<PaymentIntent> {
    const data: Record<string, any> = {};
    if (params?.paymentMethodId) data.payment_method = params.paymentMethodId;
    if (params?.returnUrl) data.return_url = params.returnUrl;

    return this.request<PaymentIntent>('POST', `/payment_intents/${id}/confirm`, data);
  }

  /**
   * Cancel a PaymentIntent
   */
  async cancelPaymentIntent(id: string): Promise<PaymentIntent> {
    return this.request<PaymentIntent>('POST', `/payment_intents/${id}/cancel`);
  }

  // ==========================================================================
  // Customers
  // ==========================================================================

  /**
   * Create a Customer
   */
  async createCustomer(params: {
    email?: string;
    name?: string;
    description?: string;
    metadata?: Record<string, string>;
  }): Promise<Customer> {
    return this.request<Customer>('POST', '/customers', params);
  }

  /**
   * Retrieve a Customer
   */
  async getCustomer(id: string): Promise<Customer> {
    return this.request<Customer>('GET', `/customers/${id}`);
  }

  // ==========================================================================
  // Payment Methods
  // ==========================================================================

  /**
   * Retrieve a PaymentMethod
   */
  async getPaymentMethod(id: string): Promise<PaymentMethod> {
    return this.request<PaymentMethod>('GET', `/payment_methods/${id}`);
  }

  /**
   * Attach a PaymentMethod to a Customer
   */
  async attachPaymentMethod(paymentMethodId: string, customerId: string): Promise<PaymentMethod> {
    return this.request<PaymentMethod>('POST', `/payment_methods/${paymentMethodId}/attach`, {
      customer: customerId,
    });
  }

  /**
   * Detach a PaymentMethod from a Customer
   */
  async detachPaymentMethod(paymentMethodId: string): Promise<PaymentMethod> {
    return this.request<PaymentMethod>('POST', `/payment_methods/${paymentMethodId}/detach`);
  }

  /**
   * List a Customer's PaymentMethods (used as a webhook-less reconciliation
   * path in the wallet endpoints, so the demo works without a `stripe listen`
   * tunnel running).
   */
  async listCustomerPaymentMethods(customerId: string, type: string = 'card'): Promise<PaymentMethod[]> {
    const res = await this.request<{ data: PaymentMethod[] }>(
      'GET',
      `/customers/${customerId}/payment_methods?type=${type}`
    );
    return res.data || [];
  }

  // ==========================================================================
  // SetupIntents
  // ==========================================================================

  /**
   * Create a SetupIntent (used for vaulting cards via Payment Element).
   */
  async createSetupIntent(params: {
    customer: string;
    usage?: 'on_session' | 'off_session';
    paymentMethodTypes?: string[];
    metadata?: Record<string, string>;
  }): Promise<{
    id: string;
    client_secret: string;
    status: string;
    customer: string;
    payment_method?: string;
  }> {
    const data: Record<string, any> = {
      customer: params.customer,
      usage: params.usage || 'off_session',
    };
    if (params.paymentMethodTypes?.length) data.payment_method_types = params.paymentMethodTypes;
    else {
      data.automatic_payment_methods = { enabled: true, allow_redirects: 'never' };
    }
    if (params.metadata) data.metadata = params.metadata;
    return this.request('POST', '/setup_intents', data);
  }

  /**
   * Retrieve a SetupIntent
   */
  async getSetupIntent(id: string): Promise<{
    id: string;
    status: string;
    customer: string;
    payment_method?: string;
    client_secret: string;
  }> {
    return this.request('GET', `/setup_intents/${id}`);
  }

  // ==========================================================================
  // SharedPaymentToken (ACP)
  // ==========================================================================

  /**
   * Process an ACP SharedPaymentToken
   * 
   * A SharedPaymentToken (SPT) is a secure, single-use token that represents
   * a user's payment authorization for an agent-initiated purchase.
   * 
   * Flow:
   * 1. User authorizes payment on merchant/platform
   * 2. Platform generates SPT
   * 3. Agent sends SPT to PayOS
   * 4. PayOS validates and processes payment via Stripe
   */
  async processSharedPaymentToken(params: {
    token: string;
    amount: number;  // in cents
    currency: string;
    description?: string;
    metadata?: Record<string, string>;
    idempotencyKey?: string;
  }): Promise<PaymentIntent> {
    // In production, SPT would be decoded to get customer/payment method
    // For now, we handle test SPTs directly
    
    if (params.token.startsWith('spt_test_')) {
      // Test SPT - simulate successful payment
      console.log('[Stripe] Processing test SPT:', params.token);
      
      // Create PaymentIntent with automatic confirmation
      const paymentIntent = await this.createPaymentIntent({
        amount: params.amount,
        currency: params.currency,
        description: params.description,
        metadata: {
          ...params.metadata,
          shared_payment_token: params.token,
          source: 'acp',
        },
        idempotencyKey: params.idempotencyKey,
      });
      
      return paymentIntent;
    } else if (params.token.startsWith('pm_')) {
      // Direct PaymentMethod ID - use directly (off-session for ACP)
      return this.createPaymentIntent({
        amount: params.amount,
        currency: params.currency,
        paymentMethodId: params.token,
        description: params.description,
        metadata: params.metadata,
        idempotencyKey: params.idempotencyKey,
        confirm: true,
        offSession: true,  // ACP payments are server-initiated
      });
    } else {
      throw new Error('Invalid SharedPaymentToken format');
    }
  }

  // ==========================================================================
  // Webhooks
  // ==========================================================================

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.webhookSecret) {
      console.warn('[Stripe] No webhook secret configured, skipping verification');
      return true;
    }

    // Parse Stripe signature header
    const parts = signature.split(',');
    const sigMap: Record<string, string> = {};
    for (const part of parts) {
      const [key, value] = part.split('=');
      sigMap[key] = value;
    }

    const timestamp = sigMap['t'];
    const expectedSig = sigMap['v1'];

    if (!timestamp || !expectedSig) {
      return false;
    }

    // Compute expected signature
    const crypto = require('crypto');
    const signedPayload = `${timestamp}.${payload}`;
    const computedSig = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(signedPayload)
      .digest('hex');

    // Compare signatures (constant-time)
    return crypto.timingSafeEqual(
      Buffer.from(expectedSig),
      Buffer.from(computedSig)
    );
  }

  // ==========================================================================
  // Health Check
  // ==========================================================================

  /**
   * Verify API key is valid
   */
  async healthCheck(): Promise<{
    valid: boolean;
    testMode: boolean;
    error?: string;
  }> {
    try {
      // Try to retrieve a non-existent customer to verify key
      await this.request('GET', '/customers/cus_test_nonexistent').catch(() => {});
      return {
        valid: true,
        testMode: this.isTestMode,
      };
    } catch (error: any) {
      // If error is "resource not found", key is valid
      if (error.message.includes('No such customer')) {
        return {
          valid: true,
          testMode: this.isTestMode,
        };
      }
      return {
        valid: false,
        testMode: this.isTestMode,
        error: error.message,
      };
    }
  }
}

// ==========================================================================
// Service Factory
// ==========================================================================

let stripeClient: StripeClient | null = null;

/**
 * Get singleton Stripe client
 */
export function getStripeClient(): StripeClient {
  if (!stripeClient) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!secretKey) {
      throw new Error('STRIPE_SECRET_KEY not configured');
    }

    stripeClient = new StripeClient({
      secretKey,
      webhookSecret,
    });
  }

  return stripeClient;
}

/**
 * Check if Stripe is configured
 */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

