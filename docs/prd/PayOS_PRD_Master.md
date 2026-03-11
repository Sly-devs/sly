# Sly — Product Requirements Document (PRD)

**Version:** 1.23
**Date:** March 1, 2026
**Status:** Agent Contracting Governance + Platform Architecture & Card Networks

---

## Executive Summary

Sly is a **multi-protocol settlement infrastructure** for LATAM, enabling fintechs and AI agents to move money across borders using stablecoins with native local rail integration (Pix, SPEI). This PRD covers the PoC implementation that demonstrates:

1. **Core settlement infrastructure** — Quotes, transfers, multi-currency payouts
2. **Agent system** — AI agents as first-class actors with KYA verification
3. **Multi-protocol support** — x402 (Coinbase), AP2 (Google), ACP (Stripe/OpenAI), UCP (Google+Shopify)
4. **Money streaming** — Continuous per-second payments
5. **Partner dashboard** — Full UI for managing accounts, agents, and payments

### Strategic Positioning

> **"We don't care which protocol wins. Sly makes them all work."**

Four agentic payment protocols are now active (x402, AP2, ACP, UCP). Sly is the **only settlement layer** that:
- Supports all four protocols
- Has native LATAM rails (Pix/SPEI via Circle)
- Enables partners rather than competing with them

### Implementation Phases

| Phase | Focus | External Services | Timeline |
|-------|-------|-------------------|----------|
| **Phase 1** | Full PoC with mocked externals | Supabase only | ✅ Complete |
| **Phase 1.5** | AI visibility & demo polish | Supabase only | ✅ Complete |
| **Phase 2** | PSP table stakes (refunds, disputes, exports) | Supabase only | ✅ Complete |
| **Phase 3** | Multi-protocol infrastructure (x402, AP2, ACP) | Supabase + Protocol APIs | ✅ Complete (Dec 28) |
| **Phase 3.5** | External sandbox integrations | + Circle, Coinbase, Google, Stripe | Current |
| **Phase 4** | Customer validation (parallel tracks) | + First customers | Next |
| **Phase 5** | Production hardening & scale | Settlement infrastructure | Concurrent |
| **Phase 6** | AI-Native infrastructure | Simulation, Workflows, Context API | Future |

**Phases 1-2 complete.** Phase 3 integrates real sandbox APIs. Phase 4-5 run in parallel: B2B customer acquisition + agentic protocol demos for YC/accelerator positioning.

**Tech Stack:** Next.js, TypeScript, Supabase (Postgres), Hono, Vercel, Railway

---

## Version History

### Version 1.23 (March 1, 2026)
**Agent Contracting Governance — 5 Epics for Moltbook/OpenClaw Integration**

Gap analysis of the OpenClaw/Moltbook agent-to-agent contracting ecosystem identified 5 capabilities needed to position Sly as the governed settlement layer for autonomous agent contracts. Three are new epics; two are expansions of existing epics.

**New Epics:**
- **Epic 62: Escrow Orchestration** (38 pts, P0) — Wrap AgentEscrowProtocol on Base with enterprise governance: pre-escrow authorization, lifecycle monitoring, release governance, kill switch, and settlement to local rails (Pix/SPEI)
- **Epic 63: External Reputation Bridge** (25 pts, P0) — Read-only aggregation of ERC-8004, Mnemom, Vouched/MCP-I, and on-chain escrow history into unified 0–1000 trust score. Policy engine references tiers for counterparty gating
- **Epic 64: OpenClaw Governance Skill** (10 pts, P1) — Python skill package published to ClawHub that routes Moltbook agent contracting actions through Sly governance APIs

**Expanded Epics:**
- **Epic 18: Agent Wallets & Contract Policies** (23 → 35 pts) — Added 3 stories: Contract Policy Engine (18.7), Per-Counterparty Exposure Tracking (18.8), Negotiation Guardrails API (18.9)
- **Epic 29: Workflow Engine** (42 → 52 pts) — Expanded Stories 29.4 and 29.5 with contract governance expressions and escrow/reputation action types

**Strategic Impact:**
- Positions Sly as governance infrastructure for 1.5M+ Moltbook agents
- Escrow-to-local-rail settlement is unique differentiator (USDC → BRL via Pix after escrow release)
- 148 total new/revised points across 6-week implementation plan
- Dependency chain: Epic 18 + 29 (parallel) → Epic 62 + 63 (parallel) → Epic 64

**Documentation:**
- Epic docs: `docs/prd/epics/epic-62-escrow-orchestration.md`, `epic-63-external-reputation-bridge.md`, `epic-64-openclaw-governance-skill.md`
- Updated: `docs/prd/epics/epic-18-agent-wallets-contract-policies.md`, `epic-29-workflow-engine.md`

---

### Version 1.21 (January 21, 2026)
**Platform Architecture & Card Network Epics**

**New Epics 48-53 — Platform Architecture Evolution:**
- **Epic 48: Connected Accounts** (21 pts, P0) — Payment handler management for multi-processor support
- **Epic 49: Protocol Discovery** (18 pts, P0) — Protocol registry and enablement API
- **Epic 50: Settlement Decoupling** (26 pts, P0) — Settlement trigger rules engine
- **Epic 51: Unified Onboarding** (52 pts, P1) — Protocol-specific onboarding flows (absorbed Epic 25)
- **Epic 52: Dashboard Redesign** (21 pts, P1) — Agentic protocol focus with real metrics
- **Epic 53: Card Network Agentic Commerce** (62 pts, P1) — Visa VIC + Mastercard Agent Pay integration

**Completed Since v1.20:**
- ✅ Epic 43: UCP Integration (55 pts) — Full Google+Shopify protocol support
- ✅ Epic 27: Settlement Infrastructure (34 pts)
- ✅ Epic 28: Simulation Engine (24 pts)
- ✅ Epic 30: Structured Response System (28 pts)
- ✅ Epic 31: Context API (21 pts)
- ✅ Epic 36: SDK & Developer Experience (66 pts)

**Strategic Impact:**
- Sly now supports **ALL FOUR** agentic protocols: x402, AP2, ACP, UCP
- Platform architecture epics (48-50) enable true multi-protocol scaling
- Card network support (Epic 53) adds Visa VIC + Mastercard Agent Pay
- Total completed: ~497 points across 13 epics

