# Epic 82: Scoped Capability Tokens

## Summary

Make agent identity the *default* posture and tenant-wide capability the explicit, time-boxed, audited exception. Today every agent connected via MCP runs with a tenant API key (`pk_live_*`) — broad enough to see and sign for siblings, which produces "Tina paid the wrong wallet" class bugs. After this epic, agents authenticate as themselves (Ed25519 sessions or `agent_*` tokens), can only see and act on their own resources, and request *per-intent* elevation to broader scopes via a user approval flow. The pattern mirrors `sudo` / IAM AssumeRole / OAuth incremental consent — established, well-understood, and the right primitive for an agentic platform.

Sits next to Epic 78 (Credential Vault) — same trust services neighborhood, complementary resource type. Vault stores *external* secrets; this stores *internal* capabilities.

## Motivation

Production incident pattern, documented in MEMORY against this codebase: Tina (an MCP-connected agent on tenant `aaaaaaaa-…-001`) tried to pay for image generation, picked the wrong agent's wallet (`Meridian Settlement Agent` — empty), reported "0 USDC, can't pay," when in fact a sibling agent (`TinaProvider`) had funds. Root cause was authentication: she was connected with a tenant API key, which is correctly scoped tenant-wide, so the LLM had to pick which agent to "be" on every paid call. With agent-bound auth and per-intent elevation, this entire class of confusion disappears — she can only see her own wallet, and any cross-agent operation requires user approval.

Three concrete user-visible wins:

1. **Agents can't accidentally spend from a sibling.** Auth model prevents it server-side (the route handlers already enforce `actorType === 'agent' && actorId !== id` checks; the gap is just that agents aren't using agent tokens).
2. **Sensitive operations get an interactive approval moment.** "Tina wants to bridge $50 from agent A to agent B — approve?" routed through MCP elicit / dashboard / push, decision recorded.
3. **Every elevation is auditable.** Tenant owner gets a `/dashboard/security/scopes` page showing every active grant, every elevation request, every standing grant in use, with one-click revoke.

## Prerequisites

- **Epic 78 (Vault)** primitives in place — at minimum, the `credential-vault` encryption service (`apps/api/src/services/credential-vault/index.ts`) and the `vault_audit` table pattern. Does not require the full vault MVP shipped first; can land in parallel.
- **Epic 72 (Ed25519 sessions)** already shipped — provides the `sess_*` token infrastructure that scope grants are anchored to.
- **Epic 84 (Agent Activity Audit)** is the consumer of every `auth_scope_audit` event but not a hard prereq — 82 ships its own audit table, 84 federates them later.

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/auth/scopes/request` | ✅ Yes | `sly.auth` | P0 | Agent requests elevation |
| `GET /v1/auth/scopes/active` | ✅ Yes | `sly.auth` | P0 | Agent reads its current scope |
| `POST /v1/auth/scopes/:requestId/decide` | ❌ Internal | dashboard / push handler | P0 | User-facing decision |
| `GET /v1/organization/scopes/grants` | ❌ Internal | dashboard | P0 | Tenant owner audit view |
| `DELETE /v1/organization/scopes/grants/:id` | ❌ Internal | dashboard | P0 | Revoke standing grant |
| `POST /v1/organization/scopes/grants` | ❌ Internal | dashboard | P1 | Issue standing grant |

**SDK Stories Required:**
- [ ] Story 82.X: Add `sly.auth.scopes` module to `@sly_ai/sdk`
- [ ] Story 82.Y: Add `request_scope`, `whoami` MCP tools to `@sly_ai/mcp-server`

## Design

### Scope tiers

| Scope | Meaning | Default for | Examples |
|---|---|---|---|
| `agent` | The calling agent only | Every `agent_*` / `sess_*` authenticated request | Sign own wallet, read own transfers, fetch own balance |
| `tenant_read` | All agents on the tenant, read-only | Tenant API keys | List sibling agents, audit cross-agent reputation, read tenant-wide aggregates |
| `tenant_write` | All agents on the tenant, mutate | Tenant owner JWT | Create new agent, modify policies, sign with sibling wallet |
| `treasury` | Move funds between agents | Tenant owner JWT, never auto | Bridge from agent A's EOA to agent B; cross-agent USDC sweep |

A request's `ctx.elevatedScope` is set by auth middleware when an active scope grant exists for the calling session. Route handlers gate via `requireScope(ctx, 'tenant_read')` instead of just `actorType === 'api_key'`. Handlers that don't call `requireScope` continue to behave as today (default-deny for cross-agent).

### Lifecycle of a scope grant

```
                    one_shot (per-intent)         standing (bypass)
                    ─────────────────────         ─────────────────
