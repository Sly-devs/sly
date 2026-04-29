# Agentforce Org Probe — `agentforce-org`

**Date**: 2026-04-29
**Org**: `00Dfj00000H9zdZEAR` (Agentforce Trial / Developer Edition)
**Instance URL**: `https://orgfarm-2796413d99-dev-ed.develop.my.salesforce.com`
**API version**: `66.0`
**Auth**: `sf` CLI session — `sf org display --target-org agentforce-org --json`

## Summary

| Question | Answer |
|---|---|
| Does the org expose A2A natively (`/.well-known/agent.json`)? | **No** (HTTP 404) |
| Does it expose `/services/data/v66.0/connect/agents`? | **No** (HTTP 404) |
| Does it expose Einstein/Agentforce Agent API on the instance URL? | **No** (HTTP 404 at `/services/data/v66.0/einstein/ai-agent/v1/agents`) |
| Does `api.salesforce.com/einstein/ai-agent/v1/health` respond unauthenticated? | **No** (HTTP 404 — endpoint requires auth + correct path) |
| **How many Agentforce agents are defined in the org?** | **0** |
| How many Einstein Bots? | **0** |

## Available metadata sObjects (relevant ones)

The org's sObjects describe (filtered for agent/bot/genai/copilot/planner) lists:

```
AIAgentStatusEvent
AgentWork (and *ChangeEvent / *Share — service-cloud routing, not Agentforce)
BotDefinition
BotVersion
GenAiFunctionDefinition
GenAiPlannerAttrDefinition
GenAiPlannerDefinition       ← the Agentforce "Agent" object
GenAiPlannerFunctionDef
GenAiPluginDefinition         ← the Agentforce "Topic" object
GenAiPluginFunctionDef
GenAiPluginInstructionDef
OmniSpvsrConfigAIAgent
```

All return `totalSize: 0` on `SELECT COUNT()`. Schema is wired; no
records yet. (Note: GenAiPlannerDefinition has no `Status` column — use
`Id, DeveloperName, MasterLabel` only.)

## What didn't work + why

| Probe | HTTP | Reason |
|---|---|---|
| `GET {instance}/.well-known/agent.json` | 404 | Salesforce doesn't expose A2A on the instance host. |
| `GET {instance}/services/data/v66.0/connect/agents` | 404 | Endpoint doesn't exist on this org / API version. |
| Tooling API `SELECT FROM BotDefinition` | 400 INVALID_TYPE | BotDefinition isn't queryable via Tooling API — use the regular `/query` endpoint. |
| Tooling API `SELECT FROM GenAiPlanner` (without `Definition`) | 400 INVALID_TYPE | Older blog posts use the bare names; correct is `GenAiPlannerDefinition`. |
| `sf agent list` | error — not a command | `sf agent` topic exists (`generate / preview / publish / test / validate / activate / create / deactivate`) but no `list` subcommand. Closest enumeration is `sf data query` against `GenAiPlannerDefinition`. |
| `sf agent preview --target-org X --api-name Y` outside a project | RequiresProjectError | `sf agent` commands need a Salesforce project directory (sfdx-project.json). |
| `GET https://api.salesforce.com/einstein/ai-agent/v1/health` (unauth) | 404 | Endpoint requires Connected App OAuth — and the public path is different (Salesforce gates Agent API runtime behind a separate auth flow). |

## Architectural finding (important)

The `sf` CLI session token works for **org metadata APIs** (configuration,
queries, sObjects). It does **not** work for the Agentforce runtime
**Agent API**. Salesforce's Agent API (the surface that lets you invoke
an agent and get a response) requires:

1. A **Connected App** in the org with these OAuth scopes:
   - `api` (general API access)
   - `einstein_gpt_api` (Agentforce / Einstein gateway)
   - `sfap_api` (Salesforce API Gateway)
2. **Client-credentials OAuth flow** against the org's My Domain or
   `login.salesforce.com` with the Connected App's consumer key + secret.
