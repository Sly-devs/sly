/**
 * @sly/x402-client-sdk
 * 
 * Consumer SDK for calling x402-enabled APIs with automatic payment handling.
 * 
 * Simple Usage (Agent with auto-derived wallet):
 * ```typescript
 * const client = new X402Client({
 *   apiKey: 'ak_live_xxxxx'  // Agent's API key - wallet is auto-derived
 * });
 * 
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 * 
 * Advanced Usage (Explicit wallet):
 * ```typescript
 * const client = new X402Client({
 *   apiKey: 'pk_live_xxxxx',
 *   walletId: 'wal_specific'  // Override default wallet
 * });
 * ```
 * 
 * Spec: https://www.x402.org/x402-whitepaper.pdf
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// Types
// ============================================

export interface X402ClientConfig {
  /** API key for authentication (required) */
  apiKey: string;
  
  /** Agent ID - wallet will be looked up from agent (required unless walletId provided) */
  agentId?: string;
  
  /** Wallet ID to use for payments (alternative to agentId) */
  walletId?: string;
  
  /** Optional: PayOS API URL (default: https://api.payos.ai) */
  apiUrl?: string;
  
  /** Optional: Maximum amount to auto-pay per request */
  maxAutoPayAmount?: number;
  
  /** Optional: Maximum daily spending */
  maxDailySpend?: number;
  
  /** Optional: Callback when payment is processed */
  onPayment?: (payment: X402Payment) => void | Promise<void>;
  
  /** Optional: Callback when spending limit is reached */
  onLimitReached?: (limit: X402LimitReached) => void | Promise<void>;
  
  /** Optional: Custom fetch implementation */
  fetcher?: typeof fetch;
  
  /** Optional: Enable debug logging */
  debug?: boolean;
}

export interface X402FetchOptions extends RequestInit {
  /** Automatically retry request after payment (default: true) */
  autoRetry?: boolean;
  
  /** Maximum number of payment retries (default: 1) */
  maxRetries?: number;
  
  /** Override onPayment callback for this request */
  onPayment?: (payment: X402Payment) => void | Promise<void>;
  
  /** Override onError callback for this request */
  onError?: (error: X402Error) => void | Promise<void>;
}

export interface X402PaymentDetails {
  endpointId: string;
  amount: number;
  currency: string;
  paymentAddress?: string;
  assetAddress?: string;
  network?: string;
}

export interface X402Payment {
  requestId: string;
  transferId: string;
  amount: number;
  currency: string;
  endpointId: string;
  endpoint?: string;
  walletId: string;
  proof: {
    paymentId: string;
    signature: string;
    jwt?: string;  // Phase 2: JWT for local verification
  };
  newWalletBalance: number;
  timestamp: string;
}

export interface X402Error {
  code: string;
  message: string;
  details?: any;
}

export interface X402LimitReached {
  type: 'per_request' | 'daily';
  limit: number;
  requested: number;
}

export interface X402Status {
  balance: number;
  currency: string;
  todaySpend: number;
  dailyLimit: number | null;
  remaining: number;
  agentId?: string;
  agentName?: string;
}

// ============================================
// X402 Client
// ============================================

export class X402Client {
  private config: {
    apiKey: string;
    agentId?: string;
    walletId?: string;
    apiUrl: string;
    maxAutoPayAmount?: number;
    maxDailySpend?: number;
    onPayment?: (payment: X402Payment) => void | Promise<void>;
    onLimitReached?: (limit: X402LimitReached) => void | Promise<void>;
    fetcher: typeof fetch;
    debug: boolean;
  };
  
  private resolvedWalletId?: string;
  private todaySpend: number = 0;
  
  constructor(config: X402ClientConfig) {
    if (!config.apiKey) {
      throw new Error('X402Client requires an apiKey');
    }
    
    if (!config.agentId && !config.walletId) {
      throw new Error('X402Client requires either agentId or walletId');
    }
    
    this.config = {
      apiKey: config.apiKey,
      agentId: config.agentId,
      walletId: config.walletId,
      apiUrl: config.apiUrl || 'http://localhost:3456',
      maxAutoPayAmount: config.maxAutoPayAmount,
      maxDailySpend: config.maxDailySpend,
      onPayment: config.onPayment,
      onLimitReached: config.onLimitReached,
      fetcher: config.fetcher || fetch,
      debug: config.debug || false
    };
  }
  
