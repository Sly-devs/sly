/**
 * Net Position Tracker (Epic 38, Story 38.11)
 *
 * Tracks net positions between wallet pairs from authorized payment intents.
 * Instead of settling 1000 micro-payments individually on-chain, the batcher
 * computes net positions and settles a single transfer per direction.
 *
 * Example: If wallet A sends $5 to B and B sends $2 to A across 100 intents,
 * the net position is A→B: $3, which becomes a single on-chain transfer.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical key for a wallet pair (always sorted for consistent netting) */
export type WalletPairKey = string;

export interface NetPosition {
  walletA: string;  // lexically smaller wallet ID
  walletB: string;  // lexically larger wallet ID
  /** Positive = A owes B, Negative = B owes A */
  netAmount: number;
  intentCount: number;
  intentIds: string[];
}

export interface NetPositionSummary {
  tenantId: string;
  positions: NetPosition[];
  totalGrossAmount: number;
  totalNetAmount: number;
  totalIntents: number;
  reductionRatio: number;  // 1 - (netTransfers / grossIntents)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Create a canonical wallet pair key (always sorted for consistent netting).
 */
export function walletPairKey(walletA: string, walletB: string): WalletPairKey {
  return walletA < walletB ? `${walletA}:${walletB}` : `${walletB}:${walletA}`;
}

// ---------------------------------------------------------------------------
// Compute Net Positions from DB
// ---------------------------------------------------------------------------

/**
 * Compute net positions from authorized payment intents for a tenant.
 * Reads all authorized intents, groups by wallet pair, and computes net amounts.
 */
export async function computeNetPositions(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<NetPositionSummary> {
  // Fetch all authorized intents for this tenant
  const { data: intents, error } = await supabase
    .from('payment_intents')
    .select('id, source_wallet_id, destination_wallet_id, amount')
    .eq('tenant_id', tenantId)
    .eq('status', 'authorized')
    .order('created_at', { ascending: true });

  if (error || !intents || intents.length === 0) {
    return {
      tenantId,
      positions: [],
      totalGrossAmount: 0,
      totalNetAmount: 0,
      totalIntents: 0,
      reductionRatio: 0,
    };
  }

  // Group by canonical wallet pair and compute net positions
  const pairMap = new Map<WalletPairKey, {
    walletA: string;
    walletB: string;
    netAmount: number;  // positive = A→B, negative = B→A
    intentCount: number;
    intentIds: string[];
  }>();

  let totalGrossAmount = 0;

  for (const intent of intents) {
    const src = intent.source_wallet_id;
    const dst = intent.destination_wallet_id;
    const amount = typeof intent.amount === 'string' ? parseFloat(intent.amount) : intent.amount;
    const key = walletPairKey(src, dst);

    totalGrossAmount += amount;

    let pair = pairMap.get(key);
    if (!pair) {
      pair = {
        walletA: src < dst ? src : dst,
        walletB: src < dst ? dst : src,
        netAmount: 0,
        intentCount: 0,
        intentIds: [],
      };
      pairMap.set(key, pair);
    }

    // If source is walletA, positive direction (A→B)
    // If source is walletB, negative direction (B→A)
    pair.netAmount += (src === pair.walletA) ? amount : -amount;
    pair.intentCount++;
    pair.intentIds.push(intent.id);
  }

  // Convert to array, filter out zero-net positions
  const positions: NetPosition[] = [];
  let totalNetAmount = 0;

  for (const pair of pairMap.values()) {
    if (Math.abs(pair.netAmount) < 0.001) {
      // Net zero — still track for batch marking but no on-chain transfer needed
      positions.push({ ...pair, netAmount: 0 });
      continue;
    }
    positions.push(pair);
    totalNetAmount += Math.abs(pair.netAmount);
  }

  const reductionRatio = intents.length > 0
    ? 1 - (positions.filter(p => Math.abs(p.netAmount) >= 0.001).length / intents.length)
    : 0;

  return {
    tenantId,
    positions,
    totalGrossAmount,
    totalNetAmount,
    totalIntents: intents.length,
    reductionRatio,
  };
}
