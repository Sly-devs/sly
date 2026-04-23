/**
 * Agent EOA Balance Sync Worker
 *
 * For every active `agent_eoa` wallet, reads on-chain USDC and mirrors it
 * into `wallets.balance` + `sync_data.on_chain_usdc` + `last_synced_at`.
 *
 * Motivation:
 *  - GET /v1/wallets/:id already does a synchronous on-chain read for EOAs,
 *    so per-page-view freshness is solid. But Tina may sit idle overnight
 *    while external transfers arrive or external x402 payments go out.
 *    Without a background sync the dashboard balance drifts off-chain until
 *    someone loads the detail page. For a multi-agent tenant view (e.g. the
 *    Wallets list) that's noticeable.
 *  - This worker keeps balances fresh without requiring a page load. It
 *    polls Base mainnet + Base Sepolia RPCs every 5 minutes, same cadence
 *    as smart-wallet-sync.
 *
 * Safety:
 *  - Per-wallet RPC failures are logged and skipped; one bad address does
 *    not block the rest.
 *  - No writes for wallets whose on-chain read is null (keeps the existing
 *    balance — better to show stale than to flash $0).
 */
import { createClient } from '../db/client.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let syncTimer: ReturnType<typeof setInterval> | null = null;

async function readOnchainUsdc(address: string, env: 'live' | 'test'): Promise<number | null> {
  try {
    const rpcUrl = env === 'live' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
    const usdc = env === 'live' ? USDC_BASE_MAINNET : USDC_BASE_SEPOLIA;
    const data = '0x70a08231' + '0'.repeat(24) + address.slice(2).toLowerCase();
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdc, data }, 'latest'] }),
    });
    const json: any = await res.json();
    if (!json?.result) return null;
    return parseInt(json.result, 16) / 1e6;
  } catch {
    return null;
  }
}

async function syncOnce(): Promise<void> {
  const supabase = createClient();
  let scanned = 0;
  let synced = 0;
  let failed = 0;
  try {
    const { data: rows, error } = await supabase
      .from('wallets')
      .select('id, tenant_id, wallet_address, environment, sync_data')
      .eq('wallet_type', 'agent_eoa')
      .eq('status', 'active');
    if (error) {
      console.warn(`[EoaSync] Fetch failed: ${error.message}`);
      return;
    }
    if (!rows || rows.length === 0) return;

    for (const row of rows as any[]) {
      scanned++;
      if (!row.wallet_address) continue;
      const env: 'live' | 'test' = row.environment === 'live' ? 'live' : 'test';
      const onchain = await readOnchainUsdc(row.wallet_address, env);
      if (onchain === null) {
        failed++;
        continue;
      }
      const nowIso = new Date().toISOString();
      const { error: upErr } = await (supabase.from('wallets') as any)
        .update({
          balance: onchain,
          last_synced_at: nowIso,
          sync_data: {
            ...(row.sync_data || {}),
            on_chain_usdc: String(onchain),
            synced_at: nowIso,
            source: 'eoa_sync_worker',
          },
        })
        .eq('id', row.id)
        .eq('tenant_id', row.tenant_id);
      if (upErr) {
        failed++;
      } else {
        synced++;
      }
    }
    if (scanned > 0) {
      console.log(`[EoaSync] scanned=${scanned} synced=${synced} failed=${failed}`);
    }
  } catch (e: any) {
    console.warn(`[EoaSync] Error: ${e.message?.slice(0, 120)}`);
  }
}

export function startAgentEoaSyncWorker(): void {
  if (syncTimer) return;
  console.log(`[EoaSync] Starting (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
  // Delay first tick by 20s so it doesn't pile on cold-start.
  setTimeout(() => {
    syncOnce();
  }, 20_000);
  syncTimer = setInterval(syncOnce, SYNC_INTERVAL_MS);
}

export function stopAgentEoaSyncWorker(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
    console.log('[EoaSync] Stopped');
  }
}
