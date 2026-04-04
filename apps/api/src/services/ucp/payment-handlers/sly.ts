/**
 * PayOS Payment Handler
 *
 * Handles payments via PayOS settlement corridors (Pix, SPEI).
 * This is the default handler for UCP checkouts.
 *
 * @see Phase 2: Payment Handlers Architecture
 */

import { createHash } from 'crypto';
import type {
  PaymentHandler,
  AcquireInstrumentRequest,
  AcquireInstrumentResult,
  ProcessPaymentRequest,
  ProcessPaymentResult,
  RefundPaymentRequest,
  RefundPaymentResult,
  PaymentStatus,
  PaymentInstrument,
  Payment,
} from './types.js';

// =============================================================================
// In-Memory Store (for PoC)
// =============================================================================

interface StoredInstrument extends PaymentInstrument {
  tenantId: string;
  corridor?: string;
  recipientData?: Record<string, unknown>;
}

interface StoredPayment extends Payment {
  tenantId: string;
}

const instrumentStore = new Map<string, StoredInstrument>();
const paymentStore = new Map<string, StoredPayment>();

// =============================================================================
// PayOS Payment Handler
// =============================================================================

export const payosHandler: PaymentHandler = {
  id: 'sly_latam',
  name: 'com.sly.latam_settlement',
  version: '2026-01-11',
  supportedTypes: ['pix', 'spei', 'settlement'],
  supportedCurrencies: ['USD', 'USDC', 'BRL', 'MXN'],

  /**
   * Acquire a payment instrument
   *
   * For PayOS, this creates a settlement token for a specific corridor.
   */
  async acquireInstrument(
    request: AcquireInstrumentRequest
  ): Promise<AcquireInstrumentResult> {
    const { type, config, currency } = request;

    // Validate corridor type
    if (!['pix', 'spei', 'settlement'].includes(type)) {
      return {
        success: false,
        error: {
          code: 'INVALID_INSTRUMENT_TYPE',
          message: `Unsupported instrument type: ${type}. Supported: pix, spei, settlement`,
          retryable: false,
        },
      };
    }

    // Validate currency
    if (!this.supportedCurrencies.includes(currency)) {
      return {
        success: false,
        error: {
          code: 'INVALID_CURRENCY',
          message: `Unsupported currency: ${currency}`,
          retryable: false,
        },
      };
    }

    // Extract corridor config
    const corridor = type === 'settlement' ? (config.corridor as string) : type;
    const recipientData = config.recipient as Record<string, unknown> | undefined;

    // Validate recipient for Pix
    if (corridor === 'pix' && recipientData) {
      const pixKey = recipientData.pix_key as string;
      if (!pixKey) {
        return {
          success: false,
          error: {
            code: 'INVALID_RECIPIENT',
            message: 'Pix key is required for Pix payments',
            retryable: false,
          },
        };
      }
    }

    // Validate recipient for SPEI
    if (corridor === 'spei' && recipientData) {
      const clabe = recipientData.clabe as string;
      if (!clabe || clabe.length !== 18) {
        return {
          success: false,
          error: {
            code: 'INVALID_RECIPIENT',
            message: 'Valid CLABE (18 digits) is required for SPEI payments',
            retryable: false,
          },
        };
      }
    }

    // Generate instrument ID
    const instrumentId = `pi_${createHash('sha256')
      .update(`${Date.now()}-${Math.random()}`)
      .digest('hex')
      .slice(0, 24)}`;

    const instrument: StoredInstrument = {
      id: instrumentId,
      handler: this.id,
      type: corridor,
      reusable: false, // Settlement instruments are single-use
      tenantId: config.tenantId as string || 'unknown',
      corridor,
      recipientData,
      data: {
        corridor,
        recipient: recipientData,
      },
      createdAt: new Date().toISOString(),
    };

    // Add display info
    if (corridor === 'pix' && recipientData) {
      const pixKey = recipientData.pix_key as string;
      instrument.last4 = pixKey.slice(-4);
    } else if (corridor === 'spei' && recipientData) {
      const clabe = recipientData.clabe as string;
      instrument.last4 = clabe.slice(-4);
    }

    instrumentStore.set(instrumentId, instrument);

    console.log(`[PayOS Handler] Created instrument ${instrumentId} for corridor ${corridor}`);

    return {
      success: true,
      instrument: {
        id: instrument.id,
        handler: instrument.handler,
        type: instrument.type,
        last4: instrument.last4,
        reusable: instrument.reusable,
        data: instrument.data,
        createdAt: instrument.createdAt,
      },
    };
  },

  /**
   * Process a payment
   *
   * For PayOS, this initiates a settlement via the corridor.
   */
  async processPayment(
    request: ProcessPaymentRequest
  ): Promise<ProcessPaymentResult> {
    const { instrumentId, amount, currency, idempotencyKey, metadata } = request;

    // Get instrument
    const instrument = instrumentStore.get(instrumentId);
    if (!instrument) {
      return {
        success: false,
        error: {
          code: 'INSTRUMENT_NOT_FOUND',
          message: 'Payment instrument not found',
          retryable: false,
        },
      };
    }

    // Validate amount
    if (amount <= 0) {
      return {
        success: false,
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Amount must be greater than 0',
          retryable: false,
        },
      };
    }

    // Generate payment ID
    const paymentId = `pay_${createHash('sha256')
      .update(`${idempotencyKey || Date.now()}-${instrumentId}`)
      .digest('hex')
      .slice(0, 24)}`;

    // Check for idempotent payment
    if (idempotencyKey) {
      const existing = Array.from(paymentStore.values()).find(
        (p) => p.handler === this.id && metadata?.idempotencyKey === idempotencyKey
      );
      if (existing) {
        return {
          success: true,
          payment: {
            id: existing.id,
            handler: existing.handler,
            instrumentId: existing.instrumentId,
            amount: existing.amount,
            currency: existing.currency,
            status: existing.status,
            settlementId: existing.settlementId,
            externalId: existing.externalId,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          },
        };
      }
    }

    // Simulate settlement processing
    // In production, this would call the actual settlement service
    const settlementId = `stl_${createHash('sha256')
      .update(`${paymentId}-${Date.now()}`)
      .digest('hex')
      .slice(0, 24)}`;

    const now = new Date().toISOString();

    const payment: StoredPayment = {
      id: paymentId,
      handler: this.id,
      instrumentId,
      amount,
      currency,
      status: 'succeeded', // Simulated success
      settlementId,
      tenantId: instrument.tenantId,
      createdAt: now,
      updatedAt: now,
    };

    paymentStore.set(paymentId, payment);

    console.log(
      `[PayOS Handler] Processed payment ${paymentId} for ${amount} ${currency} via ${instrument.corridor}`
    );

    return {
      success: true,
      payment: {
        id: payment.id,
        handler: payment.handler,
        instrumentId: payment.instrumentId,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        settlementId: payment.settlementId,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      },
    };
  },

  /**
   * Refund a payment
   */
  async refundPayment(request: RefundPaymentRequest): Promise<RefundPaymentResult> {
    const { paymentId, amount, reason } = request;

    const payment = paymentStore.get(paymentId);
    if (!payment) {
      return {
        success: false,
        error: {
          code: 'PAYMENT_NOT_FOUND',
          message: 'Payment not found',
          retryable: false,
        },
      };
    }

    if (payment.status !== 'succeeded') {
      return {
        success: false,
        error: {
          code: 'INVALID_PAYMENT_STATUS',
          message: `Cannot refund payment in ${payment.status} status`,
          retryable: false,
        },
      };
    }

    const refundAmount = amount || payment.amount;
    if (refundAmount > payment.amount) {
      return {
        success: false,
        error: {
          code: 'INVALID_REFUND_AMOUNT',
          message: 'Refund amount exceeds payment amount',
          retryable: false,
        },
      };
    }

    // Generate refund ID
    const refundId = `ref_${createHash('sha256')
      .update(`${paymentId}-${Date.now()}`)
      .digest('hex')
      .slice(0, 24)}`;

    // Update payment status
    if (refundAmount === payment.amount) {
      payment.status = 'refunded';
    }
    payment.updatedAt = new Date().toISOString();
    paymentStore.set(paymentId, payment);

    console.log(`[PayOS Handler] Refunded ${refundAmount} ${payment.currency} for payment ${paymentId}`);

    return {
      success: true,
      refund: {
        id: refundId,
        paymentId,
        amount: refundAmount,
        currency: payment.currency,
        status: 'succeeded',
        reason,
        createdAt: new Date().toISOString(),
      },
    };
  },

  /**
   * Get payment status
   */
  async getPaymentStatus(paymentId: string): Promise<PaymentStatus> {
    const payment = paymentStore.get(paymentId);
    if (!payment) {
      throw new Error('Payment not found');
    }

    return {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      updatedAt: payment.updatedAt,
    };
  },
};

// =============================================================================
// Utilities
// =============================================================================

/**
 * Clear stores (for testing)
 */
export function clearPayosStores(): void {
  instrumentStore.clear();
  paymentStore.clear();
}

export default payosHandler;
