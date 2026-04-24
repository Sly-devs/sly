/**
 * x402 Vendor Reputation Service — Epic 81
 *
 * Thin wrapper over the Postgres `x402_vendor_reliability` function.
 * Returns per-host aggregates and derives a recommendation code
 * (trusted / caution / avoid / unknown) callers can use to short-circuit
 * paid calls to known-broken vendors.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type Recommendation = 'trusted' | 'caution' | 'avoid' | 'unknown';

export interface VendorReputation {
  host: string;
  marketplace: string | null;
  settlementNetwork: string | null;
  totalCalls: number;
  completedCount: number;
  cancelledCount: number;
  pendingCount: number;
  successRate: number;                    // 0–1
  avgResponseSize: number | null;
  avgDurationMs: number | null;
  classificationHistogram: Record<string, number>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  firstSeenAt: string | null;
  // Actually moved on-chain. Completed rows with tx_hash set.
  totalUsdcSpent: number;
  // Signed authorizations the vendor never redeemed. Chain was NOT
  // settled — money stayed in the caller's wallet. Treat as
  // "leakage risk surface" (stale auths could theoretically be
  // redeemed until validBefore expires), not realized loss.
  totalUsdcAuthorizedUnredeemed: number;
  // On-chain settlement happened (tx_hash set) AND the call was still
  // cancelled — rare, but when this is non-zero it is actual
  // paid-and-got-nothing. THIS is real waste.
  totalUsdcPaidUnreturned: number;
  // Back-compat alias — equals totalUsdcAuthorizedUnredeemed +
  // totalUsdcPaidUnreturned. Older dashboards read `.totalUsdcWasted`
  // expecting this combined figure; keep it but prefer the split.
  totalUsdcWasted: number;
  // Per-call quality signal (from x402_call_quality joins). `null` when
  // nothing has been rated yet — distinct from "rated badly."
  ratedCallCount: number;
  deliveredCorrectness: number | null; // 0–1, share of rated calls that delivered what was asked
  avgResultScore: number | null;       // 0–100, mean score across rated calls
  topQualityFlags: Record<string, number>;
  recommendation: Recommendation;
  reasoning: string;
}

// Thresholds — tuned from Tina's first ~60 calls. Move to per-tenant
// config later if needed.
const MIN_CALLS_FOR_RATING = 3;
const TRUSTED_SUCCESS = 0.9;
const AVOID_SUCCESS = 0.4;
// Quality gate — a vendor with HTTP ≥90% but correctness below this
// gets downgraded to caution. The HTTP-success bar alone can't catch
// vendors that return valid-looking-but-useless JSON. See Epic 81 plan.
const CORRECTNESS_CAUTION = 0.6;
const MIN_RATED_FOR_QUALITY_GATE = 3;

function classify(row: any): { recommendation: Recommendation; reasoning: string } {
  const total = Number(row.total_calls) || 0;
  const completed = Number(row.completed_count) || 0;
  const cancelled = Number(row.cancelled_count) || 0;
  const rate = Number(row.success_rate) || 0;
  const hist = (row.classification_histogram || {}) as Record<string, number>;
  const ratedCount = Number(row.rated_call_count) || 0;
  const correctness = row.delivered_correctness != null ? Number(row.delivered_correctness) : null;

  if (total < MIN_CALLS_FOR_RATING) {
    return {
      recommendation: 'unknown',
      reasoning: `Only ${total} call${total === 1 ? '' : 's'} in window — not enough signal yet.`,
    };
  }

  if (rate >= TRUSTED_SUCCESS) {
    // HTTP looks fine — but if enough callers have rated the results
    // and correctness is poor, downgrade. This is the "deceptive
    // reliability" case the quality layer exists to catch.
    if (correctness != null && ratedCount >= MIN_RATED_FOR_QUALITY_GATE && correctness < CORRECTNESS_CAUTION) {
      const wrongShare = ((1 - correctness) * 100).toFixed(0);
      return {
        recommendation: 'caution',
        reasoning: `${completed}/${total} HTTP-completed (${(rate * 100).toFixed(0)}%), but ${wrongShare}% of ${ratedCount} rated calls didn't deliver what was asked. Response looked valid but contents were poor.`,
      };
    }
    const qualNote = correctness != null && ratedCount >= MIN_RATED_FOR_QUALITY_GATE
      ? ` Correctness: ${(correctness * 100).toFixed(0)}% (${ratedCount} rated).`
      : '';
    return {
      recommendation: 'trusted',
      reasoning: `${completed}/${total} calls completed (${(rate * 100).toFixed(0)}%).${qualNote} Safe to use.`,
    };
  }

  if (rate >= AVOID_SUCCESS) {
    const topFailure = Object.entries(hist).sort(([, a], [, b]) => b - a)[0];
    const topNote = topFailure ? ` Most common failure: ${topFailure[0]} (${topFailure[1]}).` : '';
    return {
      recommendation: 'caution',
      reasoning: `${completed}/${total} completed (${(rate * 100).toFixed(0)}%).${topNote} Expect intermittent failures.`,
    };
  }

  // Avoid — most calls failing.
  const histNotes = Object.entries(hist)
    .sort(([, a], [, b]) => b - a)
    .map(([code, count]) => `${code}: ${count}`)
    .join(', ');
  return {
    recommendation: 'avoid',
    reasoning: `${cancelled}/${total} calls cancelled (${((1 - rate) * 100).toFixed(0)}% failure). Classifications — ${histNotes || 'unclassified'}. Prefer an alternative.`,
  };
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function mapRow(row: any): VendorReputation {
  const { recommendation, reasoning } = classify(row);
  const authorizedUnredeemed = Number(row.total_usdc_authorized_unredeemed) || 0;
  const paidUnreturned = Number(row.total_usdc_paid_unreturned) || 0;
  return {
    host: row.host,
    marketplace: row.marketplace ?? null,
    settlementNetwork: row.settlement_network ?? null,
    totalCalls: Number(row.total_calls) || 0,
    completedCount: Number(row.completed_count) || 0,
    cancelledCount: Number(row.cancelled_count) || 0,
    pendingCount: Number(row.pending_count) || 0,
    successRate: Number(row.success_rate) || 0,
    avgResponseSize: row.avg_response_size != null ? Number(row.avg_response_size) : null,
    avgDurationMs: row.avg_duration_ms != null ? Number(row.avg_duration_ms) : null,
    classificationHistogram: (row.classification_histogram || {}) as Record<string, number>,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    firstSeenAt: row.first_seen_at,
    totalUsdcSpent: Number(row.total_usdc_spent) || 0,
    totalUsdcAuthorizedUnredeemed: authorizedUnredeemed,
    totalUsdcPaidUnreturned: paidUnreturned,
    totalUsdcWasted: authorizedUnredeemed + paidUnreturned,
    ratedCallCount: Number(row.rated_call_count) || 0,
    deliveredCorrectness: row.delivered_correctness != null ? Number(row.delivered_correctness) : null,
    avgResultScore: row.avg_result_score != null ? Number(row.avg_result_score) : null,
    topQualityFlags: (row.top_quality_flags || {}) as Record<string, number>,
    recommendation,
    reasoning,
  };
}

export interface ReputationQueryOptions {
  sinceDays?: number;       // default: 30
  environment?: 'live' | 'test';
}

export async function listVendorReputation(
  supabase: SupabaseClient,
  tenantId: string,
  opts: ReputationQueryOptions = {},
): Promise<VendorReputation[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 30) * 86400_000).toISOString();
  const { data, error } = await (supabase.rpc('x402_vendor_reliability', {
    p_tenant_id: tenantId,
    p_since: since,
    p_environment: opts.environment ?? null,
  }) as any);
  if (error) {
    console.error('[reputation] RPC failed:', error);
    throw new Error(`Failed to read vendor reliability: ${error.message}`);
  }
  return (data || []).map(mapRow);
}

export async function getVendorReputation(
  supabase: SupabaseClient,
  tenantId: string,
  host: string,
  opts: ReputationQueryOptions = {},
): Promise<VendorReputation> {
  const target = normalizeHost(host);
  const all = await listVendorReputation(supabase, tenantId, opts);
  const match = all.find((r) => normalizeHost(r.host) === target);
  if (match) return match;
  // Host not seen — synthesize an "unknown" reading so callers have a
  // consistent shape to key off.
  return {
    host: target,
    marketplace: null,
    settlementNetwork: null,
    totalCalls: 0,
    completedCount: 0,
    cancelledCount: 0,
    pendingCount: 0,
    successRate: 0,
    avgResponseSize: null,
    avgDurationMs: null,
    classificationHistogram: {},
    lastSuccessAt: null,
    lastFailureAt: null,
    firstSeenAt: null,
    totalUsdcSpent: 0,
    totalUsdcAuthorizedUnredeemed: 0,
    totalUsdcPaidUnreturned: 0,
    totalUsdcWasted: 0,
    ratedCallCount: 0,
    deliveredCorrectness: null,
    avgResultScore: null,
    topQualityFlags: {},
    recommendation: 'unknown',
    reasoning: 'No calls to this host from this tenant in the window.',
  };
}