**Documentation:**
- Updated Epic Dashboard with all 48-53 epics
- Architecture doc: `docs/architecture/three-layer-architecture.md`
- Epic docs: `docs/prd/epics/epic-48-53-*.md`

---

### Version 1.20 (January 15, 2026)
**UCP Protocol Integration — URGENT Strategic Priority**

**Epic 43: UCP (Universal Commerce Protocol)** (55 points, 14 stories) — **NEW P0:**
- Google+Shopify launched UCP on January 11, 2026 as THE industry standard for agentic commerce
- 20+ endorsements: Stripe, Visa, Mastercard, Walmart, Target, Shopify (1M+ merchants)
- UCP orchestrates existing protocols (AP2, MCP, A2A) rather than replacing them
- Sly to become a **UCP Payment Handler** (`com.sly.latam_settlement`)
- Stories include: Profile endpoint, capability negotiation, payment handler spec, SDK client

**Strategic Impact:**
- UCP validates Sly's multi-protocol strategy
- Not supporting UCP risks irrelevance in agentic commerce
- Sly can become THE LATAM settlement layer for entire UCP ecosystem

**Protocol Coverage Update:**
- x402 (Coinbase) — ✅ Full support
- AP2 (Google) — ✅ Full support
- ACP (Stripe/OpenAI) — ✅ Full support
- **UCP (Google+Shopify) — 🚧 Epic 43 (P0)**

**Documentation:**
- `docs/prd/epics/epic-43-ucp-integration.md`
- `docs/prd/investigations/ucp-integration.md`
- `docs/prd/epics/README.md` (updated with UCP)

**Placeholder Epics Created:**
- Epic 44: Observability & Monitoring (P2)
- Epic 45: Webhook Infrastructure (P2)
- Epic 46: Multi-Region & Disaster Recovery (P3)

---

### Version 1.19 (January 6, 2026)
**Epic 42 Complete & Epic 43: Cards Infrastructure — NEW**

**Epic 42 (65 points, 19 stories) — COMPLETE:**
- All 6 parts verified and deployed:
  1. ✅ Wallet Enhancements (dual balance, BYOW verification, Circle creation)
  2. ✅ Transfers with FX (calculator page, inline preview, settlement timeline)
  3. ✅ AP2 Mandate Actions (edit/cancel, VDC visualizer)
  4. ✅ Compliance Screening (screening tab, run screening action)
  5. ✅ Dashboard Home (aggregated balance, protocol stats, rate limit card)
  6. ✅ Real-Time Updates (live indicator, polling with toast notifications)

**Epic 43 (47 points, 12 stories) — NEW:**
- Virtual Debit Card infrastructure for AP2 mandates
- Card issuance, lifecycle management (activate/freeze/cancel)
- PCI-compliant secure card detail retrieval
- Spend controls (limits, MCC restrictions)
- Mock authorization flow for testing
- Wallet deposit API for sandbox testing

**API Feedback Addressed:**
- VDC stored in mandate metadata → Dedicated cards infrastructure (Epic 43)
- Wallet deposit missing → Added to Epic 43.12
- Rate limit headers hidden → Backlog ticket created
- Type definition sync → Backlog ticket created

**Supabase Performance Issues Fixed:**
- Fixed 50+ auth_rls_initplan warnings (wrapped auth.uid() in select)
- Fixed 80+ multiple_permissive_policies warnings (scoped service_all to service_role)
- Dropped duplicate index on settlement_holidays

