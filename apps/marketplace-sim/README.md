# @sly/marketplace-sim

External marketplace simulation + validation runner for the Sly platform.

This app exercises Sly **entirely through public APIs** — no backend shortcuts,
no direct DB access, no internal imports. Anything it can do, a real customer
could do. It's both a live demo tool and a continuous integration test.

## Design

| Scripted scenario engine (inside `apps/api`) | Marketplace-sim (this app) |
|---|---|
| Runs server-side inside the API process | Runs as a separate node process |
| Creates tasks via direct DB inserts | Creates tasks via `POST /a2a/:agentId` with real agent tokens |
| Drives state transitions by hand (scripted) | State transitions emerge from the real task worker → webhook → response cycle |
| No real agent decisions | Agents are LLM-backed personas making real choices (ratings, disputes, etc.) |
| ~30s per scenario, free | ~3-5 min per scenario, ~$1-$10 per run |
| Deterministic — the loop controls outcomes | Emergent — you don't know in advance what rogues will try |

**You can run both.** The scripted scenarios stay as fast product demos. Marketplace-sim
is the engineering validation layer that finds bugs the scripts didn't think to fake.

## Three processor modes

All modes talk to Sly through the same public HTTP surface. Only the task-processing
brain changes.

### `--mode api` (standalone, requires key)
Uses `@anthropic-ai/sdk` directly. Runs from CI, cron, or just the command line.
Each task is an LLM inference with a persona prompt.

```bash
pnpm --filter @sly/marketplace-sim sim run competitive_review --mode api --duration 5m
```

Requires `ANTHROPIC_API_KEY` in `.env`. Budget-capped via `BUDGET_USD_CAP`.

### `--mode scripted` (deterministic, $0)
Processors return templated responses with deterministic branching.
Useful for CI regression testing — exercises the full real API path without LLM flakiness.

```bash
pnpm --filter @sly/marketplace-sim sim run competitive_review --mode scripted --duration 2m
```

### `--mode subagent` (Claude Code session, $0)
Task prompts are written to a work queue. Inside a Claude Code chat, the parent
session spawns subagents via the `Agent` tool to process pending tasks and write
responses back. No API key, but requires an active Claude Code conversation.

```bash
pnpm --filter @sly/marketplace-sim sim run rogue_injection --mode subagent --duration 5m
```

## Live viewer integration

Marketplace-sim uses the Sly public API to create real tasks. Every state
transition, mandate, and settlement automatically fires through the existing
`taskEventBus`, which is what the live round viewer subscribes to.

For the narrative layer (scenario announcements, findings, milestones), the sim
calls `POST /admin/round/comment` and `/admin/round/milestone` — the same
endpoints the built-in scripted scenarios use.

**Result:** when you run a marketplace-sim round, the live viewer shows it
identically to a scripted round. You'd see it working without any viewer changes.

## Quick start

```bash
# 1. Copy the env template and fill in your local values
cp apps/marketplace-sim/.env.example apps/marketplace-sim/.env
# Edit apps/marketplace-sim/.env — set ANTHROPIC_API_KEY if using --mode api

# 2. Make sure your local Sly API is running
pnpm --filter @sly/api dev

# 3. Seed persona agents into Sly (one-time)
pnpm --filter @sly/marketplace-sim seed-personas

# 4. Run a scenario
pnpm --filter @sly/marketplace-sim sim run competitive_review --mode scripted --duration 2m

# 5. Watch it in the live viewer
open http://localhost:8889/LIVE_ROUND_VIEWER.html
```

## Package layout

```
apps/marketplace-sim/
├── src/
│   ├── cli.ts                 # pnpm sim entry point
│   ├── sly-client.ts          # thin HTTP wrapper over Sly public APIs
│   ├── narrator.ts            # posts comments/milestones to viewer
│   │
│   ├── personas/              # behavioral prompts
│   │   ├── index.ts           # persona registry
│   │   ├── honest-trader.md
│   │   ├── quality-reviewer.md
│   │   └── rogue-disputer.md
│   │
│   ├── processors/            # pluggable task-processing brains
│   │   ├── types.ts           # TaskProcessor interface
│   │   ├── scripted.ts        # deterministic templated responses
│   │   ├── anthropic-api.ts   # LLM via @anthropic-ai/sdk
│   │   └── claude-subagent.ts # work queue + subagent dispatch
│   │
│   ├── agents/
│   │   ├── registry.ts        # register/reuse persona agents via Sly API
│   │   ├── funder.ts          # top up wallets
│   │   └── worker.ts          # per-agent polling loop
│   │
│   └── scenarios/
│       ├── types.ts
│       ├── competitive-review.ts
│       └── rogue-injection.ts
│
└── scripts/
    └── seed-personas.ts       # one-time: create 5-10 persona agents in Sly
```

## Security

- Never commits secrets (`.env` is gitignored).
- Reads `ANTHROPIC_API_KEY` and `SLY_PLATFORM_ADMIN_KEY` from env only.
- Treats every interaction with Sly as a customer would — through the
  authenticated public API surface.
