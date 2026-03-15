import type { SupabaseClient } from '@supabase/supabase-js';
import type { Account, Agent, Transfer, Stream } from '@sly/types';

// ============================================
// DATABASE ROW MAPPERS
// ============================================

export function mapAccountFromDb(row: any): Account {
  const currency = row.currency || 'USDC';
  
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    name: row.name,
    email: row.email || undefined,
    country: row.country || undefined,
    currency: currency,
    // Flat verification fields for client compatibility
    verificationTier: row.verification_tier || 0,
    verificationStatus: row.verification_status || 'unverified',
    verificationType: row.verification_type || (row.type === 'person' ? 'kyc' : 'kyb'),
    // Flat balance fields for client compatibility
    balanceTotal: parseFloat(row.balance_total) || 0,
    balanceAvailable: parseFloat(row.balance_available) || 0,
    balanceInStreams: parseFloat(row.balance_in_streams) || 0,
    balanceBuffer: parseFloat(row.balance_buffer) || 0,
    // Also include nested structure for backward compatibility
    verification: {
      tier: row.verification_tier || 0,
      status: row.verification_status || 'unverified',
      type: row.verification_type || (row.type === 'person' ? 'kyc' : 'kyb'),
    },
    balance: {
      total: parseFloat(row.balance_total) || 0,
      available: parseFloat(row.balance_available) || 0,
      inStreams: {
        total: parseFloat(row.balance_in_streams) || 0,
        buffer: parseFloat(row.balance_buffer) || 0,
        streaming: (parseFloat(row.balance_in_streams) || 0) - (parseFloat(row.balance_buffer) || 0),
      },
      currency: currency,
    },
    agents: {
      count: row.agents_count || 0,
      active: row.agents_active || 0,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapAgentFromDb(row: any): Agent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description || '',
    status: row.status,
    type: row.type || 'custom',
    // Flat fields for client compatibility
    kyaTier: row.kya_tier || 0,
    kyaStatus: row.kya_status || 'unverified',
    parentAccountId: row.parent_account_id,
    // Nested structure for backward compatibility
    parentAccount: {
      id: row.parent_account_id,
      type: row.parent_account_type || 'business',
      name: row.parent_account_name || '',
      verificationTier: row.parent_verification_tier || 0,
    },
    kya: {
      tier: row.kya_tier || 0,
      status: row.kya_status || 'unverified',
      verifiedAt: row.kya_verified_at || undefined,
      agentLimits: {
        perTransaction: parseFloat(row.limit_per_transaction) || 0,
        daily: parseFloat(row.limit_daily) || 0,
        monthly: parseFloat(row.limit_monthly) || 0,
      },
      effectiveLimits: {
        perTransaction: parseFloat(row.effective_limit_per_tx) || 0,
        daily: parseFloat(row.effective_limit_daily) || 0,
        monthly: parseFloat(row.effective_limit_monthly) || 0,
        cappedByParent: row.effective_limits_capped || false,
      },
    },
    permissions: row.permissions || {
      transactions: { initiate: true, approve: false, view: true },
      streams: { initiate: true, modify: true, pause: true, terminate: true, view: true },
      accounts: { view: true, create: false },
      treasury: { view: false, rebalance: false },
    },
    streamStats: {
      activeStreams: row.active_streams_count || 0,
      totalOutflow: parseFloat(row.total_stream_outflow) || 0,
      maxActiveStreams: row.max_active_streams || 5,
      maxTotalOutflow: parseFloat(row.max_total_outflow) || 50000,
    },
    auth: {
      type: row.auth_type || 'api_key',
      clientId: row.auth_client_id || undefined,
    },
    // Flat fields for UI compatibility
    limit_per_transaction: parseFloat(row.limit_per_transaction) || 0,
    limit_daily: parseFloat(row.limit_daily) || 0,
    limit_monthly: parseFloat(row.limit_monthly) || 0,
    effective_limit_per_tx: parseFloat(row.effective_limit_per_tx) || 0,
    effective_limit_daily: parseFloat(row.effective_limit_daily) || 0,
    effective_limit_monthly: parseFloat(row.effective_limit_monthly) || 0,
    effective_limits_capped: row.effective_limits_capped || false,
    max_active_streams: row.max_active_streams || 5,
    max_flow_rate_per_stream: parseFloat(row.max_flow_rate_per_stream) || 0,
    max_total_outflow: parseFloat(row.max_total_outflow) || 50000,
    active_streams_count: row.active_streams_count || 0,
    total_stream_outflow: parseFloat(row.total_stream_outflow) || 0,
    kya_tier: row.kya_tier || 0,
    kya_status: row.kya_status || 'unverified',
    kya_verified_at: row.kya_verified_at || null,
    auth_token_prefix: row.auth_token_prefix || null,
    x402_enabled: row.x402_enabled !== null ? row.x402_enabled : true,
    ap2_enabled: row.ap2_enabled !== null ? row.ap2_enabled : false,
    acp_enabled: row.acp_enabled !== null ? row.acp_enabled : false,
    ucp_enabled: row.ucp_enabled !== null ? row.ucp_enabled : false,
    processing_mode: row.processing_mode || 'managed',
    processing_config: row.processing_config || {},
    processingMode: row.processing_mode || 'managed',
    processingConfig: row.processing_config || {},
    total_volume: parseFloat(row.total_volume) || 0,
    total_transactions: row.total_transactions || 0,
    tenant_id: row.tenant_id,
    parent_account_id: row.parent_account_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTransferFromDb(row: any): Transfer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    type: row.type,
    status: row.status,
    from: {
      accountId: row.from_account_id,
      accountName: row.from_account_name || '',
    },
    to: {
      accountId: row.to_account_id,
      accountName: row.to_account_name || '',
    },
    initiatedBy: {
      type: row.initiated_by_type,
      id: row.initiated_by_id,
      name: row.initiated_by_name || '',
    },
    description: row.description || undefined,
    amount: parseFloat(row.amount),
    currency: row.currency || 'USDC',
    destinationAmount: row.destination_amount ? parseFloat(row.destination_amount) : undefined,
    destinationCurrency: row.destination_currency || undefined,
    fxRate: row.fx_rate ? parseFloat(row.fx_rate) : undefined,
    streamId: row.stream_id || undefined,
    fees: parseFloat(row.fee_amount) || 0,
    idempotencyKey: row.idempotency_key || undefined,
    protocolMetadata: row.protocol_metadata || undefined, // Protocol-specific metadata (x402, AP2, ACP)
    x402Metadata: row.protocol_metadata || row.x402_metadata || undefined, // @deprecated - for backward compatibility
    createdAt: row.created_at,
    completedAt: row.completed_at || undefined,
    failedAt: row.failed_at || undefined,
    failureReason: row.failure_reason || undefined,
  };
}

