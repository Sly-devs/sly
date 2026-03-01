/**
 * Google A2A (Agent-to-Agent) Protocol Types
 *
 * Interfaces matching the A2A protocol spec v1.0 (Linux Foundation RC).
 * Enables inter-agent communication, task lifecycle, and paid-service workflows.
 *
 * @see Epic 57: Google A2A Protocol Integration
 * @see https://google.github.io/A2A/
 */

// =============================================================================
// Agent Card Types
// =============================================================================

export interface A2AAgentCard {
  id: string;
  name: string;
  description?: string;
  url: string;
  version: string;
  provider?: A2AProvider;
  capabilities: A2ACapabilities;
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
  supportedInterfaces: A2ASupportedInterface[];
  securitySchemes: Record<string, A2ASecurityScheme>;
  security: Array<Record<string, string[]>>;
  extensions?: A2AExtension[];
}

export interface A2AProvider {
  organization: string;
  url?: string;
  contactEmail?: string;
}

export interface A2ACapabilities {
  streaming: boolean;
  multiTurn: boolean;
  stateTransition: boolean;
}

export interface A2ASkill {
  id: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  inputModes?: string[];
  outputModes?: string[];
  tags?: string[];
  // Pricing (Sly extension)
  base_price?: number;
  currency?: string;
}

export interface A2ASupportedInterface {
  protocolBinding: string;
  protocolVersion: string;
  url: string;
  contentTypes?: string[];
}

export interface A2ASecurityScheme {
  type: 'apiKey' | 'http' | 'oauth2';
  scheme?: string; // 'bearer' for http type
  in?: string;     // 'header' for apiKey type
  name?: string;   // header name for apiKey type
}

export interface A2AExtension {
  uri: string;
  data?: Record<string, unknown>;
}

// =============================================================================
// Configuration Type (v1.0)
// =============================================================================

export interface A2AConfiguration {
  historyLength?: number;
  blocking?: boolean;
  acceptedOutputModes?: string[];
  // Completion webhook — notify caller when task reaches terminal state
  callbackUrl?: string;
  callbackSecret?: string;
}

// =============================================================================
// Task Types
// =============================================================================

export type A2ATaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export interface A2ATask {
  id: string;
  contextId?: string;
  status: A2ATaskStatus;
  history: A2AMessage[];
  artifacts: A2AArtifact[];
  metadata?: Record<string, unknown>;
}

export interface A2ATaskStatus {
  state: A2ATaskState;
  message?: string;
  timestamp: string;
}

// =============================================================================
// Message Types
// =============================================================================

export interface A2AMessage {
  messageId: string;
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export type A2APart =
  | A2ATextPart
  | A2ADataPart
  | A2AFilePart;

export interface A2ATextPart {
  text: string;
}

export interface A2ADataPart {
  data: Record<string, unknown>;
  metadata?: { mimeType?: string };
}

export interface A2AFilePart {
  file: { uri: string; mimeType?: string; name?: string; bytes?: string };
}

// =============================================================================
// Artifact Types
// =============================================================================

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  mediaType: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

// =============================================================================
// JSON-RPC Types
// =============================================================================

export interface A2AJsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id: string | number;
}

export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  result?: unknown;
  error?: A2AJsonRpcError;
  id: string | number | null;
}

export interface A2AJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // A2A-specific error codes
  TASK_NOT_FOUND: -32001,
  AGENT_NOT_FOUND: -32002,
  PAYMENT_REQUIRED: -32003,
  UNAUTHORIZED: -32004,
  SKILL_NOT_FOUND: -32005,
  PRICE_MISMATCH: -32006,
} as const;

// =============================================================================
// Database Row Types (snake_case, matching DB schema)
// =============================================================================

