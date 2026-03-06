/**
 * Circle API Client
 * Story 40.1, 40.2: Circle Sandbox Integration
 * 
 * Real Circle API client for Programmable Wallets.
 * Supports both sandbox and production environments.
 * 
 * Docs: https://developers.circle.com/w3s/docs
 */

import { randomUUID, publicEncrypt, constants as cryptoConstants } from 'crypto';
import {
  CircleClientConfig,
  CircleWallet,
  CircleWalletSet,
  CircleBlockchain,
  WalletBalanceResponse,
  CircleTransaction,
  CreateWalletSetRequest,
  CreateWalletsRequest,
  GetWalletsRequest,
  TransferTokensRequest,
  CircleApiResponse,
  CircleApiError,
  TokenBalance,
} from './types.js';

// ============================================
// Configuration
// ============================================

// W3S Programmable Wallets always uses api.circle.com (testnet vs mainnet
// is determined by blockchain choice, not URL). The legacy Payments API
// sandbox at api-sandbox.circle.com does NOT host W3S endpoints.
const CIRCLE_W3S_URL = 'https://api.circle.com';
const CIRCLE_PAYMENTS_SANDBOX_URL = 'https://api-sandbox.circle.com';
const DEFAULT_TIMEOUT = 30000; // 30 seconds

// ============================================
// Circle API Client
// ============================================

export class CircleClient {
  private apiKey: string;
  private entitySecret?: string;
  private baseUrl: string;
  private timeout: number;
  private entityPublicKey?: string; // Cached RSA public key from Circle

  constructor(config: CircleClientConfig) {
    if (!config.apiKey) {
      throw new Error('Circle API key is required');
    }

    this.apiKey = config.apiKey;
    this.entitySecret = config.entitySecret;
    this.baseUrl = config.baseUrl || CIRCLE_W3S_URL;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
  }

  // ============================================
  // HTTP Client
  // ============================================

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    console.log(`[Circle] ${method} ${path}`);

