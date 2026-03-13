# Epic 58: A2A Task Processor Worker 🧠

**Status:** ✅ Complete (17/18 stories done, 58.4 deferred)
**Phase:** 5.2 (Agent Interoperability)
**Priority:** P0 — Agents Without Processing Are Just Database Records
**Total Points:** 119 (109 done, 10 deferred)
**Stories:** 17/18 Complete — 58.4 (LLM Managed Handler) intentionally deferred
**Implementation Notes:** [`docs/completed/epics/EPIC_58_IMPLEMENTATION_STATUS.md`](../../completed/epics/EPIC_58_IMPLEMENTATION_STATUS.md)
**Dependencies:** Epic 57 (A2A Protocol Integration — complete)
**Enables:** Live agent demos, agent-to-agent commerce, paid A2A services, enterprise agent orchestration

[← Back to Epic List](./README.md)

---

## Executive Summary

Epic 57 gave Sly agents a voice (A2A protocol, discovery, JSON-RPC). This epic gives them a brain. Today, `message/send` creates a task in `submitted` state and… nothing happens. No worker picks it up, no LLM reasons about it, no webhook fires. The Treasury Agent has a beautiful Agent Card declaring 5 skills, but it can't actually execute any of them.

Epic 58 builds the **Task Processor Worker** — a background service that claims submitted tasks, dispatches them to the appropriate handler (LLM, webhook callback, or human escalation), executes tool calls against Sly's own APIs, and returns completed results. This is the difference between "we have an A2A endpoint" and "our agents actually do things."

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| Task processor worker | ❌ No | - | - | Internal service, no API surface |
| `POST /v1/a2a/agents/:id/config` | ✅ Yes | `sly.a2a` | P0 | Agent processing config |
| `GET /v1/a2a/agents/:id/config` | ✅ Yes | `sly.a2a` | P0 | Read config |
| `PATCH /v1/a2a/tasks/:id` | ✅ Yes | `sly.a2a` | P0 | External state updates |
| Agent tool definitions | ⚠️ Types | Types only | P0 | Tool call/result types |
| Worker health endpoint | ❌ No | - | - | Ops only |
| `GET /v1/a2a/tasks/:id/messages` | ✅ Yes | `sly.a2a` | P1 | Full conversation history |

**SDK Stories Required:**
- Story 58.11: Add agent config and task processing types to SDK
- Story 58.12: Add worker MCP tools for task management

---

## Architecture

### Processing Model Overview

A2A is a **client-server protocol** — Sly always mediates. Every task hits Sly's JSON-RPC endpoint, gets stored, and is dispatched by the worker. There is no direct agent-to-agent backchannel. This is by design: it's where governance, billing, audit logging, and mandate enforcement happen.

```
                          ┌──────────────────────────────────────────┐
                          │            Sly Platform                   │
                          │                                          │
External Agent ──A2A──>   │  POST /a2a/:agentId                     │
                          │       │                                  │
                          │       ▼                                  │
                          │  ┌──────────┐    ┌───────────────────┐   │
                          │  │ JSON-RPC │───>│   a2a_tasks DB    │   │
                          │  │ Handler  │    │  state: submitted │   │
                          │  └──────────┘    └────────┬──────────┘   │
                          │                           │              │
                          │                  ┌────────▼──────────┐   │
                          │                  │  Task Processor   │   │
                          │                  │     Worker        │   │
                          │                  │  (polls every N)  │   │
                          │                  └────────┬──────────┘   │
                          │                           │              │
                          │              ┌────────────┼────────────┐ │
                          │              ▼            ▼            ▼ │
                          │         ┌────────┐  ┌─────────┐  ┌─────┐│
                          │         │  LLM   │  │Webhook  │  │Human││
                          │         │Dispatch│  │Callback │  │Loop ││
                          │         └───┬────┘  └────┬────┘  └──┬──┘│
                          │             │            │          │   │
                          │             ▼            │          │   │
                          │        Sly APIs          │          │   │
                          │    (wallets, mandates,   │          │   │
                          │     transfers, x402)     │          │   │
                          │             │            │          │   │
                          │             ▼            ▼          ▼   │
                          │        ┌─────────────────────────────┐  │
                          │        │  Task updated: completed /  │  │
                          │        │  input-required / failed    │  │
                          │        └─────────────────────────────┘  │
                          └──────────────────────────────────────────┘
```

### Three Processing Modes

| Mode | When | Who Processes | Latency Profile |
|------|------|---------------|-----------------|
| **`managed`** | Agent has LLM config | Sly's task processor calls LLM with tools | 1-8s (LLM inference + tool calls) |
| **`webhook`** | Agent has `callbackUrl` | External system, updates task via API | 100ms-minutes (depends on external) |
| **`manual`** | Agent has neither, or task escalated | Human via dashboard or API | Minutes-hours |

### Latency Analysis: Managed Agent (LLM-Backed)

This is the primary scenario — Sly hosts the agent's "brain."

```
Timeline for "Check wallet balance" task:
─────────────────────────────────────────────────────────────
 0ms    Task created (submitted)
 ~200ms Worker claims task (poll interval)
 ~250ms Load agent config + conversation history
 ~300ms Build LLM prompt (system prompt + history + tools)
 ~2500ms LLM inference (Claude Sonnet → tool call decision)
 ~2600ms Execute tool: GET /v1/wallets/:id/balance
 ~3000ms LLM generates natural language response
 ~3100ms Task updated: completed, artifacts added
─────────────────────────────────────────────────────────────
 Total: ~3.1s for simple single-tool task
```

```
Timeline for "Transfer 1000 USDC to account xyz" task:
─────────────────────────────────────────────────────────────
 0ms    Task created (submitted)
 ~200ms Worker claims task
 ~300ms Load agent config + history + mandate budget
 ~2800ms LLM inference → decides: check mandate → call transfer
 ~2900ms Tool 1: Check mandate remaining budget
 ~3100ms Tool 2: Execute wallet transfer
 ~3500ms LLM generates confirmation with transfer details
 ~3600ms Task updated: completed, artifact with transferId
─────────────────────────────────────────────────────────────
 Total: ~3.6s for multi-tool task with mandate check
```

```
Timeline for "Transfer 50K USDC" (exceeds mandate) task:
─────────────────────────────────────────────────────────────
 0ms    Task created (submitted)
 ~200ms Worker claims task
 ~2800ms LLM inference → mandate check fails → escalation
 ~3000ms Task updated: input-required
         Message: "This exceeds your $10K mandate. Approve?"
─────────────────────────────────────────────────────────────
 Total: ~3s to escalation (then human time)
 
 Later:
 Human approves via dashboard/API
 ~200ms Worker picks up resumed task
 ~2500ms LLM re-evaluates with approval context
 ~2700ms Execute transfer
 ~2800ms Task updated: completed
─────────────────────────────────────────────────────────────
```

### Latency Analysis: Webhook Agent

```
Timeline for webhook-backed agent:
─────────────────────────────────────────────────────────────
 0ms    Task created (submitted)
 ~200ms Worker claims task, loads agent config
 ~250ms POST callback to customer's endpoint
 ~300ms Task updated: working (waiting for external)
         ... external system processes ...
 ~Xms   Customer calls PATCH /v1/a2a/tasks/:id
         with status: completed + artifacts
─────────────────────────────────────────────────────────────
 Sly overhead: ~300ms. Total depends on customer.
```

### Latency Analysis: Agent-to-Agent (Intra-Platform)

Two Sly-hosted agents communicating. The initiating agent's LLM decides it needs another agent's help.

```
Timeline for Procurement Agent → Treasury Agent:
─────────────────────────────────────────────────────────────
 0ms    Procurement task processing
 ~2500ms LLM decides: "Need Treasury to approve funds"
 ~2600ms Tool call: a2a_send_task(treasuryAgentId, message)
 ~2700ms Internal POST /a2a/:treasuryId (bypasses HTTP, direct service call)
 ~2800ms Treasury task created (submitted)
 ~3000ms Treasury worker claims task
 ~5500ms Treasury LLM processes, checks mandate, approves
 ~5600ms Treasury task: completed
 ~5700ms Tool result returned to Procurement LLM
 ~6500ms Procurement LLM generates final response
 ~6600ms Procurement task: completed
─────────────────────────────────────────────────────────────
 Total: ~6.6s (two LLM calls in series)
```

**Optimization for intra-platform:** When both agents are on the same Sly instance, skip HTTP and call the task service directly. This saves ~100ms per hop.

### Latency Analysis: External Agent → Sly Agent (with payment)

```
Timeline for paid A2A task with x402:
─────────────────────────────────────────────────────────────
 0ms    External agent sends message/send
 ~100ms Task created (submitted)
 ~300ms Worker claims, checks agent config
 ~350ms Agent requires payment → task: input-required
         Metadata: { x402_payment_required: { amount, endpoint } }
 ~400ms Response returned to external agent
         ... external agent pays via x402 ...
 ~500ms External agent sends message/send with payment proof
 ~600ms Worker picks up, verifies x402 JWT (~1ms)
 ~650ms Task: working
 ~3000ms LLM processes original request
 ~3200ms Task: completed with artifacts
─────────────────────────────────────────────────────────────
 Total: ~3.2s processing + external payment time
```

### Conversation History & Context Management

```
contextId links tasks into conversations:

Task 1 (no contextId):        "What's my balance?"
  └─ history: [user: "What's my balance?", agent: "Your balance is 5,000 USDC"]

Task 2 (contextId = Task 1):  "Transfer 100 to account xyz"
  └─ worker loads Task 1 history + Task 2 message
  └─ LLM sees full conversation: balance check → transfer request
  └─ history: [user: "Transfer 100 to account xyz", agent: "Transferred 100 USDC..."]

Task 3 (contextId = Task 1):  "What's my balance now?"
  └─ worker loads Task 1 + Task 2 history + Task 3 message
  └─ LLM sees: balance → transfer → new balance check
```

**History loading strategy:**
- Load all tasks sharing the same `contextId`, ordered by `created_at`
- Collect all messages from all tasks into a single conversation
- Cap at last N messages (configurable, default 50) to stay within LLM context window
- Include artifacts from prior tasks as system context when relevant

### Concurrent Task Processing

