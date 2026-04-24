
import * as cheerio from 'cheerio';
import type {
  AgentShoppingTestResult,
  AgentTestStep,
  AgentTestBlocker,
  AgentTestStepName,
  AgentTestBlockerType,
  AgentTestRecommendation,
} from '@sly/types';
import { normalizeDomain } from '../scanner.js';
import * as queries from '../db/queries.js';

// ============================================
// CONSTANTS
// ============================================

const USER_AGENT = 'SlyAgentTest/1.0 (+https://sly.dev/scanner)';
const REQUEST_TIMEOUT_MS = 8000;
const STEP_DELAY_MS = 1000;

const STEP_NAMES: AgentTestStepName[] = ['discovery', 'selection', 'cart', 'checkout', 'payment'];

const TEST_TYPE_MAX_STEP: Record<string, number> = {
  browse: 1,
  search: 1,
  add_to_cart: 3,
  checkout: 4,
  full_flow: 5,
};

const CATEGORY_BASELINES: Record<string, { visits: number; aov: number; conversion: number }> = {
  retail: { visits: 500, aov: 85, conversion: 0.03 },
  marketplace: { visits: 800, aov: 65, conversion: 0.025 },
  saas: { visits: 300, aov: 200, conversion: 0.05 },
  fintech: { visits: 200, aov: 150, conversion: 0.04 },
  restaurant: { visits: 400, aov: 35, conversion: 0.06 },
  b2b: { visits: 150, aov: 500, conversion: 0.02 },
  travel: { visits: 350, aov: 300, conversion: 0.015 },
  healthcare: { visits: 200, aov: 120, conversion: 0.03 },
  media: { visits: 600, aov: 15, conversion: 0.08 },
  other: { visits: 300, aov: 75, conversion: 0.03 },
};

// Writes tag the calling tenant (passed through runAgentShoppingTest);
// reads span the shared corpus.

// ============================================
// HELPERS
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeFetch(url: string, options: Record<string, unknown> = {}): Promise<{
  ok: boolean;
  status: number;
  text: string;
  headers: Record<string, string>;
}> {
  try {
    const res = await fetch(url, {
      method: (options.method as string) || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/json,application/xml',
        ...(options.headers as Record<string, string> || {}),
      },
      body: options.body as string | undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'follow',
    });
    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => { headers[key] = value; });
    return { ok: res.ok, status: res.status, text, headers };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: err instanceof Error ? err.message : 'Fetch failed',
      headers: {},
    };
  }
}

function shouldRunStep(stepIndex: number, testType: string): boolean {
  const max = TEST_TYPE_MAX_STEP[testType] || 5;
  return stepIndex <= max;
}

function detectPlatform(html: string): string | null {
  if (/Shopify\.theme|cdn\.shopify\.com|shopify-section/i.test(html)) return 'shopify';
  if (/woocommerce|wc-ajax|wc-block/i.test(html)) return 'woocommerce';
  if (/magento|mage-init/i.test(html)) return 'magento';
  if (/bigcommerce|BigCommerce/i.test(html)) return 'bigcommerce';
  return null;
}

function detectCaptcha(html: string): boolean {
  return /recaptcha|hcaptcha|cf-turnstile|captcha/i.test(html);
}

// ============================================
// STEP 1: DISCOVERY
// ============================================