**Documentation:**
- `docs/prd/epics/epic-43-cards-infrastructure.md`
- `docs/EPIC_42_WALKTHROUGH.md` (Gemini's verification)
- `docs/API_FEEDBACK.md` (Frontend integration feedback)

---

### Version 1.18 (January 5, 2026)
**Epic 40 Complete & Epic 42: Frontend Dashboard Integration — NEW**

**Epic 40 (86 points, 28 stories) — COMPLETE:**
- All external sandbox integrations working
- Circle Web3 Services for real blockchain balances
- Pix/SPEI payouts via Circle Payments
- x402.org facilitator integration
- Compliance screening (mock provider)
- Multi-currency FX quotes (USD↔BRL↔MXN)

**Epic 42 (65 points, 19 stories) — NEW:**
- Frontend integration with Epic 40 backend capabilities
- Dual balance display (ledger + on-chain)
- BYOW wallet verification with EIP-191 signatures
- FX Calculator page + inline transfer form preview
- Settlement timeline tab on transfer detail
- Compliance screening interface
- AP2 mandate actions (activate, suspend, revoke)

**Design Decisions:**
- Show both internal ledger and blockchain balances
- FX quotes in both dedicated page and inline in forms
- Settlement tracking as tab within transfer detail (not separate section)
- Compliance screening both on dedicated page and contextual buttons
- Mandate actions in both list view and detail page

**Documentation:**
- `docs/prd/epics/epic-42-frontend-dashboard.md`

---

### Version 1.17 (January 4-5, 2026)
**Epic 40: External Sandbox Integrations & Epic 41: On-Ramp Integrations — NEW**

**Epic 40 (86 points, 28 stories):**
- Connect Sly to all external sandbox environments
- Circle, Base Sepolia, x402, Stripe, AP2, compliance (mock)
- Critical x402 → Circle settlement bridge identified

**Epic 41 (89 points, 24 stories) — NEW:**
- On-ramp integrations for non-crypto-native customers
- Stripe (cards, ACH, SEPA), Plaid (US banks), Belvo (LATAM banks)
- MoonPay/Transak crypto widgets for direct card→USDC
- Pix/SPEI collection for Brazilian/Mexican funding
- Fiat→USDC conversion via Circle

**Key Insight:** Without on-ramps, Sly is limited to crypto-native customers (~5% of market). Epic 41 opens access to traditional fintechs.

**External Services Covered:**
- Stripe: Cards, ACH, SEPA, Connect
- Plaid: US bank linking, balance checks
- Belvo: LATAM banks (Brazil, Mexico, Colombia)
- MoonPay/Transak: Card→USDC widgets
- Circle: Fiat→USDC conversion

**Documentation:**
- `docs/prd/epics/epic-40-sandbox-integrations.md`
- `docs/prd/epics/epic-41-onramp-integrations.md`
- `docs/prd/IMPLEMENTATION_SEQUENCE.md` (updated)

---

### Version 1.16 (December 29, 2025)
**Epic Dashboard & Modular Structure:**

- **Reorganization:** Created Master PRD with Epic Dashboard tracking all 35 epics
- **Modular Documentation:** Epics 17, 18, 27, 28 extracted into dedicated docs
- **Status Tracking:** Foundation epics (1-16) archived as complete, active epics (17-35) tracked with points/stories
- **Quick Links:** Added navigation to epic docs, testing guides, and implementation summaries

---

### Version 1.15 (December 28, 2025)
**Epic 17: Multi-Protocol Gateway Infrastructure — COMPLETE ✅**

**Major Deliverables:**
- ✅ **12/12 stories completed** (53 points delivered in 2 days)
- ✅ **Multi-Protocol Foundation**: Data model with `protocol_metadata`, webhook delivery system, TypeScript types
- ✅ **x402 Protocol**: Full implementation with endpoints, verification, SDK, and dashboard
- ✅ **AP2 Protocol**: Complete mandate system with CRUD APIs, execution tracking, and analytics
- ✅ **ACP Protocol**: Full checkout system with cart management, multi-item support, and analytics
- ✅ **UI Implementation**: 8+ new pages, 2 analytics dashboards, date filters, pagination
- ✅ **Production Testing**: E2E tests passed, browser validation complete, live data verified

**Technical Highlights:**
- 4 database migrations with RLS policies
- 3 new API route modules (ap2.ts, acp.ts, agentic-payments.ts)
- Webhook infrastructure with exponential backoff and DLQ
- Cross-protocol analytics with unified metrics
- Full type safety with Zod validation schemas

**Impact:**
Sly is now the **only settlement infrastructure** supporting all three agentic payment protocols (x402, AP2, ACP) with native LATAM rails. Production-ready for sandbox integrations and customer demos.

**Documentation:**
- `docs/MULTI_PROTOCOL_COMPLETION_SUMMARY.md` (comprehensive session summary)
- `docs/AP2_UI_FIXES_COMPLETE.md` (UI implementation details)
- `docs/testing/AP2_TESTING_GUIDE.md` & `docs/testing/ACP_TESTING_GUIDE.md`

---

### Version 1.14 (December 27, 2025)
- Added AI-Native Infrastructure epics (28-35)
- Strategic context update with protocol landscape
- Settlement Infrastructure Hardening epic (27)
- Sandbox integration checklist

---

### Version 1.13 (December 27, 2025)

**EPIC 26 PHASE 2: JWT LOCAL VERIFICATION COMPLETE** ⚡

- **Epic 26: x402 Payment Performance Optimization** - Phase 2 ✅ COMPLETE
  - **Story 26.5:** JWT Payment Proofs ✅
    - API `/pay` endpoint returns JWT proof in response
    - Client SDK sends `X-Payment-JWT` header on retry
    - Provider SDK verifies JWT locally (no API call)
    - Provider verification: **140ms → 1ms** (99% reduction)
  - **Story 26.6:** Bloom Filter Idempotency ✅
    - In-memory Bloom filter (1M items, 1% FP rate)
    - Skip DB lookup for known-new requests
    - Idempotency check: **169ms → 0ms** (100% reduction)
  - **Story 26.7:** Endpoint Caching ✅
    - 60-second TTL for endpoint lookups
    - Cache hit reduces DB calls
    - Endpoint fetch: **166ms → 148ms** (cache hit)

**MULTI-PROTOCOL STRATEGY & SETTLEMENT-AS-A-SERVICE ARCHITECTURE:**

- **Strategic Context Added:**
  - Agentic payments landscape (x402, AP2, ACP)
  - Sly market position as multi-protocol settlement layer
  - Revenue model with 9 revenue streams
  - Competitive landscape analysis
  - Regulatory requirements (Brazil Nov 2025, Mexico)
  - Go-to-market strategy with parallel tracks

- **Implementation Schedule Restructured:**
  - Phase 3: External integrations (Circle, Coinbase, Stripe, Google AP2)
  - Phase 4: Customer validation with parallel tracks
    - Track A: B2B payout customer acquisition
    - Track B: Agentic protocol demos for YC
  - Phase 5: Multi-protocol production
  - Phase 6: Settlement hardening & scale

- **New Epic 27: Settlement Infrastructure Hardening** (29 pts)

---

## Epic Dashboard

### Foundation Epics (Phase 1-2) - ARCHIVED

| Epic | Name | Phase | Priority | Status | Points | Stories | Doc |
|------|------|-------|----------|--------|--------|---------|-----|
| 1 | Foundation & Multi-Tenancy | 1 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-01-foundation.md) |
| 2 | Account System | 1 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-02-accounts.md) |
| 3 | Agent System & KYA | 1 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-03-agents.md) |
| 4 | Transfers & Payments | 1 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-04-transfers.md) |
| 5 | Money Streaming | 1 | P1 | ✅ Complete | — | — | [Archive](./archive/epic-05-streaming.md) |
| 6 | Reports & Documents | 1 | P1 | ✅ Complete | — | — | [Archive](./archive/epic-06-reports.md) |
| 7 | Dashboard UI | 1 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-07-dashboard.md) |
| 8 | AI Visibility & Agent Intelligence | 1.5 | P1 | ✅ Complete | — | — | [Archive](./archive/epic-08-ai-visibility.md) |
| 9 | Demo Polish & Missing Features | 1.5 | P2 | ✅ Complete | — | — | [Archive](./archive/epic-09-demo-polish.md) |
| 10 | PSP Table Stakes Features | 2 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-10-psp-features.md) |
| 11 | Authentication & User Management | 2 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-11-auth.md) |
| 12 | Client-Side Caching & Data Management | 2 | P1 | ✅ Complete | — | — | [Archive](./archive/epic-12-caching.md) |
| 13 | Advanced Authentication & Security | 2 | P1 | ✅ Complete | — | — | [Archive](./archive/epic-13-advanced-auth.md) |
| 14 | Compliance & Dispute Management APIs | 2 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-14-compliance.md) |
| 15 | Row-Level Security Hardening | 2 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-15-rls.md) |
| 16 | Database Function Security & Performance | 2 | P0 | ✅ Complete | — | — | [Archive](./archive/epic-16-db-security.md) |

### Active/Future Epics