```sql
-- Atomic claim with SKIP LOCKED: prevents double-processing
UPDATE a2a_tasks
SET state = 'working',
    processor_id = $worker_id,
    processing_started_at = NOW()
WHERE id = (
  SELECT id FROM a2a_tasks
  WHERE state = 'submitted'
    AND processor_id IS NULL
  ORDER BY
    -- Priority: tasks with mandates > tasks with context > new tasks
    CASE
      WHEN mandate_id IS NOT NULL THEN 0  -- payment-linked tasks first
      WHEN context_id IS NOT NULL THEN 1  -- follow-up messages next
      ELSE 2                               -- new conversations last
    END,
    created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Multi-tenant fairness:** Round-robin across tenants prevents one noisy tenant from starving others. Implementation: maintain a `last_served_tenant` cursor and cycle through tenants with pending tasks.

**Scaling:** Worker is stateless — run N instances behind `FOR UPDATE SKIP LOCKED`. Each claims different tasks. Linear horizontal scaling.

---

## Stories

### Phase 1: Worker Foundation

---

### Story 58.1: Agent Processing Configuration

**Points:** 5
**Priority:** P0
**Dependencies:** Epic 57 (complete)

**Description:**
Add processing configuration to agents. Each agent needs to know HOW its tasks should be processed.

**Database Migration:**
```sql
-- Add processing config to agents table
ALTER TABLE agents ADD COLUMN processing_mode TEXT
  DEFAULT 'manual'
  CHECK (processing_mode IN ('managed', 'webhook', 'manual'));

ALTER TABLE agents ADD COLUMN processing_config JSONB DEFAULT '{}';
-- For 'managed': { "model": "claude-sonnet-4-20250514", "systemPrompt": "...", "tools": [...], "maxTokens": 4096, "temperature": 0.3 }
-- For 'webhook': { "callbackUrl": "https://...", "callbackSecret": "whsec_...", "timeoutMs": 30000 }
-- For 'manual': {} (tasks stay in submitted until human acts)

-- Add processing columns to a2a_tasks
ALTER TABLE a2a_tasks ADD COLUMN processor_id TEXT;
ALTER TABLE a2a_tasks ADD COLUMN processing_started_at TIMESTAMPTZ;
ALTER TABLE a2a_tasks ADD COLUMN processing_completed_at TIMESTAMPTZ;
ALTER TABLE a2a_tasks ADD COLUMN processing_duration_ms INTEGER;
ALTER TABLE a2a_tasks ADD COLUMN error_details JSONB;
ALTER TABLE a2a_tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE a2a_tasks ADD COLUMN max_retries INTEGER DEFAULT 3;

-- Index for worker claim query
CREATE INDEX idx_a2a_tasks_claimable
  ON a2a_tasks (state, processor_id, created_at)
  WHERE state = 'submitted' AND processor_id IS NULL;
```

**API Endpoints:**
- `GET /v1/a2a/agents/:agentId/config` — read processing config
- `PUT /v1/a2a/agents/:agentId/config` — update processing config

**Files:**
- `apps/api/supabase/migrations/20260220_a2a_task_processor.sql` (NEW)
- `apps/api/src/routes/a2a.ts` (MODIFY — add config endpoints)
- `apps/api/src/services/a2a/types.ts` (MODIFY — add ProcessingConfig types)

**Acceptance Criteria:**
- [ ] Migration runs without errors
- [ ] Can set agent to `managed`, `webhook`, or `manual` mode
- [ ] Config validation rejects invalid combinations (e.g. `managed` without `model`)
- [ ] Existing agents default to `manual`
- [ ] `pnpm build` passes

**SDK Exposure:** `sly.a2a.getAgentConfig()`, `sly.a2a.updateAgentConfig()`

---

### Story 58.2: Agent Tool Registry (Reusing MCP Tool Definitions)

**Points:** 8
**Priority:** P0
**Dependencies:** Story 58.1

**Description:**
Build a tool registry that reuses the existing MCP tool definitions (`packages/mcp-server/src/index.ts`) as the canonical schema, but wraps them with permission-based filtering and an in-process execution layer. The MCP server already defines 50+ tools covering the full Sly platform surface. Rather than creating a parallel tool set, we import MCP tool schemas and adapt them for agent-internal use.

**Why Not Just Call MCP Tools Directly?**

The MCP server operates over stdio with HTTP SDK calls underneath. Agent tools need three things MCP doesn't provide:
1. **In-process execution** — Call Sly services directly, skip HTTP. Saves ~100ms per tool call (×3-4 calls per task = 300-400ms saved).
2. **Permission scoping** — MCP has full tenant access. Agent tools are filtered by the agent's permissions. An agent with `transactions.read` shouldn't see `ap2_execute_mandate`.
3. **Context injection** — Agent's walletId, mandateIds, accountId are pre-loaded. The LLM doesn't waste a tool call discovering "which wallet am I?" every time.

**Architecture:**
```
MCP Tool Definitions (canonical schema)
  │
  ├── MCP Server: schema → SDK → HTTP → API (for Claude Desktop users)
  │
  └── Agent Tool Registry: schema → permission filter → direct service call (for managed agents)
                              │
                              ├── AgentContext injected (walletId, mandateIds, etc.)
                              ├── Results structured for LLM consumption
                              └── ~100ms faster per call vs HTTP path
```

**Permission → Tool Mapping:**

| Agent Permission | MCP Tools Available | Notes |
|------------------|---------------------|-------|
| `wallets.read` | `get_wallet_balance`, `get_wallet`, `list_wallets` | Balance checks |
| `wallets.write` | `wallet_deposit`, `wallet_withdraw` | Fund movements |
| `transactions.read` | `get_agent_transactions`, `get_settlement_status` | History |
| `transactions.initiate` | `create_settlement`, `get_settlement_quote` | Settlements |
| `mandates.read` | `ap2_get_mandate`, `ap2_list_mandates` | Mandate inspection |
| `mandates.execute` | `ap2_execute_mandate` | Spending against mandate |
| `accounts.read` | `list_accounts`, `get_agent` | Entity lookups |
| `checkouts.write` | `ucp_create_checkout`, `ucp_complete_checkout`, `acp_create_checkout` | Commerce |
| `a2a.send` | `a2a_send_task`, `a2a_discover_agent` | Agent-to-agent (always on) |
| *(always available)* | `get_agent_info` (synthetic) | Agent's own context |

**Implementation:**
```typescript
import { tools as mcpToolDefinitions } from '@sly/mcp-server'; // Import schemas

interface AgentContext {
  tenantId: string;
  agentId: string;
  accountId: string;
  walletId?: string;
  mandateIds: string[];
  permissions: string[];
}

interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string; suggestedAction?: string };
}

class AgentToolRegistry {
  // Import MCP schemas as-is for LLM function calling
  private toolSchemas = mcpToolDefinitions;
  
  // Map MCP tool names to required permissions
  private permissionMap: Record<string, string[]> = {
    'get_wallet_balance': ['wallets.read'],
    'ap2_execute_mandate': ['mandates.execute'],
    'ucp_create_checkout': ['checkouts.write'],
    'a2a_send_task': [],  // Always available
    // ... etc
  };

  // Get tools this agent can use (filtered by permissions)
  getToolsForAgent(ctx: AgentContext): ToolDefinition[] {
    return this.toolSchemas.filter(tool => {
      const required = this.permissionMap[tool.name] || [];
      return required.every(p => ctx.permissions.includes(p));
    });
  }

  // Execute tool in-process (direct service call, no HTTP)
  async executeTool(ctx: AgentContext, toolName: string, args: unknown): Promise<ToolResult> {
    // Inject agent context (e.g., auto-fill walletId if not provided)
    const enrichedArgs = this.injectContext(ctx, toolName, args);
    // Call service directly instead of HTTP
    return this.handlers[toolName](ctx, enrichedArgs);
  }
}
```

**Context Injection Examples:**
- `get_wallet_balance` with no `walletId` → auto-fills from `ctx.walletId`
- `ap2_execute_mandate` → validates mandateId is in `ctx.mandateIds`
- `a2a_send_task` → auto-fills `context_id` from current task's context
- Synthetic `get_agent_info` tool → returns agent's own details, wallet, mandates without any API call

**Files:**
- `apps/api/src/services/a2a/tools/registry.ts` (NEW — AgentToolRegistry class)
- `apps/api/src/services/a2a/tools/permission-map.ts` (NEW — permission → tool mapping)
- `apps/api/src/services/a2a/tools/handlers.ts` (NEW — in-process execution handlers)
- `apps/api/src/services/a2a/tools/context-injector.ts` (NEW — auto-fill agent context)
- `packages/mcp-server/src/index.ts` (MODIFY — export tool definitions array for reuse)

**Acceptance Criteria:**
- [ ] Tool schemas imported from MCP server (single source of truth)
- [ ] Permission filtering correctly scopes tools per agent
- [ ] In-process handlers call services directly (no HTTP)
- [ ] Context injection auto-fills walletId, mandateIds, accountId
- [ ] Synthetic `get_agent_info` tool works without API call
- [ ] Tool results structured with success/error pattern for LLM consumption
- [ ] `pnpm build` passes

**SDK Exposure:** Types only — `AgentToolDefinition`, `ToolResult`

---

### Story 58.3: Task Claim & Dispatch Service

**Points:** 8
**Priority:** P0
**Dependencies:** Story 58.1

**Description:**
Core worker loop that claims tasks and dispatches to the correct handler. This is the heart of the task processor.

**Implementation:**

```typescript
// apps/api/src/services/a2a/task-processor.ts

export class TaskProcessor {
  private workerId: string;
  private running = false;
  private pollIntervalMs = 200;  // 200ms default poll
  private maxConcurrent = 5;     // max tasks in-flight per worker
  private activeTaskCount = 0;

  async start(): Promise<void> {
    this.running = true;
    this.workerId = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
    
    while (this.running) {
      if (this.activeTaskCount >= this.maxConcurrent) {
        await sleep(50);
        continue;
      }

      const task = await this.claimNextTask();
      if (!task) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      // Process async — don't block the claim loop
      this.activeTaskCount++;
      this.processTask(task)
        .catch(err => this.handleProcessingError(task, err))
        .finally(() => this.activeTaskCount--);
    }
  }

