# Epic 73: KYC/KYA Tier Implementation

**Status:** Backlog
**Phase:** 4.3 (Compliance & Governance)
**Priority:** P0
**Total Points:** 116
**Stories:** 19
**Dependencies:** Epic 3 (Agent System & KYA), Epic 72 (Agent Key-Pair Auth)
**Created:** March 31, 2026
**Companion Docs:** CAI Framework (Working Paper III), PRD Master v1.26
**Spec:** Sly_KYC_KYA_Tier_Specification v1.0
**Implementation Notes:** [Per-Tenant Tier Limits with Platform Ceiling](../../completed/epics/EPIC_73_TIER_LIMITS_MULTITENANT.md) — follow-up that replaced the global `tier_limits` design from Story 73.1 with a tenant-scoped + ceiling-enforced model.

---

## Overview

Implement unified KYC/KYB account tiers (T0-T3) and KYA agent tiers (T0-T3) with progressive verification, spending limits, and CAI framework integration. This epic replaces the placeholder KYC/KYA verification in Epic 3 with a production-ready tiered system.

## Design Principles

1. **Compliance should feel like a feature, not a gate.** Users should think "this platform takes security seriously" not "this platform won't let me in."
2. **Unified ladder, diverging verification.** One tier structure for persons and businesses. Different documents required, different caps at upper tiers.
3. **Progressive disclosure.** Friction appears only when use case demands higher limits. Upgrade is triggered by actual usage, not arbitrary gates.
4. **Declare at entry, validate through behavior.** Agents self-declare capabilities at registration. Platform validates declarations through observed transaction patterns.
5. **Agent limits bounded by parent.** effective_limit = MIN(KYA tier limit, parent account tier limit). Always.
6. **Unlimited agents, limited spending.** Agent count is not capped at any tier. Spending limits are the risk control. Agent count belongs in commercial pricing, not compliance.

## Account Tiers (KYC/KYB)

| Tier | Name | Verification | Per Tx | Daily | Monthly |
|------|------|-------------|--------|-------|---------|
| T0 | Explore | Email only + IP geolocation + disposable domain check | $100 | $500 | $2,000 |
| T1 | Starter | + legal name, DOB, country, sanctions/PEP screening | $500 | $2,000 | $10,000 |
| T2 Person | Verified | + government ID, liveness, proof of address (Persona) | $5,000 | $20,000 | $100,000 |
| T2 Business | Verified | + registration docs, UBO, business address, signatory ID | $50,000 | $200,000 | $500,000 |
| T3 | Enterprise | + audited financials, source of funds, enhanced UBO, ongoing monitoring | Custom | Custom | Custom |

**No max agents at any tier.** Unlimited agent registration.

## Agent Tiers (KYA)

| Tier | Name | Requirements | Per Tx | Daily | Monthly | CAI Layers |
|------|------|-------------|--------|-------|---------|------------|
| T0 | Registered | Agent name, description, API key | $10 | $50 | $200 | 1 (partial), 4 (minimal) |
| T1 | Declared | + skill manifest, spending policy, escalation policy, use case | $100 | $500 | $2,000 | 1 (DSD), 3 (APT), 4 |
| T2 | Verified | + 30-day history OR enterprise override, zero violations, behavioral consistency | $1,000 | $5,000 | $20,000 | All 5 |
| T3 | Trusted | + security review, KYA-4 attestation, kill-switch operator, BRQ active | Custom | Custom | Custom | All 5 (fully verified) |

**Enterprise override:** T3 parent accounts can request expedited KYA-3 behavioral probes within 24-48 hours, bypassing the 30-day observation period.

## Inheritance Matrix

```
effective_limit = MIN(kya_tier.limit, parent_account_tier.limit)
```

| Parent Account Tier | KYA T0 | KYA T1 | KYA T2 | KYA T3 |
|---------------------|--------|--------|--------|--------|
| T0 ($100/tx) | $10/tx | $100/tx | $100/tx | $100/tx |
| T1 Person ($500/tx) | $10/tx | $100/tx | $500/tx | $500/tx |
| T2 Person ($5K/tx) | $10/tx | $100/tx | $1K/tx | Custom |
| T2 Business ($50K/tx) | $10/tx | $100/tx | $1K/tx | Custom |
| T3 Enterprise | $10/tx | $100/tx | $1K/tx | Custom |

## Verification Providers

