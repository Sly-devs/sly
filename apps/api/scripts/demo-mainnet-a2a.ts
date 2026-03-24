#!/usr/bin/env tsx
/**
 * A2A Mainnet Demo — 5 Real Transactions Between Two Agents
 *
 * Tests all 5 payment protocols on Base mainnet:
 * 1. Direct Wallet Transfer (on-chain)
 * 2. A2A Task with Payment
 * 3. AP2 Mandate + Execution
 * 4. x402 Micropayment
 * 5. MPP Session + Multi-charge
 *
 * Usage: pnpm --filter @sly/api tsx scripts/demo-mainnet-a2a.ts
 */

const API_URL = process.env.API_URL || 'http://localhost:4000';
const API_KEY = 'pk_live_demo_fintech_key_12345';

// Production agents
const MERIDIAN_AGENT_ID = 'e0e18b0a-c1d2-4959-a656-5c5ed7777582';
const AUSTRAL_AGENT_ID = '54e35f9e-ccc7-4a3d-8769-b3d808695489';

// Production wallets (Base mainnet, Circle custodial)
const MERIDIAN_WALLET_ID = '5bf1e826-8cb7-455f-a477-5f161feaffc4';
const AUSTRAL_WALLET_ID = 'ead0bca2-6740-4d1b-ae35-c23f3275c523';

// Parent accounts
const MERIDIAN_ACCOUNT_ID = '61766a16-3ad7-4e53-a04e-9d0b81a3cfce';
const AUSTRAL_ACCOUNT_ID = 'c5079e84-a685-4713-8a22-133d676173c1';

const headers = {
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
  'X-Environment': 'live',
};

