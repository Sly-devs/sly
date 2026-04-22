#!/usr/bin/env tsx
/**
 * Dual-spec OpenAPI generator.
 *
 * Each OpenAPIHono route declaration can include a tag of `public` or `internal`
 * on the `x-visibility` extension. This script walks the registered routes and
 * emits two spec files:
 *
 *   - docs-site/public/api-reference/openapi.json   (public routes only)
 *   - docs-site/internal/api-reference/openapi.json (all routes)
 *
 * Run manually:  pnpm --filter @sly/api generate:openapi
 * CI runs on any PR touching apps/api/src/routes/** (see .github/workflows/docs-spec.yml)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildOpenAPIApp } from '../src/app-openapi.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

const PUBLIC_SPEC = resolve(repoRoot, 'docs-site/public/api-reference/openapi.json');
const INTERNAL_SPEC = resolve(repoRoot, 'docs-site/internal/api-reference/openapi.json');

const baseInfo = {
  openapi: '3.1.0' as const,
  info: {
    title: 'Sly API',
    description:
      'The Agentic Economy Platform — stablecoin payments, agent wallets, multi-protocol commerce, and AI agent orchestration.',
    version: '1.0.0',
    contact: { name: 'Sly', url: 'https://getsly.ai', email: 'support@getsly.ai' },
  },
  servers: [
    { url: 'https://api.getsly.ai/v1', description: 'Production' },
    { url: 'https://sandbox.getsly.ai/v1', description: 'Sandbox' },
  ],
};

type Visibility = 'public' | 'internal';

interface FilteredSpec {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown>; securitySchemes: Record<string, unknown> };
}

function filterByVisibility(fullSpec: any, include: Visibility[]): FilteredSpec {
  const filteredPaths: Record<string, Record<string, unknown>> = {};

  for (const [pathKey, pathItem] of Object.entries(fullSpec.paths ?? {})) {
    const methods: Record<string, unknown> = {};
    for (const [method, op] of Object.entries(pathItem as Record<string, any>)) {
      if (typeof op !== 'object' || op === null) continue;
      const visibility: Visibility = (op['x-visibility'] as Visibility) ?? 'public';
      if (include.includes(visibility)) {
        methods[method] = op;
      }
    }
    if (Object.keys(methods).length > 0) filteredPaths[pathKey] = methods;
  }

  return {
    paths: filteredPaths,
    components: fullSpec.components ?? { schemas: {}, securitySchemes: {} },
  };
}

async function writeSpec(path: string, spec: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`✓ Wrote ${path}`);
}

async function main(): Promise<void> {
  const app = buildOpenAPIApp();
  const fullSpec = app.getOpenAPI31Document(baseInfo);

  // Public: only routes tagged x-visibility: public (or unset, default to public)
  const publicFiltered = filterByVisibility(fullSpec, ['public']);
  await writeSpec(PUBLIC_SPEC, {
    ...baseInfo,
    paths: publicFiltered.paths,
    components: publicFiltered.components,
    security: [{ bearerAuth: [] }],
  });

  // Internal: everything
  const internalFiltered = filterByVisibility(fullSpec, ['public', 'internal']);
  await writeSpec(INTERNAL_SPEC, {
    ...baseInfo,
    info: { ...baseInfo.info, title: 'Sly API (internal)' },
    paths: internalFiltered.paths,
    components: internalFiltered.components,
    security: [{ bearerAuth: [] }],
  });

  console.log('\nPublic paths:', Object.keys(publicFiltered.paths).length);
  console.log('Internal paths:', Object.keys(internalFiltered.paths).length);
}

main()
  .then(() => {
    // Force exit: imported modules (rate-limit middleware, caches) keep timers
    // alive in the event loop, which would otherwise hang the process after
    // main() resolves. The specs are already on disk; we're done.
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
