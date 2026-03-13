/**
 * A2A (Agent-to-Agent) Protocol Types — SDK-facing
 *
 * Consumer-facing types for the Google A2A protocol integration.
 * These are the types SDK users need to interact with A2A endpoints.
 *
 * @see Epic 57: Google A2A Protocol Integration
 * @see Epic 58: A2A Task Processor Worker
 */

// =============================================================================
// Agent Card Types (v1.0 spec)
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
  /** Sly extension: price per invocation (0 = free) */
  base_price?: number;
  /** Sly extension: pricing currency */
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
  scheme?: string;
  in?: string;
  name?: string;
}

export interface A2AExtension {
  uri: string;
  data?: Record<string, unknown>;
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

export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

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
// Configuration Type (v1.0)
// =============================================================================

export interface A2AConfiguration {
  historyLength?: number;
  blocking?: boolean;
  acceptedOutputModes?: string[];
  callbackUrl?: string;
  callbackSecret?: string;
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

// =============================================================================
// Input-Required Context (machine-readable guidance for callers)
// =============================================================================

export interface A2AInputRequiredContext {
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

// =============================================================================
// SDK Request/Response Types
// =============================================================================

export interface A2ASendMessageRequest {
  agentId: string;
  message: string | A2APart[];
  contextId?: string;
  configuration?: A2AConfiguration;
  metadata?: Record<string, unknown>;
  skillId?: string;
}

export interface A2AGetTaskRequest {
  agentId: string;
  taskId: string;
  historyLength?: number;
}

export interface A2AListTasksOptions {
  agentId?: string;
  state?: A2ATaskState;
  direction?: 'inbound' | 'outbound';
  contextId?: string;
  page?: number;
  limit?: number;
}

export interface A2AListTasksResponse {
  data: Array<{
    id: string;
    agentId: string;
    agentName?: string;
    contextId?: string;
    state: A2ATaskState;
    statusMessage?: string;
    direction: string;
    transferId?: string;
    transferAmount?: number;
    transferCurrency?: string;
    mandateId?: string;
    messageCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// =============================================================================
// Custom Tool Types (Story 58.15)
// =============================================================================

export interface A2ACustomTool {
  id: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handlerType: 'webhook' | 'http' | 'noop';
  handlerUrl?: string;
  handlerMethod?: string;
  handlerTimeoutMs?: number;
  status: 'active' | 'inactive' | 'deprecated';
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface A2ACreateCustomToolRequest {
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handlerType?: 'webhook' | 'http' | 'noop';
  handlerUrl?: string;
  handlerSecret?: string;
  handlerMethod?: string;
  handlerTimeoutMs?: number;
}
