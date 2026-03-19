import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Non-ISO currency symbols (stablecoins, crypto, supertokens)
const CRYPTO_SYMBOLS: Record<string, string> = {
  // Stablecoins
  'USDC': '$',
  'USDT': '$',
  'DAI': '$',
  'BUSD': '$',
  'pathUSD': '$',
  // Supertokens (Superfluid wrapped tokens)
  'USDCx': '$',
  'fUSDCx': '$', // Fake USDC on testnet
  'fDAIx': '$',
  // Crypto
  'ETH': 'Ξ',
  'MATIC': 'MATIC ',
  'BTC': '₿',
};

// ISO 4217 fiat currency codes we support
const FIAT_CURRENCIES = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CHF', 'CAD', 'AUD',
  'MXN', 'BRL', 'ARS', 'COP', 'PEN', 'CLP', // LATAM
  'INR', 'KRW', 'SGD', 'HKD', 'TWD', 'THB', // Asia
]);

/**
 * Format a number as currency
 * Supports both fiat (ISO 4217) and crypto/stablecoins
 * Always shows at least 2 decimal places (more for streams/stablecoin if needed)
 */
export function formatCurrency(
  amount: number,
  currency: string = 'USD',
  options?: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    showSymbol?: boolean;
    locale?: string;
  }
): string {
  const minDecimals = options?.minimumFractionDigits ?? 2;
  const showSymbol = options?.showSymbol ?? true;
  const locale = options?.locale ?? 'en-US';
  
  // Check if it's a crypto/stablecoin
  const isCrypto = currency in CRYPTO_SYMBOLS;
  const isFiat = FIAT_CURRENCIES.has(currency);
  
  if (isFiat) {
    // Use Intl.NumberFormat for fiat currencies
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: options?.maximumFractionDigits ?? 2,
    }).format(amount);
  }
  
  if (isCrypto) {
    // Format crypto with custom symbol
    const symbol = showSymbol ? CRYPTO_SYMBOLS[currency] : '';
    const maxDecimals = options?.maximumFractionDigits ?? 6; // More precision for crypto
    
    const formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: minDecimals,
      maximumFractionDigits: maxDecimals,
    }).format(amount);
    
    // For dollar-based stablecoins, format like USD ($1,234.56 USDC)
    if (symbol === '$') {
      return `${symbol}${formatted} ${currency}`;
    }
    
    // For other crypto, symbol comes before
    return `${symbol}${formatted}`;
  }
  
  // Unknown currency - just format as number with currency code
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amount);
  
  return showSymbol ? `${formatted} ${currency}` : formatted;
}

/**
 * Format amount with just the number (no currency symbol)
 */
export function formatAmount(
  amount: number,
  options?: {
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    locale?: string;
  }
): string {
  return new Intl.NumberFormat(options?.locale ?? 'en-US', {
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  }).format(amount);
}

/**
 * Format a number compactly (e.g., 1.2K, 3.4M)
 */
export function formatCompact(value: number): string {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Format a date
 */
export function formatDate(
  date: string | Date,
  options?: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(date));
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(date: string | Date): string {
  const now = new Date();
  const then = new Date(date);
  const seconds = Math.floor((now.getTime() - then.getTime()) / 1000);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
    { label: 'second', seconds: 1 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
    }
  }

  return 'just now';
}

/**
 * Format stream runway
 */
export function formatRunway(seconds: number): string {
  if (seconds <= 0) return 'Depleted';
  
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  
  if (days > 30) return `${Math.floor(days / 30)} months`;
  if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
  
  return 'Less than 1 hour';
}

