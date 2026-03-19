/**
 * MPP Payer KYA Verification
 *
 * Extracts payer identity from MPP payment credentials,
 * looks them up in the Sly agent registry by wallet address,
 * and assigns a trust tier based on KYA verification level.
 *
 * @see Story 71.12: Payer KYA Verification
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PayerVerification, PayerTrustTier } from './types.js';

// ============================================
// Payer Verification Service
// ============================================

export class MppPayerVerification {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Verify a payer's identity by wallet address.
   * Looks up the address in Sly's agent registry and assigns trust tier.
   */
  async verifyPayer(payerAddress: string): Promise<PayerVerification> {
    if (!payerAddress || payerAddress === 'unknown') {
      return {
        verified: false,
        payerAddress,
        trustTier: 0,
      };
    }

    // Look up by wallet address in wallets table
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('id, tenant_id, managed_by_agent_id, address')
      .eq('address', payerAddress)
      .eq('status', 'active')
      .single();

    if (!wallet?.managed_by_agent_id) {
      // Unknown payer — tier 0
      return {
        verified: false,
        payerAddress,
        trustTier: 0,
      };
    }

    // Look up agent for KYA details
    const { data: agent } = await this.supabase
      .from('agents')
      .select('id, name, kya_tier, kya_status, status, tenant_id')
      .eq('id', wallet.managed_by_agent_id)
      .single();

    if (!agent || agent.status !== 'active') {
      return {
        verified: false,
        payerAddress,
        agentId: wallet.managed_by_agent_id,
        trustTier: 0,
      };
    }

    // Map KYA tier to trust tier
    const trustTier = this.mapKyaToTrust(agent.kya_tier, agent.kya_status);

    return {
      verified: true,
      payerAddress,
      agentId: agent.id,
      agentName: agent.name,
      trustTier,
      kyaTier: agent.kya_tier,
      tenantId: agent.tenant_id,
    };
  }

  /**
   * Verify a payer from an MPP receipt context.
   * Tries multiple resolution strategies.
   */
  async verifyFromReceipt(receipt: {
    payer?: string;
    from?: string;
    agent_id?: string;
  }): Promise<PayerVerification> {
    // Try agent ID lookup first (most reliable)
    if (receipt.agent_id) {
      const { data: agent } = await this.supabase
        .from('agents')
        .select('id, name, kya_tier, kya_status, status, tenant_id, wallet_address')
        .eq('id', receipt.agent_id)
        .single();

      if (agent) {
        return {
          verified: agent.status === 'active',
          payerAddress: agent.wallet_address || receipt.payer || receipt.from || 'unknown',
          agentId: agent.id,
          agentName: agent.name,
          trustTier: this.mapKyaToTrust(agent.kya_tier, agent.kya_status),
          kyaTier: agent.kya_tier,
          tenantId: agent.tenant_id,
        };
      }
    }

    // Fall back to wallet address lookup
    const address = receipt.payer || receipt.from;
    if (address) {
      return this.verifyPayer(address);
    }

    return {
      verified: false,
      payerAddress: 'unknown',
      trustTier: 0,
    };
  }

  /**
   * Map KYA tier + status to a trust tier for payment authorization.
   */
  private mapKyaToTrust(kyaTier: number | null, kyaStatus: string | null): PayerTrustTier {
    if (!kyaTier || kyaStatus !== 'verified') return 0;
    if (kyaTier >= 3) return 3;
    if (kyaTier >= 2) return 2;
    if (kyaTier >= 1) return 1;
    return 0;
  }
}
