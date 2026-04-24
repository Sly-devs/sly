
import * as cheerio from 'cheerio';
import type { ScanConfig } from '../probes/types.js';
import { buildUrl } from '../probes/types.js';

interface AccessibilityResult {
  homepage_accessible: boolean;
  robots_txt_exists: boolean;
  robots_blocks_gptbot: boolean;
  robots_blocks_claudebot: boolean;
  robots_blocks_googlebot: boolean;
  robots_blocks_all_bots: boolean;
  robots_allows_agents: boolean;
  robots_raw?: string;
  requires_javascript: boolean;
  has_captcha: boolean;
  requires_account: boolean;
  guest_checkout_available: boolean;
  checkout_steps_count?: number;
  payment_processors: string[];
  supports_digital_wallets: boolean;
  supports_crypto: boolean;
  supports_pix: boolean;
  supports_spei: boolean;
  ecommerce_platform?: string;
  platform_version?: string;
}

// Platform detection signatures
const PLATFORM_SIGNATURES: Record<string, { patterns: string[]; versionPattern?: RegExp }> = {
  shopify: {
    patterns: ['Shopify.theme', 'cdn.shopify.com', 'myshopify.com', 'shopify-section'],
    versionPattern: /Shopify\.theme\s*=.*?"version":"([^"]+)"/,
  },
  woocommerce: {
    patterns: ['wc-cart', 'woocommerce', 'wp-content/plugins/woocommerce'],
    versionPattern: /woocommerce.*?ver=([0-9.]+)/,
  },
  magento: {
    patterns: ['Magento_', 'mage/cookies', 'requirejs/require'],
    versionPattern: /magento.*?version.*?([0-9.]+)/i,
  },
  bigcommerce: {
    patterns: ['bigcommerce.com', 'stencil-utils', 'data-content-region'],
  },
  squarespace: {
    patterns: ['squarespace.com', 'static.squarespace.com', 'squarespace-cdn'],
  },
  wix: {
    patterns: ['wix.com', 'parastorage.com', '_wix_browser_sess'],
  },
  prestashop: {
    patterns: ['prestashop', 'PrestaShop'],
  },
  salesforce_commerce: {
    patterns: ['demandware.net', 'salesforce-commerce', 'dw.js'],
  },
  etsy: {
    patterns: ['etsy.com', 'etsy.me', 'etsystatic.com', 'data-etsy'],
  },
};

// Payment processor signatures
const PAYMENT_SIGNATURES: Record<string, string[]> = {
  stripe: ['stripe.com', 'Stripe(', 'stripe.js', 'js.stripe.com'],
  paypal: ['paypal.com', 'paypal-button', 'paypalobjects.com'],
  square: ['squareup.com', 'square.js', 'squarecdn.com'],
  mercadopago: ['mercadopago.com', 'mercadopago.js', 'mp-mercadopago'],
  adyen: ['adyen.com', 'adyen-checkout'],
  braintree: ['braintreegateway.com', 'braintree-web'],
  klarna: ['klarna.com', 'klarna-checkout'],
  afterpay: ['afterpay.com', 'afterpay.js'],
};

// CAPTCHA signatures
const CAPTCHA_SIGNATURES = [
  'recaptcha', 'google.com/recaptcha',
  'hcaptcha', 'hcaptcha.com',
  'turnstile', 'challenges.cloudflare.com',
  'funcaptcha', 'arkoselabs.com',
  'captcha-delivery.com', 'datadome',
  'perimeterx', 'px-captcha',
];

