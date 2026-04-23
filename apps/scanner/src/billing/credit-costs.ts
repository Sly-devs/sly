/**
 * Credit cost per scanner operation.
 * Reads are free (shared corpus). Writes cost credits.
 *
 * Keys are "METHOD path_template". Path templates must match what
 * services/usage.ts#normalizePath produces (UUIDs -> :id, numeric -> /:id).
 */
export const CREDIT_COSTS: Record<string, number> = {
  'POST /v1/scanner/scan': 1,
  // Batch cost is computed at enqueue time: domains.length * PER_BATCH_TARGET.
  'POST /v1/scanner/scan/batch': 0,
  'POST /v1/scanner/tests': 5,

  // Reads — free.
  'GET /v1/scanner/scan/:id': 0,
  'GET /v1/scanner/scans': 0,
  'GET /v1/scanner/scans/by-domain/:id': 0,
  'GET /v1/scanner/scans/stats': 0,
  'GET /v1/scanner/scans/protocol-adoption': 0,
  'GET /v1/scanner/scan/batch/:id': 0,
  'GET /v1/scanner/tests/:id': 0,
  'GET /v1/scanner/prospects': 0,
  'GET /v1/scanner/prospects/heat-map': 0,
  'GET /v1/scanner/prospects/export': 0,
  'GET /v1/scanner/observatory': 0,
  'GET /v1/scanner/reports/:id': 0,
  'GET /v1/scanner/traffic-monitor/:id': 0,
  'GET /v1/scanner/credits/balance': 0,
  'GET /v1/scanner/credits/ledger': 0,
  'GET /v1/scanner/usage': 0,
};

export const PER_BATCH_TARGET = 0.5;

export const MCP_CREDIT_COSTS: Record<string, number> = {
  scan_merchant: 1,
  batch_scan: 0, // computed from domain count
  run_agent_shopping_test: 5,
  // all other tools are reads — 0
};

/**
 * Look up credit cost for an HTTP request. Returns 0 if unknown
 * (unknown routes should be rare — usage-counter still records them).
 */
export function getCreditCost(method: string, pathTemplate: string): number {
  const key = `${method} ${pathTemplate}`;
  return CREDIT_COSTS[key] ?? 0;
}

/**
 * Batch cost: N targets * PER_BATCH_TARGET, rounded up to the nearest credit.
 */
export function computeBatchCost(targetCount: number): number {
  return Math.ceil(targetCount * PER_BATCH_TARGET);
}
