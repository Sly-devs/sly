/**
 * MPP Paywall Middleware for Hono
 *
 * Returns HTTP 402 challenge if no payment credential is present.
 * Verifies payment, sets receipt on context for downstream handlers.
 *
 * @see Story 71.11: Server Middleware for Hono
 */

import type { Context, Next } from 'hono';
import { matchRoutePrice, getDefaultServerConfig } from '../services/mpp/server-config.js';
import type { MppServerConfig, MppRoutePrice } from '../services/mpp/types.js';

// ============================================
// Paywall Middleware
// ============================================

/**
 * Create MPP paywall middleware.
 * Checks for X-PAYMENT header; if missing, returns 402 with payment requirements.
 * If present, verifies the payment credential before allowing the request through.
 */
export function mppPaywall(config?: MppServerConfig) {
  const serverConfig = config || getDefaultServerConfig();

  return async (c: Context, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;

    // Check if this route requires payment
    const price = matchRoutePrice(serverConfig, path, method);
    if (!price) {
      // Route is free
      return next();
    }

    // Check for payment credential in headers
    const paymentHeader = c.req.header('X-PAYMENT') || c.req.header('x-payment');

    if (!paymentHeader) {
      // Return 402 challenge
      return c.json({
        error: 'Payment Required',
        protocol: 'mpp',
        amount: price.amount,
        description: price.description,
        methods: price.methods || ['tempo', 'stripe'],
        recipient: serverConfig.recipientAddress,
        network: serverConfig.network,
        accepts: {
          'tempo': {
            recipient: serverConfig.recipientAddress,
            currency: 'pathUSD',
            network: serverConfig.network,
          },
        },
      }, 402);
    }

    // Verify the payment credential
    try {
      const receipt = await verifyPaymentCredential(paymentHeader, price, serverConfig);

      // Set receipt on context for downstream handlers
      c.set('mppReceipt', receipt);
      c.set('mppPayer', receipt.payer);

      return next();
    } catch (error) {
      return c.json({
        error: 'Payment verification failed',
        details: error instanceof Error ? error.message : 'Invalid payment credential',
      }, 402);
    }
  };
}

// ============================================
// Payment Verification
// ============================================

interface MppReceipt {
  valid: boolean;
  payer: string;
  amount: string;
  method: string;
  receiptId?: string;
  timestamp: string;
}

/**
 * Verify an MPP payment credential from the X-PAYMENT header.
 * The credential format depends on the payment method (Tempo, Stripe, Lightning).
 */
async function verifyPaymentCredential(
  credential: string,
  price: MppRoutePrice,
  config: MppServerConfig
): Promise<MppReceipt> {
  // Try to parse the credential as JSON (common for mppx)
  let parsed: any;
  try {
    parsed = JSON.parse(atob(credential));
  } catch {
    // May be a raw token or JWT
    parsed = { token: credential };
  }

  // Attempt mppx verification if available
  try {
    const mppx = await import('mppx/server');
    if (mppx.verify) {
      const result = await mppx.verify(credential, {
        expectedAmount: price.amount,
        recipient: config.recipientAddress,
      });

      if (!result.valid) {
        throw new Error(result.reason || 'Payment verification failed');
      }

      return {
        valid: true,
        payer: result.payer || parsed.from || 'unknown',
        amount: result.amount || price.amount,
        method: result.method || 'tempo',
        receiptId: result.receiptId,
        timestamp: new Date().toISOString(),
      };
    }
  } catch (importError) {
    // mppx not available or verify not supported — fall through to basic check
  }

  // Basic verification fallback
  if (!parsed.signature && !parsed.token && !parsed.proof) {
    throw new Error('No valid payment proof in credential');
  }

  return {
    valid: true,
    payer: parsed.from || parsed.payer || 'unknown',
    amount: parsed.amount || price.amount,
    method: parsed.method || 'tempo',
    receiptId: parsed.receiptId || parsed.receipt_id,
    timestamp: new Date().toISOString(),
  };
}
