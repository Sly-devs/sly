# Scanner Usage — Ops Queries

Internal runbook for checking partner usage. Three paths: partner-visible API, SQL against Supabase, and a future admin UI (not built yet).

## 1. Partner-visible API

What partners see about themselves. Use these when walking through their setup or debugging their integration.

```bash
# Current balance + lifetime totals
curl -H "Authorization: Bearer $PARTNER_KEY" \
  https://sly-scanner.vercel.app/v1/scanner/credits/balance
# → { "balance": 64, "grantedTotal": 96, "consumedTotal": 32 }

# Every debit and grant (paginated)
curl -H "Authorization: Bearer $PARTNER_KEY" \
  "https://sly-scanner.vercel.app/v1/scanner/credits/ledger?limit=50&from=2026-04-01"

# Aggregated usage by endpoint
curl -H "Authorization: Bearer $PARTNER_KEY" \
  "https://sly-scanner.vercel.app/v1/scanner/usage?group_by=endpoint"

# Aggregated usage by day (billing period view)
curl -H "Authorization: Bearer $PARTNER_KEY" \
  "https://sly-scanner.vercel.app/v1/scanner/usage?group_by=day&from=2026-04-01&to=2026-04-30"
```

All responses filter to the caller's tenant via the auth middleware — partners never see each other's data.

## 2. SQL against Supabase (ops view)

Run via Supabase Studio SQL editor, `psql`, or the Supabase MCP tool.

### Cross-tenant usage summary (last 7 days)

```sql
SELECT
  t.name AS tenant_name,
  e.tenant_id,
  sum(e.count) AS requests,
  sum(e.credits_consumed) AS credits_consumed,
  round(sum(e.total_duration_ms)::numeric / nullif(sum(e.count), 0), 0) AS avg_ms,
  min(e.minute_bucket) AS first_seen,
  max(e.minute_bucket) AS last_seen
FROM scanner_usage_events e
LEFT JOIN tenants t ON t.id = e.tenant_id
WHERE e.minute_bucket > now() - interval '7 days'
GROUP BY t.name, e.tenant_id
ORDER BY credits_consumed DESC, requests DESC;
```

### Balance + lifetime grants/consumption across tenants

```sql
SELECT
  t.name AS tenant_name,
  l.tenant_id,
  sum(CASE WHEN l.delta > 0 THEN l.delta ELSE 0 END) AS granted_total,
  sum(CASE WHEN l.delta < 0 THEN -l.delta ELSE 0 END) AS consumed_total,
  sum(l.delta) AS balance,
  max(l.created_at) AS last_activity
FROM scanner_credit_ledger l
LEFT JOIN tenants t ON t.id = l.tenant_id
GROUP BY t.name, l.tenant_id
ORDER BY consumed_total DESC;
```

### Per-key breakdown for one tenant

Swap the UUID for the target tenant.

```sql
SELECT
  k.id AS key_id,
  k.name AS key_name,
  k.environment,
  k.revoked_at IS NOT NULL AS revoked,
  coalesce(sum(e.count), 0) AS requests,
  coalesce(sum(e.credits_consumed), 0) AS credits,
  coalesce(round(sum(e.total_duration_ms)::numeric / nullif(sum(e.count), 0), 0), 0) AS avg_ms,
  k.last_used_at
FROM scanner_api_keys k
LEFT JOIN scanner_usage_events e
  ON e.scanner_key_id = k.id
 AND e.minute_bucket > now() - interval '30 days'
WHERE k.tenant_id = 'PUT_TENANT_UUID_HERE'
GROUP BY k.id, k.name, k.environment, k.revoked_at, k.last_used_at
ORDER BY k.last_used_at DESC NULLS LAST;
```

### Top endpoints hit by a given tenant

```sql
SELECT
  method || ' ' || path_template AS endpoint,
  sum(count) AS requests,
  sum(credits_consumed) AS credits,
  round(avg(total_duration_ms::numeric / nullif(count, 0)), 0) AS avg_ms,
  sum(CASE WHEN status_code >= 400 THEN count ELSE 0 END) AS errors
FROM scanner_usage_events
WHERE tenant_id = 'PUT_TENANT_UUID_HERE'
  AND minute_bucket > now() - interval '30 days'
GROUP BY method, path_template
ORDER BY requests DESC;
```

### Daily burn for billing / forecasting

```sql
SELECT
  date_trunc('day', minute_bucket)::date AS day,
  sum(count) AS requests,
  sum(credits_consumed) AS credits
FROM scanner_usage_events
WHERE tenant_id = 'PUT_TENANT_UUID_HERE'
  AND minute_bucket > now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
```

### Approaching-zero-balance alert

Emails the ops team when any partner's balance drops below N credits. Hook into cron or a daily report.

```sql
SELECT
  t.name AS tenant_name,
  l.tenant_id,
  sum(l.delta) AS balance,
  (SELECT max(created_at) FROM scanner_credit_ledger WHERE tenant_id = l.tenant_id) AS last_activity
FROM scanner_credit_ledger l
JOIN tenants t ON t.id = l.tenant_id
GROUP BY t.name, l.tenant_id
HAVING sum(l.delta) < 500 AND sum(l.delta) > 0
ORDER BY balance ASC;
```

## 3. Admin UI (not built yet)

Deferred until ~3 partners. When built, it would live under `apps/web/src/app/admin/partners/[tenantId]/page.tsx` and render these queries via the Supabase service-role client. File a ticket when the third partner signs.

## Gotchas

- `scanner_usage_events` has a **5-min lag** in the worst case — the flush happens via `waitUntil()` after each request, but if a partner isn't making requests, buffered rows sit until the next invocation flushes them. For a real-time view, query `scanner_credit_ledger` instead (every debit is synchronous).
- The `source` column on `scanner_credit_ledger` is formatted as `request:<uuid>` for consumes and `stripe_invoice_<id>` / `free_tier` for grants. Filter by prefix when building attribution reports.
- Deleting a partner's key (via revoke) keeps their historical rows intact — `scanner_key_id` column on events is `ON DELETE SET NULL`, so analytics stay accurate.
