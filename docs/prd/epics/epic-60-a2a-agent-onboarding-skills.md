# Epic 60: A2A Agent Onboarding Skills

**Status:** 🚧 In Progress
**Phase:** 5.2 (Agent Interoperability)
**Priority:** P0 — Removes REST API barrier for agent onboarding
**Estimated Points:** 28
**Stories:** 8
**Dependencies:** Epic 57 (A2A Protocol), Epic 59 (User Onboarding)
**Created:** February 28, 2026

[← Back to Epic List](./README.md)

---

## Executive Summary

Sly's A2A gateway (`POST /a2a`) currently only supports discovery skills (`find_agent`, `list_agents`). To register as a provider, an agent must know Sly's REST API and make 4 separate calls (create agent, add skills, set endpoint, verify KYA). This blocks multi-model agent interoperability — agents shouldn't need platform-specific REST knowledge.

This epic adds three new platform-level A2A skills so the entire agent lifecycle (register → configure → inspect) works through standard A2A `message/send` to `POST /a2a`.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `register_agent` A2A skill | ❌ No | - | - | A2A protocol, not REST |
| `update_agent` A2A skill | ❌ No | - | - | A2A protocol, not REST |
| `get_my_status` A2A skill | ❌ No | - | - | A2A protocol, not REST |

**SDK Stories Required:** None — these are A2A protocol skills, not REST endpoints.

---

## New Skills

| Skill | Auth | Purpose |
|-------|------|---------|
| `register_agent` | `Bearer pk_*` (API key) | One-shot: create agent + wallet + skills + endpoint + auto-verify KYA tier 1. Returns auth token. |
| `update_agent` | `Bearer agent_*` (self) | Self-sovereign: modify name, description, endpoint, add/remove skills |
| `get_my_status` | `Bearer agent_*` (self) | Check registration, wallet balance, skills, limits |

---

## Architecture

### Auth Flow

The `POST /a2a` gateway route currently requires no auth. This epic adds **optional** auth extraction:

```
POST /a2a (Authorization: Bearer pk_test_... or agent_...)
  → Extract auth context (tenantId, authType, agentId/apiKeyId)
  → Pass to gateway handler
  → Route to onboarding handler if skill matches
  → Discovery skills remain public (no auth required)
```

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Auth extraction | `a2a.ts:242-293` | Prefix lookup + hash verify pattern |
| Agent creation | `agents.ts:277-294` | INSERT into agents table |
| Wallet auto-creation | `agents.ts:329-356` | Auto-create wallet for agent |
| KYA verification | `agents.ts:37-66` | `computeEffectiveLimits()` |
| Skill upsert | `agents.ts:1797-1805` | UPSERT with conflict clause |
| Token generation | `utils/crypto.ts` | `generateAgentToken`, `hashApiKey`, `getKeyPrefix` |
| Response format | `gateway-handler.ts:245-278` | `buildDiscoveryResponse()` pattern |

---

## Stories

### Story 60.1: Export shared utilities (2 pts)
Export `computeEffectiveLimits` and `DEFAULT_PERMISSIONS` from `agents.ts` so the new onboarding handler can import them.

### Story 60.2: Add optional auth to POST /a2a gateway route (3 pts)
- Define `GatewayAuthContext` interface
- Extract `pk_*` / `agent_*` credentials from Authorization header
- Pass `authContext?` to `handleGatewayJsonRpc`
- Discovery skills remain public

### Story 60.3: Expand Intent extraction (2 pts)
- Add new skill IDs to Intent type
- Add `payload` field for structured data
- Route to new handlers in switch statement

### Story 60.4: Implement `register_agent` handler (8 pts)
- Require API key auth
- Validate input, resolve parent account
- Generate token, create agent, auto-create wallet
- Batch-upsert skills, set endpoint
- Auto-verify KYA tier 1
- Return credentials (shown once only)

### Story 60.5: Implement `update_agent` handler (5 pts)
- Require agent token auth (self-sovereign)
- Apply partial updates: name, description, endpoint
- Upsert/remove skills
- Return updated state

### Story 60.6: Implement `get_my_status` handler (3 pts)
- Require agent token auth
- Parallel queries: agent, wallet(s), skills
- Return full status with effective limits

### Story 60.7: Update platform Agent Card (2 pts)
- Add 3 skill definitions to `generatePlatformCard()`
- Update `buildCapabilitiesResponse()`

### Story 60.8: Tests (3 pts)
- Unit tests for all three handlers with mocked Supabase

**Total: 28 points**

---

## Security

- **Tenant isolation**: `tenantId` always from verified auth — never from user input
- **Self-sovereign updates**: `update_agent`/`get_my_status` derive target from auth token, not payload
- **Token exposure**: Plaintext token returned once only (matches existing REST pattern)
- **KYA gating**: Only API key holders (tenant admins) can register agents
- **Backward compat**: Unauthenticated discovery calls completely unaffected

---

## Definition of Done

- [ ] `pnpm build` — no type errors
- [ ] `pnpm test` — existing + new tests pass
- [ ] Platform card includes new skills
- [ ] Register flow: `POST /a2a` with `register_agent` + API key → returns agent_id + token + wallet
- [ ] Status check: `POST /a2a` with `get_my_status` + agent token → full status
- [ ] Update flow: `POST /a2a` with `update_agent` + agent token → skills updated
- [ ] Auth rejection: `register_agent` without auth → `-32004` error
- [ ] Discovery unbroken: `list_agents` without auth → still works
