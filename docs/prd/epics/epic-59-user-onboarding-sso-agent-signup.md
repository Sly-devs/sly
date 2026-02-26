# Epic 59: User Onboarding, SSO & Agent Self-Registration

**Status:** 📋 Planned
**Phase:** 3.5 (Platform Readiness)
**Priority:** P0 — Can't Onboard New Users Without This
**Estimated Points:** 76
**Stories:** 16
**Dependencies:** Epic 24 (API Key Security), Epic 51 (Unified Onboarding)
**Created:** February 26, 2026

[← Back to Epic List](./README.md)

---

## Executive Summary

Sly is ready to onboard more users, but the current signup flow is broken and several key capabilities are missing:

1. **Broken web signup**: The web UI calls `supabase.auth.signUp()` directly, which creates a Supabase Auth user but never provisions a tenant, user_profile, or API keys. Users who sign up via the web UI can't use the dashboard.
2. **No team invite UI**: The API has complete invite endpoints (`POST /v1/organization/team/invite`, `POST /v1/auth/accept-invite`) but there's no web UI — no accept-invite page, no team management dashboard.
3. **No SSO**: Only email/password. No Google/GitHub OAuth despite Supabase supporting it natively.
4. **No agent self-registration**: Agents can only be created under an existing human tenant with a business parent account. There's no way for an AI agent to autonomously register itself.

This epic addresses all four gaps across four incremental phases, each independently shippable.

---

## SDK Impact Assessment

| Feature/Endpoint | Needs SDK? | Module | Priority | Notes |
|------------------|------------|--------|----------|-------|
| `POST /v1/auth/provision` | ❌ No | - | - | Web UI only, not for partners |
| `POST /v1/auth/agent-signup` | ✅ Yes | `sly.auth` | P0 | Agent self-registration |
| `POST /v1/agents/:id/claim` | ✅ Yes | `sly.agents` | P1 | Claim autonomous agent |
| Team invite UI pages | ❌ No | - | - | Frontend only |
| OAuth login/signup | ❌ No | - | - | Supabase client-side only |

**SDK Stories Required:**
- Story 59.16: Add agent self-registration to SDK (`sly.auth.agentSignup()`)

---

## Architecture

### Signup Flow (Fixed)

```
1. User fills signup form (email, password, org name)
2. supabase.auth.signUp() → email confirmation sent
   (org name stored in user_metadata)
3. User clicks email link → /auth/callback
4. Callback checks: has tenant? No → redirect /auth/setup
5. /auth/setup calls POST /v1/auth/provision
   → creates tenant, user_profile, tenant_settings, API keys
6. Shows API keys once → redirect to /dashboard
```

### OAuth Flow (SSO)

```
1. User clicks "Continue with Google/GitHub"
2. supabase.auth.signInWithOAuth() → provider consent
3. Redirect → /auth/callback
4. Callback checks: has tenant? No → redirect /auth/setup
5. /auth/setup shows org name form (not in OAuth metadata)
6. Calls POST /v1/auth/provision → dashboard
```

### Agent Self-Registration Flow

```
POST /v1/auth/agent-signup (public, no auth)
  → Creates: tenant, agent account (type: 'agent'), agent, wallet
  → Returns: agent token (once), tenant, wallet, KYA tier 0 limits
  → Safety: 5 req/hr rate limit, KYA tier 0 ($10/tx, $50/day)
```

### Existing Infrastructure Reused

| Component | Location | Reuse |
|-----------|----------|-------|
| Tenant provisioning logic | `apps/api/src/routes/auth.ts:157-263` | Extract to shared service |
| Auth utilities | `apps/api/src/utils/auth.ts` | `generateApiKey`, `hashApiKey`, `checkRateLimit`, `logSecurityEvent` |
| Agent token generation | `apps/api/src/routes/agents.ts:253-255` | `generateAgentToken()` |
| Team invite API | `apps/api/src/routes/organization-team.ts` | Complete — no backend changes needed |
| Accept invite API | `apps/api/src/routes/auth.ts:760-987` | Complete — no backend changes needed |
| Supabase browser client | `apps/web/src/lib/supabase/client.ts` | OAuth + signup calls |
| Auth callback handler | `apps/web/src/app/auth/callback/route.ts` | Extend with tenant check |
| `create_agent_account()` | Migration `20251222` | DB function for agent accounts |

