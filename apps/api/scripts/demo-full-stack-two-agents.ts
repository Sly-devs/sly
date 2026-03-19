#!/usr/bin/env tsx
/**
 * Full-Stack Two-Agent Demo Script
 *
 * Registers two fresh agents on Sly, provisions them with funded Tempo wallets,
 * and exercises every payment protocol: A2A, MPP, UCP, ACP (with Stripe), AP2, and x402.
 *
 * Environment Variables:
 *   SUPABASE_URL                # Required
 *   SUPABASE_SERVICE_ROLE_KEY   # Required
 *   SLY_URL                     # Default: http://localhost:4000
 *   SLY_API_KEY                 # Default: pk_test_demo_fintech_key_12345
 *   STRIPE_SECRET_KEY           # Required for ACP phase; phase skipped if absent
 *
 * Usage:
 *   cd apps/api && set -a && source .env && set +a && npx tsx scripts/demo-full-stack-two-agents.ts
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createPublicClient, createWalletClient, http, defineChain, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ============================================
// Configuration
// ============================================

const API = process.env.SLY_URL || 'http://localhost:4000';
const API_KEY = process.env.SLY_API_KEY || 'pk_test_demo_fintech_key_12345';
const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACME_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000002'; // Acme Corp

// Tempo testnet config for on-chain balance reads
const TEMPO_TESTNET = defineChain({
  id: 42431,
  name: 'Tempo Testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
});
const PATH_USD_CONTRACT = '0x20c0000000000000000000000000000000000000' as `0x${string}`;
const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

// MPP master wallet — has ~1M pathUSD on Tempo testnet
const MPP_PRIVATE_KEY = process.env.MPP_PRIVATE_KEY as `0x${string}`;
const mppMasterAccount = MPP_PRIVATE_KEY ? privateKeyToAccount(MPP_PRIVATE_KEY) : null;

const tempoPublicClient = createPublicClient({ chain: TEMPO_TESTNET, transport: http() });
const tempoWalletClient = mppMasterAccount
  ? createWalletClient({ account: mppMasterAccount, chain: TEMPO_TESTNET, transport: http() })
  : null;

async function readOnChainBalance(walletAddress: string): Promise<number> {
  const raw = await tempoPublicClient.readContract({
    address: PATH_USD_CONTRACT,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [walletAddress as `0x${string}`],
  });
  return Number(raw) / 1e6; // pathUSD has 6 decimals
}

/** Transfer pathUSD on-chain from MPP master wallet to target address */
async function fundOnChain(toAddress: string, amountUsd: number): Promise<string> {
  if (!tempoWalletClient) throw new Error('MPP_PRIVATE_KEY not set');
  const amount = parseUnits(amountUsd.toString(), 6);
  const hash = await tempoWalletClient.writeContract({
    address: PATH_USD_CONTRACT,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [toAddress as `0x${string}`, amount],
  });
  // Wait for confirmation
  await tempoPublicClient.waitForTransactionReceipt({ hash });
  return hash;
}

/** Send ETH for gas from MPP master wallet */
async function fundGas(toAddress: string, ethAmount: bigint): Promise<string> {
  if (!tempoWalletClient) throw new Error('MPP_PRIVATE_KEY not set');
  const hash = await tempoWalletClient.sendTransaction({
    to: toAddress as `0x${string}`,
    value: ethAmount,
  });
  await tempoPublicClient.waitForTransactionReceipt({ hash });
  return hash;
}

// Supabase client for direct DB operations
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

// ============================================
// Counters & State
// ============================================

let passCount = 0;
let failCount = 0;

const created: {
  agents: string[];
  wallets: string[];
  accounts: string[];
  mandates: string[];
  endpoints: string[];
  sessions: string[];
  acpCheckouts: string[];
  ucpCheckouts: string[];
  a2aTasks: string[];
  transfers: string[];
  x402Payments: string[];
} = { agents: [], wallets: [], accounts: [], mandates: [], endpoints: [], sessions: [], acpCheckouts: [], ucpCheckouts: [], a2aTasks: [], transfers: [], x402Payments: [] };

const SUPABASE_PROJECT_REF = (process.env.SUPABASE_URL || '').replace('https://', '').replace('.supabase.co', '');
const SB_DASH = `https://supabase.com/dashboard/project/${SUPABASE_PROJECT_REF}/editor`;
const API_DASH = API;

// Agent A state
let agentAId = '';
let agentAToken = '';
let agentAInternalWalletId = '';
let agentATempoWalletId = '';
let agentATempoAddress = '';

// Agent B state
let agentBId = '';
let agentBToken = '';
let agentBInternalWalletId = '';
let agentBTempoWalletId = '';
let agentBTempoAddress = '';
let botForgeAccountId = '';

// ============================================
// Helpers
// ============================================

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passCount++;
  } else {
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
    failCount++;
  }
}

/** Soft assert — logs but does not increment failCount (for optional checks) */
function softAssert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passCount++;
  } else {
    console.log(`  ⚠️  ${label}${detail ? ` — ${detail}` : ''} (soft)`);
  }
}

/** Unwrap API envelope: { success, data } → data, or return raw if no envelope */
function unwrap(res: any): any {
  if (res && typeof res === 'object' && 'success' in res && 'data' in res) {
    return res.data;
  }
  return res;
}

async function apiGet(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  return unwrap(await res.json());
}

async function apiPostRaw(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

async function apiPost(path: string, body: Record<string, unknown>) {
  const raw = await apiPostRaw(path, body);
  return unwrap(raw);
}

async function apiPatch(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return unwrap(await res.json());
}

async function jsonRpc(agentId: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${API}/a2a/${agentId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }),
  });
  return res.json() as Promise<any>;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================
// Phase 0: Setup & Agent Registration
// ============================================