  /**
   * Resolve wallet ID from agent or use explicit wallet
   */
  private async resolveWalletId(): Promise<string> {
    // If explicitly provided, use it
    if (this.config.walletId) {
      return this.config.walletId;
    }
    
    // If already resolved, return cached
    if (this.resolvedWalletId) {
      return this.resolvedWalletId;
    }
    
    // Must have agentId if no walletId
    if (!this.config.agentId) {
      throw new Error('No wallet configured. Provide either agentId or walletId.');
    }
    
    // Fetch agent to get wallet ID
    this.log(`Resolving wallet from agent ${this.config.agentId}...`);
    
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/agents/${this.config.agentId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to fetch agent ${this.config.agentId}. Check your API key and agent ID.`);
    }
    
    const agent = await response.json() as { walletId?: string; id?: string };
    
    if (!agent.walletId) {
      throw new Error(`Agent ${this.config.agentId} has no wallet assigned. Assign a wallet first.`);
    }
    
    this.resolvedWalletId = agent.walletId;
    this.log(`Wallet resolved: ${this.resolvedWalletId}`);
    
    return this.resolvedWalletId;
  }
  
  /**
   * Fetch a URL with automatic x402 payment handling
   */
  async fetch(url: string, options: X402FetchOptions = {}): Promise<Response> {
    const {
      autoRetry = true,
      maxRetries = 1,
      onPayment,
      onError,
      ...fetchOptions
    } = options;
    
    let retries = 0;
    
    while (retries <= maxRetries) {
      try {
        this.log(`Fetching: ${url} (attempt ${retries + 1}/${maxRetries + 1})`);
        
        const response = await this.config.fetcher(url, fetchOptions);
        
        // If not 402, return response
        if (response.status !== 402) {
          this.log(`Response: ${response.status}`);
          return response;
        }
        
        // Handle 402 Payment Required
        this.log('402 Payment Required detected');
        
        if (!autoRetry) {
          this.log('Auto-retry disabled, returning 402 response');
          return response;
        }
        
        if (retries >= maxRetries) {
          this.log('Max retries reached, returning 402 response');
          return response;
        }
        
        // Parse 402 response
        const paymentDetails = await this.parse402Response(response);
        
        // Check spending limits
        const limitCheck = this.checkLimits(paymentDetails.amount);
        if (limitCheck) {
          this.log(`Spending limit reached: ${limitCheck.type}`);
          if (this.config.onLimitReached) {
            await this.config.onLimitReached(limitCheck);
          }
          return response;
        }
        
        // Process payment
        this.log('Processing payment...');
        const walletId = await this.resolveWalletId();
        const payment = await this.pay(paymentDetails, url, fetchOptions.method as string || 'GET', walletId);
        
        // Track spending
        this.todaySpend += payment.amount;
        
        // Callbacks
        const paymentCallback = onPayment || this.config.onPayment;
        if (paymentCallback) {
          await paymentCallback(payment);
        }
        
        this.log('Payment successful, retrying request...');
        
        // Retry original request with proof of payment
        const retryHeaders = new Headers(fetchOptions.headers);
        retryHeaders.set('X-Payment-ID', payment.transferId);
        retryHeaders.set('X-Payment-Proof', payment.proof.signature);
        
        // Phase 2: Add JWT for local verification by provider
        if (payment.proof.jwt) {
          retryHeaders.set('X-Payment-JWT', payment.proof.jwt);
        }
        
        retries++;
        fetchOptions.headers = retryHeaders;
        
      } catch (error) {
        const x402Error: X402Error = {
          code: 'PAYMENT_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
          details: error
        };
        
        if (onError) {
          await onError(x402Error);
        }
        
        throw error;
      }
    }
    
    throw new Error('Failed to fetch after max retries');
  }
  
  /**
   * Check if payment would exceed limits
   */
  private checkLimits(amount: number): X402LimitReached | null {
    // Check per-request limit
    if (this.config.maxAutoPayAmount && amount > this.config.maxAutoPayAmount) {
      return {
        type: 'per_request',
        limit: this.config.maxAutoPayAmount,
        requested: amount
      };
    }
    
    // Check daily limit
    if (this.config.maxDailySpend && (this.todaySpend + amount) > this.config.maxDailySpend) {
      return {
        type: 'daily',
        limit: this.config.maxDailySpend,
        requested: amount
      };
    }
    
    return null;
  }
  
  /**
   * Parse 402 response to extract payment details
   */
  private async parse402Response(response: Response): Promise<X402PaymentDetails> {
    const endpointId = response.headers.get('X-Endpoint-ID');
    const amount = parseFloat(response.headers.get('X-Payment-Amount') || '0');
    const currency = response.headers.get('X-Payment-Currency') || 'USDC';
    const paymentAddress = response.headers.get('X-Payment-Address') || undefined;
    const assetAddress = response.headers.get('X-Asset-Address') || undefined;
    const network = response.headers.get('X-Payment-Network') || 'base-mainnet';
    
    if (!endpointId || !amount) {
      throw new Error('Invalid 402 response: missing payment details');
    }
    
    return {
      endpointId,
      amount,
      currency,
      paymentAddress,
      assetAddress,
      network
    };
  }
  
  /**
   * Process payment via PayOS
   */
  private async pay(
    details: X402PaymentDetails,
    path: string,
    method: string,
    walletId: string
  ): Promise<X402Payment> {
    const requestId = uuidv4();
    const timestamp = Date.now();
    
    const paymentRequest = {
      endpointId: details.endpointId,
      requestId,
      amount: details.amount,
      currency: details.currency,
      walletId,
      method,
      path,
      timestamp,
      metadata: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'PayOS SDK',
        sdk: '@sly/x402-client-sdk@0.1.0'
      }
    };
    
    this.log('Payment request:', paymentRequest);
    
    const response = await this.config.fetcher(`${this.config.apiUrl}/v1/x402/pay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(paymentRequest)
    });
    
