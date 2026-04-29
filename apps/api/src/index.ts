import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { getScheduledTransferWorker } from './workers/scheduled-transfers.js';
import { startIdempotencyCleanupWorker } from './workers/idempotency-cleanup.js';
import { startX402ExpiredCleanupWorker } from './workers/x402-expired-cleanup.js';
import { startScopeExpirationSweeper } from './workers/scope-expiration-sweeper.js';
import { startScopeHeartbeatWorker } from './workers/scope-heartbeat.js';
import { startAutoRefillWorker } from './workers/agent-auto-refill.js';
import { startAgentEoaSyncWorker, stopAgentEoaSyncWorker } from './workers/agent-eoa-sync.js';
import { webhookCleanupWorker } from './workers/webhook-cleanup.js';
import { SettlementWindowProcessor } from './workers/settlement-window-processor.js';
import { TreasuryWorker } from './workers/treasury-worker.js';
import { getA2ATaskWorker } from './workers/a2a-task-worker.js';
import { getAsyncSettlementWorker } from './workers/async-settlement-worker.js';
import { getBatchSettlementWorker } from './workers/batch-settlement-worker.js';
import { getReviewTimeoutWorker } from './workers/review-timeout-worker.js';
import { environmentManager } from './config/environment.js';
import { loadHandlersFromDB } from './services/ucp/payment-handlers/index.js';
import { createClient } from './db/client.js';
import { startOpTracker, stopOpTracker } from './services/ops/track-op.js';
import { startRequestCounter, stopRequestCounter } from './services/ops/request-counter.js';
import { startPartitionManager, stopPartitionManager } from './workers/partition-manager.js';
import { taskEventBus } from './services/a2a/task-event-bus.js';
import { startSmartWalletSyncWorker, stopSmartWalletSyncWorker } from './workers/smart-wallet-sync.js';
import { startConnectionCleanupWorker, stopConnectionCleanupWorker } from './workers/agent-connection-cleanup.js';
import { startTaskBridge, stopTaskBridge } from './services/agent-auth/task-bridge.js';
import { getX402PublishPoller } from './workers/x402-publish-poller.js';

// Railway uses PORT, fallback to API_PORT for local dev
const port = parseInt(process.env.PORT || process.env.API_PORT || '4000');
// Railway expects 0.0.0.0 (all interfaces), not localhost
// Only use API_HOST if explicitly set (for local dev)
const host = process.env.API_HOST || '0.0.0.0';
const enableScheduledTransfers = process.env.ENABLE_SCHEDULED_TRANSFERS === 'true';
const mockMode = process.env.MOCK_SCHEDULED_TRANSFERS === 'true' || process.env.NODE_ENV === 'development';
const enableWebhookCleanup = process.env.ENABLE_WEBHOOK_CLEANUP !== 'false'; // Enabled by default
const enableSettlementWindows = process.env.ENABLE_SETTLEMENT_WINDOWS !== 'false'; // Enabled by default
const enableTreasuryWorker = process.env.ENABLE_TREASURY_WORKER !== 'false'; // Enabled by default
const enableA2AWorker = process.env.ENABLE_A2A_WORKER !== 'false'; // Enabled by default
const enableAsyncSettlement = process.env.ENABLE_ASYNC_SETTLEMENT !== 'false'; // Enabled by default
const enableBatchSettlement = process.env.ENABLE_BATCH_SETTLEMENT !== 'false'; // Enabled by default
const enableReviewTimeout = process.env.ENABLE_REVIEW_TIMEOUT !== 'false'; // Enabled by default
const enableAutoRefill = process.env.ENABLE_AGENT_AUTO_REFILL !== 'false'; // Enabled by default
const enableX402PublishPoller = process.env.ENABLE_X402_PUBLISH_POLLER !== 'false'; // Enabled by default

