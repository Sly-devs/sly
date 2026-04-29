/**
 * Endpoint auto-probe service.
 *
 * Used by the publish flow to derive a Bazaar discovery_metadata payload
 * from a real backend response so the user gets a sensible default before
 * editing. Keeps Sly out of the schema-design business while still
 * allowing one-click publish.
 *
 * Constraints:
 *  - GET only auto-probes today. POST/PUT/PATCH return {requires_manual_metadata: true}
 *    so the dashboard prompts for schema + example.
 *  - Body capped at 64 KB to prevent runaway memory use on misbehaving backends.
 *  - Arrays truncated to 5 elements before inference (good enough for shape).
 *  - No external requests outside the tenant's declared backend_url.
 *  - Result is cached on x402_endpoints.discovery_metadata by the publish service.
 */
import { request } from 'undici';
import type { X402DiscoveryMetadata } from '@sly/api-client';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ARRAY_SAMPLES = 5;
const REQUEST_TIMEOUT_MS = 8000;

export interface ProbeRequest {
  method: string;
  backendUrl: string;
  /** Optional headers Sly normally attaches when proxying (auth, HMAC) — passed through. */
  headers?: Record<string, string>;
}

export interface ProbeSuccess {
  ok: true;
  status: number;
  contentType: string;
  /** Inferred Bazaar metadata. Caller merges any user override on top. */
  metadata: X402DiscoveryMetadata;
}

export interface ProbeFailure {
  ok: false;
  reason: string;
  /**
   * Set when the endpoint's method makes auto-probing inappropriate (POST,
   * PUT, PATCH, DELETE) — the dashboard should prompt the user to provide
   * schema + example manually instead of retrying.
   */
  requiresManualMetadata?: boolean;
}

export type ProbeResult = ProbeSuccess | ProbeFailure;

// ────────────────────────────────────────────────────────────────────────────
// JSON-Schema inferer
// ────────────────────────────────────────────────────────────────────────────

type Schema = Record<string, unknown>;

/**
 * Truncate arrays at MAX_ARRAY_SAMPLES so a 10k-element list doesn't
 * inflate the inferred schema or the cached example.
 */
function truncate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_SAMPLES).map(truncate);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncate(v);
    }
    return out;
  }
  return value;
}

/**
 * Roll-our-own JSON-Schema inferer. Quicker to ship than pulling in
 * quicktype-core (which is megabytes of CodeMirror baggage we don't need).
 *
 * - Primitives → matching `type`.
 * - Arrays → infer `items` from the union of element schemas (or first
 *   element if homogeneous).
 * - Objects → all keys treated as properties; required = keys present on
 *   the sample. additionalProperties left true to keep the catalog
 *   forgiving when backends drift.
 */
function inferSchema(value: unknown): Schema {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    const sampled = value.slice(0, MAX_ARRAY_SAMPLES);
    if (sampled.length === 0) return { type: 'array' };
    const itemSchemas = sampled.map(inferSchema);
    // If all items have the same single type, collapse to a single items schema
    const allSame = itemSchemas.every(
      (s) => JSON.stringify(s) === JSON.stringify(itemSchemas[0])
    );
    return {
      type: 'array',
      items: allSame ? itemSchemas[0] : { oneOf: itemSchemas },
    };
  }
  if (typeof value === 'object') {
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      properties[k] = inferSchema(v);
      if (v !== undefined) required.push(k);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: true,
    };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string' };
    case 'number':
      return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return {};
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Probe
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read up to MAX_BODY_BYTES from the response stream. Anything larger is
 * truncated — the resulting JSON parse will fail and we report "body too
 * large", which is the right outcome (we don't want to base the catalog
 * listing on a half-read object).
 */
async function readCappedBody(body: AsyncIterable<Uint8Array>): Promise<string> {
  let total = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
}

export async function probeEndpoint(req: ProbeRequest): Promise<ProbeResult> {
  const method = (req.method || 'GET').toUpperCase();

  // Non-GET probing is risky (side effects, auth requirements, idempotency).
  // Force the user to supply metadata for those.
  if (method !== 'GET') {
    return {
      ok: false,
      reason: `Auto-probe only supported for GET (got ${method})`,
      requiresManualMetadata: true,
    };
  }

  let url: URL;
  try {
    url = new URL(req.backendUrl);
  } catch {
    return { ok: false, reason: `backend_url is not a valid URL: ${req.backendUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported protocol: ${url.protocol}` };
  }

  let res;
  try {
    res = await request(url.toString(), {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'Sly-Publish-Probe/1.0',
        ...(req.headers || {}),
      },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err: any) {
    return { ok: false, reason: `probe failed: ${err?.message || 'unknown error'}` };
  }

  if (res.statusCode >= 400) {
    return {
      ok: false,
      reason: `backend returned ${res.statusCode}`,
    };
  }

  const contentType = String(res.headers['content-type'] || '');
  if (!contentType.includes('json')) {
    return {
      ok: false,
      reason: `expected JSON response, got content-type "${contentType || 'unknown'}"`,
    };
  }

  const text = await readCappedBody(res.body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err: any) {
    return {
      ok: false,
      reason:
        text.length >= MAX_BODY_BYTES
          ? `response body exceeded ${MAX_BODY_BYTES} bytes`
          : `response body was not valid JSON: ${err?.message}`,
    };
  }

  const truncatedExample = truncate(parsed);
  const outputSchema = inferSchema(truncatedExample);

  const metadata: X402DiscoveryMetadata = {
    description: '',
    output: {
      schema: outputSchema as Record<string, unknown>,
      example: truncatedExample,
    },
  };

  return {
    ok: true,
    status: res.statusCode,
    contentType,
    metadata,
  };
}

// Re-exported for unit-test reuse so the inferer can be exercised in
// isolation without spinning up an HTTP server.
export const __testing = { inferSchema, truncate };
