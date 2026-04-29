/**
 * x402 publish state machine.
 *
 *   draft → validating → publishing → processing → published
 *      \────────────────────────→ failed (per stage)
 *   published ──unpublish──→ unpublished
 *
 * One entrypoint (`publishEndpoint`) drives every transition. Idempotent:
 * re-calling on a published endpoint with `metadata_dirty=false` is a
 * no-op unless `force=true`. Each state change writes an x402_publish_events
 * audit row so the dashboard timeline reflects truth.
 *
 * The only external service the state machine touches is the CDP
 * Facilitator (verify+settle). All probing, validation, and event-writing
 * is local.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  X402DiscoveryMetadata,
  X402PublishStatus,
  X402PublishEventType,
} from '@sly/api-client';
import type { RequestContext } from '../middleware/auth.js';
import { buildBazaarExtension, validateBazaarExtension } from './bazaar-extension.js';
import { probeEndpoint } from './endpoint-probe.js';
import { getOrProvision, mapSlyNetworkToCAIP2 } from './payout-wallet.js';
import { BazaarValidationError } from '../middleware/error.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface PublishOptions {
  /** Caller-supplied overrides applied on top of probe results. */
  metadataOverride?: Partial<X402DiscoveryMetadata>;
  /** Bypass the metadata-clean / already-published short-circuit. */
  force?: boolean;
  /** Skip the synthetic settle (used by tests + auto-republish hot path). */
  skipFirstSettle?: boolean;
}

export interface PublishResult {
  status: 'ok' | 'failed';
  publishStatus: X402PublishStatus;
  publishError?: string | null;
  errors?: Array<{ field: string; reason: string }>;
}

/**
 * Minimal endpoint shape the state machine reads. Kept as `any` in the
 * SQL layer because x402_endpoints carries dozens of unrelated columns;
 * this interface documents the subset publish-x402 actually consumes.
 */
