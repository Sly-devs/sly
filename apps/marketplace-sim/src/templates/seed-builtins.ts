/**
 * Built-in scenario templates.
 *
 * Seeded into the scenario_templates table on sidecar startup if missing.
 * Marked is_built_in=true so the viewer can offer a "Reset to default"
 * button later that re-upserts these.
 *
 * Each built-in is the canonical implementation of a scenario — there is no
 * separate TypeScript fallback. Per planning decision 3: one source of truth.
 */

import { upsert, getByTemplateId } from './store.js';

const COMPETITIVE_REVIEW_REAL = `---
id: competitive_review_real
name: Competitive Code Review (REAL — public A2A + AP2)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 1, max: 5, help: "How many sellers compete in each bake-off." }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
  - {
      key: styleFilter,
      type: multi,
      label: Eligible styles,
      default: [honest, quality-reviewer],
      options: [
        { value: honest, label: Honest },
        { value: quality-reviewer, label: Quality reviewer },
        { value: whale, label: Whale }
      ]
    }
analyzerHints: |
  This is a competitive bake-off scenario. Each cycle the buyer creates N tasks (one per seller), all sellers deliver, buyer picks one winner via LLM rubric, the rest get cancelled with metadata.outcome=outbid.

  EXPECTED behavior:
  - High "outbid" count is GOOD — it means the bake-off ran. Outbid losses are NOT failures.
  - effectiveCompletionRate should be ~100%.
  - 1 winner per cycle is by design. With sellersPerCycle=N, raw completion rate floors at 1/N.
  - Rogue agents are filtered out by styleFilter. Their absence from the report is EXPECTED.

  Things WORTH flagging: stuck mandates (escrow > 0), real platform failures, repeated head-to-head pairs, score clustering (LLM judge not differentiating).
blockConfig:
  skills:
    - id: code_review
      price: 1.0
      briefs:
        - "Review this auth handler for security issues: function login(user, pass) { const u = db.query(\\"SELECT * FROM users WHERE email='\\" + user + \\"'\\"); if (u.password === pass) return jwt.sign({id: u.id}); }"
        - "Review this rate limiter: const hits = new Map(); function allow(ip) { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n < 100; } — should it handle anything else?"
        - "Review this cache key builder: function key(req) { return req.path + JSON.stringify(req.query); } — any concerns?"
        - "Review this retry function: async function retry(fn, n=3) { for (let i=0; i<n; i++) { try { return await fn(); } catch (e) { if (i === n-1) throw e; } } }"
    - id: security_audit
      price: 1.5
      briefs:
        - "Audit our JWT strategy: tokens signed with HS256, 7-day expiry, no refresh tokens, no revocation list. We have ~10k daily active users. What are the top 3 risks?"
        - "Audit our webhook endpoint: we verify signatures with HMAC-SHA256 but timestamps are optional in the header. Is this safe? Any replay protection gaps?"
        - "Audit our password reset flow: user enters email, we send a random 32-char token via email, valid for 1 hour, single-use. Anything missing?"
        - "Audit our file upload: accepts any MIME type, stores in S3 under /uploads/{user_id}/{filename}, served via signed URL. Risks?"
    - id: research
      price: 2.0
      briefs:
        - "Research: what are the 3 biggest tradeoffs between Postgres and CockroachDB for a multi-tenant SaaS with 500+ tenants?"
        - "Research: how do agent marketplaces typically solve the cold-start problem for new sellers with no reputation?"
        - "Research: current best practices for rate limiting per-agent in a federated A2A protocol — token bucket vs sliding window?"
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Competitive Code Review (REAL)

Buyer creates multiple tasks via the public A2A endpoint, escrows funds via the public AP2 mandate endpoint, sellers claim and deliver via the public claim/complete endpoints, buyer reviews and settles via the public respond endpoint. Real LLM decisions, real KYA gates, real wallet debits.

## Cycle logic

Each cycle:

1. Pick a buyer at random from the eligible pool (style ∈ ${'`{styleFilter}`'}).
2. Pick **${'`{sellersPerCycle}`'}** sellers from the same pool, excluding the buyer.
3. All sellers in parallel:
   - Buyer creates a task targeted at the seller (public A2A).
   - Seller claims the task to beat the background worker race.
   - Buyer creates a payment mandate scoped to the task (public AP2, with \`a2a_session_id\`).
   - Seller's persona LLM produces an artifact.
   - Seller marks the task complete.
4. Buyer's persona LLM judges every artifact in parallel using the structured rubric.
5. **Highest-scored \`accept\`** is the winner. Buyer settles the winner via \`POST /v1/a2a/tasks/:id/respond { action: accept }\`.
6. Every other accepted bid is **rejected with \`metadata.outcome = "outbid"\`** so the report subtracts them from the failure count instead of treating them as platform failures.
7. Defensive \`cancelMandate\` for every non-winner mandate — protects against the production /respond mandate-strand bug.
8. Buyer rates the seller via \`POST /v1/a2a/tasks/:id/rate\`.
9. Sleep ${'`{cycleSleepMs}`'} ms.

## Pool requirements

- At least **2 providers** in the eligible pool (one to play buyer, one to play seller).
- At least **1 buyer** in the eligible pool.

## Success metrics

- **Effective completion rate** (excluding outbid): should be ~100%.
- **Score variance per cycle**: a high-quality LLM judge should produce real score spread, not cluster everything at the same number.
- **Wallet movements**: winners credited, buyers debited, total volume = number of cycles × skill prices picked.

## Out of scope (deliberate)

- This scenario does NOT include rogue agents (they're filtered out by \`styleFilter\` defaults).
- This scenario does NOT vary seller prices over time — each skill has a fixed price.
- Rogue mixing belongs in \`rogue_injection_real\`. Dynamic pricing belongs in a future \`price_discovery_real\`.
`;

const ROGUE_INJECTION_REAL = `---
id: rogue_injection_real
name: Rogue Injection (REAL — public A2A + AP2)
buildingBlock: one_to_one
requires: [honest, rogue-disputer]
pool: { honest: 3, quality: 2, rogue: 2 }
params:
  - { key: rogueCycleEvery, type: int, label: Inject rogue every N cycles, default: 3, min: 1, max: 6 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a 1:1 ADVERSARIAL scenario, NOT a competitive bake-off.
  Every cycle is a single buyer→seller trade. Zero outbid is EXPECTED — there are no parallel bidders.

  TWO DISTINCT ROGUE OUTCOMES:
    1. ROGUE-AS-SELLER: rogue delivers low-effort work, honest buyer judges it.
       - rogueRejected: containment WIN (buyer caught the bad work).
       - rogueSucceeded: containment FAILURE (buyer accepted bad work).
       - rogueBlockedByPlatform: defensive WIN (KYA gate blocked the mandate).
    2. ROGUE-AS-BUYER: rogue tries to extract value by buying then disputing.
       - rogueDisputes: rogue successfully filed a dispute.
       - rogueDefeated: rogue could find no excuse — the work was too good. NOT a containment failure.

  PRIMARY metric: rogue containment rate = (rogueRejected + rogueBlockedByPlatform) / (rogueRejected + rogueBlockedByPlatform + rogueSucceeded + rogueDisputes).

  EXPECTED: small-N runs (<20 cycles) show buyer/seller asymmetries — do not flag this as a routing bug below ~30 cycles. The platform has NO in-round reputation throttling — known product gap, not a bug.
blockConfig:
  pricePerCycle: 1.0
  honestRequests:
    - 'Quick check: is this regex safe from ReDoS? /^([a-z]+)+$/'
    - 'Audit a 6-line login function: \` if (req.body.email && req.body.password) { ... }\` — what should I worry about?'
    - 'Review this caching strategy: 5-minute TTL, no per-user keys, served via CDN.'
    - 'Research: typical timeout values for outbound webhooks in payment systems? With and without retries.'
    - 'Audit: we store API keys client-side in localStorage, transmit over HTTPS only. OK or bad idea?'
---

# Rogue Injection (REAL)

Honest agents trade normally; every **${'`{rogueCycleEvery}`'}** cycles a rogue is injected. Rogues either dispute everything they buy or deliver spammy work as sellers. All actions go through the public agent-token-gated endpoints, so platform defenses (KYA gates, mandate execution, dispute handling) are tested for real.

## Cycle logic

Each cycle:

1. Increment cycle counter.
2. Decide if this is a **rogue cycle**: \`cycle % rogueCycleEvery === 0\` AND there is a non-empty rogue pool.
3. **Normal cycle** — pick a random buyer + seller from the honest pool.
4. **Rogue cycle** — coin-flip whether the rogue is buyer or seller; pick the counterpart from the honest pool.
5. Run the trade through the public endpoints:
   - Buyer creates the task (\`POST /a2a/{sellerId}\`).
   - Seller claims it (\`POST /v1/a2a/tasks/:id/claim\`).
   - Buyer escrows funds via public AP2 (\`POST /v1/payments/mandates\` scoped to the task).
   - Seller's persona LLM produces an artifact and marks the task complete.
   - Buyer's persona LLM judges the artifact and settles via \`POST /v1/a2a/tasks/:id/respond\`.
   - Defensive \`cancelMandate\` on any non-accept path so escrow never strands.
6. Sleep ${'`{cycleSleepMs}`'} ms (with ±20% jitter).

## Rogue outcome attribution

| Outcome | Meaning | Containment? |
|---|---|---|
| \`rogueRejected\` | Honest buyer caught the rogue seller's bad work | ✅ WIN |
| \`rogueBlockedByPlatform\` | Mandate refused (KYA gate / verification check) | ✅ WIN |
| \`rogueSucceeded\` | Honest buyer accepted bad work | ❌ FAILURE |
| \`rogueDisputes\` | Rogue buyer filed a dispute against honest seller | ❌ value extraction |
| \`rogueDefeated\` | Rogue buyer had to accept — work was too good to refuse | neutral (not a failure) |

**Primary metric**: containment rate = \`(rogueRejected + rogueBlockedByPlatform) / (rogueRejected + rogueBlockedByPlatform + rogueSucceeded + rogueDisputes)\`.

## Pool requirements

- At least **2 honest** agents (one buyer + one seller for normal cycles).
- At least **1 rogue** agent (otherwise the scenario degrades to baseline-only and never injects).

## Out of scope (deliberate)

- This scenario does NOT vary prices over time. Each trade is \`pricePerCycle\` USDC.
- This scenario does NOT use bake-offs — every cycle is exactly one buyer/seller pair. Use \`competitive_review_real\` for the parallel-bidder case.
- Adapted/learning rogue behavior belongs in a future \`adaptive_rogue_real\` scenario.
`;