agent calls         POST /v1/auth/scopes/request  POST /v1/auth/scopes/request
                    { scope, purpose, intent }    { scope, durationMins, purpose }
                            │                              │
                            ▼                              ▼
                    pending_approvals row created (Epic 83)
                            │
                            ▼
                    user decides via channel
                    (MCP elicit / dashboard / push)
                            │
                            ▼
                    auth_scope_grants row inserted
                    lifecycle = 'one_shot' | 'standing'
                    expires_at = now + 60s    expires_at = now + durationMins
                            │
                            ▼
                    ctx.elevatedScope set on next request
                    handler executes
                            │
                            ▼
              one_shot: deleted on first use     standing: persists until expires_at or revoke
                            │                              │
                            ▼                              ▼
                    auth_scope_audit              auth_scope_audit
                    action='scope_used'           action='scope_used' (per use)
                                                  + daily heartbeat audit row
```

Critical invariants:

- **Agents can REQUEST scope, never GRANT.** The grant write happens server-side after a user decision arrives via Epic 83's approval queue.
- **Standing grants are tiered.** `tenant_read` allowed up to 1 hour; `tenant_write` up to 15 min; `treasury` cannot be standing — every use is per-intent.
- **One-shot grants are consumed on first use.** Replay protection: the row's `consumed_at` is set in the same transaction as the route handler's success path. A second request with the same grant 401s.
- **Standing grants emit a daily heartbeat to audit.** Even if dormant, the timeline shows an active standing grant existed on day N. Catches "I forgot I approved this" cases.
- **Kill switch on the agent cascades to all grants.** Same pattern as `apps/api/src/routes/agents.ts:2059` already does for kill-switching — extends to cancel all `auth_scope_grants` rows in `status='active'`.

### Bypass-permissions UX (consent gate)

The third button on every elevation prompt: `Approve & don't ask again for [scope] (15 min)`. Tiered limits:

| Scope | Bypass duration cap | Re-confirmation gate |
|---|---|---|
| `tenant_read` | up to 60 min | Standard click |
| `tenant_write` | up to 15 min | Type the agent's name to confirm |
| `treasury` | not allowed | — |

Mirrors Epic 78's plaintext-lease consent modal (typed-confirmation gate for high-risk operations). Active bypasses surfaced at top of `/dashboard/security/scopes` with one-click revoke.

### Default `agentId` from context

Today every paid MCP tool requires `agentId` as input — necessary when called via tenant key, redundant and dangerous when called via agent token. After this epic, any tool whose schema currently lists `agentId` as required gets it marked optional, with default `ctx.actorId` filled server-side when `actorType === 'agent'`. Tools affected: `x402_fetch`, `agent_x402_sign`, `agent_wallet_get`, `get_agent_transactions`, `get_agent_limits`, `get_agent`, `agent_fund_eoa`, `agent_refill_faucet`, `agent_wallet_freeze`/`unfreeze`, `wallet_topup_link`, `agent_evm_key_provision`, `agent_enable_auto_refill`/`disable_auto_refill`/`auto_refill_status`. Tenant-key callers can still pass `agentId` explicitly — that path is unchanged.

A new MCP tool, `whoami`, returns `{ actorType, actorId, agentName, kyaTier, scopes: ['agent'], elevatedScopeActive: false }` so an LLM can verify its identity without guessing.

## Code changes

### 1. Schema — `apps/api/supabase/migrations/YYYYMMDD_auth_scope_grants.sql`

