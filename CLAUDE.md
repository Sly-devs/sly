# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ CRITICAL: UI Development Location

**NEVER use `payos-ui/` for any new development.** It is DEPRECATED.

All UI work MUST be done in `apps/web/` (Next.js application).

- ❌ `payos-ui/` - DEPRECATED, do not use
- ✅ `apps/web/` - Active UI development (Next.js, port 3000)

```bash
# Start the CORRECT UI
pnpm --filter @sly/web dev
```

## Project Overview

Sly is a B2B stablecoin payout operating system for LATAM. It's a monorepo featuring a Hono-based API server, a Next.js dashboard UI, and shared packages. The system enables fintech partners to offer stablecoin-powered payouts with AI-native agent support and money streaming capabilities.

**Key Differentiators:**
- **KYA (Know Your Agent) Framework**: AI agents are first-class actors with formal verification tiers
- **Money Streaming**: Real-time per-second payment flows (not just batch transfers)
- **Multi-Tenant Architecture**: Partner organizations isolated via Row-Level Security (RLS)
- **Triple Authentication**: Supports API keys, JWT sessions, and agent tokens

## Common Commands

### Development
```bash
# Install dependencies
pnpm install

# Build all packages (required before dev/test)
pnpm build

# Start API server (http://localhost:4000)
pnpm --filter @sly/api dev

# Start UI (http://localhost:3000) - USE THIS, NOT payos-ui
pnpm --filter @sly/web dev

# Start everything
pnpm dev
```

### npm Package Publishing
```bash
# Publish all public packages to npm (@sly_ai scope)
pnpm publish:all

# Publish individually
pnpm publish:sdk    # @sly_ai/sdk
pnpm publish:cli    # @sly_ai/cli
pnpm publish:mcp    # @sly_ai/mcp-server
```

**When to publish**: Bump the version in the package's `package.json` and run the publish command after any changes to `packages/sdk/`, `packages/cli/`, or `packages/mcp-server/` that affect the public API or fix bugs. The workspace uses `@sly_ai/*` for npm-published packages and `@sly/*` for internal-only packages (types, utils, ui, etc.).

### Testing
```bash
# Run all tests
pnpm test

# Run only unit tests
pnpm test:unit

# Run only integration tests (requires Supabase connection)
INTEGRATION=true pnpm test:integration

# Run specific test file
pnpm --filter @sly/api test tests/unit/helpers.test.ts

# Coverage report
pnpm test:coverage
```

### Database Operations
```bash
# Seed demo data (Demo Fintech tenant with sample accounts/agents/transfers)
pnpm --filter @sly/api seed:db

# Check RLS policy coverage
pnpm --filter @sly/api check:rls

# Run custom scripts
pnpm --filter @sly/api tsx scripts/setup-beta-tenant.ts
```

### Type Checking & Linting
```bash
# Type check everything
pnpm typecheck

# Lint code
pnpm lint
```

## Architecture

### Monorepo Structure
```
sly/
├── apps/
│   ├── api/              # Hono API server (port 4000)
│   │   ├── src/
│   │   │   ├── routes/   # API route handlers (accounts, agents, transfers, etc.)
│   │   │   ├── middleware/ # Auth, error handling, rate limiting, security
│   │   │   ├── services/ # Business logic (balances, streams, exports, limits)
│   │   │   ├── workers/  # Background jobs (scheduled transfers)
│   │   │   ├── db/       # Supabase client setup
│   │   │   ├── utils/    # Crypto, auth helpers
│   │   │   ├── app.ts    # Hono app configuration
│   │   │   └── index.ts  # Server entry point
│   │   ├── supabase/migrations/ # Database schema & RLS policies
│   │   ├── scripts/      # Seed data, setup helpers
│   │   └── tests/        # Unit & integration tests
│   ├── scanner/          # Agentic Commerce Demand Scanner (port 4100) ← Epic 56
│   │   ├── src/
│   │   │   ├── probes/   # Protocol detection (UCP, ACP, x402, AP2, MCP, NLWeb, Visa VIC, Mastercard)
│   │   │   ├── analyzers/ # Structured data, accessibility, checkout friction, scoring
│   │   │   ├── queue/    # Batch processor with p-limit
│   │   │   ├── demand/   # Intelligence, synthetic tests, observatory, telemetry
│   │   │   ├── mcp/      # MCP server + 13 tool definitions
│   │   │   ├── routes/   # Hono API routes
│   │   │   ├── db/       # Supabase client & query helpers
│   │   │   └── index.ts  # Hono entry point
│   │   └── seed/         # Pre-built scan lists (1,000 merchants)
│   └── web/              # Next.js dashboard (port 3000) ← ACTIVE UI
│       ├── src/
│       │   ├── app/      # App Router pages
│       │   ├── components/ # React components
│       │   ├── lib/      # API client, utilities
│       │   └── hooks/    # Custom hooks
├── packages/
│   ├── sdk/              # Unified SDK (@sly/sdk)
│   ├── types/            # Shared TypeScript types
│   ├── utils/            # Shared utilities
│   ├── cards/            # Card network integrations (Visa VIC, Mastercard Agent Pay)
│   ├── api-client/       # API client library
│   ├── ui/               # Shared UI components
│   └── db/               # Database migration utilities
└── payos-ui/             # ⚠️ DEPRECATED - DO NOT USE
```

