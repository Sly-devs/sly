/**
 * GET/POST /v1/tenant-payout-wallets
 *
 * Standalone CRUD for the tenant_payout_wallets table that pairs with
 * Worktree D's dashboard (PublishToMarketDialog auto-provision button)
 * and external integrators that want to bind a payout address before
 * publishing an x402 endpoint.
 *
 * The publish flow itself can also call payout-wallet.getOrProvision()
 * directly via validateEndpointForPublish; these routes are the explicit
 * external-facing surface for managing the binding.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { ApiError, ValidationError } from '../middleware/error.js';
import { bind, getOrProvision, mapSlyNetworkToCAIP2 } from '../services/payout-wallet.js';

const app = new Hono();

const bindInputSchema = z.object({
  accountId: z.string().uuid(),
  network: z.string().min(1).max(64),
  // Optional — when omitted, server auto-provisions a CDP smart wallet.
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a valid 0x-prefixed EVM address')
    .optional(),
  provider: z.enum(['cdp', 'privy', 'external']).optional(),
});

function rowToCamel(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    network: row.network,
    address: row.address,
    provisionedBy: row.provisioned_by,
    provider: row.provider,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /v1/tenant-payout-wallets
 * List all payout wallets bound under the caller's tenant.
 */
app.get('/', async (c: Context) => {
  const ctx = c.get('ctx');
  const supabase: any = createClient();
  const accountId = c.req.query('account_id');

  let query = supabase
    .from('tenant_payout_wallets')
    .select('*')
    .eq('tenant_id', ctx.tenantId)
    .order('created_at', { ascending: false });

  if (accountId) query = query.eq('account_id', accountId);

  const { data, error } = await query;
  if (error) {
    console.error('Error listing tenant_payout_wallets:', error);
    return c.json({ error: 'Failed to list payout wallets' }, 500);
  }

  return c.json({ data: (data ?? []).map(rowToCamel) });
});

/**
 * POST /v1/tenant-payout-wallets
 * Bind an existing on-chain address as the payTo for (account, network),
 * OR (when address is omitted) auto-provision a Sly-managed CDP smart
 * wallet for the same tuple.
 */
app.post('/', async (c: Context) => {
  const ctx = c.get('ctx');
  const supabase: any = createClient();

  let parsed: z.infer<typeof bindInputSchema>;
  try {
    parsed = bindInputSchema.parse(await c.req.json());
  } catch (err: any) {
    throw new ValidationError(
      'Invalid request body',
      err?.issues ?? err?.errors ?? err?.message
    );
  }

  // Confirm the account belongs to the caller's tenant — prevents cross-tenant
  // wallet binding.
  const { data: account, error: accErr } = await supabase
    .from('accounts')
    .select('id')
    .eq('id', parsed.accountId)
    .eq('tenant_id', ctx.tenantId)
    .single();
  if (accErr || !account) {
    return c.json({ error: 'Account not found' }, 404);
  }

  try {
    if (parsed.address) {
      // Explicit address — bind it.
      const wallet = await bind(
        supabase,
        ctx.tenantId,
        parsed.accountId,
        parsed.network,
        parsed.address,
        parsed.provider ?? 'external'
      );
      return c.json({ data: rowToCamel(wallet) }, 201);
    }

    // No address — caller wants auto-provision via CDP.
    const wallet = await getOrProvision(
      supabase,
      ctx.tenantId,
      parsed.accountId,
      parsed.network,
      { autoProvision: true }
    );
    return c.json({ data: rowToCamel(wallet) }, 201);
  } catch (err: any) {
    if (err instanceof ApiError) throw err;
    if (err?.message?.includes('already bound')) {
      return c.json(
        {
          error: err.message,
          // Surface the existing binding for the dashboard to use.
          network: mapSlyNetworkToCAIP2(parsed.network),
        },
        409
      );
    }
    console.error('Error binding payout wallet:', err);
    return c.json(
      { error: err?.message || 'Failed to bind payout wallet' },
      500
    );
  }
});

export default app;