```sql
CREATE TABLE auth_scope_grants (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_session_id   UUID,                  -- FK to agent_sessions when issued from a sess_* token; NULL when standing-grant via dashboard
  scope               TEXT NOT NULL CHECK (scope IN ('tenant_read','tenant_write','treasury')),
  lifecycle           TEXT NOT NULL CHECK (lifecycle IN ('one_shot','standing')),
  status              TEXT NOT NULL CHECK (status IN ('active','consumed','revoked','expired')),
  purpose             TEXT NOT NULL,         -- short-form rationale shown to user at decision time
  intent_payload      JSONB,                 -- structured intent: tool name, args, target ids
  granted_by_user_id  UUID NOT NULL,         -- always present; the user who approved
  granted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at         TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ NOT NULL,
  last_used_at        TIMESTAMPTZ,
  use_count           INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_scope_grants_active
  ON auth_scope_grants (tenant_id, agent_id, status)
  WHERE status = 'active';
CREATE INDEX idx_scope_grants_session
  ON auth_scope_grants (parent_session_id, status)
  WHERE parent_session_id IS NOT NULL;

CREATE TABLE auth_scope_audit (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  grant_id            UUID,
  agent_id            UUID,
  scope               TEXT,
  action              TEXT NOT NULL CHECK (action IN (
    'scope_requested', 'scope_granted', 'scope_denied',
    'scope_used', 'scope_expired', 'scope_revoked',
    'scope_heartbeat'
  )),
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('user','agent','system','api_key')),
  actor_id            UUID,
  request_summary     JSONB,                 -- { mcp_tool, route, request_id, decision_channel }
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_scope_audit_tenant_time ON auth_scope_audit (tenant_id, created_at DESC);
CREATE INDEX idx_scope_audit_agent_time  ON auth_scope_audit (agent_id, created_at DESC);
```

RLS: tenant-scoped read for authenticated users matching `user_profiles.tenant_id`; service-role bypass for the API. Mirrors `vault_audit` policies in `epic-78-agentic-credential-vault.md` Story 78.1.

### 2. Services

**`apps/api/src/services/auth/scopes/index.ts`** — grant resolution, request/decision flow, heartbeat job.

```ts
export async function requireScope(ctx: RequestContext, required: 'tenant_read'|'tenant_write'|'treasury'): Promise<void>;
export async function requestScope(args: { ctx, scope, purpose, intent, durationMins?, lifecycle? }): Promise<{ requestId: string }>;
export async function decideScope(args: { requestId, userId, decision: 'approve'|'deny', durationMins? }): Promise<{ grantId?: string }>;
export async function listActiveGrants(ctx: RequestContext): Promise<ScopeGrant[]>;
export async function revokeGrant(grantId: string, byUserId: string): Promise<void>;
```

`requireScope` reads `ctx.elevatedScope` (set by auth middleware), and if absent, throws a structured `ScopeRequiredError` carrying the required scope and a request_id pre-populated by the API for the MCP layer to wrap into an elicit prompt. Critical: handlers throw, never silently 403, so the MCP layer can prompt the user and retry the call within the same conversation turn.

**`apps/api/src/services/auth/scopes/heartbeat.ts`** — daily worker that writes `scope_heartbeat` audit rows for every active standing grant, plus expires grants whose `expires_at` has passed.

### 3. Auth middleware

`apps/api/src/middleware/auth.ts` extension — after the agent/session token verification path sets `ctx.actorType = 'agent'`, query `auth_scope_grants` for any `status='active'` row keyed to either the parent session (Ed25519 path) or the agent (long-lived `agent_*` path) whose `expires_at > now()`, and set `ctx.elevatedScope` to the highest-tier active grant. Cache result on the existing agent-token cache (5-second TTL) so the lookup doesn't bloat per-request latency.

### 4. HTTP routes

**`apps/api/src/routes/auth-scopes.ts`** — agent surface:
- `POST /v1/auth/scopes/request` — body `{ scope, purpose, intent, durationMins?, lifecycle: 'one_shot'|'standing' }`. Writes a `pending_approvals` row (Epic 83), returns `{ requestId, status: 'pending', expires_at }`. Auth required: any agent token.
- `GET /v1/auth/scopes/active` — returns the grants currently in effect for the calling agent. Auth: agent token.
- `GET /v1/auth/scopes/:requestId` — poll a pending request's status. Auth: the requesting agent only.

**`apps/api/src/routes/organization/scopes.ts`** — tenant-owner surface, mounted at `/v1/organization/scopes`:
- `GET /grants` — list active + recent grants across all agents. Auth: tenant-owner JWT.
- `POST /grants` — issue a standing grant directly (no agent request involved). Auth: tenant-owner JWT.
- `DELETE /grants/:id` — revoke. Auth: tenant-owner JWT.
- `GET /audit?agent_id=&scope=&since=` — paginated audit query. Auth: tenant-owner JWT.

### 5. MCP tools

Add to `packages/mcp-server/src/tools.ts` + handlers in `server-factory.ts`:

1. **`whoami({})`** — returns `{ actorType, actorId, agentName, kyaTier, parentAccountId, environment, walletAddress?, balance?, activeScopes }`. Lets the LLM know who it is and what it can do without guessing.
2. **`request_scope({ scope, purpose, intent?, durationMins?, lifecycle? })`** — submit an elevation request, blocks awaiting decision via Epic 83's approval flow. Returns `{ requestId, decision, grantId? }` once decided or `{ requestId, decision: 'timeout' }` on no-response.
3. **`list_active_scopes({})`** — readable inventory of what the caller currently has, including bypasses.

Existing MCP tools that take `agentId`: schema becomes optional with description "Defaults to the authenticated agent when called via agent auth; required when called via tenant API key."

### 6. Dashboard — `apps/web`

- **`/dashboard/security/scopes/page.tsx`** — overview: active standing grants table (agent, scope, expires, last used, revoke button), recent decisions log, top-10 scope users.
- **`/dashboard/security/scopes/[grantId]/page.tsx`** — single grant detail: lifecycle log, every use with request context, revoke button.
- **`/dashboard/agents/[id]/scopes` tab** — per-agent scope history.
- **Approval modal component** — reused for the consent-gate UX (typed agent name for `tenant_write`); fed by Epic 83's three channels.

### 7. Governance integration

- **Kill switch (`apps/api/src/routes/agents.ts:2059`)** must cascade-revoke every `auth_scope_grants` row in `status='active'` for the agent. Done in Story 82.5.
- **Wallet freeze** must block scope requests as well as paid operations. Add check in `requestScope` service.
- **KYA tier gates standing-grant duration.** Tier 0 agents cannot hold standing grants; tier 1 max 15 min; tier 2 max 1 hour; tier 3 (Trusted) max 4 hours.
- **Encryption.** `intent_payload` may contain user prompts (PII). Encrypt at rest using `credential-vault.encryptAndSerialize` per Epic 78 patterns; decrypt only when the tenant owner views audit detail. (Future: tenant-held KEK per Epic 84a — until that lands, server-key encryption is the floor.)

## Story breakdown (~22 pts MVP)

| # | Story | Points |
|---|---|---|
| 82.1 | Migration + RLS + indexes for `auth_scope_grants` and `auth_scope_audit` | 2 |
| 82.2 | `requireScope` middleware + `requestScope`/`decideScope` services + ScopeRequiredError | 3 |
| 82.3 | Auth middleware extension to populate `ctx.elevatedScope` from active grants | 2 |
| 82.4 | Agent-side routes: `/v1/auth/scopes/request`, `/active`, `/:id` | 2 |
| 82.5 | Tenant-owner routes + kill-switch cascade + wallet-freeze gate | 3 |
| 82.6 | MCP tools: `whoami`, `request_scope`, `list_active_scopes` + `agentId`-optional shim across existing agent tools | 3 |
| 82.7 | Dashboard `/security/scopes` + per-agent scopes tab + revoke flow | 3 |
| 82.8 | Daily heartbeat + expiration worker + audit emission | 1 |
| 82.9 | Encryption of `intent_payload` via credential-vault service | 1 |
| 82.10 | Bypass consent-gate modal (typed-confirmation for tenant_write) | 2 |

**MVP: ~22 story points.** Ship incrementally — 82.1–82.4 alone (~9pts) gives agent-side request flow with manual tenant-owner approval via SQL or basic dashboard. 82.5–82.7 adds the proper UX. 82.8–82.10 hardens.

### Shipped status (2026-04-26)

Epic 82 is **feature-complete** modulo Story 82.9 (gated on Epic 84a). User-facing usage guide: [`docs/guides/onboarding/SCOPE_GRANTS_GUIDE.md`](../../guides/onboarding/SCOPE_GRANTS_GUIDE.md).

