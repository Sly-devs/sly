#!/usr/bin/env tsx
/**
 * Creates a single A2A session where the service fee is paid in pathUSD
 * from a Tempo wallet — no internal USDC wallet involved.
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { createPublicClient, createWalletClient, http, defineChain, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const API = process.env.SLY_URL || 'http://localhost:4000';
const API_KEY = process.env.SLY_API_KEY || 'pk_test_demo_fintech_key_12345';
const TENANT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ACME_ACCOUNT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string,
);

const TEMPO = defineChain({
  id: 42431,
  name: 'Tempo Testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.moderato.tempo.xyz'] } },
});
const PATH_USD = '0x20c0000000000000000000000000000000000000' as `0x${string}`;
const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const;

const masterAccount = privateKeyToAccount(process.env.MPP_PRIVATE_KEY as `0x${string}`);
const publicClient = createPublicClient({ chain: TEMPO, transport: http() });
const walletClient = createWalletClient({ account: masterAccount, chain: TEMPO, transport: http() });

async function apiPostRaw(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<any>;
}

function unwrap(res: any): any {
  if (res && typeof res === 'object' && 'success' in res && 'data' in res) return res.data;
  return res;
}

async function apiPost(path: string, body: Record<string, unknown>) {
  return unwrap(await apiPostRaw(path, body));
}

async function jsonRpc(agentId: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${API}/a2a/${agentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: `req-${Date.now()}` }),
  });
  return res.json() as Promise<any>;
}

async function main() {
  console.log('=== Creating pathUSD-only A2A session ===\n');

  // 1. Create caller agent — NO internal wallet, only Tempo
  console.log('Creating caller agent (TempoAlice)...');
  const callerRaw = await apiPostRaw('/v1/agents', {
    accountId: ACME_ACCOUNT_ID,
    name: `TempoAlice-pathUSD-${Date.now()}`,
    description: 'Caller agent that pays in pathUSD via Tempo wallet',
    auto_create_wallet: false,
  });
  const callerOuter = callerRaw?.data || callerRaw;
  const callerData = callerOuter?.data || callerOuter;
  const callerId = callerData?.id;
  console.log(`  Caller: ${callerId}`);

  // 2. Create provider account + agent — NO internal wallet
  const providerAcctId = randomUUID();
  await supabase.from('accounts').insert({
    id: providerAcctId,
    tenant_id: TENANT_ID,
    name: 'PathUSD Research Co',
    type: 'business',
    email: `pathusd-${Date.now()}@demo.sly.dev`,
    verification_tier: 1,
    verification_status: 'verified',
    verification_type: 'kyb',
  });

  console.log('Creating provider agent (TempoBob)...');
  const providerRaw = await apiPostRaw('/v1/agents', {
    accountId: providerAcctId,
    name: `TempoBob-pathUSD-${Date.now()}`,
    description: 'Provider agent that charges pathUSD for research',
    auto_create_wallet: false,
  });
  const providerOuter = providerRaw?.data || providerRaw;
  const providerData = providerOuter?.data || providerOuter;
  const providerId = providerData?.id;
  console.log(`  Provider: ${providerId}`);

  // 3. KYA verify both
  await apiPost(`/v1/agents/${callerId}/verify`, { tier: 1 });
  await apiPost(`/v1/agents/${providerId}/verify`, { tier: 1 });
  console.log('  Both KYA verified tier 1');

  // 4. Provision Tempo wallets (ONLY wallets for these agents)
  console.log('\nProvisioning Tempo-only wallets...');
  const tempoA = await apiPost('/v1/mpp/wallets/provision', {
    agent_id: callerId,
    owner_account_id: ACME_ACCOUNT_ID,
    testnet: true,
    initial_balance: 0,
  });
  const walletAData = tempoA?.data || tempoA;
  const callerWalletId = walletAData?.id;
  const callerAddr = walletAData?.address || walletAData?.wallet_address;
  console.log(`  Caller Tempo: ${callerWalletId}  addr: ${callerAddr}`);

  const tempoB = await apiPost('/v1/mpp/wallets/provision', {
    agent_id: providerId,
    owner_account_id: providerAcctId,
    testnet: true,
    initial_balance: 0,
  });
  const walletBData = tempoB?.data || tempoB;
  const providerWalletId = walletBData?.id;
  const providerAddr = walletBData?.address || walletBData?.wallet_address;
  console.log(`  Provider Tempo: ${providerWalletId}  addr: ${providerAddr}`);

  // 5. Fund on-chain: 25 pathUSD each
  console.log('\nFunding on-chain (25 pathUSD each)...');
  for (const [name, addr] of [['Caller', callerAddr], ['Provider', providerAddr]] as const) {
    const hash = await walletClient.writeContract({
      address: PATH_USD,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [addr as `0x${string}`, parseUnits('25', 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ${name}: 25 pathUSD sent (tx: ${hash.slice(0, 22)}...)`);
  }

  // Also fund DB ledger
  for (const [wId, acctId] of [[callerWalletId, ACME_ACCOUNT_ID], [providerWalletId, providerAcctId]] as const) {
    await apiPost(`/v1/wallets/${wId}/deposit`, { fromAccountId: acctId, amount: 25 });
  }
  console.log('  DB ledger funded (25 pathUSD each)');

  // 6. Seed pathUSD skills on provider
  console.log('\nSeeding pathUSD skills...');
  await supabase.from('agent_skills').upsert([
    {
      tenant_id: TENANT_ID,
      agent_id: providerId,
      skill_id: 'research',
      name: 'LATAM Research (pathUSD)',
      description: 'Payment corridor research charged in pathUSD',
      base_price: 3.00,
      currency: 'pathUSD',
      tags: ['research', 'pathusd'],
      input_modes: ['text'],
      output_modes: ['text', 'data'],
      status: 'active',
    },
    {
      tenant_id: TENANT_ID,
      agent_id: providerId,
      skill_id: 'agent_info',
      name: 'Agent Info',
      description: 'Agent capabilities',
      base_price: 0,
      currency: 'pathUSD',
      tags: ['info'],
      input_modes: ['text'],
      output_modes: ['text'],
      status: 'active',
    },
  ], { onConflict: 'tenant_id,agent_id,skill_id' });
  console.log('  research skill: 3.00 pathUSD');

  // 7. Set managed processing mode
  for (const [id, name] of [[callerId, 'TempoAlice'], [providerId, 'TempoBob']] as const) {
    await supabase
      .from('agents')
      .update({
        processing_mode: 'managed',
        processing_config: {
          model: 'regex',
          systemPrompt: `You are ${name}. Process requests and respond.`,
        },
      })
      .eq('id', id)
      .eq('tenant_id', TENANT_ID);
  }
  console.log('  Both set to managed processing');

  // 8. Send A2A task: caller → provider
  console.log('\nSending A2A task (will charge 3.00 pathUSD service fee)...');
  const rpc = await jsonRpc(providerId, 'message/send', {
    message: {
      role: 'user',
      parts: [{ text: 'Research Brazil-Mexico stablecoin corridor for pathUSD remittances. Include volume estimates and key corridors.' }],
      metadata: { callerAgentId: callerId },
    },
  });

  const taskId = rpc.result?.id;
  console.log(`  Task created: ${taskId}`);

  if (!taskId) {
    console.log(`  ERROR: ${JSON.stringify(rpc).slice(0, 300)}`);
    process.exit(1);
  }

  // 9. Process task
  console.log('  Processing...');
  const processRes = await fetch(`${API}/v1/a2a/tasks/${taskId}/process`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: '{}',
  });
  console.log(`  Process response: HTTP ${processRes.status}`);

  await new Promise((r) => setTimeout(r, 3000));

  // 10. Fetch final state
  const finalRpc = await jsonRpc(providerId, 'tasks/get', { id: taskId });
  const task = finalRpc.result;
  console.log(`  Task state: ${task?.status?.state}`);

  // 11. Check transfers — should show pathUSD
  const { data: transfers } = await supabase
    .from('transfers')
    .select('id, amount, currency, type, status, description, protocol_metadata')
    .eq('tenant_id', TENANT_ID)
    .eq('initiated_by_id', providerId)
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('\n=== Transfers (pathUSD) ===');
  for (const tx of transfers || []) {
    console.log(`  ${tx.id}  ${tx.amount} ${tx.currency} [${tx.status}] ${tx.description}`);
  }

  // 12. Audit events
  const { data: auditEvents } = await supabase
    .from('a2a_audit_events')
    .select('event_type, data')
    .eq('task_id', taskId)
    .eq('event_type', 'payment');

  console.log('\n=== A2A Payment Audit Events ===');
  for (const ev of auditEvents || []) {
    console.log(`  ${ev.event_type}: ${JSON.stringify(ev.data)}`);
  }

  // 13. Check provider wallet balance
  const { data: provWallet } = await supabase
    .from('wallets')
    .select('balance, currency')
    .eq('id', providerWalletId)
    .single();
  console.log(`\n  Provider wallet: ${provWallet?.balance} ${provWallet?.currency} (expected ~22 after 3.00 fee)`);

  // Print links
  const SB = 'https://supabase.com/dashboard/project/lgsreshwntpdrthfgwos/editor';
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  Dashboard Links                                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`  A2A Task:        http://localhost:3000/dashboard/agents/a2a/tasks/${taskId}`);
  console.log(`  Caller Agent:    http://localhost:3000/dashboard/agents/${callerId}`);
  console.log(`  Provider Agent:  http://localhost:3000/dashboard/agents/${providerId}`);
  console.log(`  Caller Wallet:   http://localhost:3000/dashboard/wallets/${callerWalletId}`);
  console.log(`  Provider Wallet: http://localhost:3000/dashboard/wallets/${providerWalletId}`);
  console.log(`  Caller Tempo:    https://testnet.tempo.xyz/address/${callerAddr}`);
  console.log(`  Provider Tempo:  https://testnet.tempo.xyz/address/${providerAddr}`);
  console.log(`\n  Supabase:`);
  console.log(`  Task:     ${SB}/a2a_tasks?filter=id%3Deq.${taskId}`);
  console.log(`  Wallets:  ${SB}/wallets?filter=managed_by_agent_id%3Din.(${callerId},${providerId})`);
  if (transfers?.length) {
    console.log(`  Transfer: ${SB}/transfers?filter=id%3Deq.${transfers[0].id}`);
    console.log(`  Transfer (dashboard): http://localhost:3000/dashboard/transfers/${transfers[0].id}`);
  }

  console.log('\n✅ A2A session with pathUSD Tempo payment created');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
