# Epic 57: Google A2A Protocol Integration

**Status:** COMPLETE ✅
**Phase:** 5.2 (Agent Interoperability)
**Priority:** P0 — Strategic Differentiation
**Estimated Points:** 89
**Stories:** 14 (14 complete)
**Dependencies:** Epic 17 (complete), Epic 18 (complete), Epic 40 (complete)
**Created:** February 19, 2026
**Completed:** February 21, 2026

[<- Back to Epic List](./README.md)

---

## Executive Summary

Implement Google's A2A (Agent-to-Agent) protocol so Sly-hosted agents can be **discovered**, **communicated with**, and **paid** using the open standard. Currently Sly has no Google A2A support — AP2 (mandate-based payments) and x402 (pay-per-call) exist but there's no inter-agent messaging, task lifecycle, or discovery protocol. The existing `GET /v1/ap2/agent-card` returns a hardcoded platform card, not per-agent cards.

This epic enables:
1. Each Sly agent gets a discoverable Agent Card with its capabilities and payment protocols
2. External agents can send tasks to Sly agents via JSON-RPC 2.0
3. Tasks can require payment (via x402 or AP2), creating a paid-service workflow
4. Sly agents can discover and send tasks to other A2A agents (outbound)
5. The dashboard shows A2A task history alongside existing activity

**Key Design Decision — Hybrid Authentication:**
- **Discovery (Agent Cards):** Public, no auth — frictionless discovery like `/.well-known/openid-configuration`
- **Task Submission (JSON-RPC):** Hybrid — accepts Sly API keys (for known partners, full features) AND verified bearer tokens (for open federation, basic task access). Start with API-key-only, add bearer verification later.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `GET /.well-known/agent.json` | No | - | - | Public discovery |
| `GET /a2a/agents/:id/card` | ✅ Yes | `sly.a2a` | P0 | Per-agent card |
| `POST /a2a/:agentId` (JSON-RPC) | ✅ Yes | `sly.a2a` | P0 | Task send/get |
| `POST /v1/a2a/discover` | ✅ Yes | `sly.a2a` | P0 | Remote discovery |
| `POST /v1/a2a/tasks` | ✅ Yes | `sly.a2a` | P0 | Outbound tasks |
| `GET /v1/a2a/tasks` | ✅ Yes | `sly.a2a` | P0 | Task listing |
| MCP tools | ✅ Yes | MCP Server | P0 | 4 new tools |
| Dashboard A2A tab | No | - | - | Frontend only |

**SDK Stories Required:**
- Story 57.11: Add `a2a` module to @sly/sdk
- Story 57.12: Add A2A MCP tools to MCP server

---

## Architecture

### Protocol Relationship

```
Google A2A (this epic)     = Agent-to-Agent COMMUNICATION (tasks, messages, artifacts)
AP2 (existing, Epic 17)    = Agent-to-Agent PAYMENTS (mandates, spending authorization)
x402 (existing, Epic 17)   = Pay-per-call MICROPAYMENTS (HTTP 402, wallet-based)
MCP (existing, Epic 36)    = Agent-to-TOOL access (function calling)
```

A2A provides the communication layer. When a task requires payment, it delegates to existing AP2/x402 infrastructure. A2A does NOT replace AP2/x402 — it wraps them with a task lifecycle and discovery protocol.

### Data Flow

```
Agent A                           Sly Platform                        Agent B
  |                                    |                                  |
  |-- GET /a2a/agents/{B}/card ------->|                                  |
  |<-- Agent Card (skills, auth) ------|                                  |
  |                                    |                                  |
  |-- POST /a2a/{B} tasks/send ------->|-- create a2a_task ------------->  |
  |<-- task: { state: "submitted" } ---|                                  |
  |                                    |                                  |
  |                                    |-- process task ----------------> |
  |                                    |<-- state: "input-required" ------|
  |                                    |   (x402 payment required)        |
  |                                    |                                  |
  |-- POST /a2a/{B} tasks/send ------->|-- verify x402 payment --------> |
  |   (with payment proof)             |-- wallet deduction              |
  |                                    |<-- state: "completed" ---------- |
  |<-- task: { artifacts: [...] } -----|                                  |
```

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| AP2 mandate execution | `apps/api/src/routes/ap2.ts:345-738` | Payment within A2A tasks |
| x402 payment verification | `apps/api/src/routes/x402-payments.ts` | Payment proof verification |
| Agent CRUD | `apps/api/src/routes/agents.ts` | Agent lookup for card generation |
| Agent tokens | `apps/api/src/middleware/auth.ts` | Auth for task submission |
| Wallet system | `apps/api/src/routes/wallets.ts` | Agent wallet lookups |
| Well-known pattern | `apps/api/src/routes/well-known-ucp.ts` | Discovery endpoint pattern |
| AP2 types | `apps/api/src/services/ap2/types.ts` | AgentCard interface to extend |
| `a2a_session_id` column | `ap2_mandates` table | Link A2A tasks to mandates |
| Agent detail tabs | `apps/web/.../agents/[id]/page.tsx:48` | TabType pattern to extend |
| MCP server | `packages/mcp-server/src/index.ts` | Tool registration pattern |

