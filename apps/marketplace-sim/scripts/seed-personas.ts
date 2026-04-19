#!/usr/bin/env tsx
/**
 * Seed N persona agents per template into Sly and write tokens.json.
 *
 * CLI:
 *   pnpm seed-personas
 *   pnpm seed-personas --honest 5 --quality 2 --rogue 1
 *
 * Defaults: 3 honest, 2 quality, 1 rogue.
 *
 * Each instance becomes a real Sly agent (`sim-<NamePrefix>-<i>`) with its
 * own bearer token, parent account, and funded $200 USDC wallet. The seed
 * uses each template's `defaultKyaTier` so verified agents can transact and
 * the rogue intentionally hits the platform's KYA gate.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { seedPersonas, type SeedCounts } from '../src/seeder.js';

function parseArgs(argv: string[]): SeedCounts {
  const counts: SeedCounts = { honest: 3, quality: 2, rogue: 1 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--honest' && argv[i + 1]) counts.honest = parseInt(argv[++i], 10);
    else if (arg === '--quality' && argv[i + 1]) counts.quality = parseInt(argv[++i], 10);
    else if (arg === '--rogue' && argv[i + 1]) counts.rogue = parseInt(argv[++i], 10);
  }
  for (const [k, v] of Object.entries(counts)) {
    if (Number.isNaN(v) || v < 0) throw new Error(`Invalid count for --${k}: ${v}`);
  }
  return counts;
}

async function main() {
  const baseUrl = process.env.SLY_API_URL;
  const adminKey = process.env.SLY_PLATFORM_ADMIN_KEY;
  if (!baseUrl || !adminKey) {
    console.error('Missing SLY_API_URL or SLY_PLATFORM_ADMIN_KEY in env. Check apps/marketplace-sim/.env');
    process.exit(1);
  }

  const counts = parseArgs(process.argv.slice(2));
  console.log(`\nSeed plan: ${counts.honest} honest + ${counts.quality} quality + ${counts.rogue} rogue\n`);

  const result = await seedPersonas(counts, {
    baseUrl,
    adminKey,
    log: (msg: string) => console.log(msg),
  });

  if (result.errors.length > 0) {
    console.error(`\n${result.errors.length} error(s):`);
    for (const e of result.errors) console.error(`  ${e}`);
  }
  console.log(`\nTotal seeded: ${result.total}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