async function testDiscovery(domain: string): Promise<{
  step: AgentTestStep;
  data: Record<string, unknown>;
}> {
  const start = Date.now();
  const productUrls: string[] = [];

  // Try sitemap.xml first
  const sitemapRes = await safeFetch(`https://${domain}/sitemap.xml`);
  if (sitemapRes.ok && sitemapRes.text.includes('<urlset') || sitemapRes.text.includes('<sitemapindex')) {
    const $ = cheerio.load(sitemapRes.text, { xmlMode: true });
    $('url > loc').each((_, el) => {
      const loc = $(el).text();
      if (/\/product[s]?\//i.test(loc) || /\/p\//i.test(loc) || /\/item[s]?\//i.test(loc)) {
        productUrls.push(loc);
      }
    });

    // If sitemapindex, try first child sitemap for products
    if (productUrls.length === 0) {
      const childSitemaps: string[] = [];
      $('sitemap > loc').each((_, el) => {
        const loc = $(el).text();
        if (/product/i.test(loc)) childSitemaps.push(loc);
      });
      if (childSitemaps.length > 0) {
        const childRes = await safeFetch(childSitemaps[0]);
        if (childRes.ok) {
          const $child = cheerio.load(childRes.text, { xmlMode: true });
          $child('url > loc').each((_, el) => {
            productUrls.push($child(el).text());
          });
        }
      }
    }
  }

  // Fallback: parse homepage for product links
  if (productUrls.length === 0) {
    const homeRes = await safeFetch(`https://${domain}`);
    if (homeRes.ok) {
      const $ = cheerio.load(homeRes.text);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (/\/product[s]?\//i.test(href) || /\/p\//i.test(href) || /\/item[s]?\//i.test(href)) {
          const full = href.startsWith('http') ? href : `https://${domain}${href}`;
          if (!productUrls.includes(full)) productUrls.push(full);
        }
      });
    }
  }

  const durationMs = Date.now() - start;

  if (productUrls.length === 0) {
    return {
      step: {
        step_number: 1,
        action: 'discover_products',
        description: 'Find product URLs via sitemap or homepage links',
        status: 'failed',
        duration_ms: durationMs,
        error: 'No product URLs found in sitemap.xml or homepage links',
      },
      data: {},
    };
  }

  return {
    step: {
      step_number: 1,
      action: 'discover_products',
      description: 'Find product URLs via sitemap or homepage links',
      status: 'passed',
      duration_ms: durationMs,
      data: { product_count: productUrls.length },
    },
    data: { productUrls, productUrl: productUrls[0] },
  };
}

// ============================================
// STEP 2: SELECTION
// ============================================

async function testSelection(productUrl: string, domain: string): Promise<{
  step: AgentTestStep;
  data: Record<string, unknown>;
}> {
  const start = Date.now();

  const res = await safeFetch(productUrl);
  if (!res.ok) {
    return {
      step: {
        step_number: 2,
        action: 'parse_product',
        description: 'Fetch product page and extract structured data (Schema.org Product)',
        status: 'failed',
        duration_ms: Date.now() - start,
        error: `Product page returned HTTP ${res.status}`,
      },
      data: {},
    };
  }

  const html = res.text;
  const platform = detectPlatform(html);

  if (detectCaptcha(html)) {
    return {
      step: {
        step_number: 2,
        action: 'parse_product',
        description: 'Fetch product page and extract structured data (Schema.org Product)',
        status: 'failed',
        duration_ms: Date.now() - start,
        error: 'CAPTCHA detected on product page',
      },
      data: { platform, blocker: 'captcha_blocked' as AgentTestBlockerType },
    };
  }

  const $ = cheerio.load(html);
  let productData: Record<string, unknown> = {};

  // Parse JSON-LD for Schema.org Product
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() || '');
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        if (item['@type'] === 'Product' || item['@type']?.includes?.('Product')) {
          productData = {
            name: item.name,
            price: item.offers?.price || item.offers?.[0]?.price,
            currency: item.offers?.priceCurrency || item.offers?.[0]?.priceCurrency,
            availability: item.offers?.availability || item.offers?.[0]?.availability,
            sku: item.sku,
          };
        }
      }
    } catch { /* ignore parse errors */ }
  });

  // Shopify: try .json endpoint for variant ID (needed for cart API)
  if (platform === 'shopify' && !productData.variantId) {
    const handle = productUrl.split('/products/')[1]?.split('?')[0]?.split('#')[0];
    if (handle) {
      const jsonRes = await safeFetch(`https://${domain}/products/${handle}.json`);
      if (jsonRes.ok) {
        try {
          const p = JSON.parse(jsonRes.text).product;
          if (p) {
            const variant = p.variants?.[0];
            productData = {
              ...productData,
              name: productData.name || p.title,
              price: productData.price || variant?.price,
              currency: productData.currency || 'USD',
              sku: productData.sku || variant?.sku,
              variantId: variant?.id,
              shopifyHandle: handle,
            };
          }
        } catch { /* ignore */ }
      }
    }
  }

  // Fallback: parse meta tags
  if (!productData.name) {
    productData.name = $('meta[property="og:title"]').attr('content')
      || $('h1').first().text().trim();
    productData.price = $('meta[property="product:price:amount"]').attr('content')
      || $('[itemprop="price"]').attr('content');
  }

  const durationMs = Date.now() - start;

  if (!productData.name) {
    return {
      step: {
        step_number: 2,
        action: 'parse_product',
        description: 'Fetch product page and extract structured data (Schema.org Product)',
        status: 'failed',
        duration_ms: durationMs,
        error: 'No structured product data found (no Schema.org Product, no meta tags)',
        data: { platform },
      },
      data: { platform, blocker: 'no_structured_data' as AgentTestBlockerType },
    };
  }

  return {
    step: {
      step_number: 2,
      action: 'parse_product',
      description: 'Fetch product page and extract structured data (Schema.org Product)',
      status: 'passed',
      duration_ms: durationMs,
      data: { product: productData, platform },
    },
    data: { product: productData, platform },
  };
}

