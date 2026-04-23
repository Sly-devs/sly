import { describe, it, expect } from 'vitest';
import {
  CREDIT_COSTS,
  MCP_CREDIT_COSTS,
  getCreditCost,
  computeBatchCost,
  PER_BATCH_TARGET,
} from '../../src/billing/credit-costs.js';
import { normalizePath } from '../../src/services/usage.js';

describe('credit costs', () => {
  it('writes cost credits, reads are free', () => {
    expect(getCreditCost('POST', '/v1/scanner/scan')).toBe(1);
    expect(getCreditCost('POST', '/v1/scanner/tests')).toBe(5);
    expect(getCreditCost('GET', '/v1/scanner/scans')).toBe(0);
    expect(getCreditCost('GET', '/v1/scanner/prospects')).toBe(0);
    expect(getCreditCost('GET', '/v1/scanner/credits/balance')).toBe(0);
  });

  it('unknown endpoints default to 0 (usage still recorded)', () => {
    expect(getCreditCost('GET', '/v1/scanner/unknown')).toBe(0);
  });

  it('batch cost is domains × 0.5, rounded up', () => {
    expect(computeBatchCost(1)).toBe(1);
    expect(computeBatchCost(2)).toBe(1);
    expect(computeBatchCost(3)).toBe(2);
    expect(computeBatchCost(10)).toBe(5);
    expect(computeBatchCost(500)).toBe(250);
    expect(PER_BATCH_TARGET).toBe(0.5);
  });

  it('MCP tool costs match REST for equivalent operations', () => {
    expect(MCP_CREDIT_COSTS['scan_merchant']).toBe(CREDIT_COSTS['POST /v1/scanner/scan']);
    expect(MCP_CREDIT_COSTS['run_agent_shopping_test']).toBe(CREDIT_COSTS['POST /v1/scanner/tests']);
  });
});

describe('path normalization', () => {
  it('replaces UUIDs with :id', () => {
    const uuid = 'c5e4f1b0-1234-5678-9abc-def012345678';
    expect(normalizePath(`/v1/scanner/scan/${uuid}`)).toBe('/v1/scanner/scan/:id');
  });

  it('replaces numeric IDs with /:id', () => {
    expect(normalizePath('/v1/scanner/scan/batch/123')).toBe('/v1/scanner/scan/batch/:id');
    expect(normalizePath('/v1/scanner/scan/batch/42/progress')).toBe(
      '/v1/scanner/scan/batch/:id/progress',
    );
  });

  it('leaves static paths alone', () => {
    expect(normalizePath('/v1/scanner/scans/stats')).toBe('/v1/scanner/scans/stats');
    expect(normalizePath('/v1/scanner/prospects/heat-map')).toBe('/v1/scanner/prospects/heat-map');
  });

  it('handles domain in path', () => {
    expect(normalizePath('/v1/scanner/scans/by-domain/shopify.com')).toBe(
      '/v1/scanner/scans/by-domain/shopify.com',
    );
  });
});
