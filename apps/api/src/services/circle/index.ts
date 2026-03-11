/**
 * Circle Service Index
 * Story 40.1, 40.2: Circle Integration
 * 
 * Exports Circle client and utilities.
 * Automatically switches between mock and real client based on environment.
 */

import { getEnvironment, isServiceEnabled, getServiceConfig } from '../../config/environment.js';
import { CircleClient, getCircleClient, createCircleClient, CircleApiClientError } from './client.js';
import { CircleMockService, getCircleService as getMockCircleService } from '../circle-mock.js';
import type {
  CircleWallet,
  CircleWalletSet,
  CircleBlockchain,
  TokenBalance,
  CircleTransaction,
  PayOSBlockchain,
  GasStationConfig,
  GasStationStatus,
} from './types.js';
import { toCircleBlockchain, getUsdcContract, getEurcContract } from './types.js';

// ============================================
// Unified Circle Service Interface
// ============================================

export interface CircleServiceInterface {
  // Wallet operations
  createWallet(params: {
    walletSetId?: string;
    blockchain: PayOSBlockchain;
    name?: string;
    refId?: string;
    accountType?: 'SCA' | 'EOA';
  }): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  }>;

  getWallet(walletId: string): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  } | null>;

  getWalletBalance(walletId: string, currency?: 'USDC' | 'EURC'): Promise<{
    amount: string;
    formatted: number;
    currency: string;
  }>;

  // Health check
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

// ============================================
// Real Circle Service (wraps CircleClient)
// ============================================

class RealCircleService implements CircleServiceInterface {
  private client: CircleClient;
  private defaultWalletSetId: string | null = null;

  constructor(client: CircleClient) {
    this.client = client;
  }

  async ensureWalletSet(): Promise<string> {
    if (this.defaultWalletSetId) {
      return this.defaultWalletSetId;
    }

    // Check for existing wallet sets
    const walletSets = await this.client.listWalletSets();
    if (walletSets.length > 0) {
      this.defaultWalletSetId = walletSets[0].id;
      return this.defaultWalletSetId;
    }

    // Create a new wallet set
    const newSet = await this.client.createWalletSet('PayOS Wallets');
    this.defaultWalletSetId = newSet.id;
    return this.defaultWalletSetId;
  }

  async createWallet(params: {
    walletSetId?: string;
    blockchain: PayOSBlockchain;
    name?: string;
    refId?: string;
    accountType?: 'SCA' | 'EOA';
  }): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  }> {
    const walletSetId = params.walletSetId || await this.ensureWalletSet();
    const circleBlockchain = toCircleBlockchain(params.blockchain, true); // Use testnet

    const wallet = await this.client.createWallet(
      walletSetId,
      circleBlockchain,
      params.name,
      params.refId,
      params.accountType
    );

    return {
      id: wallet.id,
      address: wallet.address,
      blockchain: wallet.blockchain,
      state: wallet.state,
    };
  }

  async getWallet(walletId: string): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  } | null> {
    try {
      const wallet = await this.client.getWallet(walletId);
      return {
        id: wallet.id,
        address: wallet.address,
        blockchain: wallet.blockchain,
        state: wallet.state,
      };
    } catch (error) {
      if (error instanceof CircleApiClientError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async getWalletBalance(walletId: string, currency: 'USDC' | 'EURC' = 'USDC'): Promise<{
    amount: string;
    formatted: number;
    currency: string;
  }> {
    const balances = await this.client.getWalletBalances(walletId);
    const tokenBalance = balances.find(b => b.token.symbol === currency);

    if (!tokenBalance) {
      return { amount: '0', formatted: 0, currency };
    }

    const formatted = parseFloat(tokenBalance.amount) / Math.pow(10, tokenBalance.token.decimals);
    return {
      amount: tokenBalance.amount,
      formatted,
      currency,
    };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    const result = await this.client.healthCheck();
    return {
      healthy: result.healthy,
      message: result.healthy
        ? `Connected to Circle (Master Wallet: ${result.masterWalletId})`
        : result.error,
    };
  }
}

// ============================================
// Mock Circle Service Adapter
// ============================================

class MockCircleServiceAdapter implements CircleServiceInterface {
  private mockService: CircleMockService;

  constructor(tenantId: string) {
    this.mockService = getMockCircleService(tenantId);
  }

  async createWallet(params: {
    walletSetId?: string;
    blockchain: PayOSBlockchain;
    name?: string;
    refId?: string;
    accountType?: 'SCA' | 'EOA';
  }): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  }> {
    const wallet = await this.mockService.createWallet({
      walletSetId: params.walletSetId || this.mockService.getDefaultWalletSetId(),
      blockchain: params.blockchain.toUpperCase() as any,
      name: params.name,
      refId: params.refId,
    });

    return {
      id: wallet.id,
      address: wallet.address,
      blockchain: wallet.blockchain,
      state: wallet.state,
    };
  }

  async getWallet(walletId: string): Promise<{
    id: string;
    address: string;
    blockchain: string;
    state: string;
  } | null> {
    const wallet = await this.mockService.getWallet(walletId);
    if (!wallet) return null;

    return {
      id: wallet.id,
      address: wallet.address,
      blockchain: wallet.blockchain,
      state: wallet.state,
    };
  }

  async getWalletBalance(_walletId: string, currency: 'USDC' | 'EURC' = 'USDC'): Promise<{
    amount: string;
    formatted: number;
    currency: string;
  }> {
    // Mock always returns 0 - real balance tracking is in PayOS wallets table
    return { amount: '0', formatted: 0, currency };
  }

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return {
      healthy: true,
      message: 'Circle Mock Service is healthy',
    };
  }
}