  private async claimNextTask(): Promise<A2ATask | null> {
    // Uses FOR UPDATE SKIP LOCKED (see Architecture section)
    // Returns null if no claimable tasks
  }

  private async processTask(task: A2ATask): Promise<void> {
    const agent = await this.agentService.getAgent(task.tenantId, task.agentId);
    const config = agent.processingConfig;
    const startTime = Date.now();

    try {
      switch (agent.processingMode) {
        case 'managed':
          await this.managedHandler.process(task, agent, config);
          break;
        case 'webhook':
          await this.webhookHandler.dispatch(task, agent, config);
          break;
        case 'manual':
          // Task stays in submitted — no processing
          // But log it for dashboard visibility
          await this.taskService.addSystemMessage(task.id, 
            'Task queued for manual processing');
          break;
      }
    } finally {
      const duration = Date.now() - startTime;
      await this.taskService.recordProcessingDuration(task.id, duration);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    // Wait for in-flight tasks to complete (graceful shutdown)
    while (this.activeTaskCount > 0) {
      await sleep(100);
    }
  }
}
```

**Claim Query Priority:**
1. Tasks linked to mandates (payment-critical)
2. Follow-up messages (contextId present — agent is mid-conversation)
3. New conversations (no contextId)
4. Within each priority: FIFO by created_at

**Multi-Tenant Fairness:**
- Round-robin tenant selection when multiple tenants have pending tasks
- Configurable per-tenant concurrency limit (default: 3 tasks/tenant in flight)

**Files:**
- `apps/api/src/services/a2a/task-processor.ts` (NEW)
- `apps/api/src/services/a2a/handlers/index.ts` (NEW — handler interface)

**Acceptance Criteria:**
- [ ] Worker starts and polls for tasks
- [ ] Claims tasks atomically with `FOR UPDATE SKIP LOCKED`
- [ ] Dispatches to correct handler based on `processing_mode`
- [ ] Respects max concurrent limit
- [ ] Records processing duration
- [ ] Graceful shutdown waits for in-flight tasks
- [ ] No double-processing under concurrent workers

**SDK Exposure:** None (internal service)

---

### Story 58.4: LLM Managed Handler

**Points:** 13
**Priority:** P0
**Dependencies:** Stories 58.2, 58.3

**Description:**
The managed handler calls an LLM (Claude, GPT) with the agent's system prompt, conversation history, and available tools. This is where agents come alive.

**Processing Flow:**
```
1. Load conversation history (all tasks in contextId)
2. Build system prompt from agent config
3. Filter available tools by agent permissions
4. Call LLM with messages + tools
5. If LLM returns tool_use:
   a. Execute tool via ToolRegistry
   b. Append tool result to messages
   c. Call LLM again (loop until text response or max iterations)
6. If LLM returns text response:
   a. Add assistant message to task history
   b. Create artifact if structured data present
   c. Set task state to completed
7. If LLM signals escalation (via special tool or keyword):
   a. Set task state to input-required
   b. Add message explaining what's needed
```

**LLM Integration:**
```typescript
interface LLMConfig {
  provider: 'anthropic' | 'openai';    // Start with Anthropic
  model: string;                        // e.g. "claude-sonnet-4-20250514"
  maxTokens: number;
  temperature: number;
  systemPrompt: string;                 // Agent's personality + instructions
  maxToolIterations: number;            // Default: 10, prevent infinite loops
}
```

**System Prompt Template:**
```
You are {agent.name}, an AI agent on the Sly payment platform.
{agent.description}

Your account: {account.name} (ID: {account.id})
Your wallet: {wallet.id} (Balance: {wallet.balance} USDC)
Active mandates: {mandates summary}

You have access to the following tools to accomplish tasks.
Always check mandate budgets before making transfers.
If a request exceeds your authorization, set the task to input-required
and explain what approval is needed.

{custom system prompt from agent config}
```

**Conversation History Assembly:**
```typescript
async function buildConversationHistory(
  task: A2ATask,
  contextId: string | null
): Promise<LLMMessage[]> {
  if (!contextId) {
    // Single task — just return its messages
    return task.history.map(toLLMMessage);
  }

  // Multi-turn: load all tasks in this context
  const contextTasks = await taskService.getTasksByContext(
    task.tenantId, contextId
  );

  // Flatten all messages across tasks, chronological
  const allMessages = contextTasks
    .flatMap(t => t.history)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Cap to last N messages
  const maxMessages = 50;
  return allMessages.slice(-maxMessages).map(toLLMMessage);
}
```

**Error Handling:**
- LLM API timeout (30s) → retry once, then fail task
- Tool execution error → pass error back to LLM for recovery
- Max tool iterations reached → complete with partial result + warning
- LLM rate limit → exponential backoff, retry up to 3 times

**Files:**
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (NEW)
- `apps/api/src/services/a2a/llm-client.ts` (NEW — LLM API abstraction)

**Acceptance Criteria:**
- [ ] Calls Claude API with system prompt, history, and tools
- [ ] Executes tool calls and loops back to LLM
- [ ] Respects `maxToolIterations` limit
- [ ] Loads full conversation history for multi-turn via `contextId`
- [ ] Sets task to `completed` with assistant message and artifacts
- [ ] Sets task to `input-required` when escalation needed
- [ ] Handles LLM errors gracefully (retry, fallback, fail)
- [ ] Records token usage in task metadata

**SDK Exposure:** None (internal handler)

---

### Story 58.5: Webhook Handler

**Points:** 5
**Priority:** P0
**Dependencies:** Story 58.3

**Description:**
The webhook handler forwards tasks to external systems and provides an API for them to update task state.

**Outbound Webhook:**
```typescript
// POST to agent's callbackUrl
{
  event: "task.submitted",
  task: {
    id: "...",
    agentId: "...",
    state: "working",
    history: [...],
    contextId: "..."
  },
  timestamp: "2026-02-20T17:00:00Z",
  webhookId: "wh_..."
}

// Signed with HMAC-SHA256 using callbackSecret
// Header: X-Sly-Signature: t=timestamp,v1=signature
```

**Inbound State Update API:**
```
PATCH /v1/a2a/tasks/:taskId
Authorization: Bearer pk_test_...
Content-Type: application/json

{
  "state": "completed",
  "message": {
    "role": "agent",
    "parts": [{ "text": "Transfer complete. ID: txn_abc123" }]
  },
  "artifacts": [{
    "artifactId": "art-1",
    "parts": [{ "data": { "transferId": "txn_abc123", "amount": 1000 } }]
  }]
}
```

**Valid state transitions via API:**
- `working` → `completed` | `failed` | `input-required`
- `input-required` → `working` | `completed` | `failed` (after human input)

**Timeout Handling:**
- If no response within `config.timeoutMs` (default 30s), retry once
- After 2 failures, set task to `failed` with timeout error
- Dashboard shows webhook delivery status and retry count

**Files:**
- `apps/api/src/services/a2a/handlers/webhook-handler.ts` (NEW)
- `apps/api/src/routes/a2a.ts` (MODIFY — add PATCH /v1/a2a/tasks/:id)

**Acceptance Criteria:**
- [ ] POST webhook with HMAC signature to callback URL
- [ ] PATCH endpoint accepts state updates from external systems
- [ ] Validates state transitions (can't go backward)
- [ ] Timeout and retry logic works
- [ ] Webhook delivery logged for debugging
- [ ] Task state correctly updated after external response

**SDK Exposure:** `sly.a2a.updateTaskState(taskId, update)`

---

### Story 58.6: Human-in-the-Loop Escalation

**Points:** 5
**Priority:** P1
**Dependencies:** Story 58.4

**Description:**
When a managed agent sets task state to `input-required`, humans need a way to respond. This story creates the escalation and resumption flow.

**Escalation Triggers:**
1. LLM explicitly calls `escalate_to_human` tool
2. Transfer exceeds mandate budget
3. Compliance flag raised during tool execution
4. Agent config has `requireApprovalAbove` threshold

**Dashboard Integration:**
- "Pending Approvals" section on agent detail page
- Task shows message from agent explaining what's needed
- Human can reply with text message (adds to task history)
- Human can approve/reject with one click (adds structured response)

**Resumption Flow:**
```
Human responds via:
  - Dashboard: POST /v1/a2a/tasks/:id/respond { message: "Approved" }
  - API: PATCH /v1/a2a/tasks/:id (with new message, state → submitted)

Worker picks up the resumed task:
  - Loads full history including human's response
  - LLM sees: original request → escalation → human approval
  - LLM proceeds with the approved action
  - Task → completed
```

**API:**
- `POST /v1/a2a/tasks/:taskId/respond` — add human message and re-queue
- Sets task state back to `submitted` so worker picks it up again

**Files:**
- `apps/api/src/routes/a2a.ts` (MODIFY — add respond endpoint)
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — handle resumed tasks)

**Acceptance Criteria:**
- [ ] `escalate_to_human` tool available to managed agents
- [ ] Human response re-queues task as `submitted`
- [ ] Worker loads full history including human message on resumption
- [ ] LLM correctly processes resumed context
- [ ] Dashboard shows pending approvals (deferred to Epic 52 redesign)

**SDK Exposure:** `sly.a2a.respondToTask(taskId, message)`

---

### Phase 2: Agent-to-Agent Communication

---

### Story 58.7: Intra-Platform Agent-to-Agent

**Points:** 8
**Priority:** P0
**Dependencies:** Story 58.4

**Description:**
Enable Sly-managed agents to send tasks to other Sly agents. When an agent's LLM decides it needs another agent's help, it calls the `send_a2a_task` tool. For intra-platform communication, bypass HTTP and call the task service directly.

**Tool Definition:**
```typescript
{
  name: "send_a2a_task",
  description: "Send a task to another Sly agent. Use when you need help from a specialized agent (e.g., Treasury Agent for payments, Compliance Agent for screening).",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Target agent ID" },
      message: { type: "string", description: "What you need the agent to do" },
      waitForCompletion: { type: "boolean", default: true, description: "Wait for the agent to complete the task before continuing" }
    },
    required: ["agentId", "message"]
  }
}
```

**Synchronous vs Async:**
- `waitForCompletion: true` (default) — tool blocks until target agent completes. The initiating agent's LLM gets the result as tool output. **Timeout: 30s.**
- `waitForCompletion: false` — tool returns immediately with task ID. Agent can poll later via `get_a2a_task` tool.

**Intra-Platform Optimization:**
```typescript
async function handleSendA2ATask(ctx: AgentContext, args: SendTaskArgs): Promise<ToolResult> {
  const targetAgent = await agentService.getAgent(ctx.tenantId, args.agentId);

  if (!targetAgent) {
    return { success: false, error: { code: 'AGENT_NOT_FOUND', message: '...' } };
  }

  // Same tenant — direct service call (skip HTTP)
  const task = await taskService.createTask(ctx.tenantId, args.agentId, {
    role: 'user',
    parts: [{ text: args.message }],
    metadata: { initiatingAgentId: ctx.agentId, initiatingTaskId: ctx.currentTaskId }
  });

  if (args.waitForCompletion) {
    // Poll until complete or timeout
    const result = await waitForTaskCompletion(task.id, 30000);
    return {
      success: result.state === 'completed',
      data: { taskId: task.id, state: result.state, artifacts: result.artifacts }
    };
  }

  return { success: true, data: { taskId: task.id, state: 'submitted' } };
}
```

**Cross-Tenant (External A2A):**
If `agentId` is not found locally, check if it's a URL pointing to an external agent. Fall back to HTTP A2A client (Story 57.10).

**Context Propagation:**
- Intra-platform tasks share `contextId` chain for full audit trail
- `initiatingAgentId` and `initiatingTaskId` in metadata for traceability
- Dashboard can show the full agent-to-agent task graph

**Files:**
- `apps/api/src/services/a2a/tools/handlers.ts` (MODIFY — add send_a2a_task)
- `apps/api/src/services/a2a/task-processor.ts` (MODIFY — support wait-for-completion)

**Acceptance Criteria:**
- [ ] Agent A's LLM can call `send_a2a_task` targeting Agent B
- [ ] Intra-platform calls bypass HTTP
- [ ] `waitForCompletion: true` blocks until target completes (with timeout)
- [ ] `waitForCompletion: false` returns task ID immediately
- [ ] Cross-reference metadata links parent ↔ child tasks
- [ ] Falls back to HTTP for external agents

**SDK Exposure:** Types only

---

### Story 58.8: Task Processing with Payment Gating

**Points:** 5
**Priority:** P0
**Dependencies:** Stories 58.4, 57.9

**Description:**
Integrate payment verification into the task processing flow. When an external agent sends a task to a paid Sly agent, the worker checks payment status before processing.

**Flow:**
```
Task arrives → Worker claims →
  Is this a paid agent?
    No → Process normally
    Yes → Does task have payment proof?
      Yes → Verify x402 JWT → Process normally
      No → Set state: input-required
           Metadata: { x402_payment_required: { amount, walletId, endpoint } }
           Return to caller