### Authentication Flow

The API supports three authentication methods (see `apps/api/src/middleware/auth.ts:76`):

1. **API Key Auth** (`pk_test_*` or `pk_live_*`)
   - Primary auth for partner integrations
   - Stored with prefix + hash in `api_keys` table
   - Fallback to legacy `tenants.api_key_hash` for backwards compatibility
   - Environment-aware (test vs live)

2. **JWT Session Auth** (tokens starting with `eyJ`)
   - Used by dashboard UI for logged-in users
   - Verified via Supabase Auth `getUser()` method
   - User profile looked up in `user_profiles` table
   - Includes role-based permissions (owner/admin/member/viewer)
   - Tokens expire in 15 minutes, auto-refresh at 14 minutes (see `payos-ui/src/hooks/useAuth.tsx:208`)

3. **Agent Token Auth** (`agent_*`)
   - For AI agents acting autonomously
   - Stored with prefix + hash in `agents` table
   - Validates agent status and KYA tier
   - Fallback to legacy `auth_client_id` for backwards compatibility

**Important**: All `/v1/*` routes require authentication. Health/ready checks and auth routes are public.

### Request Context

After authentication, `authMiddleware` sets `c.set('ctx', RequestContext)` containing:
- `tenantId`: Organization identifier for RLS filtering
- `actorType`: 'api_key' | 'user' | 'agent'
- `userId`, `userRole`, `userName`: (for JWT auth)
- `apiKeyId`, `apiKeyEnvironment`: (for API key auth)
- `actorId`, `actorName`, `kyaTier`: (for agent auth)

All route handlers access this via `c.get('ctx')` to enforce tenant isolation.

### Database & RLS (Row-Level Security)

**Database**: Supabase (Postgres) with strict RLS policies for multi-tenancy.

**Critical RLS Pattern**: Every query MUST filter by `tenant_id` to prevent cross-tenant data leaks. The auth middleware sets the tenant context, but application code must explicitly filter:

```typescript
// CORRECT - filters by tenant
const { data } = await supabase
  .from('accounts')
  .select('*')
  .eq('tenant_id', ctx.tenantId);

// WRONG - exposes all tenants' data
const { data } = await supabase.from('accounts').select('*');
```

**RLS Policies**: Located in `apps/api/supabase/migrations/`. All tables have RLS enabled. Use `pnpm --filter @sly/api check:rls` to audit coverage.

**Database Clients**:
- `src/db/client.ts`: Uses `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS - use with explicit tenant filtering)
- `src/db/admin-client.ts`: Admin operations (create users, set JWT claims)

**Migrations**: SQL files in `apps/api/supabase/migrations/` are run manually or via Supabase CLI. Naming: `YYYYMMDD_description.sql`.

### API Response Patterns

**Standard Response**:
```typescript
// Single resource
return c.json({ id, name, status, ... });

// Collection
return c.json({
  data: [...items],
  pagination: { page, limit, total, totalPages }
});
```

**Error Handling** (see `apps/api/src/middleware/error.ts:69`):
- Custom errors: `ApiError`, `NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`
- All errors return `{ error: string, details?: unknown }`
- HTTP status codes: 400 (validation), 401 (auth), 403 (forbidden), 404 (not found), 500 (server error)

### UI Data Fetching

**Custom Hooks** (`payos-ui/src/hooks/api/useApi.ts`):
- `useApi<T>(endpoint)`: GET requests with loading/error states, auto-retry, token refresh
- `useApiMutation<TReq, TRes>()`: POST/PUT/PATCH/DELETE with token refresh handling

**Token Refresh Flow**:
1. Request receives 401
2. `useApi`/`useApiMutation` calls `refreshAccessToken()`
3. If refresh succeeds, retry original request
4. If refresh fails, logout user

**Environment Variables**:
- UI uses `VITE_API_URL` (default: http://localhost:4000)
- API uses `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `API_PORT`, `CORS_ORIGINS`

### Core Domain Concepts

**Tenant**: A fintech partner organization. All data is scoped to a tenant (enforced via RLS).

**Account**: A person or business entity that holds funds. Has KYC/KYB verification tiers (0-3).

