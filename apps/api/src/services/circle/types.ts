/**
 * Circle API Types
 * Story 40.1, 40.2: Circle Sandbox Integration
 * 
 * Type definitions for Circle Programmable Wallets API
 * Docs: https://developers.circle.com/w3s/docs
 */

// ============================================
// Blockchain Types
// ============================================

export type CircleBlockchain = 
  | 'ETH'       // Ethereum Mainnet
  | 'ETH-SEPOLIA'  // Ethereum Sepolia Testnet
  | 'MATIC'     // Polygon Mainnet
  | 'MATIC-AMOY'   // Polygon Amoy Testnet (replaced Mumbai)
  | 'AVAX'      // Avalanche C-Chain
  | 'AVAX-FUJI'    // Avalanche Fuji Testnet
  | 'SOL'       // Solana Mainnet
  | 'SOL-DEVNET'   // Solana Devnet
  | 'ARB'       // Arbitrum One
  | 'ARB-SEPOLIA'  // Arbitrum Sepolia
  | 'BASE'      // Base Mainnet (NEW - not in all docs yet)
  | 'BASE-SEPOLIA'; // Base Sepolia (NEW)

// Simplified blockchain for our internal use
export type PayOSBlockchain = 'base' | 'eth' | 'polygon' | 'avax' | 'sol' | 'arb';

// Map PayOS blockchain to Circle blockchain
export function toCircleBlockchain(blockchain: PayOSBlockchain, testnet: boolean = true): CircleBlockchain {
  const map: Record<PayOSBlockchain, { mainnet: CircleBlockchain; testnet: CircleBlockchain }> = {
    base: { mainnet: 'BASE' as CircleBlockchain, testnet: 'BASE-SEPOLIA' as CircleBlockchain },
    eth: { mainnet: 'ETH', testnet: 'ETH-SEPOLIA' },
    polygon: { mainnet: 'MATIC', testnet: 'MATIC-AMOY' },
    avax: { mainnet: 'AVAX', testnet: 'AVAX-FUJI' },
    sol: { mainnet: 'SOL', testnet: 'SOL-DEVNET' },
    arb: { mainnet: 'ARB', testnet: 'ARB-SEPOLIA' },
  };
  return testnet ? map[blockchain].testnet : map[blockchain].mainnet;
}

// ============================================
// Wallet Types
// ============================================

export type WalletState = 'LIVE' | 'FROZEN';
export type AccountType = 'SCA' | 'EOA';
export type CustodyType = 'DEVELOPER' | 'USER';

export interface CircleWallet {
  id: string;                    // e.g., "wa_xxxxx"
  address: string;               // e.g., "0x..."
  blockchain: CircleBlockchain;
  state: WalletState;
  walletSetId: string;           // e.g., "ws_xxxxx"
  accountType: AccountType;
  custodyType: CustodyType;
  name?: string;
  refId?: string;                // External reference (our account ID)
  createDate: string;            // ISO timestamp
  updateDate: string;            // ISO timestamp
}

export interface CircleWalletSet {
  id: string;                    // e.g., "ws_xxxxx"
  custodyType: CustodyType;
  name?: string;
  createDate: string;
  updateDate: string;
}

// ============================================
// Token Balance Types
// ============================================

export interface TokenBalance {
  token: {
    id: string;
    name: string;
    symbol: string;
    decimals: number;
    blockchain: CircleBlockchain;
    tokenAddress?: string;       // Contract address (null for native)
    isNative: boolean;
    updateDate: string;
  };
  amount: string;                // String to preserve precision
  updateDate: string;
}

export interface WalletBalanceResponse {
  data: {
    tokenBalances: TokenBalance[];
  };
}

// ============================================
// Transaction Types
// ============================================

export type TransactionState = 
  | 'INITIATED'
  | 'PENDING_RISK_SCREENING'
  | 'PENDING_SIGNATURE'
  | 'PENDING'
  | 'CONFIRMED'
  | 'COMPLETE'
  | 'FAILED'
  | 'CANCELLED'
  | 'DENIED';

