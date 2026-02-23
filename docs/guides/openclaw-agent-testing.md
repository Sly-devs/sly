# OpenClaw Bot Testing Guide for Sly A2A

A practical guide for OpenClaw bot developers to test Sly's A2A (Agent-to-Agent) protocol implementation. Covers discovery, free and paid skill invocation, payment flows, SSE streaming, multi-turn conversations, and edge-case testing.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Architecture Overview](#2-architecture-overview)
3. [Phase 1 — Discovery](#3-phase-1--discovery)
4. [Phase 2 — Free Skill Testing](#4-phase-2--free-skill-testing)
5. [Phase 3 — Paid Skill Testing (Skill Economy)](#5-phase-3--paid-skill-testing-skill-economy)
6. [Phase 4 — Payment Flow Testing](#6-phase-4--payment-flow-testing)
7. [Phase 5 — Advanced Patterns](#7-phase-5--advanced-patterns)
8. [Phase 6 — Agent Forwarding (Your Bot AS the Agent)](#8-phase-6--agent-forwarding-your-bot-as-the-agent)
9. [Phase 7 — Edge Case & Error Testing](#9-phase-7--edge-case--error-testing)
10. [Bot Implementation Reference](#10-bot-implementation-reference)
11. [Test Matrix](#11-test-matrix)

---

## 1. Introduction

### What This Guide Covers

This guide walks through using OpenClaw bots as **external A2A agents** that interact with Sly's payment platform. Sly implements the [Google A2A protocol](https://google.github.io/A2A/) with extensions for payment gating, a DB-driven skill economy, SSE streaming, and multi-turn conversations.

Your bot can operate in two modes:

**As a Caller** (Phases 1-5):
- Discover Sly agents and their skills (free and paid)
- Submit tasks via JSON-RPC 2.0
- Handle the full task lifecycle: `submitted` → `working` → `input-required` → `completed`/`failed`
- Submit payment proofs (x402, AP2, wallet)
- Stream results via SSE
- Conduct multi-turn conversations using `contextId`

**As an Agent** (Phase 6 — NEW):
- Register your bot as a Sly agent with its own A2A or webhook endpoint
- Provide custom skills (`handler_type: "agent_provided"`) that Sly forwards to your bot
- Mix custom skills with Sly-native skills on the same agent
- Sly handles discovery, payment/settlement, and protocol — your bot just does the work

### Prerequisites

| Requirement | Details |
|---|---|
| Sly API running | `http://localhost:4000` (or deployed URL) |
| API key | `pk_test_*` format — get one from the dashboard or seed script |
| Active agent | At least one agent with `status=active`, skills, and a funded wallet |
| Node.js 18+ | For running the TypeScript bot skeleton |

### Seed Data

Run the seed script to create a demo tenant with agents, wallets, and skills:

```bash
pnpm --filter @sly/api seed:db
```

### Reference Implementations

- **Invoice Bot** (external A2A agent): `apps/a2a-test-agent/src/index.ts`
- **E2E test script**: `apps/api/scripts/test-a2a-e2e.ts`

---

## 2. Architecture Overview

```
┌──────────────────┐         ┌──────────────────────────────────────────┐
│   OpenClaw Bot    │         │              Sly Platform                │
│  (as Caller)      │         │                                          │
│                   │         │                                          │
│  1. Discover  ────┼── GET ──┤→ /a2a/{agentId}/.well-known/agent.json  │
│                   │         │                                          │
│  2. Send task ────┼─ POST ──┤→ /a2a/{agentId}   (JSON-RPC 2.0)       │
│                   │         │   ├─ message/send                       │
│                   │         │   ├─ message/stream (SSE)               │
│                   │         │   ├─ tasks/get                          │
│                   │         │   ├─ tasks/cancel                       │
│                   │         │   └─ tasks/list                         │
│                   │         │                                          │
│  3. Gateway   ────┼─ POST ──┤→ /a2a           (platform directory)    │
│     discover      │         │   ├─ find_agent                         │
│                   │         │   └─ list_agents                        │
│                   │         │                                          │
│  4. Management ───┼─ REST ──┤→ /v1/a2a/tasks (authenticated)         │
│     (optional)    │         │   ├─ GET    /tasks/:id                  │
│                   │         │   ├─ POST   /tasks/:id/respond          │
│                   │         │   ├─ POST   /tasks/:id/cancel           │
│                   │         │   └─ POST   /tasks/:id/process          │
└──────────────────┘         └──────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────────────────────────────┐
│   OpenClaw Bot    │         │              Sly Platform                │
│  (as Agent)       │         │                                          │
│                   │         │  5. Register  ─── PUT  /v1/agents/:id/  │
│  Register your ───┼─ REST ──┤→    endpoint      endpoint              │
│  endpoint + skills│         │                                          │
│                   │         │  6. Register  ─── POST /v1/agents/:id/  │
│                   │         │     skills         skills                │
│                   │         │     (handler_type: "agent_provided")     │
│                   │         │                                          │
│  Receive ◄────────┼─ POST ──┤← Sly forwards tasks to your endpoint   │
│  forwarded tasks  │         │   (A2A JSON-RPC or webhook POST)        │
│                   │         │                                          │
│  Return result ───┼─ POST ──┤→ /a2a/{agentId}/callback                │
│  (webhook mode)   │         │   (with HMAC signature if secret set)   │
└──────────────────┘         └──────────────────────────────────────────┘
```

### Two Modes of Operation

| Mode | Your Bot Is... | How It Works |
|---|---|---|
| **Caller** (Phases 1-5) | Sending tasks to a Sly agent | You call `/a2a/{agentId}` with JSON-RPC |
| **Agent** (Phase 6) | Registered as a Sly agent with its own skills | Callers send tasks to your agent on Sly, Sly handles payment/settlement, forwards the task to your endpoint |

### Authentication Options

| Method | Format | Use Case |
|---|---|---|
| API key | `Authorization: Bearer pk_test_xxxxx` | Recommended for testing |
| Agent token | `Authorization: Bearer agent_xxxxx` | For agent-to-agent auth |
| No auth | (omit header) | Public discovery only; task submission still works (tenant derived from target agent) |

### Base URLs

```
Local:      http://localhost:4000
Production: https://api.sly.dev   (or your deployed URL)
```

---

## 3. Phase 1 — Discovery

### 3a. Platform Discovery

Fetch the platform-level Agent Card. This describes the Sly gateway and its directory skills.

```bash
curl -s http://localhost:4000/.well-known/agent.json | jq .
```

**Expected response shape:**

```json
{
  "id": "sly-platform",
  "name": "Sly Payment Platform",
  "description": "Universal agentic payment orchestration for LATAM",
  "url": "http://localhost:4000/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "multiTurn": true,
    "stateTransition": true
  },
  "skills": [
    { "id": "find_agent", "name": "Find Agent", "tags": ["discovery", "directory"] },
    { "id": "list_agents", "name": "List Agents", "tags": ["discovery", "directory"] },
    { "id": "make_payment", "name": "Make Payment", "tags": ["payments", "stablecoin", "latam"] },
    { "id": "create_mandate", "name": "Create Payment Mandate", "tags": ["payments", "mandates", "ap2"] },
    { "id": "manage_wallet", "name": "Manage Wallet", "tags": ["wallets", "stablecoin"] }
  ],
  "securitySchemes": {
    "sly_api_key": { "type": "apiKey", "in": "header", "name": "Authorization" },
    "bearer": { "type": "http", "scheme": "bearer" }
  },
  "extensions": [
    { "uri": "urn:a2a:ext:agent-directory" },
    { "uri": "urn:a2a:ext:x402" },
    { "uri": "urn:a2a:ext:ap2" }
  ]
}
```

**Assertions:**
- `skills` array has entries for `find_agent` and `list_agents`
- `capabilities.streaming` is `true`
- `extensions` includes `urn:a2a:ext:x402` and `urn:a2a:ext:ap2`

### 3b. Agent Search via Gateway

Use the platform gateway to find agents by capability or keyword.

**List all agents:**

```bash
curl -s -X POST http://localhost:4000/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "discover-1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "list_agents" }]
      }
    }
  }' | jq .
```

**Find agents by keyword:**

```bash
curl -s -X POST http://localhost:4000/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "discover-2",
    "params": {
      "message": {
        "role": "user",
        "parts": [
          { "text": "find_agent" },
          { "data": { "query": "payment", "tags": ["payments"] } }
        ]
      }
    }
  }' | jq .
```

**Expected:** A JSON-RPC response with `result` containing a task with agent summaries in artifacts.

### 3c. Per-Agent Card Fetch

Once you know an agent ID (UUID), fetch its specific Agent Card:

```bash
AGENT_ID="<uuid>"

curl -s "http://localhost:4000/a2a/${AGENT_ID}/.well-known/agent.json" | jq .
```

**Expected response shape:**

```json
{
  "id": "<agent-uuid>",
  "name": "Treasury Agent",
  "description": "Sly agent managed by Demo Account",
  "url": "http://localhost:4000/a2a/<agent-uuid>",
  "version": "1.0.0",
  "capabilities": { "streaming": true, "multiTurn": true, "stateTransition": true },
  "skills": [
    { "id": "check_balance", "name": "Check Balance", "tags": ["wallets", "balance"] },
    { "id": "get_agent_info", "name": "Agent Info", "tags": ["info"] },
    { "id": "get_transactions", "name": "Transaction History", "tags": ["transactions"] },
    { "id": "create_checkout", "name": "Create Checkout", "description": "... Fee: 0.50 USDC.", "tags": ["commerce"] },
    { "id": "access_api", "name": "x402 API Access", "description": "... Fee: 0.10 USDC.", "tags": ["x402"] },
    { "id": "create_mandate", "name": "Create Mandate", "description": "... Fee: 1.00 USDC.", "tags": ["mandates"] },
    { "id": "research", "name": "Research", "description": "... Fee: 2.00 USDC.", "tags": ["research"] }
  ],
  "extensions": [
    { "uri": "urn:a2a:ext:x402", "data": { "walletId": "...", "currency": "USDC" } },
    { "uri": "urn:a2a:ext:ap2", "data": { "mandateEndpoint": "...", "agentId": "..." } }
  ]
}
```

**Verification checklist:**
- [ ] `skills` array is non-empty
- [ ] Skills with fees have `Fee: X.XX USDC` in their description
- [ ] `securitySchemes` includes `sly_api_key` and `bearer`
- [ ] `extensions` includes x402 and AP2 entries with valid endpoints
- [ ] `url` points to the agent's JSON-RPC endpoint

---

## 4. Phase 2 — Free Skill Testing

All free skills use `POST /a2a/{agentId}` with `message/send`. Auth is optional but recommended.

### Helper: JSON-RPC Request Template

```bash
AGENT_ID="<uuid>"
API_KEY="pk_test_xxxxx"
BASE_URL="http://localhost:4000"

# Usage: send_task "your message here"
send_task() {
  curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"method\": \"message/send\",
      \"id\": \"test-$(date +%s)\",
      \"params\": {
        \"message\": {
          \"role\": \"user\",
          \"parts\": [{ \"text\": \"$1\" }]
        }
      }
    }" | jq .
}
```

### 4a. Check Balance

```bash
send_task "Check my wallet balance"
```

**Expected response:**

```json
{
  "jsonrpc": "2.0",
  "id": "test-...",
  "result": {
    "id": "<task-uuid>",
    "status": { "state": "completed", "message": "Balance checked" },
    "history": [
      { "role": "user", "parts": [{ "text": "Check my wallet balance" }] },
      {
        "role": "agent",
        "parts": [
          { "text": "Current wallet balance: 5,000 USDC. Wallet: ..." },
          {
            "data": {
              "type": "balance_check",
              "walletId": "...",
              "balance": 5000,
              "currency": "USDC",
              "status": "active"
            }
          }
        ]
      }
    ]
  }
}
```

**Assert:**
- `result.status.state` === `"completed"`
- Agent response contains a data part with `type: "balance_check"`
- `balance` is a number >= 0
- `currency` is a valid currency code

### 4b. Agent Info

```bash
send_task "What are your capabilities?"
```

**Expected data part:**

```json
{
  "type": "agent_info",
  "name": "Treasury Agent",
  "kyaTier": 2,
  "permissions": { ... },
  "walletBalance": 5000,
  "walletCurrency": "USDC"
}
```

**Assert:**
- Response includes `kyaTier` (number 0-3)
- Response includes agent name and permissions object

### 4c. Transaction History

```bash
send_task "Show recent transactions"
```

**Expected data part:**

```json
{
  "type": "transaction_history",
  "count": 5,
  "transactions": [
    { "type": "internal", "amount": 100, "currency": "USDC", "status": "completed", "description": "..." }
  ]
}
```

**Assert:**
- `transactions` is an array
- Each transaction has `type`, `amount`, `currency`, `status`

### 4d. Account Lookup

```bash
send_task "List accounts"
```

**Expected data part:**

```json
{
  "type": "account_list",
  "count": 3,
  "accounts": [
    { "id": "...", "name": "Demo Account", "type": "business", "verificationTier": 2 }
  ]
}
```

**Assert:**
- `accounts` is a non-empty array
- Each account has `id`, `name`, `type`

### 4e. Get Quote

```bash
send_task "Quote 500 USDC to BRL"
```

**Expected data part:**

```json
{
  "type": "quote",
  "sourceAmount": 500,
  "sourceCurrency": "USDC",
  "destinationAmount": 2507.5,
  "destinationCurrency": "BRL",
  "fxRate": 5.05,
  "fee": 3.5,
  "feeCurrency": "USDC",
  "rail": "pix",
  "expiresIn": "5 minutes"
}
```

**Assert:**
- `fxRate` > 0
- `fee` > 0
- `rail` is one of `pix`, `spei`, `x402`
- `destinationAmount` === `(sourceAmount - fee) * fxRate`

---

## 5. Phase 3 — Paid Skill Testing (Skill Economy)

Paid skills charge a service fee from the agent's wallet. Verify the fee deduction by checking the wallet balance before and after.

### Setup: Check Initial Balance

```bash
# Record balance before
send_task "Check my wallet balance"
# Note the balance value
```

### 5a. Create Checkout (0.50 USDC fee)

```bash
send_task "Create a checkout for 3 widgets at 25 each"
```

**Expected data part:**

```json
{
  "type": "checkout_created",
  "id": "<checkout-uuid>",
  "currency": "USDC",
  "totals": { "subtotal": 75, "total": 75 },
  "serviceFee": 0.5
}
```

**Assert:**
- `serviceFee` === `0.5`
- Task has an artifact named `checkout-*`
- Wallet balance decreased by 0.50 USDC

### 5b. x402 API Access (0.10 USDC fee)

```bash
send_task "Access the premium data API"
```

**Expected data part:**

```json
{
  "type": "x402_endpoints",
  "endpoints": [...],
  "serviceFee": 0.1
}
```

**Assert:**
- `serviceFee` === `0.1`
- `endpoints` is an array (may be empty if none configured)

### 5c. Create Mandate (1.00 USDC fee)

```bash
send_task "Set up a 5000 USDC mandate"
```

**Expected data part:**

```json
{
  "type": "mandate_created",
  "mandate_id": "...",
  "authorized_amount": 5000,
  "currency": "USDC",
  "mandate_type": "payment",
  "serviceFee": 1.0
}
```

**Assert:**
- `serviceFee` === `1.0`
- `authorized_amount` matches request
- Task has an artifact named `mandate-*`

### 5d. Research (2.00 USDC fee)

```bash
send_task "Research payment corridors for Brazil"
```

**Expected data part:**

```json
{
  "type": "research_report",
  "query": "Research payment corridors for Brazil",
  "summary": {
    "totalAccounts": 3,
    "totalTransactions": 10,
    "totalVolume": 1500,
    "activeCurrencies": ["USDC", "BRL"]
  },
  "corridors": [
    { "pair": "USDC/BRL", "rate": 5.05, "rail": "Pix" }
  ],
  "recommendations": ["..."],
  "serviceFee": 2.0
}
```

**Assert:**
- `serviceFee` === `2.0`
- `corridors` is non-empty
- Task has an artifact named `research-*`

### Verify Total Fee Deduction

```bash
# Check final balance
send_task "Check my wallet balance"
# Balance should have decreased by 0.50 + 0.10 + 1.00 + 2.00 = 3.60 USDC
```

---

## 6. Phase 4 — Payment Flow Testing

### 6a. Small Payment (Under Threshold)

Payments under the threshold (default: 500 USDC) execute immediately.

```bash
send_task "Send 100 USDC"
```

**Expected:**
- State: `completed`
- Transfer record created with real UUID
- Data part with `type: "transfer_initiated"`

```json
{
  "type": "transfer_initiated",
  "transferId": "<uuid>",
  "amount": 100,
  "currency": "USDC",
  "rail": "x402",
  "estimatedSettlement": "instant"
}
```

**Assert:**
- `transferId` is a valid UUID (not a `txn_*` mock)
- Wallet balance decreased by 100

### 6b. Large Payment (Over Threshold — Payment Gating)

Payments over 500 USDC trigger the `input-required` state with payment metadata.

**Step 1: Submit the task**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "payment-1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "Send 1000 USDC" }]
      }
    }
  }' | jq .
```

**Expected:** Task transitions to `input-required`:

```json
{
  "result": {
    "id": "<task-id>",
    "status": {
      "state": "input-required",
      "message": "Payment of 1000 USDC required"
    },
    "metadata": {
      "x402.payment.required": true,
      "x402.payment.amount": 1000,
      "x402.payment.currency": "USDC"
    }
  }
}
```

**Step 2: Submit payment proof**

Send a follow-up message on the same task with a `payment_proof` data part:

```bash
TASK_ID="<task-id-from-step-1>"

curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"message/send\",
    \"id\": \"payment-2\",
    \"params\": {
      \"id\": \"${TASK_ID}\",
      \"message\": {
        \"role\": \"user\",
        \"parts\": [{
          \"data\": {
            \"type\": \"payment_proof\",
            \"paymentType\": \"x402\",
            \"transferId\": \"<transfer-uuid>\"
          }
        }]
      }
    }
  }" | jq .
