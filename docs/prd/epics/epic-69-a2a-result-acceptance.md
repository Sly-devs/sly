# Epic 69: A2A Result Acceptance & Quality Feedback

**Status:** Backlog
**Phase:** 5.3 (Agent Economics)
**Priority:** P1
**Total Points:** 29
**Stories:** 7
**Dependencies:** Epic 57 (A2A Protocol), Epic 58 (Task Processor)
**Linear Project:** [Epic 69](https://linear.app/sly-ai/project/epic-69-a2a-result-acceptance)
**Created:** March 16, 2026

## Overview

When a provider agent completes an A2A task, the AP2 settlement mandate auto-resolves and payment transfers immediately. There is no review window — the caller cannot inspect the result, accept or reject it, or provide quality feedback before funds move. This means no reputation signal is emitted, no partial settlement is possible, and low-quality work is paid at the same rate as excellent work.

This epic adds an acceptance gate between task completion and mandate resolution, a quality feedback mechanism, and partial settlement support. Combined with Epic 62 (Escrow) and Epic 63 (Reputation Bridge), it creates a complete trust-and-quality loop for the A2A agent marketplace.

## Executive Summary

**Problem:** A2A tasks auto-settle on completion. Callers cannot review results before paying. No quality signals are captured. The marketplace has no quality accountability.

**Solution:** An optional acceptance gate that pauses mandate resolution until the caller reviews and accepts (or rejects) the result. Quality feedback is stored and feeds into Epic 63's trust score. Partial settlement allows proportional payment for partial work.

**Why now:** Epics 57 and 58 are complete — tasks execute and settle. Epic 68 adds pricing flexibility. Acceptance and feedback are the next unlock: quality accountability that enables a functioning agent marketplace.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|---|---|---|---|---|
| Acceptance gate (internal) | ❌ No | - | - | Internal task processor logic |
| `POST /a2a` respond (accept/reject) | ❌ No | - | - | Existing A2A endpoint |
| `GET /v1/agents/:id/feedback` | ✅ Yes | `sly.agents` | P2 | Feedback query |
| `GET /v1/agents/:id/feedback/summary` | ✅ Yes | `sly.agents` | P2 | Aggregated stats |
| `a2a_task_feedback` table | ❌ No | - | - | Internal storage |

**SDK Stories Required:**
- [ ] Update `sly.agents` module with feedback query methods (post-Epic 69)

---

## How It Works

### Acceptance Flow

```
Task completed by provider agent
    │
    ▼
┌──────────────────────────────────────────┐
│  Acceptance Gate Check (69.1)            │
│                                          │
│  Skill has requires_acceptance: true?    │
│    NO → auto-resolve mandate (existing)  │
│    YES → check auto_accept_below         │
│      Amount < threshold?                 │
│        YES → auto-resolve (skip review)  │
│        NO → transition to input-required │
│             reason_code: result_review   │
└──────────────┬───────────────────────────┘
               │ input-required
               ▼
┌──────────────────────────────────────────┐
│  Caller reviews result                   │
│                                          │
│  POST /a2a (tasks/respond)               │
│    accept: resolve mandate as completed  │
│    reject: resolve mandate as failed     │
│                                          │
│  Optional feedback on accept:            │
│    satisfaction, score (0-100), comment   │
│                                          │
│  Optional partial settlement:            │
│    settlement_amount < original amount   │
└──────────────┬───────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────┐
│  Timeout Worker (69.3)                   │
│  If no response within review_timeout    │
│  → auto-fail mandate (refund to caller)  │
└──────────────────────────────────────────┘
```

### Cross-Epic Integration

| Component | Epic | Integration |
|-----------|------|-------------|
| Mandate resolution | Epic 57 | Gate inserted before `resolveSettlementMandate()` |
| Task `input-required` state | Epic 58 | Existing state used for review pause |
| Escrow events | Epic 62 | 62.10 emits reputation signals on escrow terminal state |
| Trust score | Epic 63 | 63.8 ingests `a2a_task_feedback` as reputation source |
| Skill pricing | Epic 68 | Partial settlement adjusts resolved price |

---

## Stories

### Phase 1: Core Acceptance — 13 pts

| Story | Linear | Points | Priority | Labels | Status |
|-------|--------|--------|----------|--------|--------|
| 69.1: Acceptance gate on mandate resolution | [SLY-455](https://linear.app/sly-ai/issue/SLY-455) | 5 | High | Engineering | Backlog |
| 69.2: Acceptance policy configuration | [SLY-456](https://linear.app/sly-ai/issue/SLY-456) | 3 | High | Engineering | Backlog |
| 69.3: Review timeout worker | [SLY-457](https://linear.app/sly-ai/issue/SLY-457) | 3 | Medium | Engineering | Backlog |

#### Story Details

**69.1: Acceptance gate on mandate resolution (5 pts)**
When a task completes and the skill has `requires_acceptance: true` in its acceptance policy, the callback handler transitions the task to `input-required` (with `reason_code: 'result_review'`) instead of auto-resolving the mandate. The caller uses the existing `/tasks/:taskId/respond` endpoint to accept or reject.

- On accept → resolve mandate as `completed`
- On reject → resolve mandate as `failed` (refund to caller)

**Insertion point:** `apps/api/src/routes/a2a.ts` lines 542-545 — between task state update and mandate resolution.

**Acceptance Criteria:**
- [ ] Skills with `requires_acceptance: true` pause at `input-required` before mandate resolution
- [ ] Skills without the flag continue to auto-resolve (backwards compatible)
- [ ] Caller can accept via `tasks/respond` → mandate resolves as `completed`
- [ ] Caller can reject via `tasks/respond` → mandate resolves as `failed`
- [ ] Task metadata stores review state: `{ review_status, review_requested_at }`
- [ ] Only the original caller agent can accept/reject

**69.2: Acceptance policy configuration (3 pts)**
Add `acceptance_policy` to agent skill metadata:
```json
{
  "acceptance_policy": {
    "requires_acceptance": true,
    "auto_accept_below": 0.50,
    "review_timeout_minutes": 60
  }
}
```
- `requires_acceptance` — enables the acceptance gate
- `auto_accept_below` — threshold in USD; amounts below this skip review and auto-accept
- `review_timeout_minutes` — minutes before auto-fail if caller doesn't respond (default: 60)

**Acceptance Criteria:**
- [ ] `acceptance_policy` parsed from `agent_skills.metadata` during task completion
- [ ] `auto_accept_below` threshold correctly skips review for small amounts
- [ ] `review_timeout_minutes` stored in task metadata for timeout worker
- [ ] Default values applied when fields are missing
- [ ] Zod validation on acceptance policy shape

**69.3: Review timeout worker (3 pts)**
Background check that finds tasks in `input-required` with `reason_code: 'result_review'` past their timeout. Auto-resolves mandate as `failed` (refund to caller). Piggybacks on the existing scheduled-transfers worker interval or runs standalone.

**Acceptance Criteria:**
- [ ] Polls for timed-out review tasks every 60 seconds
- [ ] Tasks past `review_timeout_minutes` auto-resolve mandate as `failed`
- [ ] Timeout event recorded in task metadata and `a2a_audit_events`
- [ ] Worker gracefully handles concurrent mandate resolution attempts
- [ ] Configurable poll interval via environment variable

### Phase 2: Feedback & Partial Settlement — 13 pts

| Story | Linear | Points | Priority | Labels | Status |
|-------|--------|--------|----------|--------|--------|
| 69.4: Quality feedback on acceptance | [SLY-458](https://linear.app/sly-ai/issue/SLY-458) | 5 | Medium | Engineering, DB | Backlog |
| 69.5: Partial settlement on acceptance | [SLY-459](https://linear.app/sly-ai/issue/SLY-459) | 5 | Medium | Engineering | Backlog |

#### Story Details

**69.4: Quality feedback on acceptance (5 pts)**
When caller responds to accept, allow optional feedback payload:
```json
{
  "satisfaction": "excellent",
  "score": 85,
  "comment": "Fast turnaround, accurate results"
}
```
Satisfaction levels: `excellent` | `acceptable` | `partial` | `unacceptable`.

Create `a2a_task_feedback` table:
- `id`, `tenant_id`, `task_id`, `caller_agent_id`, `provider_agent_id`, `skill_id`
- `satisfaction`, `score` (0-100), `comment`
- `mandate_id`, `settlement_amount`
- `created_at`
- RLS: tenant isolation

**Migration:** `apps/api/supabase/migrations/20260316_a2a_task_feedback.sql`

**Acceptance Criteria:**
- [ ] Feedback stored on accept response (optional — accept works without feedback too)
- [ ] `a2a_task_feedback` table created with RLS
- [ ] Satisfaction enum validated via Zod
- [ ] Score validated: integer 0-100
- [ ] Feedback linked to task, caller, provider, skill, and mandate
- [ ] Reject responses can also include feedback (reason for rejection)

**69.5: Partial settlement on acceptance (5 pts)**
When caller accepts with `satisfaction: 'partial'`, allow `settlement_amount` override:
```json
{
  "satisfaction": "partial",
  "score": 40,
  "settlement_amount": 0.75,
  "comment": "Only 3 of 5 items completed"
}
```
- `settlement_amount` must be > 0 and <= original mandate amount
- Mandate resolves at the accepted amount
- Difference refunded to caller wallet
- Provider must have opted in via `metadata.allows_partial_settlement: true` on the skill

**Acceptance Criteria:**
- [ ] Partial settlement only allowed when skill `allows_partial_settlement: true`
- [ ] `settlement_amount` validated: > 0 and <= original mandate amount
- [ ] Mandate resolves at `settlement_amount`, not original amount
- [ ] Difference (original - settlement_amount) returned to caller wallet
- [ ] If `allows_partial_settlement: false`, partial amount is rejected (400)
- [ ] Settlement amount recorded in `a2a_task_feedback`

### Phase 3: Query & Testing — 8 pts

| Story | Linear | Points | Priority | Labels | Status |
|-------|--------|--------|----------|--------|--------|
| 69.6: Feedback query API | [SLY-460](https://linear.app/sly-ai/issue/SLY-460) | 3 | Low | Engineering, API | Backlog |
| 69.7: Unit tests | [SLY-461](https://linear.app/sly-ai/issue/SLY-461) | 5 | High | Engineering, Testing | Backlog |

#### Story Details

**69.6: Feedback query API (3 pts)**
Two new endpoints on the agents route:

- `GET /v1/agents/:id/feedback` — returns feedback received by this agent across tasks
  - Filters: `skill_id`, `date_from`, `date_to`, `satisfaction`
  - Pagination: standard page/limit
  - Returns: array of feedback records with task and caller details

- `GET /v1/agents/:id/feedback/summary` — aggregated stats
  - Returns: `{ avg_score, total_reviews, satisfaction_distribution: { excellent: N, acceptable: N, partial: N, unacceptable: N }, rejection_rate }`
  - Optional `skill_id` filter for per-skill breakdown

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

**Acceptance Criteria:**
- [ ] Both endpoints enforce tenant isolation via RLS
- [ ] Feedback list supports filtering and pagination
- [ ] Summary endpoint computes correct aggregates
- [ ] Empty feedback returns zeroed summary (not error)
- [ ] Agent can query their own feedback via agent token

**69.7: Unit tests (5 pts)**
Comprehensive test coverage for the acceptance gate, feedback, and partial settlement.

**Test cases:**
- Acceptance gate: accept flow, reject flow, auto-accept below threshold, timeout behavior
- Feedback: store on accept, store on reject, missing feedback (still works), invalid score
- Partial settlement: valid partial, exceeds original amount, provider not opted in, zero amount
- Feedback query: list with filters, summary aggregation, empty state
- Policy config: missing fields use defaults, invalid config rejected

**Files:**
- New: `apps/api/tests/unit/acceptance-gate.test.ts`

**Acceptance Criteria:**
- [ ] >90% branch coverage on acceptance gate logic
- [ ] All edge cases tested (timeout race conditions, concurrent accept/reject, etc.)
- [ ] Tests run without external dependencies (mocked Supabase)

---

## Dependencies

```
69.2 (policy config) ──→ 69.1 (acceptance gate uses policy)
69.1 (gate) ──→ 69.3 (timeout needs gate)
69.1 (gate) ──→ 69.4 (feedback on acceptance)
69.4 (feedback) ──→ 69.5 (partial settlement extends feedback)
69.4 (feedback) ──→ 69.6 (query API reads feedback table)
69.1, 69.4 ──→ 69.7 (tests after core features)
```

### Cross-Epic Dependencies

- **Epic 63.8** blocked by **69.4** — trust score ingestion needs `a2a_task_feedback` table
- **Epic 62.10** independent — can proceed whenever Epic 62 starts

### Critical Path

`69.2 → 69.1 → 69.4 → 69.5 → 69.7`

### Parallel Tracks

- **Gate track:** 69.2 → 69.1 → 69.3
- **Feedback track:** 69.1 → 69.4 → 69.5 (after gate)
- **Query track:** 69.4 → 69.6
- **Test track:** 69.7 (after 69.1 + 69.4)

---

## Key Files

| File | Change |
|---|---|
| `apps/api/src/routes/a2a.ts` | Acceptance gate in callback handler (lines 542-545) |
| `apps/api/src/services/a2a/task-processor.ts` | `resolveSettlementMandate()` partial settlement support |
| `apps/api/supabase/migrations/20260316_a2a_task_feedback.sql` | NEW — feedback table + RLS |
| `apps/api/src/routes/agents.ts` | Feedback query endpoints |
| `apps/api/tests/unit/acceptance-gate.test.ts` | NEW — test coverage |

## Security

- Feedback table scoped by `tenant_id` with RLS
- Only the original caller agent can accept/reject a task result
- Partial settlement amount validated server-side (cannot exceed original mandate)
- Review timeout prevents indefinite fund locks
- All acceptance/rejection events logged in `a2a_audit_events`

## Design Decisions

1. **Reuse `input-required` state** — A2A protocol already supports this state with custom reason codes. No new protocol extensions needed.
2. **Feedback optional on accept** — Callers can accept without providing feedback. Friction-free for quick transactions, feedback available for quality-sensitive ones.
3. **Timeout auto-fails (not auto-accepts)** — Conservative approach: if the caller doesn't review, funds return. Protects callers from paying for unreviewed work.
4. **Partial settlement requires provider opt-in** — Prevents surprise partial payments. Providers explicitly agree to partial settlement via skill metadata.
5. **Satisfaction enum, not just score** — Categorical satisfaction enables simple aggregation and filtering. Numeric score (0-100) provides granularity for trust calculations.
6. **Piggyback on existing worker** — Review timeout check runs alongside scheduled transfers worker to avoid deploying a separate background process.
