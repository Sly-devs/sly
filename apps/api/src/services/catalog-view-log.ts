/**
 * Catalog-view logger. Fire-and-forget.
 *
 * Inserts a row into catalog_views each time a detail-level merchant endpoint
 * is hit. Non-blocking — failures are swallowed so they never affect the
 * caller's response. List endpoints are NOT logged (too high-volume, low-
 * signal); only detail + ratings pages.
 *
 * The resolvedAccountId is optional: when the route already resolved the
 * merchant UUID, pass it through. When the route accepts either UUID or
 * a TEXT merchant_id (ACP style), the caller passes what it has and the
 * logger does the resolve itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { RequestContext } from '../middleware/auth.js';

export interface CatalogViewLogInput {
  tenantId: string;
  merchantAccountId: string;
  endpoint: 'detail' | 'ratings';
  viewerAgentId?: string | null;
  viewerType: 'agent' | 'tenant' | 'anon';
  refererSku?: string;
}

export function logCatalogView(
  supabase: SupabaseClient,
  input: CatalogViewLogInput,
): void {
  // Fire-and-forget — don't await. Errors logged but not surfaced.
  (supabase.from('catalog_views') as any)
    .insert({
      tenant_id: input.tenantId,
      merchant_account_id: input.merchantAccountId,
      viewer_agent_id: input.viewerAgentId ?? null,
      viewer_type: input.viewerType,
      endpoint: input.endpoint,
      referer_sku: input.refererSku ?? null,
    })
    .then((res: any) => {
      if (res?.error) {
        // Quiet — don't spam logs in happy-path runs.
        console.warn('[catalog-view] insert failed:', res.error.message);
      }
    });
}

/** Classify a request context into (viewerType, viewerAgentId). */
export function viewerFromCtx(
  ctx: RequestContext,
): { viewerType: 'agent' | 'tenant' | 'anon'; viewerAgentId: string | null } {
  if (ctx.actorType === 'agent' && ctx.actorId) {
    return { viewerType: 'agent', viewerAgentId: ctx.actorId };
  }
  if (ctx.actorType === 'user' || ctx.actorType === 'api_key') {
    return { viewerType: 'tenant', viewerAgentId: null };
  }
  return { viewerType: 'anon', viewerAgentId: null };
}