export type TransactionType = 
  | 'INBOUND'
  | 'OUTBOUND'
  | 'CONTRACT_EXECUTION'
  | 'CONTRACT_DEPLOYMENT';

export interface CircleTransaction {
  id: string;
  blockchain: CircleBlockchain;
  walletId: string;
  tokenId: string;
  amounts: string[];
  destinationAddress?: string;
  sourceAddress?: string;
  transactionType: TransactionType;
  state: TransactionState;
  txHash?: string;
  blockHash?: string;
  blockHeight?: number;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  networkFee?: string;
  networkFeeToken?: string;
  firstConfirmDate?: string;
  createDate: string;
  updateDate: string;
  errorReason?: string;
  errorDetails?: string;
}

// ============================================
// Request/Response Types
// ============================================

export interface CreateWalletSetRequest {
  idempotencyKey: string;
  name?: string;
  custodyType?: CustodyType;
}

export interface CreateWalletsRequest {
  idempotencyKey: string;
  walletSetId: string;
  blockchains: CircleBlockchain[];
  count: number;
  metadata?: Array<{
    name?: string;
    refId?: string;
  }>;
}

export interface GetWalletsRequest {
  walletSetId?: string;
  address?: string;
  blockchain?: CircleBlockchain;
  pageAfter?: string;
  pageBefore?: string;
  pageSize?: number;
}

export interface TransferTokensRequest {
  idempotencyKey: string;
  amounts: string[];
  destinationAddress: string;
  feeLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  walletId: string;
  tokenId: string;
}

export interface CircleApiResponse<T> {
  data: T;
}

export interface CircleApiError {
  code: number;
  message: string;
  errors?: Array<{
    error: string;
    message: string;
    location?: string;
    invalidValue?: string;
  }>;
}

// ============================================
// Configuration Types
// ============================================

export interface CircleClientConfig {
  apiKey: string;
  entitySecret?: string;
  baseUrl?: string;              // Override for sandbox vs production
  timeout?: number;              // Request timeout in ms
}

// ============================================
// USDC/EURC Contract Addresses
// ============================================

// These are the official Circle USDC/EURC contract addresses
export const USDC_CONTRACTS: Record<string, string> = {
  'BASE': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'BASE-SEPOLIA': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',  // USDC on Base Sepolia
  'ETH': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'ETH-SEPOLIA': '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  'MATIC': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'MATIC-AMOY': '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
  'AVAX': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'AVAX-FUJI': '0x5425890298aed601595a70AB815c96711a31Bc65',
  'ARB': '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  'ARB-SEPOLIA': '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
  'SOL': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'SOL-DEVNET': '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

export const EURC_CONTRACTS: Record<string, string> = {
  'BASE': '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42',
  'ETH': '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
  'AVAX': '0xc891EB4cbdEFf6e073e859e987815Ed1505c2ACD',
};

// ============================================
// Gas Station Types (Epic 38, Story 38.7)
// ============================================

export type GasStationState = 'ENABLED' | 'DISABLED';

export interface GasStationConfig {
  state: GasStationState;
  walletId?: string;
  gasLimit?: string;
  maxPriorityFee?: string;
  maxFee?: string;
}

export interface GasStationBalance {
  blockchain: CircleBlockchain;
  nativeTokenBalance: string;
  walletAddress: string;
}

export interface GasStationStatus {
  config: GasStationConfig | null;
  balances: GasStationBalance[];
  healthy: boolean;
  message?: string;
}

/**
 * Get USDC contract address for a blockchain
 */
export function getUsdcContract(blockchain: CircleBlockchain): string | undefined {
  return USDC_CONTRACTS[blockchain];
}

/**
 * Get EURC contract address for a blockchain
 */
export function getEurcContract(blockchain: CircleBlockchain): string | undefined {
  return EURC_CONTRACTS[blockchain];
}



