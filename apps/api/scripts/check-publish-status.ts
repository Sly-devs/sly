// Diagnostic: is a Sly-published x402 resource indexed in CDP's catalog?
//
// Sweeps `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`
// (the canonical source of truth) for a given gateway URL. Also checks the
// derived `https://api.agentic.market/v1/services/{domain-slug}` mirror.
//
// Use this instead of curling manually. Two modes:
//
//   pnpm --filter @sly/api check:publish-status <gatewayUrl>
//   pnpm --filter @sly/api check:publish-status --domain <host>
//
// Exits non-zero if not indexed (handy for CI / scripts).

const CDP_DISCOVERY_URL =
  'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources';
const AGENTIC_MARKET_URL = 'https://api.agentic.market/v1/services';
const PAGE_LIMIT = 500;

interface CdpResource {
  resource: string;
  lastUpdated?: string;
  quality?: {
    l30DaysTotalCalls?: number;
    l30DaysUniquePayers?: number;
    lastCalledAt?: string;
  };
}

async function findCdpResource(targetUrl: string): Promise<CdpResource | null> {
  const target = targetUrl.toLowerCase();
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const res = await fetch(`${CDP_DISCOVERY_URL}?limit=${PAGE_LIMIT}&offset=${offset}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      console.error(`CDP discovery returned ${res.status}`);
      return null;
    }
    const body: any = await res.json();
    total = body?.pagination?.total ?? body?.items?.length ?? 0;
    const items: CdpResource[] = body?.items ?? [];
    const hit = items.find((it) => it.resource?.toLowerCase() === target);
    if (hit) return hit;
    if (items.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }
  return null;
}

async function checkAgenticMarket(host: string): Promise<{
  found: boolean;
  endpointUrls: string[];
  enriched?: boolean;
}> {
  const slug = host.replace(/\./g, '-');
  const res = await fetch(`${AGENTIC_MARKET_URL}/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return { found: false, endpointUrls: [] };
  if (!res.ok) {
    console.error(`agentic.market returned ${res.status}`);
    return { found: false, endpointUrls: [] };
  }
  const body: any = await res.json();
  const endpoints = Array.isArray(body?.endpoints) ? body.endpoints : [];
  return {
    found: true,
    endpointUrls: endpoints
      .map((e: any) => e?.url)
      .filter((u: unknown): u is string => typeof u === 'string'),
    enriched: body?.enriched,
  };
}

function parseArgs(argv: string[]): { gatewayUrl: string; host: string } {
  const args = argv.slice(2);
  if (args[0] === '--domain' && args[1]) {
    return { gatewayUrl: '', host: args[1] };
  }
  if (args[0] && args[0].startsWith('http')) {
    const url = new URL(args[0]);
    return { gatewayUrl: args[0], host: url.host };
  }
  console.error('Usage:');
  console.error('  pnpm --filter @sly/api check:publish-status <https://gateway/url>');
  console.error('  pnpm --filter @sly/api check:publish-status --domain <host>');
  process.exit(2);
}

async function main() {
  const { gatewayUrl, host } = parseArgs(process.argv);

  console.log('═══ CDP discovery (canonical source) ═══');
  if (gatewayUrl) {
    console.log(`  searching for: ${gatewayUrl}`);
    const hit = await findCdpResource(gatewayUrl);
    if (hit) {
      console.log(`  ✅ INDEXED`);
      console.log(`     lastUpdated: ${hit.lastUpdated || '(unknown)'}`);
      if (hit.quality) {
        console.log(`     30d calls:   ${hit.quality.l30DaysTotalCalls ?? 0}`);
        console.log(`     unique payers: ${hit.quality.l30DaysUniquePayers ?? 0}`);
        console.log(`     last called: ${hit.quality.lastCalledAt ?? '(never)'}`);
      }
    } else {
      console.log(`  ❌ NOT INDEXED in CDP catalog`);
    }
  } else {
    console.log(`  (skipped — only --domain provided)`);
  }

  console.log('');
  console.log(`═══ agentic.market service entry (${host}) ═══`);
  const am = await checkAgenticMarket(host);
  if (!am.found) {
    console.log(`  ❌ no service entry for ${host.replace(/\./g, '-')}`);
  } else {
    console.log(`  ✅ service entry exists (enriched=${am.enriched ?? 'unknown'})`);
    console.log(`  endpoints (${am.endpointUrls.length}):`);
    for (const u of am.endpointUrls) {
      const marker = gatewayUrl && u.toLowerCase() === gatewayUrl.toLowerCase() ? '◀' : ' ';
      console.log(`    ${marker} ${u}`);
    }
    if (gatewayUrl) {
      const matched = am.endpointUrls.some(
        (u) => u.toLowerCase() === gatewayUrl.toLowerCase(),
      );
      if (!matched) {
        console.log(`  ⚠ ${gatewayUrl} is NOT in this service's endpoints[]`);
      }
    }
  }

  console.log('');
  if (gatewayUrl) {
    const cdpHit = await findCdpResource(gatewayUrl);
    const amHit = am.endpointUrls.some(
      (u) => u.toLowerCase() === gatewayUrl.toLowerCase(),
    );
    if (cdpHit && amHit) {
      console.log('Final: fully indexed (CDP canonical + agentic.market mirror)');
      process.exit(0);
    }
    if (cdpHit || amHit) {
      console.log('Final: partially indexed — one source has the URL, the other doesn\'t');
      process.exit(1);
    }
    console.log('Final: not indexed yet');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
