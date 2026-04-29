/**
 * x402 publish-status poller.
 *
 * Confirms catalog visibility for endpoints whose first settle landed
 * (`publish_status='processing'`) by polling the public agentic.market
 * catalog. Mirrors the lifecycle pattern from
 * `apps/api/src/workers/scheduled-transfers.ts` — singleton worker, mock-mode
 * flag, graceful start/stop hooks.
 *
 * Why polling vs. webhooks: Coinbase's CDP Facilitator returns
 * EXTENSION-RESPONSES: processing|rejected on settle but doesn't fire a
 * confirmation webhook when indexing completes. The catalog itself is the
 * source of truth.
 *
 * Timeout: rows that stay 'processing' for X402_PUBLISH_INDEX_SLA_MINUTES
 * (default 30) flip to 'failed' so the dashboard surfaces the stuck listing.
 */
import { createClient } from '../db/client.js';

const DEFAULT_INTERVAL_MS = parseInt(
  process.env.X402_PUBLISH_POLLER_INTERVAL_MS || '60000',
  10
);
const SLA_MINUTES = parseInt(
  process.env.X402_PUBLISH_INDEX_SLA_MINUTES || '30',
  10
);

const CATALOG_BASE_URL =
  process.env.AGENTIC_MARKET_API_URL || 'https://api.agentic.market/v1/services';

export class X402PublishPoller {
  private isRunning = false;
  private intervalId: NodeJS.Timeout | null = null;
  private mockMode: boolean;

  constructor(mockMode: boolean = false) {
    this.mockMode = mockMode || process.env.MOCK_X402_PUBLISH_POLLER === 'true';
  }

  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.isRunning) {
      console.warn('[x402-publish-poller] already running');
      return;
    }
    this.isRunning = true;
    console.log(
      `[x402-publish-poller] starting (mock=${this.mockMode}, interval=${intervalMs}ms, sla=${SLA_MINUTES}min)`
    );

    // First tick immediately so a recent publish doesn't wait a whole interval
    this.processBatch().catch((err) =>
      console.error('[x402-publish-poller] first tick failed:', err)
    );

    this.intervalId = setInterval(() => {
      this.processBatch().catch((err) =>
        console.error('[x402-publish-poller] tick failed:', err)
      );
    }, intervalMs);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[x402-publish-poller] stopped');
  }

  /**
   * One pass: pull all endpoints in 'processing', check the catalog,
   * promote to 'published' on hit, expire to 'failed' past SLA.
   */
  async processBatch(): Promise<void> {
    const supabase: any = createClient();
    const { data: rows, error } = await supabase
      .from('x402_endpoints')
      .select(
        'id, tenant_id, service_slug, name, path, last_settle_at, publish_status, catalog_service_id'
      )
      .eq('publish_status', 'processing')
      .limit(50);

    if (error) {
      console.error('[x402-publish-poller] failed to load batch:', error.message);
      return;
    }
    if (!rows || rows.length === 0) return;

    const slaMs = SLA_MINUTES * 60 * 1000;
    const now = Date.now();

    for (const row of rows) {
      try {
        // SLA timeout: fall through to 'failed' before hitting the catalog.
        const settled = row.last_settle_at ? Date.parse(row.last_settle_at) : 0;
        if (settled && now - settled > slaMs) {
          await this.failExpired(supabase, row);
          continue;
        }

        const match = await this.lookupCatalog(row);
        if (match) {
          await this.markPublished(supabase, row, match);
        }
      } catch (err: any) {
        console.error(
          `[x402-publish-poller] error on endpoint ${row.id}:`,
          err?.message || err
        );
      }
    }
  }

  /**
   * Hit the agentic.market public catalog and try to find this endpoint.
   * Returns the catalog service id when found.
   */
  private async lookupCatalog(row: {
    service_slug: string | null;
    name: string;
    path: string;
  }): Promise<{ id: string } | null> {
    if (this.mockMode) {
      // Mock mode: pretend everything indexes after one tick — keeps the
      // local dev loop tight without burning real CDP traffic.
      return { id: `mock-svc-${row.service_slug || 'unknown'}` };
    }

    const q = encodeURIComponent(row.service_slug || row.name || row.path);
    const url = `${CATALOG_BASE_URL}/search?q=${q}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      console.warn(`[x402-publish-poller] catalog fetch failed: ${err?.message}`);
      return null;
    }

    if (!res.ok) {
      // 5xx upstream — try again next tick rather than failing the row.
      return null;
    }

    const body = await res.json().catch(() => null);
    if (!body) return null;

    // We accept a few common response shapes:
    //   { services: [{ id, slug }] }       — Bazaar's documented shape
    //   { data: [{ id, slug }] }           — common API convention
    //   [{ id, slug }]                     — bare list
    const list: any[] = Array.isArray(body)
      ? body
      : Array.isArray(body.services)
      ? body.services
      : Array.isArray(body.data)
      ? body.data
      : [];

    const slug = (row.service_slug || '').toLowerCase();
    const match = list.find((s: any) => {
      const fields = [s?.slug, s?.serviceSlug, s?.path, s?.name];
      return fields.some(
        (f) => typeof f === 'string' && f.toLowerCase() === slug
      );
    });
    if (match && match.id) return { id: String(match.id) };
    return null;
  }

  private async markPublished(
    supabase: any,
    row: { id: string; tenant_id: string },
    match: { id: string }
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('x402_endpoints')
      .update({
        publish_status: 'published',
        published_at: now,
        last_indexed_at: now,
        catalog_service_id: match.id,
        publish_error: null,
        updated_at: now,
      })
      .eq('id', row.id);
    if (updateErr) {
      console.error(`[x402-publish-poller] markPublished update: ${updateErr.message}`);
      return;
    }

    await supabase.from('x402_publish_events').insert({
      tenant_id: row.tenant_id,
      endpoint_id: row.id,
      actor_type: 'system',
      actor_id: null,
      event: 'indexed',
      details: { catalog_service_id: match.id },
    });
  }

  private async failExpired(
    supabase: any,
    row: { id: string; tenant_id: string; last_settle_at: string | null }
  ): Promise<void> {
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('x402_endpoints')
      .update({
        publish_status: 'failed',
        publish_error: 'not_indexed_within_sla',
        updated_at: now,
      })
      .eq('id', row.id);
    if (updateErr) {
      console.error(`[x402-publish-poller] failExpired update: ${updateErr.message}`);
      return;
    }
    await supabase.from('x402_publish_events').insert({
      tenant_id: row.tenant_id,
      endpoint_id: row.id,
      actor_type: 'system',
      actor_id: null,
      event: 'failed',
      details: {
        reason: 'not_indexed_within_sla',
        sla_minutes: SLA_MINUTES,
        last_settle_at: row.last_settle_at,
      },
    });
  }
}

let pollerInstance: X402PublishPoller | null = null;

export function getX402PublishPoller(mockMode?: boolean): X402PublishPoller {
  if (!pollerInstance) {
    pollerInstance = new X402PublishPoller(mockMode);
  }
  return pollerInstance;
}