    if (!response.ok) {
      const error = await response.json() as { error?: string; message?: string };
      throw new Error(`Payment failed: ${error.error || error.message || 'Unknown error'}`);
    }
    
    const result = await response.json() as { success?: boolean; data?: X402Payment; error?: string };
    
    if (!result.success) {
      throw new Error(`Payment failed: ${result.error || 'Unknown error'}`);
    }
    
    return result.data!;
  }
  
  /**
   * Get pricing quote for an endpoint
   */
  async getQuote(endpointId: string): Promise<{
    endpointId: string;
    name: string;
    path: string;
    method: string;
    basePrice: number;
    currentPrice: number;
    currency: string;
    volumeDiscounts: any[];
    totalCalls: number;
  }> {
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/x402/quote/${endpointId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch quote');
    }
    
    const result = await response.json() as { data: any };
    return result.data;
  }
  
  /**
   * Get wallet and spending status
   */
  async getStatus(): Promise<X402Status> {
    const walletId = await this.resolveWalletId();
    
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/wallets/${walletId}`,
      {
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`
        }
      }
    );
    
    if (!response.ok) {
      throw new Error('Failed to fetch wallet status');
    }
    
    const wallet = await response.json() as { balance: string; currency: string };
    const balance = parseFloat(wallet.balance);
    
    return {
      balance,
      currency: wallet.currency || 'USDC',
      todaySpend: this.todaySpend,
      dailyLimit: this.config.maxDailySpend || null,
      remaining: this.config.maxDailySpend 
        ? Math.max(0, this.config.maxDailySpend - this.todaySpend)
        : balance
    };
  }
  
  /**
   * Verify a payment
   */
  async verifyPayment(requestId: string, transferId: string): Promise<boolean> {
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/x402/verify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`
        },
        body: JSON.stringify({ requestId, transferId })
      }
    );
    
    const result = await response.json() as { verified?: boolean };
    return result.verified === true;
  }
  
  /**
   * Update client configuration
   */
  updateConfig(config: Partial<X402ClientConfig>): void {
    Object.assign(this.config, config);

    // Clear resolved wallet if apiKey changed
    if (config.apiKey) {
      this.resolvedWalletId = undefined;
    }
  }

  // ==========================================================================
  // SPEC-COMPLIANT x402 (EIP-3009) — for paying EXTERNAL x402 endpoints
  //
  // The methods above (fetch/pay) talk to the Sly platform's internal
  // /v1/x402/pay API. The methods below talk to EXTERNAL x402-protected
  // resources using spec-compliant EIP-3009 signatures produced by the
  // agent's Sly-custodial EVM key.
  // ==========================================================================

  /**
   * Get the agent's managed EVM address (used as the payer for x402 payments).
   * Provisions a key automatically if the agent doesn't have one yet.
   */
  async getEvmAddress(): Promise<string> {
    if (!this.config.agentId) {
      throw new Error('agentId is required for EVM signing');
    }
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/agents/${this.config.agentId}/evm-keys`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: '{}',
      },
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`getEvmAddress failed: ${err.error || response.statusText}`);
    }
    const body = await response.json() as { data?: { ethereumAddress: string } };
    const addr = body.data?.ethereumAddress;
    if (!addr) throw new Error('No EVM address in response');
    return addr;
  }

  /**
   * Sign an EIP-3009 transferWithAuthorization payload using the agent's
   * managed EVM key. The resulting signature is spec-compliant and can be
   * submitted to any x402 server that verifies EIP-3009 payloads, or used
   * directly on-chain via the USDC contract's transferWithAuthorization()
   * function.
   */
  async signTransferAuth(params: {
    to: string;
    value: string;        // token units as decimal string (e.g. "100000" for 0.1 USDC)
    chainId?: number;     // defaults to 84532 (Base Sepolia)
    validBefore: number;  // unix seconds deadline
    validAfter?: number;  // unix seconds start (defaults to 0)
    nonce?: string;       // 32-byte hex, auto-generated if omitted
  }): Promise<{
    signature: `0x${string}`;
    v: number;
    r: `0x${string}`;
    s: `0x${string}`;
    from: string;
    to: string;
    value: string;
    chainId: number;
    tokenAddress: string;
    validAfter: number;
    validBefore: number;
    nonce: string;
  }> {
    if (!this.config.agentId) {
      throw new Error('agentId is required for EVM signing');
    }
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/agents/${this.config.agentId}/x402-sign`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          to: params.to,
          value: params.value,
          chainId: params.chainId || 84532,
          validBefore: params.validBefore,
          validAfter: params.validAfter || 0,
          nonce: params.nonce,
        }),
      },
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`signTransferAuth failed: ${err.error || response.statusText}`);
    }
    return await response.json() as any;
  }

  /**
   * Fund the agent's managed EVM EOA by bridging USDC from its Circle custodial
   * wallet. Required before the EOA can pay external x402 endpoints — the
   * signature it produces is only redeemable if the EOA actually holds USDC.
   */
  async fundEvmAddress(amount: string = '1'): Promise<{
    txId: string;
    destinationAddress: string;
    amount: string;
  }> {
    if (!this.config.agentId) {
      throw new Error('agentId is required for EVM funding');
    }
    const response = await this.config.fetcher(
      `${this.config.apiUrl}/v1/agents/${this.config.agentId}/fund-eoa`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ amount }),
      },
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(`fundEvmAddress failed: ${err.error || response.statusText}`);
    }
    const body = await response.json() as { data?: any };
    return body.data || body as any;
  }

  /**
   * Fetch an EXTERNAL x402-protected URL and handle the payment using a
   * spec-compliant EIP-3009 signature. This is the opposite of `fetch()`
   * above: fetch() uses Sly's internal /v1/x402/pay flow; this uses the
   * actual x402 protocol so Sly agents can pay non-Sly x402 endpoints.
   *
   * Flow:
   * 1. Fetch the URL
   * 2. If 402, parse payment requirements from the response
   * 3. Get a signed EIP-3009 payload from Sly's signing endpoint
   * 4. Retry with the PAYMENT-SIGNATURE header
   */
  async fetchExternal(url: string, options: X402FetchOptions = {}): Promise<Response> {
    const { autoRetry = true, ...fetchOptions } = options;

    // Initial request
    const response = await this.config.fetcher(url, fetchOptions);
    if (response.status !== 402 || !autoRetry) return response;

    // Parse 402 payment instructions. The x402 spec uses accept/payment fields.
    // We try multiple header conventions since different servers emit slightly
    // different shapes during the protocol's current evolution.
    const amount = response.headers.get('x-payment-amount') ||
                   response.headers.get('x-amount') ||
                   '0';
    const to = response.headers.get('x-payment-to') ||
               response.headers.get('x-pay-to') ||
               '';
    const chainId = parseInt(
      response.headers.get('x-chain-id') || '84532',
      10,
    );

    if (!to || !amount || amount === '0') {
      this.log('402 received but no payment headers present — returning raw 402');
      return response;
    }

    // Convert decimal amount to token units (USDC has 6 decimals)
    const valueUnits = String(Math.floor(parseFloat(amount) * 1_000_000));

    // Sign the EIP-3009 payload
    const validBefore = Math.floor(Date.now() / 1000) + 3600;
    const signed = await this.signTransferAuth({
      to,
      value: valueUnits,
      chainId,
      validBefore,
    });

    // Retry with PAYMENT-SIGNATURE header. The header encoding follows the
    // x402 spec's `scheme=exact` convention — the payload is a base64-encoded
    // JSON object containing the signature + all the parameters the server
    // needs to verify and settle on-chain.
    const paymentPayload = {
      scheme: 'exact',
      network: chainId === 84532 ? 'base-sepolia' : 'base',
      payload: {
        signature: signed.signature,
        authorization: {
          from: signed.from,
          to: signed.to,
          value: signed.value,
          validAfter: signed.validAfter,
          validBefore: signed.validBefore,
          nonce: signed.nonce,
        },
      },
    };
    const encoded = typeof Buffer !== 'undefined'
      ? Buffer.from(JSON.stringify(paymentPayload)).toString('base64')
      : btoa(JSON.stringify(paymentPayload));

    const retryHeaders = new Headers(fetchOptions.headers);
    retryHeaders.set('X-PAYMENT', encoded);
    retryHeaders.set('PAYMENT-SIGNATURE', encoded); // legacy header name

    this.log('Retrying with EIP-3009 PAYMENT-SIGNATURE header');
    return await this.config.fetcher(url, { ...fetchOptions, headers: retryHeaders });
  }
  
  /**
   * Debug logging
   */
  private log(message: string, data?: any): void {
    if (this.config.debug) {
      console.log(`[X402Client] ${message}`, data || '');
    }
  }
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if a response is a 402 Payment Required
 */
export function is402Response(response: Response): boolean {
  return response.status === 402;
}

/**
 * Extract payment details from 402 response headers
 */
export function extract402Details(response: Response): X402PaymentDetails | null {
  if (!is402Response(response)) {
    return null;
  }
  
  const endpointId = response.headers.get('X-Endpoint-ID');
  const amount = parseFloat(response.headers.get('X-Payment-Amount') || '0');
  const currency = response.headers.get('X-Payment-Currency') || 'USDC';
  
  if (!endpointId || !amount) {
    return null;
  }
  
  return {
    endpointId,
    amount,
    currency,
    paymentAddress: response.headers.get('X-Payment-Address') || undefined,
    assetAddress: response.headers.get('X-Asset-Address') || undefined,
    network: response.headers.get('X-Payment-Network') || 'base-mainnet'
  };
}

// ============================================
// Exports
// ============================================

export default X402Client;
