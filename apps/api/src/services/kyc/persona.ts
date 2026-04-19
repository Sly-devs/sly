/**
 * Stories 73.10 + 73.11: Persona SDK Integration (T2 Person + KYB)
 *
 * Service layer for Persona identity verification:
 * - T2 Person: Document + Selfie verification
 * - T2 Business: KYB (Know Your Business) verification
 * - Webhook handler for async status updates
 *
 * All external calls are stubs with TODO comments for production wiring.
 *
 * @module services/kyc/persona
 */

import crypto from 'crypto';

// ============================================
// Types
// ============================================

export interface PersonaVerificationResult {
  status: 'approved' | 'declined' | 'pending_review';
  inquiryId: string;
  verificationChecks: {
    document: boolean;
    selfie: boolean;
    address?: boolean;
  };
}

export interface PersonaInquiryResponse {
  inquiryUrl: string;
  inquiryId: string;
}

// ============================================
// Persona Configuration
// ============================================

// TODO: Move to environment configuration in production
const PERSONA_API_KEY = process.env.PERSONA_API_KEY || '';
const PERSONA_TEMPLATE_ID_PERSON = process.env.PERSONA_TEMPLATE_ID_PERSON || 'tmpl_person_kyc';
const PERSONA_TEMPLATE_ID_KYB = process.env.PERSONA_TEMPLATE_ID_KYB || 'tmpl_business_kyb';
const PERSONA_WEBHOOK_SECRET = process.env.PERSONA_WEBHOOK_SECRET || '';

// ============================================
// T2 Person Verification
// ============================================

/**
 * Initiate a Persona inquiry for T2 person verification (Document + Selfie).
 *
 * In production, this calls the Persona API to create an inquiry
 * and returns the hosted flow URL for the user to complete.
 */
export async function initiatePersonaVerification(
  accountId: string,
  redirectUrl: string,
): Promise<PersonaInquiryResponse> {
  const inquiryId = `inq_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // TODO: Production implementation — call Persona API:
  //   const resp = await fetch('https://withpersona.com/api/v1/inquiries', {
  //     method: 'POST',
  //     headers: {
  //       'Authorization': `Bearer ${PERSONA_API_KEY}`,
  //       'Content-Type': 'application/json',
  //       'Persona-Version': '2023-01-05',
  //     },
  //     body: JSON.stringify({
  //       data: {
  //         attributes: {
  //           'inquiry-template-id': PERSONA_TEMPLATE_ID_PERSON,
  //           'reference-id': accountId,
  //           'redirect-uri': redirectUrl,
  //         },
  //       },
  //     }),
  //   });
  //   const data = await resp.json();
  //   return {
  //     inquiryUrl: data.data.attributes['hosted-flow-url'],
  //     inquiryId: data.data.id,
  //   };

  console.log(`[persona] Initiated T2 person verification for account ${accountId}`);
  return {
    inquiryUrl: `https://withpersona.com/verify?inquiry-id=${inquiryId}&redirect-uri=${encodeURIComponent(redirectUrl)}`,
    inquiryId,
  };
}

// ============================================
// T2 Business Verification (KYB)
// ============================================

/**
 * Initiate a Persona inquiry for T2 business verification (KYB).
 *
 * In production, this creates a KYB inquiry flow that verifies:
 * - Business registration documents
 * - Beneficial ownership
 * - Business address verification
 */