export interface A2ATaskRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  context_id: string | null;
  state: A2ATaskState;
  status_message: string | null;
  metadata: Record<string, unknown>;
  direction: 'inbound' | 'outbound';
  remote_agent_url: string | null;
  remote_task_id: string | null;
  a2a_session_id: string | null;
  mandate_id: string | null;
  transfer_id: string | null;
  client_agent_id: string | null;
  client_agent_url: string | null;
  processor_id: string | null;
  processing_started_at: string | null;
  processing_completed_at: string | null;
  processing_duration_ms: number | null;
  error_details: Record<string, unknown> | null;
  retry_count: number;
  max_retries: number;
  // Webhook delivery tracking (Story 58.5 + 58.6)
  webhook_status: WebhookDeliveryStatus | null;
  webhook_delivery_id: string | null;
  webhook_attempts: number;
  webhook_next_retry_at: string | null;
  webhook_last_response_code: number | null;
  webhook_last_response_body: string | null;
  webhook_last_response_time_ms: number | null;
  webhook_last_attempt_at: string | null;
  webhook_dlq_at: string | null;
  webhook_dlq_reason: string | null;
  // Completion webhook tracking (Story 58.16)
  callback_url: string | null;
  callback_secret: string | null;
  callback_status: string | null;
  callback_attempts: number;
  callback_last_attempt_at: string | null;
  callback_last_response_code: number | null;
  callback_next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface A2AMessageRow {
  id: string;
  tenant_id: string;
  task_id: string;
  role: 'user' | 'agent';
  parts: A2APart[];
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface A2AArtifactRow {
  id: string;
  tenant_id: string;
  task_id: string;
  label: string | null;
  mime_type: string;
  parts: A2APart[];
  metadata: Record<string, unknown>;
  created_at: string;
}

// =============================================================================
// Processing Configuration Types (Story 58.1)
// =============================================================================

export type ProcessingMode = 'managed' | 'webhook' | 'manual';

export interface ManagedConfig {
  model: string;           // e.g. "claude-sonnet-4-20250514"
  systemPrompt: string;    // Agent instructions
  tools?: string[];        // Tool names (Story 58.2 fills this)
  maxTokens?: number;      // Default: 4096, range: 512–200000
  temperature?: number;    // Default: 0.3, range: 0.0–2.0
  requireApprovalAbove?: number; // Escalate to human if payment > this amount (Story 58.6)
}

export interface WebhookConfig {
  callbackUrl: string;     // HTTPS endpoint
  callbackSecret?: string; // HMAC signing key
  timeoutMs?: number;      // Default: 30000, max: 120000
}

export type ProcessingConfig = ManagedConfig | WebhookConfig | Record<string, never>;

export interface AgentProcessingConfig {
  processingMode: ProcessingMode;
  processingConfig: ProcessingConfig;
}

// =============================================================================
// Webhook Delivery Types (Story 58.5 + 58.6)
// =============================================================================

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dlq';

export interface TaskStateUpdate {
  state: A2ATaskState;
  statusMessage?: string;
  message?: { role: 'agent'; parts: A2APart[]; metadata?: Record<string, unknown> };
  artifacts?: Array<{ name?: string; mediaType?: string; parts: A2APart[]; metadata?: Record<string, unknown> }>;
}

/**
 * Normalize parts to v1.0 format by stripping the v0.x `kind` discriminator.
 * Handles both inbound (before storage) and outbound (legacy DB rows).
 */
export function normalizeParts(parts: A2APart[]): A2APart[] {
  return parts.map((part) => {
    const { kind, ...rest } = part as any;
    return rest as A2APart;
  });
}

// =============================================================================
// Input-Required Context (structured metadata for machine-readable guidance)
// =============================================================================

export interface InputRequiredContext {
  reason_code:
    | 'manual_processing'
    | 'needs_payment'
    | 'needs_agent_auth'
    | 'insufficient_funds'
    | 'missing_wallet'
    | 'kya_required';
  next_action:
    | 'send_payment_proof'
    | 'human_respond'
    | 'authenticate_as_agent'
    | 'fund_wallet'
    | 'verify_agent'
    | 'create_wallet';
  resolve_endpoint?: string;
  required_auth?: 'api_key' | 'agent_token' | 'none';
  details?: Record<string, unknown>;
}
