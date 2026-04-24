
import * as cheerio from 'cheerio';
import type { ScanStructuredData, SampleProduct } from '@sly/types';
import type { ScanConfig } from '../probes/types.js';
import { buildUrl } from '../probes/types.js';

interface StructuredDataResult {
  has_schema_product: boolean;
  has_schema_offer: boolean;
  has_schema_organization: boolean;
  has_json_ld: boolean;
  has_open_graph: boolean;
  has_microdata: boolean;
  product_count: number;
  products_with_price: number;
  products_with_availability: number;
  products_with_sku: number;
  products_with_image: number;
  data_quality_score: number;
  sample_products: SampleProduct[];
}

export async function analyzeStructuredData(
  domain: string,
  config: ScanConfig,
): Promise<StructuredDataResult> {
  const result: StructuredDataResult = {
    has_schema_product: false,
    has_schema_offer: false,
    has_schema_organization: false,
    has_json_ld: false,
    has_open_graph: false,
    has_microdata: false,
    product_count: 0,
    products_with_price: 0,
    products_with_availability: 0,
    products_with_sku: 0,
    products_with_image: 0,
    data_quality_score: 0,
    sample_products: [],
  };

  try {
    // Fetch homepage
    const homepageUrl = buildUrl(domain, '/');
    const res = await fetch(homepageUrl, {
      method: 'GET',
      headers: { 'User-Agent': config.user_agent, Accept: 'text/html' },
      signal: AbortSignal.timeout(config.timeout_ms),
    });

    if (!res.ok) return result;

    const html = await res.text();
    const $ = cheerio.load(html);

    // Extract JSON-LD blocks
    const jsonLdBlocks: Record<string, unknown>[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html();
        if (raw) {
          const parsed = JSON.parse(raw);
          const items = Array.isArray(parsed) ? parsed : [parsed];
          jsonLdBlocks.push(...items);
        }
      } catch {
        // Malformed JSON-LD, skip
      }
    });

    if (jsonLdBlocks.length > 0) {
      result.has_json_ld = true;

      for (const block of jsonLdBlocks) {
        const type = String(block['@type'] || '');
        if (type === 'Product' || type === 'IndividualProduct') result.has_schema_product = true;
        if (type === 'Offer' || type === 'AggregateOffer') result.has_schema_offer = true;
        if (type === 'Organization' || type === 'LocalBusiness') result.has_schema_organization = true;

        // Check nested offers inside Product
        if (type === 'Product' && block.offers) {
          result.has_schema_offer = true;
        }
      }
    }

    // Extract Open Graph tags
    const ogTags = $('meta[property^="og:"]');
    if (ogTags.length > 0) {
      result.has_open_graph = true;
    }

    // Detect Microdata
    const microdataItems = $('[itemscope][itemtype]');
    if (microdataItems.length > 0) {
      result.has_microdata = true;
      microdataItems.each((_, el) => {
        const itemtype = $(el).attr('itemtype') || '';
        if (itemtype.includes('schema.org/Product')) result.has_schema_product = true;
        if (itemtype.includes('schema.org/Offer')) result.has_schema_offer = true;
        if (itemtype.includes('schema.org/Organization')) result.has_schema_organization = true;
      });
    }

    // Discover product pages (up to 3)
    const productUrls = discoverProductUrls($, domain);
    const products: SampleProduct[] = [];

    // Parse products from JSON-LD
    for (const block of jsonLdBlocks) {
      const type = String(block['@type'] || '');
      if (type === 'Product') {
        const product = extractProductFromJsonLd(block);
        if (product) products.push(product);
      }
    }

    // Fetch product pages in parallel for additional data
    const pagesToFetch = productUrls.slice(0, 3);
    const pageResults = await Promise.allSettled(
      pagesToFetch.map(pageUrl => fetchProductPage(pageUrl, config))
    );
    for (const pageResult of pageResults) {
      if (pageResult.status === 'fulfilled') {
        products.push(...pageResult.value);
      }
    }

    // Deduplicate and limit to 5
    const uniqueProducts = deduplicateProducts(products).slice(0, 5);
    result.sample_products = uniqueProducts;

    // Count product data completeness
    result.product_count = uniqueProducts.length;
    result.products_with_price = uniqueProducts.filter(p => p.price !== undefined).length;
    result.products_with_availability = uniqueProducts.filter(p => p.availability !== undefined).length;
    result.products_with_sku = uniqueProducts.filter(p => p.sku !== undefined).length;
    result.products_with_image = uniqueProducts.filter(p => p.image_url !== undefined).length;

    // Compute data quality score
    result.data_quality_score = computeDataQualityScore(result);
  } catch {
    // Return defaults on error
  }

  return result;
}

function discoverProductUrls($: cheerio.CheerioAPI, domain: string): string[] {
  const urls: string[] = [];
  const baseUrl = `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;

  // Look for product links
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (
      href.includes('/product') ||
      href.includes('/p/') ||
      href.includes('/item/') ||
      href.includes('/shop/')
    ) {
      const full = href.startsWith('http') ? href : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`;
      if (!urls.includes(full)) urls.push(full);
    }
  });

  return urls;
}

function extractProductFromJsonLd(block: Record<string, unknown>): SampleProduct | null {
  const name = String(block.name || '');
  if (!name) return null;

  const product: SampleProduct = { name };

  // Price from offers
  const offers = block.offers;
  if (offers && typeof offers === 'object') {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    if (offer && typeof offer === 'object') {
      const offerObj = offer as Record<string, unknown>;
      if (offerObj.price) product.price = Number(offerObj.price);
      if (offerObj.priceCurrency) product.currency = String(offerObj.priceCurrency);
      if (offerObj.availability) product.availability = String(offerObj.availability).replace('https://schema.org/', '');
    }
  }

  if (block.sku) product.sku = String(block.sku);
  if (block.image) {
    const img = Array.isArray(block.image) ? block.image[0] : block.image;
    product.image_url = typeof img === 'string' ? img : (img as Record<string, unknown>)?.url as string;
  }
  if (block.url) product.url = String(block.url);

  return product;
}

async function fetchProductPage(url: string, config: ScanConfig): Promise<SampleProduct[]> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': config.user_agent, Accept: 'text/html' },
    signal: AbortSignal.timeout(config.timeout_ms),
  });

  if (!res.ok) return [];

  const html = await res.text();
  const $ = cheerio.load(html);
  const products: SampleProduct[] = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html();
      if (raw) {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (String(item['@type']) === 'Product') {
            const product = extractProductFromJsonLd(item);
            if (product) {
              product.url = url;
              products.push(product);
            }
          }
        }
      }
    } catch {
      // Skip malformed
    }
  });

  return products;
}

function deduplicateProducts(products: SampleProduct[]): SampleProduct[] {
  const seen = new Set<string>();
  return products.filter(p => {
    const key = p.name + (p.sku || '') + (p.url || '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeDataQualityScore(data: StructuredDataResult): number {
  let score = 0;

  if (data.has_json_ld) score += 25;
  else if (data.has_microdata) score += 15;

  if (data.has_schema_product) score += 20;
  if (data.has_schema_offer) score += 15;
  if (data.has_open_graph) score += 10;

  if (data.product_count > 0) {
    const priceRate = data.products_with_price / data.product_count;
    const availRate = data.products_with_availability / data.product_count;
    const skuRate = data.products_with_sku / data.product_count;
    const imgRate = data.products_with_image / data.product_count;

    score += Math.round(priceRate * 10);
    score += Math.round(availRate * 8);
    score += Math.round(skuRate * 6);
    score += Math.round(imgRate * 6);
  }

  return Math.min(100, score);
}
