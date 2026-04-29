/**
 * x402 Facilitator Routes — per-endpoint routing.
 *
 * The internal facilitator at /v1/x402/facilitator/{verify,settle} handles
 * private/intra-tenant x402 endpoints in dev/sandbox. As of the One-Click
 * Publish epic, the same routes also know how to forward verify+settle
 * for *published* endpoints to Coinbase's CDP Facilitator
 * (`facilitator_mode='cdp'`), which is what triggers indexing on
 * agentic.market.
 *
 * Routing decision (per request):
 *   1. If request body carries `endpointId` AND the row's facilitator_mode='cdp'
 *      → proxy to CDP, capture EXTENSION-RESPONSES, persist on the row,
 *        write a x402_publish_events audit row.
 *   2. Otherwise → fall back to the legacy mock/sandbox internal behavior.
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';

const router = new Hono();

// Internal mock facilitator only enabled in dev/sandbox — production keeps
// the historical behavior of returning 404 for any request that doesn't
// carry an `endpointId` mapping to a CDP-mode endpoint.
const isInternalEnabled = process.env.NODE_ENV !== 'production';

const CDP_FACILITATOR_URL =
  process.env.CDP_FACILITATOR_URL || 'https://api.cdp.coinbase.com/platform/v2/x402';

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface EndpointMode {
  id: string;
  tenant_id: string;
  facilitator_mode: 'internal' | 'cdp';
  publish_status: string;
}

async function loadEndpointMode(endpointId: string): Promise<EndpointMode | null> {
  const supabase: any = createClient();
  const { data, error } = await supabase
    .from('x402_endpoints')
    .select('id, tenant_id, facilitator_mode, publish_status')
    .eq('id', endpointId)
    .single();
  if (error || !data) return null;
  return data as EndpointMode;
}

function pickExtensionResponses(headers: Headers): string | null {
  // EXTENSION-RESPONSES is the documented header. We accept both the
  // canonical form and a lowercase variant since fetch normalizes.
  return headers.get('extension-responses') || headers.get('EXTENSION-RESPONSES');
}

async function persistCdpResult(
  endpoint: EndpointMode,
  extensionResponse: string | null,
  outcome: 'verify' | 'settle'
): Promise<void> {
  const supabase: any = createClient();
  const lower = (extensionResponse || '').toLowerCase();

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let event: string | null = null;
  let details: Record<string, unknown> = {
    operation: outcome,
    extension_responses: extensionResponse,
  };

  if (lower.includes('reject')) {
    update.publish_status = 'failed';
    update.publish_error = `extension_rejected: ${extensionResponse}`;
    event = 'extension_rejected';
  } else if (lower.includes('processing')) {
    // Only nudge to 'processing' if we're not already published — a
    // re-settle on a published row shouldn't downgrade it.
    if (endpoint.publish_status !== 'published') {
      update.publish_status = 'processing';
    }
    if (outcome === 'settle') {
      update.last_settle_at = new Date().toISOString();
      event = 'first_settle';
    }
  } else if (outcome === 'settle') {
    update.last_settle_at = new Date().toISOString();
  }

  await supabase
    .from('x402_endpoints')
    .update(update)
    .eq('id', endpoint.id)
    .eq('tenant_id', endpoint.tenant_id);

  if (event) {
    await supabase.from('x402_publish_events').insert({
      tenant_id: endpoint.tenant_id,
      endpoint_id: endpoint.id,
      actor_type: 'system',
      actor_id: null,
      event,
      details,
    });
  }
}

async function proxyToCdp(
  path: '/verify' | '/settle',
  body: unknown,
  endpoint: EndpointMode
): Promise<Response> {
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  if (!apiKeyId || !apiKeySecret) {
    return new Response(
      JSON.stringify({ error: 'CDP credentials not configured' }),
      { status: 500, headers: { 'content-type': 'application/json' } }
    );
  }

  const upstream = await fetch(`${CDP_FACILITATOR_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CDP-API-Key-Id': apiKeyId,
      'X-CDP-API-Key-Secret': apiKeySecret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const extensionResponse = pickExtensionResponses(upstream.headers);
  await persistCdpResult(
    endpoint,
    extensionResponse,
    path === '/verify' ? 'verify' : 'settle'
  );

  // Mirror the upstream response (status, body, EXTENSION-RESPONSES header)
  // so callers see exactly what CDP returned.
  const text = await upstream.text();
  const headers = new Headers({ 'content-type': upstream.headers.get('content-type') || 'application/json' });
  if (extensionResponse) headers.set('extension-responses', extensionResponse);
  return new Response(text, { status: upstream.status, headers });
}

// ────────────────────────────────────────────────────────────────────────────
// /verify
// ────────────────────────────────────────────────────────────────────────────

router.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const endpointId: string | undefined = body?.endpointId;

  if (endpointId) {
    const ep = await loadEndpointMode(endpointId);
    if (ep && ep.facilitator_mode === 'cdp') {
      const upstream = await proxyToCdp('/verify', body, ep);
      const extResp = upstream.headers.get('extension-responses');
      const text = await upstream.text();
      const json = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })();
      if (extResp) c.header('extension-responses', extResp);
      return c.json(json, upstream.status as 200 | 400 | 500);
    }
  }

  if (!isInternalEnabled) {
    return c.json({ error: 'Facilitator not available in production' }, 404);
  }

  // Legacy internal/mock behavior preserved.
  const payment = body?.payment;
  if (!payment) {
    return c.json({ valid: false, reason: 'Missing payment payload' }, 400);
  }

  const requiredFields = ['scheme', 'network', 'amount', 'token', 'from', 'to'];
  for (const field of requiredFields) {
    if (!payment[field]) {
      return c.json({ valid: false, reason: `Missing required field: ${field}` });
    }
  }

  if (payment.scheme !== 'exact-evm') {
    return c.json({
      valid: false,
      reason: `Unsupported scheme: ${payment.scheme}`,
      details: { supportedSchemes: ['exact-evm'] },
    });
  }

  const supportedNetworks = ['eip155:8453', 'eip155:84532'];
  if (!supportedNetworks.includes(payment.network)) {
    return c.json({
      valid: false,
      reason: `Unsupported network: ${payment.network}`,
      details: { supportedNetworks },
    });
  }

  const amount = parseFloat(payment.amount);
  if (isNaN(amount) || amount <= 0) {
    return c.json({ valid: false, reason: `Invalid amount: ${payment.amount}` });
  }

  return c.json({ valid: true });
});

// ────────────────────────────────────────────────────────────────────────────
// /settle
// ────────────────────────────────────────────────────────────────────────────

router.post('/settle', async (c) => {
  const body = await c.req.json().catch(() => ({} as any));
  const endpointId: string | undefined = body?.endpointId;

  if (endpointId) {
    const ep = await loadEndpointMode(endpointId);
    if (ep && ep.facilitator_mode === 'cdp') {
      const upstream = await proxyToCdp('/settle', body, ep);
      const extResp = upstream.headers.get('extension-responses');
      const text = await upstream.text();
      const json = (() => {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      })();
      if (extResp) c.header('extension-responses', extResp);
      return c.json(json, upstream.status as 200 | 400 | 500);
    }
  }

  if (!isInternalEnabled) {
    return c.json({ error: 'Facilitator not available in production' }, 404);
  }

  const payment = body?.payment;
  if (!payment) {
    return c.json({ error: 'Missing payment payload' }, 400);
  }

  const requiredFields = ['scheme', 'network', 'amount', 'token', 'from', 'to'];
  for (const field of requiredFields) {
    if (!payment[field]) {
      return c.json(
        { error: `Payment verification failed: Missing required field: ${field}` },
        400
      );
    }
  }

  // Generate mock transaction hash
  const chars = '0123456789abcdef';
  let txHash = '0x';
  for (let i = 0; i < 64; i++) {
    txHash += chars[Math.floor(Math.random() * chars.length)];
  }

  return c.json({
    transactionHash: txHash,
    settled: true,
    timestamp: new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────────────────────────────────
// /supported (unchanged — purely informational)
// ────────────────────────────────────────────────────────────────────────────

router.get('/supported', async (c) => {
  if (!isInternalEnabled) {
    return c.json({ error: 'Facilitator not available in production' }, 404);
  }
  return c.json({
    schemes: [
      {
        scheme: 'exact-evm',
        networks: ['eip155:8453', 'eip155:84532'],
      },
    ],
  });
});

export default router;
