
import * as cheerio from 'cheerio';
import type {
  AgentObservation,
  AgentActivityReport,
  MerchantAIPresence,
  ObservationType,
  ObservationSource,
} from '@sly/types';
import * as queries from '../db/queries.js';

// ============================================
// CONSTANTS
// ============================================

const USER_AGENT = 'SlyObservatory/1.0 (+https://sly.dev/scanner)';
const REQUEST_TIMEOUT_MS = 8000;
const PERPLEXITY_TIMEOUT_MS = 15000;
// Observatory aggregates the shared corpus — no tenant filter on reads.
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

// Known MCP registries and agent directories to crawl
const MCP_REGISTRIES = [
  'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md',
  'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md',
];

// Known AI shopping agent domains
const AI_SHOPPING_AGENTS = [
  { name: 'ChatGPT Operator', domain: 'operator.chatgpt.com', source: 'chatgpt' as ObservationSource },
  { name: 'Perplexity Shopping', domain: 'perplexity.ai', source: 'perplexity' as ObservationSource },
  { name: 'Google AI Mode', domain: 'google.com', source: 'google_ai' as ObservationSource },
  { name: 'Bing Copilot', domain: 'copilot.microsoft.com', source: 'bing_copilot' as ObservationSource },
];

// Commercial queries to check AI search visibility
const COMMERCIAL_QUERIES = [
  { query: 'best running shoes', category: 'retail' },
  { query: 'buy laptop online', category: 'retail' },
  { query: 'cheapest flight to mexico', category: 'travel' },
  { query: 'project management software pricing', category: 'saas' },
  { query: 'order food delivery', category: 'restaurant' },
  { query: 'buy bitcoin', category: 'fintech' },
  { query: 'cloud hosting pricing', category: 'saas' },
  { query: 'organic coffee beans', category: 'retail' },
];

// ============================================
// HELPERS
// ============================================

async function safeFetch(url: string): Promise<{ ok: boolean; text: string; status: number }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json,text/plain,text/markdown' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    const text = await res.text();
    return { ok: res.ok, text, status: res.status };
  } catch {
    return { ok: false, text: '', status: 0 };
  }
}

// ============================================
// OBSERVATION METHOD 1: MCP Registry Crawl
// ============================================

export async function crawlMCPRegistries(): Promise<Array<{
  domain: string;
  evidence: string;
  evidence_url: string;
}>> {
  const results: Array<{ domain: string; evidence: string; evidence_url: string }> = [];

  for (const registryUrl of MCP_REGISTRIES) {
    const res = await safeFetch(registryUrl);
    if (!res.ok) continue;

    // Look for commerce/shopping/payment related MCP servers
    const commercePatterns = /(?:commerce|shopping|checkout|payment|shop|store|buy|cart|order|merchant|retail|ecommerce)/gi;
    const lines = res.text.split('\n');

    for (const line of lines) {
      if (!commercePatterns.test(line)) continue;

      // Extract URLs from markdown links [text](url)
      const urlMatches = line.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const match of urlMatches) {
        const linkText = match[1];
        const linkUrl = match[2];
        try {
          const url = new URL(linkUrl);
          const domain = url.hostname.replace(/^www\./, '');
          if (domain && !domain.includes('github.com') && !domain.includes('npmjs.com')) {
            results.push({
              domain,
              evidence: `MCP server listed in registry: "${linkText}"`,
              evidence_url: registryUrl,
            });
          }
        } catch { /* not a valid URL */ }
      }

      // Also extract raw domains from the line
      const domainMatches = line.matchAll(/(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:\.[a-zA-Z]{2,})?)/g);
      for (const match of domainMatches) {
        const domain = match[1].toLowerCase();
        if (domain && !domain.includes('github') && !domain.includes('npm')
          && !results.some(r => r.domain === domain)) {
          results.push({
            domain,
            evidence: `Referenced in MCP registry in commerce context: "${line.substring(0, 120)}"`,
            evidence_url: registryUrl,
          });
        }
      }
    }
  }

  return results;
}

