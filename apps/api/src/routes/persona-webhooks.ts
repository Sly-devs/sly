/**
 * Persona Webhook Handler
 * Stories 73.10/73.11: Persona SDK Integration
 *
 * Handles incoming webhooks from Persona for:
 * - T2 Person verification (inquiry.completed / inquiry.failed)
 * - T2 Business KYB verification
 *
 * Mounted as a public route (no auth middleware) — verifies
 * Persona webhook signatures internally.
 *
 * @module routes/persona-webhooks
 */

import { Hono } from 'hono';
import { createClient } from '../db/client.js';
import { logAudit } from '../utils/helpers.js';
import {
  verifyPersonaWebhookSignature,
  handlePersonaWebhook,
  getAccountIdFromInquiry,
} from '../services/kyc/persona.js';

const app = new Hono();

// ============================================
// POST /webhooks/persona — Persona verification webhook
// ============================================
app.post('/', async (c) => {
  const supabase = createClient();

  // Get raw body for signature verification
  let rawBody: string;
  let payload: any;
  try {
    rawBody = await c.req.text();
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Verify webhook signature
  const signature = c.req.header('persona-signature') || c.req.header('x-persona-signature') || '';
  if (!verifyPersonaWebhookSignature(rawBody, signature)) {
    console.warn('[persona-webhook] Invalid signature');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Process the webhook
  const result = await handlePersonaWebhook(payload);

  // Look up the account associated with this inquiry
  const accountInfo = await getAccountIdFromInquiry(supabase, result.inquiryId);
  if (!accountInfo) {
    console.warn(`[persona-webhook] No account found for inquiry ${result.inquiryId} — acknowledging anyway`);
    return c.json({ received: true, matched: false });
  }

  const { accountId, tenantId } = accountInfo;

  if (result.status === 'approved') {
    // Upgrade account to T2
    const { error } = await (supabase.from('accounts') as any)
      .update({
        verification_tier: 2,
        verification_status: 'verified',
        metadata: {
          persona_inquiry_id: result.inquiryId,
          persona_verified_at: new Date().toISOString(),
          persona_checks: result.verificationChecks,
        },
      })
      .eq('id', accountId)
      .eq('tenant_id', tenantId);

    if (error) {
      console.error(`[persona-webhook] Failed to upgrade account ${accountId}:`, error);
      return c.json({ error: 'Failed to process webhook' }, 500);
    }

    await logAudit(supabase as any, {
      tenantId,
      entityType: 'account',
      entityId: accountId,
      action: 'tier_upgraded',
      actorType: 'api_key',
      actorId: 'persona_webhook',
      actorName: 'Persona Verification',
      changes: {
        before: { verification_status: 'pending' },
        after: { verification_tier: 2, verification_status: 'verified' },
      },
      metadata: {
        inquiryId: result.inquiryId,
        checks: result.verificationChecks,
      },
    });

    console.log(`[persona-webhook] Account ${accountId} upgraded to T2 via Persona`);
  } else if (result.status === 'declined') {
    // Mark verification as failed
    const { data: account } = await (supabase.from('accounts') as any)
      .select('metadata')
      .eq('id', accountId)
      .eq('tenant_id', tenantId)
      .single();

    const existingMeta = account?.metadata || {};

    await (supabase.from('accounts') as any)
      .update({
        verification_status: 'unverified',
        metadata: {
          ...existingMeta,
          persona_inquiry_id: result.inquiryId,
          persona_declined_at: new Date().toISOString(),
          persona_checks: result.verificationChecks,
        },
      })
      .eq('id', accountId)
      .eq('tenant_id', tenantId);

    await logAudit(supabase as any, {
      tenantId,
      entityType: 'account',
      entityId: accountId,
      action: 'verification_declined',
      actorType: 'api_key',
      actorId: 'persona_webhook',
      actorName: 'Persona Verification',
      metadata: {
        inquiryId: result.inquiryId,
        checks: result.verificationChecks,
      },
    });

    console.log(`[persona-webhook] Account ${accountId} verification declined`);
  } else {
    // pending_review — keep status as pending
    console.log(`[persona-webhook] Account ${accountId} inquiry ${result.inquiryId} needs review`);
  }

  return c.json({ received: true, status: result.status });
});

export default app;