console.log(`
╔══════════════════════════════════════════════════╗
║              PayOS API Server                    ║
╠══════════════════════════════════════════════════╣
║  🚀 Starting on http://${host}:${port}               ║
║  📚 Health: http://${host}:${port}/health            ║
║  🔒 NODE_ENV: ${(process.env.NODE_ENV || 'development').padEnd(23)}║
╠══════════════════════════════════════════════════╣
║  Workers:                                        ║
║  ⚙️  Scheduled Transfers: ${(enableScheduledTransfers ? (mockMode ? 'MOCK' : 'REAL') : 'OFF').padEnd(22)}║
║  🧹 Webhook Cleanup: ${(enableWebhookCleanup ? 'ON' : 'OFF').padEnd(26)}║
║  ⏱️  Settlement Windows: ${(enableSettlementWindows ? 'ON' : 'OFF').padEnd(23)}║
║  💰 Treasury Sync: ${(enableTreasuryWorker ? 'ON' : 'OFF').padEnd(28)}║
║  🤖 A2A Task Worker: ${(enableA2AWorker ? 'ON' : 'OFF').padEnd(25)}║
║  ⚡ Async Settlement: ${(enableAsyncSettlement ? 'ON' : 'OFF').padEnd(24)}║
║  📦 Batch Settlement: ${(enableBatchSettlement ? 'ON' : 'OFF').padEnd(23)}║
║  ✅ Review Timeout: ${(enableReviewTimeout ? 'ON' : 'OFF').padEnd(26)}║
║  💧 Agent Auto-Refill: ${(enableAutoRefill ? 'ON' : 'OFF').padEnd(23)}║
║  📊 Ops Tracker: ON                             ║
╚══════════════════════════════════════════════════╝
`);

// Log environment configuration (Story 40.28)
environmentManager.logStartupInfo();

// Start operation tracker, request counter, & partition manager (Epic 65)
startOpTracker();
startRequestCounter();
startPartitionManager();

// Initialize A2A audit persistence (Story 58.17)
taskEventBus.initAuditPersistence(createClient());

// Load DB-driven payment handlers
loadHandlersFromDB(createClient()).catch((err) => {
  console.error('⚠️  Failed to load payment handlers from DB:', err.message);
  console.log('   Falling back to code-only handlers (PayOS)');
});

// Start scheduled transfer worker (only if enabled)
let worker: ReturnType<typeof getScheduledTransferWorker> | null = null;
if (enableScheduledTransfers) {
  worker = getScheduledTransferWorker(mockMode);
  const workerInterval = mockMode ? 30000 : 60000; // 30s in mock mode, 1min in real mode
  worker.start(workerInterval);
} else {
  console.log('⚠️  Scheduled transfer worker is DISABLED. Set ENABLE_SCHEDULED_TRANSFERS=true to enable.');
}

// Start idempotency cleanup worker (runs every hour)
const stopIdempotencyCleanup = startIdempotencyCleanupWorker(60 * 60 * 1000);

// Start x402 expired-auth cleanup (runs every 2 min — cancels pending
// external x402 rows whose valid_before window has passed so they don't
// pile up as "pending forever" in the dashboard).
const stopX402ExpiredCleanup = startX402ExpiredCleanupWorker(2 * 60 * 1000);

// Epic 82 — sweep expired scope grants every 5 min. The middleware
// already filters by expires_at > now() so unswept rows never
// authorize requests; this sweep is for accuracy of stored state and
// audit completeness (each expiration writes a scope_expired row).
const stopScopeExpirationSweeper = startScopeExpirationSweeper(5 * 60 * 1000);

// Epic 82 Story 82.8 — emit a daily heartbeat per active standing
// grant so long-lived elevations stay visible in the audit feed.
// Hourly tick: fresh grants get their first heartbeat within ~1h,
// subsequent ones every ~24h.
const stopScopeHeartbeatWorker = startScopeHeartbeatWorker(60 * 60 * 1000);

// Start smart wallet balance sync worker (syncs on-chain balances every 5 min)
startSmartWalletSyncWorker();

// Start agent EOA balance sync worker — keeps dashboard USDC balances
// fresh for on-chain signing addresses without requiring a page load.
startAgentEoaSyncWorker();

// Start webhook cleanup worker (runs daily) - Story 27.5
if (enableWebhookCleanup) {
  webhookCleanupWorker.start().catch((error) => {
    console.error('❌ Failed to start webhook cleanup worker:', error);
  });
}

// Start settlement window processor - Story 27.4
let settlementWindowProcessor: SettlementWindowProcessor | null = null;
if (enableSettlementWindows) {
  settlementWindowProcessor = new SettlementWindowProcessor();
  settlementWindowProcessor.start().catch((error) => {
    console.error('❌ Failed to start settlement window processor:', error);
  });
}