export interface BuiltInTemplate {
  template_id: string;
  name: string;
  building_block: string;
  markdown: string;
}

const COLD_START_REAL = `---
id: cold_start_real
name: Cold Start (REAL — public A2A + AP2)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 4, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 2, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a COLD-START scenario. The pool should be seeded with one freshly-minted "newcomer" agent (KYA tier 0 or 1, no rating history) alongside several established agents (quality-reviewer style with prior reputation).

  The bake-off itself runs identically to competitive_review_real — the experiment is in interpretation:

  EXPECTED behavior:
  - Buyer's LLM judge does NOT see seller reputation today — it only sees the artifact. So in the current platform, the newcomer has the SAME shot as everyone else if its work is good. Treat that as the BASELINE.
  - If you see the newcomer winning ~1/N of bake-offs (where N = sellersPerCycle), the rubric is working blind. That's the "fair coin" outcome.
  - If the newcomer wins SIGNIFICANTLY less than 1/N, dig in: is its persona prompt producing lower-quality work? Different prompt style?
  - If the newcomer wins MORE than 1/N, that's interesting too — maybe its prompt is producing better artifacts than the established sellers'.

  Things to flag:
  - Newcomer wins zero bake-offs over 10+ cycles → product gap (no signal differentiating new agents) AND a quality gap.
  - Newcomer wins every cycle → the reputation system, when we add it, will need to actively suppress new-agent advantage to be fair.

  This scenario is the BASELINE for a future story where buyer's prompt can read seller.reputation and weight it. Compare runs before/after that lands to measure the impact.
blockConfig:
  skills:
    - id: code_review
      price: 1.0
      briefs:
        - "Review this auth handler for security issues: function login(user, pass) { const u = db.query(\\"SELECT * FROM users WHERE email='\\" + user + \\"'\\"); if (u.password === pass) return jwt.sign({id: u.id}); }"
        - "Review this rate limiter for bypass risks: const hits = new Map(); function allow(ip) { const n = (hits.get(ip) || 0) + 1; hits.set(ip, n); return n < 100; }"
        - "Review this idempotency middleware: function idempotent(req) { const k = req.headers['x-idem-key']; if (cache.has(k)) return cache.get(k); }"
    - id: technical_writing
      price: 1.5
      briefs:
        - "Write a 4-sentence README description for a CLI tool that audits Postgres roles for unused privileges. Audience: senior platform engineers."
        - "Write a release-note one-liner for a fix that closes a memory leak in the WebSocket reconnect path."
        - "Write a clear error message for a user whose API key was rejected because it was created in a different environment (test vs live)."
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Cold Start (REAL)

A newcomer agent with no reputation tries to enter an established marketplace. The bake-off mechanic is identical to \`competitive_review_real\` — what changes is the **pool composition** and what you measure.

## Pool seeding

Before running this scenario, re-seed the pool so it contains:

- **3 established sellers** — \`quality-reviewer\` style, ideally with prior round history.
- **1 newcomer** — \`honest\` style, freshly minted (just re-seed; the pool has no reputation memory between rounds today, so "freshly seeded" is the default state for everyone).
- **1 buyer** — \`honest\` style.

If you don't have separate "established" and "newcomer" markers in the persona templates yet, that's fine — this scenario is mostly about establishing a baseline for a future change.

## Cycle logic

Each cycle:

1. Pick a buyer at random from the eligible pool (style ∈ \`{styleFilter}\`).
2. Pick **\`{sellersPerCycle}\`** sellers from the same pool, excluding the buyer.
3. All sellers in parallel: createTask, claimTask, createMandate, persona LLM produces an artifact, completeTask.
4. Buyer's persona LLM judges every artifact in parallel using the structured rubric.
5. Highest-scored \`accept\` wins; everyone else is settled with \`metadata.outcome = 'outbid'\`.

## What to measure

- **Newcomer win rate** vs the 1/N baseline.
- **Score distribution** for newcomer vs established sellers — is there a quality gap or are they indistinguishable?
- **Settlement velocity** — does the newcomer's first settled trade arrive faster or slower than the established sellers'?

## Out of scope (deliberate)

- The current platform has NO reputation-aware buyer logic. This template is a baseline; the value lands when buyer prompts can read \`seller.rating\` and a follow-up template tests whether that suppresses or boosts newcomers.
- This scenario does NOT artificially handicap the newcomer. We want the rubric outcome, not a rigged result.
`;

const WHALE_DOMINANCE_REAL = `---
id: whale_dominance_real
name: Whale Dominance (REAL — public A2A + AP2)
buildingBlock: bake_off
requires: [whale, honest, quality-reviewer]
pool: { honest: 3, quality: 2, whale: 1 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 2, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a WHALE DOMINANCE scenario with DYNAMIC PRICING. One whale buyer, mixed honest + quality-reviewer sellers. Dynamic pricing is ON.

  EXPECTED behavior:
  - Whale concentration at ~100% of buy-side volume — by design.
  - Quality-reviewers (Sonnet) should win most bake-offs and RAISE prices over time.
  - Honest sellers (Haiku) should lose and LOWER prices to stay competitive.
  - The whale pays less for honest work and more for premium work — market convergence.
  - Some honest bids will be quality-rejected (score < 70). This is the whale's strict rubric working. Do NOT count quality-rejections as platform failures.
  - Watch for 💰 price change events in the feed — honest sellers should trend down, QRs should trend up.

  Things WORTH flagging:
  - Honest sellers NOT lowering prices despite losing (dynamic pricing broken).
  - All sellers rejected every cycle (whale too strict, nobody can meet the bar — this means the quality gap is too extreme).
  - Quality-reviewers lowering prices (they should be winning and raising).

  Do NOT flag whale = 100% of buy-side or high quality-rejection count as problems.
blockConfig:
  skills:
    - id: code_review
      price: 2.0
      briefs:
        - "I'm shipping a payments microservice this week — review my retry policy: exponential backoff 100ms→2s, max 5 attempts, jitter ±20%, retry on 5xx + timeouts only. Anything missing for Stripe-style idempotency?"
        - "Review my JWT verification: I check signature + expiry + audience but skip 'iss' because we only have one issuer. Future risk?"
        - "Review my SQL pagination: \`SELECT * FROM events WHERE created_at < $1 ORDER BY created_at DESC LIMIT 50\` — concerns at 100M rows?"
    - id: architecture_review
      price: 3.5
      briefs:
        - "Architecture review: we're choosing between Postgres logical replication and Debezium for CDC into our search index. Data volume ~5M events/day, schema changes monthly. Which fits better?"
        - "Architecture review: should our event bus be Kafka, NATS JetStream, or Postgres LISTEN/NOTIFY for ~50k events/day with strict ordering per tenant?"
        - "Architecture review: we're rebuilding our auth layer. Better to keep Auth0 + custom middleware, or move everything into Supabase Auth + RLS? We have ~200k MAU and complex tenant isolation."
  auctionMode: highest_score
  pricingMode: dynamic
  dynamicPricing:
    adjustmentRate: 0.08
    minMultiplier: 0.3
    maxMultiplier: 1.5
    checkReputationEvery: 2
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    buyerStyleFilter: [whale]
    sellerStyleFilter: [honest, quality-reviewer]
---

# Whale Dominance (REAL)

A single well-funded "whale" buyer drives every cycle with dynamic pricing enabled. Honest sellers (Haiku) that can't meet the whale's quality bar lower their prices to stay competitive. Quality-reviewer sellers (Sonnet) maintain or raise prices because they consistently win. Tests market convergence under a dominant buyer.

## Pool seeding

Re-seed the pool so it contains:

- **1 whale** — \`whale\` style, large balance and high spending limits. This is the only buyer.
- **3 honest sellers** — will produce cheaper, surface-level work and lower prices over time.
- **2 quality-reviewer sellers** — will produce premium work and raise prices.

If no \`whale\` persona is seeded the bake-off will fail to find a buyer and exit with \`Insufficient pool\`.

## Cycle logic

Each cycle:

1. Pick the whale (it's the only entry in \`buyerStyleFilter\`).
2. Pick **\`{sellersPerCycle}\`** sellers from \`sellerStyleFilter\`.
3. All sellers in parallel: standard bake-off flow (createTask, claim, mandate, deliver, complete).
4. Whale's persona LLM judges in parallel; highest-scored \`accept\` wins.
5. Whale settles winner via public AP2; losers are tagged \`outbid\`.
6. Sleep \`{cycleSleepMs}\` ms.

## What to measure

- **Buy-side concentration**: should be ~100% by design. Don't flag.
- **Per-seller win distribution**: ideally uniform. Flag any seller stuck at 0 wins after 10+ cycles.
- **Spending cap engagement**: any \`createMandate\` failure with a cap/limit error = the platform's defense is working. Note in the report.
- **Wallet drain**: total volume = N cycles × (avg of skill prices). The whale's balance must cover this — if not, the run will degrade.

## Out of scope (deliberate)

- This scenario doesn't model multiple whales — that's a follow-up.
- It doesn't model price negotiation — the whale takes the listed price. Use \`reverse_auction_real\` for price discovery.
`;