---

## Stories

### Phase 1: A2A Types & Agent Card Discovery

---

### Story 57.1: A2A Type Definitions

**Points:** 3
**Priority:** P0

**Description:**
Create TypeScript type definitions matching the Google A2A protocol spec v0.3.

**Types to Define:**
- `A2AAgentCard` — id, name, description, version, provider, capabilities (streaming, multiTurn), skills[], interfaces[], securitySchemes, extensions[]
- `A2ASkill` — id, name, description, inputSchema?, outputSchema?
- `A2ATask` — id, contextId, status (state + message), messages[], artifacts[], metadata
- `A2ATaskState` — `'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected'`
- `A2AMessage` — id, role ('user'|'agent'), parts[], metadata
- `A2APart` — kind ('text'|'data'|'file'), text?, data?, mimeType?, uri?
- `A2AArtifact` — id, label, mimeType, parts[], metadata
- `JSONRPCRequest`, `JSONRPCResponse`, `JSONRPCError` — JSON-RPC 2.0 envelope types

**Files:**
- `apps/api/src/services/a2a/types.ts` (NEW)
- `apps/api/src/services/a2a/index.ts` (NEW — exports)

**Acceptance Criteria:**
- [ ] Types match A2A spec v0.3 structure
- [ ] Types are importable from `../services/a2a/index.js`
- [ ] `pnpm build` passes

---

### Story 57.2: Agent Card Generator Service

**Points:** 5
**Priority:** P0

**Description:**
Build a service that generates A2A-compliant Agent Cards for any registered Sly agent. Replaces the hardcoded card in `apps/api/src/services/ap2/mandate-service.ts:246-277`.

**Implementation:**
- Accept an agent record + parent account from database
- Build skills from agent permissions (e.g. `transactions.initiate` → "make_payment" skill)
- Declare x402/AP2 payment capabilities
- Include `a2a-x402` extension if agent has a wallet
- Set JSON-RPC interface URL to `{baseUrl}/a2a/{agentId}`
- Declare `securitySchemes` with both `sly_api_key` and `bearer` options

**Files:**
- `apps/api/src/services/a2a/agent-card.ts` (NEW)

**Acceptance Criteria:**
- [ ] Generates valid A2A Agent Card from agent record
- [ ] Skills reflect agent's actual permissions
- [ ] Payment extensions present for agents with wallets
- [ ] Card includes correct JSON-RPC endpoint URL

---

### Story 57.3: Public Well-Known Discovery Endpoint

**Points:** 3
**Priority:** P0

**Description:**
Create a public (no auth) endpoint at `GET /.well-known/agent.json` that returns a platform-level Agent Card for Sly. Follow the pattern from `apps/api/src/routes/well-known-ucp.ts`.

**Implementation:**
- Bypass response wrapper middleware (return raw JSON, A2A spec requires top-level fields)
- CORS `Access-Control-Allow-Origin: *`
- Cache-Control: 1 hour
- Return platform capabilities, available protocols, and service metadata

**Files:**
- `apps/api/src/routes/well-known-a2a.ts` (NEW)
- `apps/api/src/app.ts` (MODIFY — mount at app level alongside `/.well-known/ucp`)

**Acceptance Criteria:**
- [ ] `curl http://localhost:4000/.well-known/agent.json` returns valid A2A platform card
- [ ] No auth required
- [ ] Proper CORS and cache headers

---

### Story 57.4: Per-Agent Card Endpoints

**Points:** 5
**Priority:** P0

**Description:**
Create public per-agent card endpoints and update the existing AP2 agent card.

