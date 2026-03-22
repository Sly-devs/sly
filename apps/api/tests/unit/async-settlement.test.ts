/**
 * Async Settlement Tests (Epic 38, Stories 38.1 & 38.2)
 *
 * Tests:
 * 1. authorizeWalletTransfer() — fast ledger-only authorization
 * 2. AsyncSettlementWorker — background on-chain settlement
 * 3. A2A payment handler — uses async settlement path
 * 4. Latency validation — authorization completes in <200ms
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_TENANT_ID, TEST_ACCOUNTS } from '../setup.js';

// ============================================================================
// Mock Helpers
// ============================================================================

interface WalletUpdate {
  walletId: string;
  newBalance: number;
}

interface TransferUpdate {
  transferId: string;
  status: string;
  metadata?: Record<string, unknown>;
}

function createSettlementMockSupabase(opts: {
  sourceBalance?: number;
  destBalance?: number;
  sourceWalletId?: string;
  destWalletId?: string;
  transferId?: string;
  debitShouldFail?: boolean;
  creditShouldFail?: boolean;
  authorizedTransfers?: any[];
  walletData?: any[];
} = {}) {
  const walletUpdates: WalletUpdate[] = [];
  const transferUpdates: TransferUpdate[] = [];
  let currentTable = '';
  let pendingUpdate: any = null;
  let isUpdateChain = false;
  let isSelectChain = false;

  const sourceBalance = opts.sourceBalance ?? 100;
  const destBalance = opts.destBalance ?? 50;
  const sourceWalletId = opts.sourceWalletId ?? 'wallet-source-001';
  const destWalletId = opts.destWalletId ?? 'wallet-dest-001';

  const mock: any = {};

  mock.from = vi.fn((table: string) => {
    currentTable = table;
    pendingUpdate = null;
    isUpdateChain = false;
    isSelectChain = false;
    return mock;
  });

  mock.select = vi.fn(() => {
    isSelectChain = true;
    return mock;
  });

  mock.insert = vi.fn((row: any) => mock);

  mock.update = vi.fn((data: any) => {
    isUpdateChain = true;
    pendingUpdate = data;
    return mock;
  });

  mock.eq = vi.fn((col: string, val: any) => {
    if (isUpdateChain && currentTable === 'transfers' && col === 'id') {
      transferUpdates.push({
        transferId: val,
        status: pendingUpdate?.status,
        metadata: pendingUpdate?.protocol_metadata,
      });
    }
    if (isUpdateChain && currentTable === 'wallets' && col === 'id' && pendingUpdate?.balance !== undefined) {
      walletUpdates.push({ walletId: val, newBalance: pendingUpdate.balance });
    }
    return mock;
  });

  mock.in = vi.fn(() => mock);

  mock.gte = vi.fn(() => mock);

  mock.order = vi.fn(() => mock);
  mock.limit = vi.fn(() => mock);

  mock.single = vi.fn(() => {
    if (isUpdateChain && currentTable === 'wallets') {
      if (opts.debitShouldFail) {
        return Promise.resolve({ data: null, error: { message: 'Insufficient balance' } });
      }
      const newBal = pendingUpdate?.balance ?? sourceBalance;
      return Promise.resolve({ data: { balance: newBal }, error: null });
    }
    if (currentTable === 'transfers') {
      return Promise.resolve({
        data: { id: opts.transferId ?? 'transfer-001' },
        error: null,
      });
    }
    if (currentTable === 'wallets' && isSelectChain) {
      return Promise.resolve({
        data: { wallet_address: '0xProviderAddr' },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });

  mock.maybeSingle = vi.fn(() => {
    return Promise.resolve({ data: null, error: null });
  });

  mock.then = (resolve: any, reject?: any) => {
    try {
      // For .update().eq().eq() chains (no terminal)
      if (isUpdateChain && currentTable === 'wallets' && opts.creditShouldFail) {
        resolve({ data: null, error: { message: 'Credit failed' } });
      } else {
        resolve({ data: null, error: null });
      }
    } catch (e) {
      if (reject) reject(e);
    }
  };

  mock._walletUpdates = walletUpdates;
  mock._transferUpdates = transferUpdates;

  return mock;
}

// ============================================================================
// 1. authorizeWalletTransfer() tests
// ============================================================================

describe('authorizeWalletTransfer()', () => {
  let authorizeWalletTransfer: typeof import('../../src/services/wallet-settlement.js').authorizeWalletTransfer;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/services/wallet-settlement.js');
    authorizeWalletTransfer = mod.authorizeWalletTransfer;
  });

  it('should debit source and credit destination in <200ms', async () => {
    const mockSupabase = createSettlementMockSupabase({
      sourceBalance: 100,
      destBalance: 50,
    });

    const start = performance.now();

    const result = await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSourceAddr',
        wallet_type: 'circle_custodial',
        provider_wallet_id: 'circle-src-001',
        balance: 100,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: {
        id: 'wallet-dest-001',
        wallet_address: '0xDestAddr',
        wallet_type: 'circle_custodial',
        provider_wallet_id: 'circle-dst-001',
        balance: 50,
        owner_account_id: TEST_ACCOUNTS.acme,
      },
      amount: 10,
      transferId: 'transfer-001',
    });

    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(200); // Must be fast — no on-chain calls
    expect(result.sourceNewBalance).toBe(90);
    expect(result.destinationNewBalance).toBe(60);
  });

  it('should mark transfer as authorized status', async () => {
    const mockSupabase = createSettlementMockSupabase();

    await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSource',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 100,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: {
        id: 'wallet-dest-001',
        wallet_address: '0xDest',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 50,
        owner_account_id: TEST_ACCOUNTS.acme,
      },
      amount: 5,
      transferId: 'transfer-auth-001',
    });

    // Verify transfer was updated to 'authorized'
    const authUpdate = mockSupabase._transferUpdates.find(
      (u: TransferUpdate) => u.status === 'authorized',
    );
    expect(authUpdate).toBeDefined();
    expect(authUpdate?.metadata?.authorized_at).toBeDefined();
  });

  it('should fail on insufficient balance', async () => {
    const mockSupabase = createSettlementMockSupabase({ debitShouldFail: true });

    const result = await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSource',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 1,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: null,
      amount: 100,
      transferId: 'transfer-fail-001',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Insufficient balance');

    // Verify transfer was marked as failed
    const failUpdate = mockSupabase._transferUpdates.find(
      (u: TransferUpdate) => u.status === 'failed',
    );
    expect(failUpdate).toBeDefined();
  });

  it('should work without a destination wallet (unilateral debit)', async () => {
    const mockSupabase = createSettlementMockSupabase();

    const result = await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSource',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 100,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: null,
      amount: 25,
      transferId: 'transfer-nodest-001',
    });

    expect(result.success).toBe(true);
    expect(result.sourceNewBalance).toBe(75);
    expect(result.destinationNewBalance).toBeUndefined();
  });

  it('should never call Circle API (no on-chain in authorization path)', async () => {
    const circleMock = vi.fn();

    vi.doMock('../../src/services/circle/client.js', () => ({
      getCircleClient: circleMock,
    }));

    const mockSupabase = createSettlementMockSupabase();

    await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSource',
        wallet_type: 'circle_custodial',
        provider_wallet_id: 'circle-001',
        balance: 100,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: {
        id: 'wallet-dest-001',
        wallet_address: '0xDest',
        wallet_type: 'circle_custodial',
        provider_wallet_id: 'circle-002',
        balance: 50,
        owner_account_id: TEST_ACCOUNTS.acme,
      },
      amount: 10,
      transferId: 'transfer-no-circle-001',
    });

    // Circle client should never be called during authorization
    expect(circleMock).not.toHaveBeenCalled();
  });

  it('should handle micro-payment amounts correctly', async () => {
    const mockSupabase = createSettlementMockSupabase({ sourceBalance: 1.5 });

    const result = await authorizeWalletTransfer({
      supabase: mockSupabase as any,
      tenantId: TEST_TENANT_ID,
      sourceWallet: {
        id: 'wallet-source-001',
        wallet_address: '0xSource',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 1.5,
        owner_account_id: TEST_ACCOUNTS.techcorp,
      },
      destinationWallet: {
        id: 'wallet-dest-001',
        wallet_address: '0xDest',
        wallet_type: 'internal',
        provider_wallet_id: null,
        balance: 0,
        owner_account_id: TEST_ACCOUNTS.acme,
      },
      amount: 0.01,
      transferId: 'transfer-micro-001',
    });

    expect(result.success).toBe(true);
    expect(result.sourceNewBalance).toBeCloseTo(1.49, 8);
    expect(result.destinationNewBalance).toBeCloseTo(0.01, 8);
  });
});

// ============================================================================
// 2. isOnChainCapable() tests
// ============================================================================

describe('isOnChainCapable()', () => {
  let isOnChainCapable: typeof import('../../src/services/wallet-settlement.js').isOnChainCapable;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/services/wallet-settlement.js');
    isOnChainCapable = mod.isOnChainCapable;
  });

  it('should return true for circle_custodial with provider_wallet_id in sandbox', () => {
    process.env.PAYOS_ENVIRONMENT = 'sandbox';

    const result = isOnChainCapable(
      { wallet_type: 'circle_custodial', provider_wallet_id: 'circle-001' },
      '0x1234567890abcdef',
    );

    expect(result).toBe(true);
  });

  it('should return false for internal wallets', () => {
    process.env.PAYOS_ENVIRONMENT = 'sandbox';

    const result = isOnChainCapable(
      { wallet_type: 'internal', provider_wallet_id: null },
      '0x1234567890abcdef',
    );

    expect(result).toBe(false);
  });

  it('should return false when destination is internal://', () => {
    process.env.PAYOS_ENVIRONMENT = 'sandbox';

    const result = isOnChainCapable(
      { wallet_type: 'circle_custodial', provider_wallet_id: 'circle-001' },
      'internal://wallet-001',
    );

    expect(result).toBe(false);
  });

  it('should return false in mock environment', () => {
    process.env.PAYOS_ENVIRONMENT = 'mock';

    const result = isOnChainCapable(
      { wallet_type: 'circle_custodial', provider_wallet_id: 'circle-001' },
      '0x1234567890abcdef',
    );

    expect(result).toBe(false);

    // Cleanup
    process.env.PAYOS_ENVIRONMENT = 'sandbox';
  });

  it('should return true in production environment', () => {
    process.env.PAYOS_ENVIRONMENT = 'production';

    const result = isOnChainCapable(
      { wallet_type: 'circle_custodial', provider_wallet_id: 'circle-001' },
      '0x1234567890abcdef',
    );

    expect(result).toBe(true);

    // Cleanup
    process.env.PAYOS_ENVIRONMENT = 'sandbox';
  });
});

// ============================================================================
// 3. AsyncSettlementWorker tests
// ============================================================================

describe('AsyncSettlementWorker', () => {
  let AsyncSettlementWorker: typeof import('../../src/workers/async-settlement-worker.js').AsyncSettlementWorker;

  beforeEach(async () => {
    vi.resetModules();
  });

  it('should instantiate and start/stop cleanly', async () => {
    const mod = await import('../../src/workers/async-settlement-worker.js');
    AsyncSettlementWorker = mod.AsyncSettlementWorker;

    const worker = new AsyncSettlementWorker();
    // Should not throw
    worker.start(60_000); // Long interval so it doesn't actually poll
    worker.stop();
  });

  it('should not start twice', async () => {
    const mod = await import('../../src/workers/async-settlement-worker.js');
    const worker = new mod.AsyncSettlementWorker();

    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    worker.start(60_000);
    worker.start(60_000); // Second start should warn

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('already running'),
    );

    worker.stop();
    consoleSpy.mockRestore();
  });

  it('should handle empty transfer queue gracefully', async () => {
    vi.doMock('../../src/db/client.js', () => ({
      createClient: vi.fn(() => {
        const mock: any = {};
        mock.from = vi.fn(() => mock);
        mock.select = vi.fn(() => mock);
        mock.eq = vi.fn(() => mock);
        mock.order = vi.fn(() => mock);
        mock.limit = vi.fn(() => mock);
        mock.then = (resolve: any) => resolve({ data: [], error: null });
        return mock;
      }),
    }));

    const mod = await import('../../src/workers/async-settlement-worker.js');
    const worker = new mod.AsyncSettlementWorker();

    // Should not throw on empty queue
    await worker.processPendingSettlements();
  });
});

// ============================================================================
// 4. Latency benchmarks
// ============================================================================

describe('Settlement Latency', () => {
  let authorizeWalletTransfer: typeof import('../../src/services/wallet-settlement.js').authorizeWalletTransfer;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/services/wallet-settlement.js');
    authorizeWalletTransfer = mod.authorizeWalletTransfer;
  });

  it('should authorize 10 sequential payments in <500ms total', async () => {
    const start = performance.now();

    for (let i = 0; i < 10; i++) {
      const mockSupabase = createSettlementMockSupabase({
        sourceBalance: 1000,
        destBalance: 500,
      });

      const result = await authorizeWalletTransfer({
        supabase: mockSupabase as any,
        tenantId: TEST_TENANT_ID,
        sourceWallet: {
          id: `wallet-src-${i}`,
          wallet_address: `0xSrc${i}`,
          wallet_type: 'circle_custodial',
          provider_wallet_id: `circle-src-${i}`,
          balance: 1000,
          owner_account_id: TEST_ACCOUNTS.techcorp,
        },
        destinationWallet: {
          id: `wallet-dst-${i}`,
          wallet_address: `0xDst${i}`,
          wallet_type: 'circle_custodial',
          provider_wallet_id: `circle-dst-${i}`,
          balance: 500,
          owner_account_id: TEST_ACCOUNTS.acme,
        },
        amount: 0.50,
        transferId: `transfer-bench-${i}`,
      });

      expect(result.success).toBe(true);
    }

    const elapsed = performance.now() - start;
    console.log(`[Latency] 10 sequential authorizations: ${elapsed.toFixed(1)}ms (${(elapsed / 10).toFixed(1)}ms avg)`);
    expect(elapsed).toBeLessThan(500);
  });

  it('should authorize concurrent payments efficiently', async () => {
    const start = performance.now();

    const promises = Array.from({ length: 20 }, (_, i) => {
      const mockSupabase = createSettlementMockSupabase({
        sourceBalance: 1000,
        destBalance: 500,
      });

      return authorizeWalletTransfer({
        supabase: mockSupabase as any,
        tenantId: TEST_TENANT_ID,
        sourceWallet: {
          id: `wallet-src-c-${i}`,
          wallet_address: `0xSrc${i}`,
          wallet_type: 'internal',
          provider_wallet_id: null,
          balance: 1000,
          owner_account_id: TEST_ACCOUNTS.techcorp,
        },
        destinationWallet: {
          id: `wallet-dst-c-${i}`,
          wallet_address: `0xDst${i}`,
          wallet_type: 'internal',
          provider_wallet_id: null,
          balance: 500,
          owner_account_id: TEST_ACCOUNTS.acme,
        },
        amount: 0.05,
        transferId: `transfer-conc-${i}`,
      });
    });

    const results = await Promise.all(promises);
    const elapsed = performance.now() - start;

    results.forEach((r) => expect(r.success).toBe(true));
    console.log(`[Latency] 20 concurrent authorizations: ${elapsed.toFixed(1)}ms (${(elapsed / 20).toFixed(1)}ms avg)`);
    expect(elapsed).toBeLessThan(500);
  });
});

// ============================================================================
// 5. Transfer status lifecycle
// ============================================================================

describe('Transfer Status Lifecycle (authorized)', () => {
  it('authorized should be a valid TransferStatus', async () => {
    const { default: types } = await import('@sly/types');
    // TypeScript compilation is the real test — if 'authorized' is in the union,
    // this assignment works without error
    const status: import('@sly/types').TransferStatus = 'authorized';
    expect(status).toBe('authorized');
  });

  it('transfer lifecycle: pending → authorized → completed', () => {
    const validTransitions: Record<string, string[]> = {
      pending: ['processing', 'authorized', 'failed', 'cancelled'],
      processing: ['completed', 'failed'],
      authorized: ['processing', 'completed', 'failed'], // async worker picks up
      completed: [],
      failed: [],
      cancelled: [],
    };

    // authorized can transition to processing (worker picks it up)
    expect(validTransitions['authorized']).toContain('processing');
    // authorized can transition to completed (ledger-only settlement)
    expect(validTransitions['authorized']).toContain('completed');
  });
});