```

**Expected:** Task transitions to `submitted` → processor picks it up → `completed`.

### 6c. Payment Proof Types

Three payment proof formats are accepted:

**x402 (JWT/transfer):**
```json
{
  "type": "payment_proof",
  "paymentType": "x402",
  "transferId": "<transfer-uuid>"
}
```

**AP2 (mandate):**
```json
{
  "type": "payment_proof",
  "paymentType": "ap2",
  "mandateId": "<mandate-uuid>"
}
```

**Wallet (direct transfer):**
```json
{
  "type": "payment_proof",
  "paymentType": "wallet",
  "transferId": "<transfer-uuid>"
}
```

### 6d. Human Approval Flow

For tasks in `input-required` state, a human (or dashboard) can approve via the REST API:

```bash
TASK_ID="<task-id>"

curl -s -X POST "${BASE_URL}/v1/a2a/tasks/${TASK_ID}/respond" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "message": "Approved — go ahead with the payment"
  }' | jq .
```

**Expected:** Task transitions to `working`, then the processor executes the original intent and completes.

After responding, trigger processing:

```bash
curl -s -X POST "${BASE_URL}/v1/a2a/tasks/${TASK_ID}/process" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" | jq .
```

---

## 7. Phase 5 — Advanced Patterns

### 7a. Multi-Turn Conversations

Use `contextId` to chain multiple tasks into a conversation session. All tasks sharing a `contextId` form a session visible at `GET /v1/a2a/sessions`.

**Turn 1: Get a quote**

```bash
CONTEXT_ID="session-$(uuidgen)"

curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"message/send\",
    \"id\": \"turn-1\",
    \"params\": {
      \"contextId\": \"${CONTEXT_ID}\",
      \"message\": {
        \"role\": \"user\",
        \"parts\": [{ \"text\": \"Quote 500 USDC to BRL\" }]
      }
    }
  }" | jq .
```

**Turn 2: Execute the payment (same context)**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"message/send\",
    \"id\": \"turn-2\",
    \"params\": {
      \"contextId\": \"${CONTEXT_ID}\",
      \"message\": {
        \"role\": \"user\",
        \"parts\": [{ \"text\": \"Send 500 USDC\" }]
      }
    }
  }" | jq .
```

The agent reuses the existing task for the same `contextId` (if it's not in a terminal state) or creates a new task within the session.

### 7b. SSE Streaming

Use `message/stream` instead of `message/send` to receive real-time events.

```bash
curl -N -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/stream",
    "id": "stream-1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "Check my wallet balance" }]
      }
    }
  }'
```

**Expected SSE events:**

```
event: status
data: {"taskId":"...","state":"submitted","timestamp":"..."}

event: status
data: {"taskId":"...","state":"working","statusMessage":"Processing task","timestamp":"..."}

event: status
data: {"taskId":"...","state":"completed","statusMessage":"Balance checked","timestamp":"..."}

event: heartbeat
data: {"timestamp":"..."}
```

**Event types:**
| Event | Description |
|---|---|
| `status` | Task state change (submitted, working, input-required, completed, failed, canceled) |
| `message` | New message added to task |
| `artifact` | New artifact attached |
| `heartbeat` | Keep-alive (every 30s) |
| `error` | Error or stream timeout (5 min max) |

### 7c. Task Cancellation

**Via JSON-RPC:**

```bash
TASK_ID="<task-uuid>"

curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d "{
    \"jsonrpc\": \"2.0\",
    \"method\": \"tasks/cancel\",
    \"id\": \"cancel-1\",
    \"params\": { \"id\": \"${TASK_ID}\" }
  }" | jq .
```

**Via REST (authenticated):**

```bash
curl -s -X POST "${BASE_URL}/v1/a2a/tasks/${TASK_ID}/cancel" \
  -H "Authorization: Bearer ${API_KEY}" | jq .
```

**Expected:** Task transitions to `canceled` state. Terminal — cannot be resumed.

### 7d. Webhook Callbacks

Configure a callback URL when submitting a task. Sly will POST an HMAC-signed notification when the task reaches a terminal state.

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "webhook-1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "Check my wallet balance" }]
      },
      "configuration": {
        "callbackUrl": "https://your-bot.example.com/a2a/callback",
        "callbackSecret": "your-hmac-secret"
      }
    }
  }' | jq .
