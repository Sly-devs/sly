# Changelog

## 0.1.0 — 2026-05-02

Initial release.

- `Scanner` client with typed methods for scans, batches, credits, and keys
- Typed error hierarchy: `ScannerError`, `InsufficientCreditsError`, `RateLimitError`, `ValidationError`, `AuthenticationError`, `ForbiddenError`, `NotFoundError`, `ServerError`
- Auto-retry with exponential backoff on `429` / `5xx`; respects `Retry-After`
- Live balance tracking from the `X-Credits-Remaining` response header
- `scanMany()` for bounded-concurrency stream-style batches
- `waitForBatch()` for server-side batch polling with progress callback
- `iterateLedger()` async iterator for auto-paginated ledger walks
- `expandScan: true` on ledger calls joins consume rows to merchant_scans
- Bring-your-own `fetch` for tests / non-Node runtimes
- Zero runtime dependencies, dual ESM + CJS bundles, full TypeScript types
