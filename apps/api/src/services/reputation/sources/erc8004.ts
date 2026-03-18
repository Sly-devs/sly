/**
 * Epic 63, Story 63.2 — ERC-8004 On-Chain Reputation Source
 * Reads identity + reputation data from Base contracts.
 * Supports both mainnet and testnet (Base Sepolia) via env vars.
 *
 * Identity Registry is ERC-721: agents are NFTs. balanceOf > 0 = registered.
 * Reputation Registry uses getSummary(agentId, clients, tag1, tag2) for feedback.
 */

import { createPublicClient, http, type Abi } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import type { ReputationSource, ReputationSourceResult } from '../types.js';

// Testnet (Base Sepolia)
const TESTNET_IDENTITY_REGISTRY = '0x13b52042ef3e0e84d7ad49fdc1b71848b187a89c';
const TESTNET_REPUTATION_REGISTRY = '0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322';

// Mainnet (Base)
const MAINNET_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const MAINNET_REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';

function isTestnet(): boolean {
  return process.env.ERC8004_NETWORK === 'testnet'
    || process.env.NODE_ENV === 'development'
    || process.env.NODE_ENV === 'test';
}

const IDENTITY_REGISTRY = (isTestnet() ? TESTNET_IDENTITY_REGISTRY : (process.env.ERC8004_IDENTITY_REGISTRY || MAINNET_IDENTITY_REGISTRY)) as `0x${string}`;
const REPUTATION_REGISTRY = (isTestnet() ? TESTNET_REPUTATION_REGISTRY : (process.env.ERC8004_REPUTATION_REGISTRY || MAINNET_REPUTATION_REGISTRY)) as `0x${string}`;

// ERC-721 Identity Registry ABI (read-only)
const identityAbi = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'index', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const satisfies Abi;

// Reputation Registry ABI (read-only)
const reputationAbi = [
  {
    name: 'getSummary',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddresses', type: 'address[]' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
    ],
    outputs: [
      { name: 'count', type: 'uint64' },
      { name: 'summaryValue', type: 'int128' },
      { name: 'summaryValueDecimals', type: 'uint8' },
    ],
  },
] as const satisfies Abi;

function getClient() {
  if (isTestnet()) {
    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    return createPublicClient({
      chain: baseSepolia,
      transport: http(rpcUrl),
    });
  }
  const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
  return createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
}

function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/**
 * Query the ERC-8004 source with an optional pre-resolved on-chain agent ID.
 * When erc8004AgentId is provided, we skip the balanceOf + tokenOfOwnerByIndex
 * lookups and go straight to the reputation summary.
 */
export function queryErc8004(
  identifier: string,
  erc8004AgentId?: string | null,
): Promise<ReputationSourceResult> {
  return erc8004Source.query(identifier, erc8004AgentId);
}

