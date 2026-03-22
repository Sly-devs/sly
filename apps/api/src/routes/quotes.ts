import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import { getEnv } from '../utils/helpers.js';
import { ValidationError } from '../middleware/error.js';
import { getExchangeRate, MOCK_FX_RATES } from '@sly/utils';
import { getCircleFXService } from '../services/circle/fx.js';
import { getMultiCurrencyService, SUPPORTED_CORRIDORS, type SupportedCurrency } from '../services/fx/index.js';
import { trackOp } from '../services/ops/track-op.js';
import { OpType } from '../services/ops/operation-types.js';

const quotes = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createQuoteSchema = z.object({
  fromCurrency: z.string().default('USD'),
  toCurrency: z.string(),
  amount: z.number().positive(),
  corridor: z.string().optional(),
});

// ============================================
// FEE CALCULATION
// ============================================

interface FeeBreakdown {
  type: string;
  amount: number;
  description: string;
}

function calculateFees(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  corridor?: string
): { total: number; breakdown: FeeBreakdown[] } {
  const breakdown: FeeBreakdown[] = [];
  
  // Platform fee (0.5%)
  const platformFee = amount * 0.005;
  breakdown.push({
    type: 'platform_fee',
    amount: Math.round(platformFee * 100) / 100,
    description: 'Platform fee (0.5%)',
  });
  
  // Cross-border fee if different currencies
  if (fromCurrency !== toCurrency) {
    const crossBorderFee = amount * 0.002; // 0.2%
    breakdown.push({
      type: 'cross_border_fee',
      amount: Math.round(crossBorderFee * 100) / 100,
      description: 'Cross-border fee (0.2%)',
    });
  }
  
  // Corridor-specific fees
  if (corridor === 'USD_BRL') {
    const corridorFee = 1.50; // Flat fee for Brazil
    breakdown.push({
      type: 'corridor_fee',
      amount: corridorFee,
      description: 'Brazil corridor fee',
    });
  }
  
  const total = breakdown.reduce((sum, fee) => sum + fee.amount, 0);
  
  return {
    total: Math.round(total * 100) / 100,
    breakdown,
  };
}

// ============================================
// POST /v1/quotes - Get a quote
// ============================================
quotes.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse and validate body
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createQuoteSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { fromCurrency, toCurrency, amount, corridor } = parsed.data;
  
  // Validate currencies
  const supportedCurrencies = ['USD', 'USDC', 'MXN', 'BRL', 'ARS', 'COP', 'PKR'];
  if (!supportedCurrencies.includes(fromCurrency)) {
    throw new ValidationError(`Unsupported currency: ${fromCurrency}`);
  }
  if (!supportedCurrencies.includes(toCurrency)) {
    throw new ValidationError(`Unsupported currency: ${toCurrency}`);
  }
  
  // Get FX rate
  const effectiveFromCurrency = fromCurrency === 'USDC' ? 'USD' : fromCurrency;
  const effectiveToCurrency = toCurrency === 'USDC' ? 'USD' : toCurrency;
  const fxRate = getExchangeRate(effectiveFromCurrency, effectiveToCurrency);
  
  // Calculate fees
  const fees = calculateFees(amount, fromCurrency, toCurrency, corridor);
  
  // Calculate destination amount
  const netAmount = amount - fees.total;
  const destinationAmount = netAmount * fxRate;
  
  // Create quote record
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  
  const { data: quote, error } = await supabase
    .from('quotes')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      from_currency: fromCurrency,
      to_currency: toCurrency,
      from_amount: amount,
      to_amount: Math.round(destinationAmount * 100) / 100,
      fx_rate: fxRate,
      fee_amount: fees.total,
      fee_breakdown: fees.breakdown,
      corridor_id: corridor || `${fromCurrency}_${toCurrency}`,
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error creating quote:', error);
    return c.json({ error: 'Failed to create quote' }, 500);
  }
  
  // Estimate settlement time based on corridor
  let estimatedSettlement = '1-2 minutes';
  if (toCurrency === 'BRL') {
    estimatedSettlement = '2-5 minutes (Pix)';
  } else if (toCurrency === 'MXN') {
    estimatedSettlement = '1-3 minutes (SPEI)';
  } else if (fromCurrency === toCurrency || (fromCurrency === 'USDC' && toCurrency === 'USD')) {
    estimatedSettlement = 'Instant';
  }
  
  trackOp({
    tenantId: ctx.tenantId,
    operation: OpType.FX_QUOTE,
    subject: `quote/${quote.id}`,
    actorType: ctx.actorType,
    actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
    correlationId: c.get('requestId'),
    success: true,
    data: { fromCurrency, toCurrency, amount },
  });

  return c.json({
    data: {
      id: quote.id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount: Math.round(destinationAmount * 100) / 100,
      fxRate,
      fees: {
        total: fees.total,
        breakdown: fees.breakdown,
      },
      expiresAt: expiresAt.toISOString(),
      estimatedSettlement,
      corridor: corridor || `${fromCurrency}_${toCurrency}`,
    },
  });
});