Caller receives input-required → pays via x402 → sends follow-up message with proof →
  Worker claims resumed task → verifies proof → processes
```

**Agent Payment Config:**
```typescript
// In agent's processing_config:
{
  "payment": {
    "required": true,
    "amount": 0.50,          // USDC per task
    "currency": "USDC",
    "freeSkills": ["agent_info"],  // These skills don't require payment
    "mandateAccepted": true   // Accept AP2 mandates as payment
  }
}
```

**Files:**
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — add payment gate)
- `apps/api/src/services/a2a/payment-handler.ts` (MODIFY from Story 57.9)

**Acceptance Criteria:**
- [ ] Paid agents require payment before processing
- [ ] Free skills bypass payment gate
- [ ] x402 JWT verification uses existing infrastructure (~1ms)
- [ ] AP2 mandate execution accepted as alternative payment
- [ ] Payment metadata included in task response
- [ ] Same-tenant agents bypass payment (intra-platform)

**SDK Exposure:** None (transparent to callers)

---

### Phase 3: Reliability & Operations

---

### Story 58.9: Error Recovery & Dead Letter Queue

**Points:** 5
**Priority:** P0
**Dependencies:** Story 58.3

**Description:**
Handle task processing failures gracefully with retry logic and a dead letter queue for persistent failures.

**Retry Strategy:**
- LLM API error (timeout, rate limit, 5xx): retry 3 times with exponential backoff (1s, 5s, 15s)
- Tool execution error: pass error to LLM for recovery (not a task failure)
- Webhook delivery failure: retry 2 times (1s, 5s), then fail task
- Unrecoverable error (invalid agent config, missing permissions): fail immediately

**Dead Letter Queue:**
```sql
CREATE TABLE a2a_dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  task_id UUID NOT NULL REFERENCES a2a_tasks(id),
  agent_id UUID NOT NULL,
  error_type TEXT NOT NULL,   -- 'llm_timeout', 'tool_error', 'webhook_failure', etc.
  error_details JSONB NOT NULL,
  original_state TEXT NOT NULL,
  retry_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,           -- 'auto_retry', 'manual', 'abandoned'
  resolution_notes TEXT
);
```

**Worker Health:**
- `/health/worker` endpoint returns: running, active tasks, last claim time, error rate
- Log processing duration per task for monitoring
- Alert if average processing time exceeds threshold

**Files:**
- `apps/api/src/services/a2a/task-processor.ts` (MODIFY — retry logic)
- `apps/api/supabase/migrations/20260220_a2a_task_processor.sql` (MODIFY — add DLQ table)
- `apps/api/src/routes/health.ts` (MODIFY — add worker health)

**Acceptance Criteria:**
- [ ] LLM errors retry with exponential backoff
- [ ] Persistent failures move to DLQ
- [ ] DLQ entries visible in dashboard (deferred to Epic 52)
- [ ] Worker health endpoint returns status
- [ ] Processing duration logged per task

**SDK Exposure:** None

---

### Story 58.10: Worker Lifecycle & Configuration

**Points:** 5
**Priority:** P0
**Dependencies:** Story 58.3

**Description:**
Manage worker startup, shutdown, and runtime configuration. The worker runs as part of the API process (not a separate service) in development, with the option to run standalone in production.

**Configuration:**
```typescript
interface WorkerConfig {
  enabled: boolean;                // ENV: A2A_WORKER_ENABLED (default: true)
  pollIntervalMs: number;          // ENV: A2A_WORKER_POLL_MS (default: 200)
  maxConcurrentTasks: number;      // ENV: A2A_WORKER_MAX_CONCURRENT (default: 5)
  maxConcurrentPerTenant: number;  // ENV: A2A_WORKER_MAX_PER_TENANT (default: 3)
  taskTimeoutMs: number;           // ENV: A2A_WORKER_TASK_TIMEOUT (default: 60000)
  llmTimeoutMs: number;            // ENV: A2A_WORKER_LLM_TIMEOUT (default: 30000)
  shutdownGracePeriodMs: number;   // ENV: A2A_WORKER_SHUTDOWN_GRACE (default: 30000)
}
```

**Startup:**
- Worker starts with the API server (in-process)
- Registers SIGTERM/SIGINT handler for graceful shutdown
- Logs worker ID and configuration on startup

**Graceful Shutdown:**
1. Stop claiming new tasks
2. Wait for in-flight tasks to complete (up to grace period)
3. If grace period exceeded, mark in-flight tasks as `submitted` (unclaim them for another worker)
4. Exit cleanly

**Standalone Mode (Production):**
```bash
# Run as separate process for horizontal scaling
A2A_WORKER_ENABLED=true \
A2A_WORKER_MAX_CONCURRENT=10 \
node dist/worker.js
```

**Files:**
- `apps/api/src/services/a2a/task-processor.ts` (MODIFY — lifecycle management)
- `apps/api/src/worker.ts` (NEW — standalone entry point)
- `apps/api/src/app.ts` (MODIFY — start worker if enabled)

**Acceptance Criteria:**
- [ ] Worker starts with API server when enabled
- [ ] Graceful shutdown completes in-flight tasks
- [ ] Unclaims tasks on forced shutdown
- [ ] All settings configurable via environment variables
- [ ] Standalone entry point for production scaling
- [ ] Worker logs startup config and claim activity

**SDK Exposure:** None

---

### Phase 4: SDK & Integration

---

### Story 58.11: SDK Types & Task Management Methods

**Points:** 5
**Priority:** P0
**Dependencies:** Stories 58.1, 58.5, 58.6

**Description:**
Add task processing types and management methods to the SDK.

**Types:**
```typescript
interface AgentProcessingConfig {
  processingMode: 'managed' | 'webhook' | 'manual';
  processingConfig: ManagedConfig | WebhookConfig | {};
}

interface ManagedConfig {
  model: string;
  systemPrompt: string;
  maxTokens?: number;
  temperature?: number;
  maxToolIterations?: number;
  payment?: PaymentConfig;
}

interface WebhookConfig {
  callbackUrl: string;
  callbackSecret: string;
  timeoutMs?: number;
}

