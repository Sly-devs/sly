# PayOS PRD Epics

This directory contains individual epic files extracted from the master PRD for easier navigation and tracking.

---

## Templates & Guidelines

### SDK Impact Assessment (Required for Every Epic)

Every epic MUST include an SDK Impact Assessment section near the top:

```markdown
## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/foo` | ✅ Yes | `payos.foo` | P0 | New module needed |
| `GET /v1/bar/:id` | ✅ Yes | `payos.bar` | P1 | Add to existing |
| Internal refactor | ❌ No | - | - | No API changes |
| Admin-only endpoint | ❌ No | - | - | Not for partners |
| New webhook event | ⚠️ Types | Types only | P2 | Add TypeScript types |

**SDK Stories Required:** 
- [ ] Story 36.X: Add `foo` module to @sly/sdk
- [ ] Story 36.Y: Update MCP server with `payos_foo` tool
```

### Definition of Done (DoD)

Every story must meet these criteria before completion:

- [ ] Code reviewed and merged
- [ ] Tests passing (unit + integration where applicable)
- [ ] Documentation updated (if user-facing)
- [ ] **SDK GATE:**
  - [ ] SDK exposure decision documented in story
  - [ ] If SDK exposure needed: Story created/updated in Epic 36
  - [ ] If SDK exposure NOT needed: Reason documented

---

## Epic Files

### Foundation & Infrastructure
- [Epic 17: Multi-Protocol Foundation](./epic-17-multi-protocol.md) ✅ - Multi-protocol payment foundation
- [Epic 18: Agent Wallets & Contract Policies](./epic-18-agent-wallets-contract-policies.md) - Agent wallets, spending policies, and contract governance
- [Epic 27: Settlement System](./epic-27-settlement.md) ✅ - Settlement infrastructure

### x402 & Performance
- [Epic 19: PayOS x402 Services](./epic-19-x402-services.md) 🍾 - PayOS-hosted x402 services
- [Epic 26: x402 Payment Performance Optimization](./epic-26-x402-performance.md) ⚡ ✅ - PHASE 1 & 2 COMPLETE

### Streaming & Registry
- [Epic 20: Streaming Payments & Agent Registry](./epic-20-streaming-payments.md) 🌊 - Streaming payments + Agent Identity

### Developer Experience & SDK
- [Epic 36: SDK & Developer Experience](./epic-36-sdk-developer-experience.md) 🛠️ ✅ - Unified @sly/sdk with x402/AP2/ACP support

### Quality & Operations
- [Epic 21: Code Coverage Improvement](./epic-21-code-coverage.md) 📊 - Improve test coverage to 70%+
- [Epic 22: Seed Data & Final UI Integration](./epic-22-seed-data.md) 🌱 ✅ - COMPLETE
- [Epic 23: Dashboard Performance & API Optimization](./epic-23-dashboard-performance.md) 🚀 ✅ - COMPLETE

### Security & Onboarding
- [Epic 24: Enhanced API Key Security](./epic-24-api-key-security.md) 🔐 - Agent-specific API keys
- ~~[Epic 25: User Onboarding](./epic-25-user-onboarding.md)~~ → **Absorbed into Epic 51**
- [Epic 59: User Onboarding, SSO & Agent Self-Registration](./epic-59-user-onboarding-sso-agent-signup.md) ✅ - Fix signup, team invites, Google/GitHub SSO, autonomous agent registration

### AI-Native Architecture
- [Epic 28: Simulation API](./epic-28-simulation.md) 🔮 ✅ - Transaction simulation
- [Epic 29: Workflow Engine](./epic-29-workflow-engine.md) ⚙️ - Multi-step workflows + Agentic Composition
- [Epic 30: Structured Response System](./epic-30-structured-response.md) 📋 ✅ - Machine-readable API responses
- [Epic 31: Context API](./epic-31-context-api.md) 🔍 ✅ - Comprehensive context queries
- [Epic 32: Tool Discovery](./epic-32-tool-discovery.md) 🧭 - Capability catalog for agents
- [Epic 33: Metadata Schema](./epic-33-metadata-schema.md) 🏷️ - Custom field definitions
- [Epic 34: Transaction Decomposition](./epic-34-transaction-decomposition.md) 📦 - Line-item level operations
- [Epic 35: Entity Onboarding API](./epic-35-entity-onboarding.md) 🚀 - Single-call onboarding

### External Integrations (Phase 3.5)
- [Epic 40: External Sandbox Integrations](./epic-40-sandbox-integrations.md) 🔌 ✅ - Circle, x402, Stripe, AP2
- [Epic 41: On-Ramp Integrations](./epic-41-onramp-integrations.md) 💳 - Cards, ACH, LATAM banks
- [Epic 42: Frontend Dashboard Integration](./epic-42-frontend-dashboard.md) 🖥️ ✅ - UI for Epic 40 features

### Protocol Integration ⭐ NEW
- [Epic 43: UCP (Universal Commerce Protocol)](./epic-43-ucp-integration.md) 🌐 ✅ - Google+Shopify's new standard

### Platform Architecture ⭐ NEW
- [Epic 48: Connected Accounts](./epic-48-connected-accounts.md) 🔌 ✅ - Payment handler management
- [Epic 49: Protocol Discovery](./epic-49-protocol-discovery.md) 🧭 ✅ - Protocol registry & enablement
- [Epic 50: Settlement Decoupling](./epic-50-settlement-decoupling.md) ⚙️ ✅ - Settlement trigger rules
- [Epic 51: Unified Onboarding](./epic-51-unified-onboarding.md) 🚀 ✅ - Protocol-specific onboarding
- [Epic 52: Dashboard Redesign](./epic-52-dashboard-redesign.md) 📊 ✅ - Agentic protocol focus

### Card Network Integration
- [Epic 53: Card Network Agentic Commerce](./epic-53-card-network-agentic-commerce.md) 💳 ✅ - Visa VIC + Mastercard Agent Pay, unified Web Bot Auth, multi-rail routing

### Brand & Identity
- [Epic 54: Sly Rebranding](./epic-54-sly-rebranding.md) 🎨 ✅ - PayOS → Sly rename across codebase, packages, docs, UI

### Demo & Sales Enablement
- [Epic 55: Demo Scenario Readiness](./epic-55-demo-scenario-readiness.md) 🎯 - Seed data, KPI panels, settlement timeline, demo walkthrough for all 8 scenarios

### Agent Interoperability ⭐ NEW
- [Epic 57: Google A2A Protocol](./epic-57-google-a2a-protocol.md) 🤝 ✅ - Google A2A protocol for agent discovery, communication, and paid task execution
- [Epic 58: A2A Task Processor Worker](./epic-58-a2a-task-processor.md) ⚙️ ✅ - Background worker for processing A2A tasks with tool registry, payment gating, custom tools, audit trail
- [Epic 60: A2A Agent Onboarding Skills](./epic-60-a2a-agent-onboarding-skills.md) 🎫 ✅ - Register, update, and inspect agents via A2A message/send
- [Epic 68: Flexible Skill Pricing](./epic-68-flexible-skill-pricing.md) 💰 - Per-skill pricing: KYA-tiered rates, per-caller overrides, dynamic quotes, negotiated pricing via A2A
- [Epic 69: A2A Result Acceptance & Quality Feedback](./epic-69-a2a-result-acceptance.md) ✋ - Acceptance gate, quality feedback, partial settlement for A2A tasks
- [Epic 70: Universal Agent Discovery](./epic-70-universal-agent-discovery.md) 🔍 - Tri-ecosystem access: public registry REST API, MCP search tool, OpenAPI spec for Gemini/Claude/ChatGPT

### Agent Contracting Governance ⭐ NEW
- [Epic 18: Agent Wallets & Contract Policies](./epic-18-agent-wallets-contract-policies.md) 🤖 - Contract policy engine, per-counterparty exposure, negotiation guardrails (expanded from 23→35 pts)
- [Epic 29: Workflow Engine](./epic-29-workflow-engine.md) ⚙️ - Expanded with contract governance conditions + escrow/reputation actions (42→52 pts)
- [Epic 62: Escrow Orchestration](./epic-62-escrow-orchestration.md) 🔐 - Wrap AgentEscrowProtocol with governance, kill switch, settlement to Pix/SPEI
- [Epic 63: External Reputation Bridge](./epic-63-external-reputation-bridge.md) 🛡️ - Unified trust score from ERC-8004, Mnemom, Vouched/MCP-I, escrow history. [Collusion detection shipped](../../completed/epics/EPIC_63_COLLUSION_DETECTION.md) on the internal a2a-feedback source (v1 + v2 ring coefficient + live flagging + red-team audit).
- [Epic 64: OpenClaw Governance Skill](./epic-64-openclaw-governance-skill.md) 🧩 - Python skill for ClawHub routing contracting through Sly governance

### High-Frequency Payments
- [Epic 38: High-Frequency Microtransaction Optimization](./epic-38-payment-optimized-chains.md) ✅ - Async settlement, multi-chain (Solana+Base), gasless txs, deferred batch settlement

### Operations & Observability
- [Epic 65: Operations Observability](./epic-65-operations-observability.md) ✅ - Per-request event correlation, usage API, portal tokens, partition management

### Notifications
- [Epic 66: Email Notification System](./epic-66-email-notification-system.md) 🚧 - 10 email types (Tier 1 done), notification preferences, unsubscribe

### Agent Custody & External Services ⭐ NEW
- [Epic 77: BYO Wallet Custody](./epic-77-byo-wallet-custody.md) 🔑 - Session-key delegation + managed providers (Privy/Turnkey/Fireblocks/CDP) + interactive WalletConnect for agent x402 signing
- [Epic 78: Agentic Credential Vault](./epic-78-agentic-credential-vault.md) 🔐 - Tenant-stored API keys with per-agent grants for non-x402 services (Anthropic, OpenAI, Deepgram, etc.) + unified call dispatcher
- [Epic 79: API Monetization Gateway](./epic-79-api-monetization-gateway.md) 🛰️ - Thin proxy + OpenAPI ingest that turns any REST API into a paid x402 endpoint without code changes; closes Sponge Gateway feature gap
- [Epic 80: AgentKit Proof-of-Humanity for x402](./epic-80-agentkit-proof-of-humanity.md) 🧑‍🔬 - World ID / Worldcoin-anchored human-proof signatures for services that require dual auth (Exa + future); extends Epic 78 with `human_attested` custody mode
- [Epic 81: x402 Vendor Reliability Observatory](./epic-81-x402-vendor-reliability.md) 📈 - Rolling per-vendor reliability scores from already-captured response/classification data. Pure aggregation, no new schema. MCP reputation tool + dashboard + probe/discover enrichment.
- [Epic 83: Wallet Token Swap via DEX Aggregator](./epic-83-token-swap-aggregator.md) 🔄 - USDC↔ETH swaps from the wallet via 0x Aggregator (1inch fallback). Sly-signed via existing CDP path, affiliate-fee revenue, no Coinbase Swap dependency. Dashboard tab + MCP tools + worker.
- [Epic 84: Cross-Marketplace Publishing for x402 Endpoints](./epic-84-cross-marketplace-publishing.md) 🌐 - Generalize the Bazaar-only publish flow into a pluggable, multi-marketplace fanout. v1 adapters: Coinbase Bazaar (refactored), Sly A2A registry, Smithery (with MCP shim). Tenant publishes once → Sly fans out to every catalog they've opted into.
- [Epic 85: Sly Scanner on the x402 Marketplace](./epic-85-scanner-on-x402-marketplace.md) 🛒 - Publish 4 scanner endpoints (scan, tests, by-domain, prospects) to agentic.market via the existing publishEndpoint state machine. $0.05/scan undercuts the closest comparable by 50%; partner channel still 50–86% cheaper. 18pts across 8 stories — config + scripts + verification, no new infra.

### API Monetization ⭐ NEW
- [Epic 79: API Monetization Gateway](./epic-79-api-monetization-gateway.md) 🚪 - Thin proxy that wraps any REST API in x402 (MPP later) + OpenAPI ingest CLI + dashboard. Closes Sponge Gateway parity gap.

### Future Considerations (P2/P3)
- [Epic 37: Facilitator-as-a-Service](./epic-37-facilitator-as-a-service.md) - x402 facilitator for LATAM ecosystem
- [Epic 39: Open Issuance](./epic-39-open-issuance.md) - Custom stablecoin support

### Production Hardening (P2/P3)
- [Epic 67: Production Environment Mode](./epic-67-production-environment-mode.md) 🛡️ - Separate deployments (sandbox/production), env column tagging, activation guardrails
- [Epic 44: Observability & Monitoring](./epic-44-observability.md) 📊 - Monitoring, alerting, SLAs
- [Epic 45: Webhook Infrastructure](./epic-45-webhook-infrastructure.md) 🔔 - Guaranteed delivery, DLQ
- [Epic 46: Multi-Region & Disaster Recovery](./epic-46-disaster-recovery.md) 🌍 - Scale & resilience

---

## Investigation Documents

Strategic explorations before committing to implementation:

- [UCP Integration](../investigations/ucp-integration.md) 🔴 **URGENT** - New protocol from Google+Shopify (Jan 11, 2026)
- [Chargeback-Free Value Proposition](../investigations/chargeback-free-value-prop.md) - Settlement finality positioning
- [Ground Station Narrative](../investigations/ground-station-narrative.md) - "Starlink for money" marketing

---

## Status Summary

### Completed Epics ✅

| Epic | Completed | Points | Notes |
|------|-----------|--------|-------|
| Epic 17: Multi-Protocol | Dec 28, 2025 | 53 | x402/AP2/ACP foundation |
| Epic 22: Seed Data | Dec 18, 2025 | 15 | |
| Epic 23: Dashboard Perf | Dec 22, 2025 | 18 | |
| Epic 26: x402 Performance | Dec 27, 2025 | 18 | |
| Epic 27: Settlement | Dec 30, 2025 | 34 | |
| Epic 28: Simulation | Jan 4, 2026 | 24 | |
| Epic 30: Structured Response | Jan 1, 2026 | 28 | |
| Epic 31: Context API | Jan 2, 2026 | 21 | |
| Epic 36: SDK & DX | Jan 3, 2026 | 66 | |
| Epic 40: Sandbox | Jan 5, 2026 | ~100 | Circle, Stripe, x402 |
| Epic 42: Frontend | Jan 6, 2026 | 65 | |
| Epic 43: UCP Integration | Jan 19, 2026 | 55 | |
| Epic 52: Dashboard Redesign | Jan 22, 2026 | 21 | Agentic protocol focus |
| Epic 48: Connected Accounts | Jan 22, 2026 | 21 | Payment handler management |
| Epic 49: Protocol Discovery | Jan 22, 2026 | 18 | Protocol registry & enablement |
| Epic 50: Settlement Decoupling | Jan 22, 2026 | 26 | Settlement trigger rules |
| Epic 51: Unified Onboarding | Jan 22, 2026 | 52 | Protocol-specific onboarding |
| Epic 53: Card Networks | Jan 27, 2026 | 62 | Visa VIC + Mastercard Agent Pay |
| Epic 54: Sly Rebranding | Jan 27, 2026 | 34 | PayOS → Sly rename |
| Epic 57: Google A2A | Feb 21, 2026 | 89 | Agent discovery, communication, paid tasks |
| Epic 38: HF Microtransactions | Mar 11, 2026 | 63 | Async settlement, multi-chain, batch settlement |
| Epic 65: Operations Observability | Mar 11, 2026 | ~40 | Event correlation, usage API, portal tokens |
| Epic 59: User Onboarding & SSO | Mar 11, 2026 | 69 | Fix signup, team invites, SSO, agent self-registration |
| **Total Completed** | | **~992** | |

### Current Focus 🚧

| Epic | Priority | Points | Notes |
|------|----------|--------|-------|
| Epic 58: A2A Task Processor | ✅ | 119 | 17/18 done (109 pts). 58.4 LLM deferred — regex router sufficient |
| Epic 55: Demo Readiness | P0 | 89 | Seed data + demo UI for 8 scenarios |
| Epic 29: Workflow Engine | P0 | 52 | Multi-step workflows (expanded for contracting) |
| Epic 41: On-Ramp | P1 | 110 | Non-crypto customers |
| Epic 18: Agent Wallets & Contract Policies | P0 | 35 | Expanded: contract policies, counterparty exposure |
| Epic 62: Escrow Orchestration | P0 | 41 | Agent contract escrow with governance |
| Epic 63: External Reputation Bridge | P0 | 28 | Unified trust score aggregation |
| Epic 64: OpenClaw Governance Skill | P1 | 10 | ClawHub skill for governed contracting |
| Epic 66: Email Notification System | P1 | 35 | Tier 1 done (10 emails), preferences + unsubscribe remaining |
| Epic 68: Flexible Skill Pricing | P1 | 52 | KYA-tiered, per-caller, dynamic, negotiated pricing |
| Epic 69: A2A Result Acceptance | P1 | 29 | Acceptance gate, quality feedback, partial settlement |
| Epic 70: Universal Agent Discovery | P0 | 47 | Tri-ecosystem: visibility model, public registry, MCP search, OpenAPI |

### Planned (P0/P1) 📋

| Epic | Priority | Points | Notes |
|------|----------|--------|-------|
| Epic 67: Production Environment Mode | P0 | 88 | Separate deployments, env column tagging |
| Epic 32: Tool Discovery | P0 | 11 | |
| Epic 33: Metadata Schema | P1 | 11 | |
| Epic 34: Transaction Decomp | P1 | 14 | |
| **Subtotal P0/P1** | | **~424** | Including Epic 67 (88 pts), 48-52, 41, 29 |

### Planned (P2) 📋

| Epic | Priority | Points | Notes |
|------|----------|--------|-------|
| Epic 19: x402 Services | P2 | 22 | |
| Epic 20: Streaming | P2 | 28 | +10 for agent identity |
| Epic 24: API Key Security | P2 | 28 | |
| Epic 44: Observability | P2 | ~40 | |
| Epic 45: Webhooks | P2 | ~35 | |
| **Subtotal P2** | | **~153** | |

### Future (P3) 🔮

| Epic | Priority | Points | Notes |
|------|----------|--------|-------|
| Epic 21: Code Coverage | P3 | 112 | |
| Epic 37: Facilitator | P3 | TBD | Decision pending |
| Epic 39: Open Issuance | P3 | ~47 | Post-PMF |
| Epic 46: DR | P3 | ~60 | |
| **Subtotal P3** | | **~205** | |

### Points Summary

- **Completed:** ~992 points
- **Current Focus:** ~441 points (58, 55, 29, 41, 68, 69, 70)
- **P0/P1 Planned:** ~124 points (including Epic 67 at 88 pts)
- **P2 Planned:** ~153 points
- **P3 Future:** ~205 points
- **Total Defined:** ~1,806 points

---

## Recent Changes

### April 22, 2026
- **Epic 79: API Monetization Gateway** — NEW (~35 points, P1)
  - Triggered by competitive research on Sponge Gateway (YC W26) launch, April 22, 2026
  - Thin proxy at `ALL /v1/gateway/:gatewayId/*` that wraps any upstream REST API in x402 payments
  - `sly x402 import --spec openapi.yaml` CLI + dashboard drop-zone for bulk endpoint creation
  - 3 new MCP tools: `x402_gateway_create`, `x402_gateway_import_openapi`, `x402_gateway_list_routes`
  - Surfaces the `"upto"` variable-price pattern already shipped in commit `b55ad8c`
  - MPP protocol dispatch deferred to Phase 5, blocked on Epic 71 Phase 3
  - 12 stories across 5 phases: Gateway Core (16pt), OpenAPI Ingest (5pt), Dashboard (8pt), MCP + "upto" docs (3pt), MPP extension (3pt)
  - MVP = Phase 1 + 79.6 = 19pt
  - Competitive matrix: of Sponge's ~11 features, Sly already fully matches 5, partially covers 4, and closes the remaining 2 via this epic

### March 16, 2026
- **Epic 70: Universal Agent Discovery — Tri-Ecosystem Access** — UPDATED (42 → 47 points, 12 → 13 stories, P0)
  - **NEW Story 70.0: Agent Visibility Model** (5 pts, [SLY-476](https://linear.app/sly-ai/issue/SLY-476)) — formalize public vs private agents using existing `discoverable` column. Private agents hidden from registry, A2A discovery, and public card endpoints. Guards added to `fetchAgentCard()` and per-agent A2A task endpoint.
  - Phase 1 renamed: "Agent Visibility + Public Registry REST API" (13 → 18 pts)
  - Updated dependency graph: 70.0 is now the root — blocks 70.1, 70.2, 70.4
  - Stories 70.1, 70.2, 70.4 updated to reference visibility model as blocker and include private-agent test cases
  - Public agent registry REST API: `GET /v1/registry/agents` with search, tag filter, skill filter, pagination
  - Extract shared `searchAgents()` service from `gateway-handler.ts` to power all three discovery paths
  - MCP `search_agents` tool closes Claude gap — discover agents before sending tasks
  - OpenAPI 3.1 spec at `/openapi.json` enables ChatGPT GPTs/Connectors integration
  - SDK `sly.registry` module with `search()` and `getAgent()`
  - Public registry browse page in Next.js app
  - 13 stories across 5 phases: Visibility + REST API (18 pts), MCP + SDK (9 pts), OpenAPI (7 pts), Dashboard (5 pts), Testing + Docs (8 pts)
  - Subsumes SLY-249 (Agent Registry API) and SLY-252 (Agent Discovery Dashboard) from Epic 20
- **Epic 69: A2A Result Acceptance & Quality Feedback** — NEW (29 points, P1)
  - Acceptance gate pauses mandate resolution for caller review before payment
  - Quality feedback: satisfaction rating + numeric score stored in `a2a_task_feedback` table
  - Partial settlement: proportional payment for partial work (provider opt-in)
  - Review timeout worker auto-fails unreviewed tasks (refund to caller)
  - 7 stories across 3 phases: Core Acceptance (13 pts), Feedback & Partial Settlement (13 pts), Query & Testing (8 pts)
  - Linear issues: SLY-455 through SLY-461
- **Epic 62: Escrow Orchestration** — ENRICHED (38 → 41 points, 9 → 10 stories)
  - Story 62.10: Escrow outcome reputation signals — emits `reputation_relevant: true` events on terminal escrow states
  - Bridges Epic 62 → Epic 63 explicitly (escrow history as reputation source)
  - Linear issue: SLY-462
- **Epic 63: External Reputation Bridge** — ENRICHED (25 → 28 points, 7 → 8 stories)
  - Story 63.8: A2A feedback ingestion for trust score — adds "Service Quality" as 5th scoring dimension (15% weight)
  - Reads from `a2a_task_feedback` table (Epic 69.4), aggregates per-agent quality metrics
  - Linear issue: SLY-463
- **Epic 68: Flexible Skill Pricing** — NEW (52 points, P1)
  - Four pricing models: KYA-tiered rates, per-caller overrides, dynamic quotes, negotiated pricing
  - Price resolution layer between skill lookup and settlement mandate creation
  - Agent Card `urn:a2a:ext:pricing` extension for pricing model discovery
  - Management API for pricing configuration and caller-specific overrides
  - 11 stories across 5 phases: Foundation (13 pts), Task Processor Integration (10 pts), Dynamic & Negotiated (13 pts), Management API (8 pts), Testing & Docs (8 pts)
  - Linear issues: SLY-443 through SLY-453
- **Epic 67: Production Environment Mode** — REVISED (88 points, P0, was 100)
  - Architecture changed from column+RLS on single server to **separate deployments** (two Railway services)
  - Root cause: service role key bypasses all RLS, single EVM/Circle key per process, global blockchain routing
  - 22 stories across 5 phases: Foundation (24 pts), Production Guardrails (16 pts), Infrastructure/DevOps (16 pts), UI Integration (18 pts), Migration & Rollout (14 pts)
  - 8 Linear issues canceled, 12 updated, 10 new (SLY-433 through SLY-442)

### March 15, 2026
- **Epic 67: Production Environment Mode** — Original plan (100 points, superseded by March 16 revision)
  - Column + RLS approach (abandoned after architecture review)
  - Linear stories: SLY-413 through SLY-432

### March 12, 2026
- **Epic 58: A2A Task Processor** — Marked COMPLETE ✅ (17/18 stories, ~109/119 points)
  - Stories 58.11 (SDK Types): A2A types exported to `@sly/types`, A2AClient added to `@sly/sdk` with discover/sendMessage/getTask/cancelTask/listTasks/respond/customTools
  - Stories 58.15 (Custom Tool Support): `agent_custom_tools` table, webhook execution with HMAC signing, registry loads tenant-defined tools
  - Stories 58.17 (Audit Trail): `a2a_audit_events` table (RLS), event bus persists all lifecycle events, worker timeout events included
  - Stories 58.18 (Context Window): Fixed historyLength bug (now returns most recent N messages), default cap 100, per-agent `max_context_messages` setting
  - Story 58.4 (LLM Managed Handler): Intentionally deferred — regex router is faster and cheaper for A2A use case

### March 11, 2026
- **Epic 66: Email Notification System** — NEW (35 points, P1)
  - Tier 1 complete: 10 email types (welcome, transfer completed/failed, account locked, API key created/revoked, role changed, member removed, team invite, invite accepted)
  - Shared HTML layout, fire-and-forget sends, recipient resolution helpers
  - 8 stories (SLY-405 through SLY-412): Tier 1 done, Tier 2/3 + preferences + unsubscribe in backlog
- **Epic 59: User Onboarding & SSO** — Marked COMPLETE ✅ (69 points)
  - All 4 phases shipped: fix signup, team invite UI, Google/GitHub SSO, agent self-registration
  - Was already implemented but missing from completed table
- **Epic 65: Operations Observability** — COMPLETE ✅ (~40 points)
  - 3-layer observability: request counters, operation events (CloudEvents 1.0), cost tracking
  - 48+ OpTypes across all protocols (x402, AP2, ACP, UCP, A2A)
  - Per-request correlation ID linking all operations within a single API call
  - Portal token authentication (4th auth method) for customer-facing usage API
  - Usage API: 4 endpoints (summary, operations, requests, costs)
  - Partition manager worker for monthly table rotation with RLS enforcement
  - Materialized view for hourly usage summaries
- **Epic 38: HF Microtransactions** — COMPLETE ✅ (63 points)
  - Async settlement, Solana chain, Gas Station, deferred batch settlement, CCTP cross-chain

### March 7, 2026
- **Epic 38: High-Frequency Microtransaction Optimization** — REVISED (63 points, P1)
  - Completely rewritten from "Payment-Optimized Chains" (Tempo/future chains) to actionable microtransaction optimization
  - 18 stories across 5 phases: Async Settlement, Solana Chain, Gas Station, Deferred Net Settlement, CCTP Cross-Chain
  - Supersedes Epic 26 Phase 3 (Story 26.4 -> Story 38.1)
  - Key deliverables: sub-100ms authorization, Solana support, gasless txs, batch on-chain settlement
  - Linear stories: SLY-368 through SLY-385 with full dependency graph

### February 28, 2026
- **Epic 60: A2A Agent Onboarding Skills** — COMPLETE ✅ (28 points)
  - Three new platform-level A2A skills: `register_agent`, `update_agent`, `get_my_status`
  - Full agent lifecycle (register → configure → inspect) via standard A2A `message/send`
  - Optional auth extraction on `POST /a2a` gateway (API key for registration, agent token for self-service)
  - Auto-creates wallet, upserts skills, verifies KYA tier 1 in one shot
  - Self-sovereign updates: agents modify their own profiles via their auth token
  - Platform Agent Card updated with onboarding skill definitions + inputSchemas
  - 15 unit tests covering all handlers + backward compatibility
  - 8 stories across gateway auth, intent routing, handlers, card, and tests

### February 26, 2026
- **Epic 59: User Onboarding, SSO & Agent Self-Registration** — NEW (69 points, P0)
  - Fix broken web signup (Supabase auth user created but no tenant provisioned)
  - Team invite UI (accept invite page + team management dashboard)
  - Google + GitHub SSO via Supabase OAuth
  - Agent self-registration endpoint (`POST /v1/auth/agent-signup`)
  - 16 stories across 4 incremental phases

### February 21, 2026
- **Epic 57: Google A2A Protocol** — COMPLETE ✅ (89 points)
  - Full A2A v0.3 protocol support: Agent Cards, JSON-RPC 2.0, task lifecycle
  - Per-agent discovery at `/a2a/agents/:id/card` (public, no auth)
  - Platform discovery at `/.well-known/agent.json`
  - Payment integration: x402 payment gating + AP2 mandate linking within tasks
  - Outbound A2A client for remote agent communication
  - SDK types + client methods in `@sly/api-client`
  - 4 MCP tools: `a2a_discover_agent`, `a2a_send_task`, `a2a_get_task`, `a2a_list_tasks`
  - Dashboard: A2A tab on agent detail, tasks + sessions pages
  - Integration tests (599 lines)
- **AP2 Mandate Payment Instruments** — Enhancement
  - `funding_source_id` and `settlement_rail` columns on `ap2_mandates`
  - Create/update/execute mandates with bound payment instruments
  - UI: funding source + settlement rail selectors on create page, display on detail page
  - Agent detail page: "Payment Instruments" section showing bound instruments

### February 19, 2026
- **Epic 57: Google A2A Protocol** — NEW (89 points, P0)
  - Google's Agent-to-Agent protocol for agent discovery, communication, and paid task execution
  - 14 stories across 6 phases: Agent Cards, Task DB + JSON-RPC, Payment Integration, Outbound Client, SDK + Frontend, Testing
  - Hybrid auth: Sly API keys for known partners + verified bearer tokens for open federation
  - Reuses existing AP2 mandates, x402 payments, wallet system
  - Adds 4 MCP tools, A2A tab on agent detail page, `sly.a2a` SDK module

### February 6, 2026
- **Epic 55: Demo Scenario Readiness** — NEW (89 points, P0)
  - Comprehensive dashboard validation against all 8 demo scenarios
  - 20 screens validated: 1 good to go, 18 need seed data, 1 partially ready
  - 12 stories: seed data (40 pts), UI components (34 pts), polish (15 pts)
  - Key deliverables: scenario-specific seed script, KPI panels, settlement timeline, policy check viz, demo mode navigation

### January 30, 2026
- **Story 36.10: Function-Calling Format** — COMPLETE ✅
  - `GET /v1/capabilities/function-calling` endpoint implemented
  - OpenAI function format (`?format=openai`)
  - Anthropic tool format (`?format=anthropic`)
  - Protocol-specific capabilities at `/v1/capabilities/protocols`
  - LLM-optimized descriptions for all 8 core operations
- **Docs:** Updated TODO.md with recent completions and demo checklist progress

### January 27, 2026
- **Epic 54: Sly Rebranding** — COMPLETE ✅ (34 points)
  - Renamed PayOS to Sly across entire codebase
  - Updated all packages (@payos/* → @sly/*)
  - Updated UI branding, logos, and documentation
  - Support for SLY_ environment variable prefix
- **Epic 53: Card Network Agentic Commerce** — COMPLETE ✅ (62 points)
  - Visa VIC integration with TAP (Trusted Agent Protocol)
  - Mastercard Agent Pay with DTVC tokens
  - Unified Web Bot Auth verification (RFC 9421)
  - Settlement router with 5 rails: Visa, MC, USDC, Pix, SPEI
  - Dashboard UI for card network management
  - SDK modules: `sly.cards.visa`, `sly.cards.mastercard`
- **Security:** Enabled RLS on `runs` and `run_logs` tables
- **Fix:** Protocol toggles now work correctly on dashboard home page

### January 22, 2026
- **Epic 52: Dashboard Redesign** — COMPLETE ✅ (21 points)
  - Protocol distribution widget (x402/AP2/ACP/UCP, not Circle/ETH/BTC)
  - Protocol activity chart with time range and metric toggles
  - Protocol quick stats cards with enable/disable toggles
  - Conditional onboarding banner
  - Recent protocol activity feed with agent badges
- **Epic 48: Connected Accounts** — COMPLETE ✅ (21 points)
  - CRUD API for connected accounts
  - Credential vault with AES-256 encryption
  - Payment handler abstraction (Stripe, PayPal, Circle)
  - Handler registry and validation
- **Epic 49: Protocol Discovery** — COMPLETE ✅ (18 points)
  - Protocol registry service (x402, AP2, ACP, UCP)
  - Protocol discovery API (`GET /v1/protocols`)
  - Protocol enablement API with prerequisite validation
  - Protocol status dashboard widget with toggles
- **Epic 50: Settlement Decoupling** — COMPLETE ✅ (26 points)
  - Settlement trigger engine (schedule, threshold, manual, immediate)
  - Settlement rules CRUD API
  - Settlement rules dashboard UI
- **Epic 51: Unified Onboarding** — COMPLETE ✅ (52 points)
  - Onboarding state tracking API
  - Protocol-specific onboarding flows
  - Quick start templates
  - Sandbox mode toggle
  - Full wizard UI with step components

### January 21, 2026
- **Epic 53: Card Network Agentic Commerce** — NEW (62 points, P1)
  - **Both Visa VIC AND Mastercard Agent Pay** support
  - Unified Web Bot Auth verification (RFC 9421) for both networks
  - 11 stories covering full integration of both card networks
  - Settlement router evaluates 5 rails: Visa, Mastercard, USDC, Pix, SPEI
  - LATAM optimization (Mastercard already live Dec 2025)
  - MCP tools and Dashboard UI for card network management

### January 20, 2026
- **Epic 43: UCP Integration** — COMPLETE ✅ (55 points)
- **Epic 48: Connected Accounts** — NEW (21 points, P0)
  - Payment handler management for multi-processor support
- **Epic 49: Protocol Discovery** — NEW (18 points, P0)
  - Protocol registry and enablement API
- **Epic 50: Settlement Decoupling** — NEW (26 points, P0)
  - Settlement trigger rules engine
- **Epic 51: Unified Onboarding** — NEW (24 points, P1)
  - Protocol-specific onboarding flows
- **Epic 52: Dashboard Redesign** — NEW (21 points, P1)
  - Agentic protocol focus, real metrics
- **Architecture Doc** — [Three-Layer Architecture](../../architecture/three-layer-architecture.md)

### January 15, 2026
- **Epic 43: UCP Integration** — Created (55 points, P0)
  - Google+Shopify's Universal Commerce Protocol launched Jan 11
  - PayOS to become UCP Payment Handler for LATAM
- **Epic 44: Observability** — NEW (Placeholder, P2)
- **Epic 45: Webhook Infrastructure** — NEW (Placeholder, P2)
- **Epic 46: Multi-Region & DR** — NEW (Placeholder, P3)
- **UCP Investigation** — Comprehensive analysis at `investigations/ucp-integration.md`

### January 6, 2026
- **Epic 42: Frontend Dashboard** — COMPLETE ✅ (65 points)

### January 5, 2026
- **Epic 40: Sandbox Integrations** — COMPLETE ✅ (~100 points)

---

## Protocol Support Matrix

Sly supports **FIVE** agentic payment and communication protocols:

| Protocol | Owner | Focus | Sly Status |
|----------|-------|-------|------------|
| **x402** | Coinbase | Micropayments | ✅ Full support |
| **AP2** | Google | Agent mandates | ✅ Full support |
| **ACP** | Stripe/OpenAI | E-commerce | ✅ Full support |
| **UCP** | Google+Shopify | Full commerce | ✅ Epic 43 |
| **A2A** | Google | Agent communication | ✅ Epic 57 |

**Card Network Support:**

| Network | Protocol | Sly Status |
|---------|----------|------------|
| **Visa** | VIC / TAP | ✅ Epic 53 |
| **Mastercard** | Agent Pay | ✅ Epic 53 |

> **"We don't care which protocol wins. PayOS makes them all work."**

---

## Navigation

- [← Back to Master PRD](../PayOS_PRD_Master.md)
- [View Investigations](../investigations/)

---

## Appendix: SDK Module Reference

| Module | Purpose | Examples |
|--------|---------|----------|
| `payos.x402` | x402 protocol operations | `fetch()`, `createProvider()` |
| `payos.ap2` | AP2 mandate operations | `verifyMandate()`, `executePayment()` |
| `payos.acp` | ACP checkout operations | `createCheckout()`, `completeCheckout()` |
| `payos.ucp` | UCP protocol operations | `discover()`, `settle()` |
| `payos.settlements` | Direct settlement API | `quote()`, `create()`, `get()`, `list()` |
| `payos.compliance` | Compliance checks | `check()`, `screen()` |
| `payos.accounts` | Account management | `create()`, `get()`, `update()` |
| `payos.agents` | Agent management | `create()`, `get()`, `updatePolicy()` |
| `payos.webhooks` | Webhook utilities | `constructEvent()`, `verify()` |
| `payos.cards` | Card network operations | `verify()`, `createInstruction()`, `complete()` |
| `payos.cards.visa` | Visa VIC operations | `createInstruction()`, `getCredentials()` |
| `payos.cards.mastercard` | Mastercard Agent Pay | `registerAgent()`, `createToken()`, `getDTVC()` |
| `payos.a2a` | A2A protocol operations | `discover()`, `sendTask()`, `getTask()`, `getAgentCard()` |
| `payos.registry` | Agent discovery & search | `search()`, `getAgent()` |

---

*Last updated: April 22, 2026*