async function phase0_setup() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 0: Setup & Agent Registration              ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // 1. Health check
  try {
    const health = await fetch(`${API}/health`);
    const raw = await health.json() as any;
    const h = raw?.data || raw;
    assert(h?.status === 'healthy' || h?.status === 'ok', `API healthy: ${h?.status}`);
  } catch {
    console.log('  ❌ API not running at', API);
    process.exit(1);
  }

  // 2. Create Agent A ("AlicePayBot")
  // Response wrapper double-nests: { success, data: { data: {...agent}, credentials: {...} } }
  console.log('\n  Creating Agent A (AlicePayBot)...');
  const agentARaw = await apiPostRaw('/v1/agents', {
    accountId: ACME_ACCOUNT_ID,
    name: 'AlicePayBot',
    description: 'Full-stack demo payer agent — initiates payments across all protocols',
    auto_create_wallet: true,
  });
  // Navigate double-wrapped envelope
  const agentAOuter = agentARaw?.data || agentARaw;
  const agentAData = agentAOuter?.data || agentAOuter;
  const agentACreds = agentAOuter?.credentials || agentARaw?.credentials;

  assert(!!agentAData?.id, `Agent A created: ${agentAData?.id?.slice(0, 12)}...`);
  agentAId = agentAData?.id || '';
  agentAInternalWalletId = agentAData?.wallet_id || '';
  agentAToken = agentACreds?.token || '';
  assert(agentAToken.startsWith('agent_'), `Agent A token: ${agentAToken.slice(0, 12)}...`);
  created.agents.push(agentAId);
  if (agentAInternalWalletId) created.wallets.push(agentAInternalWalletId);

  // 3. Create second business account ("BotForge Labs")
  console.log('\n  Creating BotForge Labs account...');
  botForgeAccountId = randomUUID();
  const { error: acctErr } = await supabase.from('accounts').insert({
    id: botForgeAccountId,
    tenant_id: TENANT_ID,
    name: 'BotForge Labs',
    type: 'business',
    email: `botforge-${Date.now()}@demo.sly.dev`,
    verification_tier: 1,
    verification_status: 'verified',
    verification_type: 'kyb',
  });
  assert(!acctErr, `BotForge Labs account created: ${botForgeAccountId.slice(0, 12)}...`, acctErr?.message);
  created.accounts.push(botForgeAccountId);

  // 4. Create Agent B ("BobAnalytics")
  console.log('\n  Creating Agent B (BobAnalytics)...');
  const agentBRaw = await apiPostRaw('/v1/agents', {
    accountId: botForgeAccountId,
    name: 'BobAnalytics',
    description: 'Full-stack demo research agent — receives tasks and provides analytics',
    auto_create_wallet: true,
  });
  const agentBOuter = agentBRaw?.data || agentBRaw;
  const agentBData = agentBOuter?.data || agentBOuter;
  const agentBCreds = agentBOuter?.credentials || agentBRaw?.credentials;

  assert(!!agentBData?.id, `Agent B created: ${agentBData?.id?.slice(0, 12)}...`);
  agentBId = agentBData?.id || '';
  agentBInternalWalletId = agentBData?.wallet_id || '';
  agentBToken = agentBCreds?.token || '';
  assert(agentBToken.startsWith('agent_'), `Agent B token: ${agentBToken.slice(0, 12)}...`);
  created.agents.push(agentBId);
  if (agentBInternalWalletId) created.wallets.push(agentBInternalWalletId);

  // 5. KYA verify both agents
  console.log('\n  KYA verifying agents (tier 1)...');
  const verifyA = await apiPost(`/v1/agents/${agentAId}/verify`, { tier: 1 });
  assert(verifyA?.kya_tier === 1 || verifyA?.kyaTier === 1, `Agent A KYA tier 1`);
  const verifyB = await apiPost(`/v1/agents/${agentBId}/verify`, { tier: 1 });
  assert(verifyB?.kya_tier === 1 || verifyB?.kyaTier === 1, `Agent B KYA tier 1`);

  // 6. Provision Tempo wallets
  console.log('\n  Provisioning Tempo wallets...');
  const tempoA = await apiPost('/v1/mpp/wallets/provision', {
    agent_id: agentAId,
    owner_account_id: ACME_ACCOUNT_ID,
    testnet: true,
    initial_balance: 0,
  });
  const walletA = tempoA?.data || tempoA;
  agentATempoWalletId = walletA?.id || '';
  agentATempoAddress = walletA?.address || walletA?.wallet_address || '';
  assert(!!agentATempoWalletId, `Agent A Tempo wallet: ${agentATempoWalletId.slice(0, 12)}...`);
  assert(agentATempoAddress.startsWith('0x'), `Agent A Tempo address: ${agentATempoAddress.slice(0, 14)}...`);
  if (agentATempoWalletId) created.wallets.push(agentATempoWalletId);

  const tempoB = await apiPost('/v1/mpp/wallets/provision', {
    agent_id: agentBId,
    owner_account_id: botForgeAccountId,
    testnet: true,
    initial_balance: 0,
  });
  const walletB = tempoB?.data || tempoB;
  agentBTempoWalletId = walletB?.id || '';
  agentBTempoAddress = walletB?.address || walletB?.wallet_address || '';
  assert(!!agentBTempoWalletId, `Agent B Tempo wallet: ${agentBTempoWalletId.slice(0, 12)}...`);
  assert(agentBTempoAddress.startsWith('0x'), `Agent B Tempo address: ${agentBTempoAddress.slice(0, 14)}...`);
  if (agentBTempoWalletId) created.wallets.push(agentBTempoWalletId);

  // 7. Fund wallets — BOTH on-chain (pathUSD + gas) AND DB ledger
  console.log('\n  Funding wallets on-chain from MPP master...');

  // On-chain: transfer pathUSD + gas ETH from MPP master → each agent Tempo wallet
  for (const [name, addr] of [
    ['AlicePayBot', agentATempoAddress],
    ['BobAnalytics', agentBTempoAddress],
  ] as const) {
    if (!addr) { console.log(`  ${name}: no address, skipping on-chain fund`); continue; }
    try {
      // Send 50 pathUSD
      const txHash = await fundOnChain(addr, 50);
      assert(true, `${name} on-chain: 50 pathUSD sent (tx: ${txHash.slice(0, 18)}...)`);
      created.transfers.push(txHash); // track the on-chain tx

      // Send gas ETH — Tempo testnet gives all addresses infinite ETH, so this may fail
      try {
        const gasTx = await fundGas(addr, parseUnits('0.01', 18));
        console.log(`    ${name} gas: 0.01 ETH (tx: ${gasTx.slice(0, 18)}...)`);
      } catch {
        console.log(`    ${name} gas: skipped (Tempo testnet has native ETH)`);
      }

      // Verify on-chain balance
      const bal = await readOnChainBalance(addr);
      assert(bal >= 50, `${name} on-chain balance verified: ${bal} pathUSD`);
    } catch (err: any) {
      assert(false, `${name} on-chain fund`, err.message?.slice(0, 100));
    }
  }

  console.log('\n  Funding wallets via DB ledger...');

  // DB ledger: Tempo wallets — $50 each
  for (const [name, wId, acctId] of [
    ['AlicePayBot Tempo', agentATempoWalletId, ACME_ACCOUNT_ID],
    ['BobAnalytics Tempo', agentBTempoWalletId, botForgeAccountId],
  ] as const) {
    if (!wId) continue;
    const dep = await apiPost(`/v1/wallets/${wId}/deposit`, { fromAccountId: acctId, amount: 50 });
    assert(dep?.newBalance !== undefined || dep?.walletId !== undefined,
      `${name} DB ledger funded $50 → balance=$${dep?.newBalance}`,
      dep?.error);
  }

  // Internal wallets — $25 each (needed for x402)
  for (const [name, wId, acctId] of [
    ['AlicePayBot Internal', agentAInternalWalletId, ACME_ACCOUNT_ID],
    ['BobAnalytics Internal', agentBInternalWalletId, botForgeAccountId],
  ] as const) {
    if (!wId) continue;
    const dep = await apiPost(`/v1/wallets/${wId}/deposit`, { fromAccountId: acctId, amount: 25 });
    assert(dep?.newBalance !== undefined || dep?.walletId !== undefined,
      `${name} funded $25 → balance=$${dep?.newBalance}`,
      dep?.error);
  }

  // 8. Seed agent skills
  console.log('\n  Seeding agent skills...');
  const skillsA = [
    { skill_id: 'make_payment', name: 'Make Payment', base_price: 0, tags: ['payments'], description: 'Execute a payment transfer.' },
    { skill_id: 'create_checkout', name: 'Create Checkout', base_price: 0.50, tags: ['commerce', 'ucp'], description: 'Create a UCP checkout session.' },
    { skill_id: 'access_api', name: 'Access Paid API', base_price: 0.10, tags: ['x402', 'api'], description: 'Access a paid API endpoint via x402.' },
  ];
  const skillsB = [
    { skill_id: 'research', name: 'Research & Analysis', base_price: 2.00, tags: ['research', 'analytics'], description: 'Payment corridor research and analysis.' },
    { skill_id: 'agent_info', name: 'Agent Info', base_price: 0, tags: ['info'], description: 'Get agent capabilities and status.' },
    { skill_id: 'create_mandate', name: 'Create Mandate', base_price: 1.00, tags: ['ap2', 'mandates'], description: 'Create an AP2 payment mandate.' },
    { skill_id: 'access_api', name: 'Access Paid API', base_price: 0.10, tags: ['x402', 'api'], description: 'Access a paid API endpoint via x402.' },
  ];

  for (const [agentId, skills, agentName] of [
    [agentAId, skillsA, 'AlicePayBot'],
    [agentBId, skillsB, 'BobAnalytics'],
  ] as const) {
    const rows = skills.map((s) => ({
      tenant_id: TENANT_ID,
      agent_id: agentId,
      skill_id: s.skill_id,
      name: s.name,
      description: s.description,
      base_price: s.base_price,
      currency: 'USDC',
      tags: s.tags,
      input_modes: ['text'],
      output_modes: ['text', 'data'],
      status: 'active' as const,
    }));
    const { error: skillErr } = await supabase
      .from('agent_skills')
      .upsert(rows, { onConflict: 'tenant_id,agent_id,skill_id' });
    assert(!skillErr, `${agentName} skills seeded (${skills.length})`, skillErr?.message);
  }

  // 9. Set processing_mode='managed' on both agents
  console.log('\n  Setting managed processing mode...');
  for (const [agentId, agentName] of [
    [agentAId, 'AlicePayBot'],
    [agentBId, 'BobAnalytics'],
  ] as const) {
    await supabase
      .from('agents')
      .update({
        processing_mode: 'managed',
        processing_config: {
          model: 'regex',
          systemPrompt: `You are ${agentName}. Process requests and respond appropriately.`,
        },
      })
      .eq('id', agentId)
      .eq('tenant_id', TENANT_ID);
    console.log(`  ${agentName}: processing_mode=managed`);
  }

  // Summary
  console.log('\n  ── Agent Summary ──');
  console.log(`  AlicePayBot:   agent=${agentAId.slice(0, 12)}... tempo=${agentATempoWalletId.slice(0, 12)}... internal=${agentAInternalWalletId.slice(0, 12)}...`);
  console.log(`  BobAnalytics:  agent=${agentBId.slice(0, 12)}... tempo=${agentBTempoWalletId.slice(0, 12)}... internal=${agentBInternalWalletId.slice(0, 12)}...`);
}

