import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './app.js';
import { getScheduledTransferWorker } from './workers/scheduled-transfers.js';
import { startIdempotencyCleanupWorker } from './workers/idempotency-cleanup.js';
import { webhookCleanupWorker } from './workers/webhook-cleanup.js';
import { SettlementWindowProcessor } from './workers/settlement-window-processor.js';
import { TreasuryWorker } from './workers/treasury-worker.js';
import { getA2ATaskWorker } from './workers/a2a-task-worker.js';
import { getAsyncSettlementWorker } from './workers/async-settlement-worker.js';
import { getBatchSettlementWorker } from './workers/batch-settlement-worker.js';
import { environmentManager } from './config/environment.js';
import { loadHandlersFromDB } from './services/ucp/payment-handlers/index.js';
import { createClient } from './db/client.js';

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
╚══════════════════════════════════════════════════╝
`);

// Log environment configuration (Story 40.28)
environmentManager.logStartupInfo();

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

// Graceful shutdown
const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down gracefully...`);
  if (worker) {
    worker.stop();
  }
  stopIdempotencyCleanup();
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
  console.log(`📍 Railway URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-app.railway.app'}`);
} catch (error) {
  console.error('❌ Failed to start server:', error);
  process.exit(1);
}


