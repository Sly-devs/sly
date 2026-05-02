# @sly_ai/scanner

Official TypeScript SDK for the **[Sly Scanner](https://docs.getsly.ai/scanner)** — agentic-commerce readiness API.

Scan any merchant domain to detect agentic-commerce protocol support (UCP, ACP, AP2, x402, MCP, NLWeb, Visa VIC, Mastercard Agent Pay), structured data quality, accessibility, and checkout friction. Get back a 0–100 readiness score plus per-protocol detection details.

## Install

```bash
npm install @sly_ai/scanner
# or
pnpm add @sly_ai/scanner
# or
yarn add @sly_ai/scanner
```

Node 18+ (uses native `fetch`). Browser-friendly. Zero runtime dependencies.

## Quickstart

```ts
import { Scanner } from '@sly_ai/scanner';

const scanner = new Scanner({
  apiKey: process.env.SCANNER_KEY!, // psk_live_* or psk_test_*
});

const result = await scanner.scan({ domain: 'shopify.com' });

console.log(result.readiness_score);          // 0–100
console.log(result.protocol_results);          // per-protocol detection
console.log(scanner.balance);                  // remaining credits, set from X-Credits-Remaining
```

Get a key from the dashboard at **app.getsly.ai → Developers → API Keys → Scanner API Keys**.

## Typed errors

Catch the specific subclass to react actionably:

```ts
import { Scanner, InsufficientCreditsError, RateLimitError, ValidationError } from '@sly_ai/scanner';

try {
  await scanner.scan({ domain: 'shopify.com' });
} catch (err) {
  if (err instanceof InsufficientCreditsError) {
    console.log(`Need ${err.required} credits, have ${err.balance}. Top up: ${err.docs}`);
  } else if (err instanceof RateLimitError) {
    console.log(`Rate limited — retry in ${err.retryAfterSeconds}s`);
  } else if (err instanceof ValidationError) {
    console.log('Bad request:', err.fieldErrors);
  } else {
    throw err;
  }
}
```

The SDK auto-retries `429` (respecting `Retry-After`) and `5xx` (exponential backoff with jitter, default 3 attempts). It does NOT retry `400` / `402` / `403` / `404` / `409` / `422` since those are deterministic.

## Batch scanning

**Bounded-concurrency stream** (recommended for ~10–500 domains):

```ts
const domains = ['shopify.com', 'nike.com', 'adidas.com', /* … */];

for await (const { input, result, error } of scanner.scanMany(domains, { concurrency: 10 })) {
  if (error) console.error(`${input.domain}:`, error.message);
  else console.log(`${input.domain}: score ${result!.readiness_score}`);
}
```

**Server-side batch** (recommended for 500+ domains, queued + polled):

```ts
const batch = await scanner.createBatch({
  domains: domains.map((d) => ({ domain: d })),
  name: 'Q2 2026 retail audit',
});

const finished = await scanner.waitForBatch(batch.id, {
  pollIntervalMs: 5_000,
  onProgress: (b) => console.log(`${b.completed_targets}/${b.total_targets}`),
});

console.log(`Done: ${finished.completed_targets} ok, ${finished.failed_targets} failed`);
```

**CSV upload** — the CSV must have a `domain` column:

```ts
const file = new File([csvBytes], 'merchants.csv', { type: 'text/csv' });
const batch = await scanner.uploadBatchCsv(file, { name: 'imported-list' });
```

## Credits and billing

Credits map 1:1 to scans (single scan = 1 credit, batch = 0.5/domain, agent test = 5).
The SDK tracks remaining balance from the `X-Credits-Remaining` response header on every billed call:

```ts
await scanner.scan({ domain: 'shopify.com' });
console.log(scanner.balance); // last seen balance, set after any billed call
```

For an authoritative read or lifetime totals:

```ts
const summary = await scanner.getBalance();
// { balance: 96, grantedTotal: 100, consumedTotal: 4 }
```

**Day-bucketed scan history** (ground truth, sourced from the credit ledger — never undercounts):

```ts
const days = await scanner.listActivity({ from: '2026-04-01T00:00:00Z' });
// [{ day: '2026-05-02', scans: 17, credits: 17 }, …]
```

**Full ledger** (per-charge audit trail):

```ts
// Single page
const { data, pagination } = await scanner.listLedger({ page: 1, limit: 50, expandScan: true });

// Or auto-paginate
for await (const entry of scanner.iterateLedger({ expandScan: true })) {
  if (entry.reason === 'consume' && entry.scan) {
    console.log(entry.created_at, entry.scan.domain, entry.scan.readiness_score);
  }
}
```

`expandScan: true` joins each consume row to its scan result so you can audit "what did I get for this charge?" without a second call.

## Key management

```ts
// List
const keys = await scanner.listKeys();

// Create — plaintext returned ONCE in `.key`; persist immediately
const created = await scanner.createKey({
  name: 'CI scanner',
  environment: 'live',
  scopes: ['scan', 'batch', 'read'],
});
console.log('Save this:', created.key); // psk_live_...

// Revoke
await scanner.revokeKey(created.id);
```

## Auto-refunded errors

If your request fails after the credits middleware debits (e.g. a typo in the request body returns 400, or a transient 5xx), the scanner automatically refunds the credit. The ledger keeps both rows — consume + refund — for a complete audit trail. Your effective consumed total reflects the net.

## Configuration

```ts
const scanner = new Scanner({
  apiKey: process.env.SCANNER_KEY!,
  baseUrl: 'https://sly-scanner.vercel.app',  // override for staging
  environment: 'live',                         // inferred from key prefix by default
  retry: { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000 },
  fetch: customFetch,                          // bring your own (tests, proxies, edge runtimes)
  defaultHeaders: { 'X-Trace-Id': requestId }, // attached to every call
});
```

Pass a `requestId` per call for trace propagation:

```ts
await scanner.scan({ domain: 'shopify.com' }, { requestId: 'job-abc-123' });
```

The id flows through `X-Request-ID` and is echoed in error objects so support tickets can be cross-referenced.

## Testing

The SDK is tree-shakeable, dependency-free, and accepts a custom `fetch` — easy to mock in unit tests:

```ts
import { Scanner } from '@sly_ai/scanner';

const fakeFetch = async (url, init) => new Response(JSON.stringify({ readiness_score: 50 }), { status: 200 });
const scanner = new Scanner({ apiKey: 'psk_test_x', fetch: fakeFetch });
```

## Links

- Docs: https://docs.getsly.ai/scanner
- Pricing: https://docs.getsly.ai/scanner/credits-and-billing
- Status: https://sly-scanner.vercel.app/health
- Support: partners@getsly.ai

## License

MIT
