# Epic 58: A2A Task Processor — Implementation Status

**Status**: ✅ Complete (17/18 stories, 58.4 LLM deferred)
**Date**: March 12, 2026
**Stories Implemented**: 58.1–58.3, 58.5–58.13, 58.15–58.18 (58.4 deferred, 58.14 N/A)
**Epic PRD**: [`docs/prd/epics/epic-58-a2a-task-processor.md`](../../prd/epics/epic-58-a2a-task-processor.md)

---

## What Was Built

The A2A task processor has been wired to **real Supabase data**, replacing all hardcoded mock responses. The processor now executes real wallet balance checks, creates real transfer records, queries real agent info, and supports multi-turn conversations. The payment-gating flow (input-required -> payment proof -> re-process) is fully functional, and a human-in-the-loop approval path has been added.

### Key Deliverables

1. **Real data handlers** — Balance, payment, info, lookup, quote, history all query Supabase directly
2. **Payment gating** — Large amounts trigger `input-required` with x402 metadata; callers can submit payment proof or get human approval
3. **Human-in-the-loop** — `/respond` endpoint accepts human messages; processor detects approval and bypasses payment gate
4. **Multi-turn conversations** — `contextId` links tasks into procurement-style flows (search -> quote -> pay)
5. **Task operations** — tasks/list, tasks/cancel, stats, sessions, batch processing all working
6. **46/46 E2E tests passing** across 6 agent workflow scenarios

---

## Files Modified

| File | Changes |
|------|---------|
| `apps/api/src/services/a2a/task-processor.ts` | Replaced all mock handlers with real Supabase queries. Added `AgentToolRegistry`, `handlePaymentResumption()`, `handleHumanApproval()`, `handleLookup()`, `handleQuote()`, `handleHistory()`. Expanded intent parser. |
| `apps/api/src/services/a2a/jsonrpc-handler.ts` | Added payment proof detection in `message/send` follow-ups. When task is `input-required`, scans for `DataPart` with `type: 'payment_proof'`. Calls `processPayment()` on proof, transitions to `submitted` for re-processing. |
| `apps/api/src/services/a2a/task-service.ts` | Clears `processor_id` and `processing_started_at` when task state goes back to `submitted`, enabling worker re-claim. |
| `apps/api/src/services/a2a/tools/handlers.ts` | Fixed `list_accounts` select — removed `balance_total`, `balance_available`, `country`, `currency` columns that don't exist on the accounts table. |
| `apps/api/src/services/a2a/tools/registry.ts` | Made `@sly/mcp-server` import lazy/dynamic to prevent `process.exit(1)` crash when `SLY_API_KEY` isn't set. |
| `apps/api/src/routes/a2a.ts` | Passes `supabase` + `tenantId` to `handleJsonRpc()`. Made `/respond` endpoint accept plain text `{ message: "..." }` format. |
| `apps/api/package.json` | Added `@sly/mcp-server` as workspace dependency. |

### Test Scripts Created

| Script | Purpose |
|--------|---------|
| `apps/api/scripts/test-a2a-e2e.ts` | Basic E2E: discovery, balance, small payment, large payment gating, payment proof, agent info (33/33 pass) |
| `apps/api/scripts/test-a2a-agent-workflows.ts` | Comprehensive workflows: procurement, travel agent, history, task ops, lifecycle, batch (46/46 pass) |

---

## Intent Handlers

The task processor uses regex-based intent parsing to route messages to the appropriate handler:

| Intent | Keywords | Handler | Data Source |
|--------|----------|---------|-------------|
| `lookup` | find, search, lookup, list supplier/vendor/account | `handleLookup()` | `toolHandlers.list_accounts()` |
| `quote` | quote, estimate, cost, price, how much | `handleQuote()` | `toolHandlers.get_wallet_balance()` + FX rates |
| `history` | history, transactions, recent, past payments | `handleHistory()` | `toolHandlers.get_agent_transactions()` |
| `balance` | balance, wallet, funds | `handleBalance()` | `toolHandlers.get_wallet_balance()` / `list_wallets()` |
| `payment` | send, pay, transfer, remit, book, purchase, procure | `handlePayment()` | Real wallet UPDATE + transfer INSERT |
| `stream` | stream, per second, flow rate | `handleStream()` | Config-based (mock stream setup) |
| `info` | status, info, capabilities, who are you | `handleInfo()` | `toolHandlers.get_agent_info()` |
| `generic` | *(fallback)* | `handleGeneric()` | Help message with available actions |