// ============================================
// STEP 3: CART
// ============================================

async function testCart(domain: string, productData: Record<string, unknown>, platform: string | null): Promise<{
  step: AgentTestStep;
  data: Record<string, unknown>;
}> {
  const start = Date.now();

  // Shopify: POST /cart/add.js
  if (platform === 'shopify' && productData.variantId) {
    const res = await safeFetch(`https://${domain}/cart/add.js`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: productData.variantId, quantity: 1 }),
    });

    const durationMs = Date.now() - start;

    if (res.ok) {
      return {
        step: {
          step_number: 3,
          action: 'add_to_cart',
          description: 'Add product to cart via Shopify /cart/add.js API',
          status: 'passed',
          duration_ms: durationMs,
          data: { method: 'shopify_api' },
        },
        data: { cartMethod: 'shopify_api' },
      };
    }

    if (res.status === 422) {
      return {
        step: {
          step_number: 3,
          action: 'add_to_cart',
          description: 'Add product to cart via Shopify /cart/add.js API',
          status: 'passed', // 422 often means variant validation works, cart API is accessible
          duration_ms: durationMs,
          data: { method: 'shopify_api', note: 'Cart API reachable (variant may be out of stock)' },
        },
        data: { cartMethod: 'shopify_api' },
      };
    }

    return {
      step: {
        step_number: 3,
        action: 'add_to_cart',
        description: 'Add product to cart via Shopify /cart/add.js API',
        status: 'failed',
        duration_ms: durationMs,
        error: `Shopify cart API returned HTTP ${res.status}`,
      },
      data: { blocker: 'no_api_checkout' as AgentTestBlockerType },
    };
  }

  // WooCommerce: POST /?wc-ajax=add_to_cart
  if (platform === 'woocommerce' && productData.sku) {
    const res = await safeFetch(`https://${domain}/?wc-ajax=add_to_cart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `product_id=${productData.sku}&quantity=1`,
    });

    const durationMs = Date.now() - start;

    if (res.ok) {
      return {
        step: {
          step_number: 3,
          action: 'add_to_cart',
          description: 'Add product to cart via WooCommerce AJAX API',
          status: 'passed',
          duration_ms: durationMs,
          data: { method: 'woocommerce_ajax' },
        },
        data: { cartMethod: 'woocommerce_ajax' },
      };
    }
  }

  // Generic: check if cart endpoint exists
  const cartRes = await safeFetch(`https://${domain}/cart`);
  const durationMs = Date.now() - start;

  if (cartRes.ok) {
    if (detectCaptcha(cartRes.text)) {
      return {
        step: {
          step_number: 3,
          action: 'add_to_cart',
          description: 'Attempt to access cart page',
          status: 'failed',
          duration_ms: durationMs,
          error: 'CAPTCHA blocks cart access',
        },
        data: { blocker: 'captcha_blocked' as AgentTestBlockerType },
      };
    }
    return {
      step: {
        step_number: 3,
        action: 'add_to_cart',
        description: 'Attempt to access cart page (no programmatic add-to-cart API detected)',
        status: 'failed',
        duration_ms: durationMs,
        error: 'No programmatic add-to-cart API found. Cart page exists but requires JS interaction.',
      },
      data: { blocker: 'javascript_required' as AgentTestBlockerType },
    };
  }

  return {
    step: {
      step_number: 3,
      action: 'add_to_cart',
      description: 'Attempt to add product to cart',
      status: 'failed',
      duration_ms: durationMs,
      error: 'No cart endpoint or add-to-cart API found',
    },
    data: { blocker: 'no_api_checkout' as AgentTestBlockerType },
  };
}

// ============================================
// STEP 4: CHECKOUT
// ============================================

async function testCheckout(domain: string, platform: string | null): Promise<{
  step: AgentTestStep;
  data: Record<string, unknown>;
}> {
  const start = Date.now();

  const checkoutPaths = ['/checkout', '/checkouts'];
  if (platform === 'woocommerce') checkoutPaths.unshift('/checkout/');

  for (const path of checkoutPaths) {
    const res = await safeFetch(`https://${domain}${path}`);

    if (res.ok) {
      const html = res.text;
      const durationMs = Date.now() - start;

      if (detectCaptcha(html)) {
        return {
          step: {
            step_number: 4,
            action: 'reach_checkout',
            description: 'Navigate to checkout page and check for blockers',
            status: 'failed',
            duration_ms: durationMs,
            error: 'CAPTCHA blocks checkout',
          },
          data: { blocker: 'captcha_blocked' as AgentTestBlockerType },
        };
      }

      // Check for login wall
      const hasLoginWall = /sign.?in|log.?in|create.?account/i.test(html)
        && !/guest|continue.?as.?guest|skip/i.test(html);

      if (hasLoginWall) {
        return {
          step: {
            step_number: 4,
            action: 'reach_checkout',
            description: 'Navigate to checkout page and check for blockers',
            status: 'failed',
            duration_ms: durationMs,
            error: 'Checkout requires account login, no guest checkout option detected',
          },
          data: { blocker: 'no_guest_checkout' as AgentTestBlockerType },
        };
      }

      return {
        step: {
          step_number: 4,
          action: 'reach_checkout',
          description: 'Navigate to checkout page and check for blockers',
          status: 'passed',
          duration_ms: durationMs,
          data: { checkout_path: path },
        },
        data: { checkoutPath: path },
      };
    }

    // Shopify redirect to login for checkout
    if (res.status === 302 || res.status === 301) {
      const location = res.headers['location'] || '';
      if (/login|account/i.test(location)) {
        return {
          step: {
            step_number: 4,
            action: 'reach_checkout',
            description: 'Navigate to checkout page and check for blockers',
            status: 'failed',
            duration_ms: Date.now() - start,
            error: 'Checkout redirects to login page',
          },
          data: { blocker: 'no_guest_checkout' as AgentTestBlockerType },
        };
      }
    }
  }

  return {
    step: {
      step_number: 4,
      action: 'reach_checkout',
      description: 'Navigate to checkout page and check for blockers',
      status: 'failed',
      duration_ms: Date.now() - start,
      error: 'No accessible checkout page found',
    },
    data: { blocker: 'no_api_checkout' as AgentTestBlockerType },
  };
}

// ============================================
// STEP 5: PAYMENT
// ============================================

async function testPayment(domain: string, scanId: string | null): Promise<{
  step: AgentTestStep;
  data: Record<string, unknown>;
}> {
  const start = Date.now();

  // Check for agentic payment protocols from existing scan data
  let hasAgentProtocol = false;
  let protocols: string[] = [];

  if (scanId) {
    try {
      const protocolResults = await queries.getProtocolResults(scanId);
      protocols = protocolResults
        .filter(p => p.detected)
        .map(p => p.protocol);
      hasAgentProtocol = protocols.some(p =>
        ['ucp', 'acp', 'x402', 'ap2'].includes(p),
      );
    } catch { /* scan data unavailable */ }
  }

  // Also check .well-known/ucp as a quick probe
  if (!hasAgentProtocol) {
    const ucpRes = await safeFetch(`https://${domain}/.well-known/ucp`);
    if (ucpRes.ok) {
      try {
        const profile = JSON.parse(ucpRes.text);
        if (profile.checkout_types || profile.handlers) {
          hasAgentProtocol = true;
          protocols.push('ucp');
        }
      } catch { /* not valid JSON */ }
    }
  }

  const durationMs = Date.now() - start;

  if (hasAgentProtocol) {
    return {
      step: {
        step_number: 5,
        action: 'check_payment_protocol',
        description: 'Check if agentic payment protocols (UCP/ACP/x402/AP2) are available',
        status: 'passed',
        duration_ms: durationMs,
        data: { protocols },
      },
      data: { protocols },
    };
  }

  return {
    step: {
      step_number: 5,
      action: 'check_payment_protocol',
      description: 'Check if agentic payment protocols (UCP/ACP/x402/AP2) are available',
      status: 'failed',
      duration_ms: durationMs,
      error: 'No agentic payment protocol detected. Traditional checkout only.',
    },
    data: { blocker: 'no_agent_protocol' as AgentTestBlockerType },
  };
}

// ============================================
// REVENUE ESTIMATION
// ============================================

function estimateRevenue(
  category: string | undefined,
  successRate: number,
): {
  monthly_agent_visits: number;
  lost_conversions: number;
  lost_revenue_usd: number;
} {
  const baseline = CATEGORY_BASELINES[category || 'other'] || CATEGORY_BASELINES.other;
  const readinessMultiplier = successRate / 100;
  const monthlyVisits = Math.round(baseline.visits * (1 + readinessMultiplier));
  const lostConversions = Math.round(monthlyVisits * (1 - successRate / 100) * baseline.conversion);
  const lostRevenue = Math.round(lostConversions * baseline.aov * 100) / 100;

  return {
    monthly_agent_visits: monthlyVisits,
    lost_conversions: lostConversions,
    lost_revenue_usd: lostRevenue,
  };
}

// ============================================
// RECOMMENDATIONS
// ============================================

function generateRecommendations(
  steps: AgentTestStep[],
  platform: string | null,
): AgentTestRecommendation[] {
  const recs: AgentTestRecommendation[] = [];

  for (const step of steps) {
    if (step.status !== 'failed') continue;

    const error = step.error || '';

    if (/no.*structured.*data|no.*schema/i.test(error)) {
      recs.push({
        priority: 'high',
        action: 'Add Schema.org Product markup',
        detail: 'Add JSON-LD structured data with @type Product including name, price, availability, and SKU. This enables agents to programmatically identify and select products.',
        estimated_impact: 'Enables product discovery and selection by AI agents',
      });
    }

    if (/captcha/i.test(error)) {
      recs.push({
        priority: 'high',
        action: 'Whitelist agent user agents or use CAPTCHA-free checkout',
        detail: 'CAPTCHAs block AI agents from completing purchases. Consider whitelisting known agent user agents or implementing a CAPTCHA-free API checkout flow.',
        estimated_impact: 'Removes primary blocker for agent transactions',
      });
    }

    if (/guest.?checkout|login|account/i.test(error)) {
      recs.push({
        priority: 'high',
        action: 'Enable guest checkout for agent transactions',
        detail: 'Requiring account creation blocks agent shopping flows. Enable guest checkout or implement a tokenized checkout API.',
        estimated_impact: 'Enables checkout completion without account creation',
      });
    }

    if (/no.*api.*checkout|no.*programmatic|javascript.*required/i.test(error)) {
      if (platform === 'shopify') {
        recs.push({
          priority: 'medium',
          action: 'Enable Shopify Storefront API for headless checkout',
          detail: 'Use the Shopify Storefront API to enable programmatic checkout. This allows agents to complete purchases without browser-based JavaScript.',
          estimated_impact: 'Enables full programmatic checkout flow',
        });
      } else if (platform === 'woocommerce') {
        recs.push({
          priority: 'medium',
          action: 'Enable WooCommerce REST API for headless checkout',
          detail: 'Expose the WooCommerce REST API with checkout endpoints. This enables agents to complete purchases programmatically.',
          estimated_impact: 'Enables full programmatic checkout flow',
        });
      } else {
        recs.push({
          priority: 'medium',
          action: 'Implement an API-based checkout flow',
          detail: 'Create REST API endpoints for cart management and checkout. This allows AI agents to complete purchases without browser rendering.',
          estimated_impact: 'Enables programmatic checkout for agent commerce',
        });
      }
    }

    if (/no.*agent.*protocol|no.*agentic.*payment/i.test(error)) {
      recs.push({
        priority: 'medium',
        action: 'Adopt an agentic commerce protocol (UCP, ACP, or x402)',
        detail: 'Implement a standardized agentic commerce protocol to enable AI agents to discover, negotiate, and complete purchases. UCP (Universal Checkout Protocol) is recommended for most merchants.',
        estimated_impact: 'Enables end-to-end agent shopping with standardized payment',
      });
    }

    if (/no.*product.*url|sitemap/i.test(error)) {
      recs.push({
        priority: 'low',
        action: 'Add product URLs to sitemap.xml',
        detail: 'Include product page URLs in your sitemap.xml with /products/ path patterns. This enables agents to discover your product catalog.',
        estimated_impact: 'Enables product discovery via sitemap parsing',
      });
    }
  }

  // Deduplicate by action
  const seen = new Set<string>();
  return recs.filter(r => {
    if (seen.has(r.action)) return false;
    seen.add(r.action);
    return true;
  });
}

// ============================================
// ORCHESTRATOR
// ============================================

export async function runAgentShoppingTest(
  tenantId: string,
  domain: string,
  testType: 'browse' | 'search' | 'add_to_cart' | 'checkout' | 'full_flow' = 'full_flow',
): Promise<AgentShoppingTestResult> {
  const normalizedDomain = normalizeDomain(domain);
  const startTime = Date.now();
  const steps: AgentTestStep[] = [];
  const blockers: AgentTestBlocker[] = [];
  let currentData: Record<string, unknown> = {};
  let failurePoint: AgentShoppingTestResult['failure_point'];
  let scanId: string | null = null;
  let category: string | undefined;

  // Look up existing scan for context (shared corpus)
  try {
    const scan = await queries.getMerchantScanByDomain(normalizedDomain);
    if (scan) {
      scanId = scan.id;
      category = scan.merchant_category || undefined;
    }
  } catch { /* no scan data available */ }

  // If no scan exists, create a minimal one under the caller's tenant so the
  // test can link to something.
  if (!scanId) {
    try {
      const scan = await queries.upsertMerchantScan(tenantId, {
        domain: normalizedDomain,
        url: `https://${normalizedDomain}`,
        scan_status: 'pending',
      });
      scanId = scan.id;
    } catch { /* DB might not be available */ }
  }

  const maxSteps = TEST_TYPE_MAX_STEP[testType] || 5;

  // ---- Step 1: Discovery ----
  const discovery = await testDiscovery(normalizedDomain);
  steps.push(discovery.step);

  if (discovery.step.status === 'failed') {
    failurePoint = { step: 'discovery', blocker: 'no_structured_data', detail: discovery.step.error || 'No product URLs found' };
    blockers.push({ type: 'no_structured_data', description: discovery.step.error || '', severity: 'blocking', step_number: 1 });
  } else {
    currentData = { ...currentData, ...discovery.data };
  }

  // ---- Step 2: Selection ----
  if (discovery.step.status === 'passed' && shouldRunStep(2, testType)) {
    await sleep(STEP_DELAY_MS);
    const selection = await testSelection(currentData.productUrl as string, normalizedDomain);
    steps.push(selection.step);

    if (selection.step.status === 'failed') {
      const blockerType = (selection.data.blocker as AgentTestBlockerType) || 'no_structured_data';
      failurePoint = { step: 'selection', blocker: blockerType, detail: selection.step.error || '' };
      blockers.push({
        type: blockerType === 'captcha_blocked' ? 'captcha' : 'no_structured_data',
        description: selection.step.error || '',
        severity: 'blocking',
        step_number: 2,
      });
    } else {
      currentData = { ...currentData, ...selection.data };
    }
  } else if (discovery.step.status === 'failed' && shouldRunStep(2, testType)) {
    steps.push({ step_number: 2, action: 'parse_product', description: 'Skipped: no product URL from discovery', status: 'skipped', duration_ms: 0 });
  }

  // ---- Step 3: Cart ----
  const selectionPassed = steps.find(s => s.step_number === 2)?.status === 'passed';
  if (selectionPassed && shouldRunStep(3, testType)) {
    await sleep(STEP_DELAY_MS);
    const cart = await testCart(normalizedDomain, currentData.product as Record<string, unknown> || {}, currentData.platform as string | null);
    steps.push(cart.step);

    if (cart.step.status === 'failed') {
      const blockerType = (cart.data.blocker as AgentTestBlockerType) || 'no_api_checkout';
      failurePoint = failurePoint || { step: 'cart', blocker: blockerType, detail: cart.step.error || '' };
      blockers.push({
        type: blockerType === 'captcha_blocked' ? 'captcha' : blockerType === 'javascript_required' ? 'javascript_required' : 'checkout_friction',
        description: cart.step.error || '',
        severity: 'blocking',
        step_number: 3,
      });
    } else {
      currentData = { ...currentData, ...cart.data };
    }
  } else if (!selectionPassed && shouldRunStep(3, testType)) {
    steps.push({ step_number: 3, action: 'add_to_cart', description: 'Skipped: product selection failed', status: 'skipped', duration_ms: 0 });
  }

  // ---- Step 4: Checkout ----
  const cartPassed = steps.find(s => s.step_number === 3)?.status === 'passed';
  if (cartPassed && shouldRunStep(4, testType)) {
    await sleep(STEP_DELAY_MS);
    const checkout = await testCheckout(normalizedDomain, currentData.platform as string | null);
    steps.push(checkout.step);

    if (checkout.step.status === 'failed') {
      const blockerType = (checkout.data.blocker as AgentTestBlockerType) || 'no_api_checkout';
      failurePoint = failurePoint || { step: 'checkout', blocker: blockerType, detail: checkout.step.error || '' };
      const blockerMapType = blockerType === 'captcha_blocked' ? 'captcha' as const
        : blockerType === 'no_guest_checkout' ? 'auth_wall' as const
        : 'checkout_friction' as const;
      blockers.push({
        type: blockerMapType,
        description: checkout.step.error || '',
        severity: 'blocking',
        step_number: 4,
      });
    } else {
      currentData = { ...currentData, ...checkout.data };
    }
  } else if (!cartPassed && shouldRunStep(4, testType)) {
    steps.push({ step_number: 4, action: 'reach_checkout', description: 'Skipped: cart step failed', status: 'skipped', duration_ms: 0 });
  }

  // ---- Step 5: Payment ----
  const checkoutPassed = steps.find(s => s.step_number === 4)?.status === 'passed';
  if (checkoutPassed && shouldRunStep(5, testType)) {
    await sleep(STEP_DELAY_MS);
    const payment = await testPayment(normalizedDomain, scanId);
    steps.push(payment.step);

    if (payment.step.status === 'failed') {
      const blockerType = (payment.data.blocker as AgentTestBlockerType) || 'no_agent_protocol';
      failurePoint = failurePoint || { step: 'payment', blocker: blockerType, detail: payment.step.error || '' };
      blockers.push({
        type: 'other',
        description: payment.step.error || '',
        severity: 'degraded',
        step_number: 5,
      });
    }
  } else if (!checkoutPassed && shouldRunStep(5, testType)) {
    steps.push({ step_number: 5, action: 'check_payment_protocol', description: 'Skipped: checkout step failed', status: 'skipped', duration_ms: 0 });
  }

  // Compute results
  const completedSteps = steps.filter(s => s.status === 'passed').length;
  const totalSteps = Math.min(maxSteps, 5);
  const successRate = Math.round((completedSteps / totalSteps) * 10000) / 100;
  const durationMs = Date.now() - startTime;

  let status: AgentShoppingTestResult['status'];
  if (completedSteps === totalSteps) status = 'passed';
  else if (completedSteps === 0) status = blockers.length > 0 ? 'blocked' : 'failed';
  else status = 'partial';

  const platform = currentData.platform as string | null;
  const recommendations = generateRecommendations(steps, platform);
  const revenue = estimateRevenue(category, successRate);

  const result: AgentShoppingTestResult = {
    id: '',
    merchant_scan_id: scanId || '',
    domain: normalizedDomain,
    test_type: testType,
    status,
    steps,
    blockers,
    total_steps: totalSteps,
    completed_steps: completedSteps,
    success_rate: successRate,
    failure_point: failurePoint,
    estimated_monthly_agent_visits: revenue.monthly_agent_visits,
    estimated_lost_conversions: revenue.lost_conversions,
    estimated_lost_revenue_usd: revenue.lost_revenue_usd,
    recommendations,
    duration_ms: durationMs,
    agent_model: 'deterministic-http-v1',
    tested_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };

  // Persist to DB
  if (scanId) {
    try {
      const { id } = await queries.insertAgentShoppingTest({
        merchant_scan_id: scanId,
        domain: normalizedDomain,
        test_type: testType,
        status,
        steps,
        blockers,
        total_steps: totalSteps,
        completed_steps: completedSteps,
        success_rate: successRate,
        failure_point: failurePoint,
        estimated_monthly_agent_visits: revenue.monthly_agent_visits,
        estimated_lost_conversions: revenue.lost_conversions,
        estimated_lost_revenue_usd: revenue.lost_revenue_usd,
        recommendations,
        duration_ms: durationMs,
        agent_model: 'deterministic-http-v1',
      });
      result.id = id;
    } catch (err) {
      // DB persistence is best-effort; return result even if insert fails
      console.warn('[SyntheticTest] Failed to persist test result:', err instanceof Error ? err.message : err);
    }
  }

  return result;
}

// ============================================
// MARKDOWN FORMATTER
// ============================================

export function formatTestResultMarkdown(result: AgentShoppingTestResult): string {
  const statusEmoji = result.status === 'passed' ? 'PASS' : result.status === 'partial' ? 'PARTIAL' : 'FAIL';

  const lines: string[] = [
    `## Agent Shopping Test: ${result.domain}`,
    `**Status:** ${statusEmoji} (${result.status})`,
    `**Test Type:** ${result.test_type}`,
    `**Success Rate:** ${result.success_rate}% (${result.completed_steps}/${result.total_steps} steps)`,
    `**Duration:** ${result.duration_ms}ms`,
    '',
    '### Steps',
    '',
    '| # | Action | Status | Time |',
    '|---|--------|--------|------|',
  ];

  for (const step of result.steps) {
    const statusLabel = step.status === 'passed' ? 'Passed' : step.status === 'failed' ? 'Failed' : 'Skipped';
    lines.push(`| ${step.step_number} | ${step.description.substring(0, 60)} | ${statusLabel} | ${step.duration_ms}ms |`);
  }

  if (result.failure_point) {
    lines.push('', '### Failure Point');
    lines.push(`- **Step:** ${result.failure_point.step}`);
    lines.push(`- **Blocker:** ${result.failure_point.blocker}`);
    lines.push(`- **Detail:** ${result.failure_point.detail}`);
  }

  if (result.blockers.length > 0) {
    lines.push('', '### Blockers');
    for (const b of result.blockers) {
      lines.push(`- **${b.type}** (${b.severity}, step ${b.step_number}): ${b.description}`);
    }
  }

  if (result.estimated_lost_revenue_usd !== undefined) {
    lines.push('', '### Revenue Impact');
    lines.push(`- **Est. Monthly Agent Visits:** ${result.estimated_monthly_agent_visits}`);
    lines.push(`- **Est. Lost Conversions:** ${result.estimated_lost_conversions}/month`);
    lines.push(`- **Est. Lost Revenue:** $${result.estimated_lost_revenue_usd?.toFixed(2)}/month`);
  }

  if (result.recommendations.length > 0) {
    lines.push('', '### Recommendations');
    for (const rec of result.recommendations) {
      lines.push(`- **[${rec.priority.toUpperCase()}]** ${rec.action}`);
      lines.push(`  ${rec.detail}`);
      if (rec.estimated_impact) lines.push(`  *Impact: ${rec.estimated_impact}*`);
    }
  }

  lines.push('', `*Tested at ${result.tested_at} | Model: ${result.agent_model}*`);

  return lines.join('\n');
}
