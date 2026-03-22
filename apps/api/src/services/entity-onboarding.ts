/**
 * Entity Onboarding Service
 *
 * Story 51.3: Unified onboarding endpoint that creates account + payment methods + triggers verification.
 * Story 51.4: Payment method verification with proper check digit validation.
 *
 * @see Epic 51: Unified Platform Onboarding
 */

import { randomUUID } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  verifyPixKey as verifyPixKeyService,
  verifyCLABE,
  verifyBankAccount,
  PixKeyType,
} from './payment-method-verification.js';

// ============================================
// Types
// ============================================

export interface PaymentMethodInput {
  type: 'pix' | 'spei' | 'bank_account';
  // PIX fields
  pix_key?: string;
  pix_key_type?: 'cpf' | 'cnpj' | 'email' | 'phone' | 'evp';
  // SPEI fields
  clabe?: string;
  // Bank account fields
  bank_code?: string;
  account_number?: string;
  routing_number?: string;
}

export interface VerificationInput {
  skip_kyb?: boolean;
  skip_kyc?: boolean;
  documents?: {
    type: string;
    url: string;
  }[];
}

export interface PersonOnboardingInput {
  type: 'person';
  first_name: string;
  last_name: string;
  email?: string;
  country: string;
  tax_id?: string;
  payment_methods?: PaymentMethodInput[];
  verification?: VerificationInput;
  metadata?: Record<string, unknown>;
}

export interface BusinessOnboardingInput {
  type: 'business';
  business_name: string;
  email?: string;
  country: string;
  tax_id?: string;
  payment_methods?: PaymentMethodInput[];
  verification?: VerificationInput;
  metadata?: Record<string, unknown>;
}

export type OnboardingInput = PersonOnboardingInput | BusinessOnboardingInput;

export interface PaymentMethodOutput {
  id: string;
  type: 'pix' | 'spei' | 'bank_account';
  status: 'verified' | 'pending' | 'failed';
  details?: Record<string, unknown>;
}

export interface OnboardingResult {
  account_id: string;
  status: 'active' | 'pending_verification' | 'requires_documents';
  verification: {
    kyb_status?: 'not_started' | 'in_progress' | 'verified' | 'rejected';
    kyc_status?: 'not_started' | 'in_progress' | 'verified' | 'rejected';
    estimated_completion?: string;
  };
  payment_methods: PaymentMethodOutput[];
  ready_for_payments: boolean;
  ready_for_payments_after?: string;
}

// ============================================
// Payment Method Verification (Story 51.4)
// ============================================

/**
 * Verify a PIX key using the verification service
 * Includes check digit validation for CPF/CNPJ and DICT lookup simulation
 */
async function verifyPixKey(
  pixKey: string,
  pixKeyType: string
): Promise<{ verified: boolean; name?: string; error?: string; details?: Record<string, unknown> }> {
  const result = await verifyPixKeyService(pixKey, pixKeyType as PixKeyType);

  return {
    verified: result.verified,
    name: result.owner_name,
    error: result.error,
    details: {
      bank_name: result.bank_name,
      bank_code: result.bank_code,
      account_type: result.account_type,
    },
  };
}

/**
 * Validate CLABE format with check digit verification
 * Uses the payment-method-verification service for proper validation
 */
function validateClabe(clabe: string): { valid: boolean; error?: string; details?: Record<string, unknown> } {
  const result = verifyCLABE(clabe);

  return {
    valid: result.valid,
    error: result.error,
    details: result.valid ? {
      bank_name: result.bank_name,
      bank_code: result.bank_code,
      city_code: result.city_code,
    } : undefined,
  };
}

// ============================================
// Main Onboarding Function
// ============================================

/**
 * Onboard a new entity (person or business)
 *
 * Creates:
 * 1. Account record
 * 2. Payment method records
 * 3. Triggers verification if not skipped
 *
 * @param tenantId - Tenant ID for multi-tenancy
 * @param input - Onboarding input data
 * @param supabase - Supabase client
 * @returns Onboarding result with account ID and status
 */