// ============================================
// Service Factory
// ============================================

const serviceCache = new Map<string, CircleServiceInterface>();

/**
 * Get Circle service for a tenant
 * Automatically uses mock or real client based on environment
 */
export function getCircleServiceForTenant(tenantId: string): CircleServiceInterface {
  const cacheKey = `${tenantId}:${getEnvironment()}`;
  
  if (serviceCache.has(cacheKey)) {
    return serviceCache.get(cacheKey)!;
  }

  const env = getEnvironment();
  const circleConfig = getServiceConfig('circle');

  let service: CircleServiceInterface;

  if (env === 'mock' || !isServiceEnabled('circle')) {
    // Use mock service
    console.log(`[Circle] Using MOCK service for tenant ${tenantId}`);
    service = new MockCircleServiceAdapter(tenantId);
  } else {
    // Use real Circle API
    console.log(`[Circle] Using REAL service (${circleConfig.environment}) for tenant ${tenantId}`);
    const client = getCircleClient();
    service = new RealCircleService(client);
  }

  serviceCache.set(cacheKey, service);
  return service;
}

/**
 * Clear the service cache (for testing)
 */
export function clearCircleServiceCache(): void {
  serviceCache.clear();
}

// ============================================
// Gas Station Health Check (Epic 38, Story 38.9)
// ============================================

/**
 * Check Gas Station health status.
 * Returns null if Circle is not configured or Gas Station feature is disabled.
 *
 * NOTE: Gas Station has no REST API — it's managed via Circle Console.
 * We report status based on feature flags and environment configuration.
 */
export async function checkGasStationHealth(): Promise<{
  enabled: boolean;
  healthy: boolean;
  message: string;
} | null> {
  if (!isServiceEnabled('circle') || !process.env.CIRCLE_API_KEY) {
    return null;
  }

  // Check if Gas Station feature is enabled
  const { isFeatureEnabled } = await import('../../config/environment.js');
  if (!isFeatureEnabled('circleGasStation')) {
    return null;
  }

  try {
    const client = getCircleClient();
    const status = await client.getGasStationStatus();

    return {
      enabled: status.config?.state === 'ENABLED',
      healthy: status.healthy,
      message: status.message || 'Unknown',
    };
  } catch {
    return {
      enabled: false,
      healthy: false,
      message: 'Gas Station check failed',
    };
  }
}

// Re-export types and utilities
export {
  CircleClient,
  CircleApiClientError,
  getCircleClient,
  createCircleClient,
  toCircleBlockchain,
  getUsdcContract,
  getEurcContract,
};

// FX Service (Story 40.6)
export { CircleFXService, getCircleFXService, type FXQuote, type LockedQuote } from './fx.js';

export type {
  CircleWallet,
  CircleWalletSet,
  CircleBlockchain,
  TokenBalance,
  CircleTransaction,
  PayOSBlockchain,
  CircleServiceInterface,
  GasStationConfig,
  GasStationStatus,
};