**Endpoints:**
- `GET /a2a/agents/:agentId/card` — public, rate-limited, per-agent Agent Card
- `GET /v1/a2a/agents/:agentId/card` — authenticated, same content (for dashboard)
- Update `GET /v1/ap2/agent-card` to delegate to new A2A agent card service

**Files:**
- `apps/api/src/routes/a2a.ts` (NEW)
- `apps/api/src/app.ts` (MODIFY — mount public `/a2a` routes at app level, management routes under v1)
- `apps/api/src/routes/ap2.ts` (MODIFY — line 38-43, delegate to new service)

**Acceptance Criteria:**
- [ ] `curl http://localhost:4000/a2a/agents/{id}/card` returns per-agent card (no auth)
- [ ] `curl -H "Authorization: Bearer pk_test_..." http://localhost:4000/v1/a2a/agents/{id}/card` returns same
- [ ] `GET /v1/ap2/agent-card` uses new service instead of hardcoded card
- [ ] Rate limiting on public endpoint

---

### Phase 2: A2A Task Database & JSON-RPC Server

---

### Story 57.5: A2A Database Migration

**Points:** 5
**Priority:** P0

**Description:**
Create database tables for A2A tasks, messages, and artifacts with RLS policies.

**Tables:**
- `a2a_tasks` — task lifecycle with state machine, links to mandates/transfers, direction (inbound/outbound)
- `a2a_messages` — messages within tasks (role: user/agent, parts as JSONB)
- `a2a_artifacts` — output data from completed tasks

**Includes:**
- RLS policies (tenant_id filtering on all tables)
- Indexes on (tenant_id, agent_id), (tenant_id, state), (tenant_id, context_id)
- Updated_at trigger

**Files:**
- `apps/api/supabase/migrations/20260220_a2a_protocol.sql` (NEW)

**Acceptance Criteria:**
- [ ] Migration runs without errors
- [ ] RLS policies enforce tenant isolation
- [ ] All tables have appropriate indexes
- [ ] Foreign keys to agents, ap2_mandates, transfers

---

### Story 57.6: A2A Task Service

**Points:** 8
**Priority:** P0

**Description:**
Implement core task lifecycle management.

**Methods:**
- `createTask(tenantId, agentId, message, contextId?)` — creates task in `submitted` state with initial message
- `getTask(tenantId, taskId, historyLength?)` — returns task with messages and artifacts
- `updateTaskState(tenantId, taskId, state, statusMessage?)` — transitions task state
- `addMessage(tenantId, taskId, role, parts, metadata?)` — appends message
- `addArtifact(tenantId, taskId, artifact)` — adds output artifact
- `cancelTask(tenantId, taskId)` — sets state to `canceled`
- `listTasks(tenantId, agentId, filters)` — list with pagination

**Files:**
- `apps/api/src/services/a2a/task-service.ts` (NEW)

**Acceptance Criteria:**
- [ ] Task state transitions follow A2A spec state machine
- [ ] All queries filter by tenant_id
- [ ] Messages ordered chronologically
- [ ] Pagination on listTasks

---

### Story 57.7: JSON-RPC 2.0 Handler

**Points:** 5
**Priority:** P0

**Description:**
Implement a JSON-RPC 2.0 dispatcher for A2A methods.

**Methods:**
| Method | Action |
|--------|--------|
| `tasks/send` | Create task or add message to existing task (by contextId) |
| `tasks/get` | Get task by ID with optional history length |
| `tasks/cancel` | Cancel a task |

**Error Codes:**
- `-32600` — Invalid Request (malformed JSON-RPC)
- `-32601` — Method Not Found
- `-32602` — Invalid Params
- `-32000` — Task Not Found
- `-32001` — Agent Not Found

**Files:**
- `apps/api/src/services/a2a/jsonrpc-handler.ts` (NEW)

**Acceptance Criteria:**
- [ ] Validates JSON-RPC 2.0 envelope (`jsonrpc: "2.0"`, `method`, `params`, `id`)
- [ ] Dispatches to correct task service method
- [ ] Returns proper JSON-RPC responses and errors
- [ ] Handles batch requests (array of JSON-RPC calls)

---

### Story 57.8: A2A Route Handler with Hybrid Auth

**Points:** 8
**Priority:** P0

**Description:**
Create the main JSON-RPC endpoint at `POST /a2a/:agentId` with hybrid authentication.