export const erc8004Source: ReputationSource & {
  query(identifier: string, erc8004AgentId?: string | null): Promise<ReputationSourceResult>;
} = {
  name: 'erc8004',

  async query(identifier: string, erc8004AgentId?: string | null): Promise<ReputationSourceResult> {
    const start = Date.now();

    // Fast path: we already have the on-chain agent ID from the DB
    if (erc8004AgentId) {
      try {
        const client = getClient();
        const agentId = BigInt(erc8004AgentId);

        // Go straight to reputation summary
        let feedbackCount = 0;
        let summaryValue = 0;
        let summaryDecimals = 0;

        const summary = await client.readContract({
          address: REPUTATION_REGISTRY,
          abi: reputationAbi,
          functionName: 'getSummary',
          args: [agentId, [], '', ''],
        }).catch(() => null);

        if (summary) {
          feedbackCount = Number((summary as any)[0]);
          summaryValue = Number((summary as any)[1]);
          summaryDecimals = Number((summary as any)[2]);
        }

        const dataPoints = 1 + feedbackCount;
        const identityScore = 700;

        const normalizedRep = summaryDecimals > 0
          ? summaryValue / (10 ** summaryDecimals)
          : summaryValue;
        const communityScore = feedbackCount > 0
          ? Math.max(0, Math.min(1000, Math.round((normalizedRep + 100) * 5)))
          : 0;

        const score = feedbackCount > 0
          ? Math.round(identityScore * 0.5 + communityScore * 0.5)
          : identityScore;

        return {
          source: 'erc8004',
          available: true,
          score,
          rawData: {
            hasIdentity: true,
            agentId: erc8004AgentId,
            feedbackCount,
            summaryValue,
            summaryDecimals,
            network: isTestnet() ? 'base-sepolia' : 'base',
            resolvedFromDb: true,
          },
          dataPoints,
          queriedAt: new Date().toISOString(),
          latencyMs: Date.now() - start,
          dimensions: {
            identity: identityScore,
            ...(feedbackCount > 0 ? { community_signal: communityScore } : {}),
          },
        };
      } catch (error: any) {
        // Fall through to the standard path
        console.warn('[ERC-8004] Fast-path query failed, falling back:', error.message);
      }
    }

    if (!isAddress(identifier)) {
      return {
        source: 'erc8004',
        available: false,
        score: null,
        rawData: { reason: 'identifier is not an Ethereum address' },
        dataPoints: 0,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }

    try {
      const client = getClient();
      const addr = identifier as `0x${string}`;

      // Step 1: Check if this address owns any agent identity NFTs
      const balance = await client.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityAbi,
        functionName: 'balanceOf',
        args: [addr],
      }).catch(() => 0n);

      const hasIdentity = Number(balance) > 0;

      if (!hasIdentity) {
        return {
          source: 'erc8004',
          available: false,
          score: null,
          rawData: { hasIdentity: false, balance: 0, network: isTestnet() ? 'base-sepolia' : 'base' },
          dataPoints: 0,
          queriedAt: new Date().toISOString(),
          latencyMs: Date.now() - start,
        };
      }

      // Step 2: Get the first agent token ID for this owner
      const agentId = await client.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityAbi,
        functionName: 'tokenOfOwnerByIndex',
        args: [addr, 0n],
      }).catch(() => null);

      // Step 3: Query reputation summary if we have an agent ID
      let feedbackCount = 0;
      let summaryValue = 0;
      let summaryDecimals = 0;

      if (agentId !== null) {
        const summary = await client.readContract({
          address: REPUTATION_REGISTRY,
          abi: reputationAbi,
          functionName: 'getSummary',
          args: [agentId, [addr], '', ''],
        }).catch(() => null);

        if (summary) {
          feedbackCount = Number((summary as any)[0]);
          summaryValue = Number((summary as any)[1]);
          summaryDecimals = Number((summary as any)[2]);
        }
      }

      const dataPoints = 1 + feedbackCount; // 1 for identity, plus feedback

      // Compute dimension scores
      // Identity: registered on-chain = 700 base
      const identityScore = 700;

      // Community signal: normalize summary value to 0-1000
      // summaryValue is a fixed-point number with summaryDecimals decimals
      const normalizedRep = summaryDecimals > 0
        ? summaryValue / (10 ** summaryDecimals)
        : summaryValue;
      // Assume reputation range roughly -100 to +100, map to 0-1000
      const communityScore = feedbackCount > 0
        ? Math.max(0, Math.min(1000, Math.round((normalizedRep + 100) * 5)))
        : 0;

      const score = feedbackCount > 0
        ? Math.round(identityScore * 0.5 + communityScore * 0.5)
        : identityScore;

      return {
        source: 'erc8004',
        available: true,
        score,
        rawData: {
          hasIdentity: true,
          agentId: agentId !== null ? String(agentId) : null,
          feedbackCount,
          summaryValue,
          summaryDecimals,
          network: isTestnet() ? 'base-sepolia' : 'base',
        },
        dataPoints,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
        dimensions: {
          identity: identityScore,
          ...(feedbackCount > 0 ? { community_signal: communityScore } : {}),
        },
      };
    } catch (error: any) {
      return {
        source: 'erc8004',
        available: false,
        score: null,
        rawData: { error: error.message, network: isTestnet() ? 'base-sepolia' : 'base' },
        dataPoints: 0,
        queriedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    }
  },
};
