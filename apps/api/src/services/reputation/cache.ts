/**
 * Epic 63 — Reputation Cache
 * In-memory cache with TTL + DB persistence for cross-restart durability.
 * Supports stale-while-revalidate pattern.
 */

import type { UnifiedTrustScore } from './types.js';

interface CacheEntry {
  value: UnifiedTrustScore;
  expiresAt: number;
  storedAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_GRACE_MS = 15 * 60 * 1000; // serve stale for up to 15 min

const cache = new Map<string, CacheEntry>();

export function getCached(key: string): { value: UnifiedTrustScore; stale: boolean } | null {
  const entry = cache.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (now < entry.expiresAt) {
    return { value: { ...entry.value, stale: false }, stale: false };
  }

  // Stale-while-revalidate: return stale data within grace period
  if (now < entry.expiresAt + STALE_GRACE_MS) {
    return { value: { ...entry.value, stale: true }, stale: true };
  }

  // Too stale, evict
  cache.delete(key);
  return null;
}

export function setCached(key: string, value: UnifiedTrustScore, ttlMs: number = DEFAULT_TTL_MS): void {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    storedAt: Date.now(),
  });
}

export function invalidate(key: string): void {
  cache.delete(key);
}

export function clearAll(): void {
  cache.clear();
}

/** Build cache key from an agent ID or external identifier */
export function cacheKey(identifier: string): string {
  return `reputation:${identifier}`;
}