3. Calls then go to `https://api.salesforce.com/einstein/ai-agent/v1/agents/{agentId}/sessions` (NOT the org's instance URL).

Implication for our plan: even if we proceed with **Phase 2b**
(Salesforce client), we **cannot use only the sf CLI token** for runtime
invocation. We'll need a Connected App regardless. The CLI token is fine
for the Phase 1 probe (metadata) — but Phase 2/3 cannot rely on it for
talking to the agent at runtime.

## What's needed before we can continue

The org has no agents, so there's nothing to probe a transport against.
Two choices:

### Option A — create a starter agent in this trial org (recommended for the demo)

In the Salesforce Setup UI of `agentforce-org`:

1. **Setup → Agentforce Studio** (or **Setup → Einstein → Agents**)
2. **New Agent** → pick a template:
   - **Agentforce Service Agent** (built-in, fastest to spin up — good for testing)
   - Or any of the standard templates the trial ships with.
3. **Activate** the agent.

Then re-run the probe — `GenAiPlannerDefinition` will have at least one
row, and we'll know the agent's `Id` + `DeveloperName` for runtime
invocation.

### Option B — point at a different org that already has agents

If you have another Salesforce org with active Agentforce agents,
re-auth a new alias with `sf org login web --alias <other-org>` and
re-point the probe at it.

### Option C — create the Connected App now, defer agent creation

If you want me to proceed with the platform-side scaffolding (Connected
App OAuth client in `apps/api/src/services/agentforce/client.ts`), we
can build it without an agent in the org — just won't be able to
end-to-end test until step A or B is done.

## Next step

Recommend **Option A** — fastest path to an end-to-end demo. Should
take ~5 min in the Salesforce Setup UI (the trial ships with agent
templates that activate without code).

Once an agent exists, re-run the probe (the same script that produced
this doc) and we'll have the agent ID + can plan the Connected App
+ runtime adapter from a known starting point.

---

## Re-probe after agent creation (2026-04-29 16:08 UTC)

User created an Agentforce Service Agent named `SFDC_Agent` via Setup
UI. Re-running the probe surfaced this:

### Agent presence

| Surface | Result |
|---|---|
| `User WHERE Name LIKE '%Agent%'` | **1 hit** — `EinsteinServiceAgent User` (Id `005fj00000EpeUnAAJ`, username `sfdc_agent@00dfj00000h9zdz729720761.ext`, alias `einstein`, IsActive=true) |
| Permission set assignments on that user | **`AgentforceServiceAgentSecureBase`** (confirms it's a Service Agent), plus 2 anonymized perm sets, plus 1 base agent perm set |
| `GenAiPlannerDefinition` count | **0** (data API + tooling API) |
| `GenAiPluginDefinition` count | **0** |
| `GenAiFunctionDefinition` count | **0** |
| `BotDefinition` / `BotVersion` | **0** |
| `ConnectedApplication` (tooling) | INVALID_FIELD on FullName — query shape varies |

**Conclusion:** Agentforce Service Agents (the pre-built template the
user picked) are provisioned as a managed-package-style asset. They
spawn a service User but do **not** materialize into the standard
`GenAiPlannerDefinition` table that custom-built agents use. So the
metadata path that works for hand-built agents is a dead end for this
template.

### Runtime endpoint probes (all unauthenticated to clarify auth model)

| Path | HTTP | Notes |
|---|---|---|
| `{instance}/services/data/v66.0/connect/agentforce/agents` | 404 | |
| `{instance}/services/data/v66.0/connect/ai-bots-services/agents` | 404 | |
| `{instance}/services/data/v66.0/connect/copilot/agents` | 404 | |
| `{instance}/services/data/v66.0/einstein/copilot/agents` | 404 | |
| `{instance}/services/data/v66.0/einstein/ai-agent/v1/agents` | 404 | |
| `{instance}/services/data/v66.0/agentforce/agents` | 404 | |
| `https://api.salesforce.com/einstein/ai-agent/v1/agents/{userId}/sessions` (with sf CLI token, agentId=user id) | 404 | Endpoint host is gated entirely behind Connected App OAuth — even the root `api.salesforce.com/` returns 404 with the CLI token. |
| Connect API resource catalog (`{instance}/services/data/v66.0/connect/`) | 200 | 40 resources advertised, **none AI-related** (only `action-email`). |

**Conclusion:** The Agentforce Agent API runtime is **not exposed on
the org's instance URL**. It lives on `https://api.salesforce.com` and
is entirely gated by Connected App OAuth. We can't reach it with the
sf CLI session token regardless of the agent ID format we try.

### Hard requirements for runtime invocation

To call `SFDC_Agent` from the sim we need:

1. **A Connected App** in `agentforce-org` with these OAuth scopes:
   - `api` (general API)
   - `einstein_gpt_api` (Agentforce / Einstein gateway)
   - `sfap_api` (Salesforce API Gateway)
   - `refresh_token offline_access`
2. **Consumer Key + Consumer Secret** from that Connected App, stored
   server-side (env var or `connected_accounts` row).
3. **OAuth Client Credentials grant** against the org's My Domain:
   ```
   POST {instance}/services/oauth2/token
   grant_type=client_credentials
   client_id=<consumer_key>
   client_secret=<consumer_secret>
   ```
   Returns an access token usable against `api.salesforce.com`.
4. **Run-as User** assignment on the Connected App pointing at a
   licensed Agentforce user (the EinsteinServiceAgent user might
   suffice, but more likely needs a separate licensed admin/integration
   user).
5. **Agent ID resolution** — the actual agent ID format isn't yet
   known. With a real Connected App token in hand we'll either:
   a. Find an enumeration endpoint Salesforce documents.
   b. Use the agent's published `DeveloperName` (`SFDC_Agent`) which
      Salesforce sometimes accepts as an ID.

## What the user needs to do next

In `agentforce-org` Setup UI:

1. **Setup → App Manager → New Connected App**
2. Name: `Sly Sim Agent Bridge` (or similar). Contact email = your email.
3. **Enable OAuth Settings** = checked.
4. **Callback URL**: `http://localhost:1717/OauthRedirect` (placeholder
   — we use client-credentials, not the auth-code flow, but Salesforce
   requires *some* callback URL).
5. **Selected OAuth Scopes** — add all of:
   - `Manage user data via APIs (api)`
   - `Access Einstein GPT services (einstein_gpt_api)`
   - `Access the Salesforce API Platform (sfap_api)` (if visible — may
     require Agent API admin perms)
   - `Perform requests at any time (refresh_token, offline_access)`
6. **Enable Client Credentials Flow** — checked. Set "Run As" to a
   licensed admin user (your own user is fine for sandbox testing).
7. Save. Wait ~10 min for Salesforce to provision the keys.
8. **App Manager → View** the new Connected App → **Manage Consumer
   Details** → copy the **Consumer Key** and **Consumer Secret**.
9. Hand them to the assistant via env vars (don't paste into chat):
   ```
   echo 'AGENTFORCE_CONSUMER_KEY=<key>' >> /tmp/agentforce-creds.env
   echo 'AGENTFORCE_CONSUMER_SECRET=<secret>' >> /tmp/agentforce-creds.env
   chmod 600 /tmp/agentforce-creds.env
   ```

Once `/tmp/agentforce-creds.env` exists, we resume the probe — fetch
a Client Credentials token and try `api.salesforce.com` with it. From
there we can enumerate the agent's invocation surface and start
building the runtime adapter.