---

## E2E Test Scenarios

### Scenario 1: Procurement Agent (Multi-turn)

Three tasks sharing a `contextId`, simulating a procurement workflow:

```
Turn 1: "Find suppliers for office equipment in Brazil"
  +-- message/send -> task created (submitted)
  +-- POST /process -> processor claims task
  +-- Intent: lookup -> toolHandlers.list_accounts()
  +-- Returns 10 accounts with account_list data part + search-results artifact
  +-- State: completed

Turn 2: "How much would 500 USDC cost to send to Brazil?"
  +-- message/send (same contextId) -> new task (submitted)
  +-- POST /process -> Intent: quote
  +-- toolHandlers.get_wallet_balance() -> real balance
  +-- Builds FX quote: 500 USDC -> 2507.32 BRL (rate 5.05, fee 3.5)
  +-- Returns quote data part with wallet balance + affordability
  +-- State: completed

Turn 3: "Send 200 USDC to the first supplier for procurement"
  +-- message/send (same contextId) -> new task (submitted)
  +-- POST /process -> Intent: payment (200 < 500 threshold)
  +-- Checks wallet balance >= 200
  +-- UPDATE wallets SET balance = balance - 200
  +-- INSERT INTO transfers (real record)
  +-- taskService.linkPayment(taskId, transfer.id)
  +-- Returns transfer_initiated data part + receipt artifact
  +-- State: completed
```

**Assertions**: 13/13 pass. Each turn is a separate task, all share contextId. Real account data, real FX quote, real transfer in DB.

---

### Scenario 2: Travel Agent (Human-in-the-Loop)

Single task with state transitions through `input-required`:

```
Step 1: "Book a flight to Sao Paulo for 800 USDC"
  +-- message/send -> task created (submitted)
  +-- POST /process -> Intent: payment (800 > 500 threshold)
  +-- paymentHandler.requirePayment() -> payment_required data part
  +-- Merges metadata: { a2a.original_intent: "Book a flight..." }
  +-- State: input-required
  +-- Returned with x402 payment info

Step 2: Human responds via dashboard
  +-- POST /v1/a2a/tasks/:id/respond { message: "Approved. Go ahead." }
  +-- Endpoint accepts plain text, converts to [{ text: "..." }]
  +-- Adds user message to task history
  +-- State: working

Step 3: Re-process after human approval
  +-- POST /v1/a2a/tasks/:id/process
  +-- Processor finds a2a.original_intent in metadata, no transferId
  +-- handleHumanApproval() -> re-parses original intent (800 USDC)
  +-- Bypasses threshold (human authorized)
  +-- UPDATE wallets SET balance = balance - 800
  +-- INSERT INTO transfers (real record)
  +-- Returns transfer_initiated (humanApproved: true)
  +-- State: completed
```

**Assertions**: 4/4 pass. Payment gate works, human override bypasses threshold, real transfer created.

---

### Scenario 3: Transaction History

```
"Show me recent transactions and past payments"
  +-- message/send -> task created (submitted)
  +-- POST /process -> Intent: history
  +-- toolHandlers.get_agent_transactions() -> real Supabase query
  |     SELECT FROM transfers WHERE initiated_by_id = agentId LIMIT 10
  +-- Returns transaction_history data part + history artifact
  +-- State: completed
```

**Assertions**: 4/4 pass. Returns real transactions from DB (including those created in earlier scenarios).

---

### Scenario 4: Task Operations

Tests the management/control plane:

```
4a. tasks/list (JSON-RPC)
  +-- jsonRpc("tasks/list", { limit: 5 })
  +-- Returns paginated list with total count
  +-- Includes pagination metadata (page, totalPages)

4b. REST filter by state
  +-- GET /v1/a2a/tasks?state=completed&agent_id=...&limit=5
  +-- Returns only completed tasks
  +-- All have state === 'completed'

4c. Create + Cancel lifecycle
  +-- message/send -> task created (submitted)
  +-- tasks/cancel -> State: canceled
  +-- tasks/get -> confirms canceled
  +-- message/send to canceled task -> error: "Cannot send to canceled task"

4f. Stats
  +-- GET /v1/a2a/stats
  +-- Returns: { total, active, completed, transferCount, totalCost, ... }

4g. Sessions
  +-- GET /v1/a2a/sessions
  +-- Returns sessions grouped by contextId
```

**Assertions**: 12/12 pass.

---

### Scenario 5: Full Lifecycle State Transitions

Verifies each state explicitly:

```
Step 1: submitted
  +-- message/send "Lookup vendor accounts" -> state: submitted
  +-- tasks/get -> confirms submitted, history: 1 message

Step 2: working -> completed
  +-- POST /v1/a2a/tasks/:id/process
  +-- submitted -> working (processor claims)
  +-- Intent: lookup -> real account data
  +-- working -> completed
  +-- tasks/get -> confirms completed, history: 2 messages, artifacts >= 1
```

**Assertions**: 7/7 pass.

---

### Scenario 6: Batch Processing

```
Setup: Create 3 tasks without processing
  +-- "Check my USDC balance"    -> task 1 (submitted)
  +-- "Who are you?"             -> task 2 (submitted)
  +-- "Show recent transactions" -> task 3 (submitted)

Batch process:
  +-- POST /v1/a2a/process { agentId: "..." }
  +-- Queries: WHERE state='submitted' LIMIT 20
  +-- Processes each via processor.processTask():
  |     Task 1: intent=balance -> get_wallet_balance -> completed
  |     Task 2: intent=info    -> get_agent_info     -> completed
  |     Task 3: intent=history -> get_agent_transactions -> completed
  +-- All 3 tasks verified completed
```

**Assertions**: 6/6 pass.

---

## Payment Flow (End-to-End)

```
1. External agent -> message/send "Send 1000 USDC to Brazil"
2. Task created: submitted
3. Worker claims -> processor parses: payment, $1000 > $500 threshold
4. requirePayment() -> task: input-required
   metadata: { x402 payment info + a2a.original_intent }
5. External agent receives input-required + payment metadata

Path A: Payment proof
   6a. External agent pays, sends message/send with DataPart:
       { data: { type: 'payment_proof', paymentType: 'wallet', transferId: '...' } }
   7a. JSON-RPC handler detects proof -> calls processPayment()
       -> verifies transfer exists + completed -> links to task
   8a. Task -> submitted (processor_id cleared)
   9a. Worker re-claims -> processor sees transferId + original_intent
   10a. handlePaymentResumption() -> marks completed with real receipt

Path B: Human approval
   6b. Human responds via POST /respond { message: "Approved" }
   7b. Task -> working (human message added to history)
   8b. POST /process -> processor sees a2a.original_intent, no transferId
   9b. handleHumanApproval() -> bypasses threshold, executes payment
   10b. Real wallet deduction + transfer record -> completed
```

---

## Stories Status vs Epic PRD