// ============================================
// OBSERVATION METHOD 2: Protocol Drift Detection
// ============================================

export async function detectProtocolDrift(): Promise<Array<{
  domain: string;
  evidence: string;
  merchant_scan_id: string;
}>> {
  const results: Array<{ domain: string; evidence: string; merchant_scan_id: string }> = [];

  // Get all completed scans (shared corpus)
  const { data: scans } = await queries.listMerchantScans({
    status: 'completed',
    limit: 100,
  });

  for (const scan of scans) {
    const protocols = await queries.getProtocolResults(scan.id);
    const detected = protocols.filter(p => p.detected);

    if (detected.length > 0) {
      const protocolNames = detected.map(p => p.protocol).join(', ');
      results.push({
        domain: scan.domain,
        evidence: `Protocols detected in scan: ${protocolNames}`,
        merchant_scan_id: scan.id,
      });
    }
  }

  return results;
}

// ============================================
// OBSERVATION METHOD 3: Robots.txt Agent Analysis
// ============================================

export async function analyzeAgentFriendliness(domains: string[]): Promise<Array<{
  domain: string;
  evidence: string;
  allows_agents: boolean;
}>> {
  const results: Array<{ domain: string; evidence: string; allows_agents: boolean }> = [];

  for (const domain of domains.slice(0, 20)) {
    const res = await safeFetch(`https://${domain}/robots.txt`);
    if (!res.ok) continue;

    const text = res.text.toLowerCase();
    const blocksGPTBot = /user-agent:\s*gptbot[\s\S]*?disallow:\s*\//i.test(res.text);
    const blocksClaudeBot = /user-agent:\s*claudebot[\s\S]*?disallow:\s*\//i.test(res.text);
    const blocksAll = /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(res.text);
    const mentionsAgents = /agent|bot|crawler|spider/i.test(text);

    if (blocksGPTBot || blocksClaudeBot) {
      results.push({
        domain,
        evidence: `Blocks AI agents in robots.txt: ${[blocksGPTBot && 'GPTBot', blocksClaudeBot && 'ClaudeBot'].filter(Boolean).join(', ')}`,
        allows_agents: false,
      });
    } else if (blocksAll) {
      results.push({
        domain,
        evidence: 'Blocks all bots via robots.txt (Disallow: /)',
        allows_agents: false,
      });
    } else if (mentionsAgents) {
      results.push({
        domain,
        evidence: 'Robots.txt references agent/bot user-agents but does not block them',
        allows_agents: true,
      });
    }
  }

  return results;
}

// ============================================
// OBSERVATION METHOD 4: AI Search Presence Check
// ============================================

export async function checkAISearchPresence(domain: string): Promise<Array<{
  agent: string;
  source: ObservationSource;
  evidence: string;
  evidence_url?: string;
}>> {
  const results: Array<{
    agent: string;
    source: ObservationSource;
    evidence: string;
    evidence_url?: string;
  }> = [];

  // Check if the merchant is referenced in Perplexity via their API-like endpoint
  // Perplexity surfaces merchant results — check if the domain appears
  const perplexityRes = await safeFetch(`https://www.perplexity.ai/search?q=buy+from+${encodeURIComponent(domain)}`);
  if (perplexityRes.ok && perplexityRes.text.includes(domain)) {
    results.push({
      agent: 'Perplexity',
      source: 'perplexity',
      evidence: `Domain "${domain}" appears in Perplexity search results for commercial query`,
      evidence_url: `https://www.perplexity.ai/search?q=buy+from+${encodeURIComponent(domain)}`,
    });
  }

  // Check Google Shopping / AI overview presence via cached structured data
  const googleRes = await safeFetch(`https://www.google.com/search?q=buy+from+${encodeURIComponent(domain)}&udm=28`);
  if (googleRes.ok && googleRes.text.includes(domain)) {
    results.push({
      agent: 'Google AI',
      source: 'google_ai',
      evidence: `Domain "${domain}" appears in Google search results for commercial query`,
    });
  }

  return results;
}

