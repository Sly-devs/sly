/**
 * x402 EOA Signer Service
 *
 * Generates secp256k1 keypairs, derives EVM addresses, and signs EIP-3009
 * `transferWithAuthorization` payloads on behalf of agents. Private keys are
 * encrypted via credential-vault and stored in agent_signing_keys.
 *
 * This makes Sly a first-class x402 client — agents can now produce spec-
 * compliant PAYMENT-SIGNATURE headers to pay external x402-protected
 * resources, not just our internal /v1/x402/pay marketplace API.
 *
 * Design decisions:
 * - One secp256k1 key per agent (enforced by (agent_id, algorithm) unique index)
 * - EIP-3009 is the primary signing scheme (most widely supported by USDC)
 * - Permit2 and ERC-7710 can be added later without breaking this API
 * - Private key is decrypted in-memory only during signing, never logged
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptAndSerialize, deserializeAndDecrypt } from '../credential-vault/index.js';

export type Secp256k1KeyRecord = {
  key_id: string;
  public_key: string;     // 0x04... uncompressed public key (hex)
  ethereum_address: string; // 0x... derived address
  private_key_encrypted: string;
};

/**
 * Generate a new secp256k1 keypair, encrypt the private key via credential-vault,
 * and return the encrypted record ready for DB insertion.
 *
 * The plaintext private key is NEVER returned from this function — only the
 * public parts (address, public key) and the encrypted blob.
 */
export function generateAgentEvmKey(agentId: string): Omit<Secp256k1KeyRecord, 'key_id'> & { key_id: string } {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const encrypted = encryptAndSerialize({ privateKey });

  return {
    key_id: `sly_evm_${agentId.slice(0, 8)}_${Date.now()}`,
    public_key: account.publicKey,
    ethereum_address: account.address,
    private_key_encrypted: encrypted,
  };
}

// Per-agent signing key cache (keys rotate very rarely — 30s TTL is safe)
const EVM_KEY_CACHE = new Map<string, { record: Secp256k1KeyRecord; expiresAt: number }>();
const EVM_KEY_CACHE_TTL_MS = 30_000;

/**
 * Fetch the active secp256k1 key for an agent from the DB.
 * Returns null if no key exists. Results are cached for 30 seconds.
 */
export async function getAgentEvmKey(
  supabase: SupabaseClient,
  agentId: string,
): Promise<Secp256k1KeyRecord | null> {
  // Check cache first
  const cached = EVM_KEY_CACHE.get(agentId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.record;
  }

  const { data } = await (supabase.from('agent_signing_keys') as any)
    .select('key_id, public_key, ethereum_address, private_key_encrypted')
    .eq('agent_id', agentId)
    .eq('algorithm', 'secp256k1')
    .eq('status', 'active')
    .maybeSingle();

  if (data) {
    EVM_KEY_CACHE.set(agentId, { record: data, expiresAt: Date.now() + EVM_KEY_CACHE_TTL_MS });
  }
  return data || null;
}

// ---------------------------------------------------------------------------
// EIP-3009 transferWithAuthorization signing
// ---------------------------------------------------------------------------

/**
 * Parameters for an EIP-3009 transferWithAuthorization signature.
 * These match the USDC contract's `transferWithAuthorization` function.
 * See: https://eips.ethereum.org/EIPS/eip-3009
 */
export interface TransferWithAuthorizationParams {
  from: string;        // payer EOA — must match the signing key's address
  to: string;          // payee address (the x402 endpoint's payment_address)
  value: string;       // amount in token units as decimal string (e.g. "100000" for 0.1 USDC at 6 decimals)
  validAfter: number;  // unix seconds, payload rejected before this time
  validBefore: number; // unix seconds, payload rejected after this time (deadline)
  nonce: string;       // 32-byte hex string, must be unique per payload
  tokenAddress: string; // USDC contract address on the target chain
  tokenName: string;    // e.g. "USD Coin"
  tokenVersion: string; // e.g. "2"
  chainId: number;      // e.g. 84532 (Base Sepolia) or 8453 (Base mainnet)
}

export interface SignedTransferAuth {
  signature: `0x${string}`;
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
  from: string;
  params: TransferWithAuthorizationParams;
}

/**
 * Sign an EIP-3009 transferWithAuthorization payload using the agent's EOA key.
 * This produces a signature that a recipient can submit on-chain to pull funds
 * from the agent's wallet without requiring the agent to send a transaction.
 *
 * The signature is the spec-compliant PAYMENT-SIGNATURE value for x402 servers
 * using the "exact" EVM scheme with EIP-3009.
 */
export async function signTransferWithAuthorization(
  keyRecord: Secp256k1KeyRecord,
  params: TransferWithAuthorizationParams,
): Promise<SignedTransferAuth> {
  // Verify the from address matches the key's address — reject mismatches
  // to prevent agents from signing payloads that claim to be from a different
  // wallet (signature would be valid but useless on-chain).
  if (params.from.toLowerCase() !== keyRecord.ethereum_address.toLowerCase()) {
    throw new Error(
      `Signing key address (${keyRecord.ethereum_address}) does not match payload.from (${params.from})`,
    );
  }

  // Decrypt private key in-memory, use it, then let it go out of scope.
  const decrypted = deserializeAndDecrypt(keyRecord.private_key_encrypted);
  const privateKey = decrypted.privateKey as `0x${string}`;
  if (!privateKey || !privateKey.startsWith('0x')) {
    throw new Error('Invalid private key in vault');
  }

  const account = privateKeyToAccount(privateKey);

  // EIP-712 typed data for EIP-3009 transferWithAuthorization.
  // Domain separator matches USDC's EIP-712 domain on Base.
  const signature = await account.signTypedData({
    domain: {
      name: params.tokenName,
      version: params.tokenVersion,
      chainId: params.chainId,
      verifyingContract: params.tokenAddress as `0x${string}`,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: params.from as `0x${string}`,
      to: params.to as `0x${string}`,
      value: BigInt(params.value),
      validAfter: BigInt(params.validAfter),
      validBefore: BigInt(params.validBefore),
      nonce: params.nonce as `0x${string}`,
    },
  });

  // Split the 65-byte signature into v/r/s components
  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);

  return {
    signature,
    v,
    r,
    s,
    from: account.address,
    params,
  };
}

// ---------------------------------------------------------------------------
// USDC contract addresses per chain
// ---------------------------------------------------------------------------

export const USDC_CONTRACTS: Record<number, { address: string; name: string; version: string; decimals: number }> = {
  // Base Mainnet
  8453: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    name: 'USD Coin',
    version: '2',
    decimals: 6,
  },
  // Base Sepolia
  84532: {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    name: 'USDC',
    version: '2',
    decimals: 6,
  },
};

/**
 * Build the EIP-712 domain parameters for a USDC transferWithAuthorization
 * on a given chain. Handles the version/name differences between mainnet and
 * testnet USDC contracts.
 */
export function usdcDomain(chainId: number): { tokenAddress: string; tokenName: string; tokenVersion: string } {
  const entry = USDC_CONTRACTS[chainId];
  if (!entry) {
    throw new Error(`No USDC contract configured for chainId ${chainId}`);
  }
  return {
    tokenAddress: entry.address,
    tokenName: entry.name,
    tokenVersion: entry.version,
  };
}

/**
 * Generate a fresh 32-byte nonce for EIP-3009. Must be unique per signed
 * authorization — typically random or a counter.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