| Story  | Status   | Landed in                                                                   |
|--------|----------|-----------------------------------------------------------------------------|
| 82.1   | ✅       | `apps/api/supabase/migrations/20260426_auth_scope_grants.sql` (+ env-denorm migration applied via `mcp__supabase__apply_migration` named `auth_scope_env_denorm`) |
| 82.2   | ✅       | `apps/api/src/services/auth/scopes/index.ts`, `apps/api/src/services/auth/scopes/guard.ts` |
| 82.3   | ✅       | `apps/api/src/middleware/auth.ts` — `lookupElevatedScope()` runs on every request, including cache hits, so consumption/revoke is reflected immediately |
| 82.4   | ✅       | `apps/api/src/routes/auth-scopes.ts` (mounted at `/v1/auth/scopes/{request,active,:requestId}`) |
| 82.5   | ✅       | `apps/api/src/routes/organization/scopes.ts`. Kill-switch cascade in `apps/api/src/routes/agents.ts` `:id/kill-switch` handler. Wallet-freeze cascade in `apps/api/src/routes/agent-wallets.ts` `:agentId/wallet/freeze`. |
| 82.6   | ✅       | `packages/mcp-server@0.5.0` (`request_scope`, `scope_status`, `whoami`); `agentId` auto-fill via `resolveAgentId` in `server-factory.ts` |
| 82.7   | ✅       | `apps/web/src/app/dashboard/security/scopes/page.tsx` (full CRUD: pending/approve/deny, active/revoke, audit, search/filter, issue modal, refresh). Per-agent tab on `apps/web/src/app/dashboard/agents/[id]/page.tsx` (`ScopesTab`). |
| 82.8   | ✅       | `apps/api/src/workers/scope-expiration-sweeper.ts` (5-min tick, flips `expires_at` past → `expired`) + `apps/api/src/workers/scope-heartbeat.ts` (1h tick, emits `scope_heartbeat` per active standing grant per 24h). |
| 82.9   | ⏸ Deferred | Blocked on Epic 84a (tenant-held KEKs). `intent_payload` is currently stored unencrypted but server-side only — no PII surface to web. |
| 82.10  | ✅       | `ConfirmApprovalModal` in `apps/web/src/app/dashboard/security/scopes/page.tsx` — typed-confirmation gate on Approve for `tenant_write` and `treasury`. `tenant_read` stays one-click. |

#### Bonus shipped (not in original spec)

- **API-key path for issue/decide/revoke** — tenant API keys can drive the lifecycle without a JWT login. `granted_by_user_id` is auto-resolved to the tenant's primary owner so the audit invariant is preserved. Marker: `request_summary.granted_via_api_key: true`.
- **Environment scoping** — `auth_scope_grants` and `auth_scope_audit` carry an `environment` column (denormalized from agent.environment at insert time). All read endpoints default to caller-env; `?env=all` opts out.
- **Treasury gates** — `POST /v1/agents/:id/smart-wallet/send-usdc` and `/fund-eoa` were previously hardcoded "agent can only act on own wallet." Now route through `treasury` scope when calling on a sibling. Self-action bypasses the gate (preserves pre-Epic-82 semantics).
- **Searchable agent filter popover** — replaces what was an unworkable chip wall once tenants have many agents. Backed by `@sly/ui` Popover + scoped to current env.
- **`?agent_id=` param** on `/v1/organization/scopes` and `.../audit` — powers the per-agent tab.
- **Side-fixes surfaced by validation** (committed separately, not Epic-82 scope but related):
  - `apps/api/src/middleware/response-wrapper.ts` — ApiError subclasses (LimitExceededError etc) were getting routed through the supabase-error path → misleading `DATABASE_ERROR retryable:true`. Reordered dispatch.
  - `apps/api/src/routes/agents.ts` — `POST /v1/agents` now accepts `parent_account_id` (snake_case) alongside `accountId` and `parentAccountId`. Was silently dropped before.

#### Validation history

Validated end-to-end via spawned subagent harness across multiple runs. Each iteration's findings were captured in commits + the audit table itself. Highlights:

- First run found **two CRITICAL cache-invalidation bugs** (one_shot consumption didn't gate; standing-grant revoke didn't cut access) — both rooted in the `AGENT_TOKEN_CACHE` retaining `ctx.elevatedScope` for 60s past lifecycle changes. Fixed in `99e065f` (always re-query scope on every request, including cache hits).
- Second run found `listActiveGrants` mapper stripping `environment` field from API response (DB row was correct). Fixed in `1551993`.
- All four originally-failing assertions re-validated green after fixes; treasury scope re-validated as a separate pass.

### Phase 2 backlog (~10pts)

- Cross-tenant scope grants (consortium use case) — 5pts
- Scope inheritance for nested agents (Epic 73 child agents) — 3pts
- Per-route scope hints on the OpenAPI spec for client-side prompting — 2pts

### Phase 3 / out of scope

- Hardware-key-bound scope grants (WebAuthn/passkey for `treasury`).
- Cryptographically chained scope grants (each grant is a SD-JWT verifiable by counterparties).
- Auto-elevation based on agent reputation (high-trust agents get tenant_read by default).

## Risks