// ============================================
// OBSERVATION METHOD 5: Perplexity API Search
// ============================================

interface PerplexitySearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface PerplexityResponse {
  choices: Array<{ message: { content: string } }>;
  citations?: string[];
  search_results?: PerplexitySearchResult[];
}

/**
 * Query Perplexity's Sonar API with commercial queries and extract
 * which merchant domains appear in the results + citations.
 */
export async function queryPerplexityForMerchants(
  commerceQueries?: Array<{ query: string; category: string }>,
): Promise<Array<{
  domain: string;
  query: string;
  category: string;
  evidence: string;
  evidence_url?: string;
  confidence: 'high' | 'medium' | 'low';
}>> {
  if (!PERPLEXITY_API_KEY) {
    console.warn('[Observatory] PERPLEXITY_API_KEY not set — skipping Perplexity search');
    return [];
  }

  const queriesToRun = commerceQueries || COMMERCIAL_QUERIES;
  const results: Array<{
    domain: string;
    query: string;
    category: string;
    evidence: string;
    evidence_url?: string;
    confidence: 'high' | 'medium' | 'low';
  }> = [];

  // Dedupe domains across queries
  const seenDomains = new Set<string>();

  for (const q of queriesToRun) {
    try {
      const res = await fetch(PERPLEXITY_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            {
              role: 'system',
              content: 'You are a shopping assistant. List the top merchant websites where someone can buy the requested product or service. For each, mention the domain name.',
            },
            {
              role: 'user',
              content: q.query,
            },
          ],
          web_search_options: {
            search_context_size: 'medium',
          },
        }),
        signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`[Observatory] Perplexity API error for "${q.query}": ${res.status} ${res.statusText}`);
        continue;
      }

      const data = await res.json() as PerplexityResponse;
      const responseText = data.choices?.[0]?.message?.content || '';

      // Extract domains from citations
      if (data.citations && data.citations.length > 0) {
        for (const citationUrl of data.citations) {
          try {
            const url = new URL(citationUrl);
            const domain = url.hostname.replace(/^www\./, '');
            if (domain && !isNonMerchantDomain(domain) && !seenDomains.has(domain)) {
              seenDomains.add(domain);
              results.push({
                domain,
                query: q.query,
                category: q.category,
                evidence: `Perplexity cited ${domain} in response to "${q.query}"`,
                evidence_url: citationUrl,
                confidence: 'high',
              });
            }
          } catch { /* invalid URL */ }
        }
      }

      // Extract domains from search_results
      if (data.search_results && data.search_results.length > 0) {
        for (const sr of data.search_results) {
          try {
            const url = new URL(sr.url);
            const domain = url.hostname.replace(/^www\./, '');
            if (domain && !isNonMerchantDomain(domain) && !seenDomains.has(domain)) {
              seenDomains.add(domain);
              results.push({
                domain,
                query: q.query,
                category: q.category,
                evidence: `Perplexity search result for "${q.query}": "${sr.title}"`,
                evidence_url: sr.url,
                confidence: 'medium',
              });
            }
          } catch { /* invalid URL */ }
        }
      }

      // Extract domains mentioned in the response text itself
      const domainPattern = /(?:https?:\/\/)?([a-zA-Z0-9][-a-zA-Z0-9]*(?:\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\.(?:com|net|org|io|co|shop|store|ai|dev|app|xyz|me|us|uk|de|fr|br|mx|ar|cl|pe))/g;
      for (const match of responseText.matchAll(domainPattern)) {
        const domain = match[1].toLowerCase();
        if (!isNonMerchantDomain(domain) && !seenDomains.has(domain)) {
          seenDomains.add(domain);
          results.push({
            domain,
            query: q.query,
            category: q.category,
            evidence: `Perplexity mentioned ${domain} in response to "${q.query}"`,
            confidence: 'low',
          });
        }
      }

      // Rate limit: 1 req/sec to stay well within 50 req/min
      await new Promise(resolve => setTimeout(resolve, 1200));
    } catch (err) {
      console.warn(`[Observatory] Perplexity query failed for "${q.query}":`, err instanceof Error ? err.message : err);
    }
  }

  return results;
}

