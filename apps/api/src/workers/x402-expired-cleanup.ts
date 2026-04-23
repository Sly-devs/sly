/**
 * External x402 Expired Auth Cleanup Worker
 *
 * /x402-sign writes a transfers row with status='pending' before the caller
 * submits the X-PAYMENT header to the facilitator. If the caller never
 * actually submits (e.g. they used the low-level sign tool and walked off,
 * or the target URL returned a non-2xx so settlement never happened), the
 * signed authorization has a valid_before deadline — past that timestamp
 * no facilitator can submit it on-chain anymore. Without this sweep, those
 * rows sit as `pending` forever, polluting the dashboard and making it
 * look like real money is unaccounted for.
 *
 * This worker periodically cancels external x402 rows whose valid_before
 * timestamp is in the past. The row flips to 'cancelled' with a clear
 * failure_reason. Settled rows (status='completed' or with tx_hash) are
 * never touched — the tx_hash column is the ground truth for "this
 * actually moved money on-chain."
 */

import { createClient } from '../db/client.js';

/**
 * Find and cancel all expired pending external x402 rows.
 * Returns the number cancelled.
 */
export async function cleanupExpiredX402Auths(): Promise<number> {
  const supabase = createClient();
  const nowSec = Math.floor(Date.now() / 1000);

  // Find pending external x402 rows where valid_before has passed.
  // Have to read them first because Supabase can't do a JSONB numeric
  // comparison through PostgREST's filter operators in all cases — safer
  // to filter server-side than try to express this in a single update.
  const { data: candidates, error: fetchErr } = await (supabase.from('transfers') as any)
    .select('id, protocol_metadata, created_at')
    .eq('type', 'x402')
    .eq('status', 'pending')
    .contains('protocol_metadata', { direction: 'external' });

  if (fetchErr) {
    console.error('[x402-expired-cleanup] fetch failed:', fetchErr.message);
    return 0;
  }
  if (!candidates || candidates.length === 0) return 0;

  const expiredIds = candidates
    .filter((r: any) => {
      const vb = Number(r.protocol_metadata?.valid_before);
      return Number.isFinite(vb) && vb > 0 && vb < nowSec;
    })
    .map((r: any) => r.id);

  if (expiredIds.length === 0) return 0;

  const { error: updateErr } = await (supabase.from('transfers') as any)
    .update({
      status: 'cancelled',
      failed_at: new Date().toISOString(),
      failure_reason: 'signature_expired — valid_before window passed without on-chain settlement',
    })
    .in('id', expiredIds)
    .eq('status', 'pending'); // defensive re-check

  if (updateErr) {
    console.error('[x402-expired-cleanup] update failed:', updateErr.message);
    return 0;
  }

  console.log(`[x402-expired-cleanup] cancelled ${expiredIds.length} expired pending authorization(s)`);
  return expiredIds.length;
}

/**
 * Start the cleanup worker on a schedule.
 * Default cadence is 2 minutes — slow enough to not hammer the DB, fast
 * enough that stale rows clear within a minute of expiry in practice.
 *
 * @returns Function to stop the worker.
 */
export function startX402ExpiredCleanupWorker(intervalMs: number = 2 * 60 * 1000): () => void {
  console.log(`[x402-expired-cleanup] Starting with ${intervalMs / 1000}s interval`);

  // Kick one off immediately so a cold start cleans up any rows that
  // expired while the process was down.
  cleanupExpiredX402Auths().catch((e) => {
    console.error('[x402-expired-cleanup] initial run error:', e);
  });

  const interval = setInterval(async () => {
    try {
      await cleanupExpiredX402Auths();
    } catch (error) {
      console.error('[x402-expired-cleanup] tick error:', error);
    }
  }, intervalMs);

  return () => {
    console.log('[x402-expired-cleanup] Stopping');
    clearInterval(interval);
  };
}
