/**
 * Epic 65, Story 65.16: Partition Manager Worker
 *
 * Monthly: creates new partitions for operation_events and api_request_counts.
 * Hourly: refreshes the usage_summary_hourly materialized view.
 */

import { createClient } from '../db/client.js';

const PARTITION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // Daily
const MATVIEW_REFRESH_INTERVAL = 60 * 60 * 1000; // Hourly

let partitionTimer: ReturnType<typeof setInterval> | null = null;
let matviewTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Ensure partitions exist for the next 2 months.
 */
async function ensurePartitions(): Promise<void> {
  const supabase = createClient();
  const now = new Date();

  // Create partitions for this month and next 2 months
  for (let i = 0; i <= 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const nextMonth = new Date(d.getFullYear(), d.getMonth() + 1, 1);

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const fromDate = `${year}-${month}-01`;
    const toYear = nextMonth.getFullYear();
    const toMonth = String(nextMonth.getMonth() + 1).padStart(2, '0');
    const toDate = `${toYear}-${toMonth}-01`;

    const suffix = `${year}_${month}`;

    // operation_events partition
    const { error: opErr } = await (supabase.rpc as any)('exec_sql', {
      sql: `CREATE TABLE IF NOT EXISTS operation_events_${suffix} PARTITION OF operation_events FOR VALUES FROM ('${fromDate}') TO ('${toDate}');`,
    });
    if (opErr && !opErr.message?.includes('already exists')) {
      console.error(`[partition-manager] Failed to create operation_events_${suffix}:`, opErr.message);
    }

    // Enable RLS on operation_events partition (not inherited from parent)
    await (supabase.rpc as any)('exec_sql', {
      sql: `ALTER TABLE IF EXISTS operation_events_${suffix} ENABLE ROW LEVEL SECURITY;`,
    });

    // api_request_counts partition
    const { error: reqErr } = await (supabase.rpc as any)('exec_sql', {
      sql: `CREATE TABLE IF NOT EXISTS api_request_counts_${suffix} PARTITION OF api_request_counts FOR VALUES FROM ('${fromDate}') TO ('${toDate}');`,
    });
    if (reqErr && !reqErr.message?.includes('already exists')) {
      console.error(`[partition-manager] Failed to create api_request_counts_${suffix}:`, reqErr.message);
    }

    // Enable RLS on api_request_counts partition (not inherited from parent)
    await (supabase.rpc as any)('exec_sql', {
      sql: `ALTER TABLE IF EXISTS api_request_counts_${suffix} ENABLE ROW LEVEL SECURITY;`,
    });
  }

  console.log('[partition-manager] Partition check complete');
}

/**
 * Refresh the usage_summary_hourly materialized view.
 */
async function refreshMatview(): Promise<void> {
  const supabase = createClient();

  const { error } = await (supabase.rpc as any)('exec_sql', {
    sql: 'REFRESH MATERIALIZED VIEW CONCURRENTLY usage_summary_hourly;',
  });

  if (error) {
    console.error('[partition-manager] Matview refresh failed:', error.message);
  }
}

export function startPartitionManager(): void {
  // Run partition check immediately, then daily
  ensurePartitions().catch((err) => {
    console.error('[partition-manager] Initial partition check failed:', err.message);
  });

  partitionTimer = setInterval(() => {
    ensurePartitions().catch((err) => {
      console.error('[partition-manager] Partition check failed:', err.message);
    });
  }, PARTITION_CHECK_INTERVAL);

  // Refresh matview hourly
  matviewTimer = setInterval(() => {
    refreshMatview().catch((err) => {
      console.error('[partition-manager] Matview refresh failed:', err.message);
    });
  }, MATVIEW_REFRESH_INTERVAL);

  // Don't block process exit
  if (partitionTimer && typeof partitionTimer === 'object' && 'unref' in partitionTimer) {
    partitionTimer.unref();
  }
  if (matviewTimer && typeof matviewTimer === 'object' && 'unref' in matviewTimer) {
    matviewTimer.unref();
  }

  console.log('[partition-manager] Started (daily partition check, hourly matview refresh)');
}

export function stopPartitionManager(): void {
  if (partitionTimer) {
    clearInterval(partitionTimer);
    partitionTimer = null;
  }
  if (matviewTimer) {
    clearInterval(matviewTimer);
    matviewTimer = null;
  }
  console.log('[partition-manager] Stopped');
}