**Agent**: An AI actor registered under an Account. Has KYA verification tiers (0-3) and spending limits. Can initiate transfers and manage streams based on permissions.

**Transfer**: One-time movement of funds (types: cross_border, internal, stream_start/withdraw/cancel, wrap/unwrap). Statuses: pending → processing → completed/failed/cancelled.

**Stream**: Continuous per-second payment flow. Has flow rate, wrapped funds, buffer, runway. Managed by users or agents with granular permissions (canModify, canPause, canTerminate).

**Quote**: FX rate quote for cross-border transfers (expires after TTL).

**Scheduled Transfer**: Future-dated transfer executed by background worker (`apps/api/src/workers/scheduled-transfers.ts`). Worker runs every 30s in mock mode, 60s in production.

### Rate Limiting & Security

**Middleware Stack** (see `apps/api/src/app.ts:34`):
1. Request ID (tracing)
2. Security headers (CSP, HSTS, etc.)
3. CORS (configurable origins)
4. Logger (dev only)
5. Pretty JSON (dev only)
6. Rate limiter (100 req/min per IP)
7. Auth rate limiter (stricter for auth endpoints)
8. Auth middleware
9. Error handler

**Rate Limits** (`apps/api/src/middleware/rate-limit.ts`):
- General API: 100 requests/min per IP
- Auth endpoints: 5 requests/min per IP
- Headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

**Security Headers** (`apps/api/src/middleware/security.ts`):
- CSP, X-Frame-Options, HSTS, X-Content-Type-Options
- Request ID for distributed tracing

### Testing Strategy

**Unit Tests** (`apps/api/tests/unit/`):
- Test route handlers, helpers, services in isolation
- Mock Supabase client responses
- Fast, no external dependencies

**Integration Tests** (`apps/api/tests/integration/`):
- Require live Supabase connection
- Test full request/response cycle
- Test RLS policies, multi-tenant isolation
- Run with `INTEGRATION=true` env var

**Test Setup** (`apps/api/tests/setup.ts`):
- Configures vitest with 10s timeout
- Provides test helpers and fixtures

**Important**: Always run `pnpm build` before running tests (packages must be built for imports to resolve).

### Background Workers

**Scheduled Transfers Worker** (`apps/api/src/workers/scheduled-transfers.ts`):
- Polls for transfers with `scheduled_at <= NOW()` and `status = 'pending'`
- Executes transfers atomically
- Runs every 30s in mock mode (`MOCK_SCHEDULED_TRANSFERS=true`), 60s in production
- Gracefully shuts down on SIGTERM/SIGINT

**Mock Mode**: Set `MOCK_SCHEDULED_TRANSFERS=true` or `NODE_ENV=development` to skip external PSP calls.

## Important Patterns & Conventions

### Adding New API Routes

1. Create route handler in `apps/api/src/routes/`
2. Import and mount in `apps/api/src/app.ts` (line 117-133)
3. Add types to `packages/types/src/index.ts`
4. Write unit tests in `tests/unit/`
5. Write integration tests in `tests/integration/`
6. Update PRD if this is a new Epic/Story

### Database Migrations

1. Create new SQL file: `apps/api/supabase/migrations/YYYYMMDD_description.sql`
2. Include RLS policies for all new tables
3. Test with `check:rls` script
4. Run migration via Supabase CLI or manually

### Agent Permissions & Limits

**KYA Tiers**:
- Tier 0: Basic (low limits)
- Tier 1: Standard (moderate limits)
- Tier 2: Advanced (high limits)
- Tier 3: Enterprise (very high limits)

**Effective Limits**: `min(agentLimit, parentAccountLimit)` - agents can't exceed parent account's verification tier limits.

**Permissions**: Agents have granular permissions for transactions, streams, accounts, treasury. Check permissions before allowing actions.

### Error Handling Best Practices

1. Use custom error classes (`NotFoundError`, `ValidationError`, etc.)
2. Include helpful details in error responses
3. Don't leak sensitive info in production errors
4. Log all errors for debugging
5. Return appropriate HTTP status codes

### Security Reminders

1. **Never skip tenant filtering** - always filter by `tenant_id`
2. **Validate all inputs** - use Zod schemas for request validation
3. **Use constant-time comparison** for secrets (`verifyApiKey()` uses `crypto.timingSafeEqual`)
4. **Rate limit auth endpoints** strictly
5. **Log security events** (failed auth, suspicious activity)
6. **Expire sessions** appropriately (15 min for JWT)
7. **Hash sensitive tokens** - never store plaintext API keys/agent tokens

## Scanner Service (Epic 56)

**Spec**: `docs/prd/epics/epic-56-agentic-commerce-demand-scanner.md`