| Phase | Provider | Function | Cost |
|-------|----------|----------|------|
| Pilot | Persona Starter | Sanctions/PEP screening, ID verification | Free (500/month) |
| Scale | Sumsub | KYC, KYB, AML screening | $1.35-1.85/check |
| All | Circle Compliance Engine | Transaction/address screening | Per API call (TBD) |
| Pilots | Partner Reliance (Zindigi, ACBA) | Inherited KYC | $0 |

## Pilot Mapping

| Pilot | Account Tier | KYA Tier | Notes |
|-------|-------------|----------|-------|
| Invu POS (production) | T3 Enterprise | KYA T2+ | POS settlement, many small tx |
| Zindigi (corporate) | T3 Enterprise | N/A | Regulated institution, partner reliance |
| Zindigi (end users) | T2 via reliance | KYA T1 | Consumer remittances |
| DN Invest | T3 Enterprise | KYA T2 (override) | Enterprise override for expedited KYA |
| ACBA Bank | T3 Enterprise | N/A | Mastercard issuer, partner reliance |
| Project Looking Glass | T2+ (Sly as parent) | KYA T0 | $0.10 payouts, CAI bootstrap event |

---

## Stories

### Phase 1: Database & Schema Foundation — 22 points

#### Story 73.1: Tier Limits Lookup Table (3 pts, P0)
**Linear:** SLY-508
**Status:** ✅ Complete — superseded by per-tenant refactor (April 19, 2026). See [`EPIC_73_TIER_LIMITS_MULTITENANT.md`](../../completed/epics/EPIC_73_TIER_LIMITS_MULTITENANT.md) for the final shape. The table originally shipped as global (one row per tier shared across all tenants) but was refactored to carry a `tenant_id` column: `NULL` rows are the platform ceiling, non-NULL rows are per-tenant overrides capped at the ceiling.

Create `tier_limits` table storing spending limits for all account and KYA tiers.