/** Filter out non-merchant domains (search engines, social, infrastructure) */
function isNonMerchantDomain(domain: string): boolean {
  const excluded = [
    'google.com', 'google.co', 'bing.com', 'yahoo.com', 'duckduckgo.com',
    'perplexity.ai', 'openai.com', 'anthropic.com', 'chatgpt.com',
    'wikipedia.org', 'reddit.com', 'twitter.com', 'x.com',
    'facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com',
    'github.com', 'npmjs.com', 'stackoverflow.com',
    'medium.com', 'substack.com', 'wordpress.com', 'blogger.com',
    'cloudflare.com', 'amazonaws.com', 'vercel.app', 'netlify.app',
  ];
  return excluded.some(e => domain === e || domain.endsWith('.' + e));
}

// ============================================
// COLLECT ALL OBSERVATIONS
// ============================================

export async function collectObservations(options: {
  crawl_registries?: boolean;
  detect_drift?: boolean;
  check_domains?: string[];
  query_perplexity?: boolean;
  perplexity_queries?: Array<{ query: string; category: string }>;
} = {}): Promise<{
  observations: Array<{
    domain: string;
    observation_type: ObservationType;
    source: ObservationSource;
    evidence: string;
    evidence_url?: string;
    merchant_scan_id?: string;
    query?: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
  stats: { registries: number; drift: number; agent_checks: number; perplexity: number };
}> {
  const observations: Array<{
    domain: string;
    observation_type: ObservationType;
    source: ObservationSource;
    evidence: string;
    evidence_url?: string;
    merchant_scan_id?: string;
    query?: string;
    confidence: 'high' | 'medium' | 'low';
  }> = [];
  const stats = { registries: 0, drift: 0, agent_checks: 0, perplexity: 0 };

  // 1. MCP Registry Crawl
  if (options.crawl_registries !== false) {
    try {
      const registryResults = await crawlMCPRegistries();
      for (const r of registryResults) {
        observations.push({
          domain: r.domain,
          observation_type: 'agent_marketplace',
          source: 'mcp_registry',
          evidence: r.evidence,
          evidence_url: r.evidence_url,
          confidence: 'medium',
        });
      }
      stats.registries = registryResults.length;
    } catch (err) {
      console.warn('[Observatory] MCP registry crawl failed:', err instanceof Error ? err.message : err);
    }
  }

  // 2. Protocol Drift Detection
  if (options.detect_drift !== false) {
    try {
      const driftResults = await detectProtocolDrift();
      for (const r of driftResults) {
        observations.push({
          domain: r.domain,
          observation_type: 'protocol_announcement',
          source: 'scan_drift',
          evidence: r.evidence,
          merchant_scan_id: r.merchant_scan_id,
          confidence: 'high',
        });
      }
      stats.drift = driftResults.length;
    } catch (err) {
      console.warn('[Observatory] Protocol drift detection failed:', err instanceof Error ? err.message : err);
    }
  }

  // 3. AI Search Presence (for specific domains)
  if (options.check_domains && options.check_domains.length > 0) {
    for (const domain of options.check_domains.slice(0, 10)) {
      try {
        const presenceResults = await checkAISearchPresence(domain);
        for (const r of presenceResults) {
          observations.push({
            domain,
            observation_type: 'ai_search_result',
            source: r.source,
            evidence: r.evidence,
            evidence_url: r.evidence_url,
            confidence: 'medium',
          });
        }
        stats.agent_checks++;
      } catch (err) {
        console.warn(`[Observatory] AI search check failed for ${domain}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // 4. Perplexity API Search
  if (options.query_perplexity) {
    try {
      const perplexityResults = await queryPerplexityForMerchants(options.perplexity_queries);
      for (const r of perplexityResults) {
        observations.push({
          domain: r.domain,
          observation_type: 'ai_search_result',
          source: 'perplexity',
          evidence: r.evidence,
          evidence_url: r.evidence_url,
          query: r.query,
          confidence: r.confidence,
        });
      }
      stats.perplexity = perplexityResults.length;
    } catch (err) {
      console.warn('[Observatory] Perplexity search failed:', err instanceof Error ? err.message : err);
    }
  }

  return { observations, stats };
}

// ============================================
// PERSIST OBSERVATIONS
// ============================================

export async function runObservatorySweep(options: {
  crawl_registries?: boolean;
  detect_drift?: boolean;
  check_domains?: string[];
  query_perplexity?: boolean;
  perplexity_queries?: Array<{ query: string; category: string }>;
} = {}): Promise<{
  inserted: number;
  stats: { registries: number; drift: number; agent_checks: number; perplexity: number };
}> {
  const { observations, stats } = await collectObservations(options);

  if (observations.length > 0) {
    await queries.insertAgentObservationsBatch(
      observations.map(o => ({
        domain: o.domain,
        merchant_scan_id: o.merchant_scan_id,
        observation_type: o.observation_type,
        source: o.source,
        query: o.query,
        evidence: o.evidence,
        evidence_url: o.evidence_url,
        confidence: o.confidence,
      })),
    );
  }

  return { inserted: observations.length, stats };
}

// ============================================
// RECORD MANUAL OBSERVATION
// ============================================

export async function recordObservation(data: {
  domain: string;
  observation_type: ObservationType;
  source: ObservationSource;
  query?: string;
  evidence: string;
  evidence_url?: string;
  metadata?: Record<string, unknown>;
  confidence?: 'high' | 'medium' | 'low';
}): Promise<{ id: string }> {
  // Try to link to existing scan (shared corpus — freshest scan of the domain)
  let merchantScanId: string | undefined;
  try {
    const scan = await queries.getMerchantScanByDomain(data.domain);
    if (scan) merchantScanId = scan.id;
  } catch { /* no scan */ }

  return queries.insertAgentObservation({
    domain: data.domain,
    merchant_scan_id: merchantScanId,
    observation_type: data.observation_type,
    source: data.source,
    query: data.query,
    evidence: data.evidence,
    evidence_url: data.evidence_url,
    metadata: data.metadata,
    confidence: data.confidence || 'medium',
  });
}

// ============================================
// LEADERBOARD: MOST AI-REFERENCED MERCHANTS
// ============================================

export async function getMerchantLeaderboard(
  limit = 20,
  since?: string,
): Promise<MerchantAIPresence[]> {
  const topMerchants = await queries.getMostReferencedMerchants(limit, since);

  // Enrich with scan data
  const enriched: MerchantAIPresence[] = [];

  for (const merchant of topMerchants) {
    let readinessScore: number | undefined;
    let merchantName: string | undefined;
    let hasAgentProtocol = false;

    try {
      const scan = await queries.getMerchantScanByDomain(merchant.domain);
      if (scan) {
        readinessScore = scan.readiness_score;
        merchantName = scan.merchant_name || undefined;

        const protocols = await queries.getProtocolResults(scan.id);
        hasAgentProtocol = protocols.some(p =>
          p.detected && ['ucp', 'acp', 'x402', 'ap2'].includes(p.protocol),
        );
      }
    } catch { /* scan data unavailable */ }

    const sourceBreakdown: Record<string, number> = {};
    const typeBreakdown: Record<string, number> = {};
    for (const s of merchant.sources) sourceBreakdown[s] = 1;
    for (const t of merchant.types) typeBreakdown[t] = 1;

    enriched.push({
      domain: merchant.domain,
      merchant_name: merchantName,
      observation_count: merchant.observation_count,
      source_breakdown: sourceBreakdown,
      type_breakdown: typeBreakdown,
      latest_observation: merchant.latest_observed_at,
      readiness_score: readinessScore,
      has_agent_protocol: hasAgentProtocol,
    });
  }

  return enriched;
}

// ============================================
// ACTIVITY REPORT
// ============================================

export async function getAgentActivityReport(
  since?: string,
): Promise<AgentActivityReport> {
  const periodStart = since || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const periodEnd = new Date().toISOString();

  const [observations, stats, topMerchants] = await Promise.all([
    queries.getAgentObservations({ since: periodStart, limit: 200 }),
    queries.getObservationStats(),
    getMerchantLeaderboard(20, periodStart),
  ]);

  // LATAM coverage
  const latamDomains: string[] = [];
  for (const obs of observations) {
    const domain = obs.domain;
    if (/\.mx$|\.br$|\.co$|\.ar$|\.cl$|\.pe$/i.test(domain)
      || /mercadoli|rappi|nubank|ifood|liverpool|elektra|coppel/i.test(domain)) {
      if (!latamDomains.includes(domain)) latamDomains.push(domain);
    }
  }

  return {
    period_start: periodStart,
    period_end: periodEnd,
    total_observations: stats.total,
    unique_merchants: stats.unique_domains,
    top_merchants: topMerchants,
    by_source: stats.by_source,
    by_type: stats.by_type,
    latam_coverage: {
      total: latamDomains.length,
      merchants: latamDomains,
    },
    generated_at: new Date().toISOString(),
  };
}

// ============================================
// MARKDOWN FORMATTER
// ============================================

export function formatActivityReportMarkdown(report: AgentActivityReport): string {
  const lines: string[] = [
    '## Agent Activity Observatory Report',
    `**Period:** ${report.period_start.split('T')[0]} to ${report.period_end.split('T')[0]}`,
    `**Total Observations:** ${report.total_observations}`,
    `**Unique Merchants:** ${report.unique_merchants}`,
    '',
  ];

  if (report.top_merchants.length > 0) {
    lines.push('### Most AI-Referenced Merchants');
    lines.push('');
    lines.push('| Rank | Domain | Observations | Readiness | Agent Protocol |');
    lines.push('|------|--------|-------------|-----------|----------------|');

    report.top_merchants.forEach((m, i) => {
      const score = m.readiness_score !== undefined ? `${m.readiness_score}/100` : '-';
      const protocol = m.has_agent_protocol ? 'Yes' : 'No';
      lines.push(`| ${i + 1} | ${m.domain} | ${m.observation_count} | ${score} | ${protocol} |`);
    });
    lines.push('');
  }

  if (Object.keys(report.by_source).length > 0) {
    lines.push('### Observations by Source');
    for (const [source, count] of Object.entries(report.by_source)) {
      lines.push(`- **${source}**: ${count}`);
    }
    lines.push('');
  }

  if (Object.keys(report.by_type).length > 0) {
    lines.push('### Observations by Type');
    for (const [type, count] of Object.entries(report.by_type)) {
      lines.push(`- **${type}**: ${count}`);
    }
    lines.push('');
  }

  if (report.latam_coverage.total > 0) {
    lines.push('### LATAM Coverage');
    lines.push(`**${report.latam_coverage.total} LATAM merchants** observed in AI agent activity:`);
    for (const domain of report.latam_coverage.merchants) {
      lines.push(`- ${domain}`);
    }
    lines.push('');
  }

  lines.push(`*Generated at ${report.generated_at}*`);

  return lines.join('\n');
}