interface TaskStateUpdate {
  state: A2ATaskState;
  message?: { role: 'agent'; parts: A2APart[] };
  artifacts?: A2AArtifact[];
}
```

**Client Methods:**
```typescript
a2a = {
  // ... existing from Story 57.11
  getAgentConfig: (agentId: string) => ...,
  updateAgentConfig: (agentId: string, config: AgentProcessingConfig) => ...,
  updateTaskState: (taskId: string, update: TaskStateUpdate) => ...,
  respondToTask: (taskId: string, message: string) => ...,
};
```

**Files:**
- `packages/api-client/src/types.ts` (MODIFY)
- `packages/api-client/src/client.ts` (MODIFY)

**Acceptance Criteria:**
- [ ] Types match API shapes
- [ ] Client methods work with endpoints
- [ ] `pnpm build` passes

**SDK Exposure:** Full client surface

---

### Story 58.12: End-to-End Integration Tests

**Points:** 8
**Priority:** P0
**Dependencies:** All previous stories

**Description:**
Integration tests covering all processing modes and scenarios.

**Test Scenarios:**

| # | Scenario | Processing Mode | Expected Behavior |
|---|----------|-----------------|-------------------|
| 1 | Simple balance check | managed | LLM calls `check_balance`, returns result |
| 2 | Transfer within mandate | managed | LLM calls `check_mandate` → `make_transfer`, completes |
| 3 | Transfer exceeds mandate | managed | LLM escalates, task → `input-required` |
| 4 | Human approves escalation | managed | Task resumes, LLM completes transfer |
| 5 | Agent-to-agent (intra) | managed × 2 | Agent A sends task to Agent B, gets result |
| 6 | Webhook dispatch | webhook | POST to callback URL, external updates task |
| 7 | Webhook timeout | webhook | Retry, then fail task |
| 8 | Paid task (x402) | managed | Payment required → paid → processed |
| 9 | Multi-turn conversation | managed | contextId links 3 tasks, LLM sees full history |
| 10 | Concurrent claims | managed | 2 workers don't double-process |
| 11 | Worker graceful shutdown | managed | In-flight task completes, new tasks unclaimed |
| 12 | DLQ on persistent failure | managed | 3 retries, then DLQ entry created |

**Performance Benchmarks:**
- Single-tool task: < 5s end-to-end
- Multi-tool task: < 10s end-to-end
- Intra-platform agent-to-agent: < 12s (2 LLM calls)
- Task claim latency: < 300ms from submission

**Files:**
- `apps/api/tests/integration/a2a-task-processor.test.ts` (NEW)
- `apps/api/tests/integration/a2a-agent-to-agent.test.ts` (NEW)

**Acceptance Criteria:**
- [ ] All 12 scenarios pass
- [ ] Performance benchmarks met
- [ ] No flaky tests under concurrent load
- [ ] `pnpm test` passes

**SDK Exposure:** None

---

## Implementation Sequence

```
Phase 1: Worker Foundation (Stories 58.1-58.6)
  58.1: Agent processing config (DB + API)          [5 pts]
       ↓
  58.2: Sly tool definitions                        [8 pts]  ─┐
  58.3: Task claim & dispatch service               [8 pts]  ─┤ parallel
       ↓                                                      │
  58.4: LLM managed handler                         [13 pts] ←┘
  58.5: Webhook handler                             [5 pts]  (parallel with 58.4)
  58.6: Human-in-the-loop escalation                [5 pts]
       ↓
Phase 2: Agent-to-Agent (Stories 58.7-58.8)
  58.7: Intra-platform agent-to-agent               [8 pts]
  58.8: Payment gating                              [5 pts]  (parallel with 58.7)
       ↓
Phase 3: Reliability (Stories 58.9-58.10)
  58.9: Error recovery & DLQ                        [5 pts]
  58.10: Worker lifecycle & config                  [5 pts]  (parallel with 58.9)
       ↓
Phase 4: SDK & Testing (Stories 58.11-58.12)
  58.11: SDK types & methods                        [5 pts]
  58.12: End-to-end integration tests               [8 pts]
```

**Critical path:** 58.1 → 58.2+58.3 → 58.4 → 58.7 → 58.12

**Estimated time:** 2-3 weeks with one developer, or 1-1.5 weeks with parallel streams.

---

## Verification Plan

1. `pnpm build` — all packages compile
2. Configure Treasury Agent as `managed` with Claude Sonnet
3. Send `message/send`: "What's my wallet balance?" → task completes with balance
4. Send `message/send`: "Transfer 100 USDC to account xyz" → task completes with transfer ID
5. Send `message/send`: "Transfer 50K USDC" (exceeds mandate) → task `input-required`
6. Respond to escalation → task resumes and completes
7. Agent A sends task to Agent B → both complete correctly
8. Webhook agent receives callback → external system responds → task completes
9. Worker handles LLM timeout → retry → eventually completes or DLQ
10. Performance benchmarks: single-tool < 5s, multi-tool < 10s
11. `pnpm test` — all tests pass

---

## Phase 5: Production Gaps (Stories 58.13-58.18)

These stories address critical gaps identified during architecture review. Without them, Sly agents work but will fail in real demos, at scale, or with enterprise customers.

---

### Story 58.13: SSE Streaming via `message/stream`

**Points:** 13
**Priority:** P0 — Demo Blocker
**Dependencies:** Story 58.4 (LLM Managed Handler)

**Description:**
This is the single biggest gap. Right now when an external agent (or a demo) sends `message/send`, they get back `{ state: "submitted" }` and then... silence. They have to poll `tasks/get` every 500ms-2s, getting `submitted`... `submitted`... `working`... `working`... and then suddenly `completed` with the full response. For a task that takes 4 seconds, that's 2-8 wasted HTTP round trips and zero feedback that anything is happening.

In a live demo, this is the difference between "watch the agent think in real-time" and "wait... wait... wait... ok here's the answer." Every competing A2A implementation will have streaming. Ours must too.

The A2A v1.0 spec defines `message/stream` as an SSE (Server-Sent Events) method on the same JSON-RPC endpoint. Instead of returning a single JSON-RPC response, it returns a stream of events as the task progresses.

**The Current Pain (Polling):**
```
Client                          Sly
  │── message/send ──────────>│
  │<── { state: submitted } ──│
  │                            │  (worker claims, 200ms)
  │── tasks/get ─────────────>│  (LLM starting...)
  │<── { state: working } ────│
  │                            │
  │── tasks/get ─────────────>│  (LLM thinking...)
  │<── { state: working } ────│
  │                            │
  │── tasks/get ─────────────>│  (tool call executing...)
  │<── { state: working } ────│
  │                            │
  │── tasks/get ─────────────>│  (LLM generating response...)
  │<── { state: working } ────│
  │                            │
  │── tasks/get ─────────────>│  (done!)
  │<── { state: completed,   ─│
  │     history: [...] }       │
  │                            │
  Total: 5 HTTP round trips, 4s of blind waiting
```

**The Fix (Streaming):**
```
Client                          Sly
  │── message/stream ────────>│
  │<── SSE: event=status ─────│  { state: "working" }
  │<── SSE: event=status ─────│  { state: "working", message: "Checking wallet balance..." }
  │<── SSE: event=artifact ───│  { artifactId: "bal-1", parts: [{ data: { balance: 5000 } }] }
  │<── SSE: event=status ─────│  { state: "working", message: "Generating response..." }
  │<── SSE: event=message ────│  { role: "agent", parts: [{ text: "Your balance is..." }] }
  │<── SSE: event=status ─────│  { state: "completed" }
  │<── SSE: [DONE] ───────────│
  │                            │
  Total: 1 HTTP connection, real-time progress
```

**SSE Event Types (per A2A v1.0 spec):**

| Event | When | Data |
|-------|------|------|
| `status` | Task state changes | `{ id, status: { state, message, timestamp } }` |
| `message` | Agent produces text | `{ id, message: { role, parts } }` |
| `artifact` | Agent produces output | `{ id, artifact: { artifactId, parts } }` |
| `error` | Processing error | `{ id, error: { code, message } }` |

**Implementation Architecture:**

```typescript
// In a2a.ts route handler:
case 'message/stream': {
  // Create task (same as message/send)
  const task = await taskService.createTask(agentId, message, contextId);
  
  // Return SSE stream
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: object) => {
          controller.enqueue(encoder.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          ));
        };

        // Subscribe to task events
        const unsubscribe = taskEventBus.subscribe(task.id, (event) => {
          switch (event.type) {
            case 'state_change':
              send('status', { id: task.id, status: event.status });
              break;
            case 'message':
              send('message', { id: task.id, message: event.message });
              break;
            case 'artifact':
              send('artifact', { id: task.id, artifact: event.artifact });
              break;
            case 'error':
              send('error', { id: task.id, error: event.error });
              controller.close();
              break;
            case 'done':
              send('status', { id: task.id, status: { state: 'completed' } });
              controller.close();
              break;
          }
        });

        // Cleanup on disconnect
        controller.signal?.addEventListener('abort', unsubscribe);
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',  // Disable nginx buffering
      },
    }
  );
}
```

**Task Event Bus:**

The key new component. The managed handler (58.4) currently just writes to the database when state changes. With streaming, it also emits events to an in-process event bus. For single-instance deployment, an `EventEmitter` suffices. For multi-instance, use Postgres `LISTEN/NOTIFY` or Redis pub/sub.

```typescript
class TaskEventBus {
  private emitter = new EventEmitter();

  emit(taskId: string, event: TaskEvent): void {
    this.emitter.emit(`task:${taskId}`, event);
  }

  subscribe(taskId: string, handler: (event: TaskEvent) => void): () => void {
    this.emitter.on(`task:${taskId}`, handler);
    return () => this.emitter.off(`task:${taskId}`, handler);
  }
}
```

**LLM Token Streaming:**

For Claude/GPT, the LLM client can use streaming responses (`stream: true`). As tokens arrive, emit `message` events with partial text. This gives true real-time "agent typing" feel:

```typescript
// In managed-handler.ts, modify LLM call:
const stream = await anthropic.messages.stream({
  model: config.model,
  messages: history,
  tools: toolDefinitions,
  max_tokens: config.maxTokens,
});

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    taskEventBus.emit(taskId, {
      type: 'message',
      message: { role: 'agent', parts: [{ text: event.delta.text }] },
      partial: true,  // Indicates this is a streaming chunk, not final
    });
  }
}
```

**Latency Comparison:**

| Scenario | Polling (current) | Streaming (this story) |
|----------|-------------------|------------------------|
| Simple balance check (3s) | 3s blind + 2-6 polls | Real-time status updates, tokens stream at ~500ms |
| Multi-tool transfer (5s) | 5s blind + 4-10 polls | See each tool call as it happens |
| Agent-to-agent (7s) | 7s blind + 6-14 polls | See "Consulting Treasury Agent..." in real-time |
| Escalation (input-required) | Discover after next poll | Immediate notification with reason |

**Agent Card Update:**

Our agent cards currently declare `capabilities: { streaming: false }`. This story flips it to `true` and adds the streaming interface URL.

**Files:**
- `apps/api/src/services/a2a/task-event-bus.ts` (NEW — in-process event bus)
- `apps/api/src/services/a2a/jsonrpc-handler.ts` (MODIFY — add `message/stream` method)
- `apps/api/src/routes/a2a.ts` (MODIFY — SSE response handling for stream method)
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — emit events during processing)
- `apps/api/src/services/a2a/llm-client.ts` (MODIFY — use streaming LLM calls)
- `apps/api/src/services/a2a/agent-card.ts` (MODIFY — `streaming: true`)

**Acceptance Criteria:**
- [ ] `message/stream` returns SSE stream with proper headers
- [ ] State changes emit `status` events in real-time
- [ ] Agent text streams token-by-token via `message` events
- [ ] Tool calls emit status updates ("Checking balance...")
- [ ] Artifacts emit as `artifact` events when produced
- [ ] Stream closes cleanly on completion, failure, or client disconnect
- [ ] Falls back gracefully if client doesn't support SSE (returns JSON like `message/send`)
- [ ] Agent cards declare `streaming: true`
- [ ] Works through Vercel/Railway reverse proxies (X-Accel-Buffering disabled)
- [ ] Demo: send task, see real-time progress in terminal/browser EventSource

**SDK Exposure:** `sly.a2a.streamTask()` returning `AsyncIterable<TaskEvent>`

---

### Story 58.14: LLM Cost Controls & Token Budgeting

**Points:** 8
**Priority:** P0 — Runaway Cost Protection
**Dependencies:** Story 58.4 (LLM Managed Handler)

**Description:**
Every managed agent task triggers at least one LLM call. A multi-tool task loops 3-4 times. An agent-to-agent chain doubles it. Without controls, a single chatty integration sending 1,000 tasks/day at an average 3 LLM calls each = 3,000 Anthropic API calls/day per agent. At ~$0.01/call (Sonnet, moderate context), that's $30/day for one agent. Scale to 10 agents across 5 tenants and you're at $1,500/day in LLM costs with zero visibility.

This story adds metering, budgets, and model routing so costs are tracked, capped, and optimized.

**Cost Model:**
```
Single-tool task (balance check):
  - Input: ~800 tokens (system prompt + 1 message + tool defs)
  - Output: ~200 tokens (tool call + response)
  - Cost: ~$0.004 (Sonnet)

