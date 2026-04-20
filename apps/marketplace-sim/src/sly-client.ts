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

  async milestone(text: string, opts: { agentId?: string; agentName?: string; icon?: string } = {}): Promise<void> {
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

  /** List UCP-discoverable merchants (POS merchants with `metadata.pos_provider`). */
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
    const q = new URLSearchParams();
    if (filters.type) q.set('type', filters.type);
    if (filters.country) q.set('country', filters.country);
    if (filters.search) q.set('search', filters.search);
    q.set('limit', String(filters.limit ?? 50));
    const path = `/v1/ucp/merchants?${q.toString()}`;
    try {
      const res: any = await this.request(path, { method: 'GET' }, 'admin');
      return Array.isArray(res) ? res : (res?.merchants ?? res?.data ?? []);
    } catch {
      return [];
    }
  }

  /** Get a single merchant with full catalog. */
  async getMerchant(merchantId: string): Promise<any | null> {
    try {
      return await this.request(`/v1/ucp/merchants/${encodeURIComponent(merchantId)}`, { method: 'GET' }, 'admin');
    } catch {
      return null;
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
      'apiKey',
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
      'apiKey',
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
      'apiKey',
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
      'apiKey',
    );
  }

  /** Complete a UCP checkout. */
  async completeUcpCheckout(checkoutId: string): Promise<{ id: string; status: string; order_id?: string }> {
    return await this.request(
      `/v1/ucp/checkouts/${encodeURIComponent(checkoutId)}/complete`,
      { method: 'POST', body: JSON.stringify({}) },
      'apiKey',
    );
  }

  /** List x402 priced endpoints (compute/content/API catalog). */
  async listX402Endpoints(
    filters: { status?: string; accountId?: string; limit?: number } = {},
  ): Promise<Array<{
    id: string;
    name?: string;
    path?: string;
    method?: string;
    price?: number;
    currency?: string;
    account_id?: string;
  }>> {
    const q = new URLSearchParams();
    if (filters.status) q.set('status', filters.status);
    if (filters.accountId) q.set('account_id', filters.accountId);
    q.set('limit', String(filters.limit ?? 50));
    try {
      const res: any = await this.request(`/v1/x402/endpoints?${q.toString()}`, { method: 'GET' }, 'admin');
      return Array.isArray(res) ? res : (res?.endpoints ?? res?.data ?? []);
    } catch {
      return [];
    }
  }

  /** Fetch a quote for an x402 endpoint (current price). */
  async quoteX402(endpointId: string): Promise<{ amount: number; currency: string } | null> {
    try {
      const r: any = await this.request(`/v1/x402/quote/${encodeURIComponent(endpointId)}`, { method: 'GET' }, 'apiKey');
      return { amount: Number(r?.amount ?? r?.price ?? 0), currency: r?.currency ?? 'USDC' };
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
      'apiKey',
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
}