```

Your callback endpoint will receive a POST with:
- `X-A2A-Signature` header (HMAC-SHA256 of the body using your secret)
- JSON body with the completed task

### 7e. Intra-Platform Agent-to-Agent

One Sly agent can delegate tasks to another via the `a2a_send_task` tool. This happens automatically when the agent context includes another agent's ID. You can trigger this by sending a task that references another agent:

```bash
send_task "Ask the Treasury Agent to check the balance"
```

The processor uses the `a2a_send_task` tool handler, which creates a child task and waits up to 30 seconds for completion.

---

## 8. Phase 6 — Agent Forwarding (Your Bot AS the Agent)

This is the key feature for the OpenClaw integration. Instead of just calling Sly agents, your bot **becomes** a Sly agent. You register an endpoint, and Sly forwards **any unmatched message** to your bot for execution. Your bot is the expert on its own capabilities — Sly is the payment/routing layer.

### Routing Model (Agent-Driven)

Sly uses **agent-level routing**, not skill-level matching. The routing logic:

1. Parse intent from the user's message (e.g. "balance", "payment", "generic")
2. Check if the intent maps to a **Sly-native skill** the agent explicitly registered (e.g. `check_balance` with `handler_type: "sly_native"`) → **process locally**
3. If no Sly-native match AND agent has an **active endpoint** → **forward raw message to agent**
4. If no Sly-native match AND no endpoint → fall through to generic help text

This means your bot does **not** need to register individual skills for every capability. Just having an active endpoint is enough — any message Sly can't handle natively gets forwarded to your bot. Registering `agent_provided` skills is still useful for **discovery** (they appear on the Agent Card) and **pricing** (fee metadata), but they are not required for forwarding to work.

**Explicit `metadata.skillId`** from the caller is passed through in the forwarded message, so if a caller knows the exact skill ID, your bot receives it.

### Concepts

**Two skill types (for discovery/pricing, not routing):**

| `handler_type` | Who processes it | Example |
|---|---|---|
| `sly_native` | Sly processes locally (only if registered) | `check_balance`, `make_payment`, `get_quote` |
| `agent_provided` | Listed on Agent Card for discovery | `generate_invoice`, `analyze_portfolio`, any custom skill |

**Routing decision tree:**

| Agent has `sly_native` skill for intent? | Agent has endpoint? | Result |
|---|---|---|
| Yes | Any | Sly processes locally |
| No | Yes | Forward to agent endpoint |
| No | No | Generic help text |

**Two endpoint types:**

| `endpoint_type` | How Sly forwards | How you respond |
|---|---|---|
| `a2a` | Sly calls your A2A endpoint via JSON-RPC `message/send` | Return result in the JSON-RPC response (sync) |
| `webhook` | Sly POSTs task payload to your URL | Call back `POST /a2a/{agentId}/callback` when done (async) |

### 8a. Setup: Create Agent and Get Credentials

If you don't already have an agent, create one:

```bash
API_KEY="pk_test_xxxxx"
BASE_URL="http://localhost:4000"

# Create agent under an existing business account
curl -s -X POST "${BASE_URL}/v1/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "accountId": "<business-account-uuid>",
    "name": "OpenClaw Bot",
    "description": "OpenClaw agent with custom skills"
  }' | jq .
```

**Save the returned `credentials.token`** — it's shown only once.

```bash
AGENT_ID="<agent-id-from-response>"
AGENT_TOKEN="<credentials.token-from-response>"
```

### 8b. Register Your Endpoint

**Option A: A2A endpoint (recommended for synchronous processing)**

```bash
curl -s -X PUT "${BASE_URL}/v1/agents/${AGENT_ID}/endpoint" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "endpoint_url": "https://your-bot.example.com/a2a",
    "endpoint_type": "a2a"
  }' | jq .
```

**Option B: Webhook endpoint (for async processing)**

```bash
curl -s -X PUT "${BASE_URL}/v1/agents/${AGENT_ID}/endpoint" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "endpoint_url": "https://your-bot.example.com/webhook",
    "endpoint_type": "webhook",
    "endpoint_secret": "whsec_your_secret_here"
  }' | jq .