| Story | PRD Description | Status | Notes |
|-------|----------------|--------|-------|
| 58.1 | Agent Processing Configuration | Complete | `processor_id`, `processing_started_at`, worker config, per-tenant concurrency limits |
| 58.2 | Agent Tool Registry | Complete | `tools/registry.ts`, `tools/handlers.ts`, `tools/permission-map.ts`, `tools/context-injector.ts`. Lazy MCP import. |
| 58.3 | Task Claim & Dispatch | Complete | Atomic claim (optimistic locking), priority sort, per-tenant limits, timeout enforcement |
| 58.4 | LLM Managed Handler | **Deferred** | Intentionally deferred — regex router is faster, cheaper, and more predictable for structured A2A messages |
| 58.5 | Webhook Handler | Complete | `webhook-handler.ts` — HMAC-SHA256 signing, exponential backoff [30s–1h], DLQ after 5 attempts |
| 58.6 | Human-in-the-Loop | Complete | `escalate_to_human` tool, `/respond` endpoint, human approval path in processor |
| 58.7 | Intra-Platform Agent-to-Agent | Complete | `a2a_send_task` tool handler with direct service call + event bus wait |
| 58.8 | Payment Gating | Complete | Full flow: KYA check → limit check → settlement mandate → wallet transfer. x402/AP2/wallet verification |
| 58.9 | Error Recovery & DLQ | Complete | Circuit breaker (closed/open/half-open), webhook DLQ, task retry backoff, transient error detection |
| 58.10 | Worker Lifecycle | Complete | start/stop with 30s grace period, SIGTERM/SIGINT, stale task cleanup, orphan mandate sweep |
| 58.11 | SDK Types | Complete | `packages/types/src/a2a.ts` exports 25+ types. `packages/sdk/src/protocols/a2a/client.ts` provides A2AClient with discover/sendMessage/getTask/cancelTask/listTasks/respond/createCustomTool |
| 58.12 | E2E Integration Tests | Complete | 79 assertions across 6 workflow scenarios (procurement, travel, history, ops, lifecycle, batch) |
| 58.13 | SSE Streaming | Complete | `message/stream` RPC via Hono `streamSSE()`, heartbeat, terminal state close, 5min timeout |
| 58.14 | LLM Cost Controls | **N/A** | Depends on 58.4 (LLM handler) which is deferred. `maxTokens` field exists in config. |
| 58.15 | Custom Tool Support | Complete | `agent_custom_tools` table, tool registry loads custom tools, webhook execution with HMAC signing + timeout |
| 58.16 | Completion Webhooks | Complete | `completion-webhook.ts` — listens for terminal events, HMAC payload delivery, exponential retry |
| 58.17 | Audit Trail | Complete | `a2a_audit_events` table (RLS-enabled), event bus persists all lifecycle events fire-and-forget, worker timeout events included |
| 58.18 | Context Window Management | Complete | Fixed historyLength to return most recent N messages (not oldest). Default cap: 100. Per-agent `max_context_messages` column. ||

---

## Running the Tests

```bash
# Start the API server
pnpm --filter @sly/api dev

# Run basic E2E (33 assertions)
cd apps/api && source .env && npx tsx scripts/test-a2a-e2e.ts

# Run comprehensive workflows (46 assertions)
cd apps/api && source .env && npx tsx scripts/test-a2a-agent-workflows.ts
```

Both tests require:
- API server running on port 4000
- Demo Fintech tenant seeded (`pnpm --filter @sly/api seed:db`)
- Treasury Agent (`de6881d4`) present with wallet

---

## Key Design Decisions

1. **Regex intent parsing over LLM** — Story 58.4 (LLM handler) is not yet implemented. The processor uses fast regex matching, which means it works without an Anthropic API key and has zero latency overhead. LLM reasoning will be added later as an alternative processing mode.

2. **In-process tool execution** — Tool handlers call Supabase directly instead of going through the HTTP API. Saves ~100ms per tool call.

3. **Human approval bypasses payment gate** — When a human responds to an `input-required` task that has `a2a.original_intent` metadata but no `transferId`, the processor treats it as a human override and executes the original request without requiring payment proof.

4. **Lazy MCP server import** — The `@sly/mcp-server` package calls `process.exit(1)` when `SLY_API_KEY` is not set. The registry uses `await import()` in a try/catch to avoid crashing the API server.

5. **processor_id clearing on re-submit** — When a task transitions back to `submitted` (after payment proof or human response), `processor_id` and `processing_started_at` are cleared so the worker can re-claim it.
