/**
 * Wallets API Routes
 * 
 * Enables any account to create and manage wallets for x402 payments.
 * Supports:
 * - Internal wallets (PayOS managed)
 * - Circle custodial wallets (Phase 2)
 * - External wallets (user brings own wallet)
 * 
 * Accounts can have MULTIPLE wallets.
 * 
 * Spec: https://www.x402.org/x402-whitepaper.pdf
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getCircleService, USDC_CONTRACTS, EURC_CONTRACTS } from '../services/circle-mock.js';
import { getCircleServiceForTenant } from '../services/circle/index.js';
import { settleWalletTransfer, isOnChainCapable } from '../services/wallet-settlement.js';
import { getWalletVerificationService } from '../services/wallet/index.js';
import { normalizeFields, buildDeprecationHeader, getEnv } from '../utils/helpers.js';
import { triggerWorkflows } from '../services/workflow-trigger.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';

// Derive correct network name per blockchain (Solana uses solana-devnet/mainnet, others use {chain}-mainnet)
function getNetworkName(blockchain: string): string {
  if (blockchain === 'sol') {
    return process.env.PAYOS_ENVIRONMENT === 'production' ? 'solana-mainnet' : 'solana-devnet';
  }
  return `${blockchain}-mainnet`;
}

// Derive Circle faucet blockchain based on wallet blockchain
function getFaucetBlockchain(blockchain: string): string {
  if (blockchain === 'sol') return 'SOL-DEVNET';
  return 'BASE-SEPOLIA';
}

const app = new Hono();

// Apply auth middleware to all routes
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

const spendingPolicySchema = z.object({
  dailySpendLimit: z.number().positive().optional(),
  dailySpent: z.number().default(0),
  dailyResetAt: z.string().datetime().optional(),
  monthlySpendLimit: z.number().positive().optional(),
  monthlySpent: z.number().default(0),
  monthlyResetAt: z.string().datetime().optional(),
  approvedEndpoints: z.array(z.string()).optional(),
  approvedVendors: z.array(z.string()).optional(),
  approvedCategories: z.array(z.string()).optional(),
  approvalThreshold: z.number().positive().optional(),
  requiresApprovalAbove: z.number().positive().optional(),
  autoFundEnabled: z.boolean().default(false),
  autoFundThreshold: z.number().positive().optional(),
  autoFundAmount: z.number().positive().optional(),
  autoFundSourceAccountId: z.string().uuid().optional(),
  // Epic 18: Contract policy fields
  contractPolicy: z.object({
    counterpartyBlocklist: z.array(z.string()).optional(),
    counterpartyAllowlist: z.array(z.string()).optional(),
    minCounterpartyKyaTier: z.number().int().min(0).max(3).optional(),
    minCounterpartyReputation: z.number().min(0).max(1).optional(),
    allowedContractTypes: z.array(z.string()).optional(),
    blockedContractTypes: z.array(z.string()).optional(),
    maxExposure24h: z.number().positive().optional(),
    maxExposure7d: z.number().positive().optional(),
    maxExposure30d: z.number().positive().optional(),
    maxActiveContracts: z.number().int().nonnegative().optional(),
    maxActiveEscrows: z.number().int().nonnegative().optional(),
    escalateAbove: z.number().positive().optional(),
  }).optional(),
}).optional();

// Schema for creating a NEW wallet (internal or Circle)
// Story 51.1: Accept both accountId (new) and ownerAccountId (deprecated)
const createWalletSchema = z.object({
  accountId: z.string().uuid().optional(),
  ownerAccountId: z.string().uuid().optional(), // Deprecated, use accountId
  managedByAgentId: z.string().uuid().optional(),
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  initialBalance: z.number().min(0).default(0),
  spendingPolicy: spendingPolicySchema,

  // New Phase 2 fields
  walletType: z.enum(['internal', 'circle_custodial', 'circle_mpc']).default('internal'),
  blockchain: z.enum(['base', 'eth', 'polygon', 'avax', 'sol', 'tempo']).default('base'),
  accountType: z.enum(['SCA', 'EOA']).optional(), // SCA required for Gas Station on EVM chains

  // Optional metadata
  name: z.string().max(255).optional(),
  purpose: z.string().max(500).optional()
}).refine(
  (data) => data.accountId || data.ownerAccountId,
  { message: 'accountId is required', path: ['accountId'] }
);

// Schema for ADDING an existing external wallet
// Story 51.1: Accept both accountId (new) and ownerAccountId (deprecated)
const addExternalWalletSchema = z.object({
  accountId: z.string().uuid().optional(),
  ownerAccountId: z.string().uuid().optional(), // Deprecated, use accountId
  managedByAgentId: z.string().uuid().optional(),
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  spendingPolicy: spendingPolicySchema,

  // External wallet details
  walletAddress: z.string().min(10), // 0x... or Solana address
  blockchain: z.enum(['base', 'eth', 'polygon', 'avax', 'sol']),

  // Verification (signature to prove ownership)
  signature: z.string().optional(),
  signatureMessage: z.string().optional(),

  // Metadata
  name: z.string().max(255).optional(),
  purpose: z.string().max(500).optional()
}).refine(
  (data) => data.accountId || data.ownerAccountId,
  { message: 'accountId is required', path: ['accountId'] }
);

const updateWalletSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  spendingPolicy: spendingPolicySchema,
  status: z.enum(['active', 'frozen', 'depleted']).optional()
});

// Story 51.1: Accept both fromAccountId (new) and sourceAccountId (deprecated)
const depositSchema = z.object({
  amount: z.number().positive(),
  fromAccountId: z.string().uuid().optional(),
  sourceAccountId: z.string().uuid().optional(), // Deprecated, use fromAccountId
  reference: z.string().max(500).optional()
}).refine(
  (data) => data.fromAccountId || data.sourceAccountId,
  { message: 'fromAccountId is required', path: ['fromAccountId'] }
);

const withdrawSchema = z.object({
  amount: z.number().positive(),
  destinationAccountId: z.string().uuid(),
  reference: z.string().max(500).optional()
});

// ============================================
// Helper Functions
// ============================================

function mapWalletFromDb(row: any) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    environment: row.environment || 'test',
    ownerAccountId: row.owner_account_id,
    managedByAgentId: row.managed_by_agent_id,
    balance: parseFloat(row.balance),
    currency: row.currency,
    spendingPolicy: row.spending_policy,
    walletAddress: row.wallet_address,
    network: row.network,
    status: row.status,
    name: row.name,
    purpose: row.purpose,

    // New Phase 2 fields
    walletType: row.wallet_type || 'internal',
    custodyType: row.custody_type || 'custodial',
    provider: row.provider || 'payos',
    providerWalletId: row.provider_wallet_id,
    providerWalletSetId: row.provider_wallet_set_id,
    blockchain: row.blockchain || 'base',
    tokenContract: row.token_contract,
    providerMetadata: row.provider_metadata,

    // Verification
    verificationStatus: row.verification_status || 'verified',
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at,

    // Sync
    lastSyncedAt: row.last_synced_at,
    syncEnabled: row.sync_enabled || false,

    // Compliance
    kycStatus: row.kyc_status || 'not_required',
    amlCleared: row.aml_cleared !== false,
    sanctionsStatus: row.sanctions_status || 'not_screened',
    riskScore: row.risk_score,

    // Timestamps
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getTokenContract(currency: string, blockchain: string): string | null {
  const contracts = currency === 'USDC' ? USDC_CONTRACTS : EURC_CONTRACTS;
  return contracts[blockchain.toUpperCase()] || null;
}

// Read on-chain USDC for an EVM address on Base mainnet or Base Sepolia.
// Picked by the WALLET's own environment column (not process env) so a
// test-env wallet queried from a production deploy reads Sepolia, and
// vice versa. Returns null on any RPC error so callers can fall back.
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
async function readOnchainUsdc(address: string, env: 'live' | 'test'): Promise<number | null> {
  try {
    const rpcUrl = env === 'live' ? 'https://mainnet.base.org' : 'https://sepolia.base.org';
    const usdc = env === 'live' ? USDC_BASE_MAINNET : USDC_BASE_SEPOLIA;
    const data = '0x70a08231' + '0'.repeat(24) + address.slice(2).toLowerCase();
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: usdc, data }, 'latest'] }),
    });
    const json: any = await res.json();
    if (!json?.result) return null;
    return parseInt(json.result, 16) / 1e6;
  } catch (e) {
    console.warn(`[wallets] on-chain read failed for ${address} on ${env}:`, e);
    return null;
  }
}

// ============================================
// Routes
// ============================================

/**
 * POST /v1/wallets
 * Create a new wallet for an account
 * Supports: internal (PayOS), circle_custodial, circle_mpc
 * 
 * Note: For adding existing external wallets, use POST /v1/wallets/external
 */
