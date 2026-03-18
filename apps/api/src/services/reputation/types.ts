/**
 * Epic 63 — External Reputation Bridge Types
 */

export interface ReputationDimension {
  name: 'identity' | 'payment_reliability' | 'capability_trust' | 'community_signal' | 'service_quality';
  score: number;       // 0-1000
  weight: number;      // 0.0-1.0
  sources: string[];   // which sources contributed
  dataPoints: number;
}

export interface UnifiedTrustScore {
  score: number;          // 0-1000
  tier: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  confidence: 'high' | 'medium' | 'low' | 'none';
  dimensions: ReputationDimension[];
  dataPoints: number;
  lastRefreshed: string;
  stale: boolean;
}

export interface ReputationSourceResult {
  source: string;
  available: boolean;
  score: number | null;     // 0-1000 normalized
  rawData: Record<string, unknown>;
  dataPoints: number;
  queriedAt: string;
  latencyMs: number;
  dimensions?: Partial<Record<ReputationDimension['name'], number>>;
}

export interface ReputationSource {
  name: string;
  query(identifier: string): Promise<ReputationSourceResult>;
}

export type TrustTier = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

export const TIER_THRESHOLDS: { min: number; tier: TrustTier; label: string }[] = [
  { min: 900, tier: 'A', label: 'Excellent' },
  { min: 750, tier: 'B', label: 'Good' },
  { min: 600, tier: 'C', label: 'Fair' },
  { min: 400, tier: 'D', label: 'Limited' },
  { min: 200, tier: 'E', label: 'Poor' },
  { min: 0,   tier: 'F', label: 'Unrated' },
];

/** Default dimension weights (without service quality) */
export const BASE_WEIGHTS: Record<string, number> = {
  identity: 0.25,
  payment_reliability: 0.30,
  capability_trust: 0.25,
  community_signal: 0.20,
};

/** Dimension weights when service quality data is available */
export const WEIGHTS_WITH_SERVICE_QUALITY: Record<string, number> = {
  identity: 0.22,
  payment_reliability: 0.25,
  capability_trust: 0.22,
  community_signal: 0.16,
  service_quality: 0.15,
};

/** Which dimensions each source feeds into */
export const SOURCE_DIMENSION_MAP: Record<string, string[]> = {
  erc8004: ['identity', 'community_signal', 'capability_trust'],
  mnemom: ['capability_trust'],
  vouched: ['identity'],
  escrow_history: ['payment_reliability'],
  a2a_feedback: ['service_quality'],
};
