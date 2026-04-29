/**
 * SlyClient — thin HTTP wrapper over the Sly public API surface.
 *
 * This client exists to keep marketplace-sim isolated from Sly internals.
 * It only talks to the platform through authenticated HTTP endpoints, exactly
 * like a third-party customer would. No DB access, no internal imports.
 */

export interface SlyClientOptions {
  baseUrl: string;
  /** Platform admin key (used for /admin/* endpoints only) */
  adminKey?: string;
  /** API key for tenant operations (pk_test_* or pk_live_*) */
  apiKey?: string;
  /** Agent token for /a2a/* operations (agent_* or sess_*) */
  agentToken?: string;
  /** Ed25519 private key (base64) for challenge-response auth (Epic 72) */
  ed25519PrivateKey?: string;
  /** Agent ID for challenge-response auth */
  agentId?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

export interface CreateTaskParams {
  agentId: string;
  message: { role: 'user' | 'agent'; parts: Array<Record<string, unknown>>; metadata?: Record<string, unknown> };
  callerAgentId?: string;
  contextId?: string;
}

export interface TaskResponse {
  id: string;
  state: string;
  agent_id: string;
  client_agent_id?: string;
  metadata?: Record<string, unknown>;
  status_message?: string;
  created_at?: string;
  updated_at?: string;
}

export interface RespondParams {
  taskId: string;
  action: 'accept' | 'reject' | 'dispute';
  satisfaction?: 'excellent' | 'acceptable' | 'partial';
  score?: number;
  comment?: string;
}

/**
 * Detects whether a thrown Sly API error came from an agent that's been
 * suspended (kill switch activated). The Sly API signals this with:
 *   HTTP 403 + JSON-RPC error code -32004 + message "Agent is suspended"
 * (see apps/api/src/routes/a2a.ts:269)
 *
 * We match on the full error message produced by `request()`, which carries
 * the HTTP status, the JSON-RPC code (if any), and the message text.
 */
export function isSuspensionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  const is403 = /Sly API 403\b/.test(msg);
  const isRpc32004 = /code=-32004\b/.test(msg);
  const mentionsSuspended = /suspended/i.test(msg);
  return (is403 && mentionsSuspended) || isRpc32004;
}

/**
 * 401 "Invalid agent token" signals a stale token in tokens.json (e.g., the
 * seed-agent endpoint rotated it out-of-band). The agent can't take any
 * action until the sim is re-seeded, so blocks treat this the same as a
 * suspension — skip the agent for the rest of the run instead of emitting
 * a noisy alert every cycle.
 */
export function isStaleAgentTokenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return /Sly API 401\b/.test(msg) && /(invalid agent token|invalid authorization|missing or invalid auth)/i.test(msg);
}

export class SlyClient {
  private baseUrl: string;
  private adminKey?: string;
  private apiKey?: string;
  private agentToken?: string;
  private ed25519PrivateKey?: string;
  private agentId?: string;
  private timeoutMs: number;
  /** Cached sess_* token from Ed25519 challenge-response */
  private sessionToken?: string;
  private sessionExpiresAt?: number;

