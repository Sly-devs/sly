/**
 * Type definitions for the Sly Scanner API.
 *
 * Shapes mirror the live API responses at https://sly-scanner.vercel.app/v1/scanner/*.
 * Kept hand-authored (rather than generated from OpenAPI) so the SDK can be
 * published as a zero-dependency package.
 */

export type Environment = 'test' | 'live';

export type Protocol =
  | 'ucp'
  | 'acp'
  | 'ap2'
  | 'x402'
  | 'mcp'
  | 'nlweb'
  | 'visa_vic'
  | 'mastercard_ap';

export type MerchantCategory =
  | 'retail'
  | 'saas'
  | 'marketplace'
  | 'restaurant'
  | 'b2b'
  | 'travel'
  | 'fintech'
  | 'healthcare'
  | 'media'
  | 'other';

export type Region =
  | 'latam'
  | 'north_america'
  | 'europe'
  | 'apac'
  | 'africa'
  | 'mena';

export type ScanStatus = 'pending' | 'scanning' | 'completed' | 'failed';
export type ProtocolDetectionStatus =
  | 'confirmed'
  | 'platform_enabled'
  | 'eligible'
  | 'not_detected'
  | 'not_applicable'
  | 'error';

export interface ScanRequest {
  domain: string;
  merchant_name?: string;
  merchant_category?: MerchantCategory;
  country_code?: string;
  region?: Region;
  /**
   * If true, returns a cached scan when one exists within the freshness window
   * (default 7 days). Useful for batch passes that don't need re-crawling.
   */
  skip_if_fresh?: boolean;
}

export interface ProtocolResult {
  protocol: Protocol;
  detected: boolean;
  status: ProtocolDetectionStatus;
  confidence: 'high' | 'medium' | 'low';
  capabilities: Record<string, unknown>;
  response_time_ms: number;
}

export interface MerchantScan {
  id: string;
  tenant_id: string;
  domain: string;
  url: string;
  merchant_name: string | null;
  merchant_category: MerchantCategory | null;
  country_code: string | null;
  region: Region | null;
  readiness_score: number | null;
  protocol_score: number | null;
  data_score: number | null;
  accessibility_score: number | null;
  checkout_score: number | null;
  scan_status: ScanStatus;
  scan_duration_ms: number | null;
  scan_version: string | null;
  business_model: string | null;
  last_scanned_at: string | null;
  request_id: string | null;
  protocol_results?: ProtocolResult[];
  error_message?: string | null;
}

export interface BalanceSummary {
  balance: number;
  grantedTotal: number;
  consumedTotal: number;
}

export interface LedgerEntry {
  id: string;
  delta: number;
  reason: 'consume' | 'grant' | 'refund' | 'adjustment';
  source: string | null;
  balance_after: number;
  metadata: Record<string, unknown>;
  created_at: string;
  /** Present when the consume row links to a scan and ?expand=scan was requested. */
  scan?: {
    id: string;
    domain: string;
    readiness_score: number | null;
    scan_status: string;
  };
}

export interface ActivityDay {
  day: string; // YYYY-MM-DD
  scans: number;
  credits: number;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ScannerKey {
  id: string;
  name: string;
  key_prefix: string;
  environment: Environment;
  scopes: Array<'scan' | 'batch' | 'read' | 'tests' | 'mcp'>;
  rate_limit_per_min: number;
  created_at: string;
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
}

export interface CreateKeyRequest {
  name: string;
  environment?: Environment;
  scopes?: Array<'scan' | 'batch' | 'read' | 'tests' | 'mcp'>;
  rate_limit_per_min?: number;
}

export interface CreateKeyResponse extends ScannerKey {
  /** Plaintext API key — shown once, never again. Persist immediately. */
  key: string;
}

export interface ScanBatch {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  total_targets: number;
  completed_targets: number;
  failed_targets: number;
  status: 'queued' | 'processing' | 'completed' | 'cancelled' | 'failed';
  created_at: string;
  completed_at: string | null;
}

export interface CreateBatchRequest {
  domains: Array<{ domain: string; merchant_name?: string }>;
  name?: string;
  description?: string;
}