export async function onboardEntity(
  tenantId: string,
  input: OnboardingInput,
  supabase: SupabaseClient,
  environment: 'test' | 'live' = 'test'
): Promise<OnboardingResult> {
  const accountId = randomUUID();
  const now = new Date();

  // Determine name based on type
  const name = input.type === 'business'
    ? input.business_name
    : `${input.first_name} ${input.last_name}`;

  // Determine if verification is skipped
  const skipVerification = input.type === 'business'
    ? input.verification?.skip_kyb
    : input.verification?.skip_kyc;

  const hasDocuments = input.verification?.documents && input.verification.documents.length > 0;

  // Determine initial verification status
  let verificationStatus: 'unverified' | 'pending' | 'verified' = 'unverified';
  let verificationTier = 0;

  if (skipVerification) {
    // Skipped verification - account is active but unverified (tier 0)
    verificationStatus = 'unverified';
    verificationTier = 0;
  } else if (hasDocuments) {
    // Documents provided - start verification
    verificationStatus = 'pending';
    verificationTier = 0;
  } else {
    // No documents, verification not skipped - requires documents
    verificationStatus = 'unverified';
    verificationTier = 0;
  }

  // Create account
  const { error: accountError } = await supabase
    .from('accounts')
    .insert({
      id: accountId,
      tenant_id: tenantId,
      environment,
      type: input.type,
      name,
      email: input.email || null,
      country: input.country,
      verification_tier: verificationTier,
      verification_status: verificationStatus,
      verification_type: input.type === 'business' ? 'kyb' : 'kyc',
      balance_total: 0,
      balance_available: 0,
      balance_in_streams: 0,
      balance_buffer: 0,
      currency: 'USDC',
      metadata: {
        ...input.metadata,
        tax_id: input.tax_id,
        onboarded_at: now.toISOString(),
        onboarding_source: 'api',
      },
    });

  if (accountError) {
    throw new Error(`Failed to create account: ${accountError.message}`);
  }

  // Process payment methods
  const paymentMethods: PaymentMethodOutput[] = [];

  if (input.payment_methods && input.payment_methods.length > 0) {
    for (const pm of input.payment_methods) {
      const pmId = randomUUID();
      let status: 'verified' | 'pending' | 'failed' = 'pending';
      let details: Record<string, unknown> = {};

      if (pm.type === 'pix' && pm.pix_key && pm.pix_key_type) {
        // Verify PIX key with check digit validation and DICT lookup
        const verification = await verifyPixKey(pm.pix_key, pm.pix_key_type);
        status = verification.verified ? 'verified' : 'failed';
        details = {
          pix_key: pm.pix_key,
          pix_key_type: pm.pix_key_type,
          verified_name: verification.name,
          bank_name: verification.details?.bank_name,
          bank_code: verification.details?.bank_code,
          account_type: verification.details?.account_type,
          error: verification.error,
        };
      } else if (pm.type === 'spei' && pm.clabe) {
        // Validate CLABE with check digit verification
        const validation = validateClabe(pm.clabe);
        status = validation.valid ? 'verified' : 'failed';
        details = {
          clabe: pm.clabe,
          clabe_masked: pm.clabe.slice(0, 6) + '******' + pm.clabe.slice(-4),
          bank_name: validation.details?.bank_name,
          bank_code: validation.details?.bank_code,
          city_code: validation.details?.city_code,
          error: validation.error,
        };
      } else if (pm.type === 'bank_account') {
        // Validate bank account with routing number check digit
        if (pm.bank_code && pm.account_number) {
          // If routing number provided, validate it
          if (pm.routing_number) {
            const bankValidation = verifyBankAccount(pm.routing_number, pm.account_number);
            status = bankValidation.valid ? 'verified' : 'failed';
            details = {
              bank_code: pm.bank_code,
              bank_name: bankValidation.bank_name,
              account_number_last4: pm.account_number.slice(-4),
              routing_number: pm.routing_number,
              account_type: bankValidation.account_type,
              error: bankValidation.error,
            };
          } else {
            status = 'verified';
            details = {
              bank_code: pm.bank_code,
              account_number_last4: pm.account_number.slice(-4),
            };
          }
        } else {
          status = 'failed';
          details = { error: 'Bank code and account number are required' };
        }
      }

      // Store payment method in metadata (in production, would be separate table)
      paymentMethods.push({
        id: pmId,
        type: pm.type,
        status,
        details,
      });
    }

    // Update account with payment methods
    await supabase
      .from('accounts')
      .update({
        metadata: {
          ...input.metadata,
          tax_id: input.tax_id,
          onboarded_at: now.toISOString(),
          onboarding_source: 'api',
          payment_methods: paymentMethods,
        },
      })
      .eq('id', accountId)
      .eq('tenant_id', tenantId)
      .eq('environment', environment);
  }

  // If documents were provided, create verification request (mock)
  let estimatedCompletion: string | undefined;
  if (hasDocuments && !skipVerification) {
    // Simulate 7-day verification time
    const completionDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    estimatedCompletion = completionDate.toISOString();

    // In production, would create verification request in external KYC/KYB provider
    console.log(`[Onboarding] Verification started for account ${accountId}`);
  }

  // Determine ready_for_payments status
  const hasVerifiedPaymentMethod = paymentMethods.some(pm => pm.status === 'verified');
  const readyForPayments = (skipVerification || verificationStatus === 'verified') && hasVerifiedPaymentMethod;

  let readyForPaymentsAfter: string | undefined;
  if (!readyForPayments) {
    if (!hasVerifiedPaymentMethod) {
      readyForPaymentsAfter = 'payment_method_verified';
    } else if (verificationStatus === 'pending') {
      readyForPaymentsAfter = input.type === 'business' ? 'kyb_completed' : 'kyc_completed';
    } else if (!hasDocuments && !skipVerification) {
      readyForPaymentsAfter = 'documents_submitted';
    }
  }

  // Build verification status for response
  const verificationResponse: OnboardingResult['verification'] = {};
  if (input.type === 'business') {
    verificationResponse.kyb_status = skipVerification
      ? 'not_started'
      : hasDocuments
        ? 'in_progress'
        : 'not_started';
    if (estimatedCompletion) {
      verificationResponse.estimated_completion = estimatedCompletion;
    }
  } else {
    verificationResponse.kyc_status = skipVerification
      ? 'not_started'
      : hasDocuments
        ? 'in_progress'
        : 'not_started';
    if (estimatedCompletion) {
      verificationResponse.estimated_completion = estimatedCompletion;
    }
  }

  // Determine overall status
  let overallStatus: OnboardingResult['status'];
  if (readyForPayments) {
    overallStatus = 'active';
  } else if (hasDocuments || skipVerification) {
    overallStatus = 'pending_verification';
  } else {
    overallStatus = 'requires_documents';
  }

  return {
    account_id: accountId,
    status: overallStatus,
    verification: verificationResponse,
    payment_methods: paymentMethods,
    ready_for_payments: readyForPayments,
    ready_for_payments_after: readyForPaymentsAfter,
  };
}
