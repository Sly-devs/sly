import {
  AuthenticationError,
  ForbiddenError,
  InsufficientCreditsError,
  NotFoundError,
  RateLimitError,
  ScannerError,
  ServerError,
  ValidationError,
} from './errors.js';

export interface RetryOptions {
  /** Total attempts (includes the first try). Default 3. Set to 1 to disable retries. */
  maxAttempts?: number;
  /** Base backoff delay in ms (used when no Retry-After header is provided). Default 500. */
  baseDelayMs?: number;
  /** Maximum backoff cap in ms. Default 30_000. */
  maxDelayMs?: number;
}

export interface RequestContext {
  baseUrl: string;
  apiKey: string;
  environment?: string;
  fetchImpl: typeof fetch;
  retry: Required<RetryOptions>;
  /** Hook called with each response — used by Scanner to track X-Credits-Remaining. */
  onResponse?: (res: Response) => void;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

export function makeContext(opts: {
  baseUrl: string;
  apiKey: string;
  environment?: string;
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  onResponse?: (res: Response) => void;
  defaultHeaders?: Record<string, string>;
}): RequestContext {
  return {
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    environment: opts.environment,
    fetchImpl: opts.fetchImpl ?? fetch,
    retry: { ...DEFAULT_RETRY, ...(opts.retry ?? {}) },
    onResponse: opts.onResponse,
    defaultHeaders: opts.defaultHeaders,
  };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Provide a stable request id for tracing across the partner's logs and ours. */
  requestId?: string;
  /** Override default headers for this single call. */
  headers?: Record<string, string>;
  /** Pass-through for multipart bodies (FormData) so the SDK doesn't JSON-encode. */
  raw?: boolean;
}

const NON_RETRYABLE_STATUS = new Set([400, 401, 402, 403, 404, 409, 422]);

export async function request<T>(ctx: RequestContext, opts: RequestOptions): Promise<T> {
  const url = buildUrl(ctx.baseUrl, opts.path, opts.query);
  const headers = buildHeaders(ctx, opts);

  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    if (opts.raw) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
    }
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= ctx.retry.maxAttempts; attempt++) {
    try {
      const res = await ctx.fetchImpl(url, {
        method: opts.method ?? 'GET',
        headers,
        body,
      });
      ctx.onResponse?.(res);

      if (res.ok) {
        // 204 No Content: return undefined (typed as T by caller).
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }

      const requestId = res.headers.get('x-request-id') ?? undefined;
      const errorBody = await safeReadJson(res);

      // Map status → typed error.
      const error = mapErrorResponse(res, errorBody, requestId);

      // Retryable: 429 + 5xx (excluding deterministic 4xx).
      if (
        attempt < ctx.retry.maxAttempts &&
        (res.status === 429 || (res.status >= 500 && res.status < 600))
      ) {
        const wait = computeBackoff(res, ctx.retry, attempt);
        await sleep(wait);
        lastError = error;
        continue;
      }

      throw error;
    } catch (err) {
      // Network / fetch errors — retry up to maxAttempts unless we already
      // matched a non-retryable status above.
      if (err instanceof ScannerError && NON_RETRYABLE_STATUS.has(err.status)) {
        throw err;
      }
      if (attempt >= ctx.retry.maxAttempts) {
        throw err;
      }
      lastError = err;
      await sleep(computeBackoff(undefined, ctx.retry, attempt));
    }
  }

  throw lastError ?? new Error('Scanner SDK: exhausted retries with no error captured');
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions['query']): string {
  const u = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function buildHeaders(ctx: RequestContext, opts: RequestOptions): HeadersInit {
  const h: Record<string, string> = {
    Authorization: `Bearer ${ctx.apiKey}`,
    Accept: 'application/json',
    ...(ctx.defaultHeaders ?? {}),
  };
  if (opts.body !== undefined && !opts.raw) h['Content-Type'] = 'application/json';
  if (ctx.environment) h['X-Environment'] = ctx.environment;
  if (opts.requestId) h['X-Request-ID'] = opts.requestId;
  if (opts.headers) Object.assign(h, opts.headers);
  return h;
}

async function safeReadJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function mapErrorResponse(res: Response, body: unknown, requestId?: string): ScannerError {
  const b = (body ?? {}) as Record<string, unknown>;
  switch (res.status) {
    case 400:
      return new ValidationError(b as any, requestId);
    case 401:
      return new AuthenticationError(b, requestId);
    case 402:
      return new InsufficientCreditsError(
        {
          balance: Number((b as any).balance ?? 0),
          required: Number((b as any).required ?? 0),
          docs: (b as any).docs,
        },
        requestId,
      );
    case 403:
      return new ForbiddenError(b, requestId);
    case 404:
      return new NotFoundError(typeof (b as any).error === 'string' ? (b as any).error : 'Resource', requestId);
    case 429: {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      return new RateLimitError(b as any, retryAfter, requestId);
    }
    default:
      if (res.status >= 500) return new ServerError(res.status, b, requestId);
      return new ScannerError(
        typeof (b as any).error === 'string' ? (b as any).error : `HTTP ${res.status}`,
        res.status,
        b,
        requestId,
      );
  }
}

function parseRetryAfter(header: string | null): number {
  if (!header) return 1;
  const n = Number(header);
  if (Number.isFinite(n)) return Math.max(1, n);
  // HTTP-date variant — degrade to 1s rather than parsing a Date here.
  return 1;
}

function computeBackoff(res: Response | undefined, retry: Required<RetryOptions>, attempt: number): number {
  // Honor server's Retry-After if present.
  const retryAfter = res ? parseRetryAfter(res.headers.get('retry-after')) : undefined;
  if (retryAfter !== undefined && res?.status === 429) {
    return Math.min(retryAfter * 1000, retry.maxDelayMs);
  }
  // Exponential with jitter: base * 2^(attempt-1) ± 25%.
  const exp = retry.baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = exp * 0.25 * (Math.random() * 2 - 1);
  return Math.min(retry.maxDelayMs, Math.max(0, exp + jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