| Epic | Name | Phase | Priority | Status | Points | Stories | Doc |
|------|------|-------|----------|--------|--------|---------|-----|
| 17 | Multi-Protocol Gateway 🔌 | 3 | P1 | ✅ Complete | 53 | 12/12 | [View](./epics/epic-17-multi-protocol.md) |
| 18 | Agent Wallets & Contract Policies 🤖 | 5.2 | P0 | 📋 Pending | 35 | 0/9 | [View](./epics/epic-18-agent-wallets-contract-policies.md) |
| 19 | Sly x402 Services 🍾 | 3.5 | P2 | 📋 Pending | 22 | 0/5 | — |
| 20 | Streaming Payments & Agent Registry 🌊 | 3.5 | P2 | 📋 Pending | 18 | 0/5 | — |
| 21 | Code Coverage Improvement 📊 | — | P3 | 📋 Pending | 112 | 0/13 | — |
| 22 | Seed Data & Final UI Integration 🌱 | — | P2 | ✅ Complete | 21 | 6/6 | — |
| 23 | Dashboard Performance & API Optimization 🚀 | — | P1 | ✅ Complete | 18 | 7/7 | — |
| 24 | Enhanced API Key Security 🔐 | — | P2 | 📋 Pending | 28 | 0/7 | — |
| ~~25~~ | ~~User Onboarding~~ | — | — | → Absorbed into Epic 51 | — | — | — |
| 26 | x402 Payment Performance Optimization ⚡ | — | P1 | ✅ Complete (Phase 3 → Epic 38) | 13 | 6/7 | [View](./epics/epic-26-x402-performance.md) |
| 27 | Settlement Infrastructure Hardening 🏗️ | 5 | P1 | ✅ Complete | 34 | 8/8 | [View](./epics/epic-27-settlement.md) |
| 28 | Simulation Engine 🔮 | 6 | P0 | ✅ Complete | 24 | 8/8 | [View](./epics/epic-28-simulation.md) |
| 29 | Workflow Engine ⚙️ | 6 | P0 | 📋 Pending | 52 | 0/11 | [View](./epics/epic-29-workflow-engine.md) |
| 30 | Structured Response System 📋 | 6 | P0 | ✅ Complete | 28 | 8/8 | [View](./epics/epic-30-structured-response.md) |
| 31 | Context API 🔍 | 6 | P0 | ✅ Complete | 21 | 5/5 | [View](./epics/epic-31-context-api.md) |
| 32 | Tool Discovery 🧭 | 6 | P0 | 📋 Pending | 11 | 0/4 | [View](./epics/epic-32-tool-discovery.md) |
| 33 | Metadata Schema 🏷️ | 6 | P1 | 📋 Pending | 11 | 0/4 | [View](./epics/epic-33-metadata-schema.md) |
| 34 | Transaction Decomposition 📦 | 6 | P1 | 📋 Pending | 14 | 0/4 | [View](./epics/epic-34-transaction-decomposition.md) |
| 35 | Entity Onboarding API 🚀 | 6 | P1 | 📋 Pending | 14 | 0/4 | [View](./epics/epic-35-entity-onboarding.md) |
| 36 | SDK & Developer Experience 🧰 | 3.5 | P0 | ✅ Complete | 66 | 17/17 | [View](./epics/epic-36-sdk-developer-experience.md) |
| 40 | External Sandbox Integrations 🔌 | 3.5 | P0 | ✅ Complete | ~100 | 28/28 | [View](./epics/epic-40-sandbox-integrations.md) |
| 41 | On-Ramp Integrations 💳 | 3.5 | P1 | 📋 Pending | 110 | 0/29 | [View](./epics/epic-41-onramp-integrations.md) |
| 42 | Frontend Dashboard Integration 🖥️ | 3.5 | P0 | ✅ Complete | 65 | 19/19 | [View](./epics/epic-42-frontend-dashboard.md) |
| 43 | UCP (Universal Commerce Protocol) 🌐 | 3.5 | P0 | ✅ Complete | 55 | 14/14 | [View](./epics/epic-43-ucp-integration.md) |
| 43a | Cards Infrastructure & VDC 💳 | 3.5 | P2 | 📋 Backlog | 47 | 0/12 | [View](./epics/epic-43-cards-infrastructure.md) |
| 44 | Observability & Monitoring 📊 | 5 | P2 | 📋 Placeholder | ~40 | 0/TBD | [View](./epics/epic-44-observability.md) |
| 45 | Webhook Infrastructure 🔔 | 5 | P2 | 📋 Placeholder | ~35 | 0/TBD | [View](./epics/epic-45-webhook-infrastructure.md) |
| 46 | Multi-Region & DR 🌍 | 5 | P3 | 📋 Placeholder | ~60 | 0/TBD | [View](./epics/epic-46-disaster-recovery.md) |
| 47 | UCP Merchant Gateway 🏪 | 4 | P2 | 📋 Backlog | 89 | 0/22 | [View](./epics/epic-47-ucp-merchant-gateway.md) |
| **48** | **Connected Accounts 🔌** | **4** | **P0** | **🚧 Current** | **21** | **0/6** | **[View](./epics/epic-48-connected-accounts.md)** |
| **49** | **Protocol Discovery 🧭** | **4** | **P0** | **🚧 Current** | **18** | **0/5** | **[View](./epics/epic-49-protocol-discovery.md)** |
| **50** | **Settlement Decoupling ⚙️** | **4** | **P0** | **🚧 Current** | **26** | **0/7** | **[View](./epics/epic-50-settlement-decoupling.md)** |
| **51** | **Unified Onboarding 🚀** | **4** | **P1** | **📋 Next** | **52** | **0/14** | **[View](./epics/epic-51-unified-onboarding.md)** |
| **52** | **Dashboard Redesign 📊** | **4** | **P1** | **📋 Next** | **21** | **0/6** | **[View](./epics/epic-52-dashboard-redesign.md)** |
| **53** | **Card Network Agentic Commerce 💳** | **4** | **P1** | **📋 Next** | **62** | **0/11** | **[View](./epics/epic-53-card-network-agentic-commerce.md)** |
| **57** | **Google A2A Protocol Integration 🤝** | **5.2** | **P0** | **✅ Complete** | **89** | **14/14** | **[View](./epics/epic-57-google-a2a-protocol.md)** |
| **58** | **A2A Task Processor Worker 🧠** | **5.2** | **P0** | **📋 Planned** | **119** | **0/18** | **[View](./epics/epic-58-a2a-task-processor.md)** |
| **59** | **User Onboarding, SSO & Agent Self-Registration 🔐** | **3.5** | **P0** | **✅ Complete** | **69** | **16/16** | **[View](./epics/epic-59-user-onboarding-sso-agent-signup.md)** |
| **60** | **A2A Agent Onboarding Skills 🎫** | **5.2** | **P0** | **✅ Complete** | **28** | **8/8** | **[View](./epics/epic-60-a2a-agent-onboarding-skills.md)** |
| **61** | **Agent Wallet Identity & Verification 🔗** | **5.2** | **P2** | **📋 Planned** | **TBD** | **0/TBD** | **[View](./epics/epic-61-agent-wallet-identity.md)** |
| **62** | **Escrow Orchestration 🔐** | **5.3** | **P0** | **📋 Planned** | **38** | **0/9** | **[View](./epics/epic-62-escrow-orchestration.md)** |
| **63** | **External Reputation Bridge 🛡️** | **5.3** | **P0** | **📋 Planned** | **25** | **0/7** | **[View](./epics/epic-63-external-reputation-bridge.md)** |
| **64** | **OpenClaw Governance Skill 🧩** | **5.4** | **P1** | **📋 Planned** | **10** | **0/4** | **[View](./epics/epic-64-openclaw-governance-skill.md)** |
| **38** | **High-Frequency Microtransaction Optimization ⚡** | **5** | **P1** | **📋 Planned** | **63** | **0/18** | **[View](./epics/epic-38-payment-optimized-chains.md)** |