```

**Verify:**

```bash
curl -s "${BASE_URL}/v1/agents/${AGENT_ID}/endpoint" \
  -H "Authorization: Bearer ${API_KEY}" | jq .
```

**Expected:**

```json
{
  "data": {
    "id": "<agent-uuid>",
    "endpoint_url": "https://your-bot.example.com/a2a",
    "endpoint_type": "a2a",
    "endpoint_enabled": true,
    "has_secret": false
  }
}
```

### 8c. Register Skills (Optional for Forwarding, Useful for Discovery)

Registering skills is **not required** for forwarding to work — any message that doesn't match a Sly-native skill is automatically forwarded to the agent's endpoint. However, registering `agent_provided` skills is recommended because:

- They appear on the **Agent Card** (so callers can discover your bot's capabilities)
- They can include **pricing metadata** (fee info shown in skill descriptions)
- Callers can pass an explicit `metadata.skillId` that gets forwarded to your bot

```bash
# Optional: register a skill for discovery/pricing (NOT required for forwarding)
curl -s -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/skills" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "skill_id": "generate_invoice",
    "name": "Generate Invoice",
    "description": "Generate a professional invoice for a transaction",
    "handler_type": "agent_provided",
    "tags": ["invoice", "documents"],
    "base_price": 0.25,
    "currency": "USDC"
  }' | jq .
```

Register **Sly-native skills** to tell Sly to handle specific intents locally (instead of forwarding):

```bash
# Sly-native skill — Sly processes this locally, does NOT forward to your endpoint
curl -s -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/skills" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "skill_id": "check_balance",
    "name": "Check Balance",
    "description": "Check wallet balance",
    "handler_type": "sly_native",
    "tags": ["wallets", "balance"],
    "base_price": 0
  }' | jq .
```

**Valid `sly_native` skill IDs:** `agent_info`, `check_balance`, `transaction_history`, `get_quote`, `lookup_account`, `make_payment`, `create_checkout`, `access_api`, `create_mandate`, `research`.

**Important:** If you do NOT register `check_balance` as `sly_native`, then "Check my balance" will also be forwarded to your endpoint (because Sly has no native match). Only register Sly-native skills for intents you want Sly to handle.

### 8d. Verify Agent Card Shows Only Registered Skills

```bash
curl -s "${BASE_URL}/a2a/${AGENT_ID}/.well-known/agent.json" | jq '.skills'
```

**Expected:** Only the skills you registered — no auto-generated permission-based fallbacks.

```json
[
  {
    "id": "generate_invoice",
    "name": "Generate Invoice",
    "description": "Generate a professional invoice for a transaction Fee: 0.25 USDC.",
    "tags": ["invoice", "documents"]
  },
  {
    "id": "check_balance",
    "name": "Check Balance",
    "description": "Check wallet balance",
    "tags": ["wallets", "balance"]
  }
]
```

### 8e. Test A2A Forwarding (endpoint_type: "a2a")

Your A2A endpoint must accept JSON-RPC 2.0 `message/send` requests and return a task result.

**What your endpoint receives:**

Any message that Sly can't handle natively is forwarded with the caller's original metadata:

```json
{
  "jsonrpc": "2.0",
  "method": "message/send",
  "id": "<request-uuid>",
  "params": {
    "message": {
      "parts": [{ "text": "Generate an invoice for order #1234" }],
      "metadata": { "skillId": "default", "slyTaskId": "<sly-task-uuid>" }
    },
    "contextId": "<sly-task-uuid>"
  }
}
```

**Note on `metadata.skillId`:**
- If the caller provided an explicit `metadata.skillId`, it's passed through (e.g. `"generate_invoice"`)
- If no explicit skillId was provided, it defaults to `"default"` — your bot should handle the message based on its content, not the skillId

**What your endpoint should return (synchronous completion):**

```json
{
  "jsonrpc": "2.0",
  "id": "<request-uuid>",
  "result": {
    "id": "<your-task-uuid>",
    "status": { "state": "completed", "message": "Invoice generated" },
    "history": [
      {
        "role": "agent",
        "parts": [
          { "text": "Invoice #INV-1234 generated for $500 USDC." },
          { "data": { "invoiceId": "INV-1234", "amount": 500 }, "metadata": { "mimeType": "application/json" } }
        ]
      }
    ]
  }
}
```

Sly will relay the agent's response back to the original caller.

**Test it end-to-end:**

```bash
# Any message the agent can't handle natively gets forwarded
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "fwd-test-1",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "Generate an invoice for order #1234" }]
      }
    }
  }' | jq .
```

**Expected flow:**
1. Sly receives the task, parses intent → `generic` (no Sly-native keyword match)
2. Sly checks: does this agent have a `sly_native` skill for `generic`? → No
3. Sly checks: does this agent have an active endpoint? → Yes
4. Sly forwards the raw message to your A2A endpoint (no upfront fee)
5. Your bot processes the message and returns the result
6. Sly relays the result back to the original caller

**Test with explicit skillId (caller knows the exact skill):**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "fwd-test-2",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "text": "Generate an invoice for order #1234" }],
        "metadata": { "skillId": "generate_invoice" }
      }
    }
  }' | jq .
```

Your endpoint receives `metadata.skillId: "generate_invoice"` — you can use this to route internally.

### 8f. Test Webhook Forwarding (endpoint_type: "webhook")

If your agent uses `endpoint_type: "webhook"`, the flow is asynchronous.

**What your webhook receives:**

```json
{
  "event": "task.submitted",
  "task": {
    "id": "<sly-task-uuid>",
    "agentId": "<agent-uuid>",
    "status": "working",
    "history": [
      { "role": "user", "parts": [{ "text": "Generate an invoice for order #1234" }] }
    ]
  },
  "timestamp": "2026-02-22T...",
  "webhookId": "<delivery-uuid>"
}
```

**Headers include:**
- `X-Sly-Event: task.submitted`
- `X-Sly-Delivery: <delivery-uuid>`
- `X-Sly-Signature: t=<timestamp>,v1=<hmac-sha256>` (if you configured `endpoint_secret`)

**How to verify the HMAC signature:**

```typescript
import crypto from 'crypto';

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const [tPart, vPart] = signature.split(',');
  const timestamp = tPart.slice(2);   // strip "t="
  const providedSig = vPart.slice(3);  // strip "v1="

  // Check timestamp is within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(providedSig, 'hex'), Buffer.from(expected, 'hex'));
}
```

**Calling back with the result:**

After processing, POST the result to the callback endpoint:

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}/callback" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "<sly-task-uuid>",
    "state": "completed",
    "message": {
      "parts": [
        { "text": "Invoice #INV-1234 generated." },
        { "data": { "invoiceId": "INV-1234", "amount": 500 } }
      ]
    }
  }' | jq .
