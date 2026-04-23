#!/usr/bin/env tsx
/**
 * Grant scanner credits to a partner tenant (typically after invoice payment).
 *
 * Usage:
 *   pnpm --filter @sly/scanner tsx scripts/grant-credits.ts \
 *     --tenant <uuid> \
 *     --amount 50000 \
 *     --source stripe_invoice_in_1ABC \
 *     --note "May 2026 renewal"
 */
import 'dotenv/config';
import { createClient } from '../src/db/client.js';
import { grant, getBalanceSummary } from '../src/billing/ledger.js';

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (flag: string, def?: string): string => {
    const i = argv.indexOf(flag);
    if (i < 0) {
      if (def !== undefined) return def;
      throw new Error(`Missing required flag: ${flag}`);
    }
    return argv[i + 1];
  };
  return {
    tenant: get('--tenant'),
    amount: parseInt(get('--amount'), 10),
    source: get('--source'),
    note: get('--note', ''),
  };
}

async function main() {
  const args = parseArgs();
  if (!Number.isFinite(args.amount) || args.amount <= 0) {
    throw new Error('--amount must be a positive integer');
  }

  const supabase = createClient();
  const { data: tenant } = await (supabase.from('tenants') as any)
    .select('id, name')
    .eq('id', args.tenant)
    .single();
  if (!tenant) throw new Error(`Tenant ${args.tenant} not found`);

  const before = await getBalanceSummary(args.tenant);
  const newBalance = await grant(args.tenant, args.amount, args.source, {
    note: args.note || undefined,
  });

  console.log('='.repeat(60));
  console.log('Scanner credits granted.');
  console.log('='.repeat(60));
  console.log(`Tenant:        ${tenant.name} (${args.tenant})`);
  console.log(`Source:        ${args.source}`);
  console.log(`Amount:        +${args.amount}`);
  console.log(`Balance:       ${before.balance} → ${newBalance}`);
  if (args.note) console.log(`Note:          ${args.note}`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