**Summary:**
- **Foundation Complete:** Epics 1-16 (Phase 1-2) fully implemented
- **Protocol Infrastructure Complete:** Epic 17 (Multi-Protocol), Epic 43 (UCP), Epic 36 (SDK)
- **AI-Native Complete:** Epic 28 (Simulation), Epic 30 (Structured Response), Epic 31 (Context API)
- **🚧 Current Focus (P0):** Epics 48-50 — Platform architecture for multi-protocol scaling
  - Epic 48: Connected Accounts (payment handler management)
  - Epic 49: Protocol Discovery (protocol registry & enablement)
  - Epic 50: Settlement Decoupling (settlement trigger rules)
- **📋 Next (P1):** Epics 51-53 — Onboarding, Dashboard, Card Networks
  - Epic 51: Unified Onboarding (protocol-specific flows)
  - Epic 52: Dashboard Redesign (agentic protocol focus)
  - Epic 53: Card Network Agentic Commerce (Visa VIC + Mastercard Agent Pay)
- **📋 Agent Contracting Governance (NEW):** Epics 18, 29, 62-64 — 148 points
  - Epic 18: Agent Wallets & Contract Policies (35 pts, expanded)
  - Epic 29: Workflow Engine (52 pts, expanded)
  - Epic 62: Escrow Orchestration (38 pts, new)
  - Epic 63: External Reputation Bridge (25 pts, new)
  - Epic 64: OpenClaw Governance Skill (10 pts, new)
- **Total Completed:** ~497 points across 13 epics
- **Current Focus:** ~65 points (Epics 48-50)
- **Next Priority:** ~135 points (Epics 51-53)
- **Agent Contracting:** ~148 points (Epics 18, 29, 62-64)
- **AI-Native Remaining:** Epic 32 (Tool Discovery)
- **Production Hardening:** Epics 44-46 (Observability, Webhooks, DR) — placeholders for scale phase

---

## Strategic Context

### The Agentic Payments Landscape (January 2026)

Four major protocols have emerged for AI agent payments:

| Protocol | Owner | Focus | Settlement Method | Status |
|----------|-------|-------|-------------------|--------|
| **x402** | Coinbase/Cloudflare | Micropayments, API monetization | Stablecoin (USDC on Base) | Production |
| **AP2** | Google (60+ partners) | Agent authorization, mandates | Multi-rail (cards, banks, x402) | Production |
| **ACP** | Stripe/OpenAI | Consumer checkout, e-commerce | SharedPaymentToken | Production |
| **UCP** | Google+Shopify (20+ partners) | Full commerce lifecycle | Multi-handler (AP2, cards, wallets) | **NEW** (Jan 11, 2026) |

**Key Insight:** UCP is a **superset** protocol that orchestrates x402/AP2/ACP rather than replacing them. It defines the full shopping journey (Discovery → Checkout → Order → Post-purchase) and supports multiple transports (REST, MCP, A2A). Sly's multi-protocol strategy is validated—we're the settlement layer, not picking winners.

**UCP Ecosystem Impact:**
- Google AI Mode and Gemini will use UCP for shopping agents
- Shopify's 1M+ merchants will support UCP natively
- Sly can become a **UCP Payment Handler** for LATAM settlement
- AP2 mandates work inside UCP via the `dev.ucp.shopping.ap2_mandate` extension

### Sly Market Position

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PARTNER APPLICATIONS                             │
│  Remittance App   Payroll Platform   Shopping Agent   Procurement AI    │
└───────┬───────────────┬──────────────────┬───────────────┬──────────────┘
        │               │                  │               │
        └───────────────┴────────┬─────────┴───────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      Sly SETTLEMENT-AS-A-SERVICE                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   Protocol  │  │  Execution  │  │  Treasury   │  │ Compliance  │    │
│  │ Orchestrator│  │   Engine    │  │  & Float    │  │  & KYC      │    │
│  │x402/AP2/ACP/UCP│  │             │  │             │  │             │    │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘    │
└────────────────────────────────┬────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         SETTLEMENT RAILS                                │
│    Circle USDC     │     Pix (Brazil)    │    SPEI (Mexico)            │
│    Base Chain      │     BCB Real-time   │    Banxico Real-time        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Revenue Model

### Transaction Revenue

| Stream | Mechanism | Take Rate | Notes |
|--------|-----------|-----------|-------|
| **Fiat Offramp** (35% of volume) | Settlement fee + FX spread | 0.65% + 0.35% | Only ~35% of B2B stablecoin payments convert to fiat |
| **Stablecoin Protocol Fees** | Gateway + routing | 0.15% + 0.10% | x402/AP2/ACP/UCP protocol handling |
| **Internal Transfers** | Ledger movements | 0.05% | Between accounts on platform |

### Platform Revenue