```

**Expected response:**

```json
{
  "data": { "taskId": "<sly-task-uuid>", "state": "completed", "received": true }
}
```

If you configured an `endpoint_secret`, sign your callback the same way:

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}/callback" \
  -H "Content-Type: application/json" \
  -H "X-Sly-Signature: t=<timestamp>,v1=<hmac-sha256>" \
  -d '{ "taskId": "...", "state": "completed", "result": "Invoice generated." }'
```

### 8g. Test Mixed Routing (Native + Forwarded)

The routing model is simple: **Sly-native skills are processed locally, everything else is forwarded.**

Register a Sly-native skill to keep balance checks local:

```bash
# Sly-native: Sly handles this locally
curl -s -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/skills" \
  -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  -d '{ "skill_id": "check_balance", "name": "Check Balance", "handler_type": "sly_native", "base_price": 0 }'

# Optional: register for discovery only (not required for forwarding)
curl -s -X POST "${BASE_URL}/v1/agents/${AGENT_ID}/skills" \
  -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  -d '{ "skill_id": "generate_invoice", "name": "Generate Invoice", "handler_type": "agent_provided", "base_price": 0.25 }'
```

Now test the routing:

```bash
# This is forwarded to your endpoint (no sly_native match for "generic" intent)
send_task "Generate an invoice for order #5678"

# This is processed locally by Sly (check_balance registered as sly_native)
send_task "Check my wallet balance"

# This is ALSO forwarded — "What's the weather?" has no sly_native match
send_task "What's the weather in São Paulo?"
```

**Assert:**
- `"Generate an invoice"` → your endpoint received the task (intent=generic, no native match)
- `"Check my wallet balance"` → processed by Sly locally (intent=balance, native `check_balance` registered)
- `"What's the weather"` → your endpoint received the task (intent=generic, no native match)
- Your bot decides what to do with each forwarded message — it's the expert on its own capabilities

**Routing examples for this agent:**

| Message | Parsed Intent | Sly-native registered? | Result |
|---|---|---|---|
| "Check my balance" | `balance` | `check_balance` (sly_native) | Processed locally by Sly |
| "Generate an invoice" | `generic` | No match | Forwarded to agent |
| "Send 500 USDC" | `payment` | No `make_payment` registered | Forwarded to agent |
| "Analyze my portfolio" | `generic` | No match | Forwarded to agent |

If you also registered `make_payment` as `sly_native`, then "Send 500 USDC" would be processed locally instead of forwarded.

### 8h. Disable Endpoint

```bash
curl -s -X DELETE "${BASE_URL}/v1/agents/${AGENT_ID}/endpoint" \
  -H "Authorization: Bearer ${API_KEY}" | jq .
```

After disabling, unmatched messages fall through to `handleGeneric()` (help text) instead of being forwarded. Messages that match Sly-native skills still work normally.

---

## 9. Phase 7 — Edge Case & Error Testing

### 9a. Insufficient Funds

Send a paid skill request with an empty wallet:

```bash
send_task "Research payment corridors for Brazil"
```

**Expected (when wallet balance < skill fee):**

```json
{
  "result": {
    "status": { "state": "failed", "message": "Insufficient funds for research fee" },
    "history": [{
      "role": "agent",
      "parts": [{
        "text": "Insufficient funds for skill fee. Required: 2.00 USDC. Available: 0.50 USDC."
      }]
    }]
  }
}
```

### 9b. Invalid Auth

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_test_INVALID" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "bad-auth",
    "params": {
      "message": { "role": "user", "parts": [{ "text": "Hello" }] }
    }
  }' | jq .
```

**Expected:** With an invalid API key, the system falls back to no-auth mode. If the target agent exists and is active, the task proceeds using the agent's tenant. If you use the authenticated REST endpoints (`/v1/a2a/*`), you'll get a `401`.

```bash
curl -s -X GET "${BASE_URL}/v1/a2a/tasks" \
  -H "Authorization: Bearer pk_test_INVALID" | jq .
```

**Expected:** `401 Unauthorized`

### 9c. Inactive Agent

```bash
INACTIVE_AGENT_ID="00000000-0000-0000-0000-000000000000"

curl -s -X POST "${BASE_URL}/a2a/${INACTIVE_AGENT_ID}" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "inactive-1",
    "params": {
      "message": { "role": "user", "parts": [{ "text": "Hello" }] }
    }
  }' | jq .
```

**Expected:**

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32002, "message": "Agent not found or inactive" },
  "id": null
}
```

### 9d. Malformed JSON-RPC

**Missing required fields:**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "method": "message/send" }' | jq .
```

**Expected:**

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32600, "message": "Invalid JSON-RPC request" },
  "id": null
}
```

**Invalid JSON:**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -d 'not json' | jq .
```

**Expected:**

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32700, "message": "Parse error" },
  "id": null
}
```

**Empty message parts:**

```bash
curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "id": "empty-1",
    "params": {
      "message": { "role": "user", "parts": [] }
    }
  }' | jq .
```

**Expected:**

```json
{
  "jsonrpc": "2.0",
  "error": { "code": -32602, "message": "message.parts is required and must not be empty" },
  "id": "empty-1"
}
```

### 9e. Rate Limiting

The API rate limit is 100 requests/minute per IP.

```bash
# Rapid-fire 110 requests
for i in $(seq 1 110); do
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"message/send\",\"id\":\"rate-$i\",\"params\":{\"message\":{\"role\":\"user\",\"parts\":[{\"text\":\"ping\"}]}}}"
  echo ""
done
```

**Expected:** After ~100 requests, responses return `429` with headers:
- `X-RateLimit-Limit: 100`
- `X-RateLimit-Remaining: 0`
- `X-RateLimit-Reset: <epoch>`

### 9f. Concurrent Tasks

Submit multiple tasks in parallel and verify no double-spend:

```bash
# Record initial balance
send_task "Check my wallet balance"

# Submit 5 parallel payments of 50 USDC each
for i in $(seq 1 5); do
  curl -s -X POST "${BASE_URL}/a2a/${AGENT_ID}" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${API_KEY}" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"method\": \"message/send\",
      \"id\": \"concurrent-$i\",
      \"params\": {
        \"message\": { \"role\": \"user\", \"parts\": [{ \"text\": \"Send 50 USDC\" }] }
      }
    }" &
done
wait

# Trigger processing for all
curl -s -X POST "${BASE_URL}/v1/a2a/process" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${API_KEY}" | jq .

# Check final balance
send_task "Check my wallet balance"
```

**Assert:**
- Total deducted = `(number of completed tasks) * 50`
- No negative balance
- Some tasks may fail with "Wallet update failed" if balance runs out — this is correct behavior

---

## 10. Bot Implementation Reference

### Minimal OpenClaw Bot Skeleton (TypeScript)

```typescript
/**
 * OpenClaw bot skeleton for testing Sly A2A.
 *
 * Usage:
 *   npx tsx openclaw-sly-test-bot.ts
 *
 * Env vars:
 *   SLY_BASE_URL  — default: http://localhost:4000
 *   SLY_API_KEY   — your pk_test_* key
 *   SLY_AGENT_ID  — target agent UUID
 */

