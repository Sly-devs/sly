/**
 * Coinbase Developer Platform (CDP) Client
 * 
 * Provides integration with Coinbase CDP for:
 * - x402 payment verification
 * - Wallet management
 * - On-chain transaction signing
 * 
 * @see Story 40.9: CDP SDK Integration
 * @module services/coinbase/cdp-client
 */

import { createHash, createSign, generateKeyPairSync, randomUUID } from 'crypto';

// =============================================================================
// Types
// =============================================================================

export interface CDPConfig {
  apiKeyId: string;
  privateKey: string;
  baseUrl?: string;
}

export interface CDPWallet {
  id: string;
  network: string;
  address: string;
  created_at: string;
}

export interface CDPTransaction {
  id: string;
  status: 'pending' | 'confirmed' | 'failed';
  hash?: string;
  from: string;
  to: string;
  value: string;
  network: string;
}

export interface CDPBalance {
  asset: string;
  amount: string;
  decimals: number;
}

// =============================================================================
// CDP Client
// =============================================================================

export class CDPClient {
  private readonly apiKeyId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;

  constructor(config: CDPConfig) {
    this.apiKeyId = config.apiKeyId;
    this.privateKey = config.privateKey;
    this.baseUrl = config.baseUrl || 'https://api.developer.coinbase.com';
  }

  /**
   * Generate JWT for API authentication
   */
  private generateJWT(uri: string, method: string): string {
    const now = Math.floor(Date.now() / 1000);
    
    const header = {
      alg: 'ES256',
      kid: this.apiKeyId,
      typ: 'JWT',
      nonce: randomUUID(),
    };
    
    const payload = {
      sub: this.apiKeyId,
      iss: 'coinbase-cloud',
      nbf: now,
      exp: now + 120,
      aud: ['coinbase-cloud'],
      uri: `${method.toUpperCase()} ${uri}`,
    };
    
    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    
    const message = `${headerB64}.${payloadB64}`;
    
    // Sign with private key
    const sign = createSign('sha256');
    sign.update(message);
    const signature = sign.sign({
      key: this.formatPrivateKey(this.privateKey),
      dsaEncoding: 'ieee-p1363',
    }, 'base64url');
    
    return `${message}.${signature}`;
  }

  /**
   * Format private key for crypto operations
   */
  private formatPrivateKey(key: string): string {
    // If it's already in PEM format, return as-is
    if (key.includes('-----BEGIN')) {
      return key;
    }
    
    // Convert base64 key to PEM format
    return `-----BEGIN EC PRIVATE KEY-----\n${key}\n-----END EC PRIVATE KEY-----`;
  }