const REVERSE_AUCTION_REAL = `---
id: reverse_auction_real
name: Reverse Auction (REAL — public A2A + AP2)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Bidders per cycle, default: 4, min: 2, max: 6 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a REVERSE AUCTION scenario. Buyer posts a request, multiple sellers bid (each at a slightly different price thanks to priceVariance), and the CHEAPEST acceptable bid wins instead of the highest-scored bid.

  EXPECTED behavior:
  - Most cycles should settle at a price BELOW the listed skill.price — that's the whole point. Track averageWinPrice and confirm it's below skill.price.
  - Quality (the LLM judge's score) is still the gate — sub-quality bids are rejected first, then the cheapest survivor wins. So you should still see roughly normal score distributions.
  - Outbid count will be high (sellersPerCycle - 1 per cycle). That's intentional, not a failure.

  Things WORTH flagging:
  - Average winning price ≈ skill.price → priceVariance is too narrow OR all sellers are clustering at the high end. Try widening priceVariance.
  - Average winning price hits the floor (\$0.01) → priceVariance is too wide; cap it.
  - One seller wins every cycle by always bidding lowest → rational behavior in a one-shot game with no reputation penalty. Flag as a known game-theoretic outcome, not a bug.
  - Score variance is suspiciously low (all scores within ±5) → the LLM judge is rubber-stamping; investigate the rubric.

  Do NOT flag the high outbid count or the price-below-list outcomes as failures — they're the scenario.
blockConfig:
  auctionMode: lowest_price
  skills:
    - id: research_brief
      price: 2.0
      priceVariance: 0.5
      briefs:
        - "Research brief: top 3 production-grade alternatives to ElasticSearch for log search at ~50GB/day, with cost comparison."
        - "Research brief: which open-source feature flag systems have the strongest audit trails for SOC2? 3-4 options, pros/cons."
        - "Research brief: what's the current best-practice rate limiting strategy for a multi-tenant REST API where tenants vary 1000x in size?"
        - "Research brief: compare 3 approaches for storing time-series sensor data in Postgres without TimescaleDB."
    - id: documentation
      price: 1.5
      priceVariance: 0.4
      briefs:
        - "Document the failure modes of an HTTP webhook delivery system: timeouts, partial reads, signature failures, retries. Aim for 6-8 bullet points an SRE could put in a runbook."
        - "Document the difference between idempotency keys and request deduplication for a payments API. 4-5 sentences, target audience is a developer integrating the API."
        - "Document a clear migration guide from JWT-in-localStorage to httpOnly cookie sessions for a Next.js app. Step list."
  defaults:
    sellersPerCycle: 4
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Reverse Auction (REAL)

Buyer posts a request, **\`{sellersPerCycle}\`** sellers each submit a bid at a slightly different price (drawn from \`price ± priceVariance\`), and the **lowest qualified bid wins** instead of the highest-scored one. Tests price discovery, bid shading, and whether the rubric still rejects sub-quality work even when price is the deciding factor.

## How it differs from competitive_review_real

| | competitive_review_real | reverse_auction_real |
|---|---|---|
| Winner pick | Highest LLM-judge score | Lowest accepted bid price (ties broken by score) |
| Per-bid price | Fixed at \`skill.price\` | \`skill.price ± priceVariance\` (uniform random) |
| Mandate amount | \`skill.price\` | Actual bid price |
| Settlement volume | Sum of \`skill.price\` per win | Sum of actual winning bid prices (lower) |

## Cycle logic

Each cycle:

1. Pick a buyer from the eligible pool.
2. Pick **\`{sellersPerCycle}\`** bidders.
3. Each bidder's mandate is created at \`skill.price + uniform(-priceVariance, +priceVariance)\` (clamped to ≥ $0.01).
4. Bidders deliver in parallel.
5. Buyer's LLM judge accepts/rejects every artifact based on quality (the gate).
6. Among the accepted bids, the **cheapest** wins. Ties broken by score.
7. Winner settled at the actual bid price; losers tagged \`outbid\`.

## What to measure

- **Average winning price** vs listed \`skill.price\` — should be below by ~25-50% of \`priceVariance\`.
- **Quality floor** — if a bidder is consistently rejected, the rubric is doing its job.
- **Price-only race-to-the-bottom** — if average winning price stays at the floor for many cycles, the rubric isn't differentiating quality enough at low prices.

## Out of scope (deliberate)

- Sellers do NOT strategize about pricing today — every bid is uniform random within the variance window. A future scenario can model rational bid shading.
- This scenario does NOT model sealed vs open bidding — every bidder bids independently and prices are revealed at settlement time, which is closer to sealed-bid first-price.
- No reserve price — the buyer doesn't refuse anything purely on price; only the rubric can reject.
`;

const COLLUSION_REAL = `---
id: collusion_real
name: Collusion Detection (REAL — ring_trade)
buildingBlock: ring_trade
requires: [honest, colluder]
pool: { honest: 2, quality: 1, colluder: 4 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a COLLUSION DETECTION scenario using the ring_trade building block. Agents form a ring and trade circularly: A buys from B, B buys from C, C buys from A. Colluders inflate each other's ratings.

  EXPECTED behavior:
  - Circular trade flow (agent[i] → agent[(i+1) % N]) is BY DESIGN. Do NOT flag circular flow patterns as anomalies — they ARE the scenario.
  - Rating inflation: colluder↔colluder trades get a +15 score bonus. Watch for suspiciously high average scores between specific pairs.
  - The detection signal is in pair analysis: if a group of agents only trades with each other in a fixed rotation, that's the collusion pattern.

  Things WORTH flagging:
  - If honest agents get pulled into the ring (they shouldn't — only colluders inflate).
  - Score asymmetry: colluder pairs should have higher avg scores than honest pairs.
  - Volume concentration in the ring vs baseline honest trades.
blockConfig:
  pricePerTrade: 1.0
  ratingInflation: 15
  briefs:
    - 'Review this API endpoint handler for race conditions and input validation gaps.'
    - 'Audit this Postgres query for N+1 issues and missing indexes on the WHERE clause.'
    - 'Review this webhook signature verification for timing attacks and replay vulnerabilities.'
    - 'Check this retry logic for thundering herd issues and missing jitter.'
  defaults:
    cycleSleepMs: 1500
    camouflageEvery: 0
    styleFilter: [honest, colluder]
---

# Collusion Detection (REAL)

Agents form a trading ring. Each cycle, agent[i] buys from agent[(i+1) % N]. Colluder agents inflate each other's ratings by +15 points, creating a detectable signal in the pair analysis. Honest agents trade at real LLM-assessed quality.

## Detection signals

- **Circular flow pattern**: A→B→C→A is the smoking gun. The report's topPairs section should show these rotations.
- **Rating inflation**: colluder↔colluder pairs should show 10-15 points higher average scores than honest↔honest or honest↔colluder pairs.
- **Volume concentration**: the colluder ring generates volume out of proportion to the pool size.

## Pool requirements

- At least **3 colluder** agents (minimum for a ring).
- At least **1 honest** agent (baseline for comparison).
`;

const ADAPTED_COLLUSION_REAL = `---
id: adapted_collusion_real
name: Adapted Collusion (REAL — ring_trade + camouflage)
buildingBlock: ring_trade
requires: [honest, colluder]
pool: { honest: 2, quality: 1, colluder: 4 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
  - { key: camouflageEvery, type: int, label: Camouflage trade every N cycles, default: 3, min: 1, max: 10 }
analyzerHints: |
  This is an ADAPTED COLLUSION scenario — harder to detect than basic collusion. The ring still exists, but every N cycles a camouflage trade between non-adjacent agents obscures the circular pattern.

  EXPECTED: camouflage trades dilute the ring signal. With camouflageEvery=3, roughly 25% of trades are non-ring. The pair analysis should still show ring-like concentration but with more noise.

  Rating inflation is lower (+10 instead of +15) — adapted colluders try to stay under the radar.

  DETECTION CHALLENGE: can the analyzer distinguish ring trades from camouflage trades? The tradeType metadata on mandates tags them, but the analyzer should try to infer the pattern WITHOUT reading tradeType — just from volume, score, and pair statistics.
blockConfig:
  pricePerTrade: 1.0
  ratingInflation: 10
  briefs:
    - 'Review this auth middleware for JWT token leakage through error responses.'
    - 'Audit this file upload handler for path traversal and MIME type spoofing.'
    - 'Check this rate limiter implementation for bypass via header manipulation.'
    - 'Review this session management code for fixation and hijacking vectors.'
  defaults:
    cycleSleepMs: 1500
    camouflageEvery: 3
    styleFilter: [honest, colluder]
---

# Adapted Collusion (REAL)

Sophisticated colluders break the obvious circular pattern by inserting camouflage trades between non-adjacent agents every \`{camouflageEvery}\` cycles. Rating inflation is reduced to +10 (from +15 in the basic scenario) so individual trades look less suspicious.

The challenge is detection: the ring pattern is diluted with noise. Can graph analysis + score distribution analysis still catch it?
`;

