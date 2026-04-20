#!/usr/bin/env tsx
/**
 * Seed UCP merchants + x402 endpoints for the marketplace simulator.
 *
 * Idempotent: re-running updates existing rows with the same `invu_merchant_id`
 * (for merchants) or `name + path` (for x402 endpoints).
 *
 * Target tenant: SIM_TENANT_ID env var, or the built-in "Competitor Corp" fixture
 * (aaaaaaaa-0000-0000-0000-000000000002) where the sim agents live.
 *
 * Run: `SIM_TENANT_ID=<uuid> pnpm --filter @sly/api tsx scripts/seed-sim-commerce.ts`
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TENANT_ID = process.env.SIM_TENANT_ID || 'aaaaaaaa-0000-0000-0000-000000000002';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY);

interface MerchantSpec {
  merchant_id: string;   // stable id for idempotency
  name: string;
  type: 'hotel' | 'airline' | 'retail' | 'restaurant' | 'service';
  country: string;
  city: string;
  description: string;
  currency: string;
  pos_provider: string;
  /** 1.0–5.0. Used by merchant_comparison scenarios to drive persona-based selection. */
  rating?: number;
  catalog: Array<{
    id: string;
    name: string;
    category: string;
    unit_price_cents: number;
    currency: string;
    description?: string;
    /** Cross-merchant SKU: products sharing a sku compete. Optional on non-competing items. */
    sku?: string;
  }>;
}

// 4 UCP/ACP merchants with real-shaped catalogs.
const MERCHANTS: MerchantSpec[] = [
  {
    merchant_id: 'sim_hotel_001',
    name: 'Panama Bay Hotel',
    type: 'hotel',
    country: 'PA',
    city: 'Panama City',
    description: 'Boutique hotel in Casco Viejo. Rooms and airport transfers available for agent bookings.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    catalog: [
      { id: 'room_std', name: 'Standard Room (1 night)', category: 'lodging', unit_price_cents: 12000, currency: 'USDC', description: 'Queen bed, city view' },
      { id: 'room_ste', name: 'Suite (1 night)', category: 'lodging', unit_price_cents: 22000, currency: 'USDC', description: 'Separate living area' },
      { id: 'xfer_ap', name: 'Airport Transfer', category: 'transport', unit_price_cents: 3500, currency: 'USDC' },
      { id: 'brk_buffet', name: 'Breakfast Buffet', category: 'food', unit_price_cents: 1500, currency: 'USDC' },
    ],
  },
  {
    merchant_id: 'sim_air_001',
    name: 'Aero Istmo',
    type: 'airline',
    country: 'PA',
    city: 'Panama City',
    description: 'Regional carrier covering Central America routes.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    catalog: [
      { id: 'pty_sjo', name: 'PTY → SJO one-way', category: 'flight', unit_price_cents: 8500, currency: 'USDC' },
      { id: 'pty_cr7', name: 'PTY → Medellín one-way', category: 'flight', unit_price_cents: 11500, currency: 'USDC' },
      { id: 'pty_mia', name: 'PTY → Miami one-way', category: 'flight', unit_price_cents: 24000, currency: 'USDC' },
      { id: 'bag_add', name: 'Extra Checked Bag', category: 'ancillary', unit_price_cents: 3500, currency: 'USDC' },
    ],
  },
  {
    merchant_id: 'sim_retail_001',
    name: 'Volcán Coffee Roasters',
    type: 'retail',
    country: 'PA',
    city: 'Boquete',
    description: 'Specialty coffee, shipped worldwide.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    catalog: [
      { id: 'geisha_250', name: 'Geisha 250g', category: 'coffee', unit_price_cents: 2800, currency: 'USDC' },
      { id: 'natural_250', name: 'Natural Process 250g', category: 'coffee', unit_price_cents: 1800, currency: 'USDC' },
      { id: 'sampler_3', name: 'Sampler Trio 3×100g', category: 'coffee', unit_price_cents: 3200, currency: 'USDC' },
      { id: 'ship_int', name: 'International Shipping', category: 'shipping', unit_price_cents: 1200, currency: 'USDC' },
    ],
  },
  {
    merchant_id: 'sim_svc_001',
    name: 'Ciudad Concierge',
    type: 'service',
    country: 'PA',
    city: 'Panama City',
    description: 'Local dining reservations, tours, and ticket concierge.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    catalog: [
      { id: 'tour_city', name: 'Half-Day City Tour', category: 'tour', unit_price_cents: 4500, currency: 'USDC' },
      { id: 'tour_canal', name: 'Panama Canal Tour', category: 'tour', unit_price_cents: 7500, currency: 'USDC' },
      { id: 'res_fine', name: 'Fine-Dining Reservation', category: 'reservation', unit_price_cents: 800, currency: 'USDC' },
      { id: 'tix_museum', name: 'Biomuseo Ticket', category: 'ticket', unit_price_cents: 1800, currency: 'USDC' },
    ],
  },
  // ─── Competing roasters — same SKUs at different prices + ratings ───
  // These drive the merchant_comparison scenario. Each product shares an `sku`
  // across merchants so the scenario block can group competing listings.
  {
    merchant_id: 'sim_roaster_a',
    name: 'Atlas Coffee Roasters',
    type: 'retail',
    country: 'PA',
    city: 'Boquete',
    description: 'Premium-tier roaster, highest rated, prices to match.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    rating: 4.9,
    catalog: [
      { id: 'atlas_single_250', sku: 'sku_single_origin_250g', name: 'Single Origin 250g', category: 'coffee', unit_price_cents: 2800, currency: 'USDC', description: 'Premium bourbon, hand-sorted' },
      { id: 'atlas_blend_500', sku: 'sku_signature_blend_500g', name: 'Signature Blend 500g', category: 'coffee', unit_price_cents: 4200, currency: 'USDC' },
      { id: 'atlas_decaf_250', sku: 'sku_decaf_250g', name: 'Decaf 250g', category: 'coffee', unit_price_cents: 2600, currency: 'USDC' },
    ],
  },
  {
    merchant_id: 'sim_roaster_b',
    name: 'Budget Beans Co.',
    type: 'retail',
    country: 'PA',
    city: 'Panama City',
    description: 'Cheapest in market, mid-grade beans.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    rating: 3.8,
    catalog: [
      { id: 'bb_single_250', sku: 'sku_single_origin_250g', name: 'Single Origin 250g', category: 'coffee', unit_price_cents: 1900, currency: 'USDC', description: 'Standard grade' },
      { id: 'bb_blend_500', sku: 'sku_signature_blend_500g', name: 'Signature Blend 500g', category: 'coffee', unit_price_cents: 2900, currency: 'USDC' },
      { id: 'bb_decaf_250', sku: 'sku_decaf_250g', name: 'Decaf 250g', category: 'coffee', unit_price_cents: 1700, currency: 'USDC' },
    ],
  },
  {
    merchant_id: 'sim_roaster_c',
    name: 'Midtown Roastery',
    type: 'retail',
    country: 'PA',
    city: 'Panama City',
    description: 'Middle-of-market, balanced price-to-quality.',
    currency: 'USDC',
    pos_provider: 'sly-demo',
    rating: 4.4,
    catalog: [
      { id: 'mt_single_250', sku: 'sku_single_origin_250g', name: 'Single Origin 250g', category: 'coffee', unit_price_cents: 2300, currency: 'USDC' },
      { id: 'mt_blend_500', sku: 'sku_signature_blend_500g', name: 'Signature Blend 500g', category: 'coffee', unit_price_cents: 3500, currency: 'USDC' },
      { id: 'mt_decaf_250', sku: 'sku_decaf_250g', name: 'Decaf 250g', category: 'coffee', unit_price_cents: 2100, currency: 'USDC' },
    ],
  },
];