| Stream | Pricing | Target Customers |
|--------|---------|------------------|
| **Yield on Float** | 6% APY on 5-day average | All partners |
| **Compliance API** | $0.02/check | High-volume partners |
| **FX Intelligence** | $500/partner/month | Treasury-focused |
| **Treasury Dashboard** | $449/partner/month | Enterprise |
| **Escrow Services** | 0.5% on escrowed volume | B2B procurement |
| **Agent Wallet Fees** | $0.05/wallet/month | Agentic platforms |
| **White-label Licensing** | $10K/month | Enterprise |

### Target Milestones

| Milestone | Monthly TPV | Partners | Timeline |
|-----------|-------------|----------|----------|
| **$1M ARR** | $5.5M | ~26 | 18-24 months |
| **$10M ARR** | $50M | ~100 | 36 months |
| **$50M ARR** | $270M | ~300 | 48 months |

---

## Competitive Landscape

### Direct Competitors

| Company | Funding | Focus | Revenue Model | What They Don't Do |
|---------|---------|-------|---------------|--------------------|
| **Crossmint** | $23.6M | Multi-protocol wallets | Subscription + per-tx | No LATAM rails, competes with partners |
| **Skyfire** | $9.5M | Agent identity (KYA) | 2-3% per transaction | No settlement, no white-label |
| **Gr4vy** | ~$30M | Payment orchestration | SaaS + revenue share | Not stablecoin-native, no LATAM |
| **Kite** | $33M | L1 for agent payments | Chain fees | No local rails integration |
| **Natural** | $9.8M | B2B agentic workflows | Enterprise SaaS | No LATAM focus |

### Sly Differentiation

1. **Multi-protocol** — Not betting on one winner (x402 vs AP2 vs ACP)
2. **Native LATAM settlement** — Circle's Pix/SPEI = 12-month head start
3. **Partner-enabling** — White-label infrastructure, don't compete
4. **Both B2B and agentic** — Revenue today, positioned for tomorrow

---

## Regulatory Requirements

### Brazil (New Nov 2025 Regulations)

| Requirement | Details |
|-------------|--------|
| **License** | SPSAV (Sociedade Prestadora de Serviços de Ativos Virtuais) |
| **Effective** | February 2, 2026 |
| **Capital** | $2-7M depending on activity |
| **Stablecoin Treatment** | FX transactions under BCB supervision |
| **Transaction Cap** | $100K for unauthorized counterparties |
| **Foreign Firms** | Must have local subsidiary OR partner with licensed entity |
| **Reporting** | Monthly to BCB starting May 4, 2026 |

### Mexico

| Requirement | Details |
|-------------|--------|
| **License** | ITF (Institución de Tecnología Financiera) under Fintech Law (2018) |
| **Regulator** | CNBV (authorization), Banxico (operations) |
| **Capital** | ~$500K USD equivalent |
| **Stablecoin Status** | Not classified as virtual assets (treated as currency) |
| **Local Presence** | Required for direct operations |

### Recommended Licensing Path

| Phase | Approach | Timeline | Cost |
|-------|----------|----------|------|
| **Phase 1** (Now) | Pure SaaS — partners bring Circle accounts | Immediate | $0 |
| **Phase 2** (Post-PMF) | API agent model — registration as tech provider | 3-6 months | ~$50K |
| **Phase 3** (Scale) | Own licenses in key markets | 18-24 months | $2-7M Brazil, ~$500K Mexico |

---

## Go-to-Market Strategy

### Phase 0: Validate (Weeks 1-2)

- **Target:** Companies moving $500K+/month to LATAM
- **Method:** 10 customer discovery calls
- **Goal:** Find 3 who'd pay today
- **Channels:** Warm outreach, LinkedIn, fintech communities

### Phase 1: Concierge MVP (Weeks 3-6)

- Manual approval + Circle API execution
- Prove the flow works end-to-end
- Document pain points and friction

### Phase 2: First Paying Customer (Weeks 7-10)

- 90-day pilot at 1.5% (vs their current 4-5%)
- Build case study with real metrics
- Target: >99% payout success rate

### Phase 3: Scale (Months 4-12)

- Customers 2-5 via referral/network
- Systematize onboarding
- Build self-serve dashboard

### Customer Validation Questions

| What They Say | What It Means | Response |
|---------------|---------------|----------|
| "Exploring x402" | Curious, no budget | Call when ready to build |
| "Want to monetize API" | Real need, might pay | Discuss current revenue model |
| "Agents need to pay suppliers" | Potential fit | Walk through specific transaction |
| "Building AI assistant that buys" | Interesting but early | When launch? What volume? |

**The Filter:** Are they spending/collecting money TODAY or is this future project?

---

## AI-Native Infrastructure

> **Design Philosophy:** Build horizontal primitives that compose into solutions, not vertical features for specific industries.

### Why AI-Native Matters

Sly's Identity 3 positioning as "AI-Native Settlement OS" requires infrastructure that AI agents can actually use. This means:

1. **Machine-parseable responses** — Agents can't interpret "Something went wrong"
2. **Simulation before execution** — Agents must reason about outcomes
3. **Composable workflows** — Same primitives serve procurement, batch payments, compliance
4. **Capability discovery** — Agent platforms need to understand what Sly can do

