/**
 * Tenant payout-wallet service.
 *
 * Resolves the on-chain payTo address Sly needs to put on a published
 * x402 endpoint's 402 challenge. Auto-provisions a CDP smart wallet when
 * the tenant has none bound yet.
 *
 * RLS: every query filters by tenant_id. The Supabase client uses the
 * service role (bypasses RLS) so explicit filtering is mandatory — see
 * CLAUDE.md "Never skip tenant filtering".
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { WalletRequiredError } from '../middleware/error.js';

// ────────────────────────────────────────────────────────────────────────────
// Network mapping
// ────────────────────────────────────────────────────────────────────────────

/**
 * Map the Sly-internal network slug to a CAIP-2 identifier. The DB stores
 * either form (the migration's CHECK constraint accepts both); the CDP
 * Facilitator and Bazaar always want CAIP-2.
 *
 * Unknown slugs pass through unchanged so this never blocks a tenant
 * from binding a custom L2 — the CHECK on tenant_payout_wallets.network
 * still gates the format.
 */
export function mapSlyNetworkToCAIP2(network: string): string {
  if (!network) return network;
  if (network.startsWith('eip155:')) return network;

  switch (network) {
    case 'base-mainnet':
      return 'eip155:8453';
    case 'base-sepolia':
      return 'eip155:84532';
    case 'ethereum-mainnet':
      return 'eip155:1';
    case 'optimism-mainnet':
      return 'eip155:10';
    case 'arbitrum-mainnet':
      return 'eip155:42161';
    default:
      return network;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Address validation (lightweight)
// ────────────────────────────────────────────────────────────────────────────

/**
 * EVM address shape check. We deliberately don't enforce EIP-55 checksum
 * here — many existing tenants store lowercase addresses, and re-checksumming
 * happens at signing time via viem.
 */
export function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

// ────────────────────────────────────────────────────────────────────────────
// Service
// ────────────────────────────────────────────────────────────────────────────

export interface PayoutWalletRow {
  id: string;
  tenantId: string;
  accountId: string;
  network: string;
  address: string;
  provisionedBy: 'user' | 'auto';
  provider: 'cdp' | 'privy' | 'external';
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

function rowToWallet(row: any): PayoutWalletRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    network: row.network,
    address: row.address,
    provisionedBy: row.provisioned_by,
    provider: row.provider,
    metadata: row.metadata ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface GetOrProvisionOpts {
  /**
   * If true and no wallet is bound, mint a CDP smart wallet and persist it
   * with provisioned_by='auto', provider='cdp'. Defaults to false so callers
   * have to opt in — uncontrolled provisioning would silently spend CDP
   * quota.
   */
  autoProvision?: boolean;
}

/**
 * Look up the wallet bound to (tenant, account, network). Returns null when
 * none exists and autoProvision is false. When autoProvision is true and
 * none exists, calls CDP Wallet API to mint one.
 */
export async function getOrProvision(
  supabase: SupabaseClient,
  tenantId: string,
  accountId: string,
  network: string,
  opts: GetOrProvisionOpts = {}
): Promise<PayoutWalletRow> {
  const caip2 = mapSlyNetworkToCAIP2(network);

  // Look up against both the CAIP-2 form and the original slug — the
  // table accepts either, so we match either way.
  const { data: rows, error } = await supabase
    .from('tenant_payout_wallets')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('account_id', accountId)
    .in('network', Array.from(new Set([caip2, network])))
    .limit(1);

  if (error) {
    throw new Error(`Failed to query tenant_payout_wallets: ${error.message}`);
  }

  if (rows && rows.length > 0) {
    return rowToWallet(rows[0]);
  }

  if (!opts.autoProvision) {
    throw new WalletRequiredError(network, accountId);
  }

  // Auto-provision via CDP Wallet API. The CDP SDK is a transitive dep of
  // @coinbase/x402; we lazy-import to keep the service runnable in tests
  // without CDP creds set.
  const address = await provisionCdpSmartWallet(caip2);

  const { data: inserted, error: insertErr } = await supabase
    .from('tenant_payout_wallets')
    .insert({
      tenant_id: tenantId,
      account_id: accountId,
      network: caip2,
      address,
      provisioned_by: 'auto',
      provider: 'cdp',
      metadata: { provisioned_at: new Date().toISOString() },
    })
    .select()
    .single();

  if (insertErr || !inserted) {
    throw new Error(
      `Failed to persist auto-provisioned wallet: ${insertErr?.message || 'no row returned'}`
    );
  }
  return rowToWallet(inserted);
}

/**
 * Bind an existing on-chain address as the payTo for (tenant, account, network).
 * Validates EVM address shape; throws if a row already exists for the tuple
 * (the unique index would also catch this, but a typed error is friendlier).
 */
export async function bind(
  supabase: SupabaseClient,
  tenantId: string,
  accountId: string,
  network: string,
  address: string,
  provider: 'cdp' | 'privy' | 'external' = 'external'
): Promise<PayoutWalletRow> {
  if (!isEvmAddress(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  const caip2 = mapSlyNetworkToCAIP2(network);

  const { data: existing } = await supabase
    .from('tenant_payout_wallets')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('account_id', accountId)
    .eq('network', caip2)
    .limit(1);

  if (existing && existing.length > 0) {
    throw new Error(
      `Payout wallet already bound for account ${accountId} on ${caip2} — call update instead`
    );
  }

  const { data, error } = await supabase
    .from('tenant_payout_wallets')
    .insert({
      tenant_id: tenantId,
      account_id: accountId,
      network: caip2,
      address,
      provisioned_by: 'user',
      provider,
      metadata: { bound_at: new Date().toISOString() },
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(`Failed to bind payout wallet: ${error?.message || 'no row returned'}`);
  }
  return rowToWallet(data);
}

// ────────────────────────────────────────────────────────────────────────────
// CDP wallet provisioning (best-effort lazy import)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mint a CDP smart wallet and return its address. Called only when the
 * tenant has opted into auto-provisioning. CDP creds (`CDP_API_KEY_ID`,
 * `CDP_API_KEY_SECRET`) must be present.
 *
 * Implementation is best-effort behind a lazy require of `@coinbase/cdp-sdk`
 * so the service keeps building/testing in environments without CDP set up.
 */
async function provisionCdpSmartWallet(caip2Network: string): Promise<string> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    throw new Error(
      'CDP credentials missing (CDP_API_KEY_ID / CDP_API_KEY_SECRET). Cannot auto-provision wallet.'
    );
  }

  let CdpClient: any;
  try {
    // Dynamic import via expression so TypeScript doesn't statically resolve
    // the module — the SDK is only present transitively via @coinbase/x402,
    // and we want builds to succeed in environments where it isn't.
    const mod: any = await (Function('return import("@coinbase/cdp-sdk")')() as Promise<any>);
    CdpClient = mod?.CdpClient;
  } catch (err) {
    throw new Error(
      `@coinbase/cdp-sdk is not installed — cannot auto-provision wallet. Install it or bind a wallet manually. (${(err as Error).message})`
    );
  }

  if (!CdpClient) {
    throw new Error('@coinbase/cdp-sdk did not export CdpClient — wallet provisioning unsupported.');
  }

  const cdp = new CdpClient({ apiKeyId, apiKeySecret });
  // The CDP SDK's exact method name varies across minor versions; we try
  // the documented one first and fall back to alternatives without
  // exploding on an interface drift.
  let addr: string | undefined;
  if (cdp?.evm?.createSmartAccount) {
    const out = await cdp.evm.createSmartAccount({});
    addr = out?.address;
  } else if (cdp?.smartAccounts?.create) {
    const out = await cdp.smartAccounts.create({});
    addr = out?.address;
  } else if (cdp?.evm?.createAccount) {
    const out = await cdp.evm.createAccount({});
    addr = out?.address;
  }

  if (!addr || !isEvmAddress(addr)) {
    throw new Error(
      `CDP wallet provisioning returned no usable address for network ${caip2Network}`
    );
  }
  return addr;
}