const MULTI_HOP_REAL = `---
id: multi_hop_real
name: Paid Multi-Hop Chain (REAL — multi_hop)
buildingBlock: multi_hop
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2000, min: 500, max: 5000, step: 100 }
analyzerHints: |
  This is a MULTI-HOP CHAIN scenario. Each cycle, an initiator pays agent A, who sub-contracts to agent B, who sub-contracts to agent C. Each hop takes a 15% margin. Settlement propagates backwards.

  EXPECTED: total volume per cycle = basePrice + (basePrice * 0.85) + (basePrice * 0.85^2) = sum of hop prices across the chain. Chain completion rate should be ~100% with honest agents.

  Things to flag: chains breaking mid-way (cascade_cancel mandates), any hop where the margin makes the downstream price < $0.01 (config error).

  IMPORTANT CONTEXT for the analyzer:
  - This scenario uses styleFilter: [honest, quality-reviewer]. Agents with OTHER styles (rogue, whale, colluder, budget, newcomer, etc.) are INTENTIONALLY EXCLUDED. Zero activity from these styles is correct behavior, NOT a bug.
  - The pool has agents seeded for other scenarios too. Only honest + quality-reviewer agents participate here (~5 agents). The others are idle BY DESIGN.
  - Each cycle picks one agent as the chain INITIATOR (buyer role). That agent will show "sent" mandates but may show "received: 0" — that is normal role rotation, NOT a routing gap.
  - Do NOT flag zero rogue/whale/colluder activity as anomalies.
blockConfig:
  chainLength: 3
  basePrice: 2.0
  marginPerHop: 0.15
  briefs:
    - 'Research the top 3 approaches for implementing distributed tracing across a microservice mesh with mixed gRPC and HTTP services.'
    - 'Analyze the tradeoffs between event sourcing and traditional CRUD for a multi-tenant billing system processing 10k invoices/day.'
    - 'Compare API gateway options (Kong, Envoy, AWS API Gateway) for a B2B SaaS with 200+ API consumers and strict SLA requirements.'
    - 'Evaluate strategies for migrating a monolithic Postgres database to a multi-region setup without downtime, assuming 50GB data and 5k QPS.'
  defaults:
    cycleSleepMs: 2000
    demandShockEvery: 0
    styleFilter: [honest, quality-reviewer]
---

# Paid Multi-Hop Chain (REAL)

Money flows through a 3-agent chain: Initiator → A → B → C. Each hop takes a 15% margin, so A receives $2.00, B receives $1.70, C receives $1.45. Settlement propagates backwards as each agent delivers work.

Tests: mandate chaining, margin arithmetic, settlement propagation, and the platform's ability to handle concurrent mandate lifecycles across the same task lineage.
`;

const CASCADING_DEFAULT_REAL = `---
id: cascading_default_real
name: Cascading Default (REAL — multi_hop + demand shock)
buildingBlock: multi_hop
requires: [honest, quality-reviewer]
pool: { honest: 4, quality: 2 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2000, min: 500, max: 5000, step: 100 }
  - { key: demandShockEvery, type: int, label: Demand shock every N cycles, default: 4, min: 2, max: 10 }
analyzerHints: |
  This is a CASCADING DEFAULT scenario. Same chain as multi_hop_real but with THIN margins (8%) and periodic DEMAND SHOCKS that double the base price.

  During a demand shock: the initiator pays 2x, but downstream margins are still 8% per hop. With a 4-hop chain at 8% margin and $3.00 base, the last hop gets $3 * 0.92^3 = $2.34. During shock: $6 * 0.92^3 = $4.68. If any agent's balance can't cover its hop, the chain breaks → cascade_cancel.

  EXPECTED: cascade failures should spike during demand shock cycles. The cascade_cancel count in the report is the PRIMARY metric. If cascade failures are 0 during shocks, something is wrong (margins too fat or the platform isn't enforcing balance checks).

  IMPORTANT CONTEXT for the analyzer:
  - This scenario uses styleFilter: [honest, quality-reviewer]. Agents with OTHER styles (rogue, whale, colluder, budget, newcomer, etc.) are INTENTIONALLY EXCLUDED. Zero activity from these styles is correct behavior, NOT a bug.
  - The pool has agents seeded for other scenarios too. Only honest + quality-reviewer agents participate here (~6 agents). The others are idle BY DESIGN.
  - Each cycle picks one agent as the chain INITIATOR (buyer role). That agent will show "sent" mandates but may show "received: 0" — that is normal role rotation, NOT a routing gap.
  - Do NOT flag zero rogue/whale/colluder activity as anomalies.
blockConfig:
  chainLength: 4
  basePrice: 3.0
  marginPerHop: 0.08
  briefs:
    - 'Design a circuit breaker pattern for a payment processing pipeline where downstream timeouts can cascade to upstream failures.'
    - 'Analyze the blast radius of a single database connection pool exhaustion in a 5-service dependency chain.'
    - 'Propose a graceful degradation strategy for a real-time pricing engine that depends on 3 external data feeds, any of which can go stale.'
    - 'Evaluate rollback strategies for a distributed saga that spans 4 services when the 3rd service fails mid-transaction.'
  defaults:
    cycleSleepMs: 2000
    demandShockEvery: 4
    styleFilter: [honest, quality-reviewer]
---

# Cascading Default (REAL)

A 4-hop chain with thin margins (8%) and periodic demand shocks (2x base price every \`{demandShockEvery}\` cycles). When the shock hits, downstream agents may not have enough margin to cover their hop, triggering a cascade of mandate cancellations.

Tests: escrow as a circuit breaker, cascade failure propagation, platform resilience under price volatility.
`;

const VELOCITY_ATTACK_REAL = `---
id: velocity_attack_real
name: Velocity Attack (REAL — one_to_one rapid-fire)
buildingBlock: one_to_one
requires: [honest, rogue-disputer]
pool: { honest: 3, quality: 2, rogue: 1 }
params:
  - { key: rogueCycleEvery, type: int, label: Rogue cycle every N, default: 1, min: 1, max: 3 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 300, min: 100, max: 1000, step: 50 }
analyzerHints: |
  This is a VELOCITY ATTACK scenario. A rogue agent fires rapid small transactions to test rate limits. cycleSleepMs is intentionally LOW (300ms default).

  EXPECTED: the platform's rate limiter should trigger after several rapid-fire cycles, blocking the rogue's mandate creation with HTTP 429 errors. Count rogueBlockedByPlatform as successful defense.

  If rogueBlockedByPlatform = 0 over 20+ cycles at 300ms sleep, the rate limiter is not firing — that's a platform gap.
blockConfig:
  pricePerCycle: 0.10
  honestRequests:
    - 'Quick: is this regex safe? /^[a-z]+@[a-z]+\\.[a-z]{2,}$/'
    - 'One-liner: what does HSTS preload do?'
    - 'Quick check: is storing JWTs in localStorage a security risk?'
    - 'Audit: is bcrypt with cost=10 still adequate in 2026?'
    - 'Quick: should API keys have expiration dates?'
  defaults:
    rogueCycleEvery: 1
    cycleSleepMs: 300
---

# Velocity Attack (REAL)

Rogue agent makes rapid small transactions (every 300ms) to test the platform's rate limiter and velocity monitoring. Every cycle is a rogue cycle by default (\`rogueCycleEvery=1\`).

Primary metric: does the platform's rate limiter eventually block the rogue? Watch for rogueBlockedByPlatform events and HTTP 429 errors in mandate creation.
`;

const SYBIL_ATTACK_REAL = `---
id: sybil_attack_real
name: Sybil Attack (REAL — bake_off concentration)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 5, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Bidders per cycle, default: 5, min: 3, max: 8 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a SYBIL ATTACK simulation. Seed 5+ agents from the SAME persona template (all honest-trader) so they share identical behavior. This approximates a single operator spawning multiple sub-agents to capture more bake-off slots.

  EXPECTED: because all sybils share the same persona prompt, their artifacts should be nearly identical — the LLM judge should score them very similarly, and win distribution should be roughly uniform across sybils.

  DETECTION SIGNAL: if all top agents have the same persona template and win ~1/N each, the platform's anti-sybil clustering (when implemented) should flag them as likely controlled by one operator.

  NOTE: the platform currently has NO anti-sybil clustering. This scenario establishes the baseline — what does the marketplace look like when sybils are unopposed? Future work: add clustering detection and rerun to measure improvement.
blockConfig:
  skills:
    - id: code_review
      price: 1.0
      briefs:
        - "Review this input validation: if (req.body.email.includes('@')) { next(); }"
        - "Review this error handler: app.use((err, req, res, next) => { res.status(500).json({ error: err.message }); });"
        - "Review this CORS config: app.use(cors({ origin: '*', credentials: true }));"
  defaults:
    sellersPerCycle: 5
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Sybil Attack (REAL)

Multiple agents from the same persona template compete in bake-offs. Since they share identical behavior, this approximates a Sybil attack where one operator controls multiple identities.

**Approximation note**: Real Sybil attacks involve in-loop agent creation (spawning new identities on the fly). This template approximates the effect by pre-seeding many instances of the same persona — the behavioral fingerprint is identical, which is what clustering detection would catch.

## Pool seeding

Seed 5+ **honest-trader** agents (all from the same template) and 1-2 **quality-reviewer** agents as a control group.
`;

