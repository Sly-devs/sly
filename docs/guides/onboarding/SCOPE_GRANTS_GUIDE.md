# Scope Grants Guide (Epic 82)

## Overview

By default, an agent token (`agent_*` or `sess_*`) is **single-agent-scoped** — the agent can only act on its own resources. Reading sibling agents, mutating their state, or moving funds between agents requires an **explicit, audited capability grant** issued by a tenant owner.

This is the same security model as a Unix `sudo`: low-friction normal operation, explicit + traceable elevation, no global admin keys floating around in agent configs.

Three scope tiers, in increasing blast radius:

| Scope          | What it lets the agent do                                        | Lifecycle defaults     |
|----------------|------------------------------------------------------------------|------------------------|
| `agent`        | (implicit baseline) Read/modify ITS OWN agent resources only.    | always-on              |
| `tenant_read`  | Read ANY agent in the tenant — wallets, balances, transfers, audit. | one_shot OR standing (max 60min) |
| `tenant_write` | Mutate sibling agent state — policies, skills, status, freeze.   | one_shot OR standing (max 15min) |
| `treasury`     | Move funds between sibling agents — `send-usdc`, `fund-eoa`.     | **one_shot only** (DB enforced)  |

## Lifecycle of a grant

```
agent calls request_scope     →   scope_requested  audit row (pending)
tenant owner approves         →   scope_granted    audit row + grant row (active)
agent calls gated route       →   scope_used       audit row + grant row (consumed if one_shot)
tenant owner revokes          →   scope_revoked    audit row + grant row (revoked)
expires_at passes             →   scope_expired    audit row + grant row (expired)
24h elapsed (standing only)   →   scope_heartbeat  audit row (grant still active)
```

Every transition writes an audit row to `auth_scope_audit` with the actor, the route, and the env. Audit rows persist past agent deletion (no FK cascade) so you always have a complete trail.

---

## For agents

### Detect that you need a scope

Hit any privileged endpoint and you'll get a `403` like:

```json
{
  "error": "Scope 'tenant_read' required; caller has 'agent'. Call request_scope({ scope: 'tenant_read', purpose: '...' }) and have the tenant owner approve, or have them issue a standing grant from the dashboard.",
  "code": "SCOPE_REQUIRED",
  "required_scope": "tenant_read",
  "current_scope": "agent",
  "hint": "Call request_scope(...)"
}
```

The `required_scope` field tells you exactly what to ask for.

### Request elevation (HTTP)

```bash
curl -X POST https://api.getsly.ai/v1/auth/scopes/request \
  -H "Authorization: Bearer agent_YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scope": "tenant_read",
    "lifecycle": "one_shot",
    "purpose": "Read sibling agent Tina-2 wallet to plan a fund split"
  }'
```

Response (`202`):

```json
{
  "data": {
    "request_id": "uuid",
    "status": "pending",
    "message": "Scope request submitted. A tenant owner must approve it via the dashboard before the elevation takes effect."
  }
}
```

The agent then waits for approval. Polling pattern:

```bash
curl https://api.getsly.ai/v1/auth/scopes/<request_id> \
  -H "Authorization: Bearer agent_YOUR_TOKEN"
```

Response transitions:
- `{ "status": "pending" }` — not decided
- `{ "status": "approved", "grant": { ... } }` — go ahead, retry the privileged call
- `{ "status": "denied", "denial_reason": "..." }` — give up or request differently

### Inspect current scope

```bash
curl https://api.getsly.ai/v1/auth/scopes/active \
  -H "Authorization: Bearer agent_YOUR_TOKEN"
```

Returns `current_scope` (your effective tier right now) plus the active grants applicable to this caller.

### From the MCP server (Claude Desktop / mcporter)

`@sly_ai/mcp-server@0.5.0+` ships two tools:

- **`request_scope({ scope, lifecycle, purpose, durationMinutes?, intent? })`** — submits the request, returns `request_id`.
- **`scope_status({ requestId? })`** — with no args returns current effective scope; with a `requestId` returns that request's status.

Both auto-fill the calling agent's identity (Story 82.6) — you don't pass `agentId`.

### Lifecycle gotchas

- **`one_shot` is one shot.** First successful gated call consumes the grant. Subsequent calls 403 until you request again.
- **`standing` grants** persist until `expires_at` or revoke. Capped per tier (60min for read, 15min for write, treasury is one_shot only).
- **Concurrency**: gated routes await `recordScopeUse` before responding, so two parallel calls can't share one one_shot — exactly one wins.
- **Cache freshness**: the auth middleware re-queries `auth_scope_grants` on every request, so revocation/consumption is reflected immediately (no 60s cache lag).
- **Grant inheritance**: parent-session-anchored one_shot grants only apply to `sess_*` calls from the originating session. Standing un-anchored grants apply to any agent_* / sess_* call from the agent.

---

## For tenant owners

### Approve / deny via dashboard

Open `/dashboard/security/scopes`. Pending requests appear at the top with:
- Agent name, requested scope, lifecycle, purpose, time submitted
- **Approve** button (one-click for `tenant_read`; **typed-confirmation modal** for `tenant_write` and `treasury`)
- **Deny** button — prompts for a reason that surfaces back to the agent's `scope_status` poll

