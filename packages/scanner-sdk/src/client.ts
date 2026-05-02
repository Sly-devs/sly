import { makeContext, request, type RequestContext, type RetryOptions } from './http.js';
import type {
  ActivityDay,
  BalanceSummary,
  CreateBatchRequest,
  CreateKeyRequest,
  CreateKeyResponse,
  Environment,
  LedgerEntry,
  MerchantScan,
  PaginationMeta,
  ScanBatch,
  ScanRequest,
  ScannerKey,
} from './types.js';

const DEFAULT_BASE_URL = 'https://sly-scanner.vercel.app';

export interface ScannerOptions {
  /** Partner API key (`psk_live_*` or `psk_test_*`) or a Supabase JWT. */
  apiKey: string;
  /** Override the scanner base URL (e.g. for staging). Defaults to production. */
  baseUrl?: string;
  /** Tag requests with the environment header. Defaults to inferring from key prefix. */
  environment?: Environment;
  /** Bring your own fetch — useful for tests or for non-Node runtimes. */
  fetch?: typeof fetch;
  /** Retry config for 429 / 5xx (default 3 attempts, exponential backoff with jitter). */
  retry?: RetryOptions;
  /** Headers attached to every request (merged after auth/env headers). */
  defaultHeaders?: Record<string, string>;
}

export interface ListScansFilter {
  category?: string;
  region?: string;
  status?: string;
  min_score?: number;
  max_score?: number;
  page?: number;
  limit?: number;
}

export interface ListLedgerOptions {
  from?: string;
  to?: string;
  limit?: number;
  page?: number;
  /** When true, consume rows include the linked merchant_scans summary. */
  expandScan?: boolean;
}

export interface ListActivityOptions {
  from?: string;
  to?: string;
}

export interface WaitForBatchOptions {
  /** How often to poll, ms. Default 2000. */
  pollIntervalMs?: number;
  /** Give up after this many ms. Default no timeout. */
  timeoutMs?: number;
  /** Optional callback fired on each poll with the latest batch state. */
  onProgress?: (batch: ScanBatch) => void;
}

/**
 * Sly Scanner SDK — typed client for the agentic-commerce readiness API.
 *
 * @example
 * ```ts
 * import { Scanner } from '@sly_ai/scanner';
 * const scanner = new Scanner({ apiKey: process.env.SCANNER_KEY! });
 * const result = await scanner.scan({ domain: 'shopify.com' });
 * console.log(result.readiness_score, scanner.balance);
 * ```
 */
export class Scanner {
  private ctx: RequestContext;
  private _balance: number | null = null;

  constructor(opts: ScannerOptions) {
    if (!opts.apiKey) {
      throw new Error('Scanner: apiKey is required');
    }
    const env = opts.environment ?? inferEnvironment(opts.apiKey);
    this.ctx = makeContext({
      baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: opts.apiKey,
      environment: env,
      fetchImpl: opts.fetch,
      retry: opts.retry,
      defaultHeaders: opts.defaultHeaders,
      onResponse: (res) => {
        const remaining = res.headers.get('x-credits-remaining');
        if (remaining !== null) {
          const n = Number(remaining);
          if (Number.isFinite(n)) this._balance = n;
        }
      },
    });
  }

  /**
   * Last seen balance from `X-Credits-Remaining` (set after any billed call).
   * Returns null until the first call lands. For an authoritative read use
   * `getBalance()`.
   */
  get balance(): number | null {
    return this._balance;
  }

  // ─── Scans ────────────────────────────────────────────────────────────

  /** Scan a single domain. Costs 1 credit on success; refunded on 4xx/5xx. */
  scan(req: ScanRequest, opts: { requestId?: string } = {}): Promise<MerchantScan> {
    return request<MerchantScan>(this.ctx, {
      method: 'POST',
      path: '/v1/scanner/scan',
      body: req,
      requestId: opts.requestId,
    });
  }