Multi-tool task (mandate check → transfer):
  - Input: ~1,200 tokens × 3 rounds
  - Output: ~600 tokens total
  - Cost: ~$0.012 (Sonnet)

10-turn conversation (accumulated context):
  - Input: ~4,000 tokens (growing each turn)
  - Output: ~300 tokens
  - Cost: ~$0.025 (Sonnet)

Agent-to-agent (2 LLM agents in series):
  - Cost: ~$0.020 combined
```

**Budget Configuration:**
```typescript
// Added to agent processing_config:
{
  "model": "claude-sonnet-4-20250514",
  "costControls": {
    "maxTokensPerTask": 8000,        // Hard cap per task (input + output)
    "maxTokensPerDay": 500000,       // Daily budget per agent
    "maxToolIterations": 10,          // Already exists, reinforce here
    "maxTasksPerHour": 100,           // Rate limit on task volume
    "warningThresholdPercent": 80,    // Alert at 80% of daily budget
    "fallbackModel": "claude-haiku-4-5-20251001",  // Downgrade when nearing budget
    "fallbackThresholdPercent": 90    // Switch to fallback at 90%
  }
}
```

**Token Tracking:**
```sql
-- Add to a2a_tasks table:
ALTER TABLE a2a_tasks ADD COLUMN token_usage JSONB DEFAULT '{}';
-- { "inputTokens": 1200, "outputTokens": 350, "totalTokens": 1550,
--   "llmCalls": 3, "model": "claude-sonnet-4-20250514",
--   "estimatedCost": 0.012 }

-- Daily aggregation view:
CREATE VIEW agent_daily_token_usage AS
SELECT
  agent_id,
  DATE(created_at) AS usage_date,
  SUM((token_usage->>'totalTokens')::int) AS total_tokens,
  SUM((token_usage->>'estimatedCost')::numeric) AS total_cost,
  COUNT(*) AS task_count,
  SUM((token_usage->>'llmCalls')::int) AS llm_calls
FROM a2a_tasks
WHERE state IN ('completed', 'failed')
GROUP BY agent_id, DATE(created_at);
```

**Smart Model Routing:**
```
Task arrives → Check daily budget
  │
  ├── Under 80%: Use configured model (e.g., Sonnet)
  ├── 80-90%: Log warning, continue with configured model
  ├── 90-100%: Switch to fallbackModel (e.g., Haiku)
  └── Over 100%: Reject task with error:
      "Agent daily token budget exceeded. Resets at midnight UTC."
```

**Per-Task Enforcement:**
```typescript
// In managed-handler.ts, during LLM loop:
let totalTokens = 0;

for (let i = 0; i < maxIterations; i++) {
  const response = await llmClient.call(messages, tools, model);
  totalTokens += response.usage.input_tokens + response.usage.output_tokens;

  if (totalTokens > config.costControls.maxTokensPerTask) {
    // Graceful stop: return what we have so far
    await addSystemMessage(taskId,
      `Task token limit reached (${totalTokens}/${config.costControls.maxTokensPerTask}). ` +
      `Returning partial result.`);
    break;
  }
  // ... continue tool loop
}

// Record usage
await taskService.recordTokenUsage(taskId, {
  inputTokens, outputTokens, totalTokens, llmCalls: i + 1,
  model, estimatedCost: calculateCost(model, inputTokens, outputTokens),
});
```

**Dashboard Visibility (API only, UI deferred to Epic 52):**
- `GET /v1/a2a/agents/:id/usage` — daily token usage, cost, task count
- `GET /v1/a2a/agents/:id/usage/history` — last 30 days trend
- Token usage included in task detail response

**Files:**
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — token tracking + budget enforcement)
- `apps/api/src/services/a2a/cost-controller.ts` (NEW — budget checking, model routing)
- `apps/api/src/services/a2a/task-service.ts` (MODIFY — recordTokenUsage method)
- `apps/api/supabase/migrations/20260220_a2a_task_processor.sql` (MODIFY — add token_usage column, view)
- `apps/api/src/routes/a2a.ts` (MODIFY — add usage endpoints)

**Acceptance Criteria:**
- [ ] Token usage recorded per task (input, output, total, cost, model)
- [ ] Daily budget enforced per agent
- [ ] Tasks rejected when budget exceeded (with clear error message)
- [ ] Fallback model kicks in at configured threshold
- [ ] Per-task token cap stops runaway multi-tool loops
- [ ] Usage API endpoint returns daily/historical data
- [ ] Cost estimates accurate for Anthropic pricing

**SDK Exposure:** `sly.a2a.getAgentUsage(agentId)`, `sly.a2a.getAgentUsageHistory(agentId)`

---

### Story 58.15: Custom Tool Support (Tenant-Provided Tools)

**Points:** 8
**Priority:** P0 — Enterprise Blocker
**Dependencies:** Story 58.2 (Agent Tool Registry)

**Description:**
Managed agents can currently only use Sly's built-in tools (wallets, mandates, settlements, etc.). This is fine for a Treasury Agent, but real enterprise use cases need agents that combine Sly payment tools with business-specific tools: ERP lookups, approval system queries, inventory checks, Slack notifications, CRM updates.

Without this, every enterprise customer is forced into `webhook` mode — pushing all logic to their side and losing the benefit of Sly-managed agents entirely. The pitch of "configure an agent and it works" falls apart if the agent can only do payment things.

**Example: Procurement Agent needs:**
- `check_budget` → Sly mandate (built-in ✅)
- `lookup_vendor` → Customer's ERP API (custom ❌)
- `get_approval_status` → Customer's workflow system (custom ❌)
- `make_payment` → Sly transfer (built-in ✅)
- `notify_team` → Customer's Slack webhook (custom ❌)

Today: 2 out of 5 tools work. Agent is useless for the actual workflow.

**Design: HTTP Callback Tools**

Custom tools are defined as JSON Schema (same format as built-in tools) with an HTTP endpoint that Sly calls when the LLM invokes the tool.

```typescript
// Custom tool definition stored in agent processing_config:
{
  "customTools": [
    {
      "name": "lookup_vendor",
      "description": "Look up vendor details from the ERP system by vendor ID or name",
      "parameters": {
        "type": "object",
        "properties": {
          "vendorId": { "type": "string", "description": "Vendor ID" },
          "vendorName": { "type": "string", "description": "Vendor name (fuzzy search)" }
        }
      },
      "endpoint": {
        "url": "https://customer.com/api/vendors/lookup",
        "method": "POST",
        "headers": { "Authorization": "Bearer ${VENDOR_API_KEY}" },
        "timeoutMs": 10000
      },
      "resultSchema": {
        "type": "object",
        "properties": {
          "vendorId": { "type": "string" },
          "name": { "type": "string" },
          "status": { "type": "string" },
          "paymentTerms": { "type": "string" }
        }
      }
    }
  ]
}
```

**Execution Flow:**
```
LLM decides to call "lookup_vendor" with { vendorId: "V-1234" }
    ↓
Tool Registry sees it's a custom tool
    ↓
POST https://customer.com/api/vendors/lookup
  Body: { "vendorId": "V-1234" }
  Headers: { "Authorization": "Bearer <secret>", "X-Sly-Agent-Id": "..." }
    ↓
Customer's API returns: { "vendorId": "V-1234", "name": "Acme Corp", ... }
    ↓
Result validated against resultSchema
    ↓
Returned to LLM as tool result
    ↓
LLM continues with vendor data + Sly tools
```

**Secret Management:**

Custom tool endpoints often need API keys. These can't be stored in plain text in `processing_config`.

```typescript
// Secrets stored separately, referenced by variable name:
{
  "customToolSecrets": {
    "VENDOR_API_KEY": "sk-vendor-xxx...",   // Encrypted at rest
    "SLACK_WEBHOOK": "https://hooks.slack.com/..."
  }
}

// In tool definition, reference with ${VARIABLE_NAME}
"headers": { "Authorization": "Bearer ${VENDOR_API_KEY}" }
```

**Latency Impact:**

Custom tools add an external HTTP call to the processing loop. This is the biggest latency variable:

```
With built-in tools only (current):
  LLM call (2.5s) → in-process tool (5ms) → LLM call (2s) = ~4.5s

With custom tool:
  LLM call (2.5s) → HTTP to customer API (200-2000ms) → LLM call (2s) = ~4.7-6.5s