Below: every active grant tenant-wide, with a **Revoke** button.
Below that: a filtered audit feed with action chips, agent picker, and free-text search.

### Issue a standing grant directly (no agent request)

Click **+ Issue grant** on the Active grants section. Pick agent, scope, lifecycle, duration, purpose. Treasury auto-locks to `one_shot`.

### Per-agent view

`/dashboard/agents/[id]` now has a **Scopes** tab showing just that agent's grants + audit history. Useful for "what has agent X been doing lately?"

### Approve / deny / revoke via API (server-to-server automation)

Tenant API keys (`pk_*`) carry full owner-equivalent privilege and can drive the lifecycle without a JWT login. Endpoints:

```bash
# List active grants (defaults to current env; ?env=all spans both)
curl https://api.getsly.ai/v1/organization/scopes \
  -H "Authorization: Bearer pk_test_..." -H "X-Environment: test"

# Issue a standing grant directly
curl -X POST https://api.getsly.ai/v1/organization/scopes \
  -H "Authorization: Bearer pk_test_..." -H "X-Environment: test" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "...",
    "scope": "tenant_read",
    "lifecycle": "standing",
    "duration_minutes": 30,
    "purpose": "..."
  }'

# Decide a pending request
curl -X POST https://api.getsly.ai/v1/organization/scopes/<requestId>/decide \
  -H "Authorization: Bearer pk_test_..." -H "X-Environment: test" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "approve" }'   # or "deny", with optional "reason"

# Revoke
curl -X DELETE https://api.getsly.ai/v1/organization/scopes/<grantId> \
  -H "Authorization: Bearer pk_test_..." -H "X-Environment: test"

# Audit feed (defaults to current env; ?env=all spans both; ?agent_id=... narrows)
curl https://api.getsly.ai/v1/organization/scopes/audit?limit=100 \
  -H "Authorization: Bearer pk_test_..." -H "X-Environment: test"
```

When issuing via API key, the grant's `granted_by_user_id` is auto-resolved to the tenant's primary owner, so the "every elevation has a real human approver" invariant holds. The audit row records `actor_type='api_key'` + `granted_via_api_key: true` for traceability.

---

## Auto-cascading revokes

Two operator actions automatically wipe every active grant for an agent:

1. **Kill switch** (`POST /v1/agents/:id/kill-switch`) — suspends the agent + cascade-revokes scope grants. Response includes `scopeGrantsRevoked: N`.
2. **Wallet freeze** (`POST /v1/agents/:agentId/wallet/freeze`) — locks the wallet + cascade-revokes scope grants.

Audit row each gets `request_summary.reason: "kill_switch_cascade"` so the trail distinguishes operator-driven revokes from manual ones.

---

## Environment scoping

`auth_scope_grants` and `auth_scope_audit` rows carry an `environment` column populated from the **target agent's** env (not the issuer's). Default behavior on dashboards + API:

- `/v1/organization/scopes` and `.../audit` filter to the caller's env
- `?env=all` opts out (dashboards don't expose this; cross-env automation scripts can use it)
- The Issue Grant flow stamps the new grant with the target agent's env, even if the tenant API key calling it spans both

Net effect: a live-env dashboard never shows test-env scope events and vice versa.

---

## Currently gated routes (canonical list)

| Method | Path                                            | Required scope (sibling only) |
|--------|-------------------------------------------------|-------------------------------|
| GET    | `/v1/agents/:id`                                | `tenant_read`                 |
| PATCH  | `/v1/agents/:id`                                | `tenant_write`                |
| POST   | `/v1/agents/:agentId/wallet/freeze`             | `tenant_write`                |
| POST   | `/v1/agents/:agentId/wallet/unfreeze`           | `tenant_write`                |
| PUT    | `/v1/agents/:agentId/wallet/policy`             | `tenant_write`                |
| POST   | `/v1/agents/:id/smart-wallet/send-usdc`         | `treasury`                    |
| POST   | `/v1/agents/:id/fund-eoa`                       | `treasury`                    |

Same-agent calls (where `actorId === targetId`) bypass the gate. Tenant API keys + JWT users are unaffected (their existing tenant-wide auth model is preserved).

---

## Failure modes / debugging

**`SCOPE_REQUIRED` 403 when I expect to have permission.**
Check `GET /v1/auth/scopes/active`. If `current_scope` is `agent` but you expected `tenant_read`:
- Grant might be `consumed` (one_shot used) or `expired`
- `parent_session_id` might not match your current session (session-anchored grants only apply to the originating sess_*)
- env mismatch — agent is test, calling endpoint with X-Environment: live

**Approve button doesn't appear / dashboard empty.**
Logged-in user might not be on the same tenant as the requesting agent. JWT auth derives tenant from `user_profiles.tenant_id`.

**Stuck-cache after revoke (legacy bug, fixed in `99e065f`).**
Should not happen — every request re-queries scope. If you see this, it's a regression worth filing.

---

## Related

- Spec: [`docs/prd/epics/epic-82-scoped-capability-tokens.md`](../prd/epics/epic-82-scoped-capability-tokens.md)
- Auth model: [`AGENT_AUTH_GUIDE.md`](./AGENT_AUTH_GUIDE.md)
- Vault credentials (Epic 78 — sibling concept for external secrets): see Epic 78 spec