// Merchant-owned x402 endpoints (compute / content / data APIs).
// Each entry is (endpointName, path, method, basePriceUsdc, description).
const X402_MERCHANTS: Array<{
  merchantId: string;
  endpoints: Array<{ name: string; path: string; method: 'GET' | 'POST'; price: number; description: string }>;
}> = [
  {
    merchantId: 'sim_api_001',
    endpoints: [
      { name: 'Web Search API', path: '/x402/merchants/search/query', method: 'POST', price: 0.01, description: 'Search 10M-page index; returns ranked URLs + snippets' },
      { name: 'Summarizer API', path: '/x402/merchants/summarize/content', method: 'POST', price: 0.02, description: 'LLM-powered article summarization' },
      { name: 'Translation API', path: '/x402/merchants/translate/text', method: 'POST', price: 0.015, description: 'Multi-language translation' },
    ],
  },
  {
    merchantId: 'sim_cnt_001',
    endpoints: [
      { name: 'Premium Article', path: '/x402/merchants/content/article', method: 'GET', price: 0.10, description: 'Paywalled investigative journalism piece' },
      { name: 'Research Report', path: '/x402/merchants/content/report', method: 'GET', price: 0.50, description: 'Industry research PDF download' },
    ],
  },
  {
    merchantId: 'sim_cmp_001',
    endpoints: [
      { name: 'Image Render', path: '/x402/merchants/compute/render', method: 'POST', price: 0.05, description: '4K image render / upscale' },
      { name: 'Speech Transcribe', path: '/x402/merchants/compute/transcribe', method: 'POST', price: 0.03, description: 'Audio → text, per-minute billing' },
    ],
  },
];

function merchantUuid(merchantId: string): string {
  // Deterministic UUID from merchant_id so re-seeds are idempotent.
  // Uses a simple hash → UUID-v5-like formatting (not cryptographically real,
  // but sufficient for demo seed stability).
  const h = [...merchantId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0x811c9dc5);
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return `${hex(h)}-${hex(h >>> 4).slice(0, 4)}-4${hex(h >>> 8).slice(1, 4)}-a${hex(h >>> 12).slice(1, 4)}-${hex(h >>> 16)}${hex(h >>> 20).slice(0, 4)}`;
}