**Authentication Model:**
1. **Sly API Key** (`Authorization: Bearer pk_test_...` or `agent_...`) — full audit trail, rate limiting per tenant
2. **Verified Bearer Token** (future) — for external A2A agents not registered with Sly

**Agent Card security declaration:**
```json
{
  "securitySchemes": {
    "sly_api_key": { "type": "apiKey", "in": "header", "name": "Authorization" },
    "bearer": { "type": "http", "scheme": "bearer" }
  },
  "security": [{ "sly_api_key": [] }, { "bearer": [] }]
}
```

**Implementation:**
- Custom `a2aAuthMiddleware` that tries Sly auth first (API key or agent token)
- Start with Sly API key auth only; bearer verification is a follow-up story
- Mount `POST /a2a/:agentId` at app level (not under v1)
- Mount management routes (`GET/POST /v1/a2a/*`) under v1 with standard auth

**Files:**
- `apps/api/src/routes/a2a.ts` (MODIFY — extend from Story 57.4)
- `apps/api/src/app.ts` (MODIFY — mount public JSON-RPC route)

**Acceptance Criteria:**
- [ ] `POST /a2a/{agentId}` accepts JSON-RPC with Sly API key
- [ ] Returns proper JSON-RPC response
- [ ] Validates agent exists and is active
- [ ] Rejects unauthenticated requests with JSON-RPC error
- [ ] Management routes (`/v1/a2a/tasks`) require standard auth

---

### Phase 3: Payment Integration

---

### Story 57.9: A2A Payment Handler

**Points:** 8
**Priority:** P0

**Description:**
Orchestrate payment flows within A2A tasks.

**Flows:**
1. **Payment Required:** When a skill requires payment, set task state to `input-required` with metadata `{ "x402.payment.required": { amount, currency, endpoint_url } }`
2. **Payment Submitted:** When client sends message with payment proof, verify via existing x402 verify logic, transition task to `working`
3. **Sly-Native Shortcut:** If both agents are on the same tenant, use wallet-to-wallet transfer via AP2 mandate execution instead of on-chain x402 (free, instant)
4. **Mandate Linking:** Populate `a2a_session_id` on AP2 mandates, set `mandate_id` and `transfer_id` on `a2a_tasks`

**Reuses:**
- x402 payment verification from `apps/api/src/routes/x402-payments.ts`
- AP2 mandate execution from `apps/api/src/routes/ap2.ts:345-738`
- Wallet balance checks from existing wallet service

**Files:**
- `apps/api/src/services/a2a/payment-handler.ts` (NEW)
- `apps/api/src/services/a2a/task-service.ts` (MODIFY — integrate payment awareness)
- `apps/api/src/services/a2a/agent-card.ts` (MODIFY — add a2a-x402 extension, payment skills)

**Acceptance Criteria:**
- [ ] Task transitions to `input-required` when payment needed
- [ ] x402 payment proof is verified using existing infrastructure
- [ ] Wallet balances update correctly after payment
- [ ] Transfer recorded in `transfers` table with `protocol_metadata.protocol = 'a2a'`
- [ ] A2A session linked to AP2 mandate via `a2a_session_id`
- [ ] Same-tenant shortcut avoids on-chain x402

---

### Phase 4: A2A Client (Outbound)

---

### Story 57.10: A2A Client Service & Routes

**Points:** 8
**Priority:** P1

**Description:**
Allow Sly agents to discover and communicate with other A2A agents (outbound).

**Client Service Methods:**
- `discover(url)` — fetch `/.well-known/agent.json` from remote URL, parse Agent Card
- `sendTask(remoteUrl, message, auth?)` — send `tasks/send` JSON-RPC
- `getTask(remoteUrl, taskId, auth?)` — poll `tasks/get`
- `cancelTask(remoteUrl, taskId, auth?)` — send `tasks/cancel`
- `handlePaymentRequired(task, walletId)` — when remote responds with payment-required, pay via agent's wallet

**API Routes (under /v1/a2a, authenticated):**
- `POST /v1/a2a/discover` — fetch and parse a remote agent card
- `POST /v1/a2a/tasks` — send task to remote agent (outbound)
- `GET /v1/a2a/tasks` — list A2A tasks (inbound + outbound)
- `GET /v1/a2a/tasks/:taskId` — get task detail
- `POST /v1/a2a/tasks/:taskId/cancel` — cancel task

**Files:**
- `apps/api/src/services/a2a/client.ts` (NEW)
- `apps/api/src/routes/a2a.ts` (MODIFY — add management routes)