// ============================================
// GET /v1/quotes/rates - Get current FX rates
// ============================================
quotes.get('/rates', async (c) => {
  // Return current mock rates
  return c.json({
    data: {
      baseCurrency: 'USD',
      rates: {
        MXN: MOCK_FX_RATES.USD_MXN,
        BRL: MOCK_FX_RATES.USD_BRL,
        ARS: MOCK_FX_RATES.USD_ARS,
        COP: MOCK_FX_RATES.USD_COP,
        USD: 1,
        USDC: 1,
      },
      updatedAt: new Date().toISOString(),
      note: 'Rates are mocked for PoC - real rates would come from exchange provider',
    },
  });
});

// ============================================
// GET /v1/quotes/fx - Get Circle FX quote (Story 40.6)
// ============================================
quotes.get('/fx', async (c) => {
  const source = c.req.query('source') || 'USD';
  const destination = c.req.query('destination') || 'BRL';
  const amount = parseFloat(c.req.query('amount') || '100');
  
  const fxService = getCircleFXService();
  
  try {
    const quote = await fxService.getQuote({
      source_currency: source,
      destination_currency: destination,
      source_amount: amount,
    });
    
    return c.json({ data: quote });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ============================================
// POST /v1/quotes/fx - Create Circle FX quote
// ============================================
quotes.post('/fx', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const { source_currency, destination_currency, source_amount, destination_amount } = body;
  
  if (!source_currency || !destination_currency) {
    throw new ValidationError('source_currency and destination_currency are required');
  }
  
  if (!source_amount && !destination_amount) {
    throw new ValidationError('Either source_amount or destination_amount is required');
  }
  
  const fxService = getCircleFXService();
  
  try {
    const quote = await fxService.getQuote({
      source_currency,
      destination_currency,
      source_amount,
      destination_amount,
    });
    
    // Store quote in database
    const { data: storedQuote, error } = await supabase
      .from('quotes')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_currency: quote.source_currency,
        to_currency: quote.destination_currency,
        from_amount: quote.source_amount || 0,
        to_amount: quote.destination_amount || 0,
        fx_rate: quote.rate,
        fee_amount: quote.total_fee,
        fee_breakdown: [{
          type: 'fx_fee',
          amount: quote.total_fee,
          description: `FX fee (${quote.fee_percentage}%)`
        }],
        corridor_id: quote.corridor,
        expires_at: quote.expires_at,
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error storing quote:', error);
    }
    
    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.FX_QUOTE,
      subject: `quote/${storedQuote?.id || 'circle'}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { fromCurrency: source_currency, toCurrency: destination_currency, amount: source_amount || destination_amount },
    });

    return c.json({
      data: {
        ...quote,
        database_id: storedQuote?.id,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ============================================
// POST /v1/quotes/fx/lock - Lock a quote
// ============================================
quotes.post('/fx/lock', async (c) => {
  const ctx = c.get('ctx');

  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }

  const { quote_id } = body;

  if (!quote_id) {
    throw new ValidationError('quote_id is required');
  }

  const fxService = getCircleFXService();

  try {
    const lockedQuote = await fxService.lockQuote(quote_id);

    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.FX_QUOTE,
      subject: `quote/${quote_id}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { action: 'lock', quoteId: quote_id },
    });

    return c.json({ data: lockedQuote });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

// ============================================
// GET /v1/quotes/fx/corridors - Get supported corridors
// ============================================
quotes.get('/fx/corridors', async (c) => {
  const fxService = getCircleFXService();
  const corridors = fxService.getSupportedCorridors();
  
  return c.json({
    data: {
      corridors,
      primary: [
        { source: 'USD', destination: 'BRL', name: 'Pix (Brazil)', settlement: '2-5 minutes' },
        { source: 'USD', destination: 'MXN', name: 'SPEI (Mexico)', settlement: '1-3 minutes' },
      ],
      cross_latam: [
        { source: 'BRL', destination: 'MXN', name: 'Brazil → Mexico', settlement: '5-10 minutes', via: 'USD' },
        { source: 'MXN', destination: 'BRL', name: 'Mexico → Brazil', settlement: '5-10 minutes', via: 'USD' },
      ],
    },
  });
});

// ============================================
// Multi-Currency Routes (Story 40.17)
// ============================================

/**
 * GET /v1/quotes/multi - Get multi-currency quote
 */
quotes.get('/multi', async (c) => {
  const source = (c.req.query('source') || 'USD') as SupportedCurrency;
  const destination = (c.req.query('destination') || 'BRL') as SupportedCurrency;
  const amount = parseFloat(c.req.query('amount') || '100');
  
  const mcService = getMultiCurrencyService();
  
  if (!mcService.isCorridorSupported(source, destination)) {
    return c.json({
      error: `Corridor ${source}→${destination} is not supported`,
      supported_corridors: SUPPORTED_CORRIDORS.map(c => `${c.source}→${c.destination}`),
    }, 400);
  }
  
  try {
    const quote = await mcService.getQuote(source, destination, amount);
    return c.json({ data: quote });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * POST /v1/quotes/multi - Create multi-currency quote
 */
quotes.post('/multi', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const { source_currency, destination_currency, source_amount, destination_amount } = body;
  
  if (!source_currency || !destination_currency) {
    throw new ValidationError('source_currency and destination_currency are required');
  }
  
  if (!source_amount && !destination_amount) {
    throw new ValidationError('Either source_amount or destination_amount is required');
  }
  
  const mcService = getMultiCurrencyService();
  
  if (!mcService.isCorridorSupported(source_currency, destination_currency)) {
    return c.json({
      error: `Corridor ${source_currency}→${destination_currency} is not supported`,
      supported_corridors: SUPPORTED_CORRIDORS.map(c => `${c.source}→${c.destination}`),
    }, 400);
  }
  
  try {
    const quote = await mcService.getQuote(
      source_currency,
      destination_currency,
      source_amount || 0
    );
    
    // Store in database
    const { data: storedQuote, error } = await supabase
      .from('quotes')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        from_currency: quote.source_currency,
        to_currency: quote.destination_currency,
        from_amount: quote.source_amount,
        to_amount: quote.destination_amount,
        fx_rate: quote.route.total_rate,
        fee_amount: quote.total_fee,
        fee_breakdown: quote.route.steps.map(s => ({
          type: 'fx_step',
          from: s.from,
          to: s.to,
          rate: s.rate,
          fee_percentage: s.fee_percentage,
        })),
        corridor_id: quote.route.via 
          ? `${quote.source_currency}-${quote.route.via}-${quote.destination_currency}`
          : `${quote.source_currency}-${quote.destination_currency}`,
        expires_at: quote.expires_at,
      })
      .select()
      .single();
    
    if (error) {
      console.error('Error storing multi-currency quote:', error);
    }
    
    trackOp({
      tenantId: ctx.tenantId,
      operation: OpType.FX_QUOTE,
      subject: `quote/${storedQuote?.id || 'multi'}`,
      actorType: ctx.actorType,
      actorId: ctx.actorId || ctx.userId || ctx.apiKeyId,
      correlationId: c.get('requestId'),
      success: true,
      data: { fromCurrency: source_currency, toCurrency: destination_currency, amount: source_amount || destination_amount, multi: true },
    });

    return c.json({
      data: {
        ...quote,
        database_id: storedQuote?.id,
      },
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * GET /v1/quotes/multi/corridors - List all supported corridors
 */
quotes.get('/multi/corridors', async (c) => {
  return c.json({
    data: {
      corridors: SUPPORTED_CORRIDORS,
      direct: SUPPORTED_CORRIDORS.filter(c => c.direct),
      cross_latam: SUPPORTED_CORRIDORS.filter(c => !c.direct),
      currencies: ['USD', 'USDC', 'BRL', 'MXN', 'ARS', 'COP'],
    },
  });
});

/**
 * POST /v1/quotes/multi/simulate - Simulate a transfer
 */
quotes.post('/multi/simulate', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const { source_currency, destination_currency, amount } = body;
  
  if (!source_currency || !destination_currency || !amount) {
    throw new ValidationError('source_currency, destination_currency, and amount are required');
  }
  
  const mcService = getMultiCurrencyService();
  
  if (!mcService.isCorridorSupported(source_currency, destination_currency)) {
    return c.json({
      error: `Corridor ${source_currency}→${destination_currency} is not supported`,
    }, 400);
  }
  
  try {
    const simulation = await mcService.simulateTransfer(
      source_currency,
      destination_currency,
      amount
    );
    
    return c.json({ data: simulation });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

/**
 * POST /v1/quotes/multi/compare - Compare rates across corridors
 */
quotes.post('/multi/compare', async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const { source_currency, amount } = body;
  
  if (!source_currency || !amount) {
    throw new ValidationError('source_currency and amount are required');
  }
  
  const mcService = getMultiCurrencyService();
  const destinations = ['BRL', 'MXN', 'ARS', 'COP'].filter(
    d => d !== source_currency && mcService.isCorridorSupported(source_currency as SupportedCurrency, d as SupportedCurrency)
  );
  
  const comparisons = await Promise.all(
    destinations.map(async (dest) => {
      try {
        const simulation = await mcService.simulateTransfer(
          source_currency as SupportedCurrency,
          dest as SupportedCurrency,
          amount
        );
        return {
          destination: dest,
          ...simulation,
        };
      } catch {
        return null;
      }
    })
  );
  
  return c.json({
    data: {
      source: source_currency,
      amount,
      comparisons: comparisons.filter(Boolean),
    },
  });
});

// ============================================
// GET /v1/quotes/:id - Get quote by ID
// ============================================
quotes.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  const { data: quote, error } = await supabase
    .from('quotes')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();
  
  if (error || !quote) {
    return c.json({ error: 'Quote not found' }, 404);
  }
  
  const isExpired = new Date(quote.expires_at) < new Date();
  const isUsed = !!quote.used_at;
  
  return c.json({
    data: {
      id: quote.id,
      fromCurrency: quote.from_currency,
      toCurrency: quote.to_currency,
      fromAmount: parseFloat(quote.from_amount),
      toAmount: parseFloat(quote.to_amount),
      fxRate: parseFloat(quote.fx_rate),
      fees: {
        total: parseFloat(quote.fee_amount),
        breakdown: quote.fee_breakdown,
      },
      expiresAt: quote.expires_at,
      corridor: quote.corridor_id,
      status: isUsed ? 'used' : isExpired ? 'expired' : 'valid',
      usedAt: quote.used_at,
      transferId: quote.transfer_id,
    },
  });
});

export default quotes;