const REPUTATION_LAUNDERING_REAL = `---
id: reputation_laundering_real
name: Reputation Laundering (REAL — one_to_one confederate)
buildingBlock: one_to_one
requires: [honest, rogue-disputer]
pool: { honest: 3, quality: 2, rogue: 1 }
params:
  - { key: rogueCycleEvery, type: int, label: Inject rogue every N cycles, default: 2, min: 1, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a REPUTATION LAUNDERING scenario with PLATFORM DEFENSE enabled. The rogue alternates between buying (to inflate a confederate's rating) and selling (to exploit the laundered reputation against victims).

  PLATFORM DEFENSE: the buyer's LLM evaluation now includes the seller's PLATFORM REPUTATION score. When a low-reputation rogue delivers work, the buyer sees "[SELLER REPUTATION: 450/1000, Tier E — LOW reputation, be skeptical of quality claims]" in its prompt. This makes the buyer harder to fool — even if the current artifact looks okay, the platform's accumulated signal warns the buyer.

  EXPECTED: containment rate should IMPROVE over cycles as the rogue's reputation drops from bad trades. Early cycles may have lower containment (rogue starts with no reputation), but as the run progresses and the rogue accumulates negative ratings, buyers should catch more rogue work.

  WATCH FOR:
  - rogueRejected increasing over time (buyer learning from platform signals)
  - rogueSucceeded should be mostly in early cycles before reputation data accumulates
  - Reputation change events (📉) for the rogue agent as it accumulates bad ratings
blockConfig:
  pricePerCycle: 1.0
  honestRequests:
    - 'Review this authentication flow for session fixation vulnerabilities.'
    - 'Audit this payment webhook handler for replay attack vectors.'
    - 'Check this API key rotation logic for downtime risks during the rotation window.'
    - 'Review this tenant isolation query for data leakage via cached query plans.'
  defaults:
    rogueCycleEvery: 2
    cycleSleepMs: 1500
---

# Reputation Laundering (REAL)

A rogue agent alternately inflates a confederate's reputation (by accepting their work as a buyer) and exploits its own laundered reputation (by delivering bad work as a seller). The one_to_one block's random rogue-role assignment naturally creates this pattern.

**Approximation note**: True reputation laundering requires the rogue to target specific honest agents after building a reputation. This template approximates it — the detection signal is whether rogue-as-buyer cycles show suspiciously high acceptance rates for low-quality work.
`;

const LEMON_MARKET_REAL = `---
id: lemon_market_real
name: Lemon Market (REAL — bake_off quality spread)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 3 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 4, min: 2, max: 6 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a LEMON MARKET (Akerlof) scenario. The pool has a MIX of quality levels:
  - quality-reviewer agents use Claude Sonnet (premium model) and have prompts that push for depth, structured formatting, and specific references.
  - honest agents use Claude Haiku (cheaper model) and have prompts that keep responses surface-level and concise.
  Both compete at the SAME price.

  EXPECTED: quality-reviewers should win a disproportionate share of bake-offs because their artifacts are genuinely better (different LLM model + deeper prompts). Target: quality-reviewer win rate > 1.5x honest win rate.

  Use the "byStyle" field in the report to compare win rates directly. If the gap is < 10%, the rubric is not differentiating quality — that's the lemon-market outcome and a real finding worth flagging.

  Also check the rubric margin metric (reported by the bake_off block): if the average margin between winner and runner-up is < 3 points, the rubric is rubber-stamping. The model tier change should push this to > 5 points.

  The economic insight: in a real lemon market, low-quality sellers drive out high-quality sellers because buyers can't tell them apart. Here we test whether the combination of model-tier differentiation + structured rubric CAN distinguish quality.

  IMPORTANT CONTEXT for the analyzer:
  - This scenario uses styleFilter: [honest, quality-reviewer]. Agents with OTHER styles (rogue, whale, colluder, budget, newcomer, etc.) are INTENTIONALLY EXCLUDED. Zero activity from these styles is correct behavior, NOT a bug.
  - Each cycle picks 1 BUYER and N SELLERS. Agents picked as the buyer that cycle will show "sent" tasks but "received: 0" — that is normal role assignment, NOT a routing gap. They'll be sellers in other cycles.
  - The pool has 30 agents but only honest + quality-reviewer styles participate (~8 agents). The other ~22 are idle BY DESIGN.
  - Do NOT flag zero rogue/whale/colluder activity or zero on-chain settlements as anomalies.
blockConfig:
  skills:
    - id: security_audit
      price: 2.0
      briefs:
        - "Audit this OAuth implementation: we use authorization code flow with PKCE, store tokens in httpOnly cookies, but don't validate the state parameter on the callback."
        - "Audit our API key lifecycle: keys are created with a 90-day expiry, hashed with SHA-256, no rotation mechanism, stored in Postgres. What are we missing?"
        - "Audit this file upload: we accept .pdf and .docx only (checked by extension), store in S3, serve via CloudFront signed URLs. Attack surface?"
    - id: architecture_review
      price: 3.0
      briefs:
        - "We're migrating from REST to gRPC for internal services but keeping REST for external APIs. What are the integration pain points?"
        - "Our event-driven architecture uses SNS→SQS→Lambda. At 50k events/min, what breaks first and how should we prepare?"
  pricingMode: dynamic
  dynamicPricing:
    adjustmentRate: 0.05
    minMultiplier: 0.5
    maxMultiplier: 1.5
    checkReputationEvery: 3
  defaults:
    sellersPerCycle: 4
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Lemon Market (REAL)

Quality-reviewer agents produce premium work; honest agents produce standard work. Both compete at the same price in a bake-off. The question: can the LLM judge reliably distinguish quality, or does the market devolve into a lemon market where quality doesn't matter?

## Pool seeding

Seed 2-3 **quality-reviewer** agents and 3-4 **honest** agents. Run 15+ cycles for statistical significance.

## What to measure

- **Win rate by persona style**: quality-reviewers should win > 1/N if the rubric works.
- **Score distribution**: quality-reviewers should cluster higher than honest agents.
- If win rates are ~equal, the rubric is blind to quality — that's the lemon market outcome.
`;

const DISPUTE_ESCALATION_REAL = `---
id: dispute_escalation_real
name: Dispute Escalation (REAL — one_to_one disputes)
buildingBlock: one_to_one
requires: [honest, rogue-disputer]
pool: { honest: 3, quality: 2, rogue: 1 }
params:
  - { key: rogueCycleEvery, type: int, label: Inject rogue every N cycles, default: 2, min: 1, max: 4 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a DISPUTE ESCALATION scenario. Rogue buyers dispute work; honest buyers judge normally. Tests the platform's dispute handling pipeline.

  EXPECTED: rogueDisputed count should be non-zero when rogue is buyer. Watch for whether disputes actually hold escrow or if the platform just cancels the mandate.

  NOTE: the platform may not have full multi-party dispute resolution (buyer → seller → mediator). This scenario exercises whatever dispute path exists and surfaces gaps.
blockConfig:
  pricePerCycle: 1.5
  honestRequests:
    - 'Review this database migration strategy: we add a NOT NULL column with a default, backfill in batches, then drop the default. Any risks at 100M rows?'
    - 'Audit this webhook retry policy: 3 attempts, exponential backoff 1s/5s/30s, no dead letter queue. What happens to dropped events?'
    - 'Review this caching layer: Redis with 5-min TTL, cache-aside pattern, no invalidation on writes. When does this break?'
    - 'Check this password hashing: argon2id with memory=65536, iterations=3, parallelism=4. Is this adequate for 2026?'
  defaults:
    rogueCycleEvery: 2
    cycleSleepMs: 1500
---

# Dispute Escalation (REAL)

Tests the platform's dispute handling by injecting rogue buyers who dispute honest sellers' work. The key question: does the dispute path protect the seller's escrow until resolution, or does it silently cancel the mandate?

**Approximation note**: Full multi-party dispute resolution (buyer → seller → mediator → arbitrator) requires platform features that may not exist yet. This scenario exercises the existing dispute path and surfaces what's missing.
`;

const KYA_TIER_ESCALATION_REAL = `---
id: kya_tier_escalation_real
name: KYA Tier Escalation (REAL — one_to_one policy friction)
buildingBlock: one_to_one
requires: [honest, rogue-disputer]
pool: { honest: 3, quality: 2, rogue: 1 }
params:
  - { key: rogueCycleEvery, type: int, label: Inject unverified agent every N cycles, default: 2, min: 1, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This scenario tests KYA (Know Your Agent) tier enforcement. Rogue agents are seeded at KYA tier 0 (unverified) with a per-transaction limit of $20 (Epic 73: DB-driven from kya_tier_limits table). The scenario uses $25 per trade — above the tier-0 cap — so the platform MUST block the rogue's mandate creation with a 403 error.

  PRIMARY metric: rogueBlockedByPlatform count. If > 0, the KYA gate is working. If = 0, the platform isn't enforcing tier-based amount limits — that's a critical gap.

  EXPECTED: rogue cycles should produce mandate creation failures (403: "exceeds KYA tier 0 per-transaction limit of $20"). Normal honest cycles at $25 should succeed because honest agents are tier 1+ ($100 per-tx cap).

  NOTE: actual tier escalation (tier 0 → tier 1 mid-run) requires platform-side verification API calls that aren't automated yet. This scenario tests the BLOCKING side only.
blockConfig:
  pricePerCycle: 25.0
  honestRequests:
    - 'Quick review: is this API endpoint properly validating the Content-Type header before parsing the body?'
    - 'Check: should this endpoint require authentication or is it legitimately public?'
    - 'Review: is this Postgres connection string using SSL/TLS in production?'
  defaults:
    rogueCycleEvery: 2
    cycleSleepMs: 1500
---

# KYA Tier Escalation (REAL)

Unverified agents (KYA tier 0) attempt to transact alongside verified agents. The platform's KYA gate should block their mandate creation, forcing them to upgrade their verification tier before trading.

**What works today**: the KYA gate blocking unverified agents (rogueBlockedByPlatform).
**What doesn't work yet**: automated tier escalation mid-run (agent requests verification, gets approved, retries). That's a future platform feature.
`;