```

Critical to enforce `timeoutMs` per custom tool. Default 10s, max 30s. Timeout = tool error passed to LLM for graceful handling.

**Security Boundaries:**
- Custom tool URLs validated (HTTPS only, no internal IPs, no localhost)
- Request/response size limits (1MB max)
- Secrets encrypted at rest (Supabase vault or env-encrypted column)
- Tool execution sandboxed (can't call Sly internal APIs via custom tool)
- Rate limited per custom tool endpoint (10 calls/minute default)

**Files:**
- `apps/api/src/services/a2a/tools/custom-tool-executor.ts` (NEW — HTTP callback execution)
- `apps/api/src/services/a2a/tools/registry.ts` (MODIFY — merge built-in + custom tools)
- `apps/api/src/services/a2a/tools/secret-manager.ts` (NEW — secret resolution)
- `apps/api/src/routes/a2a.ts` (MODIFY — custom tool CRUD in agent config)

**Acceptance Criteria:**
- [ ] Custom tools defined via agent config API with JSON Schema
- [ ] LLM sees custom tools alongside built-in Sly tools
- [ ] Custom tool invocation calls external HTTP endpoint
- [ ] Secrets resolved from encrypted storage (not exposed in config reads)
- [ ] Timeout enforcement per custom tool
- [ ] URL validation (HTTPS only, no internal IPs)
- [ ] Tool result validated against `resultSchema` if provided
- [ ] Failed custom tool calls passed to LLM as error (not task failure)

**SDK Exposure:** `sly.a2a.updateAgentConfig()` with `customTools` field

---

### Story 58.16: Completion Webhooks (Push Notification to Callers)

**Points:** 5
**Priority:** P1
**Dependencies:** Story 58.5 (Webhook Handler)

**Description:**
Today when an external agent sends `message/send`, it gets `{ state: "submitted" }` and must poll `tasks/get` until completion. Streaming (58.13) solves this for clients that can hold an SSE connection open. But many integrations are server-to-server — a backend that fires off a task and wants a callback when it's done, not a persistent connection.

This story adds an optional `callbackUrl` in the `message/send` params. When the task reaches a terminal state (completed, failed, canceled) or requires input, Sly POSTs the task result to that URL.

**Note:** This is different from Story 58.5's webhook handler. That's for agents whose `processing_mode` is `webhook` — the agent *owner's* processing endpoint. This story is for the *caller* of any agent, regardless of processing mode.

```
External Agent                     Sly                      Sly-Managed Agent
  │                                 │                              │
  │── message/send ────────────>│                              │
  │   { message: "...",          │                              │
  │     callbackUrl: "https://  │                              │
  │       agent.example.com/    │                              │
  │       webhook" }             │                              │
  │<── { state: submitted } ─────│                              │
  │                                 │──── worker claims ────────>│
  │  (caller goes about its day)  │                              │
  │                                 │<─── LLM processes ─────────│
  │                                 │                              │
  │<── POST /webhook ───────────│  (task completed)            │
  │   { id, state: completed,    │                              │
  │     history: [...],           │                              │
  │     artifacts: [...] }        │                              │
  │                                 │                              │
  No polling required.
```

**Params Extension to `message/send`:**
```typescript
// In message/send params (optional):
{
  "message": { "parts": [...] },
  "configuration": {
    "callbackUrl": "https://agent.example.com/a2a/callback",
    "callbackEvents": ["completed", "failed", "input-required"]  // default: all terminal states
  }
}
```

**Webhook Payload:**
```json
{
  "event": "task.completed",
  "task": {
    "id": "task-uuid",
    "contextId": "ctx-uuid",
    "status": { "state": "completed", "timestamp": "..." },
    "history": [...],
    "artifacts": [...]
  },
  "timestamp": "2026-02-20T17:00:00Z"
}
```

Signed with HMAC-SHA256 if the caller provided a signing key, or unsigned for simplicity in v1.

**Retry Policy:**
- Attempt delivery immediately on state change
- If 4xx/5xx or timeout (10s): retry at 5s, 30s, 2min
- After 3 failures: log to DLQ, don't retry further
- Caller can always fall back to `tasks/get` polling

**Files:**
- `apps/api/src/services/a2a/jsonrpc-handler.ts` (MODIFY — parse callbackUrl from configuration)
- `apps/api/src/services/a2a/task-service.ts` (MODIFY — store callbackUrl on task, fire webhook on state change)
- `apps/api/src/services/a2a/caller-webhook.ts` (NEW — delivery with retry)

**Acceptance Criteria:**
- [ ] `callbackUrl` accepted in `message/send` configuration params
- [ ] POST sent to callbackUrl when task reaches terminal state
- [ ] `input-required` state triggers webhook (so caller knows to respond)
- [ ] Retry logic with exponential backoff (3 attempts)
- [ ] Delivery failures logged but don't affect task processing
- [ ] Works alongside streaming (caller can use both)

**SDK Exposure:** `callbackUrl` option in `sly.a2a.sendTask()`

---

### Story 58.17: LLM Decision Audit Trail

**Points:** 8
**Priority:** P1 — Governance Requirement
**Dependencies:** Story 58.4 (LLM Managed Handler)

**Description:**
When a managed agent processes a task, we store the final assistant message and artifacts. But the full decision chain is invisible: what tools did the LLM consider? Why did it pick `execute_mandate` over `make_transfer`? What was the system prompt at the time? If the LLM transferred $5,000, the audit trail currently shows "agent completed task with transfer" — but not *why*.

For a payment platform, this is a governance gap. Enterprises need to answer: "Why did the AI approve this payment?" Regulators will ask: "Show me the decision trace for this transaction." Without full LLM interaction logging, we can't answer either.

**What Gets Logged Today vs What Should:**

| Data | Today | After This Story |
|------|-------|-------------------|
| User message | ✅ In task history | ✅ Same |
| Agent final response | ✅ In task history | ✅ Same |
| Tool calls made | ❌ Lost | ✅ Full trace |
| Tool results returned | ❌ Lost | ✅ Full trace |
| System prompt used | ❌ Lost | ✅ Recorded |
| Model + temperature | ❌ Lost | ✅ Recorded |
| Token counts per call | ❌ Lost | ✅ Per-call breakdown |
| LLM reasoning (if any) | ❌ Lost | ✅ Chain-of-thought if model supports |
| Rejected tool calls | ❌ Lost | ✅ Permission denials logged |
| Total processing timeline | ❌ Lost | ✅ Timestamps per step |

**Audit Log Schema:**
```sql
CREATE TABLE a2a_task_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  task_id UUID NOT NULL REFERENCES a2a_tasks(id),
  sequence_number INTEGER NOT NULL,  -- Ordering within task
  event_type TEXT NOT NULL,          -- 'llm_call', 'tool_call', 'tool_result', 'state_change', 'error'
  
  -- LLM call details
  model TEXT,
  system_prompt_hash TEXT,           -- SHA-256 of system prompt (not the full prompt, for storage)
  input_token_count INTEGER,
  output_token_count INTEGER,
  llm_latency_ms INTEGER,
  
  -- Tool call details
  tool_name TEXT,
  tool_input JSONB,                  -- Args passed to tool
  tool_output JSONB,                 -- Result from tool
  tool_latency_ms INTEGER,
  tool_permission_granted BOOLEAN,   -- Was the tool allowed?
  
  -- State change details
  from_state TEXT,
  to_state TEXT,
  reason TEXT,
  
  -- Full LLM messages for this call (complete input/output)
  llm_messages JSONB,               -- Full messages array sent to LLM
  llm_response JSONB,               -- Full LLM response (including tool_use blocks)
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_log_task ON a2a_task_audit_log(task_id, sequence_number);
CREATE INDEX idx_audit_log_tenant_date ON a2a_task_audit_log(tenant_id, created_at);
```

**Recorded During Processing:**
```typescript
// In managed-handler.ts, each LLM loop iteration:
auditLog.record(taskId, {
  eventType: 'llm_call',
  model: config.model,
  systemPromptHash: sha256(systemPrompt),
  inputTokenCount: response.usage.input_tokens,
  outputTokenCount: response.usage.output_tokens,
  llmLatencyMs: endTime - startTime,
  llmMessages: messages,        // Full context sent
  llmResponse: response.content, // Full response including tool_use
});

// When tool is called:
auditLog.record(taskId, {
  eventType: 'tool_call',
  toolName: 'ap2_execute_mandate',
  toolInput: { mandateId: 'xxx', amount: 5000 },
  toolOutput: { success: true, transferId: 'txn_abc' },
  toolLatencyMs: 45,
  toolPermissionGranted: true,
});

// When tool is DENIED:
auditLog.record(taskId, {
  eventType: 'tool_call',
  toolName: 'wallet_withdraw',
  toolInput: { amount: 50000 },
  toolPermissionGranted: false,
  reason: 'Agent lacks wallets.write permission',
});
```

**Reconstruction:**

Given a task ID, the audit log can reconstruct the complete decision timeline:

```
[0] llm_call: Claude Sonnet, 847 input tokens, 156 output tokens (2,340ms)
    → Decided to call: ap2_get_mandate(mandate_shopping_001)
[1] tool_call: ap2_get_mandate → { remaining: 8500, currency: "USDC" } (12ms)
[2] llm_call: Claude Sonnet, 1,203 input tokens, 89 output tokens (1,890ms)
    → Decided to call: ap2_execute_mandate(mandate_shopping_001, 5000)
[3] tool_call: ap2_execute_mandate → { success: true, transferId: "txn_abc" } (34ms)
[4] llm_call: Claude Sonnet, 1,547 input tokens, 201 output tokens (2,100ms)
    → Generated final response: "Transfer of 5,000 USDC completed..."
[5] state_change: working → completed
```

**Storage Considerations:**
- Full `llm_messages` can be large (10-50KB per call). Store with 30-day retention, then archive to cold storage.
- `system_prompt_hash` rather than full prompt saves space (deduplicate prompts).
- Separate table from `a2a_tasks` to avoid bloating the main query path.
- Optional: compress `llm_messages` and `llm_response` with pg_lz4.

**API:**
- `GET /v1/a2a/tasks/:taskId/audit` — full audit trail for a task
- Response grouped by sequence number with human-readable timeline

**Files:**
- `apps/api/src/services/a2a/audit-logger.ts` (NEW — audit log service)
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — emit audit events)
- `apps/api/supabase/migrations/20260220_a2a_task_processor.sql` (MODIFY — add audit table)
- `apps/api/src/routes/a2a.ts` (MODIFY — add audit endpoint)

**Acceptance Criteria:**
- [ ] Every LLM call logged with full input/output, tokens, latency
- [ ] Every tool call logged with input, output, latency, permission status
- [ ] State changes logged with from/to and reason
- [ ] Permission denials logged (attempted tool calls that were blocked)
- [ ] Audit trail reconstructable as ordered timeline
- [ ] API endpoint returns audit log for a task
- [ ] System prompt hash deduplicated (not stored N times per task)
- [ ] Storage bounded by retention policy

**SDK Exposure:** `sly.a2a.getTaskAudit(taskId)`

---

### Story 58.18: Context Window Management

**Points:** 5
**Priority:** P1
**Dependencies:** Story 58.4 (LLM Managed Handler)

**Description:**
The current design loads "last 50 messages" from all tasks sharing a `contextId`. But messages include tool calls (with JSON Schema args), tool results (with full API responses), and artifacts (with data payloads). A realistic 10-turn conversation:

```
10 user messages:           ~2,000 tokens
10 assistant messages:       ~3,000 tokens
30 tool calls (3 per turn):  ~6,000 tokens (schemas + args)
30 tool results:             ~15,000 tokens (full API responses!)
10 system context updates:   ~2,000 tokens
─────────────────────────────────────────
Total:                       ~28,000 tokens (just history)
+ System prompt:             ~800 tokens
+ Tool definitions:          ~3,000 tokens
─────────────────────────────────────────
Grand total:                 ~31,800 tokens
```

Claude Sonnet's context window is 200K, so this isn't technically overflowing. But at $3/million input tokens, 31K tokens per call × 3 calls per task = $0.28/task. For a busy agent, that's the cost problem from 58.14 compounded.

More critically, larger contexts mean slower inference. Every extra 10K tokens adds ~200-500ms to response latency. At 30K+ input, we're adding 600ms-1.5s of pure context overhead per LLM call.

**Strategy: Tiered Context Compression**

```
Turn 1-2 (most recent): Full detail
  - Complete messages, tool calls, tool results, artifacts

Turn 3-5 (recent): Compressed tool results
  - Messages kept in full
  - Tool results summarized: { "tool": "get_wallet_balance", "result": "5,000 USDC" }
    instead of the full API response object

Turn 6-10 (older): Summary only
  - Replaced with a single system message:
    "Previous conversation summary: User asked about wallet balance (5,000 USDC),
     then transferred 100 USDC to account xyz (transfer txn_abc123)."

Turn 11+: Dropped entirely
  - Context summary covers the gist
```

**Implementation:**
```typescript
interface ContextWindowConfig {
  maxInputTokens: number;         // Default: 16,000 (leaves room for tools + response)
  fullDetailTurns: number;        // Default: 2 (most recent turns, full fidelity)
  compressedTurns: number;        // Default: 3 (tool results summarized)
  summaryTurns: number;           // Default: 5 (replaced with LLM-generated summary)
  toolResultMaxTokens: number;    // Default: 200 (truncate large tool results)
}

async function buildManagedContext(
  task: A2ATask,
  contextId: string | null,
  config: ContextWindowConfig
): Promise<LLMMessage[]> {
  if (!contextId) return task.history.map(toLLMMessage);

  const allTasks = await taskService.getTasksByContext(tenantId, contextId);
  const allMessages = allTasks.flatMap(t => t.history).sort(byCreatedAt);

  // Count tokens from the end
  const result: LLMMessage[] = [];
  let tokenCount = 0;

  // Phase 1: Full detail (most recent N turns)
  const recentMessages = allMessages.slice(-config.fullDetailTurns * 4); // ~4 messages per turn
  for (const msg of recentMessages.reverse()) {
    const tokens = estimateTokens(msg);
    if (tokenCount + tokens > config.maxInputTokens) break;
    result.unshift(toLLMMessage(msg));
    tokenCount += tokens;
  }

  // Phase 2: Compressed (next N turns)
  const olderMessages = allMessages.slice(-(config.fullDetailTurns + config.compressedTurns) * 4, -config.fullDetailTurns * 4);
  for (const msg of olderMessages.reverse()) {
    const compressed = compressToolResults(msg, config.toolResultMaxTokens);
    const tokens = estimateTokens(compressed);
    if (tokenCount + tokens > config.maxInputTokens) break;
    result.unshift(compressed);
    tokenCount += tokens;
  }

  // Phase 3: Summary (everything older)
  const oldestMessages = allMessages.slice(0, -(config.fullDetailTurns + config.compressedTurns) * 4);
  if (oldestMessages.length > 0) {
    const summaryTokenBudget = Math.min(500, config.maxInputTokens - tokenCount);
    if (summaryTokenBudget > 100) {
      const summary = generateSummary(oldestMessages, summaryTokenBudget);
      result.unshift({ role: 'system', content: `Previous conversation context: ${summary}` });
    }
  }

  return result;
}
```

**Summary Generation:**

Two approaches, configurable:
1. **Rule-based** (fast, free): Extract key facts from tool results — account names, amounts, transfer IDs. Template: "User checked balance (X), transferred Y to Z (txn_ID)."
2. **LLM-based** (expensive, better): Call Haiku with old messages and ask for a concise summary. Cost: ~$0.001 per summary. Only use for contexts with 20+ turns.

**Latency Impact:**

| Context Size | Without Management | With Management |
|--------------|--------------------|-----------------|
| 5 turns | ~8K tokens, ~200ms overhead | ~8K tokens (no change needed) |
| 10 turns | ~31K tokens, ~800ms overhead | ~12K tokens, ~300ms overhead |
| 20 turns | ~60K+ tokens, ~1.5s overhead | ~14K tokens, ~350ms overhead |
| 50 turns | ~150K tokens, ~3s overhead | ~16K tokens, ~400ms overhead |

**Files:**
- `apps/api/src/services/a2a/context-manager.ts` (NEW — tiered compression)
- `apps/api/src/services/a2a/handlers/managed-handler.ts` (MODIFY — use context manager)
- `apps/api/src/services/a2a/token-estimator.ts` (NEW — fast token count estimation)

**Acceptance Criteria:**
- [ ] Recent turns preserved in full detail
- [ ] Older tool results compressed to key facts
- [ ] Oldest turns replaced with summary
- [ ] Total context stays under configurable token limit
- [ ] 20-turn conversation context < 16K tokens
- [ ] Token estimation within 10% of actual count
- [ ] No information loss for most recent 2 turns

**SDK Exposure:** None (internal optimization)

---

## Implementation Sequence

```
Phase 1: Worker Foundation (Stories 58.1-58.6)              [44 pts]
  58.1: Agent processing config (DB + API)          [5 pts]
       ↓
  58.2: Agent tool registry (MCP reuse)             [8 pts]  ─┐
  58.3: Task claim & dispatch service               [8 pts]  ─┤ parallel
       ↓                                                      │
  58.4: LLM managed handler                         [13 pts] ←┘
  58.5: Webhook handler                             [5 pts]  (parallel with 58.4)
  58.6: Human-in-the-loop escalation                [5 pts]
       ↓
Phase 2: Agent-to-Agent (Stories 58.7-58.8)                 [13 pts]
  58.7: Intra-platform agent-to-agent               [8 pts]
  58.8: Payment gating                              [5 pts]  (parallel with 58.7)
       ↓
Phase 3: Reliability (Stories 58.9-58.10)                   [10 pts]
  58.9: Error recovery & DLQ                        [5 pts]
  58.10: Worker lifecycle & config                  [5 pts]  (parallel with 58.9)
       ↓
Phase 4: SDK & Testing (Stories 58.11-58.12)                [13 pts]
  58.11: SDK types & methods                        [5 pts]
  58.12: End-to-end integration tests               [8 pts]
       ↓
Phase 5: Production Gaps (Stories 58.13-58.18)              [47 pts]
  58.13: SSE Streaming (message/stream)             [13 pts] ← START HERE (demo blocker)
  58.14: LLM cost controls                          [8 pts]  (parallel with 58.13)
       ↓
  58.15: Custom tool support                        [8 pts]
  58.16: Completion webhooks                        [5 pts]  (parallel with 58.15)
       ↓
  58.17: LLM decision audit trail                   [8 pts]
  58.18: Context window management                  [5 pts]  (parallel with 58.17)
```

**Critical path:** 58.1 → 58.2+58.3 → 58.4 → 58.13 → 58.15 → 58.17

**Note:** Phase 5 can start as soon as 58.4 (managed handler) is working. Streaming (58.13) should be prioritized immediately after the basic handler works — even before Phases 2-3 if needed for an upcoming demo.

**Estimated time:** 3-4 weeks with one developer, or 2-2.5 weeks with parallel streams.

---

## Verification Plan

1. `pnpm build` — all packages compile
2. Configure Treasury Agent as `managed` with Claude Sonnet
3. Send `message/send`: "What's my wallet balance?" → task completes with balance
4. Send `message/send`: "Transfer 100 USDC to account xyz" → task completes with transfer ID
5. Send `message/send`: "Transfer 50K USDC" (exceeds mandate) → task `input-required`
6. Respond to escalation → task resumes and completes
7. Agent A sends task to Agent B → both complete correctly
8. Webhook agent receives callback → external system responds → task completes
9. Worker handles LLM timeout → retry → eventually completes or DLQ
10. **`message/stream`: send task, see real-time SSE events in terminal/browser** ← Demo moment
11. **Token usage recorded and daily budget enforced**
12. **Custom tool calls external HTTP endpoint and returns result to LLM**
13. **Completion webhook fires on task completion**
14. **Audit trail shows full tool call sequence for any task**
15. **20-turn conversation stays under 16K context tokens**
16. Performance benchmarks: single-tool < 5s, multi-tool < 10s
17. `pnpm test` — all tests pass

---

## Future Considerations

- **Agent memory:** Persistent memory across contexts (vector store per agent)
- **Multi-model routing:** Route simple tasks to Haiku, complex to Sonnet/Opus (partially addressed by 58.14 fallback)
- **Batch processing:** Process multiple tasks in a single LLM call when possible
- **Bearer token federation:** Verify external agent identity without Sly API key
- **Postgres → Redis queue migration:** When task volume exceeds ~100/second
- **Multi-instance streaming:** Redis pub/sub for task event bus across workers

---

*"Epic 57 gave agents a voice. Epic 58 gives them a brain."*