export async function analyzeAccessibility(
  domain: string,
  config: ScanConfig,
): Promise<AccessibilityResult> {
  const result: AccessibilityResult = {
    homepage_accessible: false,
    robots_txt_exists: false,
    robots_blocks_gptbot: false,
    robots_blocks_claudebot: false,
    robots_blocks_googlebot: false,
    robots_blocks_all_bots: false,
    robots_allows_agents: false,
    requires_javascript: false,
    has_captcha: false,
    requires_account: false,
    guest_checkout_available: false,
    payment_processors: [],
    supports_digital_wallets: false,
    supports_crypto: false,
    supports_pix: false,
    supports_spei: false,
  };

  // Parallel: fetch robots.txt and homepage
  const [robotsResult, htmlResult] = await Promise.allSettled([
    fetchRobotsTxt(domain, config),
    fetchHomepage(domain, config),
  ]);

  // Process robots.txt
  if (robotsResult.status === 'fulfilled' && robotsResult.value) {
    const robots = robotsResult.value;
    result.robots_txt_exists = true;
    result.robots_raw = robots;
    const parsed = parseRobotsTxt(robots);
    result.robots_blocks_gptbot = parsed.blocksGPTBot;
    result.robots_blocks_claudebot = parsed.blocksClaudeBot;
    result.robots_blocks_googlebot = parsed.blocksGooglebot;
    result.robots_blocks_all_bots = parsed.blocksAll;
    result.robots_allows_agents = parsed.allowsAgents;
  }

  // Process homepage HTML
  if (htmlResult.status === 'fulfilled' && htmlResult.value) {
    result.homepage_accessible = true;
    const html = htmlResult.value;
    const $ = cheerio.load(html);

    // Detect platform
    const platform = detectPlatform(html, $, domain);
    if (platform) {
      result.ecommerce_platform = platform.name;
      result.platform_version = platform.version;
    }

    // Detect CAPTCHA
    result.has_captcha = CAPTCHA_SIGNATURES.some(sig => html.toLowerCase().includes(sig));

    // Detect payment processors
    result.payment_processors = detectPaymentProcessors(html);

    // Digital wallet detection
    result.supports_digital_wallets = html.includes('apple-pay') ||
      html.includes('google-pay') ||
      html.includes('gpay') ||
      html.includes('applepay');

    // Crypto detection
    result.supports_crypto = html.includes('bitcoin') ||
      html.includes('crypto') ||
      html.includes('usdc') ||
      html.includes('coinbase-commerce');

    // Pix/SPEI detection (LATAM)
    result.supports_pix = html.toLowerCase().includes('pix');
    result.supports_spei = html.toLowerCase().includes('spei');

    // JavaScript requirement detection
    const noScript = $('noscript').length > 0;
    const spaMarkers = html.includes('__NEXT_DATA__') ||
      html.includes('__NUXT__') ||
      html.includes('root') && $('body').children().length <= 2;
    result.requires_javascript = spaMarkers && !noScript;

    // Guest checkout detection
    result.guest_checkout_available = detectGuestCheckout($, html);

    // Account requirement detection
    result.requires_account = !result.guest_checkout_available &&
      (html.includes('sign in to checkout') ||
       html.includes('login to checkout') ||
       html.includes('create account'));

    // Checkout steps estimation
    result.checkout_steps_count = estimateCheckoutSteps($, html, result.ecommerce_platform);
  }

  // Domain-based platform fallback (when HTML is blocked by anti-bot / 403)
  if (!result.ecommerce_platform) {
    const stripped = domain.replace(/^www\./, '');
    const platformFromDomain = DOMAIN_PLATFORM_MAP[stripped];
    if (platformFromDomain) {
      result.ecommerce_platform = platformFromDomain;
    }
  }

  return result;
}

