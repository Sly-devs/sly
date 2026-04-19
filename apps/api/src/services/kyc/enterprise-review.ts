/**
 * Story 73.14: T3 Enterprise EDD Workflow
 *
 * Enhanced Due Diligence (EDD) review workflow for Tier 3 enterprise accounts.
 * Creates review tickets tracked in the account's metadata (JSONB),
 * requiring manual compliance team approval.
 *
 * Checklist items:
 * - Financial statements review
 * - Source of funds verification
 * - Enhanced UBO (Ultimate Beneficial Owner) screening
 * - Ongoing monitoring setup
 *
 * @module services/kyc/enterprise-review
 */

import crypto from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================
// Types
// ============================================

export interface EDDReviewTicket {
  id: string;
  accountId: string;
  status: 'pending' | 'in_review' | 'approved' | 'rejected';
  checklist: {
    financials: boolean;
    sourceOfFunds: boolean;
    enhancedUBO: boolean;
    ongoingMonitoring: boolean;
  };
  documents: Array<{ name: string; uploadedAt: string }>;
  createdAt: string;
  updatedAt: string;
  reviewedBy?: string;
  reviewNotes?: string;
}

export interface EDDCustomLimits {
  perTx: number;
  daily: number;
  monthly: number;
}

// ============================================
// EDD Review Management
// ============================================

/**
 * Create a new EDD review ticket for a T3 enterprise upgrade request.
 *
 * The review record is stored in the account's metadata under `edd_review`.
 * In a full implementation, this could be a dedicated `edd_reviews` table.
 */
export async function createEDDReview(
  supabase: SupabaseClient,
  accountId: string,
  tenantId: string,
): Promise<EDDReviewTicket> {
  const reviewId = crypto.randomUUID();
  const now = new Date().toISOString();

  const ticket: EDDReviewTicket = {
    id: reviewId,
    accountId,
    status: 'pending',
    checklist: {
      financials: false,
      sourceOfFunds: false,
      enhancedUBO: false,
      ongoingMonitoring: false,
    },
    documents: [],
    createdAt: now,
    updatedAt: now,
  };

  // Fetch current account metadata
  const { data: account, error: fetchError } = await (supabase.from('accounts') as any)
    .select('id, metadata')
    .eq('id', accountId)
    .eq('tenant_id', tenantId)
    .single();

  if (fetchError || !account) {
    throw new Error(`Account ${accountId} not found in tenant ${tenantId}`);
  }

  const existingMetadata = account.metadata || {};

  // Store EDD review in metadata
  const { error: updateError } = await (supabase.from('accounts') as any)
    .update({
      verification_status: 'pending',
      metadata: {
        ...existingMetadata,
        edd_review: ticket,
      },
    })
    .eq('id', accountId)
    .eq('tenant_id', tenantId);

  if (updateError) {
    throw new Error(`Failed to create EDD review: ${updateError.message}`);
  }

  console.log(`[enterprise-review] Created EDD review ${reviewId} for account ${accountId}`);
  return ticket;
}

/**
 * Approve an EDD review and upgrade the account to Tier 3.
 *
 * Optionally sets custom transaction limits for the enterprise account.
 * If no custom limits are provided, the default T3 limits from kya_tier_limits are used.
 */