export async function initiatePersonaKYB(
  accountId: string,
  redirectUrl: string,
): Promise<PersonaInquiryResponse> {
  const inquiryId = `inq_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

  // TODO: Production implementation — call Persona API:
  //   const resp = await fetch('https://withpersona.com/api/v1/inquiries', {
  //     method: 'POST',
  //     headers: {
  //       'Authorization': `Bearer ${PERSONA_API_KEY}`,
  //       'Content-Type': 'application/json',
  //       'Persona-Version': '2023-01-05',
  //     },
  //     body: JSON.stringify({
  //       data: {
  //         attributes: {
  //           'inquiry-template-id': PERSONA_TEMPLATE_ID_KYB,
  //           'reference-id': accountId,
  //           'redirect-uri': redirectUrl,
  //         },
  //       },
  //     }),
  //   });
  //   const data = await resp.json();
  //   return {
  //     inquiryUrl: data.data.attributes['hosted-flow-url'],
  //     inquiryId: data.data.id,
  //   };

  console.log(`[persona] Initiated T2 KYB verification for account ${accountId}`);
  return {
    inquiryUrl: `https://withpersona.com/verify?inquiry-id=${inquiryId}&redirect-uri=${encodeURIComponent(redirectUrl)}`,
    inquiryId,
  };
}

// ============================================
// Webhook Handler
// ============================================

/**
 * Verify the Persona webhook signature.
 *
 * TODO: Implement actual HMAC-SHA256 signature verification in production.
 */
export function verifyPersonaWebhookSignature(
  payload: string,
  signature: string,
): boolean {
  if (!PERSONA_WEBHOOK_SECRET) {
    console.warn('[persona] No webhook secret configured — skipping signature verification');
    return true; // Allow in development
  }

  // TODO: Production implementation:
  //   const expectedSig = crypto
  //     .createHmac('sha256', PERSONA_WEBHOOK_SECRET)
  //     .update(payload)
  //     .digest('hex');
  //   return crypto.timingSafeEqual(
  //     Buffer.from(signature),
  //     Buffer.from(`sha256=${expectedSig}`),
  //   );

  return true;
}

/**
 * Process a Persona webhook payload and extract the verification result.
 *
 * Persona sends webhooks for inquiry status changes:
 * - inquiry.completed: All checks passed
 * - inquiry.failed: One or more checks failed
 * - inquiry.needs-review: Manual review required
 */
export async function handlePersonaWebhook(
  payload: any,
): Promise<PersonaVerificationResult> {
  const eventType = payload?.data?.attributes?.name || payload?.type || '';
  const inquiryId = payload?.data?.relationships?.inquiry?.data?.id
    || payload?.data?.id
    || 'unknown';
  const status = payload?.data?.attributes?.status || '';

  // Map Persona event types to our status
  let verificationStatus: 'approved' | 'declined' | 'pending_review';
  if (eventType === 'inquiry.completed' || status === 'completed') {
    verificationStatus = 'approved';
  } else if (eventType === 'inquiry.failed' || status === 'failed') {
    verificationStatus = 'declined';
  } else {
    verificationStatus = 'pending_review';
  }

  // Extract individual check results
  const checks = payload?.data?.attributes?.checks || {};

  console.log(`[persona] Webhook processed: inquiry=${inquiryId} status=${verificationStatus}`);

  return {
    status: verificationStatus,
    inquiryId,
    verificationChecks: {
      document: checks?.document_verification?.status === 'passed' || verificationStatus === 'approved',
      selfie: checks?.selfie_verification?.status === 'passed' || verificationStatus === 'approved',
      address: checks?.address_verification?.status === 'passed' || undefined,
    },
  };
}

/**
 * Look up the account ID from a Persona inquiry ID.
 *
 * In production, the reference-id set during inquiry creation maps to accountId.
 */
export async function getAccountIdFromInquiry(
  supabase: any,
  inquiryId: string,
): Promise<{ accountId: string; tenantId: string } | null> {
  // Look up account by stored persona inquiry ID in metadata
  const { data } = await supabase
    .from('accounts')
    .select('id, tenant_id, metadata')
    .contains('metadata', { persona_inquiry_id: inquiryId })
    .single();

  if (!data) {
    console.warn(`[persona] No account found for inquiry ${inquiryId}`);
    return null;
  }

  return { accountId: data.id, tenantId: data.tenant_id };
}
