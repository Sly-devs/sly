/**
 * MPP Wallet Provisioning
 *
 * Provisions Tempo wallets for agents to use with MPP payments.
 * Uses existing wallets table with network = 'tempo-mainnet' or 'tempo-testnet'.
 *
 * @see Story 71.5: Wallet Provisioning
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// ============================================
// Types
// ============================================

export interface TempoWallet {
  id: string;
  tenantId: string;
  ownerAccountId: string;
  managedByAgentId?: string;
  address?: string;
  network: 'tempo-mainnet' | 'tempo-testnet';
  balance: number;
  currency: string;
  status: string;
}

/** Tempo token addresses per network */
const TEMPO_TOKENS = {
  testnet: {
    currency: 'pathUSD',
    tokenContract: '0x20c0000000000000000000000000000000000000',
  },
  mainnet: {
    currency: 'USDC',
    tokenContract: '0x20C000000000000000000000b9537d11c60E8b50',
  },
} as const;

export interface ProvisionOptions {
  tenantId: string;
  ownerAccountId: string;
  agentId: string;
  /** Use testnet (default: true in non-production) */
  testnet?: boolean;
  /** Initial balance for testing */
  initialBalance?: number;
}

// ============================================
// Wallet Provisioning Service
// ============================================

export class MppWalletProvisioning {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Provision a Tempo wallet for an agent to use with MPP.
   * If the agent already has a Tempo wallet, returns the existing one.
   */
  async provisionTempoWallet(options: ProvisionOptions): Promise<TempoWallet> {
    const network = options.testnet !== false ? 'tempo-testnet' : 'tempo-mainnet';

    // Check for existing Tempo wallet
    const { data: existing } = await this.supabase
      .from('wallets')
      .select('*')
      .eq('managed_by_agent_id', options.agentId)
      .eq('tenant_id', options.tenantId)
      .eq('network', network)
      .eq('status', 'active')
      .single();

    if (existing) {
      return this.mapFromDb(existing);
    }

    // Generate on-chain keypair
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const address = account.address;

    const isTestnet = options.testnet !== false;
    const tokenInfo = isTestnet ? TEMPO_TOKENS.testnet : TEMPO_TOKENS.mainnet;

    // Create new wallet with on-chain address
    const walletId = randomUUID();
    const { data: wallet, error } = await this.supabase
      .from('wallets')
      .insert({
        id: walletId,
        tenant_id: options.tenantId,
        owner_account_id: options.ownerAccountId,
        managed_by_agent_id: options.agentId,
        wallet_address: address,
        network,
        balance: options.initialBalance || 0,
        currency: tokenInfo.currency,
        status: 'active',
        provider: 'tempo',
        wallet_type: 'external',
        blockchain: 'tempo',
        token_contract: tokenInfo.tokenContract,
        provider_metadata: {
          encrypted_private_key: privateKey,  // TODO: encrypt with KMS in production
          key_derivation: 'viem/generatePrivateKey',
          chain_id: isTestnet ? 42431 : 4217,
          rpc_url: isTestnet ? 'https://rpc.moderato.tempo.xyz' : 'https://rpc.tempo.xyz',
          token_decimals: 6,
        },
        spending_policy: null,
      })
      .select()
      .single();

    if (error || !wallet) {
      throw new Error(`Failed to provision Tempo wallet: ${error?.message || 'unknown'}`);
    }

    console.log(`[MPP] Provisioned Tempo wallet ${walletId} (${address}) for agent ${options.agentId} on ${network}`);

    return this.mapFromDb(wallet);
  }

  /**
   * Configure the MPP client for a specific agent's wallet.
   * Returns the wallet address for use as the payment source.
   */
  async configureClientForAgent(
    agentId: string,
    tenantId: string
  ): Promise<{ walletId: string; address?: string; network: string; privateKey?: string } | null> {
    const { data: wallet } = await this.supabase
      .from('wallets')
      .select('id, wallet_address, network, provider_metadata')
      .eq('managed_by_agent_id', agentId)
      .eq('tenant_id', tenantId)
      .like('network', 'tempo-%')
      .eq('status', 'active')
      .single();

    if (!wallet) return null;

    const meta = wallet.provider_metadata as Record<string, any> | null;

    return {
      walletId: wallet.id,
      address: wallet.wallet_address || undefined,
      network: wallet.network,
      privateKey: meta?.encrypted_private_key || undefined,
    };
  }

  /**
   * Fund a Tempo wallet (for testing or initial provisioning).
   */
  async fundWallet(
    walletId: string,
    tenantId: string,
    amount: number
  ): Promise<{ balance: number }> {
    const { data, error } = await this.supabase
      .rpc('increment_wallet_balance', {
        p_wallet_id: walletId,
        p_tenant_id: tenantId,
        p_amount: amount,
      });

    if (error) {
      // Fallback: manual update
      const { data: wallet } = await this.supabase
        .from('wallets')
        .select('balance')
        .eq('id', walletId)
        .eq('tenant_id', tenantId)
        .single();

      if (!wallet) throw new Error('Wallet not found');

      const newBalance = parseFloat(wallet.balance) + amount;
      await this.supabase
        .from('wallets')
        .update({ balance: newBalance, updated_at: new Date().toISOString() })
        .eq('id', walletId)
        .eq('tenant_id', tenantId);

      return { balance: newBalance };
    }

    return { balance: parseFloat(data) || amount };
  }

  private mapFromDb(row: any): TempoWallet {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      ownerAccountId: row.owner_account_id,
      managedByAgentId: row.managed_by_agent_id || undefined,
      address: row.wallet_address || row.address || undefined,
      network: row.network,
      balance: parseFloat(row.balance),
      currency: row.currency,
      status: row.status,
    };
  }
}