  /** Fetch a previously-completed scan by id. */
  async getScan(id: string): Promise<MerchantScan | null> {
    try {
      return await request<MerchantScan>(this.ctx, {
        method: 'GET',
        path: `/v1/scanner/scan/${encodeURIComponent(id)}`,
      });
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  /** Browse the shared scan corpus (across tenants). */
  listScans(filter: ListScansFilter = {}): Promise<{
    data: MerchantScan[];
    pagination: PaginationMeta;
  }> {
    return request(this.ctx, {
      method: 'GET',
      path: '/v1/scanner/scans',
      query: { ...filter },
    });
  }

  /**
   * Convenience: scan many domains with bounded concurrency, yielding results
   * as they complete. Errors per-domain are caught and yielded with `{ error }`
   * so one failure doesn't abort the batch.
   */
  async *scanMany(
    domains: Array<string | ScanRequest>,
    opts: { concurrency?: number } = {},
  ): AsyncGenerator<{ input: ScanRequest; result?: MerchantScan; error?: Error }> {
    const concurrency = Math.max(1, opts.concurrency ?? 5);
    const queue = domains.map((d): ScanRequest => (typeof d === 'string' ? { domain: d } : d));
    const inFlight = new Map<Promise<unknown>, ScanRequest>();
    let nextIdx = 0;

    while (nextIdx < queue.length || inFlight.size > 0) {
      while (inFlight.size < concurrency && nextIdx < queue.length) {
        const req = queue[nextIdx++]!;
        const p = this.scan(req).then(
          (result) => ({ req, result }),
          (error: Error) => ({ req, error }),
        );
        inFlight.set(p, req);
      }
      const finished = (await Promise.race(inFlight.keys())) as
        | { req: ScanRequest; result: MerchantScan; error?: undefined }
        | { req: ScanRequest; result?: undefined; error: Error };
      // Find and remove the resolved promise.
      for (const [p, r] of inFlight) {
        if (r === finished.req) {
          inFlight.delete(p);
          break;
        }
      }
      yield { input: finished.req, result: finished.result, error: finished.error };
    }
  }

  // ─── Batches ──────────────────────────────────────────────────────────

  /** Queue a JSON batch of domains. Cost is 0.5 credit / domain at enqueue. */
  createBatch(req: CreateBatchRequest): Promise<ScanBatch> {
    return request<ScanBatch>(this.ctx, {
      method: 'POST',
      path: '/v1/scanner/scan/batch',
      body: req,
    });
  }

  /** Upload a CSV of domains as a multipart batch. The CSV must have a `domain` column. */
  uploadBatchCsv(file: Blob | File, opts: { name?: string; description?: string } = {}): Promise<ScanBatch> {
    const fd = new FormData();
    fd.append('file', file);
    if (opts.name) fd.append('name', opts.name);
    if (opts.description) fd.append('description', opts.description);
    return request<ScanBatch>(this.ctx, {
      method: 'POST',
      path: '/v1/scanner/scan/batch',
      body: fd,
      raw: true,
    });
  }

  getBatch(id: string): Promise<ScanBatch> {
    return request<ScanBatch>(this.ctx, {
      method: 'GET',
      path: `/v1/scanner/scan/batch/${encodeURIComponent(id)}`,
    });
  }

  cancelBatch(id: string): Promise<void> {
    return request<void>(this.ctx, {
      method: 'DELETE',
      path: `/v1/scanner/scan/batch/${encodeURIComponent(id)}`,
    });
  }

  /** Poll until the batch reaches a terminal state. */
  async waitForBatch(id: string, opts: WaitForBatchOptions = {}): Promise<ScanBatch> {
    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    while (true) {
      const batch = await this.getBatch(id);
      opts.onProgress?.(batch);
      if (
        batch.status === 'completed' ||
        batch.status === 'failed' ||
        batch.status === 'cancelled'
      ) {
        return batch;
      }
      if (Date.now() >= deadline) {
        throw new Error(`waitForBatch: timed out after ${opts.timeoutMs}ms (status: ${batch.status})`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  // ─── Credits / billing ────────────────────────────────────────────────

  /** Authoritative balance read (synchronous DB query, never stale). */
  async getBalance(): Promise<BalanceSummary> {
    const summary = await request<BalanceSummary>(this.ctx, {
      method: 'GET',
      path: '/v1/scanner/credits/balance',
    });
    this._balance = summary.balance;
    return summary;
  }

  /**
   * Day-bucketed billable scan counts from the credit ledger (ground truth,
   * never undercounts). Use this for usage charts and billing reconciliation.
   */
  listActivity(opts: ListActivityOptions = {}): Promise<ActivityDay[]> {
    return request<{ data: ActivityDay[] }>(this.ctx, {
      method: 'GET',
      path: '/v1/scanner/credits/activity',
      query: { from: opts.from, to: opts.to },
    }).then((r) => r.data);
  }

  /** Single page of ledger entries. For automatic pagination, use `iterateLedger()`. */
  listLedger(opts: ListLedgerOptions = {}): Promise<{ data: LedgerEntry[]; pagination: PaginationMeta }> {
    return request(this.ctx, {
      method: 'GET',
      path: '/v1/scanner/credits/ledger',
      query: {
        from: opts.from,
        to: opts.to,
        limit: opts.limit,
        page: opts.page,
        expand: opts.expandScan ? 'scan' : undefined,
      },
    });
  }

  /** Iterate the ledger across all pages — yields each entry. */
  async *iterateLedger(opts: ListLedgerOptions = {}): AsyncGenerator<LedgerEntry> {
    const limit = opts.limit ?? 100;
    let page = opts.page ?? 1;
    while (true) {
      const { data, pagination } = await this.listLedger({ ...opts, limit, page });
      for (const entry of data) yield entry;
      if (page >= pagination.totalPages) return;
      page += 1;
    }
  }

  // ─── Keys ─────────────────────────────────────────────────────────────

  listKeys(): Promise<ScannerKey[]> {
    return request<{ data: ScannerKey[] }>(this.ctx, {
      method: 'GET',
      path: '/v1/scanner/keys',
    }).then((r) => r.data);
  }

  /** Returns the plaintext key in `.key` — surface it once and persist immediately. */
  createKey(req: CreateKeyRequest): Promise<CreateKeyResponse> {
    return request<CreateKeyResponse>(this.ctx, {
      method: 'POST',
      path: '/v1/scanner/keys',
      body: req,
    });
  }

  revokeKey(id: string): Promise<void> {
    return request<void>(this.ctx, {
      method: 'DELETE',
      path: `/v1/scanner/keys/${encodeURIComponent(id)}`,
    });
  }
}

function inferEnvironment(apiKey: string): Environment | undefined {
  if (apiKey.startsWith('psk_live_')) return 'live';
  if (apiKey.startsWith('psk_test_')) return 'test';
  return undefined; // JWT / unknown — let the server decide
}
