/**
 * Story 73.8: T1 Lightweight KYC Verification
 *
 * Validates basic identity fields for Tier 1 upgrade:
 * - Legal name (>= 2 characters)
 * - Date of birth (valid date, person >= 18 years old)
 * - Country not sanctioned
 *
 * In production, this would also trigger a Persona Starter
 * sanctions/PEP screening. Currently stubbed with a TODO.
 *
 * @module services/kyc/t1-verification
 */

import { isSanctionedCountry } from './screening.js';

export interface T1VerificationInput {
  legal_name: string;
  date_of_birth: string;
  country: string;
  company_name?: string;
}

export interface T1VerificationResult {
  approved: boolean;
  reason?: string;
}

/**
 * Verify that the submitted data qualifies for Tier 1 (lightweight KYC).
 */
export async function verifyT1(data: T1VerificationInput): Promise<T1VerificationResult> {
  // 1. Validate legal name
  if (!data.legal_name || data.legal_name.trim().length < 2) {
    return { approved: false, reason: 'Legal name must be at least 2 characters' };
  }

  // 2. Validate date of birth
  const dob = new Date(data.date_of_birth);
  if (isNaN(dob.getTime())) {
    return { approved: false, reason: 'Invalid date of birth format' };
  }

  // Check age >= 18
  const today = new Date();
  const eighteenYearsAgo = new Date(
    today.getFullYear() - 18,
    today.getMonth(),
    today.getDate(),
  );
  if (dob > eighteenYearsAgo) {
    return { approved: false, reason: 'Applicant must be at least 18 years old' };
  }

  // 3. Validate country is not sanctioned
  if (!data.country || data.country.trim().length === 0) {
    return { approved: false, reason: 'Country is required' };
  }
  if (isSanctionedCountry(data.country)) {
    return { approved: false, reason: 'Service is not available in your region' };
  }

  // TODO: In production, call Persona Starter API for sanctions/PEP screening:
  //   const personaResult = await personaStarterScreen({
  //     name: data.legal_name,
  //     dateOfBirth: data.date_of_birth,
  //     country: data.country,
  //   });
  //   if (personaResult.flagged) {
  //     return { approved: false, reason: 'Additional review required' };
  //   }

  return { approved: true };
}
