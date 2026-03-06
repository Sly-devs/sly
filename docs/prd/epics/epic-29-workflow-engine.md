# Epic 29: Workflow Engine

**Status:** Pending
**Phase:** 6 (AI-Native Infrastructure)
**Priority:** P0 (core) / P1 (advanced steps)
**Estimated Points:** 52
**Stories:** 11 (0 complete)
**Dependencies:** None
**Created:** March 1, 2026

[← Back to Epic List](./README.md)

---

## Executive Summary

The Workflow Engine provides composable, multi-step processes configured per-partner. Instead of hard-coding "approval workflows for procurement," we build a generic system that handles approvals, batch processing, conditional logic, and multi-stage operations.

Originally specced at 42 points / 11 stories in PRD v1.14, this epic is revised to **52 points** with expanded Stories 29.4 and 29.5 to support agent contracting governance. The structural design is unchanged — the extensions add reputation-aware condition expressions and escrow/contract-specific action types.

**For agent contracting, this is the critical governance primitive:**
- Every contract above a threshold needs approval chains
- Every escrow release needs authorization
- Every new counterparty needs compliance review
- The engine handles all of these through the same configurable step system

**Key Design Decision — Workflows are Configured, Not Coded:**
Partners define workflow templates via API or dashboard. Steps are composable: mix approvals, conditions, actions, waits, and notifications. Same workflow handles both human and agent actors.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/workflows/templates` | ✅ Yes | `sly.workflows` | P0 | Create template |
| `GET /v1/workflows/templates` | ✅ Yes | `sly.workflows` | P0 | List templates |
| `POST /v1/workflows/instances` | ✅ Yes | `sly.workflows` | P0 | Trigger workflow |
| `POST /v1/workflows/instances/:id/steps/:n/approve` | ✅ Yes | `sly.workflows` | P0 | Approve step |
| `POST /v1/workflows/instances/:id/steps/:n/reject` | ✅ Yes | `sly.workflows` | P0 | Reject step |
| `GET /v1/workflows/pending` | ✅ Yes | `sly.workflows` | P1 | Pending approvals |
| Dashboard workflow builder | ❌ No | - | - | Frontend only |

---

## Architecture

### Step Types

| Step Type | Purpose | Contract Governance Example |
|-----------|---------|----------------------------|
| `approval` | Require human/agent sign-off | Manager approval for contract >$1K |
| `condition` | Branch based on expression | If counterparty reputation <600 → deny |
| `action` | Execute Sly operation | Create escrow, release escrow, update allowlist |
| `wait` | Pause until condition/time | Wait for deliverable verification |
| `notification` | Send webhook/email | Notify requester of approval status |

### Data Flow

```
Trigger Event (contract proposal, escrow release, new counterparty)
    │
    ▼
┌─────────────────────────────────┐
│  Match Workflow Template         │ ◄── trigger_type + trigger_config conditions
│  (by trigger_type & conditions) │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│  Create Workflow Instance        │
│  - Copy steps from template     │
│  - Store trigger_data (amount,  │
│    counterparty, reputation)    │
│  - Set expires_at               │
└──────────┬──────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│  State Machine — advance through steps   │
│                                          │
│  condition → evaluate expression         │
│    ├── if_true: continue / skip_to:N     │
│    └── if_false: reject / continue       │
│                                          │
│  approval → pause, wait for human/agent  │
│    ├── approved: advance                 │
│    └── rejected: stop workflow           │
│                                          │
│  action → execute Sly operation          │
│    └── store result, advance             │
│                                          │
│  wait → pause until time/condition       │
│                                          │
│  notification → fire webhook, advance    │
└──────────┬───────────────────────────────┘
           │
           ▼
       COMPLETED / REJECTED / TIMED_OUT