The scanner is a standalone Hono service (`apps/scanner`, port 4100) that scans merchant websites for agentic commerce readiness. It detects protocol support (UCP, ACP, x402, AP2, MCP, NLWeb, Visa VIC, Mastercard), analyzes structured data and checkout friction, computes readiness scores, and powers demand intelligence.

### Three Operational Modes

1. **API On-Demand**: `POST /v1/scanner/scan` — single domain, 2-5 seconds
2. **CSV Batch Upload**: `POST /v1/scanner/scan/batch` — queue processes 10-20 concurrent, 1,000 merchants in ~5-8 min
3. **MCP Server for Claude**: 13 tools via stdio transport — Claude becomes dashboard, report generator, sales prep tool

### Scanner Commands

```bash
# Start scanner service
pnpm --filter @sly/scanner dev

# Start scanner MCP server (stdio mode for Claude Desktop)
pnpm --filter @sly/scanner mcp
```

### Key Dependencies

`undici` (HTTP), `cheerio` (HTML parsing), `p-limit` (concurrency), `csv-parse` (batch import), `@modelcontextprotocol/sdk` (MCP server), `zod` (validation), `hono` (HTTP framework), `@supabase/supabase-js` (storage). **No Puppeteer** — lightweight HTTP probing only.

### Scanner Types

Shared scanner types go in `packages/types/src/scanner.ts` and `packages/types/src/demand.ts`. Readiness score algorithm goes in `packages/utils/src/readiness-score.ts`.

### Scanner Database Migrations

Migrations for scanner tables go in `packages/db/migrations/` (or `apps/api/supabase/migrations/` following existing pattern):
- `020_scanner_tables.sql` — scan results, protocol detections, structured data
- `021_demand_intelligence.sql` — demand signals, agent behavior observations
- `022_agent_shopping_tests.sql` — synthetic test runs and results

### Implementation Sequence

Stories are numbered 56.1–56.24 (138 total points). Build order:
1. **56.1–56.4**: Core probes + analyzers + scoring (pure functions, no DB)
2. **56.5 + 56.7**: Batch queue + API routes → Modes 1 & 2 live
3. **56.14**: MCP server → Mode 3 live
4. **56.6**: Seed data loaded
5. **56.19–56.21**: Demand intelligence + synthetic tests + observatory
6. **56.11 + 56.18**: Public audit tool + 1,000-merchant baseline scan

## Documentation

**PRD**: `docs/prd/` - Product requirements with Epic Dashboard
**Migration Docs**: `docs/guides/development/mock-to-api-migration.md` - Guide for transitioning from mock to real APIs
**Onboarding**: `docs/guides/onboarding/` - Onboarding guides
**Completed Work**: `docs/completed/` - Epic/Story implementation summaries and session notes

## Common Issues

**Build fails**: Run `pnpm build` from root to build all packages in dependency order.

**Tests fail with import errors**: Packages must be built before tests run. Use `pnpm build` first.

**RLS errors in tests**: Integration tests require `INTEGRATION=true` and valid Supabase credentials.

**Token refresh loops**: Check that `refreshAccessToken()` correctly updates localStorage and doesn't retry infinitely.

**Cross-tenant data leak**: Verify all Supabase queries include `.eq('tenant_id', ctx.tenantId)`.

**Type errors in UI**: Make sure `@sly/types` package is built and up-to-date.

## Security Rules for Claude Code

- **NEVER commit credentials, passwords, API keys, or tokens** in scripts, config files, or any tracked file. If a one-off script needs credentials, write it to `/tmp/` and run it from there — never inside the repo tree.
- **NEVER create new script files inside the repo** that contain hardcoded secrets (passwords, API keys, tokens, connection strings). Use environment variables instead.
- If you need to share credentials with the user, output them to the terminal only — do not write them to any file that could be committed.

## Key Files Reference

- **API Entry**: `apps/api/src/index.ts:1` - Server startup
- **App Config**: `apps/api/src/app.ts:32` - Middleware & route mounting
- **Auth Middleware**: `apps/api/src/middleware/auth.ts:76` - Triple auth implementation
- **Error Handler**: `apps/api/src/middleware/error.ts:69` - Global error handling
- **DB Client**: `apps/api/src/db/client.ts:5` - Supabase connection
- **UI Auth Hook**: `payos-ui/src/hooks/useAuth.tsx:82` - Login/signup/logout/refresh
- **UI API Hook**: `payos-ui/src/hooks/api/useApi.ts:48` - Authenticated requests with retry
- **Types Package**: `packages/types/src/index.ts:1` - Shared types
- **Seed Script**: `apps/api/scripts/seed-database.ts` - Demo data seeding
- **RLS Check**: `apps/api/scripts/check-rls-in-migrations.ts` - RLS audit tool
