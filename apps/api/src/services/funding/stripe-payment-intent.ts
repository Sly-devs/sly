/**
 * Crypto Onramp Services
 * Coinbase Onramp: Session token generation for popup widget
 * Stripe Crypto Onramp: Session creation for embedded widget
 */

import { CoinbaseAuthenticator } from '@coinbase/coinbase-sdk/dist/coinbase/authenticator.js';
import Stripe from 'stripe';

const CDP_API_KEY = () => process.env.CDP_API_KEY_NAME || '';
const CDP_API_SECRET = () => process.env.CDP_API_KEY_PRIVATE_KEY || '';

// Map wallet blockchain field to Coinbase network names
export const BLOCKCHAIN_TO_COINBASE: Record<string, string> = {
  base: 'base',
  eth: 'ethereum',
  ethereum: 'ethereum',
  polygon: 'polygon',
  sol: 'solana',
  solana: 'solana',
  avax: 'avalanche',
};

export interface CreateOnrampTokenInput {
  wallet_address: string;
  blockchain: string;
}

export interface OnrampTokenResult {
  token: string;
}

/**
 * Create a Coinbase Onramp session token.
 */
export async function createOnrampToken(
  input: CreateOnrampTokenInput
): Promise<OnrampTokenResult> {
  const apiKey = CDP_API_KEY();
  const apiSecret = CDP_API_SECRET();

  if (!apiKey || !apiSecret) {
    return { token: `mock_token_${Date.now()}` };
  }

  const network = BLOCKCHAIN_TO_COINBASE[input.blockchain] || 'base';

  // Use Coinbase's own authenticator to build the JWT
  const auth = new CoinbaseAuthenticator(apiKey, apiSecret, 'sly');
  const jwt = await auth.buildJWT('https://api.developer.coinbase.com/onramp/v1/token', 'POST');

  const response = await fetch('https://api.developer.coinbase.com/onramp/v1/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      addresses: [{ address: input.wallet_address, blockchains: [network] }],
      assets: ['USDC'],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error(`[Coinbase Onramp] API error: ${response.status}`, errorBody);
    throw new Error(`Coinbase API error: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();
  return { token: data.token };
}

// ============================================
// Stripe Crypto Onramp
// ============================================

const BLOCKCHAIN_TO_STRIPE: Record<string, string> = {
  base: 'base',
  eth: 'ethereum',
  ethereum: 'ethereum',
  polygon: 'polygon',
  sol: 'solana',
  solana: 'solana',
};

export { BLOCKCHAIN_TO_STRIPE };

const getStripe = (): Stripe | null => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' as any });
};

export interface CreateStripeOnrampInput {
  wallet_address: string;
  blockchain: string;
  tenant_id: string;
  wallet_id: string;
  account_id: string;
}

export interface StripeOnrampResult {
  client_secret: string;
  session_id: string;
}

/**
 * Create a Stripe Crypto Onramp session.
 * Returns a client_secret for the embeddable widget.
 */
export async function createStripeOnrampSession(
  input: CreateStripeOnrampInput
): Promise<StripeOnrampResult> {
  const stripe = getStripe();
  const network = BLOCKCHAIN_TO_STRIPE[input.blockchain] || 'base';

  if (!stripe) {
    const mockId = `cos_mock_${Date.now()}`;
    return {
      client_secret: `${mockId}_secret_mock`,
      session_id: mockId,
    };
  }

  const session = await stripe.rawRequest('POST', '/v1/crypto/onramp_sessions', {
    [`wallet_addresses[${network}]`]: input.wallet_address,
    lock_wallet_address: 'true',
    'destination_currencies[]': 'usdc',
    'destination_networks[]': network,
    'metadata[tenant_id]': input.tenant_id,
    'metadata[wallet_id]': input.wallet_id,
    'metadata[account_id]': input.account_id,
  });

  const data = JSON.parse(session.rawResponse.toString());

  return {
    client_secret: data.client_secret,
    session_id: data.id,
  };
}