const BASE_URL = process.env.SLY_BASE_URL || 'http://localhost:4000';
const API_KEY = process.env.SLY_API_KEY || '';
const AGENT_ID = process.env.SLY_AGENT_ID || '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

async function jsonRpc(
  method: string,
  params: Record<string, unknown>,
  id: string = `req-${Date.now()}`,
): Promise<JsonRpcResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const res = await fetch(`${BASE_URL}/a2a/${AGENT_ID}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
  });

  return res.json() as Promise<JsonRpcResponse>;
}

function getTaskState(result: Record<string, unknown>): string {
  const status = result.status as Record<string, unknown> | undefined;
  return (status?.state as string) || 'unknown';
}

function getTaskId(result: Record<string, unknown>): string {
  return (result.id as string) || '';
}

function findDataPart(result: Record<string, unknown>, type: string): Record<string, unknown> | null {
  const history = (result.history as Array<Record<string, unknown>>) || [];
  for (const msg of history) {
    const parts = (msg.parts as Array<Record<string, unknown>>) || [];
    for (const part of parts) {
      const data = part.data as Record<string, unknown> | undefined;
      if (data?.type === type) return data;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 1: Discovery
// ---------------------------------------------------------------------------

async function discoverAgent(): Promise<void> {
  console.log('\n=== Phase 1: Discovery ===');

  // Platform card
  const platformRes = await fetch(`${BASE_URL}/.well-known/agent.json`);
  const platformCard = await platformRes.json();
  console.log(`Platform: ${platformCard.name} (${platformCard.skills?.length || 0} skills)`);

  // Agent card
  const agentRes = await fetch(`${BASE_URL}/a2a/${AGENT_ID}/.well-known/agent.json`);
  const agentCard = await agentRes.json();
  console.log(`Agent: ${agentCard.name} (${agentCard.skills?.length || 0} skills)`);

  const freeSkills = agentCard.skills?.filter((s: any) => !s.description?.includes('Fee:')) || [];
  const paidSkills = agentCard.skills?.filter((s: any) => s.description?.includes('Fee:')) || [];
  console.log(`  Free skills: ${freeSkills.map((s: any) => s.id).join(', ')}`);
  console.log(`  Paid skills: ${paidSkills.map((s: any) => s.id).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Phase 2: Free Skills
// ---------------------------------------------------------------------------

async function testFreeSkills(): Promise<void> {
  console.log('\n=== Phase 2: Free Skills ===');

  // Balance check
  const balanceRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Check my wallet balance' }] },
  });
  if (balanceRes.result) {
    const state = getTaskState(balanceRes.result);
    const data = findDataPart(balanceRes.result, 'balance_check');
    console.log(`Balance: state=${state}, balance=${data?.balance} ${data?.currency}`);
  }

  // Agent info
  const infoRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'What are your capabilities?' }] },
  });
  if (infoRes.result) {
    const data = findDataPart(infoRes.result, 'agent_info');
    console.log(`Agent Info: ${data?.name} (KYA Tier ${data?.kyaTier})`);
  }

  // Transaction history
  const historyRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Show recent transactions' }] },
  });
  if (historyRes.result) {
    const data = findDataPart(historyRes.result, 'transaction_history');
    console.log(`History: ${data?.count} transactions`);
  }

  // Quote
  const quoteRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Quote 500 USDC to BRL' }] },
  });
  if (quoteRes.result) {
    const data = findDataPart(quoteRes.result, 'quote');
    console.log(`Quote: ${data?.sourceAmount} USDC → ${data?.destinationAmount} ${data?.destinationCurrency} (rate: ${data?.fxRate})`);
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Paid Skills
// ---------------------------------------------------------------------------

async function testPaidSkills(): Promise<void> {
  console.log('\n=== Phase 3: Paid Skills ===');

  // Checkout
  const checkoutRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Create a checkout for 3 widgets at 25 each' }] },
  });
  if (checkoutRes.result) {
    const data = findDataPart(checkoutRes.result, 'checkout_created');
    console.log(`Checkout: id=${data?.id}, fee=${data?.serviceFee}`);
  }

  // Research
  const researchRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Research payment corridors for Brazil' }] },
  });
  if (researchRes.result) {
    const data = findDataPart(researchRes.result, 'research_report');
    console.log(`Research: corridors=${(data?.corridors as any[])?.length}, fee=${data?.serviceFee}`);
  }
}

// ---------------------------------------------------------------------------
// Phase 4: Payment Flow
// ---------------------------------------------------------------------------