    const response = await fetch(url, options);
    const text = await response.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!response.ok) {
      const error = data as CircleApiError;
      console.error(`[Circle] Error ${response.status}:`, error);
      throw new CircleApiClientError(
        error.message || `Circle API error: ${response.status}`,
        response.status,
        error
      );
    }

    return data as T;
  }

  // ============================================
  // Entity Secret Ciphertext (RSA-OAEP encryption)
  // ============================================

  /**
   * Fetch Circle's RSA public key for entity secret encryption.
   * Cached after first fetch.
   */
  private async getEntityPublicKey(): Promise<string> {
    if (this.entityPublicKey) return this.entityPublicKey;

    const response = await this.request<CircleApiResponse<{ publicKey: string }>>(
      'GET',
      '/v1/w3s/config/entity/publicKey'
    );
    this.entityPublicKey = response.data.publicKey;
    return this.entityPublicKey;
  }

  /**
   * Generate a fresh entitySecretCiphertext for write operations.
   * Encrypts the 32-byte entity secret with Circle's RSA public key using RSA-OAEP/SHA-256.
   * Must be regenerated for every write request (replay protection).
   */
  async generateEntitySecretCiphertext(): Promise<string> {
    if (!this.entitySecret) {
      throw new Error(
        'CIRCLE_ENTITY_SECRET is required for write operations. ' +
        'Set it in your environment variables.'
      );
    }

    const publicKeyPem = await this.getEntityPublicKey();
    const entitySecretBytes = Buffer.from(this.entitySecret, 'hex');

    if (entitySecretBytes.length !== 32) {
      throw new Error(`Entity secret must be 32 bytes (64 hex chars), got ${entitySecretBytes.length} bytes`);
    }

    const encrypted = publicEncrypt(
      {
        key: publicKeyPem,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      entitySecretBytes,
    );

    return encrypted.toString('base64');
  }

  /**
   * Helper: attach entitySecretCiphertext to a request body for write operations.
   */
  private async withCiphertext<T extends Record<string, unknown>>(body: T): Promise<T & { entitySecretCiphertext: string }> {
    const ciphertext = await this.generateEntitySecretCiphertext();
    return { ...body, entitySecretCiphertext: ciphertext };
  }

  // ============================================
  // Wallet Set Operations
  // ============================================

  /**
   * Create a new wallet set
   */
  async createWalletSet(name?: string): Promise<CircleWalletSet> {
    const request = await this.withCiphertext({
      idempotencyKey: randomUUID(),
      name: name || 'PayOS Wallets',
      custodyType: 'DEVELOPER',
    });

    const response = await this.request<CircleApiResponse<{ walletSet: CircleWalletSet }>>(
      'POST',
      '/v1/w3s/developer/walletSets',
      request
    );

    console.log(`[Circle] Created wallet set: ${response.data.walletSet.id}`);
    return response.data.walletSet;
  }

  /**
   * Get a wallet set by ID
   */
  async getWalletSet(walletSetId: string): Promise<CircleWalletSet> {
    const response = await this.request<CircleApiResponse<{ walletSet: CircleWalletSet }>>(
      'GET',
      `/v1/w3s/walletSets/${walletSetId}`
    );
    return response.data.walletSet;
  }

  /**
   * List all wallet sets
   */
  async listWalletSets(): Promise<CircleWalletSet[]> {
    const response = await this.request<CircleApiResponse<{ walletSets: CircleWalletSet[] }>>(
      'GET',
      '/v1/w3s/walletSets'
    );
    return response.data.walletSets;
  }

  // ============================================
  // Wallet Operations
  // ============================================

  /**
   * Create wallets in a wallet set
   */
  async createWallets(
    walletSetId: string,
    blockchains: CircleBlockchain[],
    count: number = 1,
    metadata?: { name?: string; refId?: string }
  ): Promise<CircleWallet[]> {
    const request = await this.withCiphertext({
      idempotencyKey: randomUUID(),
      walletSetId,
      blockchains,
      count,
      metadata: metadata ? [metadata] : undefined,
    });

    const response = await this.request<CircleApiResponse<{ wallets: CircleWallet[] }>>(
      'POST',
      '/v1/w3s/developer/wallets',
      request
    );

    console.log(`[Circle] Created ${response.data.wallets.length} wallet(s)`);
    return response.data.wallets;
  }

  /**
   * Create a single wallet on a specific blockchain
   */
  async createWallet(
    walletSetId: string,
    blockchain: CircleBlockchain,
    name?: string,
    refId?: string
  ): Promise<CircleWallet> {
    const wallets = await this.createWallets(
      walletSetId,
      [blockchain],
      1,
      { name, refId }
    );
    return wallets[0];
  }

  /**
   * Get a wallet by ID
   */
  async getWallet(walletId: string): Promise<CircleWallet> {
    const response = await this.request<CircleApiResponse<{ wallet: CircleWallet }>>(
      'GET',
      `/v1/w3s/wallets/${walletId}`
    );
    return response.data.wallet;
  }

  /**
   * List wallets with optional filters
   */
  async listWallets(params?: GetWalletsRequest): Promise<CircleWallet[]> {
    const searchParams = new URLSearchParams();
    if (params?.walletSetId) searchParams.set('walletSetId', params.walletSetId);
    if (params?.address) searchParams.set('address', params.address);
    if (params?.blockchain) searchParams.set('blockchain', params.blockchain);
    if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
    if (params?.pageAfter) searchParams.set('pageAfter', params.pageAfter);
    if (params?.pageBefore) searchParams.set('pageBefore', params.pageBefore);

    const query = searchParams.toString();
    const path = `/v1/w3s/wallets${query ? `?${query}` : ''}`;

    const response = await this.request<CircleApiResponse<{ wallets: CircleWallet[] }>>(
      'GET',
      path
    );
    return response.data.wallets;
  }

  /**
   * Update a wallet (name, refId, state)
   */
  async updateWallet(
    walletId: string,
    updates: { name?: string; refId?: string; state?: 'LIVE' | 'FROZEN' }
  ): Promise<CircleWallet> {
    const response = await this.request<CircleApiResponse<{ wallet: CircleWallet }>>(
      'PUT',
      `/v1/w3s/wallets/${walletId}`,
      updates
    );
    return response.data.wallet;
  }

  // ============================================
  // Balance Operations
  // ============================================

  /**
   * Get token balances for a wallet
   */
  async getWalletBalances(walletId: string): Promise<TokenBalance[]> {
    const response = await this.request<WalletBalanceResponse>(
      'GET',
      `/v1/w3s/wallets/${walletId}/balances`
    );
    return response.data.tokenBalances;
  }

  /**
   * Get USDC balance for a wallet (convenience method)
   */
  async getUsdcBalance(walletId: string): Promise<{ amount: string; formatted: number }> {
    const balances = await this.getWalletBalances(walletId);
    const usdcBalance = balances.find(b => b.token.symbol === 'USDC');
    
    if (!usdcBalance) {
      return { amount: '0', formatted: 0 };
    }

    // Circle API returns amount already in human-readable format (e.g. "11" = 11 USDC)
    const formatted = parseFloat(usdcBalance.amount);
    return { amount: usdcBalance.amount, formatted };
  }

  // ============================================
  // Transaction Operations
  // ============================================

  /**
   * Transfer tokens from a wallet
   */
  async transferTokens(
    walletId: string,
    tokenId: string,
    destinationAddress: string,
    amount: string,
    feeLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'MEDIUM'
  ): Promise<CircleTransaction> {
    const request = await this.withCiphertext({
      idempotencyKey: randomUUID(),
      walletId,
      tokenId,
      destinationAddress,
      amounts: [amount],
      feeLevel,
    });

    const response = await this.request<CircleApiResponse<{ transaction?: CircleTransaction } & CircleTransaction>>(
      'POST',
      '/v1/w3s/developer/transactions/transfer',
      request
    );

    // Circle returns { data: { id, state, ... } } directly (not nested under .transaction)
    const tx = response.data.transaction || response.data;
    console.log(`[Circle] Transfer initiated: ${tx.id} (state: ${tx.state})`);
    return tx;
  }

  /**
   * Get a transaction by ID
   */
  async getTransaction(transactionId: string): Promise<CircleTransaction> {
    const response = await this.request<CircleApiResponse<{ transaction: CircleTransaction }>>(
      'GET',
      `/v1/w3s/transactions/${transactionId}`
    );
    return response.data.transaction;
  }

  /**
   * List transactions for a wallet
   */
  async listTransactions(
    walletId: string,
    pageSize: number = 50
  ): Promise<CircleTransaction[]> {
    const response = await this.request<CircleApiResponse<{ transactions: CircleTransaction[] }>>(
      'GET',
      `/v1/w3s/transactions?walletIds=${walletId}&pageSize=${pageSize}`
    );
    return response.data.transactions;
  }

  // ============================================
  // Faucet Operations (Testnet only)
  // ============================================

  /**
   * Request testnet tokens from Circle faucet.
   * Returns 204 with no body on success.
   * Rate limit: 20 USDC per address per 2 hours.
   */
  async requestFaucetDrip(
    address: string,
    blockchain: CircleBlockchain = 'BASE-SEPOLIA',
    options: { usdc?: boolean; native?: boolean; eurc?: boolean } = { usdc: true }
  ): Promise<void> {
    const url = `${this.baseUrl}/v1/faucet/drips`;

    console.log(`[Circle] POST /v1/faucet/drips for ${address} on ${blockchain}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address,
        blockchain,
        usdc: options.usdc ?? false,
        native: options.native ?? false,
        eurc: options.eurc ?? false,
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      let error: unknown;
      try { error = JSON.parse(text); } catch { error = text; }
      console.error(`[Circle] Faucet error ${response.status}:`, error);
      throw new CircleApiClientError(
        (error as any)?.message || `Circle faucet error: ${response.status}`,
        response.status,
        error as CircleApiError
      );
    }

    console.log(`[Circle] Faucet drip successful for ${address}`);
  }

  // ============================================
  // Configuration / Health
  // ============================================

  /**
   * Get API configuration (validates API key)
   */
  async getConfiguration(): Promise<{ payments: { masterWalletId: string } }> {
    const response = await this.request<CircleApiResponse<{ payments: { masterWalletId: string } }>>(
      'GET',
      '/v1/configuration'
    );
    return response.data;
  }

  /**
   * Health check - validates API key is working
   */
  async healthCheck(): Promise<{ healthy: boolean; masterWalletId?: string; error?: string }> {
    try {
      const config = await this.getConfiguration();
      return {
        healthy: true,
        masterWalletId: config.payments.masterWalletId,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================
// Error Class
// ============================================

export class CircleApiClientError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public apiError?: CircleApiError
  ) {
    super(message);
    this.name = 'CircleApiClientError';
  }
}

// ============================================
// Singleton Factory
// ============================================

let defaultClient: CircleClient | null = null;

/**
 * Get the default Circle client (uses environment variables)
 */
export function getCircleClient(): CircleClient {
  if (!defaultClient) {
    const apiKey = process.env.CIRCLE_API_KEY;
    
    if (!apiKey) {
      throw new Error(
        'CIRCLE_API_KEY environment variable is required. ' +
        'Get your API key from https://console.circle.com/'
      );
    }

    // W3S Programmable Wallets keys (TEST_API_KEY:* or LIVE_API_KEY:*) always
    // use api.circle.com. Only the legacy Payments sandbox key (SAND_API_KEY:*)
    // uses api-sandbox.circle.com.
    const isPaymentsSandbox = apiKey.startsWith('SAND');

    defaultClient = new CircleClient({
      apiKey,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
      baseUrl: isPaymentsSandbox ? CIRCLE_PAYMENTS_SANDBOX_URL : CIRCLE_W3S_URL,
    });
  }

  return defaultClient;
}

/**
 * Create a Circle client with custom configuration
 */
export function createCircleClient(config: CircleClientConfig): CircleClient {
  return new CircleClient(config);
}

// Re-export types
export * from './types.js';