**Acceptance Criteria:**
- [ ] Can discover remote agent cards from URL
- [ ] Can send outbound tasks and track status
- [ ] Outbound tasks stored in `a2a_tasks` with `direction='outbound'`
- [ ] Payment flows work for outbound tasks

---

### Phase 5: SDK & Frontend

---

### Story 57.11: SDK Types & Client Methods

**Points:** 5
**Priority:** P0

**Description:**
Add A2A types and client methods to the SDK.

**Types (in `packages/api-client/src/types.ts`):**
- `A2AAgentCard`, `A2ATask`, `A2AMessage`, `A2AArtifact`, `A2ATaskState`
- `A2ATasksListParams`, `SendA2ATaskInput`

**Client Methods (in `packages/api-client/src/client.ts`):**
```typescript
a2a = {
  discover: (url: string) => this.post('/a2a/discover', { url }),
  getAgentCard: (agentId: string) => this.get(`/a2a/agents/${agentId}/card`),
  sendTask: (input: SendA2ATaskInput) => this.post('/a2a/tasks', input),
  getTask: (taskId: string) => this.get(`/a2a/tasks/${taskId}`),
  listTasks: (params?: A2ATasksListParams) => this.get('/a2a/tasks', params),
  cancelTask: (taskId: string) => this.post(`/a2a/tasks/${taskId}/cancel`),
};
```

**Files:**
- `packages/api-client/src/types.ts` (MODIFY)
- `packages/api-client/src/client.ts` (MODIFY)

**Acceptance Criteria:**
- [ ] `pnpm build` passes
- [ ] Types match API response shapes
- [ ] Client methods work with API endpoints

---

### Story 57.12: A2A MCP Tools

**Points:** 5
**Priority:** P0

**Description:**
Add 4 MCP tools for A2A operations following existing tool registration pattern.

**Tools:**
- `a2a_discover_agent` — discover remote agent capabilities from URL
- `a2a_send_task` — send task to a remote or local agent
- `a2a_get_task` — check task status and retrieve messages/artifacts
- `a2a_list_tasks` — list A2A tasks with filters

**Files:**
- `packages/mcp-server/src/index.ts` (MODIFY)

**Acceptance Criteria:**
- [ ] Tools registered and appear in `ListTools` response
- [ ] `a2a_discover_agent` fetches and parses remote agent cards
- [ ] `a2a_send_task` creates tasks via API
- [ ] `a2a_get_task` retrieves task with messages
- [ ] `a2a_list_tasks` returns paginated results

---

### Story 57.13: Dashboard A2A Tab

**Points:** 8
**Priority:** P1

**Description:**
Add an "A2A" tab to the agent detail page.

**Tab Contents:**
1. Agent Card viewer (JSON, copy-to-clipboard, shows skills and capabilities)
2. A2A endpoint URL display
3. Inbound tasks table (state, client agent, created time, linked payment)
4. Outbound tasks table
5. Task detail view (message history as chat UI, artifacts, payment info)

**Files:**
- `apps/web/src/app/dashboard/agents/[id]/page.tsx` (MODIFY — add `'a2a'` to TabType)
- `apps/web/src/components/agents/a2a-task-detail.tsx` (NEW)

**Acceptance Criteria:**
- [ ] A2A tab appears in agent detail page
- [ ] Agent Card JSON is viewable and copyable
- [ ] Tasks displayed with correct state badges
- [ ] Task detail shows message history
- [ ] Payment links shown when applicable

---

### Phase 6: Testing & Demo

---

### Story 57.14: End-to-End A2A Tests

**Points:** 5
**Priority:** P0

**Description:**
Integration and unit tests for the full A2A flow.

**Integration Test Flow:**
1. Create two agents (Research Agent as provider, Procurement Bot as consumer)
2. Procurement Bot discovers Research Agent's card
3. Procurement Bot sends `tasks/send` with a query
4. Research Agent responds with `input-required` + x402 payment details
5. Procurement Bot submits payment
6. Research Agent verifies, processes, returns artifact with `completed` state
7. Assert: wallet balances, transfers, task state, agent transactions endpoint

**Unit Tests:**
- Agent Card generation with various permission/wallet configs
- JSON-RPC parsing, method dispatch, error handling
- Task state transitions and validation
- Payment flow within tasks