  constructor(opts: SlyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.adminKey = opts.adminKey;
    this.apiKey = opts.apiKey;
    this.agentToken = opts.agentToken;
    this.ed25519PrivateKey = opts.ed25519PrivateKey;
    this.agentId = opts.agentId;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /** Clone this client with a different auth token (useful for per-agent workers) */
  withAgentToken(token: string): SlyClient {
    return new SlyClient({
      baseUrl: this.baseUrl,
      adminKey: this.adminKey,
      apiKey: this.apiKey,
      agentToken: token,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Clone this client with Ed25519 key-pair auth (Epic 72).
   * The client will auto-authenticate via challenge-response and cache
   * the session token, re-authenticating when it expires.
   */
  withKeyPairAuth(agentId: string, ed25519PrivateKey: string): SlyClient {
    return new SlyClient({
      baseUrl: this.baseUrl,
      adminKey: this.adminKey,
      apiKey: this.apiKey,
      agentId,
      ed25519PrivateKey,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Epic 72: Authenticate via Ed25519 challenge-response.
   * Returns a cached session token, re-authenticating if expired.
   */
  async authenticate(): Promise<string> {
    // Return cached session if still valid (with 60s buffer)
    if (this.sessionToken && this.sessionExpiresAt && Date.now() < this.sessionExpiresAt - 60_000) {
      return this.sessionToken;
    }

    if (!this.agentId || !this.ed25519PrivateKey) {
      throw new Error('Ed25519 auth requires agentId and ed25519PrivateKey');
    }

    // Step 1: Request challenge
    const chalRes = await fetch(`${this.baseUrl}/v1/agents/${this.agentId}/challenge`, {
      method: 'POST',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!chalRes.ok) throw new Error(`Challenge failed: ${chalRes.status}`);
    const chalBody = await chalRes.json() as any;
    const challenge = chalBody.data?.challenge ?? chalBody.challenge;

    // Step 2: Sign challenge
    const { signEd25519 } = await import('@noble/ed25519').then(async (ed) => {
      const { sha512 } = await import('@noble/hashes/sha512');
      ed.etc.sha512Sync = (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));
      return {
        signEd25519: async (msg: string, key: string) => {
          const msgBytes = new TextEncoder().encode(msg);
          const keyBytes = Buffer.from(key, 'base64');
          const sig = await ed.signAsync(msgBytes, keyBytes);
          return Buffer.from(sig).toString('base64');
        },
      };
    });

    const signature = await signEd25519(challenge, this.ed25519PrivateKey);

    // Step 3: Authenticate
    const authRes = await fetch(`${this.baseUrl}/v1/agents/${this.agentId}/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challenge, signature }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!authRes.ok) throw new Error(`Authenticate failed: ${authRes.status}`);
    const authBody = await authRes.json() as any;
    const authData = authBody.data ?? authBody;

    this.sessionToken = authData.sessionToken;
    this.sessionExpiresAt = Date.now() + (authData.expiresIn ?? 3600) * 1000;
    this.agentToken = this.sessionToken; // Use sess_* as the agent token

    return this.sessionToken!;
  }

  // ─── Low-level HTTP ────────────────────────────────────────────────────

  private async request<T>(
    path: string,
    init: RequestInit,
    authMode: 'admin' | 'apiKey' | 'agent' | 'none' = 'apiKey',
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    };

    let token: string | undefined;
    if (authMode === 'admin') token = this.adminKey;
    else if (authMode === 'apiKey') token = this.apiKey;
    else if (authMode === 'agent') {
      // Epic 72: Ed25519 session tokens (sess_*) don't yet work on /a2a/
      // endpoints (they're mounted outside /v1 with separate auth).
      // Until the A2A handler is updated to accept sess_* tokens,
      // use the bearer token (agent_*) for all agent-authenticated requests.
      // The Ed25519 keys are provisioned and ready — just not used for auth yet.
      token = this.agentToken;
    }

    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }

    if (!res.ok) {
      // Extract a readable detail. Order of preference:
      //   1. body.error if it's a string ({ error: 'foo' })
      //   2. body.error.message if it's an object (JSON-RPC: { error: { code, message } })
      //   3. full JSON of body
      let detail: string;
      if (typeof body === 'object' && body !== null) {
        const b = body as { error?: unknown };
        if (typeof b.error === 'string') {
          detail = b.error;
        } else if (typeof b.error === 'object' && b.error !== null && 'message' in b.error) {
          const rpcErr = b.error as { code?: unknown; message?: unknown };
          // Keep code + message so isSuspensionError can match on -32004.
          detail = [rpcErr.code ? `code=${String(rpcErr.code)}` : null, rpcErr.message ? String(rpcErr.message) : null]
            .filter(Boolean)
            .join(' ');
          if (!detail) detail = JSON.stringify(body);
        } else {
          detail = JSON.stringify(body);
        }
      } else {
        detail = String(body);
      }
      throw new Error(`Sly API ${res.status} ${path}: ${detail}`);
    }

    // Sly API wraps successful responses as { success, data, meta }
    if (typeof body === 'object' && body !== null && 'data' in (body as Record<string, unknown>)) {
      return (body as { data: T }).data;
    }
    return body as T;
  }

  // ─── Health / Discovery ────────────────────────────────────────────────

  async health(): Promise<{ status: string }> {
    return this.request('/health', { method: 'GET' }, 'none');
  }

  // ─── A2A Task Lifecycle ────────────────────────────────────────────────

  /**
   * Create a new A2A task via the public gateway endpoint.
   * Requires an agent token (not an API key) so we can post as the client agent.
   */
  async createTask(params: CreateTaskParams): Promise<{ id: string }> {
    const rpc = {
      jsonrpc: '2.0',
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      method: 'message/send',
      params: {
        message: params.message,
        ...(params.contextId ? { contextId: params.contextId } : {}),
      },
    };
    const res = await this.request<{ result?: { id: string }; error?: unknown }>(
      `/a2a/${params.agentId}`,
      { method: 'POST', body: JSON.stringify(rpc) },
      'agent',
    );
    if ((res as { error?: unknown }).error || !(res as { result?: { id: string } }).result?.id) {
      throw new Error(`createTask failed: ${JSON.stringify(res)}`);
    }
    return { id: (res as { result: { id: string } }).result.id };
  }

  /** Fetch a task by ID (authenticated as the target agent or the caller). */
  async getTask(taskId: string): Promise<TaskResponse> {
    return this.request<TaskResponse>(`/v1/a2a/tasks/${taskId}`, { method: 'GET' }, 'agent');
  }

  /**
   * List tasks assigned to the authenticated agent.
   * Used by persona workers to poll for incoming work.
   */
  async listTasks(opts: { state?: string; limit?: number } = {}): Promise<TaskResponse[]> {
    const q = new URLSearchParams();
    if (opts.state) q.set('state', opts.state);
    if (opts.limit) q.set('limit', String(opts.limit));
    const path = `/v1/a2a/tasks${q.toString() ? '?' + q.toString() : ''}`;
    const res = await this.request<{ tasks?: TaskResponse[] } | TaskResponse[]>(
      path,
      { method: 'GET' },
      'agent',
    );
    // Handle both paged shape { tasks: [] } and bare array
    if (Array.isArray(res)) return res;
    return res.tasks ?? [];
  }

  /** Respond to a task that's in input-required state (accept/reject/dispute). */
  async respond(params: RespondParams): Promise<void> {
    await this.request(
      `/v1/a2a/tasks/${params.taskId}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({
          action: params.action,
          satisfaction: params.satisfaction,
          score: params.score,
          comment: params.comment,
        }),
      },
      'agent',
    );
  }

  /**
   * Provider claims a submitted task (drives submitted → working).
   * Caller must be the assigned agent. Use the agent token for the provider.
   */
  async claimTask(taskId: string): Promise<void> {
    await this.request(
      `/v1/a2a/tasks/${taskId}/claim`,
      { method: 'POST', body: JSON.stringify({}) },
      'agent',
    );
  }

  /**
   * Mark a task as completed (provider-side, after producing a result).
   * Accepts a plain text body for convenience — wraps it in the expected
   * `{ message: string }` shape that POST /v1/a2a/tasks/:id/complete accepts.
   */
  async completeTask(taskId: string, body: string | { text: string } | { message: string } | { artifact: { name: string; parts: Array<Record<string, unknown>> } }): Promise<void> {
    let payload: Record<string, unknown>;
    if (typeof body === 'string') {
      payload = { message: body };
    } else {
      payload = body as Record<string, unknown>;
    }
    await this.request(
      `/v1/a2a/tasks/${taskId}/complete`,
      { method: 'POST', body: JSON.stringify(payload) },
      'agent',
    );
  }

  /**
   * Discover marketplace agents and their skills (GET /v1/a2a/marketplace).
   * Returns all discoverable agents with skills, pricing, and reputation.
   */
  async discoverMarketplace(): Promise<Array<{ agentId: string; name: string; skills: Array<{ skill_id: string; name: string; base_price: number }>; reputation?: number }>> {
    const res = await this.request('/v1/a2a/marketplace', { method: 'GET' }, 'admin');
    const agents = (res as any)?.agents || (res as any)?.data?.agents || [];
    return agents;
  }

  /**
   * Cancel a task (POST /v1/a2a/tasks/:id/cancel).
   * Used for losing bids in auctions — the task wasn't failed, just not selected.
   */
  async cancelTask(taskId: string, params?: { reason?: string; comment?: string }): Promise<void> {
    await this.request(
      `/v1/a2a/tasks/${taskId}/cancel`,
      { method: 'POST', body: JSON.stringify(params || {}) },
      'agent',
    );
  }

  /**
   * Rate a counterparty for a completed task (POST /v1/a2a/tasks/:id/rate).
   * Bearer token must belong to either the buyer or seller of that task.
   */
  async rateTask(taskId: string, params: {
    score: number;
    comment?: string;
    satisfaction?: 'excellent' | 'acceptable' | 'partial' | 'unacceptable';
    direction?: 'buyer_rates_provider' | 'provider_rates_buyer';
  }): Promise<void> {
    await this.request(
      `/v1/a2a/tasks/${taskId}/rate`,
      { method: 'POST', body: JSON.stringify({
        direction: params.direction || 'buyer_rates_provider',
        ...params,
      }) },
      'agent',
    );
  }

  // ─── AP2 Mandates ──────────────────────────────────────────────────────

  /**
   * Create a payment mandate via the public AP2 endpoint.
   * Authenticated as the buyer agent (their bearer token must be set).
   *
   * Note on semantics: the production task processor's settlement code
   * (`resolveSettlementMandate`) treats `mandate.agent_id` as the BUYER
   * (whose wallet gets debited) and reads the seller from
   * `metadata.providerAgentId` / `metadata.providerAccountId`. We mirror
   * those semantics here so settlement debits the right wallet.
   */
  async createMandate(params: {
    accountId: string;
    /** BUYER's agent id — the agent whose wallet will be debited on settlement */
    buyerAgentId: string;
    /** SELLER's agent id — stored in metadata.providerAgentId */
    providerAgentId: string;
    /** SELLER's parent account id — stored in metadata.providerAccountId */
    providerAccountId?: string;
    amount: number;
    currency: string;
    mandateType?: 'intent' | 'cart' | 'payment';
    a2aSessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ mandate_id: string; id: string; status: string }> {
    return this.request<{ mandate_id: string; id: string; status: string }>(
      '/v1/ap2/mandates',
      {
        method: 'POST',
        body: JSON.stringify({
          account_id: params.accountId,
          // Buyer's agent — required by resolveSettlementMandate to find caller wallet
          agent_id: params.buyerAgentId,
          mandate_type: params.mandateType || 'payment',
          authorized_amount: params.amount,
          currency: params.currency,
          a2a_session_id: params.a2aSessionId,
          metadata: {
            ...(params.metadata || {}),
            // Provider identity goes in metadata where resolveSettlementMandate reads it
            providerAgentId: params.providerAgentId,
            ...(params.providerAccountId ? { providerAccountId: params.providerAccountId } : {}),
          },
        }),
      },
      'agent',
    );
  }

  /**
   * Execute (settle) a mandate. Inserts an ap2_mandate_executions row,
   * runs KYA/limit checks via LimitService, increments used_amount.
   */
  async executeMandate(
    mandateId: string,
    params: { amount: number; currency: string; description?: string },
  ): Promise<unknown> {
    return this.request(
      `/v1/ap2/mandates/${mandateId}/execute`,
      {
        method: 'POST',
        body: JSON.stringify({
          amount: params.amount,
          currency: params.currency,
          description: params.description,
        }),
      },
      'agent',
    );
  }

  /** Read a mandate by id (UUID or user-defined mandate_id). */
  async getMandate(mandateId: string): Promise<any> {
    return this.request<any>(
      `/v1/ap2/mandates/${mandateId}`,
      { method: 'GET' },
      'agent',
    );
  }

  /**
   * Cancel a mandate via the PATCH endpoint (DB-backed).
   *
   * NOTE: there's a separate POST /v1/ap2/mandates/:id/revoke that goes
   * through the legacy in-memory mandate service and does NOT update the
   * database for mandates created via the public POST endpoint. PATCH is
   * the only path that actually marks our DB rows cancelled.
   *
   * Optional `metadataMerge` keys are merged onto the existing metadata
   * (read-modify-write) so the caller can record WHY without clobbering
   * the providerAgentId / source fields set at creation time.
   *
   * Idempotent: if the mandate is already cancelled or completed, this is
   * effectively a no-op.
   */
  async cancelMandate(
    mandateId: string,
    opts: { metadataMerge?: Record<string, unknown> } = {},
  ): Promise<void> {
    let mergedMetadata: Record<string, unknown> | undefined;
    if (opts.metadataMerge) {
      try {
        const current = await this.getMandate(mandateId);
        mergedMetadata = { ...(current?.metadata || {}), ...opts.metadataMerge };
      } catch {
        // If we can't read it, fall back to just sending the new keys —
        // we'd rather lose some metadata than fail to cancel the mandate.
        mergedMetadata = opts.metadataMerge;
      }
    }
    const body: Record<string, unknown> = { status: 'cancelled' };
    if (mergedMetadata) body.metadata = mergedMetadata;
    await this.request(
      `/v1/ap2/mandates/${mandateId}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      'agent',
    );
  }

  /** Backwards-compat alias for callers that still use revokeMandate. */
  async revokeMandate(mandateId: string): Promise<void> {
    return this.cancelMandate(mandateId);
  }

  // ─── Marketplace discovery ─────────────────────────────────────────────

  async listMarketplace(): Promise<Array<{ id: string; name: string; skills?: unknown[] }>> {
    return this.request('/v1/a2a/marketplace', { method: 'GET' }, 'apiKey');
  }

  // ─── Narrative (admin) ─────────────────────────────────────────────────

  async announce(scenario: string, description: string): Promise<void> {
    await this.request(
      '/admin/round/announce',
      { method: 'POST', body: JSON.stringify({ scenario, description }) },
      'admin',
    );
  }

  async comment(text: string, type: 'info' | 'finding' | 'alert' | 'governance' = 'info'): Promise<void> {
    await this.request(
      '/admin/round/comment',
      { method: 'POST', body: JSON.stringify({ text, type }) },
      'admin',
    );
  }

  async milestone(
    text: string,
    opts: {
      agentId?: string;
      agentName?: string;
      icon?: string;
      /** Target entity — for purchase milestones the viewer draws an agent→target edge. */
      toId?: string;
      toName?: string;
      toKind?: 'merchant' | 'agent';
      /** Settlement amount in `currency`, e.g. 0.50 USDC. Viewer sums these into live volume. */
      amount?: number;
      currency?: string;
      /**
       * For merchant_comparison: every merchant considered for this purchase,
       * including the winner. Viewer increments per-merchant "appeared in
       * comparisons" + "won comparisons" to compute market share.
       */
      considered?: Array<{ toId: string; toName: string; price?: number; rating?: number }>;
      /**
       * When drawing a graph edge (toKind='agent'|'merchant'), override the
       * default edge style. 'rejected' renders a red dashed edge — use for
       * governance blocks so operators see the mandate was refused, not lost.
       */
      edgeState?: 'rejected';
    } = {},
  ): Promise<void> {
    await this.request(
      '/admin/round/milestone',
      { method: 'POST', body: JSON.stringify({ text, ...opts }) },
      'admin',
    );
  }

  /**
   * Ask the platform for a fresh collusion-detector verdict on one agent.
   * Used mid-scenario to flag rings as they form, without having to hit the
   * full /v1/reputation endpoint (which also runs all other reputation
   * sources and is noisier for this purpose).
   */
  async checkCollusion(agentId: string): Promise<{
    flagged: boolean;
    reason: string | null;
    uniqueRaters: number;
    topRaterShare: number;
    reciprocalRatio: number;
    ringCoefficient: number;
    totalRatings: number;
    topRaters: string[];
  }> {
    // this.request() auto-unwraps { success, data } → data, so we get the
    // signals object directly.
    return await this.request(
      '/admin/round/check-collusion',
      { method: 'POST', body: JSON.stringify({ agentId }) },
      'admin',
    );
  }

  /** Update an agent's KYA tier (used by baseline mode to bypass restrictions). */
  async updateAgentTier(agentId: string, kyaTier: number): Promise<void> {
    try {
      await this.request(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        { method: 'PATCH', body: JSON.stringify({ kya_tier: kyaTier }) },
        'admin',
      );
    } catch {
      // Non-fatal
    }
  }

  /** Deactivate a skill on the platform (agent drops an underperforming skill). */
  async deactivateSkill(agentId: string, skillId: string): Promise<void> {
    try {
      await this.request(
        `/v1/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
        { method: 'PATCH', body: JSON.stringify({ status: 'inactive' }) },
        'admin',
      );
    } catch {
      // Non-fatal
    }
  }

  /** Update an agent's skill price on the platform so marketplace discovery reflects it. */
  async updateSkillPrice(agentId: string, skillId: string, price: number): Promise<void> {
    try {
      await this.request(
        `/v1/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillId)}`,
        { method: 'PATCH', body: JSON.stringify({ base_price: price }) },
        'admin',
      );
    } catch {
      // Non-fatal — price update is best-effort
    }
  }

  // ─── Merchants & Commerce (ACP / UCP / x402) ───────────────────────────

  /**
   * List UCP-discoverable merchants (POS merchants with `metadata.pos_provider`).
   *
   * Uses the admin-round proxy rather than /v1/ucp/merchants because admin
   * auth doesn't set ctx.tenantId, which the /v1 handler requires for its
   * per-tenant filter. The proxy is sim-tenant-scoped via SIM_TENANT_ID.
   */
  async listMerchants(
    filters: { type?: string; country?: string; search?: string; limit?: number } = {},
  ): Promise<Array<{
    id: string;
    name: string;
    merchant_id?: string;
    type?: string;
    country?: string;
    city?: string;
    currency?: string;
    description?: string;
    pos_provider?: string;
    catalog?: { total_products: number; categories: string[]; products: any[] };
  }>> {
    try {
      const res: any = await this.request('/admin/round/merchants', { method: 'GET' }, 'admin');
      const raw: any[] = Array.isArray(res) ? res : (res?.merchants ?? res?.data ?? []);
      // The admin proxy doesn't apply /v1's filters server-side — do it here.
      let list = raw;
      if (filters.type) list = list.filter((m) => m.type === filters.type);
      if (filters.country) list = list.filter((m) => m.country === filters.country);
      if (filters.search) {
        const needle = filters.search.toLowerCase();
        list = list.filter((m) => (m.name || '').toLowerCase().includes(needle));
      }
      return filters.limit ? list.slice(0, filters.limit) : list;
    } catch {
      return [];
    }
  }

  /**
   * Get a single merchant with full catalog. The admin proxy returns summary
   * records without the catalog, so we join a direct query via /v1 fallback
   * only when we already know the tenant (agent auth). Otherwise return the
   * summary and let the caller inspect metadata.
   */
  async getMerchant(merchantId: string): Promise<any | null> {
    try {
      // Try the full-detail /v1 endpoint first (requires tenant context).
      return await this.request(`/v1/ucp/merchants/${encodeURIComponent(merchantId)}`, { method: 'GET' }, 'admin');
    } catch {
      // Fallback: find it in the admin-proxy list.
      try {
        const list = await this.listMerchants({ limit: 100 });
        return list.find((m) => m.id === merchantId || m.merchant_id === merchantId) || null;
      } catch {
        return null;
      }
    }
  }

  /**
   * Create an ACP checkout session (fixed-catalog POS purchase).
   * The agent's API key is the auth scope — checkouts are tenant-scoped.
   */
  async createAcpCheckout(params: {
    checkout_id: string;
    agent_id: string;
    agent_name?: string;
    merchant_id: string;
    merchant_name?: string;
    account_id: string;
    items: Array<{ item_id?: string; name: string; quantity: number; unit_price: number; total_price: number; currency?: string }>;
    tax_amount?: number;
    shipping_amount?: number;
    discount_amount?: number;
    currency?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: string }> {
    return await this.request(
      '/v1/acp/checkouts',
      { method: 'POST', body: JSON.stringify(params) },
      'agent',
    );
  }

  /** Complete an ACP checkout (settles payment). */
  async completeAcpCheckout(
    checkoutId: string,
    params: { shared_payment_token: string; payment_method?: string; idempotency_key?: string },
  ): Promise<{ id: string; status: string; order_id?: string }> {
    return await this.request(
      `/v1/acp/checkouts/${encodeURIComponent(checkoutId)}/complete`,
      { method: 'POST', body: JSON.stringify(params) },
      'agent',
    );
  }

  /** Create a UCP checkout (full commerce lifecycle: create → instrument → complete). */
  async createUcpCheckout(params: {
    currency: string;
    line_items?: Array<{ name: string; quantity: number; unit_price: number; [k: string]: unknown }>;
    buyer?: Record<string, unknown>;
    shipping_address?: Record<string, unknown>;
    checkout_type?: 'physical' | 'digital' | 'service';
    agent_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string; status: string }> {
    return await this.request(
      '/v1/ucp/checkouts',
      { method: 'POST', body: JSON.stringify(params) },
      'agent',
    );
  }

  /** Attach a payment instrument to a UCP checkout. */
  async addUcpInstrument(
    checkoutId: string,
    params: { id: string; handler: string; type: string; last4?: string; brand?: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await this.request(
      `/v1/ucp/checkouts/${encodeURIComponent(checkoutId)}/instruments`,
      { method: 'POST', body: JSON.stringify(params) },
      'agent',
    );
  }

  /** Complete a UCP checkout. */
  async completeUcpCheckout(checkoutId: string): Promise<{ id: string; status: string; order_id?: string }> {
    return await this.request(
      `/v1/ucp/checkouts/${encodeURIComponent(checkoutId)}/complete`,
      { method: 'POST', body: JSON.stringify({}) },
      'agent',
    );
  }

  /**
   * List x402 priced endpoints (compute/content/API catalog).
   *
   * Same story as listMerchants — admin auth needs the /admin/round/* proxy
   * because /v1/x402/endpoints filters by ctx.tenantId.
   */
  async listX402Endpoints(
    filters: { status?: string; accountId?: string; limit?: number } = {},
  ): Promise<Array<{
    id: string;
    name?: string;
    path?: string;
    method?: string;
    base_price?: number;
    price?: number;
    currency?: string;
    account_id?: string;
    status?: string;
  }>> {
    try {
      const res: any = await this.request('/admin/round/x402-endpoints', { method: 'GET' }, 'admin');
      const raw: any[] = Array.isArray(res) ? res : (res?.endpoints ?? res?.data ?? []);
      let list = raw;
      if (filters.status) list = list.filter((e) => e.status === filters.status);
      if (filters.accountId) list = list.filter((e) => e.account_id === filters.accountId);
      return filters.limit ? list.slice(0, filters.limit) : list;
    } catch {
      return [];
    }
  }

  /** Fetch a quote for an x402 endpoint (current price). */
  async quoteX402(endpointId: string): Promise<{ amount: number; currency: string } | null> {
    try {
      const r: any = await this.request(`/v1/x402/quote/${encodeURIComponent(endpointId)}`, { method: 'GET' }, 'agent');
      return { amount: Number(r?.amount ?? r?.price ?? 0), currency: r?.currency ?? 'USDC' };
    } catch {
      return null;
    }
  }

  /**
   * Submit a merchant rating (agent-auth). Agent must have transacted with
   * this merchant — the API enforces it. Fire-and-forget in scenarios
   * (ratings shouldn't block the cycle), so caller can ignore the promise.
   *
   * Dimensions are 1-5 integers; any subset can be provided. At least one
   * dimension is required.
   */
  async rateMerchant(
    merchantAccountId: string,
    dims: {
      navigation?: number;
      price_accuracy?: number;
      response_speed?: number;
      fulfillment?: number;
      error_clarity?: number;
    },
    opts: { checkoutId?: string; checkoutProtocol?: 'acp' | 'ucp' | 'x402'; comment?: string } = {},
  ): Promise<{ id: string } | null> {
    try {
      return await this.request(
        `/v1/merchants/${encodeURIComponent(merchantAccountId)}/ratings`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...dims,
            checkout_id: opts.checkoutId,
            checkout_protocol: opts.checkoutProtocol,
            comment: opts.comment,
          }),
        },
        'agent',
      );
    } catch {
      return null;
    }
  }

  /** One-shot x402 payment — buyer pays for one request against a known endpoint. */
  async payX402(params: {
    endpointId: string;
    requestId: string;
    amount: number;
    currency: 'USDC' | 'EURC';
    walletId: string;
    method: string;
    path: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  }): Promise<{ success: boolean; transferId?: string }> {
    const body = {
      ...params,
      timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    };
    return await this.request(
      '/v1/x402/pay',
      { method: 'POST', body: JSON.stringify(body) },
      'agent',
    );
  }

  /**
   * Fetch an agent's platform record (admin auth). Used for pre-flight status
   * checks and post-error disambiguation (is this agent killed or just
   * temporarily failing?).
   */
  async getAgent(agentId: string): Promise<{
    id: string;
    name: string;
    status: 'active' | 'suspended' | 'frozen' | 'closed';
    kya_tier?: number;
  } | null> {
    try {
      const data: any = await this.request(
        `/v1/agents/${encodeURIComponent(agentId)}`,
        { method: 'GET' },
        'admin',
      );
      const d = data?.data || data;
      if (!d || !d.id) return null;
      return {
        id: d.id,
        name: d.name ?? '',
        status: d.status ?? 'active',
        kya_tier: d.kya_tier,
      };
    } catch {
      return null;
    }
  }

  /** Fetch an agent's reputation from the platform. */
  async getReputation(agentId: string): Promise<{ score: number; tier: string; confidence: string } | null> {
    try {
      const data: any = await this.request(
        `/v1/reputation/${encodeURIComponent(agentId)}`,
        { method: 'GET' },
        'admin',
      );
      const d = data?.data || data;
      return {
        score: d?.score ?? 0,
        tier: d?.tier ?? 'F',
        confidence: d?.confidence ?? 'none',
      };
    } catch {
      return null;
    }
  }

  /**
   * x402 fetch against an EXTERNAL URL — the agentic.market style flow.
   *
   * Mirrors what the MCP `x402_fetch` tool does (packages/mcp-server/src/
   * server-factory.ts:1953+). Probe the URL, parse the 402 challenge, get
   * the agent's signed authorization from /v1/agents/:id/x402-sign, build
   * an X-PAYMENT envelope, retry. The platform records a transfer for the
   * sign + a record-settlement on completion / failure so the ledger
   * reflects what actually happened on-chain.
   *
   * Used by the external_marketplace_x402 sim block to drive real
   * agentic.market endpoints; differs from `payX402` (which only handles
   * Sly-internal endpoints by `endpointId`).
   */
  async x402FetchExternal(params: {
    agentId: string;
    url: string;
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    /** Cap in token base units (string). e.g. "100000" = $0.10 USDC. */
    maxPriceBaseUnits?: string;
    /** Captured intent for the ledger row — what the agent thought it was buying. */
    agentReason?: string;
  }): Promise<{
    paid: boolean;
    status: number | null;
    pricePaidBaseUnits?: string;
    network?: string;
    transferId?: string | null;
    bodyPreview?: string;
    bodyParsed?: any;
    error?: string;
  }> {
    const method = params.method || 'GET';
    const baseHeaders: Record<string, string> = { Accept: 'application/json', ...(params.headers || {}) };
    const firstInit: RequestInit = { method, headers: baseHeaders };
    if (params.body !== undefined) firstInit.body = params.body;

    const firstRes = await fetch(params.url, firstInit);
    if (firstRes.status !== 402) {
      const text = await firstRes.text();
      return { paid: false, status: firstRes.status, bodyPreview: text.slice(0, 1024) };
    }

    const challengeText = await firstRes.text();
    let challenge = safeParseJson(challengeText);
    if (!challenge || typeof challenge !== 'object' || !pickX402Accept(challenge)) {
      const headerChallenge = decodePaymentRequiredHeader(firstRes.headers.get('payment-required'));
      if (headerChallenge) challenge = headerChallenge;
    }
    const accept = pickX402Accept(challenge);
    if (!accept) {
      return { paid: false, status: 402, error: `402 with no usable accepts[] entry. Body: ${challengeText.slice(0, 200)}` };
    }
    if (accept.scheme && accept.scheme !== 'exact') {
      return { paid: false, status: 402, error: `Unsupported x402 scheme "${accept.scheme}"` };
    }
    const amount = String(accept.amount ?? accept.maxAmountRequired ?? '');
    const payTo = accept.payTo;
    if (!payTo || !amount) {
      return { paid: false, status: 402, error: `Challenge missing payTo or amount: ${JSON.stringify(accept)}` };
    }
    if (params.maxPriceBaseUnits && BigInt(amount) > BigInt(params.maxPriceBaseUnits)) {
      return { paid: false, status: 402, error: `Challenge amount ${amount} exceeds maxPriceBaseUnits ${params.maxPriceBaseUnits}` };
    }
    const chainId = networkToChainId(accept.network);
    if (!chainId) {
      return { paid: false, status: 402, error: `Unsupported network "${accept.network}"` };
    }

    const timeoutSec = Number(accept.maxTimeoutSeconds) > 0 ? Number(accept.maxTimeoutSeconds) : 300;
    const validBefore = Math.floor(Date.now() / 1000) + timeoutSec;
    let derivedHost: string | null = null;
    let derivedPath: string | null = null;
    try {
      const u = new URL(params.url);
      derivedHost = u.hostname;
      derivedPath = u.pathname;
    } catch { /* malformed url */ }
    const resourcePayload = {
      url: params.url,
      host: derivedHost,
      path: derivedPath,
      method,
      marketplace: derivedHost && /agentic\.market$|\.agentic\.market$/i.test(derivedHost) ? 'agentic.market' : null,
    };

    let signed: any;
    try {
      signed = await this.request<any>(
        `/v1/agents/${encodeURIComponent(params.agentId)}/x402-sign`,
        {
          method: 'POST',
          body: JSON.stringify({
            to: payTo,
            value: amount,
            chainId,
            validBefore,
            resource: resourcePayload,
            ...(params.agentReason ? { intent: { reason: params.agentReason } } : {}),
          }),
        },
        'agent',
      );
    } catch (e: any) {
      return { paid: false, status: 402, error: `x402-sign failed: ${e.message || String(e)}` };
    }

    const safeRecord = async (failureReason: string): Promise<void> => {
      if (!signed?.transferId) return;
      try {
        await this.request(
          `/v1/transfers/${signed.transferId}/record-settlement`,
          { method: 'POST', body: JSON.stringify({ failureReason: failureReason.slice(0, 500) }) },
          'agent',
        );
      } catch { /* swallow — best-effort cleanup */ }
    };

    let xPaymentHeader: string;
    try {
      xPaymentHeader = buildX402PaymentHeader(challenge, signed);
    } catch (e: any) {
      await safeRecord(`buildX402PaymentHeader failed: ${e.message || String(e)}`);
      return { paid: false, status: 402, error: `buildX402PaymentHeader: ${e.message}`, transferId: signed?.transferId || null };
    }

    const secondInit: RequestInit = {
      method,
      headers: { ...baseHeaders, 'X-PAYMENT': xPaymentHeader },
    };
    if (params.body !== undefined) secondInit.body = params.body;

    let secondRes: Response;
    let secondText = '';
    try {
      secondRes = await fetch(params.url, secondInit);
      secondText = await secondRes.text();
    } catch (e: any) {
      const reason = `vendor unreachable: ${e?.message || String(e)}`;
      await safeRecord(reason);
      return { paid: false, status: null, error: reason, transferId: signed?.transferId || null };
    }

    const paid = secondRes.status >= 200 && secondRes.status < 300;
    if (!paid) {
      await safeRecord(`Vendor returned ${secondRes.status}: ${secondText.slice(0, 200)}`);
    }
    return {
      paid,
      status: secondRes.status,
      pricePaidBaseUnits: paid ? amount : undefined,
      network: accept.network,
      transferId: signed?.transferId || null,
      bodyPreview: secondText.slice(0, 1024),
      bodyParsed: paid ? safeParseJson(secondText) : undefined,
    };
  }
}

// ─── x402 helpers (mirrors packages/mcp-server/src/server-factory.ts) ───
//
// Inlined here so the sim doesn't need a runtime dep on the MCP package.
// Keep these in sync if the upstream challenge format evolves.

function safeParseJson(s: string): any {
  try { return JSON.parse(s); } catch { return null; }
}

function pickX402Accept(challenge: any): any | null {
  if (!challenge || typeof challenge !== 'object') return null;
  if (Array.isArray(challenge.accepts) && challenge.accepts.length > 0) {
    const supported = challenge.accepts.find((a: any) => {
      if (!a || typeof a !== 'object') return false;
      return networkToChainId(a.network) !== null;
    });
    return supported || challenge.accepts[0];
  }
  if (challenge.scheme && challenge.network) return challenge;
  return null;
}

function decodePaymentRequiredHeader(header: string | null | undefined): any | null {
  if (!header) return null;
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function networkToChainId(network: string | undefined): number | null {
  if (!network) return null;
  const n = String(network).toLowerCase();
  if (n === 'base' || n === 'eip155:8453') return 8453;
  if (n === 'base-sepolia' || n === 'eip155:84532') return 84532;
  const m = n.match(/^eip155:(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

function buildX402PaymentHeader(challenge: any, signed: any): string {
  const accept = pickX402Accept(challenge) || {};
  const x402Version = (challenge && typeof challenge === 'object' && challenge.x402Version) || 2;
  const scheme = accept.scheme || 'exact';
  const network = accept.network || (signed.chainId === 84532 ? 'base-sepolia' : 'base');
  const envelope = {
    x402Version,
    scheme,
    network,
    payload: {
      authorization: {
        from: signed.from,
        to: signed.to,
        value: String(signed.value),
        validAfter: String(signed.validAfter ?? 0),
        validBefore: String(signed.validBefore),
        nonce: signed.nonce,
      },
      signature: signed.signature,
    },
  };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64');
}
