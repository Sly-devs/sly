#!/usr/bin/env tsx
/**
 * Issue a new scanner API key for a partner tenant.
 *
 * Usage:
 *   pnpm --filter @sly/scanner tsx scripts/issue-partner-key.ts \
 *     --tenant <uuid> \
 *     --name "Acme Corp - Live" \
 *     --env live \
 *     --credits 10000 \
 *     --scopes scan,batch,read,mcp,tests \
 *     --rate-limit 120
 */
import 'dotenv/config';
import { createClient } from '../src/db/client.js';
import {
  generateScannerKey,
  hashScannerKey,
  getScannerKeyPrefix,
} from '../src/utils/crypto.js';
import { grant } from '../src/billing/ledger.js';

interface Args {
  tenant: string;
  name: string;
  env: 'test' | 'live';
  credits: number;
  scopes: string[];
  rateLimit: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0) {
      if (def !== undefined) return def;
      throw new Error(`Missing required flag: ${flag}`);
    }
    return argv[i + 1];
  };

  const env = get('--env', 'test');
  if (env !== 'test' && env !== 'live') {
    throw new Error('--env must be "test" or "live"');
  }

  return {
    tenant: get('--tenant'),
    name: get('--name', 'Scanner Partner Key'),
    env: env as 'test' | 'live',
    credits: parseInt(get('--credits', '0'), 10),
    scopes: get('--scopes', 'scan,batch,read').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimit: parseInt(get('--rate-limit', '60'), 10),
  };
}

async function main() {
  const args = parseArgs();
  const supabase = createClient();

  const { data: tenant, error: tenantErr } = await (supabase.from('tenants') as any)
    .select('id, name, status')
    .eq('id', args.tenant)
    .single();
  if (tenantErr || !tenant) {
    throw new Error(`Tenant ${args.tenant} not found: ${tenantErr?.message ?? 'no rows'}`);
  }

  const key = generateScannerKey(args.env);
  const keyHash = hashScannerKey(key);
  const keyPrefix = getScannerKeyPrefix(key);

  const { data: row, error: insertErr } = await (supabase.from('scanner_api_keys') as any)
    .insert({
      tenant_id: args.tenant,
      name: args.name,
      key_prefix: keyPrefix,
      key_hash: keyHash,
      environment: args.env,
      scopes: args.scopes,
      rate_limit_per_min: args.rateLimit,
    })
    .select('id')
    .single();

  if (insertErr) {
    throw new Error(`Failed to insert key: ${insertErr.message}`);
  }

  let newBalance: number | null = null;
  if (args.credits > 0) {
    newBalance = await grant(args.tenant, args.credits, 'free_tier', {
      key_id: row.id,
      note: 'initial grant at key issuance',
    });
  }

  console.log('='.repeat(60));
  console.log('Scanner API key issued.');
  console.log('='.repeat(60));
  console.log(`Tenant:       ${tenant.name} (${args.tenant})`);
  console.log(`Key ID:       ${row.id}`);
  console.log(`Name:         ${args.name}`);
  console.log(`Environment:  ${args.env}`);
  console.log(`Scopes:       ${args.scopes.join(', ')}`);
  console.log(`Rate limit:   ${args.rateLimit} req/min`);
  if (newBalance !== null) {
    console.log(`Credits:      ${args.credits} granted (balance now ${newBalance})`);
  }
  console.log('='.repeat(60));
  console.log('API key (shown once — save it now):');
  console.log();
  console.log(`  ${key}`);
  console.log();
  console.log('Usage:');
  console.log(`  curl -H "Authorization: Bearer ${key}" \\`);
  console.log('    https://scanner.getsly.ai/v1/scanner/credits/balance');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
