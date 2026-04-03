/**
 * Crossmint Onramp Service
 * Creates orders for fiat-to-USDC purchases via Crossmint's embedded checkout.
 */

const CROSSMINT_API_KEY = () => process.env.CROSSMINT_API_KEY || '';
const CROSSMINT_ENV = () => process.env.CROSSMINT_ENV || 'production';

const CROSSMINT_BASE_URL = () =>
  CROSSMINT_ENV() === 'production'
    ? 'https://www.crossmint.com'
    : 'https://staging.crossmint.com';

// USDC token locators per chain
const USDC_LOCATORS: Record<string, string> = {
  base: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  ethereum: 'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  polygon: 'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  solana: 'solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

const BLOCKCHAIN_TO_CROSSMINT: Record<string, string> = {
  base: 'base',
  eth: 'ethereum',
  ethereum: 'ethereum',
  polygon: 'polygon',
  sol: 'solana',
  solana: 'solana',
};

export { BLOCKCHAIN_TO_CROSSMINT };

export interface CreateCrossmintOrderInput {
  wallet_address: string;
  blockchain: string;
  amount: string;
  receipt_email?: string;
}

export interface CrossmintOrderResult {
  order_id: string;
  client_secret: string;
}

/**
 * Create a Crossmint onramp order.
 * Returns orderId and clientSecret for the embedded checkout component.
 */
export async function createCrossmintOrder(
  input: CreateCrossmintOrderInput
): Promise<CrossmintOrderResult> {
  const apiKey = CROSSMINT_API_KEY();
  const chain = BLOCKCHAIN_TO_CROSSMINT[input.blockchain] || 'base';
  const tokenLocator = USDC_LOCATORS[chain];

  if (!apiKey) {
    // Mock mode
    return {
      order_id: `order_mock_${Date.now()}`,
      client_secret: `cs_mock_${Date.now()}`,
    };
  }

  if (!tokenLocator) {
    throw new Error(`USDC not supported on ${chain} via Crossmint`);
  }

  // First, link the wallet to the user (required by Crossmint)
  // Skip if no email provided — Crossmint will handle it in checkout

  const response = await fetch(`${CROSSMINT_BASE_URL()}/api/2022-06-09/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      lineItems: [
        {
          tokenLocator,
          executionParameters: {
            mode: 'exact-in',
            amount: input.amount,
          },
        },
      ],
      payment: {
        method: 'card',
        ...(input.receipt_email ? { receiptEmail: input.receipt_email } : {}),
      },
      recipient: {
        walletAddress: input.wallet_address,
      },
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('[Crossmint] API error:', response.status, errorBody);
    throw new Error(`Crossmint error: ${response.status} - ${errorBody}`);
  }

  const data = await response.json();

  return {
    order_id: data.order?.orderId || data.orderId,
    client_secret: data.clientSecret,
  };
}
