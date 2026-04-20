/**
 * Merchant analytics aggregation — single source of truth for per-merchant
 * sales / volume / endpoint numbers. Used by both the tenant-facing
 * `GET /v1/accounts/:id/merchant-stats` route and the end-of-round report
 * in `round-viewer.ts`.
 *
 * Input: a merchant account UUID + a cutoff ISO timestamp (inclusive).
 * Output: the shape consumed by the merchant detail page and the LLM
 * analyzer, with ACP / UCP / x402 volumes broken out plus top buyers and
 * recent sales.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface MerchantStatsInput {
  accountId: string;
  cutoff: string;           // ISO string; fetch rows with created_at >= cutoff
  tenantId?: string;        // optional guard; when provided we enforce cross-tenant isolation
}

export interface MerchantStatsResult {
  merchant: {
    id: string;
    name: string;
    type: string | null;
    subtype: string | null;
    rating: number | null;
    pos_provider: string | null;
    merchant_type: string | null;
    description: string | null;
    country: string | null;
    city: string | null;
    catalog: { products: any[] };
  } | null;
  isMerchant: boolean;
  volume: { total: number; acp: number; ucp: number; x402: number };
  counts: { total: number; acp: number; ucp: number; x402: number };
  topBuyers: Array<{ agentId: string; name: string; sales: number; spend: number }>;
  recentSales: Array<{ protocol: 'acp' | 'ucp' | 'x402'; amount: number; buyerName: string | null; at: string; item: string }>;
  endpoints: Array<{ id: string; name: string; path: string; method: string; base_price: number; total_calls: number; total_revenue: number; status: string }>;
  /** Discovery + abandonment: how often agents looked at this merchant without buying. */
  discovery: {
    views: number;
    uniqueViewers: number;
    conversionRate: number;            // purchases / views (0-1)
    funnel: { views: number; checkouts: number; completed: number; abandoned: number };
    abandonedCarts: {
      count: number;
      value: number;                    // total_amount sum of abandoned carts
      recent: Array<{
        checkoutId: string;
        buyerName: string | null;
        amount: number;
        items: string;                  // comma-joined item names
        createdAt: string;
        expiredAt: string | null;
      }>;
    };
  };
}

/**
 * Compute merchant stats. Returns a result with `isMerchant: false` when
 * the account exists but isn't a merchant (subtype !== 'merchant' AND no
 * pos_provider metadata) — caller decides how to surface that (404 on the
 * public API, 'N/A' in the report).
 */