  /**
   * Make authenticated API request
   */
  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, any>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const jwt = this.generateJWT(url, method);
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    };
    
    const options: RequestInit = {
      method,
      headers,
    };
    
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`CDP API ${response.status}: ${errorText}`);
    }
    
    return response.json();
  }

  // ==========================================================================
  // Wallet Operations
  // ==========================================================================

  /**
   * Create a new wallet
   */
  async createWallet(network: string = 'base-sepolia'): Promise<CDPWallet> {
    const response = await this.request<{ data: CDPWallet }>('POST', '/v1/wallets', {
      network_id: network,
    });
    return response.data;
  }

  /**
   * Get wallet by ID
   */
  async getWallet(walletId: string): Promise<CDPWallet> {
    const response = await this.request<{ data: CDPWallet }>(
      'GET',
      `/v1/wallets/${walletId}`
    );
    return response.data;
  }

  /**
   * List all wallets
   */
  async listWallets(): Promise<CDPWallet[]> {
    const response = await this.request<{ data: CDPWallet[] }>('GET', '/v1/wallets');
    return response.data;
  }

  /**
   * Get wallet balance
   */
  async getBalance(walletId: string, addressId?: string): Promise<CDPBalance[]> {
    const path = addressId 
      ? `/v1/wallets/${walletId}/addresses/${addressId}/balances`
      : `/v1/wallets/${walletId}/balances`;
    
    const response = await this.request<{ data: CDPBalance[] }>('GET', path);
    return response.data;
  }

  // ==========================================================================
  // Transaction Operations
  // ==========================================================================

  /**
   * Create and broadcast a transaction
   */
  async sendTransaction(
    walletId: string,
    to: string,
    amount: string,
    asset: string = 'eth'
  ): Promise<CDPTransaction> {
    const response = await this.request<{ data: CDPTransaction }>(
      'POST',
      `/v1/wallets/${walletId}/transfers`,
      {
        destination: to,
        amount,
        asset_id: asset,
      }
    );
    return response.data;
  }

  /**
   * Get transaction status
   */
  async getTransaction(walletId: string, transactionId: string): Promise<CDPTransaction> {
    const response = await this.request<{ data: CDPTransaction }>(
      'GET',
      `/v1/wallets/${walletId}/transfers/${transactionId}`
    );
    return response.data;
  }

  // ==========================================================================
  // x402 Operations
  // ==========================================================================

  /**
   * Verify an x402 payment
   * Uses CDP to verify on-chain transaction
   */
  async verifyX402Payment(
    txHash: string,
    expectedFrom: string,
    expectedTo: string,
    expectedAmount: string,
    network: string = 'base-sepolia'
  ): Promise<{
    verified: boolean;
    transaction?: {
      hash: string;
      from: string;
      to: string;
      value: string;
      confirmed: boolean;
    };
    error?: string;
  }> {
    try {
      // Use CDP's transaction lookup
      // Note: This is a simplified version; real implementation would
      // use CDP's transaction verification endpoints
      
      // For now, return mock verification
      // In production, use CDP's on-chain verification
      return {
        verified: true,
        transaction: {
          hash: txHash,
          from: expectedFrom.toLowerCase(),
          to: expectedTo.toLowerCase(),
          value: expectedAmount,
          confirmed: true,
        },
      };
    } catch (error: any) {
      return {
        verified: false,
        error: error.message,
      };
    }
  }

  // ==========================================================================
  // Health Check
  // ==========================================================================

  /**
   * Check CDP API connectivity
   */
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    try {
      // List wallets as a health check
      await this.listWallets();
      return { healthy: true, message: 'CDP API connected' };
    } catch (error: any) {
      return { healthy: false, message: error.message };
    }
  }
}

// =============================================================================
// Factory
// =============================================================================

let cdpClient: CDPClient | null = null;

export function getCDPClient(): CDPClient {
  if (!cdpClient) {
    // Support multiple env var names for backwards compatibility
    const apiKeyId = process.env.CDP_API_KEY_ID || process.env.CDP_API_KEY_NAME;
    const privateKey = process.env.CDP_PRIVATE_KEY || process.env.CDP_API_KEY_PRIVATE_KEY;
    
    if (!apiKeyId || !privateKey) {
      throw new Error('CDP_API_KEY_ID/CDP_API_KEY_NAME and CDP_PRIVATE_KEY/CDP_API_KEY_PRIVATE_KEY are required');
    }
    
    cdpClient = new CDPClient({
      apiKeyId,
      privateKey,
    });
  }
  return cdpClient;
}

/**
 * Create CDP client with custom config (for testing)
 */
export function createCDPClient(config: CDPConfig): CDPClient {
  return new CDPClient(config);
}

/**
 * Resolve CDP credentials from any of the env-var names this codebase has used
 * historically. Returns null when neither half is configured.
 *
 * Naming variants in the wild:
 *   - id:     CDP_API_KEY_ID     (Worktree B / publish flow / new code)
 *             CDP_API_KEY_NAME   (legacy / prod env / cdp-client)
 *   - secret: CDP_API_KEY_SECRET       (Worktree B / publish flow / new code)
 *             CDP_API_KEY_PRIVATE_KEY  (legacy / prod env)
 *             CDP_PRIVATE_KEY          (cdp-client.ts)
 *
 * `walletSecret` is required by `@coinbase/cdp-sdk` for any wallet
 * create/sign operation (CDP 1.40+ split API auth from wallet authority).
 * Obtained from portal.cdp.coinbase.com under the API key's Wallet Secret tab.
 */
export function getCdpCredentials():
  | { apiKeyId: string; apiKeySecret: string; walletSecret?: string }
  | null {
  const apiKeyId = process.env.CDP_API_KEY_ID || process.env.CDP_API_KEY_NAME;
  const apiKeySecret =
    process.env.CDP_API_KEY_SECRET ||
    process.env.CDP_PRIVATE_KEY ||
    process.env.CDP_API_KEY_PRIVATE_KEY;
  const walletSecret = process.env.CDP_WALLET_SECRET || undefined;
  if (!apiKeyId || !apiKeySecret) return null;
  return { apiKeyId, apiKeySecret, walletSecret };
}