```sql
CREATE TABLE tier_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_type TEXT NOT NULL CHECK (tier_type IN ('account', 'kya')),
  tier_level INTEGER NOT NULL CHECK (tier_level BETWEEN 0 AND 3),
  entity_type TEXT CHECK (entity_type IN ('person', 'business', NULL)),
  limit_per_tx NUMERIC(20,8),
  limit_daily NUMERIC(20,8),
  limit_monthly NUMERIC(20,8),
  max_active_streams INTEGER,
  max_flow_rate_per_stream NUMERIC(20,8),
  max_total_outflow NUMERIC(20,8),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

Seed data for all account tiers (T0-T3, person/business split at T2) and KYA tiers (T0-T3).

**Acceptance Criteria:**
- [ ] Table created with proper constraints
- [ ] Seed data for all tiers
- [ ] T2 has separate person/business rows
- [ ] T3 uses NULL (custom/unlimited)
- [ ] No max_agents column

---

#### Story 73.2: Account Table Schema Updates (3 pts, P0)
**Linear:** SLY-509

Add verification_path ('standard'|'partner_reliance'|'enterprise'), reliance_partner_id, reliance_agreement_date, compliance_contact_name, compliance_contact_email.

**Acceptance Criteria:**
- [ ] Migration adds all columns
- [ ] Default verification_path is 'standard'
- [ ] Existing accounts unaffected

---

#### Story 73.3: Agent Table Schema Updates — CAI Fields (3 pts, P0)
**Linear:** SLY-510

Add model_family, model_version, skill_manifest (JSONB), use_case_description, escalation_policy (DECLINE|SUSPEND_AND_NOTIFY|REQUEST_APPROVAL), operational_history_start, policy_violation_count, behavioral_consistency_score, kya_enterprise_override, kya_override_assessed_at, kill_switch_operator_id/name/email.

**Acceptance Criteria:**
- [ ] All columns added with correct types
- [ ] escalation_policy defaults to DECLINE
- [ ] operational_history_start auto-set on first transaction

---

#### Story 73.4: Effective Limit Calculation Trigger (5 pts, P0)
**Linear:** SLY-511

Replace existing `calculate_effective_limits` trigger. Read from tier_limits table. Apply MIN(KYA tier, parent account tier) rule. NULL = unlimited.

**Acceptance Criteria:**
- [ ] Reads from tier_limits table
- [ ] MIN logic correct across all combinations
- [ ] Recalculates on agent or parent account tier change
- [ ] Unit tests for full inheritance matrix

---

#### Story 73.5: Account & Agent Tier Upgrade API Endpoints (8 pts, P1)
**Linear:** SLY-512

```
POST /v1/accounts/:id/upgrade { target_tier, verification_data }
POST /v1/agents/:id/upgrade { target_tier, ... }
GET /v1/agents/:id/kya-status
GET /v1/agents/:id/trust-profile (cross-org queryable)
```

**Acceptance Criteria:**
- [ ] Validates required fields per target tier
- [ ] KYA T2 checks 30-day history OR enterprise override
- [ ] T3 creates internal review ticket
- [ ] trust-profile is publicly queryable
- [ ] All upgrades logged to audit

---

### Phase 2: Account Tier Onboarding (T0-T1) — 18 points

#### Story 73.6: T0 Email-Only Onboarding Flow (5 pts, P0)
**Linear:** SLY-513

OAuth (Google/Apple/Twitter) or email verification → T0 account → Circle wallet provisioned → dashboard. Under 60 seconds. No name, DOB, or country required.

**Acceptance Criteria:**
- [ ] OAuth and email signup create T0 accounts
- [ ] Circle wallet auto-provisioned
- [ ] T0 limits enforced ($100/$500/$2K)
- [ ] Under 60 seconds signup-to-transaction

---

#### Story 73.7: Disposable Domain & Sanctions Country Blocking (3 pts, P1)
**Linear:** SLY-514

Block disposable email domains (200+ configurable list). Block IPs from sanctioned countries via geolocation. Run before account creation.

**Acceptance Criteria:**
- [ ] Configurable blocklists (no code deploy to update)
- [ ] Clear error messages ("service not available in your region")
- [ ] Blocked attempts logged for compliance audit

---

#### Story 73.8: T1 Upgrade Flow — Lightweight KYC (5 pts, P1)
**Linear:** SLY-515

Inline upgrade when user hits T0 limit. Single screen: legal name, DOB, country (+ company name for business). Sanctions/PEP screening. Auto-upgrade if clean.

**Acceptance Criteria:**
- [ ] 3-4 fields, 30 seconds to complete
- [ ] Sanctions/PEP screening via Persona Starter
- [ ] Auto-upgrade on clean screening
- [ ] Pending state for flagged users
- [ ] T1 limits active immediately ($500/$2K/$10K)

---

#### Story 73.9: Dashboard Tier Status & Upgrade Prompts (5 pts, P2)
**Linear:** SLY-516

Tier badges, usage progress bars (green/yellow/red), upgrade CTAs at 80% usage, bottleneck indicator (parent vs KYA).

**Acceptance Criteria:**
- [ ] Account and per-agent tier display
- [ ] Usage progress bars with color coding
- [ ] Upgrade prompt at 80% of any limit
- [ ] Shows which tier (parent or KYA) is the bottleneck

---

### Phase 3: Verification Provider Integration (T2-T3) — 34 points

#### Story 73.10: Persona SDK Integration — T2 Person (8 pts, P1)
**Linear:** SLY-518

Embedded Persona Web SDK for government ID + selfie liveness + proof of address. Webhook for status. Auto-upgrade on success.

**Acceptance Criteria:**
- [ ] Persona SDK embedded in dashboard
- [ ] Supports passport, driver's license, national ID
- [ ] Person limits active on approval ($5K/$20K/$100K)
- [ ] Works within Persona Starter free tier

---

#### Story 73.11: Persona KYB Integration — T2 Business (8 pts, P1)
**Linear:** SLY-519

KYB flow: registration docs, UBO (25%+), business address, signatory ID + liveness.

**Acceptance Criteria:**
- [ ] Full KYB document collection
- [ ] Business limits on approval ($50K/$200K/$500K)
- [ ] Manual review path for incomplete docs

---

#### Story 73.12: Partner Reliance Verification Path (5 pts, P1)
**Linear:** SLY-520

API for regulated partners (Zindigi, ACBA) to submit pre-verified users. Land at T2 without Persona/Sumsub.

**Acceptance Criteria:**
- [ ] verification_path = 'partner_reliance'
- [ ] Partner API endpoint for verified user data
- [ ] Audit trail shows reliance source

---

#### Story 73.13: Circle Compliance Engine Integration (8 pts, P1)
**Linear:** SLY-521

Real-time transaction screening on all wallet transactions. Address screening API. Alert dashboard.

**Acceptance Criteria:**
- [ ] Embedded screening on wallet transactions
- [ ] Standalone address screening endpoint
- [ ] Custom rules per Sly risk policy
- [ ] REVIEW results trigger wallet freeze + notification

---

#### Story 73.14: T3 Enterprise EDD Review Workflow (5 pts, P2)
**Linear:** SLY-522

Internal review workflow for T3: document upload, checklist, admin approval, custom limits.

**Acceptance Criteria:**
- [ ] Creates internal review ticket
- [ ] Document upload for financials/source of funds
- [ ] Admin approval activates T3 with custom limits

---

### Phase 4: KYA Agent Tiers & CAI Integration — 42 points

#### Story 73.15: KYA T1 Agent Declaration Flow — DSD (8 pts, P0)
**Linear:** SLY-523

T0→T1 upgrade: parent declares skill manifest, spending policy, use case, escalation policy. This is the Delegation Scope Document from the CAI paper.

```json
{
  "protocols": ["x402", "mpp", "a2a"],
  "action_types": ["payment_initiate", "data_query"],
  "domain": "procurement",
  "description": "Procurement negotiation agent"
}
```

**Acceptance Criteria:**
- [ ] Skill manifest validated against schema
- [ ] Spending policy with per-tx/daily/monthly limits
- [ ] Escalation policy required
- [ ] KYA T1 limits enforced ($100/$500/$2K)

---

#### Story 73.16: Agent Behavioral Observation Engine (8 pts, P0)
**Linear:** SLY-524

Passive data collection on agent activity. Tracks transactions vs declared scope, spending velocity, scope adherence, error rates. Daily aggregates in `agent_observations` table. 30-day rolling window.

**Acceptance Criteria:**
- [ ] operational_history_start set on first transaction
- [ ] Daily aggregates: tx count, volume, counterparties, violations, errors
- [ ] Scope violation detection
- [ ] Does NOT block transactions, only observes

---

#### Story 73.17: KYA T2 Verification & Enterprise Override (8 pts, P1)
**Linear:** SLY-525

Standard path: 30-day history + zero violations + behavioral consistency score. Enterprise override: T3 parent triggers structured KYA-3 probes (consistency, scope adherence, self-representation) within 24-48 hours.

**Acceptance Criteria:**
- [ ] Standard path validates all criteria automatically
- [ ] Enterprise override with probe administration
- [ ] Behavioral consistency score (0.00-1.00)
- [ ] T2 limits: $1K/$5K/$20K

---

#### Story 73.18: Cross-Org Agent Trust Profile Endpoint (5 pts, P1)
**Linear:** SLY-526

`GET /v1/agents/:id/trust-profile` — publicly queryable. Returns KYA tier, parent tier, operational days, violation count, declared skills, model family, behavioral score. Core Sly differentiator vs ATXP.

**Acceptance Criteria:**
- [ ] Publicly queryable (no PII exposed)
- [ ] T0/T1 agents return minimal profiles
- [ ] T2+ agents return full behavioral data
- [ ] Rate limited, cached (5-min TTL)

---

#### Story 73.19: KYA T3 Full CAI & Kill Switch (8 pts, P2)
**Linear:** SLY-527

Kill-switch operator designation, KYA-4 operational continuity attestation (runtime hash, model version), ongoing monitoring, BRQ score activation.

**Acceptance Criteria:**
- [ ] Kill-switch suspends agent within 60 seconds
- [ ] KYA-4 stores runtime hash + model version
- [ ] Full CAI/UTE status flag
- [ ] Custom limits per agent

---

#### Story 73.20: SDK Tier Status & Trust Profile Methods (5 pts, P2)
**Linear:** SLY-528

SDK methods: `getKyaStatus()`, `getTrustProfile()`, `upgrade()`, `getTierStatus()`.

**Acceptance Criteria:**
- [ ] SDK exposes tier status, upgrade, trust-profile methods
- [ ] TypeScript types match API responses
- [ ] Error messages indicate parent vs KYA bottleneck

---

## SDK Impact Assessment

| SDK Package | Impact | Changes |
|-------------|--------|---------|
| @payos/sdk | High | New tier status, upgrade, and trust-profile methods |
| MCP Server | Medium | Expose tier status and trust-profile as MCP tools |
| LangChain Tools | Medium | Trust-profile query as LangChain tool for agent-to-agent trust checks |

## Implementation Schedule

| Phase | Stories | Points | Dependencies |
|-------|---------|--------|-------------|
| Phase 1: Schema | 73.1-73.5 | 22 | None |
| Phase 2: T0-T1 | 73.6-73.9 | 18 | Phase 1 |
| Phase 3: T2-T3 | 73.10-73.14 | 34 | Phase 2 |
| Phase 4: KYA/CAI | 73.15-73.20 | 42 | Phase 1 (can parallel Phase 2-3) |

**Critical path for pilots:** Phase 1 + Phase 2 = 40 points. Enables email-only onboarding + T1 lightweight KYC.

**Phase 4 can start in parallel** with Phases 2-3 since KYA tiers only need the schema foundation (Phase 1).