---

## Stories

### Phase 1: Fix Self-Service Signup (Ship First)

---

### Story 59.1: Extract Tenant Provisioning Service

**Points:** 5
**Priority:** P0

**Description:**
Extract tenant creation logic from `POST /v1/auth/signup` into a reusable `provisionTenant()` function. Both the existing signup and the new provision endpoint will use this.

**Acceptance Criteria:**
- [ ] New file `apps/api/src/services/tenant-provisioning.ts` with `provisionTenant()` function
- [ ] Function creates: tenant, user_profile (role: owner), tenant_settings, api_keys (test + live)
- [ ] Existing `POST /v1/auth/signup` refactored to use `provisionTenant()`
- [ ] Existing signup tests still pass
- [ ] Function is idempotent (returns existing tenant if user already has one)

**Files:**
- New: `apps/api/src/services/tenant-provisioning.ts`
- Modify: `apps/api/src/routes/auth.ts`

---

### Story 59.2: Create POST /v1/auth/provision Endpoint

**Points:** 5
**Priority:** P0

**Description:**
New endpoint that provisions a tenant for an already-authenticated Supabase user. Called by the web UI after email confirmation or OAuth.

**Acceptance Criteria:**
- [ ] `POST /v1/auth/provision` endpoint in auth routes
- [ ] Accepts Bearer JWT token (validates via `supabase.auth.getUser()`)
- [ ] Accepts `{ organizationName, userName? }` in body
- [ ] Falls back to `user_metadata.organization_name` if body field is empty
- [ ] Returns tenant info + API keys (shown once)
- [ ] Idempotent: returns existing tenant if already provisioned
- [ ] Rate limited: 10/hour per IP
- [ ] Security event logged

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

---

### Story 59.3: Update Web Signup Form

**Points:** 3
**Priority:** P0

**Description:**
Add organization name field to the signup form and store it in Supabase user metadata.

**Acceptance Criteria:**
- [ ] Organization name field added (required)
- [ ] Password validation updated to 12 chars (currently 8)
- [ ] Org name stored in `user_metadata: { organization_name }` on signUp call
- [ ] `emailRedirectTo` set to `/auth/callback?next=/auth/setup`

**Files:**
- Modify: `apps/web/src/app/auth/signup/page.tsx`

---

### Story 59.4: Create /auth/setup Page

**Points:** 5
**Priority:** P0

**Description:**
Post-confirmation page that provisions the tenant. Handles both email signup (auto-provisions from metadata) and OAuth (shows org name form).

**Acceptance Criteria:**
- [ ] Client component at `apps/web/src/app/auth/setup/page.tsx`
- [ ] Checks Supabase session on mount, redirects to login if not authenticated
- [ ] Reads `user_metadata.organization_name` from session
- [ ] If org name available → auto-calls `POST /v1/auth/provision`
- [ ] If not → shows form asking for organization name
- [ ] On success → displays API keys once with copy buttons → redirect to dashboard
- [ ] On failure → shows error with retry button
- [ ] If tenant already exists → redirects to dashboard immediately

**Files:**
- New: `apps/web/src/app/auth/setup/page.tsx`

---

### Story 59.5: Update Callback Handler with Tenant Check

**Points:** 3
**Priority:** P0

**Description:**
After exchanging the auth code for a session, check if the user has a tenant provisioned.

**Acceptance Criteria:**
- [ ] After `exchangeCodeForSession`, call `GET /v1/auth/me` with session token
- [ ] If response has `tenant: null` → redirect to `/auth/setup`
- [ ] If response has tenant → redirect to `next` param or `/dashboard`
- [ ] Error handling: if API unreachable, redirect to `/auth/setup` as fallback

**Files:**
- Modify: `apps/web/src/app/auth/callback/route.ts`

---

### Story 59.6: Dashboard Tenant Guard

**Points:** 2
**Priority:** P0

**Description:**
Add a tenant check to the dashboard layout to catch users who bypass the setup page.

