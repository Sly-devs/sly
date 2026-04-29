#!/usr/bin/env node
/**
 * Produce a Vercel Build Output API bundle at .vercel/output/.
 *
 * Why: Vercel's default function bundler runs `npm install` on apps/scanner/
 * after our install step; npm doesn't understand pnpm's `workspace:*`. By
 * producing the Build Output ourselves (with workspace deps inlined via tsup's
 * --noExternal), Vercel skips all auto-detection and just serves what we built.
 *
 * Docs: https://vercel.com/docs/build-output-api/v3
 */
import { execSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scannerDir = resolve(__dirname, '..');
const repoRoot = resolve(scannerDir, '../..');
const outputDir = resolve(scannerDir, '.vercel/output');
const fnDir = resolve(outputDir, 'functions/index.func');
const reportsSourceDir = resolve(repoRoot, 'scanner-reports');
// Reports ride along inside the function bundle. With `experimentalServices`
// in vercel.json, the `/` prefix routes entirely to the function — Vercel's
// static layer is bypassed, so app.ts serves these directly off disk.
const reportsOutDir = resolve(fnDir, 'reports');

if (existsSync(outputDir)) {
  rmSync(outputDir, { recursive: true, force: true });
}
mkdirSync(fnDir, { recursive: true });

console.log('[build-vercel] Bundling api/index.ts with workspace deps inlined...');
execSync(
  `pnpm exec tsup --config tsup.vercel.config.ts --out-dir "${fnDir}"`,
  { stdio: 'inherit', cwd: scannerDir },
);

// Vercel Functions v3 expects each function directory to contain the entry
// plus a .vc-config.json describing the runtime.
writeFileSync(
  resolve(fnDir, '.vc-config.json'),
  JSON.stringify(
    {
      runtime: 'nodejs20.x',
      handler: 'index.js',
      launcherType: 'Nodejs',
      // MUST be false — Hono's getRequestListener reads the raw Node request
      // stream itself. With helpers on, Vercel pre-consumes the body into
      // req.body, and Hono's c.req.json() then hangs forever waiting on a
      // drained stream. Affects ALL POST/PUT/PATCH requests.
      shouldAddHelpers: false,
    },
    null,
    2,
  ),
);

// tsup emits index.cjs for CJS format; rename to index.js to match the
// .vc-config.json "handler" entry point.
const producedCjs = resolve(fnDir, 'index.cjs');
const targetJs = resolve(fnDir, 'index.js');
if (existsSync(producedCjs)) {
  execSync(`mv "${producedCjs}" "${targetJs}"`);
}
if (!existsSync(targetJs)) {
  throw new Error(`Expected bundled function at ${targetJs}`);
}

// CJS — matches the tsup bundle format.
writeFileSync(
  resolve(fnDir, 'package.json'),
  JSON.stringify({ type: 'commonjs' }, null, 2),
);

// Copy pre-generated scanner reports (HTML/MD/CSV/PDF) into the function dir.
// app.ts serves them off disk at GET / and /reports/*.
if (existsSync(reportsSourceDir)) {
  mkdirSync(reportsOutDir, { recursive: true });
  const reportFiles = readdirSync(reportsSourceDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return ['.html', '.md', '.csv', '.pdf', '.png', '.jpg', '.jpeg'].includes(ext);
  });
  for (const file of reportFiles) {
    copyFileSync(resolve(reportsSourceDir, file), resolve(reportsOutDir, file));
  }
  console.log(`[build-vercel] Copied ${reportFiles.length} report files into function bundle`);
}

// `experimentalServices` in vercel.json supersedes the routes array — we keep
// only the cron block, which is still honored.
writeFileSync(
  resolve(outputDir, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      crons: [
        // 1st of each month at 00:00 UTC — create next 3 months of usage
        // event partitions so writes don't start failing.
        { path: '/v1/admin/ensure-partitions', schedule: '0 0 1 * *' },
      ],
    },
    null,
    2,
  ),
);

console.log('[build-vercel] .vercel/output ready');
