/**
 * Solana Configuration (Epic 38, Story 38.3)
 *
 * Solana RPC client, SPL Token balance/transfer functions.
 * Mirrors the Base/EVM config in blockchain.ts but for Solana.
 *
 * Uses @solana/web3.js and @solana/spl-token.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  clusterApiUrl,
  type Commitment,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { getEnvironment } from './environment.js';

// ============================================
// Types
// ============================================

export interface SolanaChainConfig {
  cluster: 'devnet' | 'mainnet-beta';
  rpcUrl: string;
  blockExplorerUrl: string;
  usdcMint: string;
  faucets?: { sol: string; usdc: string };
}

// ============================================
// Chain Configurations
// ============================================

export const SOLANA_CONFIGS: Record<'solana-devnet' | 'solana-mainnet', SolanaChainConfig> = {
  'solana-devnet': {
    cluster: 'devnet',
    rpcUrl: process.env.SOLANA_DEVNET_RPC_URL || clusterApiUrl('devnet'),
    blockExplorerUrl: 'https://explorer.solana.com/?cluster=devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    faucets: {
      sol: 'https://faucet.solana.com/',
      usdc: 'https://faucet.circle.com/',
    },
  },
  'solana-mainnet': {
    cluster: 'mainnet-beta',
    rpcUrl: process.env.SOLANA_MAINNET_RPC_URL || clusterApiUrl('mainnet-beta'),
    blockExplorerUrl: 'https://explorer.solana.com',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
};

// ============================================
// Helpers
// ============================================

export function getCurrentSolanaChain(): 'solana-devnet' | 'solana-mainnet' {
  const env = getEnvironment();
  return env === 'production' ? 'solana-mainnet' : 'solana-devnet';
}

export function getSolanaConfig(): SolanaChainConfig {
  return SOLANA_CONFIGS[getCurrentSolanaChain()];
}

let connectionCache: Connection | null = null;

export function getSolanaConnection(commitment: Commitment = 'confirmed'): Connection {
  if (!connectionCache) {
    const config = getSolanaConfig();
    connectionCache = new Connection(config.rpcUrl, commitment);
  }
  return connectionCache;
}

/**
 * Validate a Solana address (base58, 32-44 chars).
 */
export function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an address is a Solana address (not EVM).
 * Solana addresses are base58-encoded, EVM addresses start with 0x.
 */
export function isSolanaAddress(address: string): boolean {
  if (!address || address.startsWith('0x') || address.startsWith('internal://')) return false;
  return isValidSolanaAddress(address);
}

// ============================================
// Balance Checking
// ============================================

/**
 * Get SOL balance for an address.
 */
export async function getSolBalance(address: string): Promise<string> {
  const connection = getSolanaConnection();
  const pubkey = new PublicKey(address);
  const lamports = await connection.getBalance(pubkey);
  return (lamports / 1e9).toFixed(9); // SOL has 9 decimals
}

/**
 * Get USDC (SPL Token) balance for a Solana address.
 * Returns the balance as a human-readable string (6 decimals).
 */
export async function getSolanaUsdcBalance(address: string): Promise<{
  raw: bigint;
  formatted: number;
}> {
  const connection = getSolanaConnection();
  const config = getSolanaConfig();
  const owner = new PublicKey(address);
  const mint = new PublicKey(config.usdcMint);

  try {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const account = await getAccount(connection, ata);
    const raw = account.amount;
    const formatted = Number(raw) / 1e6; // USDC has 6 decimals
    return { raw, formatted };
  } catch (err: any) {
    // Token account doesn't exist — balance is 0
    if (err.name === 'TokenAccountNotFoundError' || err.message?.includes('could not find account')) {
      return { raw: BigInt(0), formatted: 0 };
    }
    throw err;
  }
}

// ============================================
// Transfer
// ============================================

/**
 * Transfer USDC on Solana from a keypair-based wallet.
 * Used for external wallet settlement (non-Circle).
 *
 * Requires SOLANA_PRIVATE_KEY env var (base58 or byte array JSON).
 */
export async function transferSolanaUsdc(
  destinationAddress: string,
  amount: number,
): Promise<{ txHash: string; from: string; to: string }> {
  const connection = getSolanaConnection();
  const config = getSolanaConfig();
  const mint = new PublicKey(config.usdcMint);

  // Load sender keypair
  const senderKeypair = getSolanaKeypair();
  const sender = senderKeypair.publicKey;
  const destination = new PublicKey(destinationAddress);

  // Get or create associated token accounts
  const senderAta = getAssociatedTokenAddressSync(mint, sender);
  const destAta = getAssociatedTokenAddressSync(mint, destination);

  const { Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
  const tx = new Transaction();

  // Ensure destination ATA exists
  try {
    await getAccount(connection, destAta);
  } catch {
    tx.add(
      createAssociatedTokenAccountInstruction(
        sender,    // payer
        destAta,   // ATA to create
        destination, // owner
        mint,
      ),
    );
  }

  // USDC has 6 decimals
  const amountLamports = BigInt(Math.round(amount * 1e6));

  tx.add(
    createTransferInstruction(
      senderAta,
      destAta,
      sender,
      amountLamports,
      [],
      TOKEN_PROGRAM_ID,
    ),
  );

  const txHash = await sendAndConfirmTransaction(connection, tx, [senderKeypair], {
    commitment: 'confirmed',
  });

  return {
    txHash,
    from: sender.toBase58(),
    to: destinationAddress,
  };
}

// ============================================
// Keypair Management
// ============================================

/**
 * Load Solana keypair from SOLANA_PRIVATE_KEY env var.
 * Supports base58 secret key or JSON byte array.
 */
function getSolanaKeypair(): Keypair {
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      'SOLANA_PRIVATE_KEY environment variable is required for Solana transfers. ' +
      'Set it to a base58-encoded secret key or JSON byte array.',
    );
  }

  // JSON byte array (e.g., from `solana-keygen new --outfile`)
  if (key.startsWith('[')) {
    const bytes = new Uint8Array(JSON.parse(key));
    return Keypair.fromSecretKey(bytes);
  }

  // Hex-encoded secret key (64 hex chars = 32 bytes)
  if (/^[0-9a-fA-F]{64,128}$/.test(key)) {
    const bytes = new Uint8Array(Buffer.from(key, 'hex'));
    return Keypair.fromSecretKey(bytes);
  }

  // Assume base58 — decode via Buffer + alphabet
  throw new Error(
    'SOLANA_PRIVATE_KEY must be a JSON byte array (e.g., [1,2,3,...]) or hex string. ' +
    'Generate one with: solana-keygen new --outfile key.json',
  );
}

// ============================================
// Health Check
// ============================================

export async function solanaHealthCheck(): Promise<{
  healthy: boolean;
  cluster: string;
  rpcUrl: string;
  slot?: number;
  error?: string;
}> {
  try {
    const config = getSolanaConfig();
    const connection = getSolanaConnection();
    const slot = await connection.getSlot();

    return {
      healthy: true,
      cluster: config.cluster,
      rpcUrl: config.rpcUrl,
      slot,
    };
  } catch (error: any) {
    const config = getSolanaConfig();
    return {
      healthy: false,
      cluster: config.cluster,
      rpcUrl: config.rpcUrl,
      error: error.message,
    };
  }
}