app.post('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();

    // Story 51.1: Normalize deprecated field names
    const { data: normalizedBody, deprecatedFieldsUsed } = normalizeFields(body, {
      ownerAccountId: 'accountId',
    });

    // Validate request
    const validated = createWalletSchema.parse(normalizedBody);

    // Story 51.1: Add deprecation warning header if old fields were used
    const deprecationWarning = buildDeprecationHeader(deprecatedFieldsUsed);
    if (deprecationWarning) {
      c.header('Deprecation', deprecationWarning);
      c.header('X-Deprecated-Fields', deprecatedFieldsUsed.join(', '));
    }

    // Get the account ID (prefer new name, fall back to old)
    const accountId = validated.accountId || accountId;

    const supabase = createClient();

    // Verify owner account belongs to tenant
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (accountError || !account) {
      return c.json({
        error: 'Account not found or does not belong to your tenant'
      }, 404);
    }

    // If managed by agent, verify agent exists and belongs to tenant
    if (validated.managedByAgentId) {
      const { data: agent, error: agentError } = await supabase
        .from('agents')
        .select('id')
        .eq('id', validated.managedByAgentId)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .single();

      if (agentError || !agent) {
        return c.json({
          error: 'Agent not found or does not belong to your tenant'
        }, 404);
      }
    }

    // NOTE: Accounts can have MULTIPLE wallets
    // We no longer check for duplicates - just create a new one

    // Determine wallet address based on type
    let walletAddress: string;
    let providerWalletId: string | null = null;
    let providerWalletSetId: string | null = null;
    let providerEntityId: string | null = null;
    let providerMetadata: any = null;

    const blockchain = validated.blockchain || 'base';
    const tokenContract = getTokenContract(validated.currency, blockchain);

    if (validated.walletType === 'internal' && blockchain === 'tempo') {
      // Tempo on-chain wallet — generate keypair eagerly so wallet has an address for funding
      const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');
      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      walletAddress = account.address;

      const isLive = getEnv(ctx) === 'live';
      const tempoToken = isLive
        ? { currency: 'USDC', contract: '0x20C000000000000000000000b9537d11c60E8b50' }
        : { currency: 'pathUSD', contract: '0x20c0000000000000000000000000000000000000' };

      providerMetadata = {
        encrypted_private_key: privateKey,  // TODO: encrypt with KMS in production
        key_derivation: 'viem/generatePrivateKey',
        chain_id: isLive ? 4217 : 42431,
        rpc_url: isLive ? 'https://rpc.tempo.xyz' : 'https://rpc.moderato.tempo.xyz',
        token_decimals: 6,
        token_contract: tempoToken.contract,
      };
    } else if (validated.walletType === 'internal') {
      // Internal PayOS ledger wallet
      walletAddress = validated.managedByAgentId
        ? `internal://payos/${ctx.tenantId}/${accountId}/agent/${validated.managedByAgentId}`
        : `internal://payos/${ctx.tenantId}/${accountId}/${Date.now()}`;
    } else {
      // Circle wallet — uses real Circle API when CIRCLE_API_KEY is configured,
      // otherwise falls back to mock service.
      const circleService = getCircleServiceForTenant(ctx.tenantId, getEnv(ctx) as 'test' | 'live');

      try {
        // Auto-select SCA for EVM chains when Gas Station is enabled (gasless txns)
        let accountType = validated.accountType as 'SCA' | 'EOA' | undefined;
        if (!accountType && blockchain !== 'sol') {
          try {
            const { isFeatureEnabled } = await import('../config/environment.js');
            if (isFeatureEnabled('circleGasStation')) {
              accountType = 'SCA';
            }
          } catch { /* feature check is optional */ }
        }

        const isLive = getEnv(ctx) === 'live';
        const circleWallet = await circleService.createWallet({
          blockchain: blockchain as any,
          name: validated.name || `PayOS Wallet`,
          refId: accountId,
          accountType,
          testnet: !isLive,
        });

        walletAddress = circleWallet.address;
        providerWalletId = circleWallet.id;
        providerMetadata = {
          circle_state: circleWallet.state,
          circle_create_date: new Date().toISOString(),
        };
      } catch (circleError: any) {
        console.error('Error creating Circle wallet:', circleError);
        return c.json({
          error: 'Failed to create Circle wallet',
          details: circleError.message
        }, 500);
      }
    }

    // Create wallet record
    const { data: wallet, error: createError } = await supabase
      .from('wallets')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        owner_account_id: accountId,
        managed_by_agent_id: validated.managedByAgentId || null,
        balance: validated.initialBalance,
        currency: validated.currency,
        spending_policy: validated.spendingPolicy || null,
        wallet_address: walletAddress,
        network: getNetworkName(blockchain),
        status: 'active',
        name: validated.name,
        purpose: validated.purpose,

        // Phase 2 fields
        wallet_type: validated.walletType,
        custody_type: validated.walletType === 'circle_mpc' ? 'mpc' : 'custodial',
        provider: blockchain === 'tempo' ? 'tempo' : (validated.walletType === 'internal' ? 'payos' : 'circle'),
        provider_wallet_id: providerWalletId,
        provider_wallet_set_id: providerWalletSetId,
        provider_entity_id: providerEntityId,
        provider_metadata: providerMetadata,
        blockchain: blockchain,
        token_contract: tokenContract,

        // Verification (new wallets are auto-verified)
        verification_status: 'verified',
        verification_method: validated.walletType === 'internal' ? 'internal' : 'api_created',
        verified_at: new Date().toISOString(),

        // Compliance defaults
        kyc_status: 'not_required',
        aml_cleared: true,
        sanctions_status: 'not_screened'
      })
      .select()
      .single();

    if (createError) {
      console.error('Error creating wallet:', createError);
      return c.json({
        error: 'Failed to create wallet',
        details: createError.message
      }, 500);
    }

    // If initial balance > 0, create a deposit transfer
    if (validated.initialBalance > 0) {
      await supabase
        .from('transfers')
        .insert({
          tenant_id: ctx.tenantId,
          environment: getEnv(ctx),
          from_account_id: accountId,
          to_account_id: accountId,
          amount: validated.initialBalance,
          currency: validated.currency,
          type: 'internal',
          status: 'completed',
          description: 'Initial wallet funding',
          protocol_metadata: {
            protocol: 'x402',
            wallet_id: wallet.id,
            operation: 'initial_deposit'
          }
        });
    }

    // Auto-fund gas for Circle custodial wallets in sandbox
    if (process.env.PAYOS_ENVIRONMENT === 'sandbox' && walletAddress && validated.walletType !== 'internal') {
      import('../services/circle/client.js').then(({ getCircleClient }) => {
        getCircleClient().requestFaucetDrip(walletAddress!, getFaucetBlockchain(blockchain) as any, {
          usdc: false,
          native: true,
        });
      }).catch(err => console.warn('[Wallet] Sandbox gas auto-fund failed:', err.message));
    }

    // Fire workflow auto-triggers (fire-and-forget)
    triggerWorkflows(supabase, ctx.tenantId, 'wallet', 'insert', {
      id: wallet.id, name: wallet.name, network: wallet.network,
      address: wallet.wallet_address, currency: wallet.currency,
    }).catch(console.error);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.WALLET_CREATED,
      subject: `wallet/${wallet.id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { blockchain, currency: validated.currency },
    });

    return c.json({
      data: mapWalletFromDb(wallet)
    }, 201);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in POST /v1/wallets:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/wallets
 * List all wallets for the tenant
 */
app.get('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();

    // Parse query params
    const ownerAccountId = c.req.query('owner_account_id');
    const managedByAgentId = c.req.query('managed_by_agent_id');
    const status = c.req.query('status');
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from('wallets')
      .select('*', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: false });

    // Agent tokens: scope to agent's own wallets only
    if (ctx.actorType === 'agent' && ctx.actorId) {
      query = query.eq('managed_by_agent_id', ctx.actorId);
    }

    // Apply filters
    if (ownerAccountId) {
      query = query.eq('owner_account_id', ownerAccountId);
    }

    if (managedByAgentId) {
      query = query.eq('managed_by_agent_id', managedByAgentId);
    }

    if (status) {
      query = query.eq('status', status);
    }

    // Apply pagination
    query = query.range(offset, offset + limit - 1);

    const { data: wallets, error, count } = await query;

    if (error) {
      console.error('Error fetching wallets:', error);
      return c.json({ error: 'Failed to fetch wallets' }, 500);
    }

    return c.json({
      data: wallets?.map(mapWalletFromDb) || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    });

  } catch (error) {
    console.error('Error in GET /v1/wallets:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/wallets/external
 * Add an existing external wallet (user brings their own)
 * 
 * Flow:
 * 1. User provides wallet address
 * 2. User signs a message to prove ownership
 * 3. We verify signature and add wallet
 * 
 * Note: In Phase 1, we mock signature verification.
 * In Phase 2+, we use EIP-712 or equivalent for real verification.
 */
app.post('/external', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();

    // Story 51.1: Normalize deprecated field names
    const { data: normalizedBody, deprecatedFieldsUsed } = normalizeFields(body, {
      ownerAccountId: 'accountId',
    });

    // Validate request
    const validated = addExternalWalletSchema.parse(normalizedBody);

    // Story 51.1: Add deprecation warning header if old fields were used
    const deprecationWarning = buildDeprecationHeader(deprecatedFieldsUsed);
    if (deprecationWarning) {
      c.header('Deprecation', deprecationWarning);
      c.header('X-Deprecated-Fields', deprecatedFieldsUsed.join(', '));
    }

    // Get the account ID (prefer new name, fall back to old)
    const accountId = validated.accountId || validated.ownerAccountId;

    const supabase = createClient();

    // Verify owner account belongs to tenant
    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', accountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (accountError || !account) {
      return c.json({
        error: 'Account not found or does not belong to your tenant'
      }, 404);
    }

    // Check if this wallet address is already linked to this tenant
    const { data: existingWallet } = await supabase
      .from('wallets')
      .select('id')
      .eq('tenant_id', ctx.tenantId)
      .eq('wallet_address', validated.walletAddress)
      .single();

    if (existingWallet) {
      return c.json({
        error: 'This wallet address is already linked to your account',
        walletId: existingWallet.id
      }, 409);
    }

    // Verify ownership (mock for now)
    let verificationStatus: 'verified' | 'pending' | 'unverified' = 'unverified';
    let verificationMethod: string | null = null;

    if (validated.signature && validated.signatureMessage) {
      // Mock verification - in Phase 2, use real signature verification
      const circleService = getCircleService(ctx.tenantId);
      const verifyResult = await circleService.verifyWalletOwnership(
        validated.walletAddress,
        validated.signature,
        validated.signatureMessage
      );

      if (verifyResult.verified) {
        verificationStatus = 'verified';
        verificationMethod = 'signature';
      } else {
        // Still allow adding but mark as unverified
        verificationStatus = 'unverified';
      }
    } else {
      // No signature provided - mark as pending verification
      verificationStatus = 'pending';
    }

    const blockchain = validated.blockchain || 'base';
    const tokenContract = getTokenContract(validated.currency, blockchain);

    // Create external wallet record
    const { data: wallet, error: createError } = await supabase
      .from('wallets')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        owner_account_id: accountId,
        managed_by_agent_id: validated.managedByAgentId || null,
        balance: 0, // External wallet balance must be synced
        currency: validated.currency,
        spending_policy: validated.spendingPolicy || null,
        wallet_address: validated.walletAddress,
        network: getNetworkName(blockchain),
        status: verificationStatus === 'verified' ? 'active' : 'frozen',
        name: validated.name,
        purpose: validated.purpose,

        // External wallet fields
        wallet_type: 'external',
        custody_type: 'self',
        provider: 'external',
        blockchain: blockchain,
        token_contract: tokenContract,

        // Verification
        verification_status: verificationStatus,
        verification_method: verificationMethod,
        verified_at: verificationStatus === 'verified' ? new Date().toISOString() : null,

        // Sync - enable for external wallets
        sync_enabled: true,
        last_synced_at: null, // Will be updated on first sync

        // Compliance - external wallets may need KYC
        kyc_status: 'pending',
        aml_cleared: false,
        sanctions_status: 'not_screened'
      })
      .select()
      .single();

    if (createError) {
      console.error('Error adding external wallet:', createError);
      return c.json({
        error: 'Failed to add external wallet',
        details: createError.message
      }, 500);
    }

    return c.json({
      data: mapWalletFromDb(wallet),
      message: verificationStatus === 'verified'
        ? 'External wallet added and verified successfully'
        : verificationStatus === 'pending'
          ? 'External wallet added. Please verify ownership to activate.'
          : 'External wallet added but verification failed. Please try again.',
      requiresVerification: verificationStatus !== 'verified'
    }, 201);

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in POST /v1/wallets/external:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/wallets/:id/verify
 * Verify ownership of an external wallet
 */
app.post('/:id/verify', async (c) => {
  try {
    const ctx = c.get('ctx');
    const walletId = c.req.param('id');
    const body = await c.req.json();

    const { signature, message } = body;

    if (!signature || !message) {
      return c.json({ error: 'Signature and message are required' }, 400);
    }

    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: fetchError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (fetchError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    if (wallet.wallet_type !== 'external') {
      return c.json({ error: 'Only external wallets require verification' }, 400);
    }

    if (wallet.verification_status === 'verified') {
      return c.json({
        message: 'Wallet is already verified',
        data: mapWalletFromDb(wallet)
      });
    }

    // Verify signature (mock for now)
    const circleService = getCircleService(ctx.tenantId);
    const verifyResult = await circleService.verifyWalletOwnership(
      wallet.wallet_address,
      signature,
      message
    );

    if (!verifyResult.verified) {
      return c.json({
        error: 'Verification failed. Signature does not match wallet address.',
        details: 'Please ensure you are signing with the correct wallet.'
      }, 400);
    }

    // Update wallet status
    const { data: updatedWallet, error: updateError } = await supabase
      .from('wallets')
      .update({
        verification_status: 'verified',
        verification_method: 'signature',
        verified_at: new Date().toISOString(),
        status: 'active', // Activate the wallet
        updated_at: new Date().toISOString()
      })
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating wallet verification:', updateError);
      return c.json({ error: 'Failed to update wallet' }, 500);
    }

    return c.json({
      message: 'Wallet verified successfully',
      data: mapWalletFromDb(updatedWallet)
    });

  } catch (error) {
    console.error('Error in POST /v1/wallets/:id/verify:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/wallets/:id
 * Get a specific wallet with transaction history
 */
app.get('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (error || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // For agent_eoa wallets, chain IS the ledger. Sync on-chain USDC
    // synchronously and await the DB update before returning so the
    // caller never sees a stale zero balance. Non-fatal on RPC error —
    // fall back to whatever balance is currently in the DB.
    const walletRow = wallet as any;
    if (walletRow.wallet_type === 'agent_eoa' && walletRow.wallet_address) {
      const env: 'live' | 'test' = walletRow.environment === 'live' ? 'live' : 'test';
      const onchain = await readOnchainUsdc(walletRow.wallet_address, env);
      if (onchain !== null) {
        const nowIso = new Date().toISOString();
        await (supabase.from('wallets') as any)
          .update({
            balance: onchain,
            last_synced_at: nowIso,
            sync_data: {
              ...(walletRow.sync_data || {}),
              on_chain_usdc: String(onchain),
              synced_at: nowIso,
            },
          })
          .eq('id', id)
          .eq('tenant_id', ctx.tenantId);
        walletRow.balance = onchain;
        walletRow.last_synced_at = nowIso;
      }
    }

    // Fetch recent transactions involving this wallet. Matching rule
    // depends on wallet type:
    //  - agent_eoa: transfers initiated by the agent that manages this
    //    EOA (external x402 calls use initiated_by_id = agent_id and
    //    don't set protocol_metadata.wallet_id), OR transfers whose
    //    external to_address matches this EOA (e.g. auto-refill
    //    deposits from the Circle master).
    //  - everything else: legacy wildcard on protocol_metadata.wallet_id.
    const buildTxQuery = () => {
      let q = supabase
        .from('transfers')
        .select('id, from_account_id, to_account_id, amount, currency, status, type, created_at, protocol_metadata')
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx));
      if (walletRow.wallet_type === 'agent_eoa' && walletRow.managed_by_agent_id) {
        const addrLower = (walletRow.wallet_address || '').toLowerCase();
        q = q.or(`initiated_by_id.eq.${walletRow.managed_by_agent_id},protocol_metadata->>to_address.eq.${addrLower}`);
      } else {
        q = q.or(`protocol_metadata->>wallet_id.eq.${id}`);
      }
      return q;
    };
    const { data: recentTxs } = await buildTxQuery()
      .order('created_at', { ascending: false })
      .limit(20);

    // Live spending totals computed from the transfers ledger. These are
    // authoritative for wallet types that don't persist counters in the
    // spending_policy JSON (agent_eoa, external, smart_wallet) and give
    // the dashboard a live "used today / this month" number regardless
    // of wallet type. Only counts outbound, completed spend — cancelled
    // attempts where no money moved are excluded.
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const [{ data: dailyRows }, { data: monthlyRows }] = await Promise.all([
      buildTxQuery()
        .in('status', ['completed', 'pending', 'processing'])
        .in('type', ['x402', 'internal', 'mpp', 'ucp_settlement', 'acp_settlement'])
        .gte('created_at', dayStart.toISOString()),
      buildTxQuery()
        .in('status', ['completed', 'pending', 'processing'])
        .in('type', ['x402', 'internal', 'mpp', 'ucp_settlement', 'acp_settlement'])
        .gte('created_at', monthStart.toISOString()),
    ]);
    const sumSpend = (rows: any[] | null) => (rows || []).reduce(
      (acc, r) => acc + (Number(r.amount) || 0),
      0,
    );
    const dailyActualSpent = sumSpend(dailyRows);
    const monthlyActualSpent = sumSpend(monthlyRows);
    const dailyActualTxCount = (dailyRows || []).length;
    const monthlyActualTxCount = (monthlyRows || []).length;
    // Timestamp of the most recent counted row today — used by the UI to
    // render "last activity X minutes ago" without a separate query.
    const lastActivityAt = (dailyRows || [])
      .map((r: any) => r.created_at)
      .filter(Boolean)
      .sort()
      .reverse()[0] || (monthlyRows || [])
      .map((r: any) => r.created_at)
      .filter(Boolean)
      .sort()
      .reverse()[0] || null;

    // Format response
    const response = {
      ...mapWalletFromDb(walletRow),
      // Live spending totals from the transfers ledger (UTC day / UTC month).
      // The dashboard reads these to render progress bars for any wallet
      // type, including ones that don't persist counters in spending_policy.
      dailyActualSpent,
      monthlyActualSpent,
      dailyActualTxCount,
      monthlyActualTxCount,
      lastActivityAt,
      recentTransactions: recentTxs?.map(tx => ({
        id: tx.id,
        fromAccountId: tx.from_account_id,
        toAccountId: tx.to_account_id,
        amount: parseFloat(tx.amount),
        currency: tx.currency,
        status: tx.status,
        type: tx.type,
        operation: tx.protocol_metadata?.operation,
        createdAt: tx.created_at
      })) || []
    };

    return c.json({ data: response });

  } catch (error) {
    console.error('Error in GET /v1/wallets/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/wallets/:id/balance
 * Get wallet balance with on-chain sync status
 */
app.get('/:id/balance', async (c) => {
  try {
    const ctx = c.get('ctx');
    const walletId = c.req.param('id');
    const supabase = createClient();

    const { data: wallet, error } = await supabase
      .from('wallets')
      .select('id, balance, currency, wallet_address, last_synced_at, sync_data, sync_enabled, wallet_type, environment, blockchain, provider_wallet_id, token_contract')
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (error || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // Compute sync status based on last_synced_at
    let syncStatus: 'synced' | 'pending' | 'stale' = 'stale';

    // Check if this is an internal wallet (no on-chain address)
    const isInternalWallet = !wallet.wallet_address || wallet.wallet_address.startsWith('internal://');

    if (isInternalWallet) {
      // Internal wallets don't need on-chain sync
      syncStatus = 'synced';
    } else if (wallet.last_synced_at) {
      const lastSync = new Date(wallet.last_synced_at);
      const now = new Date();
      const minutesSinceSync = (now.getTime() - lastSync.getTime()) / (1000 * 60);

      if (minutesSinceSync < 5) {
        syncStatus = 'synced';
      } else if (minutesSinceSync < 60) {
        syncStatus = 'pending'; // Could use a refresh
      } else {
        syncStatus = 'stale'; // Needs sync
      }
    }

    // Live balance fetch. For every address-holding wallet we now query
    // the blockchain directly via RPC — including circle_custodial —
    // so `onChain.usdc` is always the real chain state, never what a
    // provider API *claims* to hold. Circle's reported balance is
    // exposed separately as `circleReported` so tenants can see any
    // mismatch (e.g. if Circle's ledger drifts from the actual address).
    let onChainBalance: string | null = null;
    let circleReported: string | null = null;
    const walletRecord = wallet as any;
    const isAgentEoa = walletRecord.wallet_type === 'agent_eoa';
    const isCircleCustodial = walletRecord.wallet_type === 'circle_custodial';
    // Always refetch for agent_eoa + circle_custodial (these benefit from
    // the mismatch check). For others, respect the sync-age gate.
    const shouldRefetch = !isInternalWallet && (syncStatus !== 'synced' || isAgentEoa || isCircleCustodial);

    if (shouldRefetch) {
      // Circle-side read (for circle_custodial only — compare against chain).
      if (isCircleCustodial && walletRecord.provider_wallet_id) {
        try {
          const isLiveBalEnv = getEnv(ctx) === 'live';
          const { getCircleClient, getCircleLiveClient } = await import('../services/circle/client.js');
          const circle = isLiveBalEnv ? getCircleLiveClient() : getCircleClient();
          const balance = await circle.getUsdcBalance(walletRecord.provider_wallet_id);
          circleReported = balance.formatted.toString();
        } catch (e) {
          console.warn(`[Wallets] Circle API read failed for ${walletId}:`, (e as Error)?.message);
        }
      }

      // Chain-direct read — authoritative on-chain USDC balance.
      try {
        if (wallet.wallet_address && !wallet.wallet_address.startsWith('internal://')) {
          const walletBlockchain = walletRecord.blockchain || 'base';
          if (walletBlockchain === 'sol') {
            const { getSolanaUsdcBalance } = await import('../config/solana.js');
            const { formatted } = await getSolanaUsdcBalance(wallet.wallet_address);
            onChainBalance = formatted.toString();
          } else {
            const walletEnv: 'live' | 'test' = walletRecord.environment === 'live' ? 'live' : 'test';
            const onchain = await readOnchainUsdc(wallet.wallet_address, walletEnv);
            if (onchain !== null) onChainBalance = String(onchain);
          }
        }
      } catch (e) {
        console.warn(`[Wallets] Chain RPC read failed for ${walletId}:`, (e as Error)?.message);
      }

      // Persist whichever value we got. For agent_eoa the chain IS the
      // ledger so we also mirror into `balance`. For circle_custodial
      // we store both in sync_data for transparency but DON'T overwrite
      // `balance` (that's the Circle-accounted number used for
      // spending-policy enforcement).
      if (onChainBalance !== null || circleReported !== null) {
        const updatePatch: any = {
          sync_data: {
            ...(wallet.sync_data as Record<string, unknown> || {}),
            on_chain_usdc: onChainBalance ?? (wallet.sync_data as any)?.on_chain_usdc ?? null,
            circle_reported_usdc: circleReported ?? (wallet.sync_data as any)?.circle_reported_usdc ?? null,
            synced_at: new Date().toISOString(),
          },
          last_synced_at: new Date().toISOString(),
        };
        if (isAgentEoa && onChainBalance !== null) {
          updatePatch.balance = parseFloat(onChainBalance);
        }
        supabase
          .from('wallets')
          .update(updatePatch)
          .eq('id', walletId)
          .eq('tenant_id', ctx.tenantId)
          .then(() => {});
      }
    }

    // Build on-chain data + mismatch diagnostic.
    const syncData = wallet.sync_data as Record<string, unknown> | null;
    const resolvedOnChain = onChainBalance
      ?? (syncData?.on_chain_usdc as string | null | undefined)
      ?? null;
    const resolvedCircle = circleReported
      ?? (syncData?.circle_reported_usdc as string | null | undefined)
      ?? null;
    let mismatch: null | { kind: 'circle_over_chain' | 'circle_under_chain'; delta: number; note: string } = null;
    if (isCircleCustodial && resolvedOnChain !== null && resolvedCircle !== null) {
      const chain = parseFloat(resolvedOnChain);
      const circle = parseFloat(resolvedCircle);
      const delta = circle - chain;
      if (Math.abs(delta) > 0.01) {
        mismatch = {
          kind: delta > 0 ? 'circle_over_chain' : 'circle_under_chain',
          delta: Number(delta.toFixed(6)),
          note: delta > 0
            ? `Circle claims $${circle.toFixed(4)} but only $${chain.toFixed(4)} is on-chain. Circle may have swept funds to a master wallet without updating your ledger view.`
            : `On-chain balance ($${chain.toFixed(4)}) exceeds Circle's claim ($${circle.toFixed(4)}). Possibly an inbound deposit Circle hasn't indexed yet.`,
        };
      }
    }

    const onChain = !isInternalWallet ? {
      usdc: resolvedOnChain
        ?? (syncData?.raw_balance
          ? String(parseFloat(syncData.raw_balance as string) / Math.pow(10, (syncData.decimals as number) || 6))
          : wallet.balance.toString()),
      native: (syncData?.native_balance as string) || '0',
      lastSyncedAt: onChainBalance || circleReported ? new Date().toISOString() : wallet.last_synced_at,
      source: 'chain_rpc',
    } : null;

    return c.json({
      data: {
        balance: parseFloat(wallet.balance),
        currency: wallet.currency,
        syncStatus: (onChainBalance !== null || circleReported !== null) ? 'synced' : syncStatus,
        onChain,
        circleReported: isCircleCustodial ? (resolvedCircle !== null ? parseFloat(resolvedCircle) : null) : undefined,
        mismatch,
      },
    });
  } catch (error) {
    console.error('Error in GET /v1/wallets/:id/balance:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * PATCH /v1/wallets/:id
 * Update a wallet's configuration
 */
app.patch('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json();

    // Validate request
    const validated = updateWalletSchema.parse(body);

    const supabase = createClient();

    // Check wallet exists and belongs to tenant
    const { data: existing, error: fetchError } = await supabase
      .from('wallets')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fetchError || !existing) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // Update wallet
    const { data: updated, error: updateError } = await supabase
      .from('wallets')
      .update({
        ...(validated.name !== undefined && { name: validated.name }),
        ...(validated.spendingPolicy !== undefined && { spending_policy: validated.spendingPolicy }),
        ...(validated.status && { status: validated.status }),
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating wallet:', updateError);
      return c.json({ error: 'Failed to update wallet' }, 500);
    }

    return c.json({
      data: mapWalletFromDb(updated)
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in PATCH /v1/wallets/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/wallets/:id/deposit
 * Deposit funds into a wallet
 */
app.post('/:id/deposit', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json();

    // Story 51.1: Normalize deprecated field names
    const { data: normalizedBody, deprecatedFieldsUsed } = normalizeFields(body, {
      sourceAccountId: 'fromAccountId',
    });

    // Validate request
    const validated = depositSchema.parse(normalizedBody);

    // Story 51.1: Add deprecation warning header if old fields were used
    const deprecationWarning = buildDeprecationHeader(deprecatedFieldsUsed);
    if (deprecationWarning) {
      c.header('Deprecation', deprecationWarning);
      c.header('X-Deprecated-Fields', deprecatedFieldsUsed.join(', '));
    }

    // Get the from account ID (prefer new name, fall back to old)
    const fromAccountId = validated.fromAccountId || validated.sourceAccountId;

    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // Check wallet is active
    if (wallet.status !== 'active') {
      return c.json({
        error: 'Wallet is not active',
        status: wallet.status
      }, 400);
    }

    // Verify source account belongs to tenant
    const { data: sourceAccount, error: sourceError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', fromAccountId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (sourceError || !sourceAccount) {
      return c.json({
        error: 'Source account not found or does not belong to your tenant'
      }, 404);
    }

    // Update wallet balance
    const newBalance = parseFloat(wallet.balance) + validated.amount;

    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: newBalance,
        status: 'active', // Reset from depleted if needed
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);

    if (updateError) {
      console.error('Error updating wallet balance:', updateError);
      return c.json({ error: 'Failed to deposit funds' }, 500);
    }

    // Create transfer record
    const { data: transfer, error: transferError } = await supabase
      .from('transfers')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_account_id: fromAccountId,
        to_account_id: wallet.owner_account_id,
        amount: validated.amount,
        currency: wallet.currency,
        type: 'internal',
        status: 'completed',
        description: validated.reference || 'Wallet deposit',
        protocol_metadata: {
          protocol: 'x402',
          wallet_id: wallet.id,
          operation: 'deposit'
        }
      })
      .select()
      .single();

    if (transferError) {
      console.error('Error creating transfer record:', transferError);
      // Note: balance already updated, but transfer record failed
      // In production, this should be a transaction
    }

    // Fire workflow auto-triggers (fire-and-forget)
    triggerWorkflows(supabase, ctx.tenantId, 'wallet', 'update', {
      id: wallet.id, name: wallet.name, network: wallet.network,
      address: wallet.wallet_address, amount: validated.amount,
      balance: newBalance, operation: 'deposit',
    }).catch(console.error);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.WALLET_DEPOSIT,
      subject: `wallet/${wallet.id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { amount: validated.amount, currency: wallet.currency, newBalance },
    });

    return c.json({
      data: {
        walletId: wallet.id,
        previousBalance: parseFloat(wallet.balance),
        depositAmount: validated.amount,
        newBalance,
        transferId: transfer?.id,
        currency: wallet.currency
      }
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in POST /v1/wallets/:id/deposit:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/wallets/:id/withdraw
 * Withdraw funds from a wallet
 */
app.post('/:id/withdraw', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const body = await c.req.json();

    // Validate request
    const validated = withdrawSchema.parse(body);

    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // Check wallet is active
    if (wallet.status !== 'active') {
      return c.json({
        error: 'Wallet is not active',
        status: wallet.status
      }, 400);
    }

    // Check sufficient balance
    const currentBalance = parseFloat(wallet.balance);
    if (currentBalance < validated.amount) {
      return c.json({
        error: 'Insufficient balance',
        available: currentBalance,
        requested: validated.amount
      }, 400);
    }

    // Verify destination account belongs to tenant
    const { data: destAccount, error: destError } = await supabase
      .from('accounts')
      .select('id')
      .eq('id', validated.destinationAccountId)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (destError || !destAccount) {
      return c.json({
        error: 'Destination account not found or does not belong to your tenant'
      }, 404);
    }

    // Update wallet balance
    const newBalance = currentBalance - validated.amount;
    const newStatus = newBalance === 0 ? 'depleted' : 'active';

    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: newBalance,
        status: newStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);

    if (updateError) {
      console.error('Error updating wallet balance:', updateError);
      return c.json({ error: 'Failed to withdraw funds' }, 500);
    }

    // Create transfer record
    const { data: transfer, error: transferError } = await supabase
      .from('transfers')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_account_id: wallet.owner_account_id,
        to_account_id: validated.destinationAccountId,
        amount: validated.amount,
        currency: wallet.currency,
        type: 'internal',
        status: 'completed',
        description: validated.reference || 'Wallet withdrawal',
        protocol_metadata: {
          protocol: 'x402',
          wallet_id: wallet.id,
          operation: 'withdrawal'
        }
      })
      .select()
      .single();

    if (transferError) {
      console.error('Error creating transfer record:', transferError);
      // Note: balance already updated, but transfer record failed
      // In production, this should be a transaction
    }

    // Fire workflow auto-triggers (fire-and-forget)
    triggerWorkflows(supabase, ctx.tenantId, 'wallet', 'update', {
      id: wallet.id, name: wallet.name, network: wallet.network,
      address: wallet.wallet_address, amount: validated.amount,
      balance: newBalance, operation: 'withdrawal',
    }).catch(console.error);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.WALLET_WITHDRAWAL,
      subject: `wallet/${wallet.id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { amount: validated.amount, currency: wallet.currency, newBalance },
    });

    return c.json({
      data: {
        walletId: wallet.id,
        previousBalance: currentBalance,
        withdrawalAmount: validated.amount,
        newBalance,
        transferId: transfer?.id,
        currency: wallet.currency,
        status: newStatus
      }
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json({
        error: 'Validation failed',
        details: error.errors
      }, 400);
    }
    console.error('Error in POST /v1/wallets/:id/withdraw:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /v1/wallets/:id
 * Delete a wallet (only if balance is 0)
 */
app.delete('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('id, balance')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    // Check balance is 0
    if (parseFloat(wallet.balance) > 0) {
      const force = c.req.query('force') === 'true';

      if (!force) {
        return c.json({
          error: 'Wallet has non-zero balance',
          message: 'Withdraw all funds before deleting. Add ?force=true to delete anyway.',
          balance: parseFloat(wallet.balance)
        }, 409);
      }
    }

    // Delete wallet
    const { error: deleteError } = await supabase
      .from('wallets')
      .delete()
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);

    if (deleteError) {
      console.error('Error deleting wallet:', deleteError);
      return c.json({ error: 'Failed to delete wallet' }, 500);
    }

    return c.json({
      message: 'Wallet deleted successfully'
    }, 200);

  } catch (error) {
    console.error('Error in DELETE /v1/wallets/:id:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// BYOW Endpoints (Story 40.11)
// ============================================

/**
 * POST /v1/wallets/external/challenge
 * Generate a verification challenge for BYOW
 */
app.post('/external/challenge', async (c) => {
  try {
    const body = await c.req.json();
    const { walletAddress } = body;

    if (!walletAddress) {
      return c.json({ error: 'walletAddress is required' }, 400);
    }

    const verificationService = getWalletVerificationService();
    const challenge = verificationService.generateChallenge(walletAddress);

    return c.json({ data: challenge });
  } catch (error) {
    console.error('Error in POST /v1/wallets/external/challenge:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/wallets/:id/sync
 * Sync external wallet balance from blockchain
 */
app.post('/:id/sync', async (c) => {
  try {
    const ctx = c.get('ctx');
    const walletId = c.req.param('id');
    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: fetchError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (fetchError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    if (!wallet.wallet_address) {
      return c.json({ error: 'Wallet does not have an on-chain address' }, 400);
    }

    // Check if this is an internal wallet (can't sync on-chain)
    if (wallet.wallet_address.startsWith('internal://')) {
      return c.json({ error: 'Internal wallets do not require on-chain sync' }, 400);
    }

    let formattedBalance: number;
    let syncData: Record<string, unknown>;

    // Circle custodial wallets: query BOTH Circle API and the chain,
    // so we can detect when Circle's ledger drifts from the actual
    // balance at the wallet address. `balance` stays as Circle's number
    // (it's what accounting + spending-policy checks key off), but
    // sync_data exposes on_chain_usdc for transparency and the /balance
    // endpoint surfaces the mismatch diagnostic.
    if (wallet.wallet_type === 'circle_custodial' && wallet.provider_wallet_id) {
      const isLiveSyncEnv = getEnv(ctx) === 'live';
      const { getCircleClient, getCircleLiveClient } = await import('../services/circle/client.js');
      const circle = isLiveSyncEnv ? getCircleLiveClient() : getCircleClient();
      const balances = await circle.getWalletBalances(wallet.provider_wallet_id);

      const tokenSymbol = wallet.currency || 'USDC';
      const tokenBalance = balances.find(b => b.token.symbol === tokenSymbol);
      formattedBalance = tokenBalance ? parseFloat(tokenBalance.amount) : 0;
      const nativeBalance = balances.find(b => b.token.isNative);

      // Chain-direct read so the UI can show "circle says X, chain says Y".
      const walletEnv: 'live' | 'test' = (wallet as any).environment === 'live' ? 'live' : 'test';
      const onChainUsdc = await readOnchainUsdc(wallet.wallet_address, walletEnv);

      syncData = {
        source: 'circle_api',
        token_balances: balances,
        native_balance: nativeBalance ? nativeBalance.amount : '0',
        provider_wallet_id: wallet.provider_wallet_id,
        circle_reported_usdc: String(formattedBalance),
        on_chain_usdc: onChainUsdc !== null ? String(onChainUsdc) : null,
      };
    } else if (wallet.blockchain === 'sol') {
      // Solana wallets: use Solana RPC for USDC + SOL balance
      const { getSolanaUsdcBalance, getSolBalance } = await import('../config/solana.js');

      const [usdcResult, solBalance] = await Promise.all([
        getSolanaUsdcBalance(wallet.wallet_address),
        getSolBalance(wallet.wallet_address),
      ]);

      formattedBalance = usdcResult.formatted;

      syncData = {
        source: 'solana_rpc',
        raw_balance: usdcResult.raw.toString(),
        decimals: 6,
        native_balance: solBalance,
        chain: 'solana',
      };
    } else {
      // External / non-Circle EVM wallets: use on-chain RPC
      const verificationService = getWalletVerificationService();

      const [walletInfo, tokenBalance] = await Promise.all([
        verificationService.getWalletInfo(wallet.wallet_address),
        verificationService.syncBalance(wallet.wallet_address, wallet.token_contract),
      ]);

      formattedBalance = parseFloat(tokenBalance.balance) / Math.pow(10, tokenBalance.decimals);

      syncData = {
        source: 'on_chain_rpc',
        raw_balance: tokenBalance.balance,
        decimals: tokenBalance.decimals,
        native_balance: walletInfo.balance,
        nonce: walletInfo.nonce,
        is_contract: walletInfo.isContract,
        chain: walletInfo.chain,
      };
    }

    // Update wallet in database
    const { data: updatedWallet, error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: formattedBalance,
        last_synced_at: new Date().toISOString(),
        sync_data: syncData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', walletId)
      .eq('tenant_id', ctx.tenantId)
      .select()
      .single();

    if (updateError) {
      console.error('Error updating wallet after sync:', updateError);
      return c.json({ error: 'Failed to update wallet' }, 500);
    }

    // Strip internal identifiers before returning to client
    const { provider_wallet_id, token_balances, ...safeSyncData } = syncData as Record<string, unknown>;

    return c.json({
      message: 'Wallet synced successfully',
      data: {
        id: walletId,
        address: wallet.wallet_address,
        balance: formattedBalance,
        currency: wallet.currency,
        syncData: safeSyncData,
        syncedAt: updatedWallet.last_synced_at,
      },
    });
  } catch (error) {
    console.error('Error in POST /v1/wallets/:id/sync:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/wallets/external/info
 * Get info about an external wallet address (no auth required for lookup)
 */
app.get('/external/info', async (c) => {
  try {
    const address = c.req.query('address');

    if (!address) {
      return c.json({ error: 'address query parameter is required' }, 400);
    }

    const verificationService = getWalletVerificationService();
    const walletInfo = await verificationService.getWalletInfo(address);

    // Also get USDC balance on Base Sepolia
    const usdcContract = USDC_CONTRACTS.BASE_SEPOLIA;
    const usdcBalance = await verificationService.syncBalance(address, usdcContract);
    const formattedUsdcBalance = parseFloat(usdcBalance.balance) / Math.pow(10, usdcBalance.decimals);

    return c.json({
      data: {
        address: walletInfo.address,
        chain: walletInfo.chain,
        nativeBalance: walletInfo.balance,
        nativeBalanceFormatted: (parseFloat(walletInfo.balance) / 1e18).toFixed(6) + ' ETH',
        usdcBalance: usdcBalance.balance,
        usdcBalanceFormatted: formattedUsdcBalance.toFixed(2) + ' USDC',
        isContract: walletInfo.isContract,
        nonce: walletInfo.nonce,
      },
    });
  } catch (error) {
    console.error('Error in GET /v1/wallets/external/info:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// Story 51.6: POST /v1/wallets/:id/test-fund - Test Wallet Funding
// ============================================

const testFundSchema = z.object({
  amount: z.number().positive().max(100000), // Max 100k USDC for test funding
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  reference: z.string().max(500).optional(),
});

/**
 * Add test funds to a wallet (sandbox/development only)
 *
 * @see Story 51.6: Test Wallet Funding & Auto-Assignment
 */
app.post('/:id/test-fund', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');

    // Check environment - only allow in sandbox/development
    const isProduction = process.env.NODE_ENV === 'production' &&
      !process.env.SANDBOX_MODE &&
      ctx.apiKeyEnvironment !== 'test';

    if (isProduction) {
      return c.json({
        error: {
          code: 'TEST_FUNDING_NOT_ALLOWED',
          message: 'Test funding is only available in sandbox mode',
          suggestion: 'Use a test API key (pk_test_*) or enable sandbox mode',
          docs_url: 'https://docs.payos.ai/sandbox',
        },
      }, 403);
    }

    const body = await c.req.json();
    const validated = testFundSchema.parse(body);

    const supabase = createClient();

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      return c.json({
        error: {
          code: 'WALLET_NOT_FOUND',
          message: 'Wallet not found',
          suggestion: 'Create a wallet first using POST /v1/wallets',
          related_endpoints: [
            { method: 'POST', path: '/v1/wallets', description: 'Create a new wallet' },
          ],
        },
      }, 404);
    }

    // Update wallet balance
    const previousBalance = parseFloat(wallet.balance);
    const newBalance = previousBalance + validated.amount;

    const { error: updateError } = await supabase
      .from('wallets')
      .update({
        balance: newBalance,
        status: 'active', // Ensure wallet is active
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);

    if (updateError) {
      console.error('Error updating wallet balance:', updateError);
      return c.json({ error: 'Failed to add test funds' }, 500);
    }

    // Create audit log entry
    await supabase.from('audit_log').insert({
      tenant_id: ctx.tenantId,
      entity_type: 'wallet',
      entity_id: id,
      action: 'test_fund',
      actor_type: ctx.actorType || 'user',
      actor_id: ctx.userId || ctx.actorId || 'system',
      actor_name: ctx.userName || ctx.actorName || 'System',
      changes: {
        previous_balance: previousBalance,
        funded_amount: validated.amount,
        new_balance: newBalance,
        currency: validated.currency,
        reference: validated.reference,
      },
      metadata: {
        environment: 'sandbox',
        source: 'test_fund_endpoint',
      },
    });

    console.log(`[Sandbox] Test funded wallet ${id}: +${validated.amount} ${validated.currency}`);

    return c.json({
      data: {
        wallet_id: id,
        previous_balance: previousBalance,
        funded_amount: validated.amount,
        new_balance: newBalance,
        currency: validated.currency,
        environment: 'sandbox',
        message: 'Test funds added successfully. Note: These are simulated funds for testing only.',
      },
    });
  } catch (error) {
    console.error('Error in POST /v1/wallets/:id/test-fund:', error);
    if (error instanceof z.ZodError) {
      return c.json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: error.errors,
        },
      }, 400);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// POST /v1/wallets/:id/fund - Real Circle Transfer Funding (Sandbox)
// Phase 2: Transfer real testnet USDC from master wallet to agent wallet
// ============================================

const realFundSchema = z.object({
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  native: z.boolean().default(false), // also request native ETH for gas
});

app.post('/:id/fund', async (c) => {
  try {
    const ctx = c.get('ctx');
    const id = c.req.param('id');
    const supabase = createClient();

    // Only available in sandbox with Circle configured
    if (process.env.PAYOS_ENVIRONMENT !== 'sandbox' || !process.env.CIRCLE_API_KEY) {
      return c.json({
        error: 'Real funding requires PAYOS_ENVIRONMENT=sandbox and CIRCLE_API_KEY',
        code: 'NOT_SANDBOX',
      }, 403);
    }

    const body = await c.req.json().catch(() => ({}));
    const validated = realFundSchema.parse(body);

    // Fetch wallet
    const { data: wallet, error: walletError } = await supabase
      .from('wallets')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (walletError || !wallet) {
      return c.json({ error: 'Wallet not found' }, 404);
    }

    const walletType = (wallet as any).wallet_type;
    const providerWalletId = (wallet as any).provider_wallet_id;

    // Must have a real on-chain address
    if (!wallet.wallet_address) {
      return c.json({
        error: 'Wallet has no on-chain address. Use POST /v1/wallets/:id/test-fund for internal wallets.',
        code: 'NO_ADDRESS',
      }, 400);
    }

    // Only circle_custodial and external wallets have real addresses
    if (walletType !== 'circle_custodial' && walletType !== 'external') {
      return c.json({
        error: 'Real funding only available for Circle custodial or external wallets. Use POST /v1/wallets/:id/test-fund for internal wallets.',
        code: 'INTERNAL_WALLET',
      }, 400);
    }

    const { getCircleClient } = await import('../services/circle/client.js');
    const circle = getCircleClient();

    // Call Circle faucet API — use correct blockchain for Solana vs EVM wallets
    const faucetChain = getFaucetBlockchain(wallet.blockchain || 'base');
    await circle.requestFaucetDrip(
      wallet.wallet_address,
      faucetChain as any,
      {
        usdc: validated.currency === 'USDC',
        eurc: validated.currency === 'EURC',
        native: validated.native,
      },
    );

    // For Circle custodial wallets, poll on-chain balance and sync DB
    const previousBalance = parseFloat(wallet.balance);
    let newBalance = previousBalance;

    if (walletType === 'circle_custodial' && providerWalletId) {
      // Brief wait for faucet tx to settle, then check on-chain balance
      await new Promise(resolve => setTimeout(resolve, 3000));

      const balances = await circle.getWalletBalances(providerWalletId);
      const tokenSymbol = validated.currency;
      const tokenBalance = balances.find(b => b.token.symbol === tokenSymbol);
      if (tokenBalance) {
        newBalance = parseFloat(tokenBalance.amount);
      }

      await supabase
        .from('wallets')
        .update({
          balance: newBalance,
          status: 'active',
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('tenant_id', ctx.tenantId);
    }

    // Audit log
    await supabase.from('audit_log').insert({
      tenant_id: ctx.tenantId,
      entity_type: 'wallet',
      entity_id: id,
      action: 'faucet_fund',
      actor_type: ctx.actorType || 'user',
      actor_id: ctx.userId || ctx.actorId || 'system',
      actor_name: ctx.userName || ctx.actorName || 'System',
      changes: {
        previous_balance: previousBalance,
        new_balance: newBalance,
        currency: validated.currency,
        native_requested: validated.native,
        source: 'circle_faucet',
      },
      metadata: { environment: 'sandbox', source: 'faucet_fund_endpoint' },
    });

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.WALLET_DEPOSIT,
      subject: `wallet/${id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { currency: validated.currency, source: 'circle_faucet', walletType },
    });

    return c.json({
      data: {
        wallet_id: id,
        wallet_address: wallet.wallet_address,
        wallet_type: walletType,
        previous_balance: previousBalance,
        new_balance: newBalance,
        currency: validated.currency,
        native_requested: validated.native,
        faucet: {
          status: 'success',
          note: `Circle faucet drip sent. ~20 ${validated.currency} per address per 2 hours.`,
        },
        message: walletType === 'circle_custodial'
          ? 'Faucet drip sent and balance synced from on-chain.'
          : 'Faucet drip sent. Call POST /v1/wallets/:id/sync to update balance after confirmation.',
      },
    });
  } catch (error) {
    console.error('Error in POST /v1/wallets/:id/fund:', error);
    if (error instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', details: error.errors } }, 400);
    }
    // Surface Circle API errors clearly
    const { CircleApiClientError } = await import('../services/circle/client.js');
    if (error instanceof CircleApiClientError) {
      if (error.statusCode === 403) {
        return c.json({
          error: 'Circle faucet API returned 403 Forbidden.',
          code: 'FAUCET_FORBIDDEN',
          note: 'The /v1/faucet/drips API requires a mainnet-upgraded Circle API key. ' +
            'Upgrade at https://console.circle.com/ or use the web faucet at https://faucet.circle.com/',
        }, 403);
      }
      if (error.statusCode === 429) {
        return c.json({
          error: error.message,
          code: 'FAUCET_RATE_LIMITED',
          note: 'The Circle faucet rate-limits to ~20 USDC per address per 2 hours.',
        }, 429);
      }
      return c.json({
        error: error.message,
        code: 'CIRCLE_API_ERROR',
      }, error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// Gas Station (Epic 38, Story 38.8)
// ============================================

/**
 * GET /v1/wallets/gas-station/status
 * Get Circle Gas Station status.
 *
 * NOTE: Gas Station is configured exclusively via Circle Developer Console.
 * There is no REST API for Gas Station policy management.
 * On testnet, Gas Station is enabled by default with preconfigured policies.
 * SCA (Smart Contract Account) wallets are required for Gas Station on EVM chains.
 */
app.get('/gas-station/status', async (c) => {
  try {
    const { isFeatureEnabled } = await import('../config/environment.js');
    if (!isFeatureEnabled('circleGasStation')) {
      return c.json({
        error: 'Gas Station feature is not enabled',
        code: 'FEATURE_DISABLED',
        hint: 'Set PAYOS_FEATURE_CIRCLE_GAS_STATION=true to enable',
      }, 403);
    }

    if (!process.env.CIRCLE_API_KEY) {
      return c.json({
        error: 'Circle API key not configured',
        code: 'CIRCLE_NOT_CONFIGURED',
      }, 503);
    }

    const { getCircleClient } = await import('../services/circle/client.js');
    const circle = getCircleClient();
    const status = await circle.getGasStationStatus();

    return c.json({
      data: {
        ...status,
        note: 'Gas Station policies are managed via Circle Developer Console (console.circle.com). SCA wallets required for EVM chains.',
      },
    });
  } catch (error: any) {
    console.error('Error in GET /v1/wallets/gas-station/status:', error);
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

// ============================================
// POST /:id/transfer — Wallet-to-wallet transfer (on-chain or ledger)
// ============================================

const walletTransferSchema = z.object({
  destinationWalletId: z.string().uuid().optional(),
  destinationAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  amount: z.number().positive(),
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  reference: z.string().max(255).optional(),
}).refine(
  (d) => (d.destinationWalletId ? 1 : 0) + (d.destinationAddress ? 1 : 0) === 1,
  { message: 'Provide exactly one of destinationWalletId or destinationAddress' },
);

app.post('/:id/transfer', async (c) => {
  try {
    const ctx = c.get('ctx');
    const sourceWalletId = c.req.param('id');
    const body = await c.req.json();
    const validated = walletTransferSchema.parse(body);

    const supabase = createClient();

    // 1. Fetch source wallet
    const { data: sourceWallet, error: srcErr } = await supabase
      .from('wallets')
      .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id, status, currency')
      .eq('id', sourceWalletId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();

    if (srcErr || !sourceWallet) {
      return c.json({ error: 'Source wallet not found' }, 404);
    }
    if (sourceWallet.status !== 'active') {
      return c.json({ error: `Source wallet is ${sourceWallet.status}` }, 400);
    }

    // 2. Resolve destination
    let destWallet: any = null;
    let destAddress: string;

    if (validated.destinationWalletId) {
      const { data: dw, error: dwErr } = await supabase
        .from('wallets')
        .select('id, wallet_address, wallet_type, provider_wallet_id, balance, owner_account_id, status')
        .eq('id', validated.destinationWalletId)
        .eq('tenant_id', ctx.tenantId)
        .eq('environment', getEnv(ctx))
        .single();

      if (dwErr || !dw) {
        return c.json({ error: 'Destination wallet not found' }, 404);
      }
      if (dw.status !== 'active') {
        return c.json({ error: `Destination wallet is ${dw.status}` }, 400);
      }
      destWallet = dw;
      destAddress = dw.wallet_address;
    } else {
      destAddress = validated.destinationAddress!;
    }

    // 3. Check balance
    const sourceBalance = parseFloat(sourceWallet.balance);
    if (sourceBalance < validated.amount) {
      return c.json({
        error: 'Insufficient balance',
        details: { available: sourceBalance, requested: validated.amount },
      }, 400);
    }

    // 4. Determine settlement type for transfer record
    const onChainCapable = isOnChainCapable(sourceWallet, destAddress);
    const settlementTypeInitial: 'on_chain' | 'ledger' = onChainCapable ? 'on_chain' : 'ledger';

    // 5. Create transfer record
    const transferMetadata = {
      protocol: 'wallet_transfer',
      source_wallet_id: sourceWalletId,
      destination_wallet_id: destWallet?.id || null,
      destination_address: destAddress,
      settlement_type: settlementTypeInitial,
    };

    const { data: transfer, error: transferErr } = await supabase
      .from('transfers')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_account_id: sourceWallet.owner_account_id,
        to_account_id: destWallet?.owner_account_id || null,
        amount: validated.amount,
        currency: validated.currency,
        type: 'internal',
        status: 'processing',
        description: validated.reference || `Wallet transfer ${sourceWalletId} → ${destWallet?.id || destAddress}`,
        initiated_by_type: ctx.actorType === 'agent' ? 'agent' : 'api_key',
        initiated_by_id: ctx.actorType === 'agent' ? ctx.actorId : ctx.apiKeyId,
        initiated_by_name: ctx.actorType === 'agent' ? ctx.actorName : 'api',
        protocol_metadata: transferMetadata,
      })
      .select('id')
      .single();

    if (transferErr || !transfer) {
      console.error('Failed to create transfer record:', transferErr);
      return c.json({ error: 'Failed to create transfer record' }, 500);
    }

    // 6-8. Settle: on-chain (if capable) + ledger + transfer update
    const settlement = await settleWalletTransfer({
      supabase,
      tenantId: ctx.tenantId,
      sourceWallet,
      destinationWallet: destWallet,
      amount: validated.amount,
      transferId: transfer.id,
      protocolMetadata: transferMetadata,
      environment: getEnv(ctx) as 'test' | 'live',
    });

    if (!settlement.success) {
      return c.json({ error: settlement.error || 'Settlement failed' }, 500);
    }

    return c.json({
      data: {
        transferId: transfer.id,
        from: {
          walletId: sourceWallet.id,
          address: sourceWallet.wallet_address,
          newBalance: settlement.sourceNewBalance,
        },
        to: {
          walletId: destWallet?.id || null,
          address: destAddress,
          newBalance: settlement.destinationNewBalance ?? null,
        },
        amount: validated.amount,
        currency: validated.currency,
        settlement: {
          type: settlement.settlementType,
          txHash: settlement.txHash || null,
          confirmedAt: new Date().toISOString(),
        },
      },
    });
  } catch (error) {
    console.error('Error in POST /v1/wallets/:id/transfer:', error);
    if (error instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', details: error.errors } }, 400);
    }
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;