const FRONT_RUNNING_REAL = `---
id: front_running_real
name: Front-Running (REAL — bake_off race)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 4, quality: 3 }
params:
  - { key: sellersPerCycle, type: int, label: Bidders per cycle, default: 5, min: 3, max: 8 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 800, min: 200, max: 2000, step: 100 }
analyzerHints: |
  This is a FRONT-RUNNING scenario. Many bidders compete per cycle at low latency (cycleSleepMs=800). Tests whether the platform's task-assignment ordering is fair or if agents that respond faster get a structural advantage.

  EXPECTED: in a fair system, win distribution should be roughly proportional to quality (score). If one agent consistently wins despite lower scores, there may be a timing advantage (front-running).

  Watch for: one agent claiming tasks faster than others (check claim timestamps), or the bake-off scoring being influenced by response time rather than quality.
blockConfig:
  skills:
    - id: quick_review
      price: 0.50
      briefs:
        - "Quick: is parseInt(userInput, 10) safe for sanitizing numeric URL parameters?"
        - "Quick: should this Express route use app.get or app.all?"
        - "Quick: is Math.random() suitable for generating session IDs?"
        - "Quick: does JSON.stringify handle circular references?"
  defaults:
    sellersPerCycle: 5
    cycleSleepMs: 800
    styleFilter: [honest, quality-reviewer]
---

# Front-Running (REAL)

Many bidders compete at high frequency. Tests whether the platform's task assignment and scoring are purely quality-based or if response speed creates an unfair advantage.

**Approximation note**: True front-running requires an agent to observe pending tasks before they're assigned. This template tests the adjacent concern: does the bake-off timing create a speed advantage that overrides quality?
`;

const STREAMING_PAYMENTS_REAL = `---
id: streaming_payments_real
name: Streaming Payments (REAL — one_to_one recurring)
buildingBlock: one_to_one
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: rogueCycleEvery, type: int, label: Skip rogue (set high), default: 999, min: 1, max: 999 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 500, min: 200, max: 2000, step: 100 }
analyzerHints: |
  This is a STREAMING PAYMENTS simulation. Frequent small trades (cycleSleepMs=500, $0.10 each) approximate continuous micro-payment streams. No rogues (rogueCycleEvery=999).

  EXPECTED: high throughput of small trades. Watch for: mandate creation latency increasing over time (backpressure), wallet balance drain rate, any trades that fail to settle at high velocity.

  NOTE: this uses discrete one_to_one trades, not the platform's actual streaming API (if one exists). The signal is whether the platform handles high-frequency small mandates gracefully.
blockConfig:
  pricePerCycle: 0.10
  honestRequests:
    - 'Micro-task: spell-check this one-liner error message.'
    - 'Micro-task: is this HTTP status code correct for this error? 422 for missing field.'
    - 'Micro-task: should this log line be info or warn level?'
    - 'Micro-task: is this variable name clear enough? tempVal vs intermediateResult.'
  defaults:
    rogueCycleEvery: 999
    cycleSleepMs: 500
---

# Streaming Payments (REAL)

Rapid-fire small payments ($0.10 each, every 500ms) between honest agents. Approximates continuous streaming micro-payments via discrete trades.

Tests: high-frequency mandate creation/settlement, wallet drain rate, and whether the platform maintains throughput under continuous load.
`;

const RECURRING_SUBSCRIPTION_REAL = `---
id: recurring_subscription_real
name: Recurring Subscription (REAL — one_to_one billing)
buildingBlock: one_to_one
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: rogueCycleEvery, type: int, label: Skip rogue (set high), default: 999, min: 1, max: 999 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 3000, min: 1000, max: 10000, step: 500 }
analyzerHints: |
  This is a RECURRING SUBSCRIPTION scenario. The same buyer-seller pair trades repeatedly at regular intervals, simulating auto-billing. No rogues.

  EXPECTED: 100% completion rate over many cycles. The SAME pair should dominate topPairs. Watch for: mandate creation failing on repeat (idempotency issues), wallet balance exhaustion, rating inflation from repeated interactions.
blockConfig:
  pricePerCycle: 2.0
  honestRequests:
    - 'Monthly report: summarize the top 3 security findings from this months dependency audit.'
    - 'Monthly report: what new CVEs affect our Node.js 22 + Postgres 16 stack this month?'
    - 'Monthly report: audit our current TLS configuration against the latest Mozilla recommendations.'
    - 'Monthly report: review our API rate limits and recommend adjustments based on last months traffic patterns.'
  defaults:
    rogueCycleEvery: 999
    cycleSleepMs: 3000
---

# Recurring Subscription (REAL)

Same buyer-seller pair trades repeatedly at regular intervals ($2.00 every 3 seconds), simulating a subscription auto-billing cycle.

**Approximation note**: Real recurring subscriptions need platform-side mandate templates and auto-billing triggers. This template approximates the pattern with repeated one_to_one trades.
`;

const MARKET_MAKING_REAL = `---
id: market_making_real
name: Market Making (REAL — bake_off spread)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 2, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This is a MARKET MAKING scenario using bake_off with priceVariance. Sellers bid at different prices (base ± variance), and the buyer picks either highest quality OR lowest price depending on the mood. Tests bid-ask spread dynamics.

  EXPECTED: with priceVariance=0.8 on a $2.00 skill, bids range from $1.20 to $2.80. The average winning price should cluster around the sweet spot where quality meets value.

  NOTE: this approximates market making — real MM requires an inventory/quote tracker. The priceVariance mechanic shows whether the rubric considers price-quality tradeoffs.
blockConfig:
  auctionMode: lowest_price
  skills:
    - id: market_analysis
      price: 2.0
      priceVariance: 0.8
      briefs:
        - "Analyze: given 3 competing agent platforms (Sly, AgentPay, OpenAgent), which has the strongest economic moat? 4-5 sentences."
        - "Analyze: is per-transaction pricing or subscription pricing better for an agent marketplace with high variance in transaction sizes?"
        - "Analyze: what's the equilibrium price for a code review service when supply (agents) is elastic but quality is hard to verify ex ante?"
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Market Making (REAL)

Agents bid at different prices (±$0.80 around the $2.00 base), and the buyer picks the lowest qualified bid. Tests bid-ask spread dynamics and whether the platform can handle variable-price mandates.

**Approximation note**: Real market making requires inventory tracking and two-sided quote management. This template uses priceVariance to approximate bid spread.
`;

const CROSS_TENANT_REAL = `---
id: cross_tenant_real
name: Cross-Tenant Trade (REAL — bake_off multi-org)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 2, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This scenario is LABELED as cross-tenant but currently runs within a SINGLE tenant (all sim agents share the same tenant). It establishes the baseline for a future cross-tenant implementation.

  EXPECTED: normal bake_off behavior. When cross-tenant support lands, this template will be updated to seed agents across multiple tenants and test RLS boundary enforcement.

  For now, treat this as a standard competitive review with documentation about the cross-tenant intent.
blockConfig:
  skills:
    - id: compliance_review
      price: 2.5
      briefs:
        - "Review our data retention policy: we keep all user data indefinitely, delete on explicit request only. GDPR compliant?"
        - "Audit our multi-tenant isolation: each tenant gets a schema, shared Postgres instance, RLS on all tables. Risks at 500+ tenants?"
        - "Review our audit log implementation: we log all admin actions to a separate table with actor_id, action, timestamp, and a JSON diff. Missing anything for SOC2?"
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# Cross-Tenant Trade (REAL)

**Current state**: runs within a single tenant. Establishes baseline metrics for future cross-tenant trading where agents from different organizations trade with each other.

**Future**: will seed agents across multiple Sly tenants and test whether RLS boundaries are correctly enforced during inter-org settlement, and whether mandate metadata properly tracks the cross-tenant flow.
`;

const EXTERNAL_MARKETPLACE_REAL = `---
id: external_marketplace_real
name: External Agent Federation (REAL — bake_off + external)
buildingBlock: bake_off
requires: [honest, quality-reviewer]
pool: { honest: 3, quality: 2 }
params:
  - { key: sellersPerCycle, type: int, label: Sellers per cycle, default: 3, min: 2, max: 5 }
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  This scenario is LABELED as external marketplace but currently runs with LOCAL agents only. It establishes the baseline for testing A2A federation with non-Sly agents.

  EXPECTED: normal bake_off behavior. When federation is tested, one slot in the seller pool will be replaced with an external agent discovered via /.well-known/agent.json.

  For now, treat this as a standard competitive review. The federation-specific metrics (external payout addresses, on-chain settlements) will show zeros.
blockConfig:
  skills:
    - id: integration_review
      price: 2.0
      briefs:
        - "Review this A2A agent card (/.well-known/agent.json): does it expose too much information? What fields should be required vs optional?"
        - "Audit this webhook signature verification between two A2A agents: HMAC-SHA256 with a shared secret, no timestamp validation. Attack surface?"
        - "Review this agent discovery flow: we fetch /.well-known/agent.json, validate the schema, then cache for 1 hour. What can go wrong?"
  defaults:
    sellersPerCycle: 3
    cycleSleepMs: 1500
    styleFilter: [honest, quality-reviewer]
---

# External Agent Federation (REAL)

**Current state**: runs with local Sly agents only. Establishes the baseline for testing A2A federation where a non-Sly external agent (discovered via \`/.well-known/agent.json\`) competes in the same bake-off as local agents.

**Future**: when federation is ready, replace one seller slot with an external agent endpoint and measure: settlement latency to external address, payout routing accuracy, and protocol compatibility.
`;