### Composable Primitives Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              PARTNER APPLICATIONS                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐            │
│  │ Procurement  │ │   Payroll    │ │  Accounting  │ │  CS/Support  │            │
│  │    Agent     │ │   Platform   │ │   Software   │ │    Agent     │            │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                        TOOL DISCOVERY (Epic 32)                                  │
│         "What can Sly do?" → Capabilities, schemas, limits                     │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           AI-NATIVE LAYER                                        │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                     STRUCTURED RESPONSES (Epic 30)                       │    │
│  │    Machine-parseable errors │ Suggested actions │ Retry guidance         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                      SIMULATION ENGINE (Epic 28)                         │    │
│  │         Dry-run any action │ Preview outcomes │ Validate batches         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                       WORKFLOW ENGINE (Epic 29)                          │    │
│  │    Approval chains │ Conditional logic │ Multi-step processes            │    │
│  │    ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐          │    │
│  │    │  Approval  │ │ Condition  │ │   Action   │ │   Wait     │          │    │
│  │    │    Step    │ │    Step    │ │    Step    │ │   Step     │          │    │
│  │    └────────────┘ └────────────┘ └────────────┘ └────────────┘          │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │                        CONTEXT API (Epic 31)                             │    │
│  │      "Tell me everything about X" │ Account │ Transfer │ Agent           │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          DATA ENRICHMENT LAYER                                   │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐              │
│  │   METADATA SCHEMA │ │    TRANSACTION    │ │      ENTITY       │              │
│  │     (Epic 33)     │ │   DECOMPOSITION   │ │    ONBOARDING     │              │
│  │  Custom fields    │ │     (Epic 34)     │ │     (Epic 35)     │              │
│  │  GL codes, PO#s   │ │  Line items       │ │  Single-call      │              │
│  └───────────────────┘ │  Partial refunds  │ │  vendor setup     │              │
│                        └───────────────────┘ └───────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          CORE SETTLEMENT LAYER                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │  Protocol   │  │  Execution  │  │  Treasury   │  │ Compliance  │            │
│  │ Orchestrator│  │   Engine    │  │  & Float    │  │  & KYC/KYA  │            │
│  │x402/AP2/ACP/UCP│  │             │  │             │  │             │            │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              SETTLEMENT RAILS                                    │
│      Circle USDC      │      Pix (Brazil)      │      SPEI (Mexico)             │
│       Base Chain      │    BCB Real-time       │    Banxico Real-time           │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### How Primitives Compose

| Scenario | Primitives Used | Flow |
|----------|-----------------|------|
| **Procurement approval** | Simulation → Workflow → Metadata | Simulate payment → Approval chain → Execute with PO# |
| **Batch payroll** | Simulation → Workflow → Decomposition | Simulate batch → HR + Finance approval → Track per-employee |
| **CS partial refund** | Context → Decomposition → Simulation | Get account context → Select line items → Preview refund |
| **Agent integration** | Discovery → Simulation → Structured | Discover capabilities → Dry-run action → Parse response |

### AI-Native Epics Summary

| Epic | Name | Points | Priority | Status |
|------|------|--------|----------|--------|
| 28 | Simulation Engine 🔮 | 24 | P0 | ✅ Complete |
| 29 | Workflow Engine ⚙️ | 52 | P0/P1 | Pending |
| 30 | Structured Response System 📋 | 26 | P0 | ✅ Complete |
| 31 | Context API 🔍 | 16 | P0 | ✅ Complete |
| 32 | Tool Discovery 🧭 | 11 | P0 | Pending |
| 33 | Metadata Schema 🏷️ | 11 | P1 | Pending |
| 34 | Transaction Decomposition 📦 | 14 | P1 | Pending |
| 35 | Entity Onboarding API 🚀 | 14 | P1 | Pending |
| **TOTAL** | | **168** | | **3/8 Complete** |

---

### Agent Contracting Governance

> **Design Philosophy:** Sly governs agent contracts — we don't become a marketplace, reputation provider, or escrow protocol. We wrap existing infrastructure with enterprise-grade governance, audit trails, and last-mile settlement.

#### Why Agent Contracting Matters

The OpenClaw/Moltbook ecosystem (140K+ GitHub stars, 1.5M+ agents) enables autonomous agent-to-agent contracting on platforms like m/hire and ClaWork. These agents negotiate, sign contracts, lock escrow, and settle payment — all autonomously. But enterprises deploying agents on Moltbook have no governance:

- No spending limits per counterparty
- No approval workflows for large contracts
- No reputation verification before committing funds
- No kill switch when things go wrong
- No settlement to local banking rails after escrow release

Sly fills this gap as the **governed settlement layer** that enterprises install between their agents and the contracting ecosystem.

#### Agent Contracting Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    MOLTBOOK / OPENCLAW ECOSYSTEM                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │   m/hire     │  │  ClaWork    │  │  A2A Tasks  │                 │
│  │  Job Board   │  │  Contracts  │  │  (Epic 57)  │                 │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘                 │
└─────────┼─────────────────┼────────────────┼────────────────────────┘
          │                 │                │
          ▼                 ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│              SLY GOVERNANCE LAYER (Epics 18, 29, 62-64)             │
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              OpenClaw Governance Skill (Epic 64)               │  │
│  │   Contract Discovery → Negotiation → Escrow → Settlement      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                │                                     │
│  ┌──────────────────┐  ┌──────┴───────────┐  ┌──────────────────┐  │
│  │  Contract Policy  │  │     Workflow     │  │    Reputation    │  │
│  │  Engine (Epic 18) │  │  Engine (Epic 29)│  │  Bridge (Epic 63)│  │
│  │  Per-counterparty │  │  Approval chains │  │  ERC-8004        │  │
│  │  limits, type     │  │  Condition logic │  │  Mnemom          │  │
│  │  restrictions,    │  │  Timeout/escalate│  │  Vouched/MCP-I   │  │
│  │  reputation gate  │  │                  │  │  Escrow history  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                │                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              Escrow Orchestration (Epic 62)                    │  │
│  │  Pre-authorization → On-chain lock → Lifecycle monitor →      │  │
│  │  Release governance → Kill switch → Settlement to Pix/SPEI   │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         SETTLEMENT RAILS                             │
│    Circle USDC     │     Pix (Brazil)    │    SPEI (Mexico)         │
│    Base Chain      │     BCB Real-time   │    Banxico Real-time     │
└─────────────────────────────────────────────────────────────────────┘
```

#### Agent Contracting Epics Summary

| Epic | Name | Points | Priority | Status |
|------|------|--------|----------|--------|
| 18 | Agent Wallets & Contract Policies 🤖 | 35 | P0 | Pending |
| 29 | Workflow Engine ⚙️ | 52 | P0/P1 | Pending |
| 62 | Escrow Orchestration 🔐 | 38 | P0 | Planned |
| 63 | External Reputation Bridge 🛡️ | 25 | P0 | Planned |
| 64 | OpenClaw Governance Skill 🧩 | 10 | P1 | Planned |
| **TOTAL** | | **160** | | **0/5 Complete** |

#### Implementation Sequence

```
Sprint 1 (Weeks 1-2): Epic 18 P0 + Epic 29 P0 + Epic 63 core     ~43 pts
                       (wallets + policies + workflow core + ERC-8004)
    ↓
Sprint 2 (Weeks 3-4): Epic 18 P1 + Epic 29 P1 + Epic 63 rest     ~48 pts
                       + Epic 62 P0 (escrow foundation)
    ↓