**Files:**
- `apps/api/tests/integration/a2a.test.ts` (NEW)
- `apps/api/tests/unit/a2a/agent-card.test.ts` (NEW)
- `apps/api/tests/unit/a2a/jsonrpc-handler.test.ts` (NEW)
- `apps/api/tests/unit/a2a/task-service.test.ts` (NEW)

**Acceptance Criteria:**
- [ ] Integration test passes end-to-end with payment
- [ ] Unit tests cover all JSON-RPC error codes
- [ ] Unit tests cover all task state transitions
- [ ] `pnpm test` passes

---

## Implementation Sequence

```
Phase 1: Agent Cards (Stories 57.1-57.4)     ← No dependencies, immediately testable
    ↓
Phase 2: Task DB + JSON-RPC (Stories 57.5-57.8)  ← Depends on Phase 1 types
    ↓
Phase 3: Payments (Story 57.9)               ← Depends on Phase 2, reuses x402/AP2
Phase 4: Client (Story 57.10)                ← Depends on Phase 2 (parallel with 3)
    ↓
Phase 5: SDK + Frontend (Stories 57.11-57.13) ← Depends on Phases 1-4
    ↓
Phase 6: Testing (Story 57.14)               ← End-to-end validation
```

Phases 3 and 4 can be done in parallel after Phase 2.

---

## Verification Plan

1. `pnpm build` — all packages compile
2. `curl http://localhost:4000/.well-known/agent.json` — returns platform A2A card
3. `curl http://localhost:4000/a2a/agents/{id}/card` — returns per-agent card (no auth)
4. Send JSON-RPC `tasks/send` to `POST /a2a/{agentId}` — creates task, returns task object
5. Full payment flow: task → payment-required → payment-submitted → completed → wallet balances updated
6. MCP tools: `a2a_discover_agent`, `a2a_send_task`, `a2a_get_task` work end-to-end
7. Dashboard: A2A tab on agent detail page shows tasks, messages, payment links
8. `pnpm test` — no regressions

---

## TODO — End-to-End Encryption for A2A Messages

Added 2026-04-16 during pitch-prep review.

**Current state**: A2A relies on TLS in-flight, bearer-token auth, and HMAC on webhook dispatch. Message bodies (`parts`, artifacts, metadata) are stored in Postgres in plaintext, protected only by tenant RLS + at-rest disk encryption. The platform is a trusted mediator — it sees every message.

**Gap**: zero-trust agent-to-agent communication. No cryptographic guarantee that (a) a message was sent by the claimed agent, (b) the message body wasn't altered by the platform or a compromised component, (c) only the intended recipient can read it.

**What to add**:
1. **Per-message Ed25519 signatures** — each A2A message carries a detached signature from the sender's existing Ed25519 auth key (Epic 72). Verified on receipt + persisted alongside the message.
2. **Hybrid E2E payload encryption** — ephemeral X25519 key exchange between sender and recipient agent public keys → ChaCha20-Poly1305 on the message body. Platform stores only the ciphertext; headers/routing metadata stay plaintext.
3. **Signed artifact envelopes** — delivered artifacts carry the producer's signature so the buyer's rating binds to a signed proof-of-work, not just a hash of platform-stored content.
4. **Public key discovery** — extend agent cards / `.well-known/agent.json` to publish the agent's current Ed25519 + X25519 public keys, rotatable via existing key-management endpoints.

**Non-goals for v1**: encrypting task metadata (state transitions need to remain platform-visible for audit, RLS, and reputation calculations); encrypting rating/feedback rows (those are intentionally platform-mediated).

**Why it matters for the pitch**: the current story ("Sly is the trusted mediator") is fine for partners who trust us. Zero-trust agent-to-agent E2E opens up cross-platform / adversarial agent interactions where neither agent trusts the other or the platform.

---

## Protocol Support Matrix (Updated)

| Protocol | Owner | Focus | Sly Status |
|----------|-------|-------|------------|
| **x402** | Coinbase | Micropayments | ✅ Full support |
| **AP2** | Google | Agent mandates | ✅ Full support |
| **ACP** | Stripe/OpenAI | E-commerce | ✅ Full support |
| **UCP** | Google+Shopify | Full commerce | ✅ Epic 43 |
| **A2A** | Google | Agent communication | 🚧 **This epic** |

---

*"A2A provides the communication. AP2 provides the payment authorization. x402 provides the payment rails. Together, they enable a complete agent economy."*
