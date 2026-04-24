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
  readFileSync,
} from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scannerDir = resolve(__dirname, '..');
const repoRoot = resolve(scannerDir, '../..');
const outputDir = resolve(scannerDir, '.vercel/output');
const fnDir = resolve(outputDir, 'functions/index.func');
const staticDir = resolve(outputDir, 'static');
const reportsSourceDir = resolve(repoRoot, 'scanner-reports');
const reportsOutDir = resolve(staticDir, 'reports');
const ROOT_REPORT = 'baseline-q1-2026-report.html';

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

// Copy the pre-generated scanner reports (HTML/MD/CSV/PDF) to static/reports/.
// These showcase what the scanner produces; served publicly.
if (existsSync(reportsSourceDir)) {
  mkdirSync(reportsOutDir, { recursive: true });
  const reportFiles = readdirSync(reportsSourceDir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return ['.html', '.md', '.csv', '.pdf', '.png', '.jpg', '.jpeg'].includes(ext);
  });
  for (const file of reportFiles) {
    copyFileSync(resolve(reportsSourceDir, file), resolve(reportsOutDir, file));
  }
  console.log(`[build-vercel] Copied ${reportFiles.length} report files to static/reports/`);

  // Serve the Q1 baseline at the root URL as a landing page.
  const landing = resolve(reportsSourceDir, ROOT_REPORT);
  if (existsSync(landing)) {
    copyFileSync(landing, resolve(staticDir, 'index.html'));
  }
}

// Root config.json: static files take precedence; API catches the rest.
// /reports/* is served from static/reports/; / serves static/index.html.
writeFileSync(
  resolve(outputDir, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '/', dest: '/index.html' },
        { src: '/reports', dest: '/reports/index.html' },
        { src: '/reports/', dest: '/reports/index.html' },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index' },
      ],
    },
    null,
    2,
  ),
);

// Also emit a tiny /reports/ directory index so people browsing the reports
// path don't get a raw 404.
if (existsSync(reportsOutDir)) {
  const files = readdirSync(reportsOutDir).filter((f) => f.endsWith('.html'));
  const items = files
    .map((f) => `    <li><a href="/reports/${f}">${f}</a></li>`)
    .join('\n');
  writeFileSync(
    resolve(reportsOutDir, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Sly Scanner Reports</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:720px;margin:48px auto;padding:0 24px;line-height:1.6;color:#1e1b4b}
h1{color:#7c3aed}
ul{padding-left:20px}
a{color:#7c3aed;text-decoration:none}
a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>Sly Scanner Reports</h1>
<p>Generated reports from <a href="https://docs.getsly.ai/scanner">Sly Scanner</a>.</p>
<ul>
${items}
</ul>
</body>
</html>`,
  );
}

console.log('[build-vercel] .vercel/output ready');
