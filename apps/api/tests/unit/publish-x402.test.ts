/**
 * publish-x402 state-machine tests.
 *
 * The Supabase client is mocked so we can drive the row state and inspect
 * what the service writes back. Each test pins one transition:
 *   - missing prereqs → failed
 *   - bad metadata → failed
 *   - happy path → publishing → processing
 *   - idempotency: published+clean is a no-op
 *   - extension_rejected from CDP → failed
 *
 * The synthetic first-settle is skipped via `skipFirstSettle` for tests
 * that don't exercise the CDP HTTP boundary, and intercepted via a fetch
 * mock for the one that does.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  publishEndpoint,
  unpublishEndpoint,
} from '../../src/services/publish-x402.js';
import type { RequestContext } from '../../src/middleware/auth.js';

// ────────────────────────────────────────────────────────────────────────────
// Supabase mock
// ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;

interface FakeDb {
  endpoints: Map<string, Row>;
  wallets: Map<string, Row>;
  events: Row[];
}

function makeSupabase(db: FakeDb) {
  // Generic fluent-API matcher. Each .from() returns a shape that supports
  // chained .select/.eq/.in/.update/.insert/.delete with terminal .single
  // or thenable iteration. We only implement the verbs publish-x402 actually
  // uses — anything else falls through to a tracked stub.
  function tableHandler(table: string) {
    return {
      select(_cols?: string) {
        return queryBuilder(table, { type: 'select' });
      },
      insert(payload: Row | Row[]) {
        const rows = Array.isArray(payload) ? payload : [payload];
        if (table === 'x402_publish_events') {
          for (const r of rows) db.events.push({ ...r, id: `evt-${db.events.length + 1}` });
          return {
            select() {
              return {
                single: async () => ({ data: rows[0], error: null }),
              };
            },
            then(resolve: any) {
              resolve({ data: rows[0], error: null });
            },
          };
        }
        if (table === 'tenant_payout_wallets') {
          const id = `w-${db.wallets.size + 1}`;
          const row = {
            id,
            ...rows[0],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          db.wallets.set(id, row);
          return {
            select() {
              return {
                single: async () => ({ data: row, error: null }),
              };
            },
          };
        }
        return {
          select() {
            return { single: async () => ({ data: rows[0], error: null }) };
          },
        };
      },
      update(patch: Row) {
        return {
          _patch: patch,
          eq(col: string, val: any) {
            return updater(table, patch, [{ col, val }]);
          },
        };
      },
    };
  }

  function updater(table: string, patch: Row, conds: Array<{ col: string; val: any }>) {
    const apply = async () => {
      if (table === 'x402_endpoints') {
        for (const [id, row] of db.endpoints) {
          if (conds.every((c) => row[c.col] === c.val) || (conds[0].col === 'id' && id === conds[0].val)) {
            db.endpoints.set(id, { ...row, ...patch });
          }
        }
      }
      return { data: null, error: null };
    };
    const builder: any = {
      eq(col: string, val: any) {
        conds.push({ col, val });
        return builder;
      },
      then(resolve: any) {
        apply().then(resolve);
      },
    };
    return builder;
  }

  function queryBuilder(table: string, _opts: { type: 'select' }) {
    const conds: Array<{ col: string; val: any | any[]; op: 'eq' | 'in' }> = [];
    const builder: any = {
      eq(col: string, val: any) {
        conds.push({ col, val, op: 'eq' });
        return builder;
      },
      in(col: string, vals: any[]) {
        conds.push({ col, val: vals, op: 'in' });
        return builder;
      },
      neq() {
        return builder;
      },
      order() {
        return builder;
      },
      limit() {
        return builder;
      },
      contains() {
        return builder;
      },
      range() {
        return builder;
      },
      async single() {
        const rows = collect();
        if (rows.length === 0) return { data: null, error: { message: 'not found' } };
        return { data: rows[0], error: null };
      },
      then(resolve: any) {
        resolve({ data: collect(), error: null });
      },
    };
    function collect(): Row[] {
      let rows: Row[] = [];
      if (table === 'x402_endpoints') rows = Array.from(db.endpoints.values());
      else if (table === 'tenant_payout_wallets') rows = Array.from(db.wallets.values());
      else if (table === 'x402_publish_events') rows = [...db.events];
      else if (table === 'tenants') rows = [{ id: 't-1', slug: 'acme' }];
      for (const c of conds) {
        if (c.op === 'eq') rows = rows.filter((r) => r[c.col] === c.val);
        else if (c.op === 'in') rows = rows.filter((r) => (c.val as any[]).includes(r[c.col]));
      }
      return rows;
    }
    return builder;
  }

  return {
    from: (table: string) => tableHandler(table),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────────────

const ctx: RequestContext = {
  tenantId: 't-1',
  actorType: 'user',
  userId: 'u-1',
};

function seedEndpoint(db: FakeDb, overrides: Partial<Row> = {}) {
  const id = overrides.id ?? 'ep-1';
  const row: Row = {
    id,
    tenant_id: 't-1',
    account_id: 'acct-1',
    name: 'Weather',
    description: 'Returns a weather forecast for the requested city today.',
    path: '/weather',
    method: 'GET',
    base_price: '0.01',
    currency: 'USDC',
    network: 'base-mainnet',
    payment_address: 'internal://payos/t-1/acct-1',
    service_slug: 'weather',
    backend_url: 'https://internal.example.com/weather',
    visibility: 'private',
    publish_status: 'draft',
    publish_error: null,
    facilitator_mode: 'internal',
    metadata_dirty: false,
    discovery_metadata: {
      description: 'Returns a weather forecast for the requested city today.',
      output: { schema: { type: 'object' }, example: { temp: 72 } },
    },
    category: null,
    ...overrides,
  };
  db.endpoints.set(id, row);
  return row;
}

function seedWallet(db: FakeDb, address = '0x1234567890abcdef1234567890abcdef12345678') {
  const id = 'w-1';
  db.wallets.set(id, {
    id,
    tenant_id: 't-1',
    account_id: 'acct-1',
    network: 'eip155:8453',
    address,
    provisioned_by: 'user',
    provider: 'external',
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

function makeDb(): FakeDb {
  return { endpoints: new Map(), wallets: new Map(), events: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('publishEndpoint — happy path', () => {
  it('moves draft → publishing → processing on a clean GET endpoint', async () => {
    const db = makeDb();
    seedEndpoint(db);
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1', {
      skipFirstSettle: true,
    });

    expect(result.status).toBe('ok');
    // Without first-settle, the state machine still flips to processing —
    // CDP is the source of truth for that final transition in production.
    expect(result.publishStatus).toBe('processing');

    const ep = db.endpoints.get('ep-1')!;
    expect(ep.facilitator_mode).toBe('cdp');
    expect(ep.visibility).toBe('public');
    expect(ep.payment_address).toMatch(/^0x/);
    expect(ep.metadata_dirty).toBe(false);

    const events = db.events.map((e) => e.event);
    expect(events).toContain('publish_requested');
    expect(events).toContain('validated');
  });
});

describe('publishEndpoint — preflight failures', () => {
  it('fails when service_slug is missing', async () => {
    const db = makeDb();
    seedEndpoint(db, { service_slug: null });
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1', { skipFirstSettle: true });

    expect(result.status).toBe('failed');
    expect(result.publishStatus).toBe('failed');
    expect(result.errors?.some((e) => e.field === 'service_slug')).toBe(true);
  });

  it('fails when backend_url is missing', async () => {
    const db = makeDb();
    seedEndpoint(db, { backend_url: null, discovery_metadata: { description: 'a'.repeat(40) } });
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1', { skipFirstSettle: true });

    expect(result.status).toBe('failed');
    expect(result.errors?.some((e) => e.field === 'backend_url')).toBe(true);
  });

  it('fails when description is too short', async () => {
    const db = makeDb();
    seedEndpoint(db, {
      description: 'short',
      discovery_metadata: {
        description: 'short',
        output: { schema: { type: 'object' }, example: {} },
      },
    });
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1', { skipFirstSettle: true });

    expect(result.status).toBe('failed');
    expect(result.errors?.some((e) => e.field === 'description')).toBe(true);
  });
});

describe('publishEndpoint — idempotency', () => {
  it('re-publishing a clean published endpoint is a no-op', async () => {
    const db = makeDb();
    seedEndpoint(db, {
      visibility: 'public',
      publish_status: 'published',
      facilitator_mode: 'cdp',
      metadata_dirty: false,
    });
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1', { skipFirstSettle: true });

    expect(result.status).toBe('ok');
    expect(result.publishStatus).toBe('published');
    // No publish_requested event written — no-op short-circuit
    expect(db.events.find((e) => e.event === 'publish_requested')).toBeUndefined();
  });

  it('force=true re-runs the flow even when clean', async () => {
    const db = makeDb();
    seedEndpoint(db, {
      visibility: 'public',
      publish_status: 'published',
      facilitator_mode: 'cdp',
      metadata_dirty: false,
    });
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    await publishEndpoint(supabase, ctx, 'ep-1', { force: true, skipFirstSettle: true });

    const events = db.events.map((e) => e.event);
    // force=true emits republish_requested instead of publish_requested
    expect(events).toContain('republish_requested');
  });
});

describe('publishEndpoint — first-settle probe', () => {
  beforeEach(() => {
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    delete process.env.CDP_WALLET_SECRET;
    delete process.env.SLY_PUBLISH_PROBE_WALLET_ID;
  });

  it('moves to processing when probe creds are missing (best-effort skip)', async () => {
    // No CDP env vars: the probe is skipped and the endpoint transitions
    // to `processing` optimistically — the gateway will overwrite when an
    // organic settle lands.
    const db = makeDb();
    seedEndpoint(db);
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1');

    expect(result.status).toBe('ok');
    expect(result.publishStatus).toBe('processing');
    const events = db.events.map((e) => e.event);
    expect(events).toContain('first_settle');
  });

  it('marks endpoint failed when probe creds present but the buyer signer fails', async () => {
    // With creds set to bogus values, loading the CDP signer will throw
    // (invalid PEM, unknown wallet, etc.). The function reports `rejected`
    // with `probe-signer-failed:` prefix and the publish lifecycle
    // transitions to `failed`.
    process.env.CDP_API_KEY_ID = 'test-id';
    process.env.CDP_API_KEY_SECRET = 'test-secret';
    process.env.CDP_WALLET_SECRET = 'test-wallet-secret';
    process.env.SLY_PUBLISH_PROBE_WALLET_ID = '0x0000000000000000000000000000000000000000';

    const db = makeDb();
    seedEndpoint(db);
    seedWallet(db);
    const supabase: any = makeSupabase(db);

    const result = await publishEndpoint(supabase, ctx, 'ep-1');

    expect(result.status).toBe('failed');
    expect(result.publishError).toMatch(/probe-signer-failed|sdk-load-failed|gateway-/);
    const ep = db.endpoints.get('ep-1')!;
    expect(ep.publish_status).toBe('failed');
    const events = db.events.map((e) => e.event);
    expect(events).toContain('extension_rejected');
  });
});

describe('unpublishEndpoint', () => {
  it('flips visibility back to private and writes audit events', async () => {
    const db = makeDb();
    seedEndpoint(db, {
      visibility: 'public',
      publish_status: 'published',
      facilitator_mode: 'cdp',
    });
    const supabase: any = makeSupabase(db);

    const result = await unpublishEndpoint(supabase, ctx, 'ep-1');

    expect(result.publishStatus).toBe('unpublished');
    const ep = db.endpoints.get('ep-1')!;
    expect(ep.visibility).toBe('private');
    expect(ep.facilitator_mode).toBe('internal');
    expect(ep.publish_status).toBe('unpublished');

    const events = db.events.map((e) => e.event);
    expect(events).toContain('unpublish_requested');
    expect(events).toContain('unpublished');
  });
});