interface EndpointRow {
  id: string;
  tenant_id: string;
  account_id: string;
  name: string;
  description: string | null;
  path: string;
  method: string;
  base_price: string | number;
  currency: string;
  network: string;
  payment_address: string | null;
  service_slug: string | null;
  backend_url: string | null;
  visibility: 'private' | 'public';
  publish_status: X402PublishStatus;
  publish_error: string | null;
  facilitator_mode: 'internal' | 'cdp';
  metadata_dirty: boolean;
  discovery_metadata: X402DiscoveryMetadata | null;
  category: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// Audit helpers
// ────────────────────────────────────────────────────────────────────────────

function actorFromCtx(ctx: RequestContext): {
  actorType: 'user' | 'agent' | 'api_key' | 'system';
  actorId: string | null;
} {
  switch (ctx.actorType) {
    case 'user':
      return { actorType: 'user', actorId: ctx.userId ?? null };
    case 'agent':
      return { actorType: 'agent', actorId: ctx.actorId ?? null };
    case 'api_key':
      return { actorType: 'api_key', actorId: ctx.apiKeyId ?? null };
    default:
      return { actorType: 'system', actorId: null };
  }
}

async function appendEvent(
  supabase: SupabaseClient,
  ctx: RequestContext,
  endpoint: { id: string; tenant_id: string },
  event: X402PublishEventType,
  details: Record<string, unknown> = {}
): Promise<void> {
  const { actorType, actorId } = actorFromCtx(ctx);
  const { error } = await supabase.from('x402_publish_events').insert({
    tenant_id: endpoint.tenant_id,
    endpoint_id: endpoint.id,
    actor_type: actorType,
    actor_id: actorId,
    event,
    details,
  });
  if (error) {
    // Audit failures must never break the publish flow itself.
    console.error('[publish-x402] failed to append event:', error.message);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CDP synthetic first-settle
// ────────────────────────────────────────────────────────────────────────────

/**
 * Trigger the first settle from Sly's probe wallet so the user gets
 * immediate feedback ("processing" or "rejected") rather than waiting
 * for an organic buyer. Returns the EXTENSION-RESPONSES status that the
 * CDP Facilitator echoed back.
 *
 * Best-effort: when CDP creds or probe wallet are missing we treat the
 * endpoint as "processing" optimistically — the gateway will overwrite
 * publish_status when the next real settle lands.
 */
async function triggerFirstSettle(
  endpoint: EndpointRow,
  payoutAddress: string
): Promise<{ extensionResponse: 'processing' | 'rejected' | 'unknown'; reason?: string }> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const probeWalletId = process.env.SLY_PUBLISH_PROBE_WALLET_ID;

  if (!apiKeyId || !apiKeySecret || !probeWalletId) {
    return {
      extensionResponse: 'processing',
      reason: 'probe-skipped:cdp-credentials-missing',
    };
  }

  const cdpUrl =
    process.env.CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';

  // We don't inline the @coinbase/x402 client because it needs the full
  // payment header construction round-trip from a real wallet. For Phase 1
  // the synthetic settle is a server-to-server POST that returns
  // EXTENSION-RESPONSES with the same semantics as a real settle.
  try {
    const res = await fetch(`${cdpUrl}/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDP-API-Key-Id': apiKeyId,
        'X-CDP-API-Key-Secret': apiKeySecret,
        'X-Sly-Probe-Wallet': probeWalletId,
      },
      body: JSON.stringify({
        scheme: 'exact-evm',
        network: mapSlyNetworkToCAIP2(endpoint.network),
        amount: String(endpoint.base_price),
        token: process.env.X402_USDC_ADDRESS || '',
        from: probeWalletId,
        to: payoutAddress,
        extension: { source: 'sly-publish-probe' },
      }),
      signal: AbortSignal.timeout(15000),
    });

    const headerName = Object.keys(Object.fromEntries(res.headers)).find(
      (h) => h.toLowerCase() === 'extension-responses'
    );
    const raw = headerName ? res.headers.get(headerName) : null;
    const lower = (raw || '').toLowerCase();

    if (lower.includes('reject')) {
      const reason = raw ?? 'rejected';
      return { extensionResponse: 'rejected', reason };
    }
    if (lower.includes('processing')) {
      return { extensionResponse: 'processing' };
    }
    return { extensionResponse: 'unknown', reason: raw ?? `${res.status}` };
  } catch (err: any) {
    return {
      extensionResponse: 'processing',
      reason: `probe-warn:${err?.message || 'unknown'}`,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Core entrypoint
// ────────────────────────────────────────────────────────────────────────────

export async function publishEndpoint(
  supabase: SupabaseClient,
  ctx: RequestContext,
  endpointId: string,
  opts: PublishOptions = {}
): Promise<PublishResult> {
  // 1. Load endpoint, assert tenant match.
  const { data: endpoint, error: loadErr } = await supabase
    .from('x402_endpoints')
    .select('*')
    .eq('id', endpointId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (loadErr || !endpoint) {
    throw new Error(`x402 endpoint not found: ${endpointId}`);
  }
  const ep = endpoint as EndpointRow;

  // Idempotency short-circuit. force overrides.
  if (
    !opts.force &&
    ep.publish_status === 'published' &&
    !ep.metadata_dirty
  ) {
    return { status: 'ok', publishStatus: 'published' };
  }

  await appendEvent(supabase, ctx, ep, opts.force ? 'republish_requested' : 'publish_requested', {
    force: !!opts.force,
    metadataDirty: ep.metadata_dirty,
  });

  // 2. Validate prerequisites — slug + backend_url.
  const errors: Array<{ field: string; reason: string }> = [];
  if (!ep.service_slug) {
    errors.push({ field: 'service_slug', reason: 'is required before publishing' });
  }
  if (!ep.backend_url) {
    errors.push({ field: 'backend_url', reason: 'is required before publishing' });
  }
  if (errors.length > 0) {
    return await failWith(supabase, ctx, ep, 'config-incomplete', errors);
  }

  await markStatus(supabase, ep, 'validating', null);

  // 3. Probe (only if no metadata cached, or force=true). Merge override.
  let metadata: X402DiscoveryMetadata | null = ep.discovery_metadata ?? null;
  if (!metadata || opts.force) {
    const probe = await probeEndpoint({
      method: ep.method,
      backendUrl: ep.backend_url!,
    });
    if (probe.ok) {
      metadata = {
        ...probe.metadata,
        description: ep.description ?? probe.metadata.description ?? '',
        category: ep.category ?? undefined,
      };
    } else if (!metadata) {
      // No cached metadata and probe failed — surface as a validation error
      // unless the caller already supplied a full override.
      if (!opts.metadataOverride?.description) {
        return await failWith(supabase, ctx, ep, 'probe-failed', [
          { field: 'backend_url', reason: probe.reason },
        ]);
      }
      metadata = {
        description: opts.metadataOverride.description ?? '',
      };
    }
  }
  // metadata is guaranteed non-null below
  metadata = { ...(metadata as X402DiscoveryMetadata), ...(opts.metadataOverride || {}) };

  // Validate Bazaar extension shape.
  const validateResult = validateBazaarExtension({
    endpoint: { id: ep.id, name: ep.name, method: ep.method, path: ep.path },
    description: metadata!.description,
    category: metadata!.category,
    schemas: {
      input: metadata!.input?.schema,
      output: metadata!.output?.schema,
    },
    examples: {
      input: metadata!.input?.example,
      output: metadata!.output?.example,
    },
    bodyType: metadata!.bodyType,
  });
  if (validateResult.length > 0) {
    return await failWith(supabase, ctx, ep, 'validation-failed', validateResult);
  }

  // Building the extension is one more sanity check (it throws on failure,
  // but we already pre-validated above).
  try {
    buildBazaarExtension({
      endpoint: { id: ep.id, name: ep.name, method: ep.method, path: ep.path },
      description: metadata!.description,
      category: metadata!.category,
      schemas: {
        input: metadata!.input?.schema,
        output: metadata!.output?.schema,
      },
      examples: {
        input: metadata!.input?.example,
        output: metadata!.output?.example,
      },
      bodyType: metadata!.bodyType,
    });
  } catch (err) {
    if (err instanceof BazaarValidationError) {
      return await failWith(
        supabase,
        ctx,
        ep,
        'validation-failed',
        (err.details as Array<{ field: string; reason: string }>) || []
      );
    }
    throw err;
  }

  await appendEvent(supabase, ctx, ep, 'validated', { metadataDescription: metadata!.description });

  // 4. Resolve payout wallet (auto-provision if tenant opted in).
  const wallet = await getOrProvision(supabase, ep.tenant_id, ep.account_id, ep.network, {
    autoProvision: true,
  });

  // 5. Switch facilitator + persist metadata. Status moves to 'publishing'.
  await markStatus(supabase, ep, 'publishing', null, {
    facilitator_mode: 'cdp',
    discovery_metadata: metadata,
    metadata_dirty: false,
    visibility: 'public',
    payment_address: wallet.address,
  });

  // 6. Trigger first settle.
  if (!opts.skipFirstSettle) {
    const firstSettle = await triggerFirstSettle(
      { ...ep, payment_address: wallet.address },
      wallet.address
    );

    if (firstSettle.extensionResponse === 'rejected') {
      const reason = firstSettle.reason || 'extension rejected';
      await appendEvent(supabase, ctx, ep, 'extension_rejected', { reason });
      return await failWith(supabase, ctx, ep, reason, [
        { field: 'extension', reason },
      ]);
    }

    await appendEvent(supabase, ctx, ep, 'first_settle', {
      response: firstSettle.extensionResponse,
      reason: firstSettle.reason,
    });
  }

  // 7. Move to 'processing' so the catalog poller picks it up.
  await markStatus(supabase, ep, 'processing', null, {
    last_settle_at: new Date().toISOString(),
  });

  return { status: 'ok', publishStatus: 'processing' };
}

// ────────────────────────────────────────────────────────────────────────────
// Unpublish
// ────────────────────────────────────────────────────────────────────────────

/**
 * Stop routing this endpoint through CDP. Catalog entry on agentic.market
 * may persist briefly until Coinbase prunes it — the dashboard surfaces
 * that disclaimer.
 */
export async function unpublishEndpoint(
  supabase: SupabaseClient,
  ctx: RequestContext,
  endpointId: string
): Promise<PublishResult> {
  const { data: endpoint, error } = await supabase
    .from('x402_endpoints')
    .select('id, tenant_id, publish_status')
    .eq('id', endpointId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !endpoint) {
    throw new Error(`x402 endpoint not found: ${endpointId}`);
  }

  await appendEvent(
    supabase,
    ctx,
    { id: endpoint.id, tenant_id: endpoint.tenant_id },
    'unpublish_requested',
    {}
  );

  const { error: updateErr } = await supabase
    .from('x402_endpoints')
    .update({
      visibility: 'private',
      facilitator_mode: 'internal',
      publish_status: 'unpublished',
      updated_at: new Date().toISOString(),
    })
    .eq('id', endpointId)
    .eq('tenant_id', ctx.tenantId);

  if (updateErr) {
    throw new Error(`Failed to unpublish endpoint: ${updateErr.message}`);
  }

  await appendEvent(
    supabase,
    ctx,
    { id: endpoint.id, tenant_id: endpoint.tenant_id },
    'unpublished',
    {}
  );

  return { status: 'ok', publishStatus: 'unpublished' };
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

async function markStatus(
  supabase: SupabaseClient,
  ep: { id: string; tenant_id: string },
  status: X402PublishStatus,
  publishError: string | null,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const update: Record<string, unknown> = {
    publish_status: status,
    publish_error: publishError,
    updated_at: new Date().toISOString(),
    ...extra,
  };
  const { error } = await supabase
    .from('x402_endpoints')
    .update(update)
    .eq('id', ep.id)
    .eq('tenant_id', ep.tenant_id);
  if (error) {
    throw new Error(`markStatus(${status}) failed: ${error.message}`);
  }
}

async function failWith(
  supabase: SupabaseClient,
  ctx: RequestContext,
  ep: EndpointRow,
  reason: string,
  errors: Array<{ field: string; reason: string }>
): Promise<PublishResult> {
  await markStatus(supabase, ep, 'failed', reason);
  await appendEvent(supabase, ctx, ep, 'failed', { reason, errors });
  return {
    status: 'failed',
    publishStatus: 'failed',
    publishError: reason,
    errors,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Validate-only (used by POST /v1/x402/endpoints/:id/validate)
// ────────────────────────────────────────────────────────────────────────────

export interface ValidateResult {
  ok: boolean;
  errors: Array<{ field: string; reason: string }>;
  probedMetadata?: X402DiscoveryMetadata;
  walletReady: boolean;
  reachable: boolean;
}

/**
 * Dry-run pass over an endpoint: probe + Bazaar validation + wallet check,
 * without touching CDP or mutating any rows. Used by the dashboard
 * "Readiness" panel.
 */
export async function validateEndpointForPublish(
  supabase: SupabaseClient,
  ctx: RequestContext,
  endpointId: string
): Promise<ValidateResult> {
  const { data: endpoint, error } = await supabase
    .from('x402_endpoints')
    .select('*')
    .eq('id', endpointId)
    .eq('tenant_id', ctx.tenantId)
    .single();

  if (error || !endpoint) {
    throw new Error(`x402 endpoint not found: ${endpointId}`);
  }
  const ep = endpoint as EndpointRow;

  const errors: Array<{ field: string; reason: string }> = [];
  if (!ep.service_slug) errors.push({ field: 'service_slug', reason: 'is required' });
  if (!ep.backend_url) errors.push({ field: 'backend_url', reason: 'is required' });

  let probedMetadata: X402DiscoveryMetadata | undefined;
  let reachable = false;
  if (ep.backend_url) {
    const probe = await probeEndpoint({ method: ep.method, backendUrl: ep.backend_url });
    if (probe.ok) {
      reachable = true;
      probedMetadata = {
        ...probe.metadata,
        description: ep.description ?? '',
        category: ep.category ?? undefined,
      };
    } else if (!probe.requiresManualMetadata) {
      errors.push({ field: 'backend_url', reason: probe.reason });
    } else {
      // Non-GET — user supplies metadata; reachability isn't verifiable
      // without side-effects.
      reachable = true;
    }
  }

  const cachedOrProbed: X402DiscoveryMetadata | undefined =
    ep.discovery_metadata ?? probedMetadata;

  if (cachedOrProbed) {
    const fieldErrors = validateBazaarExtension({
      endpoint: { id: ep.id, name: ep.name, method: ep.method, path: ep.path },
      description: cachedOrProbed.description,
      category: cachedOrProbed.category,
      schemas: {
        input: cachedOrProbed.input?.schema,
        output: cachedOrProbed.output?.schema,
      },
      examples: {
        input: cachedOrProbed.input?.example,
        output: cachedOrProbed.output?.example,
      },
      bodyType: cachedOrProbed.bodyType,
    });
    errors.push(...fieldErrors);
  } else {
    errors.push({ field: 'discovery_metadata', reason: 'no metadata available — probe failed and none cached' });
  }

  let walletReady = false;
  try {
    await getOrProvision(supabase, ep.tenant_id, ep.account_id, ep.network, {
      autoProvision: false,
    });
    walletReady = true;
  } catch {
    walletReady = false;
  }
  if (!walletReady) {
    errors.push({
      field: 'payout_wallet',
      reason: `bind a wallet for account on ${mapSlyNetworkToCAIP2(ep.network)} or enable auto-provisioning`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    probedMetadata,
    walletReady,
    reachable,
  };
}

/**
 * Discovery-relevant fields. Changing any of these on a public endpoint
 * marks it dirty and triggers auto-republish.
 */
export const DISCOVERY_FIELDS = [
  'name',
  'description',
  'path',
  'method',
  'basePrice',
  'currency',
  'network',
  'volumeDiscounts',
  'category',
  'backendUrl',
  'serviceSlug',
] as const;

export type DiscoveryField = (typeof DISCOVERY_FIELDS)[number];
