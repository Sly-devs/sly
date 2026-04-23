import { createClient } from '../db/client.js';

interface UsageRow {
  tenantId: string;
  scannerKeyId: string | null;
  minuteBucket: string;
  method: string;
  pathTemplate: string;
  statusCode: number;
  actorType: string;
  count: number;
  totalDurationMs: number;
  creditsConsumed: number;
}

const FLUSH_INTERVAL_MS = 10_000;

const buffer = new Map<string, UsageRow>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const NUMERIC_ID_REGEX = /\/\d+(?=\/|$)/g;

export function normalizePath(path: string): string {
  return path.replace(UUID_REGEX, ':id').replace(NUMERIC_ID_REGEX, '/:id');
}

function getMinuteBucket(date: Date): string {
  const d = new Date(date);
  d.setSeconds(0, 0);
  return d.toISOString();
}

export function recordRequest(params: {
  tenantId: string;
  scannerKeyId: string | null;
  method: string;
  path: string;
  statusCode: number;
  actorType: string;
  durationMs: number;
  creditsConsumed: number;
}): void {
  const minuteBucket = getMinuteBucket(new Date());
  const pathTemplate = normalizePath(params.path);
  const key = `${params.tenantId}:${params.scannerKeyId ?? 'none'}:${minuteBucket}:${params.method}:${pathTemplate}:${params.statusCode}:${params.actorType}`;

  const existing = buffer.get(key);
  if (existing) {
    existing.count += 1;
    existing.totalDurationMs += params.durationMs;
    existing.creditsConsumed += params.creditsConsumed;
    return;
  }

  buffer.set(key, {
    tenantId: params.tenantId,
    scannerKeyId: params.scannerKeyId,
    minuteBucket,
    method: params.method,
    pathTemplate,
    statusCode: params.statusCode,
    actorType: params.actorType,
    count: 1,
    totalDurationMs: params.durationMs,
    creditsConsumed: params.creditsConsumed,
  });
}

export async function flushUsage(): Promise<number> {
  if (buffer.size === 0) return 0;

  const entries = Array.from(buffer.values());
  buffer.clear();

  try {
    const supabase = createClient();
    const rows = entries.map((e) => ({
      tenant_id: e.tenantId,
      scanner_key_id: e.scannerKeyId,
      minute_bucket: e.minuteBucket,
      method: e.method,
      path_template: e.pathTemplate,
      status_code: e.statusCode,
      actor_type: e.actorType,
      count: e.count,
      total_duration_ms: e.totalDurationMs,
      credits_consumed: e.creditsConsumed,
    }));

    const { error } = await (supabase.from('scanner_usage_events') as any).upsert(rows, {
      onConflict:
        'tenant_id,scanner_key_id,minute_bucket,method,path_template,status_code,actor_type',
      ignoreDuplicates: false,
    });

    if (error) {
      console.error(
        `[scanner-usage] Flush failed (${entries.length} rows):`,
        error.message,
      );
      // Requeue on error
      for (const entry of entries) {
        const key = `${entry.tenantId}:${entry.scannerKeyId ?? 'none'}:${entry.minuteBucket}:${entry.method}:${entry.pathTemplate}:${entry.statusCode}:${entry.actorType}`;
        const existing = buffer.get(key);
        if (existing) {
          existing.count += entry.count;
          existing.totalDurationMs += entry.totalDurationMs;
          existing.creditsConsumed += entry.creditsConsumed;
        } else {
          buffer.set(key, entry);
        }
      }
      return 0;
    }

    return entries.length;
  } catch (err: any) {
    console.error('[scanner-usage] Flush error:', err.message);
    return 0;
  }
}

export function startUsageFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushUsage().catch((err) =>
      console.error('[scanner-usage] Periodic flush failed:', err.message),
    );
  }, FLUSH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
  console.log('[scanner-usage] Started (10s flush interval)');
}

export async function stopUsageFlush(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  if (buffer.size > 0) {
    console.log(`[scanner-usage] Draining ${buffer.size} entries...`);
    await flushUsage();
  }
  console.log('[scanner-usage] Stopped');
}

export function getBufferSize(): number {
  return buffer.size;
}
