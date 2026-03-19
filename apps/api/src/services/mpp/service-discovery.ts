/**
 * MPP Service Discovery
 *
 * Browse the MPP directory and probe service pricing.
 * The MPP directory (machinepayments.com/directory) lists 100+ services.
 *
 * @see Story 71.15: Service Discovery API
 */

import type { MppServiceInfo, MppPaymentMethod } from './types.js';

// ============================================
// Constants
// ============================================

const MPP_DIRECTORY_URL = 'https://machinepayments.com/directory';
const PROBE_TIMEOUT = 10000;

// ============================================
// Service Discovery
// ============================================

export class MppServiceDiscovery {
  private cache = new Map<string, { info: MppServiceInfo; expiresAt: number }>();
  private readonly cacheTtlMs = 300000; // 5 minutes

  /**
   * Browse the MPP directory for available services.
   * Returns cached results when available.
   */
  async browseDirectory(options?: {
    category?: string;
    limit?: number;
    offset?: number;
  }): Promise<MppServiceInfo[]> {
    try {
      const response = await fetch(`${MPP_DIRECTORY_URL}/api/services`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });

      if (!response.ok) {
        console.warn(`[MPP Discovery] Directory returned ${response.status}`);
        return [];
      }

      const data = await response.json() as any;
      const services = Array.isArray(data) ? data : data.services || [];

      return services
        .slice(options?.offset || 0, (options?.offset || 0) + (options?.limit || 50))
        .map((s: any) => ({
          domain: s.domain || s.url,
          name: s.name,
          description: s.description,
          paymentMethods: s.methods || s.payment_methods || ['tempo'],
          lastChecked: new Date().toISOString(),
        }));
    } catch (error) {
      console.warn('[MPP Discovery] Failed to browse directory:', error);
      return [];
    }
  }

  /**
   * Probe a specific service for MPP pricing info.
   * Sends an unauthenticated request and inspects the 402 response.
   */
  async probePricing(serviceUrl: string): Promise<MppServiceInfo | null> {
    // Check cache
    const cached = this.cache.get(serviceUrl);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.info;
    }

    try {
      const response = await fetch(serviceUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT),
      });

      const hostname = new URL(serviceUrl).hostname;

      // If 402, parse the payment requirements
      if (response.status === 402) {
        const body = await response.json() as any;

        const info: MppServiceInfo = {
          domain: hostname,
          name: body.name || hostname,
          description: body.description,
          pricing: body.routes ? { routes: body.routes } : undefined,
          paymentMethods: (body.methods || body.accepts
            ? Object.keys(body.accepts || {})
            : ['tempo']) as MppPaymentMethod[],
          lastChecked: new Date().toISOString(),
        };

        // Cache the result
        this.cache.set(serviceUrl, {
          info,
          expiresAt: Date.now() + this.cacheTtlMs,
        });

        return info;
      }

      // Non-402 response — service may not support MPP
      return {
        domain: hostname,
        paymentMethods: [],
        lastChecked: new Date().toISOString(),
      };
    } catch (error) {
      console.warn(`[MPP Discovery] Failed to probe ${serviceUrl}:`, error);
      return null;
    }
  }
}
