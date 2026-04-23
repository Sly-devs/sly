import { createClient } from '../db/client.js';

interface BalanceCacheEntry {
  balance: number;
  expiresAt: number;
}

const BALANCE_CACHE = new Map<string, BalanceCacheEntry>();
const BALANCE_CACHE_TTL_MS = 60 * 1000;

function invalidate(tenantId: string) {
  BALANCE_CACHE.delete(tenantId);
}

export async function getBalance(tenantId: string): Promise<number> {
  const cached = BALANCE_CACHE.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.balance;

  const supabase = createClient();
  const { data, error } = await (supabase.from('scanner_credit_ledger') as any)
    .select('delta')
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[scanner-ledger] Failed to read balance:', error.message);
    // Fail open: treat as 0 so requests are rejected rather than free-riding.
    return 0;
  }

  const balance = ((data as Array<{ delta: number }>) ?? []).reduce(
    (sum, row) => sum + row.delta,
    0,
  );
  BALANCE_CACHE.set(tenantId, {
    balance,
    expiresAt: Date.now() + BALANCE_CACHE_TTL_MS,
  });
  return balance;
}

export async function getBalanceSummary(tenantId: string): Promise<{
  balance: number;
  grantedTotal: number;
  consumedTotal: number;
}> {
  const supabase = createClient();
  const { data } = await (supabase.from('scanner_credit_ledger') as any)
    .select('delta, reason')
    .eq('tenant_id', tenantId);

  const rows = (data as Array<{ delta: number; reason: string }>) ?? [];
  let grantedTotal = 0;
  let consumedTotal = 0;
  let balance = 0;
  for (const row of rows) {
    balance += row.delta;
    if (row.delta > 0) grantedTotal += row.delta;
    else consumedTotal += -row.delta;
  }
  return { balance, grantedTotal, consumedTotal };
}

/**
 * Atomic debit via the SQL function scanner_credit_debit.
 * Returns the new balance, or null if insufficient credits.
 */
export async function debit(
  tenantId: string,
  cost: number,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<number | null> {
  if (cost <= 0) return await getBalance(tenantId);

  const supabase = createClient();
  const { data, error } = await (supabase.rpc as any)('scanner_credit_debit', {
    p_tenant_id: tenantId,
    p_cost: cost,
    p_source: source,
    p_metadata: metadata,
  });

  if (error) {
    console.error('[scanner-ledger] debit() failed:', error.message);
    return null;
  }

  invalidate(tenantId);
  const newBalance = Number(data);
  if (newBalance < 0) return null;
  return newBalance;
}

/**
 * Grant credits. Typically called by the grant-credits.ts CLI or from a
 * payment webhook.
 */
export async function grant(
  tenantId: string,
  amount: number,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const supabase = createClient();
  const { data, error } = await (supabase.rpc as any)('scanner_credit_grant', {
    p_tenant_id: tenantId,
    p_amount: amount,
    p_source: source,
    p_metadata: metadata,
  });

  if (error) {
    throw new Error(`[scanner-ledger] grant() failed: ${error.message}`);
  }

  invalidate(tenantId);
  return Number(data);
}

/**
 * Refund — used when a batch is cancelled before execution.
 */
export async function refund(
  tenantId: string,
  amount: number,
  source: string,
  metadata: Record<string, unknown> = {},
): Promise<number> {
  const supabase = createClient();

  const { data: current } = await (supabase.from('scanner_credit_ledger') as any)
    .select('delta')
    .eq('tenant_id', tenantId);
  const currentBalance = ((current as Array<{ delta: number }>) ?? []).reduce(
    (s, r) => s + r.delta,
    0,
  );

  const { error } = await (supabase.from('scanner_credit_ledger') as any).insert({
    tenant_id: tenantId,
    delta: amount,
    reason: 'refund',
    source,
    balance_after: currentBalance + amount,
    metadata,
  });

  if (error) throw new Error(`[scanner-ledger] refund() failed: ${error.message}`);

  invalidate(tenantId);
  return currentBalance + amount;
}

export async function listLedger(
  tenantId: string,
  opts: { from?: string; to?: string; limit?: number; offset?: number } = {},
): Promise<
  Array<{
    id: string;
    delta: number;
    reason: string;
    source: string | null;
    balance_after: number;
    metadata: Record<string, unknown>;
    created_at: string;
  }>
> {
  const supabase = createClient();
  let q = (supabase.from('scanner_credit_ledger') as any)
    .select('id, delta, reason, source, balance_after, metadata, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100)
    .range(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 100) - 1);

  if (opts.from) q = q.gte('created_at', opts.from);
  if (opts.to) q = q.lte('created_at', opts.to);

  const { data } = await q;
  return (data as any[]) ?? [];
}