async function seedMerchants() {
  console.log(`\n=== Seeding ${MERCHANTS.length} UCP/ACP merchants in tenant ${TENANT_ID} ===`);
  for (const m of MERCHANTS) {
    const accountId = merchantUuid(m.merchant_id);
    const metadata = {
      pos_provider: m.pos_provider,
      invu_merchant_id: m.merchant_id,
      merchant_type: m.type,
      country: m.country,
      city: m.city,
      description: m.description,
      rating: m.rating,
      catalog: m.catalog,
    };

    const { error } = await sb.from('accounts').upsert(
      {
        id: accountId,
        tenant_id: TENANT_ID,
        type: 'business',
        subtype: 'merchant',
        name: m.name,
        currency: m.currency,
        metadata,
        environment: 'test',
      },
      { onConflict: 'id' },
    );
    if (error) {
      console.error(`  ✗ ${m.name}: ${error.message}`);
      continue;
    }

    // Ensure the merchant has an active USDC wallet so ACP/UCP settlement
    // has a destination. x402 merchants have always had wallets (receipt-
    // side requires it); ACP/UCP were previously wallet-less, so settlement
    // couldn't credit them.
    const { data: existingWallet } = await sb
      .from('wallets')
      .select('id')
      .eq('owner_account_id', accountId)
      .eq('currency', 'USDC')
      .eq('status', 'active')
      .maybeSingle();
    if (!existingWallet) {
      await sb.from('wallets').insert({
        tenant_id: TENANT_ID,
        owner_account_id: accountId,
        wallet_type: 'internal',
        balance: 0,
        currency: 'USDC',
        status: 'active',
      });
    }

    console.log(`  ✓ ${m.name} (${m.type}, ${m.catalog.length} products${existingWallet ? '' : ', wallet provisioned'})`);
  }
}

async function seedX402Endpoints() {
  console.log(`\n=== Seeding x402 merchant endpoints ===`);

  // Each x402 merchant is an account; endpoints FK to that account.
  for (const group of X402_MERCHANTS) {
    const accountId = merchantUuid(group.merchantId);
    const name = group.merchantId;

    // Upsert the parent merchant account.
    await sb.from('accounts').upsert(
      {
        id: accountId,
        tenant_id: TENANT_ID,
        type: 'business',
        subtype: 'merchant',
        name: `x402 merchant: ${name}`,
        currency: 'USDC',
        metadata: { pos_provider: 'sly-demo-x402', x402_merchant_id: name },
        environment: 'test',
      },
      { onConflict: 'id' },
    );

    // Ensure the merchant has a receiving USDC wallet. x402 /pay rejects with
    // PROVIDER_WALLET_NOT_FOUND if this is missing.
    const { data: existingWallet } = await sb
      .from('wallets')
      .select('id')
      .eq('owner_account_id', accountId)
      .eq('currency', 'USDC')
      .eq('status', 'active')
      .maybeSingle();
    if (!existingWallet) {
      await sb.from('wallets').insert({
        tenant_id: TENANT_ID,
        owner_account_id: accountId,
        wallet_type: 'internal',
        balance: 0,
        currency: 'USDC',
        status: 'active',
      });
    }

    for (const e of group.endpoints) {
      // Idempotency: delete existing rows matching (tenant, name, path), then insert.
      await sb.from('x402_endpoints').delete()
        .eq('tenant_id', TENANT_ID)
        .eq('name', e.name)
        .eq('path', e.path);

      const { error } = await sb.from('x402_endpoints').insert({
        tenant_id: TENANT_ID,
        account_id: accountId,
        name: e.name,
        path: e.path,
        method: e.method,
        description: e.description,
        base_price: e.price,
        currency: 'USDC',
        status: 'active',
        network: 'base-sepolia',
        environment: 'test',
      });
      if (error) {
        console.error(`  ✗ ${e.name}: ${error.message}`);
      } else {
        console.log(`  ✓ ${e.name} — ${e.method} ${e.path} @ $${e.price.toFixed(2)}`);
      }
    }
  }
}

(async () => {
  await seedMerchants();
  await seedX402Endpoints();

  // Verify
  const { count: mcount } = await sb.from('accounts')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .not('metadata->pos_provider', 'is', null);
  const { count: xcount } = await sb.from('x402_endpoints')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', TENANT_ID)
    .like('name', '%API%,%Article%,%Report%,%Render%,%Transcribe%');

  console.log(`\n=== Done ===`);
  console.log(`  merchants (pos_provider NOT NULL): ${mcount}`);
  console.log(`  x402 endpoints in sim tenant: see DB for full count`);
  process.exit(0);
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