export async function approveEDDReview(
  supabase: SupabaseClient,
  reviewId: string,
  tenantId: string,
  customLimits?: EDDCustomLimits,
  reviewedBy?: string,
): Promise<void> {
  // Find the account with this review ID
  const { data: accounts, error: searchError } = await (supabase.from('accounts') as any)
    .select('id, metadata, tenant_id')
    .eq('tenant_id', tenantId)
    .not('metadata->edd_review', 'is', null);

  if (searchError) {
    throw new Error(`Failed to search for EDD review: ${searchError.message}`);
  }

  const account = accounts?.find(
    (a: any) => a.metadata?.edd_review?.id === reviewId,
  );

  if (!account) {
    throw new Error(`EDD review ${reviewId} not found`);
  }

  const now = new Date().toISOString();
  const existingMetadata = account.metadata || {};
  const eddReview = existingMetadata.edd_review as EDDReviewTicket;

  // Update the review ticket
  const updatedReview: EDDReviewTicket = {
    ...eddReview,
    status: 'approved',
    updatedAt: now,
    reviewedBy: reviewedBy || 'system',
    checklist: {
      financials: true,
      sourceOfFunds: true,
      enhancedUBO: true,
      ongoingMonitoring: true,
    },
  };

  // Build update payload
  const updatePayload: Record<string, any> = {
    verification_tier: 3,
    verification_status: 'verified',
    verification_path: 'enterprise',
    metadata: {
      ...existingMetadata,
      edd_review: updatedReview,
      verifiedAt: now,
      verifiedBy: reviewedBy || 'system',
    },
  };

  // Apply custom limits if provided
  if (customLimits) {
    updatePayload.metadata.custom_limits = {
      per_transaction: customLimits.perTx,
      daily: customLimits.daily,
      monthly: customLimits.monthly,
      applied_at: now,
    };
  }

  const { error: updateError } = await (supabase.from('accounts') as any)
    .update(updatePayload)
    .eq('id', account.id)
    .eq('tenant_id', tenantId);

  if (updateError) {
    throw new Error(`Failed to approve EDD review: ${updateError.message}`);
  }

  // If custom limits are set, update child agents' effective limits
  if (customLimits) {
    const { data: agents } = await (supabase.from('agents') as any)
      .select('id, limit_per_transaction, limit_daily, limit_monthly')
      .eq('parent_account_id', account.id)
      .eq('tenant_id', tenantId);

    if (agents && agents.length > 0) {
      for (const agent of agents) {
        await (supabase.from('agents') as any)
          .update({
            effective_limit_per_tx: Math.min(agent.limit_per_transaction, customLimits.perTx),
            effective_limit_daily: Math.min(agent.limit_daily, customLimits.daily),
            effective_limit_monthly: Math.min(agent.limit_monthly, customLimits.monthly),
          })
          .eq('id', agent.id);
      }
    }
  }

  console.log(`[enterprise-review] Approved EDD review ${reviewId}, account ${account.id} upgraded to T3`);
}

/**
 * Reject an EDD review.
 */
export async function rejectEDDReview(
  supabase: SupabaseClient,
  reviewId: string,
  tenantId: string,
  reason?: string,
  reviewedBy?: string,
): Promise<void> {
  const { data: accounts, error: searchError } = await (supabase.from('accounts') as any)
    .select('id, metadata, tenant_id')
    .eq('tenant_id', tenantId)
    .not('metadata->edd_review', 'is', null);

  if (searchError) {
    throw new Error(`Failed to search for EDD review: ${searchError.message}`);
  }

  const account = accounts?.find(
    (a: any) => a.metadata?.edd_review?.id === reviewId,
  );

  if (!account) {
    throw new Error(`EDD review ${reviewId} not found`);
  }

  const now = new Date().toISOString();
  const existingMetadata = account.metadata || {};
  const eddReview = existingMetadata.edd_review as EDDReviewTicket;

  const updatedReview: EDDReviewTicket = {
    ...eddReview,
    status: 'rejected',
    updatedAt: now,
    reviewedBy: reviewedBy || 'system',
    reviewNotes: reason,
  };

  const { error: updateError } = await (supabase.from('accounts') as any)
    .update({
      verification_status: 'unverified',
      metadata: {
        ...existingMetadata,
        edd_review: updatedReview,
      },
    })
    .eq('id', account.id)
    .eq('tenant_id', tenantId);

  if (updateError) {
    throw new Error(`Failed to reject EDD review: ${updateError.message}`);
  }

  console.log(`[enterprise-review] Rejected EDD review ${reviewId} for account ${account.id}: ${reason}`);
}