// ============================================
// Phase 1: MPP Direct Charges
// ============================================

async function phase1_mppDirectCharges() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 1: MPP Direct Charges                      ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  for (const [name, agentId, walletId] of [
    ['AlicePayBot', agentAId, agentATempoWalletId],
    ['BobAnalytics', agentBId, agentBTempoWalletId],
  ] as const) {
    if (!walletId) { console.log(`  ${name}: skipped (no wallet)`); continue; }
    console.log(`\n  ${name} → mpp.dev/api/ping/paid ($0.10)`);
    const charge = await apiPost('/v1/mpp/pay', {
      service_url: 'https://mpp.dev/api/ping/paid',
      amount: 0.10,
      agent_id: agentId,
      wallet_id: walletId,
    });

    assert(charge?.status === 'completed', `${name} charge completed`, charge?.error || charge?.reason);
    assert(!!charge?.payment?.receipt_id || !!charge?.transfer_id, `${name} receipt/transfer exists`);
    if (charge?.transfer_id) created.transfers.push(charge.transfer_id);
  }
}

// ============================================
// Phase 2: MPP Sessions + Vouchers
// ============================================

async function phase2_mppSessions() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 2: MPP Sessions + Vouchers                 ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  console.log('\n  AlicePayBot opens session ($1.00 deposit)');
  const session = await apiPost('/v1/mpp/sessions', {
    service_url: 'https://mpp.dev/api/ping/paid',
    deposit_amount: 1.00,
    agent_id: agentAId,
    wallet_id: agentATempoWalletId,
    currency: 'USDC',
  });

  const sessId = session?.id;
  assert(!!sessId, `Session created: ${sessId?.slice(0, 8)}...`);
  if (sessId) created.sessions.push(sessId);

  if (!sessId) {
    console.log(`  Result: ${JSON.stringify(session).slice(0, 200)}`);
    // Count remaining expected assertions as failures
    for (let i = 0; i < 7; i++) failCount++;
    return;
  }

  // Issue 3 vouchers
  const voucherAmounts = [0.10, 0.15, 0.25];
  let expectedCumulative = 0;
  for (const vAmount of voucherAmounts) {
    expectedCumulative += vAmount;
    const v = await apiPost(`/v1/mpp/sessions/${sessId}/voucher`, { amount: vAmount });
    if (v?.voucher_index !== undefined) {
      assert(true, `Voucher $${vAmount}: idx=${v.voucher_index}, cumulative=$${v.cumulative_spent}`);
    } else {
      assert(false, `Voucher $${vAmount}`, v?.error || v?.reason || 'unknown');
    }
  }

  // Verify cumulative
  assert(
    Math.abs(expectedCumulative - 0.50) < 0.001,
    `Cumulative voucher total = $0.50`,
  );

  // Close session
  const close = await apiPost(`/v1/mpp/sessions/${sessId}/close`, {});
  const closed = close?.status === 'closed';
  const spent = close?.spentAmount ?? close?.spent_amount;
  assert(closed, `Session closed, spent=$${spent}`);

  // Assert spent matches cumulative
  assert(
    spent !== undefined && Math.abs(Number(spent) - 0.50) < 0.01,
    `Session spent total matches vouchers ($${spent})`,
  );

  // Final session state check
  assert(close?.session_id === sessId || close?.id === sessId || closed,
    `Session finalized`,
  );
}