**Acceptance Criteria:**
- [ ] Dashboard layout checks for tenant after getting Supabase user
- [ ] If no tenant → redirect to `/auth/setup`
- [ ] Existing users with tenants see no change

**Files:**
- Modify: `apps/web/src/app/dashboard/layout.tsx`

---

### Phase 2: Team Invite UI

---

### Story 59.7: Accept Invite Page

**Points:** 5
**Priority:** P0

**Description:**
Create the accept-invite page that handles invite link URLs. The API already supports `POST /v1/auth/accept-invite` — this is the frontend.

**Acceptance Criteria:**
- [ ] Page at `apps/web/src/app/accept-invite/page.tsx`
- [ ] Reads `token` from URL search params
- [ ] Shows form: name (optional), password (required, 12 char min), confirm password
- [ ] Calls `POST /v1/auth/accept-invite` with `{ token, password, name }`
- [ ] On success: stores session (Supabase signIn with returned tokens), redirect to `/dashboard`
- [ ] Error states: expired token, invalid token, already accepted, password too weak
- [ ] If already logged in: show warning about switching accounts

**Files:**
- New: `apps/web/src/app/accept-invite/page.tsx`

---

### Story 59.8: Team Management Page

**Points:** 8
**Priority:** P0

**Description:**
Settings page for managing team members and invites. Uses existing API endpoints.

**Acceptance Criteria:**
- [ ] Page at `apps/web/src/app/dashboard/settings/team/page.tsx`
- [ ] Members list from `GET /v1/organization/team`: name, role badge, status
- [ ] Invite form (owner/admin only): email + role dropdown → `POST /v1/organization/team/invite`
- [ ] Shows invite URL with copy-to-clipboard on success
- [ ] Pending invites section from `GET /v1/organization/team/invites`
- [ ] Role change dropdown per member → `PATCH /v1/organization/team/:userId`
- [ ] Remove member with confirm dialog → `DELETE /v1/organization/team/:userId`
- [ ] Permission gating: invite/role/remove only visible to owner/admin

**Files:**
- New: `apps/web/src/app/dashboard/settings/team/page.tsx`

---

### Story 59.9: Settings Navigation — Team Link

**Points:** 2
**Priority:** P1

**Description:**
Add team management link to the settings navigation / sidebar.

**Acceptance Criteria:**
- [ ] "Team" link visible under Settings section
- [ ] Points to `/dashboard/settings/team`
- [ ] Shows member count badge (optional)

**Files:**
- Modify: Settings page or sidebar navigation component

---

### Phase 3: Google + GitHub SSO

---

### Story 59.10: Configure OAuth Providers in Supabase

**Points:** 2
**Priority:** P1

**Description:**
Manual configuration step — enable Google and GitHub OAuth providers in the Supabase dashboard.

**Acceptance Criteria:**
- [ ] Google OAuth: consent screen, client ID, client secret configured
- [ ] GitHub OAuth: app created, client ID + secret configured
- [ ] Redirect URL set to Supabase's callback URL
- [ ] Both providers tested and working

**Files:**
- No code changes — Supabase Dashboard + Google Cloud Console + GitHub settings

---

### Story 59.11: OAuth Buttons on Login Page

**Points:** 3
**Priority:** P1

**Description:**
Add "Continue with Google" and "Continue with GitHub" buttons to the login page.

**Acceptance Criteria:**
- [ ] Google and GitHub buttons below the email/password form
- [ ] Visual divider ("or") between form and OAuth buttons
- [ ] Each calls `supabase.auth.signInWithOAuth({ provider, options: { redirectTo } })`
- [ ] Error handling for OAuth failures
- [ ] Redirects to `/auth/callback` → existing tenant check handles the rest

**Files:**
- Modify: `apps/web/src/app/auth/login/page.tsx`

---

### Story 59.12: OAuth Buttons on Signup Page

**Points:** 3
**Priority:** P1

**Description:**
Add OAuth buttons to the signup page. For OAuth signups, org name will be collected on the setup page.

**Acceptance Criteria:**
- [ ] Same Google/GitHub buttons as login page
- [ ] OAuth signup → callback → no tenant → `/auth/setup` → org name form → provision
- [ ] Clear messaging: "You'll set up your organization after signing in"

