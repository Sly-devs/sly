/**
 * ERC-8004 On-Chain Agent Registration Service
 *
 * Registers agents on the ERC-8004 Identity Registry (Base Sepolia / Base Mainnet).
 * The platform wallet (EVM_PRIVATE_KEY) acts as custodian, owning all agent NFTs.
 * Each agent gets a unique on-chain token ID stored as `erc8004_agent_id`.
 */

import { type Abi, decodeEventLog } from 'viem';
import { getWalletClient, getPublicClient, getChainConfig } from '../../config/blockchain.js';
import { createClient } from '../../db/client.js';

// Contract addresses (same as in reputation source)
const TESTNET_IDENTITY_REGISTRY = '0x13b52042ef3e0e84d7ad49fdc1b71848b187a89c';
const MAINNET_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

function isTestnet(): boolean {
  return process.env.ERC8004_NETWORK === 'testnet'
    || process.env.NODE_ENV === 'development'
    || process.env.NODE_ENV === 'test';
}

function getRegistryAddress(): `0x${string}` {
  if (isTestnet()) return TESTNET_IDENTITY_REGISTRY as `0x${string}`;
  return (process.env.ERC8004_IDENTITY_REGISTRY || MAINNET_IDENTITY_REGISTRY) as `0x${string}`;
}

// ERC-8004 Identity Registry ABI (write + event)
const registryAbi = [
  {
    name: 'register',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    name: 'Registered',
    type: 'event',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const satisfies Abi;

/**
 * Check whether on-chain registration is enabled.
 * Requires EVM_PRIVATE_KEY and a non-mock environment.
 */
export function isRegistrationEnabled(): boolean {
  if (!process.env.EVM_PRIVATE_KEY) return false;
  const env = process.env.PAYOS_ENVIRONMENT || 'mock';
  return env === 'sandbox' || env === 'production';
}

/**
 * Build the agent card URI that the on-chain NFT points to.
 */
function buildAgentURI(agentId: string): string {
  const baseUrl = process.env.API_BASE_URL
    || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
    || 'http://localhost:4000';
  return `${baseUrl}/agents/${agentId}/card.json`;
}

/**
 * Register an agent on-chain via ERC-8004 Identity Registry.
 *
 * - Mints an NFT via `register(agentURI)`
 * - Extracts the token ID from the `Registered` event log
 * - Updates `agents.erc8004_agent_id` in the database
 *
 * Returns the on-chain agent ID (uint256 as string) or null on failure.
 */
export async function registerAgent(
  agentId: string,
  name: string,
  description: string,
  options?: { nonce?: number },
): Promise<string | null> {
  if (!isRegistrationEnabled()) {
    console.log('[ERC-8004] Registration disabled (no EVM_PRIVATE_KEY or mock mode)');
    return null;
  }

  const agentURI = buildAgentURI(agentId);
  const registry = getRegistryAddress();
  const config = getChainConfig();

  console.log(`[ERC-8004] Registering agent ${agentId} on ${config.chainName}...`);
  console.log(`[ERC-8004] URI: ${agentURI}`);

  const walletClient = getWalletClient();
  const publicClient = getPublicClient();

  // Send the register transaction
  const txHash = await walletClient.writeContract({
    address: registry,
    abi: registryAbi,
    functionName: 'register',
    args: [agentURI],
    ...(options?.nonce != null ? { nonce: options.nonce } : {}),
  });

  console.log(`[ERC-8004] Tx submitted: ${config.blockExplorerUrl}/tx/${txHash}`);

  // Wait for confirmation and get receipt
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

  // Extract the Registered event to get the on-chain agent ID
  let onChainAgentId: string | null = null;

  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: registryAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'Registered') {
        onChainAgentId = String((decoded.args as any).agentId);
        break;
      }
    } catch {
      // Not our event, skip
    }
  }

  if (!onChainAgentId) {
    console.warn('[ERC-8004] Could not extract agentId from Registered event');
    return null;
  }

  // Persist the on-chain ID to the database
  const supabase = createClient();
  const { error } = await supabase
    .from('agents')
    .update({ erc8004_agent_id: onChainAgentId })
    .eq('id', agentId);

  if (error) {
    console.warn('[ERC-8004] DB update failed (agent still registered on-chain):', error.message);
  }

  console.log(`[ERC-8004] Agent ${agentId} registered on-chain with ID ${onChainAgentId}`);
  console.log(`[ERC-8004] View: ${config.blockExplorerUrl}/tx/${txHash}`);

  return onChainAgentId;
}