async function fetchRobotsTxt(domain: string, config: ScanConfig): Promise<string | null> {
  const url = buildUrl(domain, '/robots.txt');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent },
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchHomepage(domain: string, config: ScanConfig): Promise<string | null> {
  const url = buildUrl(domain, '/');
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'text/html' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface RobotsTxtParsed {
  blocksGPTBot: boolean;
  blocksClaudeBot: boolean;
  blocksGooglebot: boolean;
  blocksAll: boolean;
  allowsAgents: boolean;
}

function parseRobotsTxt(txt: string): RobotsTxtParsed {
  const result: RobotsTxtParsed = {
    blocksGPTBot: false,
    blocksClaudeBot: false,
    blocksGooglebot: false,
    blocksAll: false,
    allowsAgents: false,
  };

  const lines = txt.split('\n');
  let currentAgent = '';

  for (const rawLine of lines) {
    const line = rawLine.trim().toLowerCase();

    if (line.startsWith('user-agent:')) {
      currentAgent = line.replace('user-agent:', '').trim();
    } else if (line.startsWith('disallow:') && line.replace('disallow:', '').trim() === '/') {
      // This agent is blocked from everything
      if (currentAgent === '*') result.blocksAll = true;
      if (currentAgent === 'gptbot') result.blocksGPTBot = true;
      if (currentAgent === 'claudebot' || currentAgent === 'claude-web') result.blocksClaudeBot = true;
      if (currentAgent === 'googlebot') result.blocksGooglebot = true;
    } else if (line.startsWith('allow:') && line.replace('allow:', '').trim() === '/') {
      // Explicit allow
      if (currentAgent === 'gptbot' || currentAgent === 'claudebot' || currentAgent === 'claude-web') {
        result.allowsAgents = true;
      }
    }
  }

  return result;
}

// Domain-based platform detection (fallback when HTML is blocked by anti-bot)
const DOMAIN_PLATFORM_MAP: Record<string, string> = {
  'etsy.com': 'etsy',
  'amazon.com': 'amazon',
  'ebay.com': 'ebay',
  'walmart.com': 'walmart',
  'mercadolibre.com': 'mercadolibre',
  'mercadolibre.com.br': 'mercadolibre',
  'mercadolibre.com.mx': 'mercadolibre',
  'mercadolibre.com.ar': 'mercadolibre',
};

function detectPlatform(html: string, $: cheerio.CheerioAPI, domain?: string): { name: string; version?: string } | null {
  const htmlLower = html.toLowerCase();

  let bestName: string | null = null;
  let bestScore = 0;
  let bestVersion: string | undefined;

  for (const [name, sig] of Object.entries(PLATFORM_SIGNATURES)) {
    const matchCount = sig.patterns.filter(p => htmlLower.includes(p.toLowerCase())).length;
    if (matchCount > bestScore) {
      bestScore = matchCount;
      bestName = name;
      bestVersion = undefined;
      if (sig.versionPattern) {
        const match = html.match(sig.versionPattern);
        if (match) bestVersion = match[1];
      }
    }
  }

  // Require at least 2 pattern matches to avoid false positives
  // (e.g. stripe.com mentioning "woocommerce" in an analytics label)
  if (bestName && bestScore >= 2) {
    return { name: bestName, version: bestVersion };
  }

  // Fallback: domain-based detection for known platforms that block bots
  if (domain) {
    const stripped = domain.replace(/^www\./, '');
    const platformFromDomain = DOMAIN_PLATFORM_MAP[stripped];
    if (platformFromDomain) {
      return { name: platformFromDomain };
    }
  }

  return null;
}

function detectPaymentProcessors(html: string): string[] {
  const htmlLower = html.toLowerCase();
  const detected: string[] = [];

  for (const [processor, signatures] of Object.entries(PAYMENT_SIGNATURES)) {
    if (signatures.some(sig => htmlLower.includes(sig.toLowerCase()))) {
      detected.push(processor);
    }
  }

  return detected;
}

function detectGuestCheckout($: cheerio.CheerioAPI, html: string): boolean {
  const htmlLower = html.toLowerCase();

  // Positive signals
  if (htmlLower.includes('guest checkout') ||
      htmlLower.includes('checkout as guest') ||
      htmlLower.includes('continue as guest') ||
      htmlLower.includes('buy now')) {
    return true;
  }

  // Platform-specific defaults
  // Shopify default supports guest checkout
  if (htmlLower.includes('cdn.shopify.com')) return true;

  return false;
}

function estimateCheckoutSteps(
  $: cheerio.CheerioAPI,
  html: string,
  platform?: string,
): number | undefined {
  // Platform-specific defaults
  if (platform === 'shopify') return 3; // Cart → Info → Payment
  if (platform === 'woocommerce') return 2; // Cart → Checkout
  if (platform === 'bigcommerce') return 3;

  // Look for multi-step indicators
  const htmlLower = html.toLowerCase();
  if (htmlLower.includes('step 1') || htmlLower.includes('step-1')) {
    const stepMatches = html.match(/step[- ](\d)/gi);
    if (stepMatches) return Math.max(...stepMatches.map(m => parseInt(m.replace(/\D/g, ''))));
  }

  return undefined;
}