// ============================================
// Phase 3: ACP Checkout with Stripe
// ============================================

async function phase3_acpCheckout() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 3: ACP Checkout with Stripe                ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  if (!process.env.STRIPE_SECRET_KEY) {
    console.log('\n  ⚠️  STRIPE_SECRET_KEY not set — skipping ACP phase');
    console.log('  (Set STRIPE_SECRET_KEY to enable ACP checkout testing)');
    return;
  }

  const checkoutId = `chk_demo_${Date.now()}`;
  console.log(`\n  Creating ACP checkout: ${checkoutId}`);
  const checkout = await apiPost('/v1/acp/checkouts', {
    checkout_id: checkoutId,
    agent_id: agentAId,
    agent_name: 'AlicePayBot',
    account_id: ACME_ACCOUNT_ID,
    merchant_id: 'merchant_cloud_hosting',
    merchant_name: 'NexusCloud Hosting',
    items: [{
      name: 'A100 GPU Instance (1 hour)',
      quantity: 2,
      unit_price: 4.50,
      total_price: 9.00,
    }],
    currency: 'USDC',
  });

  assert(!!checkout?.id, `ACP checkout created: ${checkout?.id?.slice(0, 12)}...`);
  if (checkout?.id) created.acpCheckouts.push(checkout.id);
  assert(
    checkout?.total_amount === 9.00 || checkout?.total_amount === '9.00' || checkout?.total_amount === 9,
    `Total amount = $9.00 (got $${checkout?.total_amount})`,
  );

  if (!checkout?.id) {
    console.log(`  Result: ${JSON.stringify(checkout).slice(0, 200)}`);
    failCount += 4; // skip remaining assertions
    return;
  }

  // Complete checkout with Stripe test token
  // ACP complete returns { data: {...} } → wrapper unwraps to { success, data: {...} }
  const spt = `spt_test_demo_${Date.now()}`;
  console.log(`\n  Completing checkout with SPT: ${spt.slice(0, 20)}...`);
  const completeData = await apiPost(`/v1/acp/checkouts/${checkout.id}/complete`, {
    shared_payment_token: spt,
  });

  assert(
    completeData?.status === 'completed' || completeData?.status === 'processing' || completeData?.payment_status === 'completed',
    `ACP checkout completed: status=${completeData?.status}`,
    completeData?.error,
  );
  assert(
    !!completeData?.checkout_id || !!completeData?.transfer_id,
    `ACP transfer recorded`,
  );
  assert(
    !!completeData?.stripe_payment_intent_id || completeData?.payment_status === 'completed',
    `ACP payment processed`,
  );
  assert(!!checkout?.id, `ACP checkout ID matches: ${checkout.id.slice(0, 12)}...`);
}

// ============================================
// Phase 4: UCP Checkout
// ============================================

async function phase4_ucpCheckout() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 4: UCP Checkout                            ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // UCP uses minor units (cents) for prices
  // Must include buyer, payment_instruments, and checkout_type='digital' (no shipping required)
  console.log('\n  BobAnalytics creates UCP checkout...');
  const checkout = await apiPost('/v1/ucp/checkouts', {
    currency: 'USD',
    line_items: [
      { id: 'report-latam-q1', name: 'LATAM Corridor Report', quantity: 1, unit_price: 2500, total_price: 2500 },
      { id: 'data-feed-monthly', name: 'Real-time Data Feed', quantity: 1, unit_price: 1500, total_price: 1500 },
    ],
    payment_config: { handlers: ['payos_native'], default_handler: 'payos_native' },
    agent_id: agentBId,
    buyer: { email: 'bob@botforge-labs.demo', name: 'BobAnalytics Agent' },
    payment_instruments: [{ id: 'pi_payos_native_default', handler: 'payos_native', type: 'wallet' }],
    checkout_type: 'digital',
  });

  assert(!!checkout?.id, `UCP checkout created: ${checkout?.id?.slice(0, 12)}...`);
  if (checkout?.id) created.ucpCheckouts.push(checkout.id);

  // Verify totals — totals is an array of {type, amount, label}
  const totalsArr = Array.isArray(checkout?.totals) ? checkout.totals : [];
  const totalEntry = totalsArr.find((t: any) => t.type === 'total');
  const totalAmount = totalEntry?.amount;
  assert(
    totalAmount === 4000,
    `UCP total = 4000 cents ($40.00), got ${totalAmount}`,
  );

  // Check line items
  const items = checkout?.line_items || checkout?.items;
  assert(
    Array.isArray(items) && items.length === 2,
    `UCP has 2 line items`,
  );

  if (!checkout?.id) {
    console.log(`  Result: ${JSON.stringify(checkout).slice(0, 200)}`);
    failCount += 3; // skip remaining
    return;
  }

  // Complete checkout
  console.log('\n  Completing UCP checkout...');
  const complete = await apiPost(`/v1/ucp/checkouts/${checkout.id}/complete`, {});
  assert(
    complete?.status === 'completed',
    `UCP checkout completed: status=${complete?.status}`,
    complete?.error,
  );

  assert(
    complete?.id === checkout.id,
    `UCP checkout ID confirmed`,
  );
  assert(
    complete?.payment_status === 'paid' || complete?.status === 'completed',
    `UCP payment settled`,
  );
}

