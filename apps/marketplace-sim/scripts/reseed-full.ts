#!/usr/bin/env tsx
/**
 * One-shot: refresh tokens for the full persona pool the scenarios use.
 * Not part of the persistent CLI surface — safe to delete after the run.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { seedPersonas } from '../src/seeder.js';

const counts = {
  honest: 3,
  quality: 2,
  rogue: 1,
  whale: 1,
  newcomer: 2,
  budget: 3,
  opportunist: 2,
  mm: 2,
  researcher: 1,
};

(async () => {
  const r = await seedPersonas(counts, {
    baseUrl: process.env.SLY_API_URL!,
    adminKey: process.env.SLY_PLATFORM_ADMIN_KEY!,
    log: (m: string) => console.log(m),
  });
  if (r.errors.length) {
    console.error('\nErrors:');
    for (const e of r.errors) console.error('  ' + e);
  }
  console.log(`\nTotal: ${r.total}`);
})();