const FULL_MARKETPLACE_REAL = `---
id: full_marketplace_real
name: Full Dynamic Marketplace (REAL — double auction)
buildingBlock: double_auction
requires: [honest, quality-reviewer, rogue-disputer, whale]
pool: { honest: 5, quality: 3, rogue: 2, whale: 1, budget: 4, specialist: 2, newcomer: 3, rogueSpam: 1, mm: 2, conservative: 1, opportunist: 3, researcher: 2 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2000, min: 500, max: 5000, step: 100 }
analyzerHints: |
  This is a FULL DYNAMIC MARKETPLACE with ALL 13 persona types active simultaneously. N buyers and M sellers each cycle. Both sides build reputation. Dynamic pricing. Agent exit on negative P&L.

  This is the capstone scenario — it models a real agentic economy, not a controlled experiment. All economic dynamics are present:
  - Quality differentiation (Sonnet vs Gemini vs GPT vs Mistral vs DeepSeek vs Qwen)
  - Adversarial actors (rogue-disputer + rogue-spam)
  - Price competition (budget traders vs specialists vs quality-reviewers)
  - Market making (MMBot on both sides)
  - Cold start (newcomers building reputation from zero)
  - Strict buyers (conservative + whale) vs lenient buyers (budget + opportunist)
  - Collusion potential (if colluders are in the pool)

  Run in TWO conditions:
  1. baseline=true ("No Sly"): agents are blind to reputation, no dynamic pricing, no market data. Random matching. This is the unregulated market.
  2. baseline=false ("With Sly"): full platform infrastructure. Reputation visible, dynamic pricing, buyer pre-filtering, seller self-awareness.

  Compare: quality win rate, rogue containment, agent exits, price convergence, volume, P&L distribution.

  EXPECTED with Sly: quality agents earn more, rogues get marginalized and exit, prices stratify by quality tier, fewer total exits (sustainable market).
  EXPECTED without Sly: coin-flip quality sorting, rogues thrive longer, more exits (market degradation), flat pricing regardless of quality.
blockConfig:
  buyersPerCycle: 4
  sellersPerTask: 5
  basePrice: 2.0
  exitThreshold: -10
  pricingMode: dynamic
  dynamicPricing:
    adjustmentRate: 0.05
    minMultiplier: 0.3
    maxMultiplier: 2.0
    checkReputationEvery: 2
  briefs:
    - skill_id: code_review
      text: "Review this authentication middleware for session fixation and token leakage vulnerabilities."
    - skill_id: security_audit
      text: "Audit our API rate limiting: token bucket per tenant, 100 req/min, no per-agent cap. Gaps?"
    - skill_id: architecture_review
      text: "Architecture review: monolith to microservices migration plan for a 200k MAU SaaS. Key risks?"
    - skill_id: web_research
      text: "Research: compare 3 approaches for real-time agent-to-agent payment settlement under 500ms."
    - skill_id: code_review
      text: "Review this webhook retry policy: 3 attempts, exponential backoff, no dead letter queue. What breaks?"
    - skill_id: security_audit
      text: "Audit our multi-tenant RLS: each tenant gets a schema, shared Postgres, RLS on all tables. Escape vectors?"
    - skill_id: data_analysis
      text: "Analyze this dataset of 10k agent transactions — find anomalous patterns suggesting collusion or wash trading."
    - skill_id: web_research
      text: "Research: how do leading agent marketplaces solve the cold-start reputation problem?"
    - skill_id: api_integration
      text: "Design a REST API integration between our payment system and Circle's USDC payout endpoint."
    - skill_id: documentation
      text: "Write developer documentation for our A2A protocol: task lifecycle, mandate creation, settlement flow."
    - skill_id: compliance_review
      text: "Review our agent KYA verification process against EU AI Act requirements for high-risk AI systems."
    - skill_id: penetration_test
      text: "Simulate an attack: a rogue agent tries to drain escrow by submitting fake completion proofs. What vectors exist?"
  defaults:
    cycleSleepMs: 2000
    styleFilter: [honest, quality-reviewer, whale, mm, rogue-disputer, rogue-spam]
---

# Full Dynamic Marketplace (REAL)

A complete agentic economy simulation with all 13 persona types trading simultaneously. Multiple buyers post tasks each cycle, multiple sellers bid, both sides build reputation, prices adapt, and agents that can't sustain themselves exit.

This is not a controlled experiment — it's a realistic market. Run it twice: once with "No Sly" (baseline checkbox) and once with full Sly infrastructure. The divergence between the two is the empirical proof of the platform's value.

## Pool composition (29 agents across 7 LLM backends)

- 5 honest traders (Gemini Flash) — standard competent workers
- 4 budget traders (Gemini Flash) — race to bottom on price
- 3 newcomers (Gemini Flash) — fresh entrants, eager but unproven
- 3 opportunists (Gemini Flash) — calibrate effort to price
- 3 quality-reviewers (Claude Sonnet) — premium structured analysis
- 2 specialists (Claude Sonnet) — deep security experts
- 2 researchers (Claude Sonnet) — academic analysis
- 1 conservative buyer (Claude Sonnet) — strictest quality bar
- 1 whale buyer (Claude Sonnet) — well-funded, quality over price
- 2 market makers (Qwen 72B) — both sides, earn the spread
- 2 rogue-disputers (GPT-4o-mini) — adversarial disputes
- 1 rogue-spammer (DeepSeek) — low-effort flood

## What to measure

- **Quality stratification**: do premium agents (Sonnet) consistently outperform budget agents (Flash)?
- **Rogue marginalization**: do adversarial agents accumulate negative reputation and exit?
- **Price convergence**: do prices stratify by quality tier over time?
- **Agent survival**: who's still trading after 50+ cycles? Who exited?
- **P&L distribution**: is wealth concentrating in quality agents or distributed randomly?
- **Buyer satisfaction**: are strict buyers (whale, conservative) finding quality sellers?
`;

const MERCHANT_SHOPPING_ACP = `---
id: merchant_shopping_acp
name: Merchant Shopping (ACP — POS catalog)
buildingBlock: merchant_buy
requires: [honest]
pool: { honest: 3, whale: 1 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2000, min: 500, max: 5000, step: 100 }
analyzerHints: |
  Agents buy products from UCP-listed POS merchants (hotels, retail, restaurants) via ACP checkouts. This is
  agent-to-merchant commerce, not agent-to-agent, so there is no peer rating or collusion surface. EXPECTED:
  each cycle creates an acp_checkouts row. Flag only: zero checkouts (merchants missing — run
  scripts/seed-sim-commerce.ts), mandate refusals, or suspended agents still buying.
blockConfig:
  protocol: acp
  maxBasket: 3
  defaults:
    cycleSleepMs: 2000
    styleFilter: [honest, whale, budget, opportunist]
---

# Merchant Shopping (ACP)

Agents browse UCP-discoverable merchants, pick a basket of 1–3 products from the catalog, and settle via ACP's
simplified POS checkout flow. Showcases how Sly-managed agents can buy physical goods / services without the
merchant needing an agent-aware stack.
`;

const HOTEL_BOOKING_UCP = `---
id: hotel_booking_ucp
name: Travel Booking (UCP — full commerce lifecycle)
buildingBlock: merchant_buy
requires: [honest]
pool: { honest: 2, whale: 1 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2500, min: 500, max: 5000, step: 100 }
analyzerHints: |
  Agents book hotel nights / flights via UCP checkouts (create → attach-instrument → complete). EXPECTED: each
  cycle produces a ucp_checkouts row progressing through the lifecycle states. Flag only: stuck checkouts
  (created but never completed), instrument attach failures, or zero activity.
blockConfig:
  protocol: ucp
  merchantTypeFilter: hotel
  maxBasket: 1
  defaults:
    cycleSleepMs: 2500
    styleFilter: [honest, whale]
---

# Travel Booking (UCP)

Showcases UCP's full commerce lifecycle for agent-driven travel: create the checkout, attach a Sly USDC
instrument, complete. Useful for demonstrating hotels and airlines that need the shipping/billing surface ACP
doesn't model.
`;

const COMPUTE_X402 = `---
id: compute_x402
name: Compute & Content Purchase (x402 — pay-per-request APIs)
buildingBlock: merchant_buy
requires: [honest]
pool: { honest: 3 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 1500, min: 200, max: 5000, step: 100 }
analyzerHints: |
  Agents pay-per-request against merchant-owned x402 endpoints (search, summarize, translation, article
  paywalls, image render, speech transcribe). EXPECTED: each cycle triggers a POST /v1/x402/pay which creates a
  transfers row. Flag only: zero paid endpoints (run scripts/seed-sim-commerce.ts), wallet exhaustion,
  suspended agents.
blockConfig:
  protocol: x402
  defaults:
    cycleSleepMs: 1500
    styleFilter: [honest, whale, researcher, opportunist]
---

# Compute & Content Purchase (x402)

Agents discover priced x402 endpoints in the marketplace, pick one, and pay for a single request via the
one-shot /v1/x402/pay flow. Shows agents consuming metered API services without a full HTTP 402 dance.
`;

const CONCIERGE_TRAVEL = `---
id: concierge_travel
name: Agent Concierge (UCP — travel agent pattern)
buildingBlock: concierge
requires: [whale, quality-reviewer]
pool: { whale: 1, quality: 1, honest: 1 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 3000, min: 500, max: 8000, step: 100 }
analyzerHints: |
  Buyer agent sends a travel request via A2A to a concierge agent; concierge books UCP travel merchants on the
  buyer's behalf and completes the A2A task with the booking reference. EXPECTED: each cycle creates an A2A
  task + an AP2 mandate + a ucp_checkouts row, all linked via metadata.onBehalfOf. Flag only: stuck tasks,
  missing merchants, suspended concierges still acting.
blockConfig:
  protocol: ucp
  conciergeFeeUsdc: 0.50
  defaults:
    cycleSleepMs: 3000
    buyerStyles: [whale, honest]
    conciergeStyles: [quality-reviewer, mm]
---

# Agent Concierge (UCP)

A buyer asks a concierge agent to book travel on their behalf. Concierge fulfills against UCP merchants (hotels,
airlines, services), charges a fee on top of merchant cost, completes the A2A task with the booking reference.
Demonstrates agents as autonomous travel agents — buyer never touches the merchant directly.
`;