export function mapStreamFromDb(row: any): Stream {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    sender: {
      accountId: row.sender_account_id,
      accountName: row.sender_account_name,
    },
    receiver: {
      accountId: row.receiver_account_id,
      accountName: row.receiver_account_name,
    },
    initiatedBy: {
      type: row.initiated_by_type,
      id: row.initiated_by_id,
      name: row.initiated_by_name || '',
      timestamp: row.initiated_at || row.created_at,
    },
    managedBy: {
      type: row.managed_by_type,
      id: row.managed_by_id,
      name: row.managed_by_name || '',
      permissions: {
        canModify: row.managed_by_can_modify ?? true,
        canPause: row.managed_by_can_pause ?? true,
        canTerminate: row.managed_by_can_terminate ?? true,
      },
    },
    flowRate: {
      perSecond: parseFloat(row.flow_rate_per_second),
      perMonth: parseFloat(row.flow_rate_per_month),
      currency: row.currency || 'USDC',
    },
    streamed: {
      total: parseFloat(row.total_streamed) || 0,
      withdrawn: parseFloat(row.total_withdrawn) || 0,
      available: (parseFloat(row.total_streamed) || 0) - (parseFloat(row.total_withdrawn) || 0),
    },
    funding: {
      wrapped: parseFloat(row.funded_amount) || 0,
      buffer: parseFloat(row.buffer_amount) || 0,
      runway: {
        seconds: row.runway_seconds || 0,
        display: formatRunway(row.runway_seconds || 0),
      },
    },
    health: row.health || 'healthy',
    description: row.description || '',
    category: row.category || 'other',
    startedAt: row.started_at,
    pausedAt: row.paused_at || undefined,
    cancelledAt: row.cancelled_at || undefined,
    onChain: row.onchain_network ? {
      network: row.onchain_network,
      flowId: row.onchain_flow_id,
      txHash: row.onchain_tx_hash,
    } : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatRunway(seconds: number): string {
  if (seconds <= 0) return 'Depleted';
  const days = Math.floor(seconds / (24 * 60 * 60));
  const hours = Math.floor((seconds % (24 * 60 * 60)) / (60 * 60));
  if (days > 0) return days === 1 ? '1 day' : `${days} days`;
  if (hours > 0) return hours === 1 ? '1 hour' : `${hours} hours`;
  const minutes = Math.floor(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

// ============================================
// AUDIT LOGGING
// ============================================

export interface AuditLogEntry {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  actorName: string;
  changes?: Record<string, any>;
  metadata?: Record<string, any>;
}

export async function logAudit(
  supabase: SupabaseClient,
  entry: AuditLogEntry
): Promise<void> {
  try {
    await supabase.from('audit_log').insert({
      tenant_id: entry.tenantId,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      action: entry.action,
      actor_type: entry.actorType,
      actor_id: entry.actorId,
      actor_name: entry.actorName,
      changes: entry.changes,
      metadata: entry.metadata,
    });
  } catch (error) {
    // Don't fail the request if audit logging fails
    console.error('Failed to log audit entry:', error);
  }
}

// ============================================
// VALIDATION HELPERS
// ============================================

export function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Sanitize a string for safe use in PostgREST `.or()` / `.ilike()` filters.
 * Escapes characters that could break out of the filter expression:
 * commas (filter separator), parens (grouping), backslashes (escape char),
 * and percent/underscore (SQL LIKE wildcards — we add our own %).
 */
export function sanitizeSearchInput(input: string): string {
  return input
    .replace(/\\/g, '\\\\')  // escape backslashes first
    .replace(/%/g, '\\%')    // escape existing % (we add our own)
    .replace(/_/g, '\\_')    // escape _ (SQL single-char wildcard)
    .replace(/,/g, '')       // remove commas (PostgREST filter separator)
    .replace(/[()]/g, '')    // remove parens (PostgREST grouping)
    .replace(/\./g, '')      // remove dots (PostgREST operator separator)
    .slice(0, 200);          // length limit
}

// ============================================
// PAGINATION HELPERS
// ============================================

export interface PaginationParams {
  page: number;
  limit: number;
}

export function getPaginationParams(query: Record<string, string>): PaginationParams {
  const page = Math.max(1, parseInt(query.page || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20')));
  return { page, limit };
}

export function paginationResponse<T>(
  data: T[],
  total: number,
  pagination: PaginationParams
) {
  return {
    data,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.ceil(total / pagination.limit),
    },
  };
}

// ============================================
// FIELD ALIASING (Story 51.1)
// ============================================

/**
 * Field alias mappings for backward compatibility
 * oldName -> newName
 */
export const FIELD_ALIASES: Record<string, string> = {
  ownerAccountId: 'accountId',
  parentAccountId: 'accountId',
  sourceAccountId: 'fromAccountId',
};

/**
 * Result of normalizing fields - includes list of deprecated fields used
 */
export interface NormalizedFields<T> {
  data: T;
  deprecatedFieldsUsed: string[];
}

/**
 * Normalize request body by replacing deprecated field names with new ones
 * Returns the normalized data plus a list of deprecated fields that were used
 */
export function normalizeFields<T extends Record<string, any>>(
  body: T,
  aliases: Record<string, string> = FIELD_ALIASES
): NormalizedFields<T> {
  const deprecatedFieldsUsed: string[] = [];
  const normalized = { ...body };

  for (const [oldName, newName] of Object.entries(aliases)) {
    if (oldName in normalized && !(newName in normalized)) {
      // Old field present, new field not - copy value
      normalized[newName as keyof T] = normalized[oldName as keyof T];
      delete normalized[oldName as keyof T];
      deprecatedFieldsUsed.push(oldName);
    } else if (oldName in normalized && newName in normalized) {
      // Both present - prefer new name, remove old
      delete normalized[oldName as keyof T];
      deprecatedFieldsUsed.push(oldName);
    }
  }

  return { data: normalized as T, deprecatedFieldsUsed };
}

/**
 * Build deprecation warning header value
 */
export function buildDeprecationHeader(deprecatedFields: string[]): string | null {
  if (deprecatedFields.length === 0) return null;

  const warnings = deprecatedFields.map((field) => {
    const newField = FIELD_ALIASES[field] || field;
    return `"${field}" is deprecated, use "${newField}" instead`;
  });

  return warnings.join('; ');
}