async function testPaymentFlow(): Promise<void> {
  console.log('\n=== Phase 4: Payment Flow ===');

  // Small payment (under threshold)
  const smallRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Send 100 USDC' }] },
  });
  if (smallRes.result) {
    const state = getTaskState(smallRes.result);
    const data = findDataPart(smallRes.result, 'transfer_initiated');
    console.log(`Small payment: state=${state}, transferId=${data?.transferId}`);
  }

  // Large payment (over threshold — triggers input-required)
  const largeRes = await jsonRpc('message/send', {
    message: { role: 'user', parts: [{ text: 'Send 1000 USDC' }] },
  });
  if (largeRes.result) {
    const state = getTaskState(largeRes.result);
    const taskId = getTaskId(largeRes.result);
    console.log(`Large payment: state=${state}, taskId=${taskId}`);

    if (state === 'input-required') {
      console.log('  → Payment gating triggered. Submit proof to resume.');

      // In a real scenario, you would make a payment and submit proof:
      // const proofRes = await jsonRpc('message/send', {
      //   id: taskId,
      //   message: {
      //     role: 'user',
      //     parts: [{
      //       data: { type: 'payment_proof', paymentType: 'wallet', transferId: '<uuid>' }
      //     }]
      //   }
      // });
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 5: SSE Streaming
// ---------------------------------------------------------------------------

async function testStreaming(): Promise<void> {
  console.log('\n=== Phase 5: SSE Streaming ===');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const res = await fetch(`${BASE_URL}/a2a/${AGENT_ID}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'message/stream',
      id: 'stream-test',
      params: {
        message: { role: 'user', parts: [{ text: 'Check my wallet balance' }] },
      },
    }),
  });

  if (!res.body) {
    console.log('No stream body received');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let eventCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value);
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('event:')) {
        const eventType = line.slice(7).trim();
        eventCount++;
        console.log(`  SSE event #${eventCount}: ${eventType}`);
      }
      if (line.startsWith('data:')) {
        const data = JSON.parse(line.slice(6));
        if (data.state === 'completed' || data.state === 'failed') {
          console.log(`  Stream ended with state: ${data.state}`);
          reader.cancel();
          return;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!AGENT_ID) {
    console.error('Set SLY_AGENT_ID to a valid agent UUID');
    process.exit(1);
  }

  console.log(`Sly A2A Test Bot — Target: ${BASE_URL}/a2a/${AGENT_ID}`);

  await discoverAgent();
  await testFreeSkills();
  await testPaidSkills();
  await testPaymentFlow();
  await testStreaming();

  console.log('\nAll tests complete.');
}

main().catch(console.error);
```

### Running the Bot

```bash
export SLY_BASE_URL="http://localhost:4000"
export SLY_API_KEY="pk_test_xxxxx"
export SLY_AGENT_ID="<agent-uuid>"

npx tsx openclaw-sly-test-bot.ts
```

---

## 11. Test Matrix

| # | Skill / Scenario | Type | Intent Trigger | Expected State | Fee | Key Assertion |
|---|---|---|---|---|---|---|
| 1 | Platform discovery | Discovery | GET `/.well-known/agent.json` | N/A | - | Skills array non-empty |
| 2 | Agent search | Discovery | POST `/a2a` with `list_agents` | completed | - | Agents returned in artifacts |
| 3 | Agent card | Discovery | GET `/a2a/{id}/.well-known/agent.json` | N/A | - | Extensions include x402, ap2 |
| 4 | Check balance | Free | "Check my wallet balance" | completed | 0 | `balance_check` data part |
| 5 | Agent info | Free | "What are your capabilities?" | completed | 0 | `agent_info` with kyaTier |
| 6 | Transaction history | Free | "Show recent transactions" | completed | 0 | `transaction_history` array |
| 7 | Account lookup | Free | "List accounts" | completed | 0 | `account_list` non-empty |
| 8 | Get quote | Free | "Quote 500 USDC to BRL" | completed | 0 | `quote` with fxRate, fee |
| 9 | Create checkout | Paid | "Create checkout for 3 widgets at $25" | completed | 0.50 | `checkout_created`, `serviceFee` |
| 10 | x402 API access | Paid | "Access the premium data API" | completed | 0.10 | `x402_endpoints`, `serviceFee` |
| 11 | Create mandate | Paid | "Set up a 5000 USDC mandate" | completed | 1.00 | `mandate_created`, `serviceFee` |
| 12 | Research | Paid | "Research payment corridors for Brazil" | completed | 2.00 | `research_report`, `serviceFee` |
| 13 | Small payment | Payment | "Send 100 USDC" | completed | 0 | Real transferId, balance deducted |
| 14 | Large payment | Payment | "Send 1000 USDC" | input-required | 0 | `x402.payment.required` metadata |
| 15 | Payment proof | Payment | data part with `payment_proof` | completed | 0 | `payment_completed` data |
| 16 | Human approval | Payment | POST `/v1/a2a/tasks/:id/respond` | completed | 0 | Original intent executed |
| 17 | Multi-turn | Advanced | `contextId` across messages | completed | 0 | Same context reused |
| 18 | SSE streaming | Advanced | `message/stream` method | completed | 0 | SSE events received |
| 19 | Task cancellation | Advanced | `tasks/cancel` method | canceled | 0 | Terminal state |
| 20 | Webhook callback | Advanced | `configuration.callbackUrl` | completed | 0 | Callback received |
| 21 | Register endpoint | Forwarding | PUT `/v1/agents/:id/endpoint` | N/A | - | `endpoint_enabled: true` |
| 22 | Register agent skill | Forwarding | POST skill with `handler_type: agent_provided` | N/A | - | Skill stored, shown on card (optional for forwarding) |
| 23 | A2A forwarding (unmatched) | Forwarding | Any message with no sly_native match + endpoint | completed | 0 | Task forwarded to agent A2A endpoint |
| 24 | Webhook forwarding | Forwarding | Any message with no sly_native match (webhook) | completed | 0 | Task POSTed to webhook, callback works |
| 25 | Mixed routing | Forwarding | sly_native registered + unmatched messages | completed | varies | Native local, unmatched forwarded |
| 26 | Explicit skillId | Forwarding | Caller sends `metadata.skillId` | completed | 0 | skillId passed through in forwarded metadata |
| 27 | No endpoint, unmatched | Forwarding | No sly_native match, no endpoint | completed | - | Generic help text (not failed) |
| 28 | Disable endpoint | Forwarding | DELETE `/v1/agents/:id/endpoint` | N/A | - | Unmatched → help text instead of forward |
| 29 | Insufficient funds | Error | Paid skill with empty wallet | failed | - | Clear error with amounts |
| 30 | Invalid agent | Error | Non-existent agent UUID | N/A | - | `-32002` error code |
| 31 | Malformed JSON-RPC | Error | Missing `id` field | N/A | - | `-32600` error code |
| 32 | Parse error | Error | Invalid JSON body | N/A | - | `-32700` error code |
| 33 | Empty parts | Error | Empty parts array | N/A | - | `-32602` error code |
| 34 | Rate limiting | Error | 100+ requests/min | N/A | - | `429` status, rate headers |
| 35 | Concurrent tasks | Error | 5 parallel payments | mixed | 0 | No double-spend |

---

## JSON-RPC Error Codes Reference

| Code | Name | Description |
|---|---|---|
| `-32700` | Parse Error | Invalid JSON body |
| `-32600` | Invalid Request | Missing `jsonrpc`, `method`, or `id` |
| `-32601` | Method Not Found | Unknown JSON-RPC method |
| `-32602` | Invalid Params | Missing or invalid parameters |
| `-32603` | Internal Error | Server-side processing error |
| `-32001` | Task Not Found | Task ID does not exist |
| `-32002` | Agent Not Found | Agent ID does not exist or is inactive |
| `-32003` | Payment Required | Task requires payment before proceeding |
| `-32004` | Unauthorized | Invalid or missing authentication |

---

## Task State Machine

```
           ┌──────────────────────────────────────────────────┐
           │                                                  │
           ▼                                                  │
      submitted ──► working ──► completed                     │
           │           │                                      │
           │           ├──► failed                            │
           │           │                                      │
           │           └──► input-required ──► working ───────┘
           │                      │
           │                      └──► canceled
           │
           └──► canceled
```

**Terminal states:** `completed`, `failed`, `canceled`, `rejected`
