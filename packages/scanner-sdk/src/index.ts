/**
 * @sly_ai/scanner — Official SDK for the Sly Scanner.
 *
 * Quickstart:
 * ```ts
 * import { Scanner } from '@sly_ai/scanner';
 * const scanner = new Scanner({ apiKey: process.env.SCANNER_KEY! });
 * const result = await scanner.scan({ domain: 'shopify.com' });
 * ```
 *
 * Full docs: https://docs.getsly.ai/scanner
 */

export { Scanner } from './client.js';
export type {
  ScannerOptions,
  ListScansFilter,
  ListLedgerOptions,
  ListActivityOptions,
  WaitForBatchOptions,
} from './client.js';

export type {
  ActivityDay,
  BalanceSummary,
  CreateBatchRequest,
  CreateKeyRequest,
  CreateKeyResponse,
  Environment,
  LedgerEntry,
  MerchantCategory,
  MerchantScan,
  PaginationMeta,
  Protocol,
  ProtocolDetectionStatus,
  ProtocolResult,
  Region,
  ScanBatch,
  ScanRequest,
  ScanStatus,
  ScannerKey,
} from './types.js';

export type { RetryOptions } from './http.js';

export {
  ScannerError,
  AuthenticationError,
  ForbiddenError,
  InsufficientCreditsError,
  NotFoundError,
  RateLimitError,
  ServerError,
  ValidationError,
} from './errors.js';