**Files:**
- Modify: `apps/web/src/app/auth/signup/page.tsx`

---

### Phase 4: Agent Self-Registration

---

### Story 59.13: DB Migration — Standalone Agents & Agent Tenants

**Points:** 5
**Priority:** P1

**Description:**
Schema changes to support agents that self-register without a human tenant.

**Acceptance Criteria:**
- [ ] `agents.parent_account_id` made nullable (ALTER COLUMN DROP NOT NULL)
- [ ] Partial index for standalone agents: `WHERE parent_account_id IS NULL`
- [ ] `tenants` table: add `is_agent_tenant` boolean default false
- [ ] `tenants` table: add `claimed_by_tenant_id` UUID nullable (FK to tenants)
- [ ] RLS policies updated for agent tenant isolation

**Files:**
- New: `apps/api/supabase/migrations/20260226_agent_self_registration.sql`

---

### Story 59.14: POST /v1/auth/agent-signup Endpoint

**Points:** 8
**Priority:** P1

**Description:**
Public endpoint for autonomous agent self-registration. The agent equivalent of human signup.

**Acceptance Criteria:**
- [ ] `POST /v1/auth/agent-signup` endpoint (no auth required)
- [ ] Input validation: `name` (required), `purpose`, `capabilities[]`, `model`, `callback_url`
- [ ] Rate limited: 5/hour per IP
- [ ] Auto-provisions: tenant (is_agent_tenant: true) → agent account (type: 'agent') → agent → wallet
- [ ] Generates `agent_sk_...` token, stores hash + prefix
- [ ] Returns: agent info, token (once), tenant, wallet, KYA tier 0 limits
- [ ] Security event: `agent_signup_success` / `agent_signup_failure`
- [ ] Audit log entry

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

---

### Story 59.15: Update Agent Creation for Optional Parent

**Points:** 5
**Priority:** P1

**Description:**
Allow agents to exist without a business parent account. When no parent exists, limits come from KYA tier only.

**Acceptance Criteria:**
- [ ] `accountId` / `parentAccountId` made optional in `createAgentSchema`
- [ ] `computeEffectiveLimits()` handles null parent (uses KYA tier only, no cap)
- [ ] `POST /v1/accounts` accepts `type: 'agent'` (uses existing `agent_config` JSONB)
- [ ] Agent auth middleware works with null `parent_account_id`
- [ ] Downstream handlers (transfers, streams) handle null parent gracefully

**Files:**
- Modify: `apps/api/src/routes/agents.ts`
- Modify: `apps/api/src/routes/accounts.ts`

---

### Story 59.16: Agent Tenant Claim Endpoint

**Points:** 5
**Priority:** P2

**Description:**
Allow an existing human tenant to "claim" an autonomously-registered agent, bringing it under their organization.

**Acceptance Criteria:**
- [ ] `POST /v1/agents/:id/claim` — requires API key auth
- [ ] Validates: agent exists, agent's tenant is an agent_tenant, not already claimed
- [ ] Transfers agent + wallet to claiming tenant
- [ ] Updates `claimed_by_tenant_id` on original agent tenant
- [ ] Agent now subject to parent account limits if linked
- [ ] Security event logged
- [ ] SDK method: `sly.agents.claim(agentId)`

**Files:**
- Modify: `apps/api/src/routes/agents.ts`

---

## Points Summary

| Phase | Stories | Points |
|-------|---------|--------|
| Phase 1: Fix Signup | 59.1–59.6 | 23 |
| Phase 2: Team Invite UI | 59.7–59.9 | 15 |
| Phase 3: SSO | 59.10–59.12 | 8 |
| Phase 4: Agent Self-Registration | 59.13–59.16 | 23 |
| **Total** | **16** | **69** |

---

## Definition of Done

- [ ] All stories have passing tests (unit + integration)
- [ ] No cross-tenant data leaks (RLS verified)
- [ ] Security events logged for all auth operations
- [ ] Rate limiting on all public endpoints
- [ ] Password validation consistent (12 char minimum everywhere)
- [ ] API keys shown only once, stored as hash
- [ ] Agent tokens shown only once, stored as hash