// Start treasury worker - Story 27.7
let treasuryWorker: TreasuryWorker | null = null;
if (enableTreasuryWorker) {
  treasuryWorker = new TreasuryWorker();
  treasuryWorker.start().catch((error) => {
    console.error('❌ Failed to start treasury worker:', error);
  });
}

// Start A2A task worker - Story 58.3
let a2aWorker: ReturnType<typeof getA2ATaskWorker> | null = null;
if (enableA2AWorker) {
  a2aWorker = getA2ATaskWorker();
  a2aWorker.start();
}

// Start async settlement worker - Story 38.1
let asyncSettlementWorker: ReturnType<typeof getAsyncSettlementWorker> | null = null;
if (enableAsyncSettlement) {
  asyncSettlementWorker = getAsyncSettlementWorker();
  asyncSettlementWorker.start();
}

// Start batch settlement worker - Story 38.14
let batchSettlementWorker: ReturnType<typeof getBatchSettlementWorker> | null = null;
if (enableBatchSettlement) {
  const batchInterval = parseInt(process.env.BATCH_SETTLEMENT_INTERVAL_MS || '60000');
  batchSettlementWorker = getBatchSettlementWorker();
  batchSettlementWorker.start(batchInterval);
}

// Start agent connection cleanup worker - Epic 72
startConnectionCleanupWorker(createClient());

// Start TaskEventBus → AgentConnectionBus bridge - Epic 72
startTaskBridge();

// Start review timeout worker - Epic 69, Story 69.3
let reviewTimeoutWorker: ReturnType<typeof getReviewTimeoutWorker> | null = null;
if (enableReviewTimeout) {
  const reviewInterval = parseInt(process.env.REVIEW_TIMEOUT_POLL_MS || '60000');
  reviewTimeoutWorker = getReviewTimeoutWorker();
  reviewTimeoutWorker.start(reviewInterval);
}

// Start agent auto-refill worker — tops up opted-in agent EOAs from Circle master
let stopAutoRefill: (() => void) | null = null;
if (enableAutoRefill) {
  const refillInterval = parseInt(process.env.AGENT_AUTO_REFILL_INTERVAL_MS || String(5 * 60 * 1000));
  stopAutoRefill = startAutoRefillWorker(refillInterval);
}

// Start x402 publish-status poller (One-Click Publish epic) — confirms
// catalog visibility on agentic.market for endpoints whose first settle landed.
let x402PublishPoller: ReturnType<typeof getX402PublishPoller> | null = null;
if (enableX402PublishPoller) {
  const pollerInterval = parseInt(process.env.X402_PUBLISH_POLLER_INTERVAL_MS || '60000');
  x402PublishPoller = getX402PublishPoller();
  x402PublishPoller.start(pollerInterval);
}

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  if (worker) {
    worker.stop();
  }
  stopIdempotencyCleanup();
  stopX402ExpiredCleanup();
  stopScopeExpirationSweeper();
  stopScopeHeartbeatWorker();
  if (enableWebhookCleanup) {
    webhookCleanupWorker.stop();
  }
  if (settlementWindowProcessor) {
    settlementWindowProcessor.stop();
  }
  if (treasuryWorker) {
    treasuryWorker.stop();
  }
  if (a2aWorker) {
    await a2aWorker.stop();
  }
  if (asyncSettlementWorker) {
    asyncSettlementWorker.stop();
  }
  if (batchSettlementWorker) {
    batchSettlementWorker.stop();
  }
  if (reviewTimeoutWorker) {
    reviewTimeoutWorker.stop();
  }
  if (stopAutoRefill) {
    stopAutoRefill();
  }
  if (x402PublishPoller) {
    x402PublishPoller.stop();
  }
  // Drain ops buffers before exit (Epic 65)
  await stopOpTracker();
  await stopRequestCounter();
  stopPartitionManager();
  stopSmartWalletSyncWorker();
  stopAgentEoaSyncWorker();
  stopConnectionCleanupWorker();
  stopTaskBridge();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });
  
  console.log(`✅ Server is listening on ${host}:${port}`);
  console.log(`📍 Railway URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'payos-production.up.railway.app'}`);
} catch (error) {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
}