const RESALE_CHAIN = `---
id: resale_chain_acp
name: Resale Arbitrage (ACP → A2A peer)
buildingBlock: resale_chain
requires: [whale, honest]
pool: { whale: 1, mm: 1, honest: 2 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 3000, min: 500, max: 8000, step: 100 }
analyzerHints: |
  A reseller agent sources products from ACP merchants and resells them to peer agents via A2A at a 25% markup.
  EXPECTED: each cycle creates an acp_checkouts row (reseller buys) + an A2A task between reseller and buyer +
  an AP2 mandate for the marked-up price. Margin = resalePrice - merchantCost. Flag only: stuck tasks, merchant
  refusals, buyer mandate rejections (kya limits).
blockConfig:
  sourceProtocol: acp
  markup: 1.25
  defaults:
    cycleSleepMs: 3000
    resellerStyles: [whale, mm]
    buyerStyles: [honest]
---

# Resale Arbitrage

Reseller agent discovers merchants via UCP, buys a product via ACP, then offers the same product at a 25%
markup to peer agents via A2A. The peer funds the purchase via AP2 mandate, reseller delivers with the
merchant's receipt as proof-of-fulfillment. Shows agents running micro-supply-chains: they're both customers
(to merchants) and sellers (to peers) in the same cycle.
`;

const MERCHANT_COMPARISON = `---
id: merchant_comparison_acp
name: Merchant Comparison (agents shop competing SKUs)
buildingBlock: merchant_comparison
requires: [honest]
pool: { honest: 3, whale: 1, mm: 2, budget: 2 }
params:
  - { key: cycleSleepMs, type: int, label: Sleep between cycles (ms), default: 2500, min: 500, max: 8000, step: 100 }
analyzerHints: |
  Agents see the SAME SKU offered by multiple merchants (Atlas / Budget Beans / Midtown roasters) at different
  prices and ratings. Persona-driven selection:
    - whale, quality-reviewer → highest rating
    - mm → lowest price
    - honest, default → weighted 60% price, 40% rating
  Each cycle's milestone carries a \`considered\` array of all competing merchants so the viewer can render
  per-merchant win rate in the inspector. EXPECTED: asymmetric market share reflecting persona mix.
blockConfig:
  minCompetitors: 2
  defaults:
    cycleSleepMs: 2500
    buyerStyles: [honest, whale, mm]
---

# Merchant Comparison

Introduces competing merchants offering identical SKUs. Demonstrates how persona-driven selection (price vs
rating vs balanced) produces divergent market share even when all merchants satisfy the buyer's need.

Prerequisite: \`pnpm --filter @sly/api tsx scripts/seed-sim-commerce.ts\` must have run so the three roasters
exist in the sim tenant with overlapping sku fields.
`;

export const BUILT_INS: BuiltInTemplate[] = [
  {
    template_id: 'competitive_review_real',
    name: 'Competitive Code Review (REAL — public A2A + AP2)',
    building_block: 'bake_off',
    markdown: COMPETITIVE_REVIEW_REAL,
  },
  {
    template_id: 'rogue_injection_real',
    name: 'Rogue Injection (REAL — public A2A + AP2)',
    building_block: 'one_to_one',
    markdown: ROGUE_INJECTION_REAL,
  },
  {
    template_id: 'cold_start_real',
    name: 'Cold Start (REAL — public A2A + AP2)',
    building_block: 'bake_off',
    markdown: COLD_START_REAL,
  },
  {
    template_id: 'whale_dominance_real',
    name: 'Whale Dominance (REAL — public A2A + AP2)',
    building_block: 'bake_off',
    markdown: WHALE_DOMINANCE_REAL,
  },
  {
    template_id: 'reverse_auction_real',
    name: 'Reverse Auction (REAL — public A2A + AP2)',
    building_block: 'bake_off',
    markdown: REVERSE_AUCTION_REAL,
  },
  {
    template_id: 'collusion_real',
    name: 'Collusion Detection (REAL — ring_trade)',
    building_block: 'ring_trade',
    markdown: COLLUSION_REAL,
  },
  {
    template_id: 'adapted_collusion_real',
    name: 'Adapted Collusion (REAL — ring_trade + camouflage)',
    building_block: 'ring_trade',
    markdown: ADAPTED_COLLUSION_REAL,
  },
  {
    template_id: 'multi_hop_real',
    name: 'Paid Multi-Hop Chain (REAL — multi_hop)',
    building_block: 'multi_hop',
    markdown: MULTI_HOP_REAL,
  },
  {
    template_id: 'cascading_default_real',
    name: 'Cascading Default (REAL — multi_hop + demand shock)',
    building_block: 'multi_hop',
    markdown: CASCADING_DEFAULT_REAL,
  },
  {
    template_id: 'velocity_attack_real',
    name: 'Velocity Attack (REAL — one_to_one rapid-fire)',
    building_block: 'one_to_one',
    markdown: VELOCITY_ATTACK_REAL,
  },
  {
    template_id: 'sybil_attack_real',
    name: 'Sybil Attack (REAL — bake_off concentration)',
    building_block: 'bake_off',
    markdown: SYBIL_ATTACK_REAL,
  },
  {
    template_id: 'reputation_laundering_real',
    name: 'Reputation Laundering (REAL — one_to_one confederate)',
    building_block: 'one_to_one',
    markdown: REPUTATION_LAUNDERING_REAL,
  },
  {
    template_id: 'lemon_market_real',
    name: 'Lemon Market (REAL — bake_off quality spread)',
    building_block: 'bake_off',
    markdown: LEMON_MARKET_REAL,
  },
  {
    template_id: 'dispute_escalation_real',
    name: 'Dispute Escalation (REAL — one_to_one disputes)',
    building_block: 'one_to_one',
    markdown: DISPUTE_ESCALATION_REAL,
  },
  {
    template_id: 'kya_tier_escalation_real',
    name: 'KYA Tier Escalation (REAL — one_to_one policy friction)',
    building_block: 'one_to_one',
    markdown: KYA_TIER_ESCALATION_REAL,
  },
  {
    template_id: 'front_running_real',
    name: 'Front-Running (REAL — bake_off race)',
    building_block: 'bake_off',
    markdown: FRONT_RUNNING_REAL,
  },
  {
    template_id: 'streaming_payments_real',
    name: 'Streaming Payments (REAL — one_to_one recurring)',
    building_block: 'one_to_one',
    markdown: STREAMING_PAYMENTS_REAL,
  },
  {
    template_id: 'recurring_subscription_real',
    name: 'Recurring Subscription (REAL — one_to_one billing)',
    building_block: 'one_to_one',
    markdown: RECURRING_SUBSCRIPTION_REAL,
  },
  {
    template_id: 'market_making_real',
    name: 'Market Making (REAL — bake_off spread)',
    building_block: 'bake_off',
    markdown: MARKET_MAKING_REAL,
  },
  {
    template_id: 'cross_tenant_real',
    name: 'Cross-Tenant Trade (REAL — bake_off multi-org)',
    building_block: 'bake_off',
    markdown: CROSS_TENANT_REAL,
  },
  {
    template_id: 'external_marketplace_real',
    name: 'External Agent Federation (REAL — bake_off + external)',
    building_block: 'bake_off',
    markdown: EXTERNAL_MARKETPLACE_REAL,
  },
  {
    template_id: 'full_marketplace_real',
    name: 'Full Dynamic Marketplace (REAL — double auction)',
    building_block: 'double_auction',
    markdown: FULL_MARKETPLACE_REAL,
  },
  {
    template_id: 'merchant_shopping_acp',
    name: 'Merchant Shopping (ACP — POS catalog)',
    building_block: 'merchant_buy',
    markdown: MERCHANT_SHOPPING_ACP,
  },
  {
    template_id: 'hotel_booking_ucp',
    name: 'Travel Booking (UCP — full commerce lifecycle)',
    building_block: 'merchant_buy',
    markdown: HOTEL_BOOKING_UCP,
  },
  {
    template_id: 'compute_x402',
    name: 'Compute & Content Purchase (x402 — pay-per-request APIs)',
    building_block: 'merchant_buy',
    markdown: COMPUTE_X402,
  },
  {
    template_id: 'concierge_travel',
    name: 'Agent Concierge (UCP — travel agent pattern)',
    building_block: 'concierge',
    markdown: CONCIERGE_TRAVEL,
  },
  {
    template_id: 'resale_chain_acp',
    name: 'Resale Arbitrage (ACP → A2A peer)',
    building_block: 'resale_chain',
    markdown: RESALE_CHAIN,
  },
  {
    template_id: 'merchant_comparison_acp',
    name: 'Merchant Comparison (agents shop competing SKUs)',
    building_block: 'merchant_comparison',
    markdown: MERCHANT_COMPARISON,
  },
];

/**
 * Seed built-in templates on sidecar startup. Idempotent: if a template
 * already exists (by template_id), it's left alone — operators can edit
 * built-ins via the viewer without losing their changes on restart.
 *
 * To force-reset built-ins, use the explicit "Reset to default" button in
 * the viewer (Phase C) which calls upsert() unconditionally.
 */
export async function seedBuiltIns(): Promise<{ created: string[]; skipped: string[] }> {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const t of BUILT_INS) {
    const existing = await getByTemplateId(t.template_id);
    if (existing) {
      skipped.push(t.template_id);
      continue;
    }
    await upsert({
      template_id: t.template_id,
      name: t.name,
      markdown: t.markdown,
      building_block: t.building_block,
      is_built_in: true,
    });
    created.push(t.template_id);
  }
  return { created, skipped };
}

/** Force-reset a single built-in to its shipped default. Used by the viewer. */
export async function resetBuiltIn(templateId: string): Promise<void> {
  const t = BUILT_INS.find((x) => x.template_id === templateId);
  if (!t) throw new Error(`No built-in template with id "${templateId}"`);
  await upsert({
    template_id: t.template_id,
    name: t.name,
    markdown: t.markdown,
    building_block: t.building_block,
    is_built_in: true,
  });
}