async function api(method: string, path: string, body?: any) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok && res.status >= 400) {
    throw new Error(`${method} ${path} → ${res.status}: ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

function timer() {
  const start = Date.now();
  return () => `${Date.now() - start}ms`;
}

async function getBalances() {
  const [m, a] = await Promise.all([
    api('GET', `/v1/wallets/${MERIDIAN_WALLET_ID}/balance`),
    api('GET', `/v1/wallets/${AUSTRAL_WALLET_ID}/balance`),
  ]);
  return {
    meridian: m.data?.balance ?? m.balance ?? 0,
    austral: a.data?.balance ?? a.balance ?? 0,
  };
}

// ============================================================================
// Prerequisites
// ============================================================================

async function setup() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  A2A MAINNET DEMO — 5 REAL TRANSACTIONS');
  console.log('  Network: Base Mainnet | Currency: USDC');
  console.log('═══════════════════════════════════════════════════\n');

  // 1. Verify agents to KYA Tier 1
  console.log('📋 Step 1: Verifying agents to KYA Tier 1...');
  try {
    await api('POST', `/v1/agents/${MERIDIAN_AGENT_ID}/verify`, { tier: 1 });
    console.log('   ✓ Meridian → Tier 1');
  } catch (e: any) {
    console.log(`   ⚠ Meridian: ${e.message}`);
  }
  try {
    await api('POST', `/v1/agents/${AUSTRAL_AGENT_ID}/verify`, { tier: 1 });
    console.log('   ✓ Austral → Tier 1');
  } catch (e: any) {
    console.log(`   ⚠ Austral: ${e.message}`);
  }

  // 2. Print starting balances
  const bal = await getBalances();
  console.log(`\n💰 Starting Balances:`);
  console.log(`   Meridian: ${bal.meridian} USDC`);
  console.log(`   Austral:  ${bal.austral} USDC`);
  console.log('');
}

// ============================================================================
// Transaction 1: Direct Wallet Transfer (on-chain)
// ============================================================================

async function tx1_walletTransfer() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TX 1: Direct Wallet Transfer');
  console.log('Meridian → Austral: 0.10 USDC (on-chain via Circle)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t = timer();
  const result = await api('POST', `/v1/wallets/${MERIDIAN_WALLET_ID}/transfer`, {
    destinationWalletId: AUSTRAL_WALLET_ID,
    amount: 0.10,
    currency: 'USDC',
    reference: 'Demo TX1: Direct wallet transfer',
  });

  const data = result.data || result;
  console.log(`   ✓ Transfer ID: ${data.transferId}`);
  console.log(`   ✓ Settlement: ${data.settlement?.type || 'ledger'}`);
  console.log(`   ✓ Tx Hash: ${data.settlement?.txHash || 'n/a'}`);
  console.log(`   ⏱ Time: ${t()}`);

  const bal = await getBalances();
  console.log(`   💰 Meridian: ${bal.meridian} | Austral: ${bal.austral}\n`);
  return data;
}

// ============================================================================
// Transaction 2: A2A Task with Payment
// ============================================================================

async function tx2_a2aTaskPayment() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TX 2: A2A Task with Payment');
  console.log('Austral → Meridian: 0.05 USDC (task: get FX quote)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t = timer();
  const result = await api('POST', '/v1/a2a/tasks', {
    agent_id: MERIDIAN_AGENT_ID,
    message: {
      parts: [{ text: 'Get me a BRL/USD settlement quote for 1000 BRL' }],
    },
    payment: {
      amount: 0.05,
      currency: 'USDC',
      from_wallet_id: AUSTRAL_WALLET_ID,
      to_wallet_id: MERIDIAN_WALLET_ID,
    },
  });

  const data = result.data || result;
  console.log(`   ✓ Task ID: ${data.id}`);
  console.log(`   ✓ State: ${data.status?.state || data.state || 'submitted'}`);
  console.log(`   ✓ Payment: ${data.payment?.status || 'attached'}`);
  console.log(`   ⏱ Time: ${t()}`);

  const bal = await getBalances();
  console.log(`   💰 Meridian: ${bal.meridian} | Austral: ${bal.austral}\n`);
  return data;
}

// ============================================================================
// Transaction 3: AP2 Mandate + Execution
// ============================================================================

async function tx3_ap2Mandate() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TX 3: AP2 Mandate + Execution');
  console.log('Meridian authorizes Austral to draw 0.50 USDC');
  console.log('Austral executes: 0.10 USDC');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t = timer();

  // Create mandate
  const mandateId = `mandate-demo-${Date.now()}`;
  const mandate = await api('POST', '/v1/ap2/mandates', {
    mandate_id: mandateId,
    agent_id: AUSTRAL_AGENT_ID,
    account_id: MERIDIAN_ACCOUNT_ID,
    authorized_amount: 0.50,
    currency: 'USDC',
    mandate_type: 'payment',
    description: 'Demo TX3: AP2 mandate for procurement services',
  });

  const mData = mandate.data || mandate;
  console.log(`   ✓ Mandate created: ${mData.id || mandateId}`);
  console.log(`   ✓ Authorized: $${mData.authorized_amount || 0.50}`);

  // Execute mandate
  const execution = await api('POST', `/v1/ap2/mandates/${mData.id || mandateId}/execute`, {
    amount: 0.10,
    currency: 'USDC',
    description: 'Vendor payment for office supplies',
  });

  const eData = execution.data || execution;
  console.log(`   ✓ Execution: ${eData.execution_id || eData.id || 'completed'}`);
  console.log(`   ✓ Amount drawn: 0.10 USDC`);
  console.log(`   ⏱ Time: ${t()}`);

  const bal = await getBalances();
  console.log(`   💰 Meridian: ${bal.meridian} | Austral: ${bal.austral}\n`);
  return eData;
}

// ============================================================================
// Transaction 4: x402 Micropayment
// ============================================================================

async function tx4_x402Payment() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TX 4: x402 Micropayment');
  console.log('Austral pays Meridian: 0.05 USDC for API access');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t = timer();

  // Create x402 endpoint for Meridian
  let endpointId: string;
  try {
    const endpoint = await api('POST', '/v1/x402/endpoints', {
      name: 'Settlement Quote API',
      path: '/api/settlement/quote',
      method: 'POST',
      description: 'Get real-time FX settlement quote',
      accountId: MERIDIAN_ACCOUNT_ID,
      basePrice: 0.05,
      currency: 'USDC',
    });
    endpointId = endpoint.data?.id || endpoint.id;
    console.log(`   ✓ x402 Endpoint created: ${endpointId}`);
  } catch (e: any) {
    // May already exist from previous run
    console.log(`   ⚠ Endpoint: ${e.message}`);
    const endpoints = await api('GET', '/v1/x402/endpoints?account_id=' + MERIDIAN_ACCOUNT_ID);
    endpointId = endpoints.data?.[0]?.id;
    if (!endpointId) throw new Error('No x402 endpoint found');
    console.log(`   ✓ Using existing endpoint: ${endpointId}`);
  }

  // Pay for access
  const payment = await api('POST', '/v1/x402/pay', {
    endpointId,
    requestId: crypto.randomUUID(),
    walletId: AUSTRAL_WALLET_ID,
    amount: 0.05,
    currency: 'USDC',
    method: 'POST',
    path: '/api/settlement/quote',
    timestamp: Math.floor(Date.now() / 1000),
  });

  const pData = payment.data || payment;
  console.log(`   ✓ Payment: ${pData.status || 'completed'}`);
  console.log(`   ✓ JWT Proof: ${pData.jwt ? pData.jwt.substring(0, 30) + '...' : 'n/a'}`);
  console.log(`   ⏱ Time: ${t()}`);

  const bal = await getBalances();
  console.log(`   💰 Meridian: ${bal.meridian} | Austral: ${bal.austral}\n`);
  return pData;
}

// ============================================================================
// Transaction 5: MPP Session + Multiple Charges
// ============================================================================

async function tx5_mppSession() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('TX 5: MPP Session + 4 Micro-charges');
  console.log('Meridian opens session → 4 × 0.02 USDC charges');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const t = timer();

  // Open session
  const session = await api('POST', '/v1/mpp/sessions', {
    service_url: 'https://austral-procurement.example.com/api',
    deposit_amount: 0.10,
    max_budget: 0.10,
    agent_id: MERIDIAN_AGENT_ID,
    wallet_id: MERIDIAN_WALLET_ID,
    currency: 'USDC',
  });

  const sData = session.data || session;
  const sessionId = sData.id || sData.session_id;
  console.log(`   ✓ Session opened: ${sessionId}`);
  console.log(`   ✓ Budget: 0.10 USDC`);

  // 4 micro-charges
  for (let i = 1; i <= 4; i++) {
    try {
      const charge = await api('POST', '/v1/mpp/pay', {
        service_url: 'https://austral-procurement.example.com/api',
        amount: 0.02,
        currency: 'USDC',
        intent: `Micro-charge ${i}/4: vendor data lookup`,
        agent_id: MERIDIAN_AGENT_ID,
      });
      const cData = charge.data || charge;
      console.log(`   ✓ Charge ${i}/4: 0.02 USDC (${cData.receipt_id || cData.transfer_id || 'ok'})`);
    } catch (e: any) {
      console.log(`   ✗ Charge ${i}/4 failed: ${e.message}`);
    }
  }

  // Close session
  try {
    await api('POST', `/v1/mpp/sessions/${sessionId}/close`);
    console.log(`   ✓ Session closed`);
  } catch (e: any) {
    console.log(`   ⚠ Close: ${e.message}`);
  }

  console.log(`   ⏱ Time: ${t()}`);

  const bal = await getBalances();
  console.log(`   💰 Meridian: ${bal.meridian} | Austral: ${bal.austral}\n`);
  return sData;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    // Prerequisites
    await setup();

    // Run all 5 transactions
    console.log('\n🚀 Starting 5 transactions on Base Mainnet...\n');

    await tx1_walletTransfer();
    await tx2_a2aTaskPayment();
    await tx3_ap2Mandate();
    await tx4_x402Payment();
    await tx5_mppSession();

    // Final sync
    console.log('═══════════════════════════════════════════════════');
    console.log('  FINAL RESULTS');
    console.log('═══════════════════════════════════════════════════');

    // Sync from Circle
    await Promise.all([
      api('POST', `/v1/wallets/${MERIDIAN_WALLET_ID}/sync`),
      api('POST', `/v1/wallets/${AUSTRAL_WALLET_ID}/sync`),
    ]);

    const final = await getBalances();
    console.log(`\n   Meridian Final: ${final.meridian} USDC`);
    console.log(`   Austral Final:  ${final.austral} USDC`);
    console.log(`   Combined:       ${(Number(final.meridian) + Number(final.austral)).toFixed(4)} USDC`);
    console.log('\n✅ Demo complete! Check dashboard at http://localhost:3000/dashboard/transfers\n');

  } catch (error: any) {
    console.error('\n❌ Demo failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