```

### Contract Governance Templates

**Template 1 — Standard Contract Approval:**
1. Condition: value under auto-approve threshold? → skip to action
2. Condition: value above escalation threshold? → add CFO to approvers
3. Approval: finance manager reviews (timeout 24h, escalates to operations)
4. Action: authorize contract / create escrow
5. Notification: webhook to requesting agent with status

**Template 2 — New Counterparty Onboarding:**
1. Action: query External Reputation Bridge (Epic 63)
2. Condition: reputation meets minimum thresholds? If no → auto-deny
3. Approval: compliance team reviews counterparty profile
4. Action: add to allowlist
5. Notification: update agent and audit log

**Template 3 — Escrow Release Authorization:**
1. Action: validate deliverable
2. Condition: contract under auto-release threshold? → skip to release
3. Approval: designated reviewer confirms deliverable quality
4. Action: call Epic 62 escrow release
5. Notification: both parties notified

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Transfer execution | `apps/api/src/routes/transfers.ts` | `execute_transfer` action |
| Simulation engine | Epic 28 | `execute_simulation` action |
| Webhook delivery | `apps/api/src/services/webhooks/` (Epic 17) | Notification step |
| Escrow service | Epic 62 | `create_escrow`, `release_escrow` actions |
| Reputation bridge | Epic 63 | `query_reputation` action |
| Policy engine | Epic 18 Story 18.7 | `authorize_contract` action |

---

## Stories

### Phase 1: Core Engine

---

### Story 29.1: Workflow Data Model & Template CRUD

**Points:** 5
**Priority:** P0

**Description:**
Create the workflow tables and implement template CRUD API. Templates define reusable workflow patterns.

**Tables:**
- `workflow_templates` — template definitions (tenant_id, name, trigger_type, trigger_config, steps JSONB, timeout_hours, on_timeout)
- `workflow_instances` — running instances (template_id, trigger_entity_type, trigger_entity_id, trigger_data, status, current_step, step_states, outcome)
- `workflow_step_executions` — individual step audit (instance_id, step_index, step_type, status, approval details, action results, condition results)

**Files:**
- New: `apps/api/supabase/migrations/XXX_workflows.sql`
- New: `apps/api/src/routes/workflows.ts`
- New: `apps/api/src/schemas/workflow.schema.ts`
- New: `apps/api/src/types/workflows.ts`

**Acceptance Criteria:**
- [ ] Migration creates all three tables with RLS
- [ ] POST creates template with step validation (Zod schema)
- [ ] GET list with pagination, filter by trigger_type
- [ ] GET single returns full template with steps
- [ ] PUT updates template (only if no active instances)
- [ ] DELETE soft-deletes (sets `is_active=false`)
- [ ] Validates step types: approval, condition, action, wait, notification
- [ ] `trigger_type` supports: `manual`, `on_transfer`, `on_contract`, `on_escrow`, `on_threshold`, `scheduled`

---

### Story 29.2: Workflow Instance Creation & State Machine

**Points:** 5
**Priority:** P0

**Description:**
Implement workflow instantiation and the core state machine that advances through steps.

**Files:**
- New: `apps/api/src/services/workflow-engine.service.ts`
- New: `apps/api/src/services/workflow-state-machine.ts`

**Acceptance Criteria:**
- [ ] POST creates instance from template with trigger_data
- [ ] State machine advances through steps sequentially
- [ ] Handles `skip_to` directives from condition steps
- [ ] Status transitions: pending → in_progress → completed/rejected/cancelled/timed_out
- [ ] Step execution creates `workflow_step_executions` records
- [ ] Concurrent instance limit per template (configurable, default 50)
- [ ] Auto-trigger on events when trigger_type matches (`on_contract`, `on_escrow`)
- [ ] Idempotency: same `trigger_entity_id` doesn't create duplicate instances

---

### Story 29.3: Approval Step Execution

**Points:** 5
**Priority:** P0

**Description:**
Implement the approval step type. Pauses workflow until designated approver(s) approve or reject.

**Files:**
- New: `apps/api/src/services/workflow-steps/approval-step.ts`
- Modify: `apps/api/src/routes/workflows.ts` (approve/reject endpoints)

**Acceptance Criteria:**
- [ ] Step pauses workflow and sets status to `awaiting_approval`
- [ ] Approvers resolved by: role, specific user_id, agent_id, or "any_of" list
- [ ] POST /approve sets `approval_decision='approved'`, records `actual_approver`
- [ ] POST /reject sets `approval_decision='rejected'`, records comment
- [ ] Rejection stops workflow with `outcome='rejected'`
- [ ] Approval advances to next step
- [ ] Context fields from trigger_data displayed to approver
- [ ] Only designated approvers can approve (403 for others)

---

### Story 29.4: Condition Step with Expression Evaluation

**Points:** 5
**Priority:** P0
**(Expanded from 3 pts for contract governance expressions)**

**Description:**
Implement condition step that evaluates expressions and branches workflow. Extended to support reputation scores, counterparty data, and policy fields from the contracting context.

**Files:**
- New: `apps/api/src/services/workflow-steps/condition-step.ts`
- New: `apps/api/src/services/expression-evaluator.ts`

**Acceptance Criteria:**
- [ ] Evaluates JavaScript-like expressions against trigger_data and step results
- [ ] Supports operators: `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`
- [ ] Supports nested field access: `trigger.counterparty.reputation_score`
- [ ] Supports step result references: `steps[0].action_result.unified_score`
- [ ] `if_true` and `if_false` support: `continue`, `skip_to:N`, `reject`, `approve`
- [ ] Logs evaluated expression, input data, and result for audit
- [ ] Expression evaluation sandboxed (no arbitrary code execution)
- [ ] Handles missing fields gracefully (null-safe access)
- [ ] **Contract extension:** Built-in helpers: `reputation_meets(counterpartyId, minScore)`, `exposure_within(walletId, counterpartyId, limit)`

---

### Phase 2: Advanced Steps

---

### Story 29.5: Action Step Integration

**Points:** 5
**Priority:** P1
**(Expanded from 5 pts for contract governance actions)**

**Description:**
Implement action step that executes Sly operations. Extended to support escrow and reputation operations for agent contracting.

**Action Types:**
| Action | Source | Description |
|--------|--------|-------------|
| `execute_transfer` | Existing | Execute a payment transfer |
| `execute_simulation` | Epic 28 | Dry-run a transfer |
| `create_refund` | Epic 10 | Issue a refund |
| `create_escrow` | Epic 62 🆕 | Create governed escrow |
| `release_escrow` | Epic 62 🆕 | Release escrow funds |
| `freeze_escrow` | Epic 62 🆕 | Emergency freeze |
| `query_reputation` | Epic 63 🆕 | Query External Reputation Bridge |
| `update_allowlist` | Epic 18 🆕 | Add/remove counterparty from wallet policy |
| `authorize_contract` | Epic 18 🆕 | Mark pending contract as approved |

**Files:**
- New: `apps/api/src/services/workflow-steps/action-step.ts`
- New: `apps/api/src/services/workflow-action-registry.ts`

**Acceptance Criteria:**
- [ ] Action params support template variables: `{{trigger.field}}`, `{{steps[N].result.field}}`
- [ ] Action result stored in `step_execution.action_result`
- [ ] Failed actions set step status to `failed` with error details
- [ ] Retry logic: configurable retries with backoff (default 0)
- [ ] All existing action types work
- [ ] All contract extension action types registered and functional

---

### Story 29.6: Notification Step

**Points:** 3
**Priority:** P1

**Description:**
Implement notification step that sends webhooks or triggers external notifications.

**Files:**
- New: `apps/api/src/services/workflow-steps/notification-step.ts`

**Acceptance Criteria:**
- [ ] Webhook delivery to configured endpoint
- [ ] Template variables resolved in notification payload
- [ ] Supports recipient lists (multiple webhooks)
- [ ] Uses existing webhook infrastructure from Epic 17
- [ ] Non-blocking: notification failure doesn't stop workflow
- [ ] Delivery status tracked in step execution

---

### Story 29.7: Wait Step with Scheduling

**Points:** 3
**Priority:** P1

**Description:**
Implement wait step that pauses workflow until a condition is met or time elapses.

**Files:**
- New: `apps/api/src/services/workflow-steps/wait-step.ts`
- New: `apps/api/src/workers/workflow-scheduler.ts`

**Acceptance Criteria:**
- [ ] Wait types: `duration` (wait N hours), `until` (wait until datetime), `condition` (poll until expression true)
- [ ] Duration waits scheduled via cron/setTimeout
- [ ] Condition waits polled every 60 seconds
- [ ] Max wait configurable (default 7 days)
- [ ] Expired waits follow `on_timeout` policy: cancel, escalate, or auto_approve

---

### Story 29.8: Timeout Handling & Escalation

**Points:** 2
**Priority:** P1

**Description:**
Handle workflow and step-level timeouts with configurable escalation.

**Files:**
- New: `apps/api/src/workers/workflow-timeout.ts`

**Acceptance Criteria:**
- [ ] Workflow-level timeout (default 72h) checked by scheduled worker
- [ ] Step-level `timeout_hours` on approval steps
- [ ] On timeout: cancel workflow, escalate to next approver, or auto_approve
- [ ] Escalation creates new approval step with expanded approver list
- [ ] Timeout events logged to `workflow_step_executions`

---

### Story 29.9: Pending Workflows API

**Points:** 3
**Priority:** P1

**Description:**
API for users/agents to see their pending approval tasks.

**Files:**
- Modify: `apps/api/src/routes/workflows.ts`

**Acceptance Criteria:**
- [ ] GET /pending returns workflows where current user is in approver list
- [ ] Includes trigger_data context fields for informed decisions
- [ ] Sortable by created_at, amount, urgency
- [ ] Filter by trigger_entity_type (contract, escrow, transfer)
- [ ] Count endpoint for badge display on dashboard

---

### Phase 3: Dashboard & Analytics

---

### Story 29.10: Dashboard Workflow Builder UI

**Points:** 5
**Priority:** P2

**Description:**
Visual workflow template builder in the dashboard.

**Files:**
- New: `apps/web/src/app/dashboard/workflows/page.tsx`
- New: `apps/web/src/components/workflows/WorkflowBuilder.tsx`
- New: `apps/web/src/components/workflows/StepPalette.tsx`

**Acceptance Criteria:**
- [ ] Step palette with drag-and-drop
- [ ] Step configuration panels for each type
- [ ] Visual flow diagram showing step sequence and branches
- [ ] Template validation before save
- [ ] Pre-built templates: "Contract Approval", "Counterparty Review", "Escrow Release"
- [ ] Active instance count displayed per template

---

### Story 29.11: Workflow Analytics & Reporting

**Points:** 3
**Priority:** P2

**Description:**
Analytics on workflow performance: approval times, rejection rates, bottlenecks.

**Files:**
- New: `apps/web/src/components/workflows/WorkflowAnalytics.tsx`
- Modify: `apps/api/src/routes/workflows.ts` (analytics endpoints)

**Acceptance Criteria:**
- [ ] Average time to approval per template
- [ ] Approval vs rejection rate per template
- [ ] Bottleneck identification (which steps take longest)
- [ ] Active workflow count and trend
- [ ] Export workflow audit trail for compliance

---

## Points Summary

| Phase | Stories | Points |
|-------|---------|--------|
| Phase 1: Core Engine | 29.1–29.4 | 20 |
| Phase 2: Advanced Steps | 29.5–29.9 | 16 |
| Phase 3: Dashboard & Analytics | 29.10–29.11 | 8 |
| **Contract Extensions** | (in 29.4 + 29.5) | **+8** |
| **Total** | **11** | **52** |

---

## Implementation Sequence

```
Phase 1: Core Engine (29.1-29.4)         ← No dependencies, immediately testable
    ↓
Phase 2: Advanced Steps (29.5-29.9)      ← Depends on Phase 1 state machine
    ↓
Phase 3: Dashboard (29.10-29.11)         ← Depends on Phases 1-2
```

Contract governance actions in 29.5 can be stubbed initially and wired when Epics 62/63 land.

---

## Definition of Done

- [ ] All stories have passing tests (unit + integration)
- [ ] No cross-tenant data leaks (RLS verified)
- [ ] State machine handles all transitions per spec
- [ ] Approval step enforces designated-approver-only access
- [ ] Timeout worker runs reliably, no stuck workflows
- [ ] Pre-built contract governance templates seeded for demo tenants
- [ ] Expression evaluator sandboxed (no arbitrary code execution)
