/**
 * MPP Client Factory
 *
 * Wraps the mppx SDK with Tempo payment method configuration.
 * Reads MPP_TEMPO_RECIPIENT, MPP_TEMPO_CURRENCY, MPP_TEMPO_TESTNET from env.
 * Singleton pattern matches services/x402/facilitator.ts.
 *
 * @see Story 71.1: Install mppx + Configure Tempo
 */

import type { MppClientConfig, MppPaymentResult, MppPaymentMethod, MppIntent } from './types.js';

// ============================================
// MPP Client Wrapper
// ============================================

/**
 * Wraps the mppx SDK to provide a governed interface for MPP payments.
 * All calls go through try/catch since mppx is day-one software.
 */
export class MppClient {
  private config: Required<MppClientConfig>;
  private mppxClient: any | null = null;
  private initialized = false;

  constructor(config?: MppClientConfig) {
    this.config = {
      secretKey: config?.secretKey || process.env.MPP_SECRET_KEY || '',
      privateKey: config?.privateKey || process.env.MPP_PRIVATE_KEY || '',
      tempoRecipient: config?.tempoRecipient || process.env.MPP_TEMPO_RECIPIENT || '',
      tempoCurrency: config?.tempoCurrency || process.env.MPP_TEMPO_CURRENCY || 'pathUSD',
      tempoTestnet: config?.tempoTestnet ?? (process.env.MPP_TEMPO_TESTNET !== 'false'),
      stripeSecretKey: config?.stripeSecretKey || process.env.MPP_STRIPE_SECRET_KEY || '',
      timeout: config?.timeout || 30000,
    };
  }

  /**
   * Lazily initialize the mppx client.
   * We do this lazily because mppx may not be installed yet during initial setup.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    try {
      // Dynamic import — use mppx/client for making payments (not /server which is for paywalls)
      const mppx = await import('mppx/client');

      const methods: any[] = [];

      // Resolve account from private key if available
      let account: any;
      if (this.config.privateKey) {
        const { privateKeyToAccount } = await import('viem/accounts');
        account = privateKeyToAccount(this.config.privateKey as `0x${string}`);
        console.log('[MPP] Using account:', account.address);
      }

      // Configure Tempo (stablecoin) payment method — primary
      const tempoOpts: any = { testnet: this.config.tempoTestnet };
      if (account) tempoOpts.account = account;
      if (this.config.tempoRecipient) tempoOpts.recipient = this.config.tempoRecipient;
      if (this.config.tempoCurrency) tempoOpts.currency = this.config.tempoCurrency;
      methods.push(mppx.tempo(tempoOpts));

      // Configure Stripe payment method — optional
      if (this.config.stripeSecretKey) {
        methods.push(
          mppx.stripe({
            secretKey: this.config.stripeSecretKey,
          })
        );
      }

      this.mppxClient = mppx.Mppx.create({
        methods,
      });

      this.initialized = true;
      console.log('[MPP] Client initialized with methods:', methods.length);
    } catch (error) {
      console.warn('[MPP] Failed to initialize mppx client:', error);
      // Client stays uninitialized — governed client will handle gracefully
      throw new MppClientError(
        'Failed to initialize MPP client. Is mppx installed?',
        'INIT_FAILED',
        error
      );
    }
  }

  /**
   * Make a one-shot payment to a service URL.
   * Returns receipt data on success.
   */
  async charge(
    serviceUrl: string,
    options?: { amount?: string; description?: string }
  ): Promise<MppPaymentResult> {
    try {
      await this.ensureInitialized();

      // mppx/client uses fetch() — it sends the request and handles 402 payment flow
      // Default to GET since most MPP services use GET for paid endpoints
      const response = await this.mppxClient.fetch(serviceUrl);

      // The response is the actual HTTP response after payment was made
      const rawText = await response.text().catch(() => '');
      let data: any = {};
      try { data = JSON.parse(rawText); } catch { /* not JSON */ }

      // Parse Payment-Receipt header (mppx returns this on successful payment)
      let receiptMethod: string | undefined;
      let receiptReference: string | undefined;
      const receiptHeader = response.headers.get('payment-receipt');
      if (receiptHeader) {
        try {
          const { Receipt } = await import('mppx');
          const parsed = Receipt.deserialize(receiptHeader);
          receiptMethod = parsed?.method;
          receiptReference = parsed?.reference;
        } catch {
          // Receipt parsing failed — fall back to heuristic detection
        }
      }

      return {
        success: response.ok,
        receiptId: receiptReference || response.headers.get('x-receipt-id') || data?.receipt?.id,
        receiptData: data?.receipt || data,
        settlementNetwork: data?.settlement?.network,
        settlementTxHash: data?.settlement?.txHash,
        amountPaid: data?.amount || options?.amount,
        currency: data?.currency,
        paymentMethod: (receiptMethod as MppPaymentMethod) || this.detectPaymentMethod(data),
        protocolIntent: 'charge' as MppIntent,
        error: response.ok ? undefined : `HTTP ${response.status}`,
        errorCode: response.ok ? undefined : `HTTP_${response.status}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown MPP error',
        errorCode: (error as any)?.code || 'CHARGE_FAILED',
      };
    }
  }

  /**
   * Open a streaming payment session with a service.
   */
  async openSession(
    serviceUrl: string,
    options?: { deposit?: string; maxBudget?: string }
  ): Promise<any> {
    await this.ensureInitialized();

    try {
      // session() is exported from mppx/client as a separate function
      const mppx = await import('mppx/client');
      const sess = await mppx.session(this.mppxClient, serviceUrl, {
        deposit: options?.deposit,
        maxBudget: options?.maxBudget,
      });
      return sess;
    } catch (error) {
      throw new MppClientError(
        'Failed to open MPP session',
        'SESSION_OPEN_FAILED',
        error
      );
    }
  }

  /**
   * Get client configuration (safe for logging).
   */
  getConfig(): { tempoRecipient: string; tempoCurrency: string; tempoTestnet: boolean; initialized: boolean } {
    return {
      tempoRecipient: this.config.tempoRecipient ? `${this.config.tempoRecipient.slice(0, 8)}...` : '(not set)',
      tempoCurrency: this.config.tempoCurrency,
      tempoTestnet: this.config.tempoTestnet,
      initialized: this.initialized,
    };
  }

  private detectPaymentMethod(response: any): MppPaymentMethod {
    if (response?.method === 'stripe') return 'stripe';
    if (response?.method === 'lightning') return 'lightning';
    if (response?.method === 'card') return 'card';
    if (response?.method === 'tempo' || response?.settlement?.network?.includes('tempo')) return 'tempo';
    return 'tempo'; // Default to tempo
  }
}

// ============================================
// Error Class
// ============================================

export class MppClientError extends Error {
  constructor(
    message: string,
    public code: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = 'MppClientError';
  }
}

// ============================================
// Singleton Factory
// ============================================

let defaultClient: MppClient | null = null;

/**
 * Get the default MPP client (singleton).
 */
export function getMppClient(): MppClient {
  if (!defaultClient) {
    defaultClient = new MppClient();
  }
  return defaultClient;
}

/**
 * Create an MPP client with custom config.
 */
export function createMppClient(config?: MppClientConfig): MppClient {
  return new MppClient(config);
}

/**
 * Reset the default client (for testing).
 */
export function resetMppClient(): void {
  defaultClient = null;
}