- **Approval fatigue.** If every cross-agent operation prompts, users will start auto-approving without reading. Mitigation: risk-tier routing in Epic 83 + bypass-permissions for low-risk read paths + dashboard-side "approval frequency" alerting.
- **Race condition on one-shot grant consumption.** If two parallel requests arrive carrying the same grant, both may pass the active-check before the first sets `consumed_at`. Mitigation: optimistic `UPDATE … WHERE status = 'active'` with row count check; second update reports zero rows and 401s.
- **Latency cost of auth middleware extension.** Every authenticated request now does a scope-grants lookup. Mitigation: cache active grants on the existing 5-second agent-token cache; only invalidate on grant write events.
- **Tenant locked out of own data via standing-grant misuse.** A bad actor with momentary tenant-owner access could issue a 4-hour `tenant_write` standing grant to a compromised agent. Mitigation: any `tenant_write`+ standing grant longer than 30 min triggers a confirmation email to *all* tenant owners + a security webhook.
- **Migration of existing tenant-key-using agents.** Today's MCP-connected agents use `pk_live_*` and would break on default-deny if the agent token isn't provisioned. Mitigation: ship 82.6 (the `whoami` + tools-go-optional change) AFTER 82.1–82.5 are live and the dashboard exposes agent-token rotation, so tenants can migrate at their own pace. Until they migrate, tenant API keys continue to work as today.

## Related epics

- **Epic 78 — Agentic Credential Vault.** Trust services neighbor; reuses `credential-vault` encryption service and `vault_audit` patterns. Capability tokens are NOT credentials but share infrastructure.
- **Epic 83 — Pending Approvals Queue.** This epic depends on 83 for the user-decision UX (MCP elicit / dashboard / push). Stub initial implementation: 82 ships with dashboard-only approval surface, 83 generalizes to three channels.
- **Epic 84 — Agent Activity Audit.** 84's per-agent audit page surfaces `auth_scope_audit` entries alongside `audit_log`, `vault_audit`. 82 writes to its own audit table; 84 federates the read view.
- **Epic 84a — Tenant-Held Encryption Keys.** Future foundation: when 84a lands, `intent_payload` encryption uses tenant KEK so Sly engineers cannot decrypt PII even from the DB. Until then, server-key encryption is the floor.
- **Epic 72 — Ed25519 Session Tokens.** Provides the `sess_*` infrastructure that one-shot grants are anchored to via `parent_session_id`.
- **Epic 73 — KYA Tier Limits.** Read by `requireScope` when sizing default standing-grant durations.

## Critical files to reference during implementation

- `apps/api/src/middleware/auth.ts:480` — agent token verification path; `ctx.elevatedScope` population goes here
- `apps/api/src/routes/agents.ts:2772` — existing `actorType === 'agent' && actorId !== id` enforcement pattern
- `apps/api/src/utils/crypto.ts` — `generateSessionToken`, `hashApiKey`; reuse for grant-id generation if needed
- `apps/api/src/services/credential-vault/index.ts` — `encryptAndSerialize`/`deserializeAndDecrypt` for `intent_payload`
- `apps/api/supabase/migrations/20260120_connected_accounts.sql` — RLS template
- `apps/api/supabase/migrations/20260424_x402_vendor_ratings.sql` — partial-unique-index pattern
- `packages/mcp-server/src/server-factory.ts` — MCP tool dispatch + ScopeRequiredError → elicit wrapper
- `packages/mcp-server/src/tools.ts` — existing tool definitions; `agentId`-required → optional shim point
- `apps/web/src/app/dashboard/agents/[id]/page.tsx` — extend with scopes tab
- `docs/prd/epics/epic-78-agentic-credential-vault.md` — pattern template

## Open questions deferred to implementation

- **MCP elicit fallback strategy when client doesn't support it.** Some MCP clients (older Claude Desktop, custom integrations) don't implement `elicitation/create`. Plan: server detects via client capability negotiation; if unavailable, falls back to dashboard-banner-only routing for that session and the agent receives a structured 412 PRECONDITION_REQUIRED error with a deeplink to the dashboard approval. Confirm during 82.6 implementation.
- **Scope grant SD-JWT representation.** A future use case is letting agents present a grant as a verifiable credential to counterparty agents (A2A scenarios). For v1 the grant is server-side only; the JWT/SD-JWT export is Phase 2.
- **Idempotency on `request_scope`.** Should a duplicate request_scope call within 30s of a pending one return the existing requestId, or 409? Lean toward returning existing — agents retrying due to network blips shouldn't multiply approval prompts.