Sprint 3 (Weeks 5-6): Epic 62 P1 + Epic 29 P2 + Epic 64          ~33 pts
                       (settlement + dashboard + OpenClaw skill)
```

---

## Sandbox Integration Checklist

### Required External Integrations

| Service | Purpose | Sandbox Available? | Cost | Integration Effort |
|---------|---------|-------------------|------|-------------------|
| **Circle** | USDC wallets, Pix/SPEI payouts | ✅ Yes | Free | Medium (2-3 days) |
| **Coinbase CDP** | x402 facilitator, Base chain | ✅ Yes | Free | Medium (2-3 days) |
| **Stripe** | ACP SharedPaymentToken | ✅ Yes (test mode) | Free | Low (1 day) |
| **Google AP2** | Mandate verification | ✅ Yes (samples) | Free | Medium (2-3 days) |
| **Base Sepolia** | Testnet for on-chain tx | ✅ Yes (faucet) | Free | Low (1 day) |
| **Chainalysis/Elliptic** | Compliance screening | ✅ Yes | Free tier | Low (1 day) |

### Circle Sandbox Checklist

```
[ ] Create Circle sandbox account (circle.com/developers)
[ ] Generate sandbox API keys
[ ] Store keys in environment variables:
    CIRCLE_API_KEY=xxx
    CIRCLE_API_URL=https://api-sandbox.circle.com
[ ] Create test USDC wallet
[ ] Test deposit flow (sandbox USDC)
[ ] Test Pix payout (Brazil sandbox)
[ ] Test SPEI payout (Mexico sandbox)
[ ] Implement webhook handler for status updates
[ ] Test FX quote flow (USD → BRL, USD → MXN)
```

### Coinbase/x402 Sandbox Checklist

```
[ ] Set up Base Sepolia wallet
[ ] Get testnet ETH from faucet (sepolia.base.org)
[ ] Get testnet USDC from faucet
[ ] Install x402 packages:
    npm install @x402/express-middleware @x402/client
[ ] Register test x402 endpoint
[ ] Execute test payment with @x402/client
[ ] Verify payment in dashboard
[ ] Connect offramp to Circle sandbox
```

### Google AP2 Sandbox Checklist

```
[ ] Clone AP2 reference: github.com/google-agentic-commerce/AP2
[ ] Set up Vertex AI or Google API key
[ ] Run sample scenarios locally:
    cd samples/python/scenarios/<scenario>
    bash run.sh
[ ] Implement mandate verification in Sly
[ ] Test IntentMandate → CartMandate → PaymentMandate flow
[ ] Verify A2A x402 extension for crypto payments
```

### Stripe ACP Sandbox Checklist

```
[ ] Enable Stripe test mode
[ ] Review ACP spec: agenticcommerce.dev
[ ] Implement checkout endpoints:
    POST /acp/checkout (CreateCheckoutRequest)
    PATCH /acp/checkout/:id (UpdateCheckoutRequest)
    POST /acp/checkout/:id/complete (CompleteCheckoutRequest)
    DELETE /acp/checkout/:id (CancelCheckoutRequest)
[ ] Integrate SharedPaymentToken handling
[ ] Test with Stripe test cards
[ ] Connect to Circle for LATAM settlement
```

### Integration Testing Scenarios

| Scenario | Protocol | Expected Flow |
|----------|----------|---------------|
| API micropayment | x402 | Agent pays 0.01 USDC → Provider receives → Offramp to Pix |
| Shopping agent | ACP | Checkout created → SPT received → Settlement to Brazil |
| Procurement | AP2 | Mandate verified → Payment executed → SPEI payout |
| Multi-protocol | All | Different protocols route to same settlement engine |

---

## Quick Links

### Epic Documentation
- **[Epic 62: Escrow Orchestration](./epics/epic-62-escrow-orchestration.md)** 📋 **Planned** — Agent contract escrow with governance
- **[Epic 63: External Reputation Bridge](./epics/epic-63-external-reputation-bridge.md)** 📋 **Planned** — Unified trust score from ERC-8004, Mnemom, Vouched
- **[Epic 64: OpenClaw Governance Skill](./epics/epic-64-openclaw-governance-skill.md)** 📋 **Planned** — ClawHub skill for governed contracting
- [Epic 18: Agent Wallets & Contract Policies](./epics/epic-18-agent-wallets-contract-policies.md) 📋 Pending — Expanded for contracting governance
- [Epic 43: UCP Integration](./epics/epic-43-ucp-integration.md) ✅ Complete — Google+Shopify protocol
- [Epic 47: UCP Merchant Gateway](./epics/epic-47-ucp-merchant-gateway.md) 📋 Backlog — Non-Shopify merchant support
- [Epic 17: Multi-Protocol Gateway](./epics/epic-17-multi-protocol.md) ✅ Complete
- [Epic 27: Settlement Hardening](./epics/epic-27-settlement.md) ✅ Complete
- [Epic 29: Workflow Engine](./epics/epic-29-workflow-engine.md) 📋 Pending — Expanded for contract governance

### Investigations
- **[UCP Integration Investigation](./investigations/ucp-integration.md)** — Full protocol analysis

### Testing & Guides
- [AP2 Testing Guide](/docs/testing/AP2_TESTING_GUIDE.md)
- [ACP Testing Guide](/docs/testing/ACP_TESTING_GUIDE.md)
- [X402 Gemini Testing Guide](/docs/X402_GEMINI_TESTING_GUIDE.md)
- [Gemini Start Here](/docs/GEMINI_START_HERE.md)

### Implementation Docs
- [Multi-Protocol Completion Summary](/docs/MULTI_PROTOCOL_COMPLETION_SUMMARY.md)
- [AP2 UI Fixes Complete](/docs/AP2_UI_FIXES_COMPLETE.md)
- [Settlement Bug Fix](/docs/SETTLEMENT_BUG_FIX.md)

### API & Architecture
- [CLAUDE.md](/CLAUDE.md) - Development guide
- [API Routes](/apps/api/src/routes/)
- [Database Migrations](/apps/api/supabase/migrations/)

---

## Navigation

- **For Implementation Details:** See individual epic docs in `/docs/prd/epics/`
- **For Testing:** See testing guides in `/docs/testing/`
- **For Development:** See [CLAUDE.md](/CLAUDE.md)
- **For Completion Summaries:** See implementation docs in `/docs/`