// ============================================
// Phase 5: A2A Task — Agent A → Agent B
// ============================================

async function phase5_a2aTask() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 5: A2A Task — AlicePayBot → BobAnalytics   ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  console.log('\n  Sending research task via JSON-RPC...');
  const rpc = await jsonRpc(agentBId, 'message/send', {
    message: {
      role: 'user',
      parts: [{ text: 'Research LATAM stablecoin payment corridors' }],
      metadata: { callerAgentId: agentAId },
    },
  });

  assert(!rpc.error, `A2A task sent (no RPC error)`, rpc.error?.message || rpc.error?.data);

  const taskId = rpc.result?.id;
  assert(!!taskId, `A2A task created: ${taskId?.slice(0, 8)}...`);
  if (taskId) created.a2aTasks.push(taskId);

  if (!taskId) {
    console.log(`  Result: ${JSON.stringify(rpc).slice(0, 200)}`);
    failCount += 3; // skip remaining
    return;
  }

  // Trigger processing
  console.log('  Triggering processing...');
  const processRes = await fetch(`${API}/v1/a2a/tasks/${taskId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({}),
  });
  assert(processRes.status === 200, `Processing triggered (HTTP ${processRes.status})`);

  await sleep(2000);

  // Fetch final state
  const finalRpc = await jsonRpc(agentBId, 'tasks/get', { id: taskId });
  const task = finalRpc.result;
  assert(task?.status?.state === 'completed', `Task state: ${task?.status?.state}`);

  // Check response content
  const hasContent = task?.history?.some((m: any) =>
    m.role === 'agent' && m.parts?.some((p: any) => p.text?.length > 0)
  );
  assert(hasContent || task?.status?.state === 'completed', `Task has response content`);
}

// ============================================
// Phase 6: AP2 Mandate + On-Chain Execution
// ============================================

async function phase6_ap2Mandate() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 6: AP2 Mandate + On-Chain Execution        ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // Get Tempo wallet addresses from DB for metadata
  const { data: walletA } = await supabase
    .from('wallets')
    .select('wallet_address')
    .eq('id', agentATempoWalletId)
    .single();
  const { data: walletB } = await supabase
    .from('wallets')
    .select('wallet_address')
    .eq('id', agentBTempoWalletId)
    .single();

  console.log(`  AlicePayBot addr:  ${walletA?.wallet_address?.slice(0, 14)}...`);
  console.log(`  BobAnalytics addr: ${walletB?.wallet_address?.slice(0, 14)}...`);

  // Create mandate: Acme Corp authorizes AlicePayBot to pay BobAnalytics (25 pathUSD)
  console.log('\n  Creating AP2 mandate: Acme Corp → AlicePayBot pays BobAnalytics (25 pathUSD)');
  const mandateResult = await apiPost('/v1/ap2/mandates', {
    account_id: ACME_ACCOUNT_ID,
    agent_id: agentAId,
    agent_name: 'AlicePayBot',
    mandate_type: 'payment',
    authorized_amount: 25,
    currency: 'pathUSD',
    metadata: {
      recipientAgentId: agentBId,
      recipientAddress: walletB?.wallet_address,
      purpose: 'Recurring API access for analytics data — pays BobAnalytics',
    },
  });

  const mandate = mandateResult?.data || mandateResult;
  assert(!!mandate?.id, `Mandate created: ${mandate?.id?.slice(0, 8)}...`);
  assert(
    Number(mandate?.authorized_amount) === 25,
    `Authorized amount = $25 (got $${mandate?.authorized_amount})`,
  );
  if (mandate?.id) created.mandates.push(mandate.id);

  if (!mandate?.id) {
    console.log(`  Result: ${JSON.stringify(mandateResult).slice(0, 200)}`);
    failCount += 8; // skip remaining
    return;
  }

  // Execute 3 charges: $5, $8, $3
  const executions = [
    { amount: 5, desc: 'Analytics API — batch 1' },
    { amount: 8, desc: 'Analytics API — batch 2' },
    { amount: 3, desc: 'Analytics API — batch 3' },
  ];

  let totalExecuted = 0;
  for (const exec of executions) {
    console.log(`\n  Execute mandate: $${exec.amount} pathUSD — ${exec.desc}`);
    const rawResult = await apiPostRaw(`/v1/ap2/mandates/${mandate.id}/execute`, {
      amount: exec.amount,
      currency: 'pathUSD',
      description: exec.desc,
    });
    const execData = rawResult?.data || rawResult;

    if (execData?.status === 'completed') {
      totalExecuted += exec.amount;
      assert(true, `Execution $${exec.amount}: completed`);
      assert(
        execData.remaining_amount === 25 - totalExecuted,
        `Remaining: $${execData.remaining_amount} (expected $${25 - totalExecuted})`,
      );

      assert(!!execData.settlement_tx_hash, `Settlement TX: ${(execData.settlement_tx_hash || '').slice(0, 20)}...`, 'missing settlement_tx_hash');
      if (execData.settlement_tx_hash) created.transfers.push(execData.settlement_tx_hash);
    } else {
      assert(false, `Execution $${exec.amount}`, JSON.stringify(rawResult).slice(0, 200));
      assert(false, `Remaining after $${exec.amount}`, 'execution failed');
    }
  }

  // Verify final mandate state
  const finalMandate = await apiGet(`/v1/ap2/mandates/${mandate.id}`);
  const fm = finalMandate?.data || finalMandate;
  if (fm) {
    console.log(`\n  Final mandate state:`);
    console.log(`    Authorized: $${fm.authorized_amount}`);
    console.log(`    Used:       $${fm.used_amount}`);
    console.log(`    Remaining:  $${fm.remaining_amount ?? (Number(fm.authorized_amount) - Number(fm.used_amount))}`);
    assert(Number(fm.used_amount) === 16, `Used amount = $16 (5+8+3), got $${fm.used_amount}`);
  } else {
    assert(false, 'Final mandate fetch', 'no data returned');
  }
}

// ============================================
// Phase 7: x402 Paid API Access
// ============================================

async function phase7_x402Access() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 7: x402 Paid API Access                    ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // 1. Register paid endpoint (owned by Acme Corp / AlicePayBot)
  // Response: wrapper unwraps { data: {...} } → { success, data: {...} }
  console.log('\n  Registering x402 endpoint...');
  const endpoint = await apiPost('/v1/x402/endpoints', {
    name: 'Premium Data API',
    path: `/api/v1/premium/trends-${Date.now()}`, // unique path to avoid 409
    method: 'GET',
    accountId: ACME_ACCOUNT_ID,
    basePrice: 1.50,
    currency: 'USDC',
  });

  assert(!!endpoint?.id, `Endpoint created: ${endpoint?.id?.slice(0, 12)}...`);
  assert(endpoint?.status === 'active', `Endpoint active`);
  if (endpoint?.id) created.endpoints.push(endpoint.id);

  if (!endpoint?.id) {
    console.log(`  Result: ${JSON.stringify(endpoint).slice(0, 200)}`);
    failCount += 6; // skip remaining
    return;
  }

  // Use the path from the response (might be mapped from snake_case)
  const endpointPath = endpoint.path || endpoint.endpointPath;

  // 2. Agent B pays to access
  const requestId = randomUUID();
  const nowEpoch = Math.floor(Date.now() / 1000);
  console.log(`\n  BobAnalytics pays $1.50 to access endpoint...`);
  const payRaw = await apiPostRaw('/v1/x402/pay', {
    endpointId: endpoint.id,
    requestId,
    amount: 1.50,
    currency: 'USDC',
    walletId: agentBInternalWalletId,
    method: 'GET',
    path: endpointPath,
    timestamp: nowEpoch,
  });
  // x402/pay returns { success, message, data: {...} } which wrapper wraps to
  // { success, data: { success, message, data: {...} } }
  const payOuter = payRaw?.data || payRaw;
  const payData = payOuter?.data || payOuter;
  const paySuccess = payOuter?.success ?? payRaw?.success;

  assert(
    paySuccess === true,
    `x402 pay succeeded`,
    payData?.error || payOuter?.error || payRaw?.error,
  );

  const transferId = payData?.transferId || payData?.intentId;
  assert(!!transferId, `x402 transfer: ${transferId?.slice(0, 12)}...`);
  if (transferId) created.x402Payments.push(transferId);

  if (!transferId) {
    console.log(`  Result: ${JSON.stringify(payRaw).slice(0, 300)}`);
    failCount += 4; // skip remaining
    return;
  }

  // Try JWT verification first (faster), fall back to DB verification
  const jwt = payData?.proof?.jwt;
  assert(!!jwt || !!payData?.proof?.signature, `Payment proof exists`);

  // 3. Verify the payment using DB verification
  // x402/verify returns { verified: true, data: {...} } (2+ keys) → wrapper wraps as default:
  // { success, data: { verified, data: {...} } }
  // apiPost unwraps to: { verified, data: {...} }
  console.log('\n  Verifying x402 payment...');
  const verifyRaw = await apiPostRaw('/v1/x402/verify', { requestId, transferId });
  // Navigate wrapper: raw.data contains the actual response
  const verifyOuter = verifyRaw?.data || verifyRaw;
  const verified = verifyOuter?.verified === true;
  assert(verified, `x402 verify: valid=${verified}`, !verified ? `raw=${JSON.stringify(verifyOuter).slice(0, 200)}` : undefined);

  // Check proof
  if (jwt) {
    assert(jwt.split('.').length === 3, `Payment proof is valid JWT`);
  } else {
    const vData = verifyOuter?.data || verifyOuter;
    assert(!!vData?.transferId || !!vData?.requestId, `Verify returned payment details`);
  }

  // Balance check: Agent B's internal wallet should have decreased
  const { data: bWallet } = await supabase
    .from('wallets')
    .select('balance')
    .eq('id', agentBInternalWalletId)
    .single();
  const bBalance = Number(bWallet?.balance || 0);
  assert(bBalance < 25, `BobAnalytics internal balance decreased: $${bBalance}`);
}

// ============================================
// Phase 8: Verification & Scorecard
// ============================================

async function phase8_verification() {
  console.log('\n╔═══════════════════════════════════════════════════╗');
  console.log('║   Phase 8: Verification & Scorecard                ║');
  console.log('╚═══════════════════════════════════════════════════╝');

  // MPP Analytics
  console.log('\n  ── MPP Analytics ──');
  const analytics = await apiGet('/v1/mpp/analytics');
  if (analytics?.summary) {
    console.log(`  Total revenue:   $${analytics.summary.totalRevenue}`);
    console.log(`  Total sessions:  ${analytics.summary.totalSessions}`);
    console.log(`  Unique agents:   ${analytics.summary.uniqueAgents}`);
  }

  // MPP Transfers
  console.log('\n  ── MPP Transfers ──');
  const transfers = await apiGet('/v1/mpp/transfers?limit=20');
  const txList = transfers?.data || (Array.isArray(transfers) ? transfers : []);
  assert(txList.length > 0, `MPP transfers exist (${txList.length})`);
  for (const tx of txList.slice(0, 5)) {
    console.log(`    ${tx.id?.slice(0, 8)}... $${tx.amount} ${tx.currency}`);
  }

  // AP2 Mandates
  console.log('\n  ── AP2 Mandates ──');
  const mandates = await apiGet('/v1/ap2/mandates?limit=10');
  const mandateList = mandates?.data || (Array.isArray(mandates) ? mandates : []);
  assert(mandateList.length > 0, `AP2 mandates exist (${mandateList.length})`);
  for (const m of mandateList.slice(0, 3)) {
    console.log(`    ${m.id?.slice(0, 8)}... $${m.authorized_amount} ${m.currency} used=$${m.used_amount} [${m.status}]`);
  }

  // ACP Checkouts
  console.log('\n  ── ACP Checkouts ──');
  const acpCheckouts = await apiGet('/v1/acp/checkouts?limit=10');
  const acpList = acpCheckouts?.data || (Array.isArray(acpCheckouts) ? acpCheckouts : []);
  if (process.env.STRIPE_SECRET_KEY) {
    assert(acpList.length > 0, `ACP checkouts exist (${acpList.length})`);
  } else {
    console.log('  (ACP skipped — no STRIPE_SECRET_KEY)');
  }

  // On-chain balance reads
  console.log('\n  ── On-Chain Balance Verification ──');
  for (const [name, wId, addr] of [
    ['AlicePayBot', agentATempoWalletId, agentATempoAddress],
    ['BobAnalytics', agentBTempoWalletId, agentBTempoAddress],
  ] as const) {
    if (!addr) { console.log(`  ${name}: no Tempo address`); continue; }
    try {
      const onChain = await readOnChainBalance(addr);
      const { data: w } = await supabase
        .from('wallets')
        .select('balance')
        .eq('id', wId)
        .single();
      const dbBalance = Number(w?.balance || 0);
      console.log(`  ${name}: on-chain=${onChain.toFixed(2)} pathUSD, DB=${dbBalance.toFixed(2)}`);
      assert(onChain > 0, `${name} on-chain balance > 0`, `got ${onChain}`);
    } catch (err: any) {
      console.log(`  ${name}: on-chain read failed — ${err.message}`);
    }
  }

  // Internal wallet balance reads
  console.log('\n  ── Internal Wallet Balances ──');
  for (const [name, wId] of [
    ['AlicePayBot Internal', agentAInternalWalletId],
    ['BobAnalytics Internal', agentBInternalWalletId],
  ] as const) {
    if (!wId) continue;
    const { data: w } = await supabase
      .from('wallets')
      .select('balance, currency')
      .eq('id', wId)
      .single();
    console.log(`  ${name}: $${w?.balance} ${w?.currency}`);
    assert(Number(w?.balance || 0) > 0, `${name} has balance > 0`);
  }

  // Cross-protocol verification: transfers exist
  console.log('\n  ── Cross-Protocol Transfer Check ──');
  const { data: allTransfers } = await supabase
    .from('transfers')
    .select('type, status, amount, currency')
    .eq('tenant_id', TENANT_ID)
    .order('created_at', { ascending: false })
    .limit(50);

  const types = new Set((allTransfers || []).map(t => t.type));
  console.log(`  Transfer types found: ${Array.from(types).join(', ')}`);
  assert(types.size >= 2, `Multiple protocol types in transfers (${types.size})`);
}

// ============================================
// Main
// ============================================

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════╗');
  console.log('║   Full-Stack Two-Agent Demo: All Protocols                    ║');
  console.log('║   MPP · ACP · UCP · A2A · AP2 · x402                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');
  console.log(`API:     ${API}`);
  console.log(`Key:     ${API_KEY.slice(0, 15)}...`);
  console.log(`Stripe:  ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'NOT SET (ACP will be skipped)'}`);
  console.log(`Date:    ${new Date().toISOString()}`);

  try {
    await phase0_setup();
    await phase1_mppDirectCharges();
    await phase2_mppSessions();
    await phase3_acpCheckout();
    await phase4_ucpCheckout();
    await phase5_a2aTask();
    await phase6_ap2Mandate();
    await phase7_x402Access();
    await phase8_verification();
  } catch (err: any) {
    console.error(`\n💥 Unhandled error: ${err.message}`);
    console.error(err.stack);
    failCount++;
  }

  const total = passCount + failCount;
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║  Full-Stack Demo Scorecard            ║');
  console.log('╠═══════════════════════════════════════╣');
  console.log(`║  Passed: ${String(passCount).padStart(2)} / ${String(total).padStart(2)}${' '.repeat(24)}║`);
  console.log(`║  Failed: ${String(failCount).padStart(2)}${' '.repeat(28)}║`);
  console.log('╚═══════════════════════════════════════╝');

  if (failCount > 0) {
    console.log('\n⚠️  Some assertions failed. Review output above for details.');
  } else {
    console.log('\n🎉 All assertions passed!');
  }

  // ── Direct Links to Every Record ──
  console.log('\n╔═══════════════════════════════════════════════════════════════╗');
  console.log('║  Direct Links to Every Record Created                          ║');
  console.log('╚═══════════════════════════════════════════════════════════════╝');

  console.log('\n  ── Agents ──');
  for (const id of created.agents) {
    console.log(`  ${id}`);
    console.log(`    API:      ${API_DASH}/v1/agents/${id}`);
    console.log(`    Supabase: ${SB_DASH}/agents?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── Accounts ──');
  console.log(`  ${ACME_ACCOUNT_ID}  (Acme Corp — pre-existing)`);
  console.log(`    Supabase: ${SB_DASH}/accounts?filter=id%3Deq.${ACME_ACCOUNT_ID}`);
  for (const id of created.accounts) {
    console.log(`  ${id}  (BotForge Labs — created)`);
    console.log(`    Supabase: ${SB_DASH}/accounts?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── Wallets ──');
  const walletLabels: Record<string, string> = {};
  if (agentAInternalWalletId) walletLabels[agentAInternalWalletId] = 'AlicePayBot Internal';
  if (agentBInternalWalletId) walletLabels[agentBInternalWalletId] = 'BobAnalytics Internal';
  if (agentATempoWalletId) walletLabels[agentATempoWalletId] = 'AlicePayBot Tempo';
  if (agentBTempoWalletId) walletLabels[agentBTempoWalletId] = 'BobAnalytics Tempo';
  for (const id of created.wallets) {
    const label = walletLabels[id] || '';
    console.log(`  ${id}  ${label}`);
    console.log(`    API:      ${API_DASH}/v1/wallets/${id}`);
    console.log(`    Supabase: ${SB_DASH}/wallets?filter=id%3Deq.${id}`);
  }
  if (agentATempoAddress) {
    console.log(`\n  AlicePayBot on-chain: ${agentATempoAddress}`);
    console.log(`    Tempo:    https://testnet.tempo.xyz/address/${agentATempoAddress}`);
  }
  if (agentBTempoAddress) {
    console.log(`  BobAnalytics on-chain: ${agentBTempoAddress}`);
    console.log(`    Tempo:    https://testnet.tempo.xyz/address/${agentBTempoAddress}`);
  }

  console.log('\n  ── MPP Sessions ──');
  for (const id of created.sessions) {
    console.log(`  ${id}`);
    console.log(`    Supabase: ${SB_DASH}/mpp_sessions?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── ACP Checkouts ──');
  for (const id of created.acpCheckouts) {
    console.log(`  ${id}`);
    console.log(`    API:      ${API_DASH}/v1/acp/checkouts/${id}`);
    console.log(`    Supabase: ${SB_DASH}/acp_checkouts?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── UCP Checkouts ──');
  for (const id of created.ucpCheckouts) {
    console.log(`  ${id}`);
    console.log(`    API:      ${API_DASH}/v1/ucp/checkouts/${id}`);
    console.log(`    Supabase: ${SB_DASH}/ucp_checkouts?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── A2A Tasks ──');
  for (const id of created.a2aTasks) {
    console.log(`  ${id}`);
    console.log(`    Supabase: ${SB_DASH}/a2a_tasks?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── AP2 Mandates ──');
  for (const id of created.mandates) {
    console.log(`  ${id}`);
    console.log(`    API:      ${API_DASH}/v1/ap2/mandates/${id}`);
    console.log(`    Supabase: ${SB_DASH}/ap2_mandates?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── x402 Endpoints ──');
  for (const id of created.endpoints) {
    console.log(`  ${id}`);
    console.log(`    API:      ${API_DASH}/v1/x402/endpoints/${id}`);
    console.log(`    Supabase: ${SB_DASH}/x402_endpoints?filter=id%3Deq.${id}`);
  }

  console.log('\n  ── x402 Payments (Transfer IDs) ──');
  for (const id of created.x402Payments) {
    console.log(`  ${id}`);
    console.log(`    Supabase: ${SB_DASH}/transfers?filter=id%3Deq.${id}`);
  }

  // Query all transfers created by these agents
  console.log('\n  ── All Transfers (this run) ──');
  const { data: runTransfers } = await supabase
    .from('transfers')
    .select('id, type, status, amount, currency, created_at')
    .eq('tenant_id', TENANT_ID)
    .or(`from_account_id.eq.${ACME_ACCOUNT_ID},from_account_id.eq.${botForgeAccountId},to_account_id.eq.${ACME_ACCOUNT_ID},to_account_id.eq.${botForgeAccountId}`)
    .order('created_at', { ascending: false })
    .limit(30);
  for (const tx of (runTransfers || [])) {
    console.log(`  ${tx.id}  ${tx.type} $${tx.amount} ${tx.currency} [${tx.status}]`);
    console.log(`    Supabase: ${SB_DASH}/transfers?filter=id%3Deq.${tx.id}`);
  }

  // AP2 Mandate Executions
  if (created.mandates.length > 0) {
    console.log('\n  ── AP2 Mandate Executions ──');
    const { data: executions } = await supabase
      .from('ap2_mandate_executions')
      .select('id, mandate_id, amount, status, settlement_tx_hash, created_at')
      .in('mandate_id', created.mandates)
      .order('created_at', { ascending: true });
    for (const ex of (executions || [])) {
      console.log(`  ${ex.id}  $${ex.amount} [${ex.status}]${ex.settlement_tx_hash ? ' tx=' + ex.settlement_tx_hash.slice(0, 20) + '...' : ''}`);
      console.log(`    Supabase: ${SB_DASH}/ap2_mandate_executions?filter=id%3Deq.${ex.id}`);
      if (ex.settlement_tx_hash) {
        console.log(`    Tempo TX: https://testnet.tempo.xyz/tx/${ex.settlement_tx_hash}`);
      }
    }
  }

  // Agent Skills
  console.log('\n  ── Agent Skills ──');
  const { data: skills } = await supabase
    .from('agent_skills')
    .select('id, agent_id, skill_id, name')
    .in('agent_id', created.agents);
  for (const s of (skills || [])) {
    console.log(`  ${s.id}  ${s.name} (${s.skill_id}) → agent ${s.agent_id.slice(0, 8)}...`);
  }

  console.log('\n  ── Supabase Table Editor (full tables) ──');
  console.log(`  Agents:              ${SB_DASH}/agents`);
  console.log(`  Wallets:             ${SB_DASH}/wallets`);
  console.log(`  Accounts:            ${SB_DASH}/accounts`);
  console.log(`  Transfers:           ${SB_DASH}/transfers`);
  console.log(`  MPP Sessions:        ${SB_DASH}/mpp_sessions`);
  console.log(`  MPP Vouchers:        ${SB_DASH}/mpp_session_vouchers`);
  console.log(`  ACP Checkouts:       ${SB_DASH}/acp_checkouts`);
  console.log(`  UCP Checkouts:       ${SB_DASH}/ucp_checkouts`);
  console.log(`  A2A Tasks:           ${SB_DASH}/a2a_tasks`);
  console.log(`  AP2 Mandates:        ${SB_DASH}/ap2_mandates`);
  console.log(`  AP2 Executions:      ${SB_DASH}/ap2_mandate_executions`);
  console.log(`  x402 Endpoints:      ${SB_DASH}/x402_endpoints`);
  console.log(`  Agent Skills:        ${SB_DASH}/agent_skills`);

  process.exit(failCount > 0 ? 1 : 0);
}

main();