export async function computeMerchantStats(
  supabase: SupabaseClient,
  input: MerchantStatsInput,
): Promise<MerchantStatsResult> {
  const { accountId, cutoff, tenantId } = input;

  // ─── 1. Resolve merchant account + catalog ────────────────────────────
  let accountQuery = supabase
    .from('accounts')
    .select('id, name, type, subtype, currency, metadata')
    .eq('id', accountId) as any;
  if (tenantId) accountQuery = accountQuery.eq('tenant_id', tenantId);
  const { data: accountRow } = await accountQuery.maybeSingle();

  const emptyDiscovery = {
    views: 0,
    uniqueViewers: 0,
    conversionRate: 0,
    funnel: { views: 0, checkouts: 0, completed: 0, abandoned: 0 },
    abandonedCarts: { count: 0, value: 0, recent: [] as any[] },
  };
  const empty: MerchantStatsResult = {
    merchant: null,
    isMerchant: false,
    volume: { total: 0, acp: 0, ucp: 0, x402: 0 },
    counts: { total: 0, acp: 0, ucp: 0, x402: 0 },
    topBuyers: [],
    recentSales: [],
    endpoints: [],
    discovery: emptyDiscovery,
  };
  if (!accountRow) return empty;

  const isMerchant =
    accountRow.subtype === 'merchant' ||
    (accountRow.metadata?.pos_provider != null);

  const rawCatalog = accountRow.metadata?.catalog;
  const products: any[] = Array.isArray(rawCatalog)
    ? rawCatalog
    : Array.isArray(rawCatalog?.products)
      ? rawCatalog.products
      : [];

  const merchant = {
    id: accountRow.id,
    name: accountRow.name,
    type: accountRow.type ?? null,
    subtype: accountRow.subtype ?? null,
    rating: typeof accountRow.metadata?.rating === 'number' ? accountRow.metadata.rating : null,
    pos_provider: accountRow.metadata?.pos_provider ?? null,
    merchant_type: accountRow.metadata?.merchant_type ?? null,
    description: accountRow.metadata?.description ?? null,
    country: accountRow.metadata?.country ?? null,
    city: accountRow.metadata?.city ?? null,
    catalog: { products },
  };

  if (!isMerchant) {
    return { ...empty, merchant, isMerchant: false };
  }

  // ─── 2. Pull per-protocol rows in parallel ────────────────────────────
  // ACP: checkouts with merchant_account_id OR (pre-backfill) merchant_id TEXT
  // matching metadata.invu_merchant_id. Prefer the UUID column.
  const posTextId = accountRow.metadata?.invu_merchant_id ?? null;

  // Discovery + abandonment side queries (scoped here so posTextId is in scope).
  // catalog_views for this merchant in the window.
  let viewsQuery = (supabase.from('catalog_views') as any)
    .select('viewer_agent_id, created_at')
    .eq('merchant_account_id', accountId)
    .gte('created_at', cutoff);
  if (tenantId) viewsQuery = viewsQuery.eq('tenant_id', tenantId);
  viewsQuery = viewsQuery.order('created_at', { ascending: false }).limit(2000);

  // Abandoned ACP carts: status=pending AND expires_at < now (OR null expiry +
  // > 1 hour old, so checkouts that never settled don't sit as "pending" forever).
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  let abandonedAcpQuery = (supabase.from('acp_checkouts') as any)
    .select('id, checkout_id, agent_id, agent_name, total_amount, created_at, expires_at, metadata, merchant_id, merchant_account_id')
    .eq('status', 'pending')
    .or(`expires_at.lt.${new Date().toISOString()},and(expires_at.is.null,created_at.lt.${oneHourAgo})`)
    .gte('created_at', cutoff);
  if (tenantId) abandonedAcpQuery = abandonedAcpQuery.eq('tenant_id', tenantId);
  // Match either the UUID column or legacy TEXT merchant_id.
  if (posTextId) {
    abandonedAcpQuery = abandonedAcpQuery.or(`merchant_account_id.eq.${accountId},merchant_id.eq.${posTextId}`);
  } else {
    abandonedAcpQuery = abandonedAcpQuery.eq('merchant_account_id', accountId);
  }
  abandonedAcpQuery = abandonedAcpQuery.order('created_at', { ascending: false }).limit(20);
  let acpQuery = supabase
    .from('acp_checkouts')
    .select('id, status, total_amount, agent_id, agent_name, merchant_id, merchant_account_id, created_at, metadata')
    .gte('created_at', cutoff)
    .in('status', ['completed', 'pending']) as any;
  if (tenantId) acpQuery = acpQuery.eq('tenant_id', tenantId);
  // Either the UUID matches OR (legacy) the TEXT matches.
  if (posTextId) {
    acpQuery = acpQuery.or(`merchant_account_id.eq.${accountId},merchant_id.eq.${posTextId}`);
  } else {
    acpQuery = acpQuery.eq('merchant_account_id', accountId);
  }
  acpQuery = acpQuery.order('created_at', { ascending: false }).limit(500);

  // UCP: filter by session metadata.merchant_id (the sim writes it there).
  // Fall back to status='completed' only — UCP sessions that didn't complete
  // aren't sales.
  let ucpQuery = supabase
    .from('ucp_checkout_sessions')
    .select('id, status, currency, totals, agent_id, metadata, created_at')
    .gte('created_at', cutoff)
    .eq('status', 'completed') as any;
  if (tenantId) ucpQuery = ucpQuery.eq('tenant_id', tenantId);
  ucpQuery = ucpQuery.order('created_at', { ascending: false }).limit(500);

  // x402: transfers with to_account_id = this merchant.
  let txQuery = supabase
    .from('transfers')
    .select('id, amount, currency, status, protocol_metadata, from_account_id, created_at')
    .gte('created_at', cutoff)
    .eq('to_account_id', accountId) as any;
  if (tenantId) txQuery = txQuery.eq('tenant_id', tenantId);
  txQuery = txQuery.order('created_at', { ascending: false }).limit(500);

  // x402 endpoints owned by this merchant account.
  let epQuery = supabase
    .from('x402_endpoints')
    .select('id, name, path, method, base_price, currency, status, total_calls, total_revenue')
    .eq('account_id', accountId) as any;
  if (tenantId) epQuery = epQuery.eq('tenant_id', tenantId);
  epQuery = epQuery.order('created_at', { ascending: true }).limit(50);

  const [acpRes, ucpRes, txRes, epRes, viewsRes, abandonedAcpRes] = await Promise.all([
    acpQuery, ucpQuery, txQuery, epQuery, viewsQuery, abandonedAcpQuery,
  ]);

  const acpRows = (acpRes.data || []) as any[];
  const ucpRows = (ucpRes.data || []) as any[];
  const txRows = (txRes.data || []) as any[];
  const epRows = (epRes.data || []) as any[];
  const viewsRows = (viewsRes.data || []) as any[];
  const abandonedAcpRows = (abandonedAcpRes.data || []) as any[];

  // Filter UCP sessions to those addressed to this merchant via metadata.
  const ucpMine = ucpRows.filter((s: any) => {
    const mname = s.metadata?.merchant_name;
    const mid = s.metadata?.merchant_id;
    return mname === accountRow.name || (posTextId && mid === posTextId) || s.metadata?.merchant_account_id === accountId;
  });

  // Partition transfers: x402 vs. non-x402 (the non-x402 are the ACP/UCP
  // settlement rows we already accounted for in the checkout tables —
  // counting them here would double-count).
  const x402Tx = txRows.filter((t: any) => {
    const proto = t.protocol_metadata?.protocol;
    const settle = t.protocol_metadata?.settlement_type;
    return proto === 'x402' || settle === 'batch_net_ledger' || settle === 'x402_authorization';
  });
  const x402Completed = x402Tx.filter((t: any) => t.status === 'completed' || t.status === 'pending');

  // ─── 3. Volumes + counts ──────────────────────────────────────────────
  const acpVolume = acpRows.reduce((s, c) => s + Number(c.total_amount || 0), 0);
  const ucpVolume = ucpMine.reduce((s, session) => {
    const totalEntry = Array.isArray(session.totals) ? session.totals.find((t: any) => t?.type === 'total') : null;
    const cents = totalEntry ? Number(totalEntry.amount || 0) : 0;
    return s + cents / 100;
  }, 0);
  const x402Volume = x402Completed.reduce((s, t: any) => s + Number(t.amount || 0), 0);

  const volume = {
    total: acpVolume + ucpVolume + x402Volume,
    acp: acpVolume,
    ucp: ucpVolume,
    x402: x402Volume,
  };
  const counts = {
    total: acpRows.length + ucpMine.length + x402Completed.length,
    acp: acpRows.length,
    ucp: ucpMine.length,
    x402: x402Completed.length,
  };

  // ─── 4. Top buyers (by spend) ──────────────────────────────────────────
  const buyerAgg: Record<string, { agentId: string; name: string; sales: number; spend: number }> = {};
  for (const c of acpRows) {
    const aid = c.agent_id;
    if (!aid) continue;
    if (!buyerAgg[aid]) buyerAgg[aid] = { agentId: aid, name: c.agent_name || aid.slice(0, 8), sales: 0, spend: 0 };
    buyerAgg[aid].sales += 1;
    buyerAgg[aid].spend += Number(c.total_amount || 0);
  }
  for (const s of ucpMine) {
    const aid = s.agent_id;
    if (!aid) continue;
    const totalEntry = Array.isArray(s.totals) ? s.totals.find((t: any) => t?.type === 'total') : null;
    const cents = totalEntry ? Number(totalEntry.amount || 0) : 0;
    if (!buyerAgg[aid]) buyerAgg[aid] = { agentId: aid, name: aid.slice(0, 8), sales: 0, spend: 0 };
    buyerAgg[aid].sales += 1;
    buyerAgg[aid].spend += cents / 100;
  }
  for (const t of x402Completed) {
    // x402 transfers don't carry agent_id directly; try protocol_metadata.
    const aid = t.protocol_metadata?.agent_id;
    if (!aid) continue;
    if (!buyerAgg[aid]) buyerAgg[aid] = { agentId: aid, name: aid.slice(0, 8), sales: 0, spend: 0 };
    buyerAgg[aid].sales += 1;
    buyerAgg[aid].spend += Number(t.amount || 0);
  }
  // Resolve agent names
  const buyerIds = Object.keys(buyerAgg);
  if (buyerIds.length > 0) {
    const { data: agents } = await supabase
      .from('agents')
      .select('id, name')
      .in('id', buyerIds);
    for (const a of (agents || []) as any[]) {
      if (buyerAgg[a.id] && a.name) buyerAgg[a.id].name = a.name;
    }
  }
  const topBuyers = Object.values(buyerAgg).sort((a, b) => b.spend - a.spend).slice(0, 10);

  // ─── 5. Recent sales feed (last 20 across protocols) ──────────────────
  const rs: MerchantStatsResult['recentSales'] = [];
  for (const c of acpRows.slice(0, 20)) {
    rs.push({
      protocol: 'acp',
      amount: Number(c.total_amount || 0),
      buyerName: buyerAgg[c.agent_id]?.name || c.agent_name || null,
      at: c.created_at,
      item: c.metadata?.summary || 'Basket',
    });
  }
  for (const s of ucpMine.slice(0, 20)) {
    const totalEntry = Array.isArray(s.totals) ? s.totals.find((t: any) => t?.type === 'total') : null;
    const cents = totalEntry ? Number(totalEntry.amount || 0) : 0;
    rs.push({
      protocol: 'ucp',
      amount: cents / 100,
      buyerName: buyerAgg[s.agent_id]?.name || null,
      at: s.created_at,
      item: s.metadata?.item_name || 'UCP order',
    });
  }
  for (const t of x402Completed.slice(0, 20)) {
    const aid = t.protocol_metadata?.agent_id;
    rs.push({
      protocol: 'x402',
      amount: Number(t.amount || 0),
      buyerName: aid ? (buyerAgg[aid]?.name || null) : null,
      at: t.created_at,
      item: t.protocol_metadata?.endpoint_name || t.protocol_metadata?.path || 'x402 call',
    });
  }
  rs.sort((a, b) => (a.at < b.at ? 1 : -1));
  const recentSales = rs.slice(0, 20);

  // ─── 6. Endpoints ─────────────────────────────────────────────────────
  const endpoints = epRows.map((e: any) => ({
    id: e.id,
    name: e.name,
    path: e.path,
    method: e.method,
    base_price: Number(e.base_price || 0),
    total_calls: Number(e.total_calls || 0),
    total_revenue: Number(e.total_revenue || 0),
    status: e.status,
  }));

  // ─── 7. Discovery + abandonment ───────────────────────────────────────
  const uniqueViewerSet = new Set<string>();
  for (const v of viewsRows) {
    if (v.viewer_agent_id) uniqueViewerSet.add(v.viewer_agent_id);
  }
  const views = viewsRows.length;
  const checkouts = counts.total;           // all checkouts (any status) this window
  const completed = acpRows.length + ucpMine.length + x402Completed.length;
  const abandoned = abandonedAcpRows.length;
  const conversionRate = views > 0 ? completed / views : 0;

  // Resolve buyer names for recent abandoned carts — reuse the buyerAgg map
  // where possible, fall back to the agent_name text column on the checkout row.
  const abandonedRecent = abandonedAcpRows.slice(0, 10).map((c: any) => {
    const items = Array.isArray(c.metadata?.cart_items)
      ? c.metadata.cart_items.map((i: any) => i.name).filter(Boolean).slice(0, 3).join(', ')
      : (c.agent_name ? `${c.agent_name}'s basket` : 'Basket');
    return {
      checkoutId: c.checkout_id || c.id,
      buyerName: buyerAgg[c.agent_id]?.name || c.agent_name || null,
      amount: Number(c.total_amount || 0),
      items,
      createdAt: c.created_at,
      expiredAt: c.expires_at || null,
    };
  });

  const discovery = {
    views,
    uniqueViewers: uniqueViewerSet.size,
    conversionRate,
    funnel: { views, checkouts, completed, abandoned },
    abandonedCarts: {
      count: abandoned,
      value: abandonedAcpRows.reduce((s, c) => s + Number(c.total_amount || 0), 0),
      recent: abandonedRecent,
    },
  };

  return {
    merchant,
    isMerchant: true,
    volume,
    counts,
    topBuyers,
    recentSales,
    endpoints,
    discovery,
  };
}
