/**
 * A2A SDK Client Types
 *
 * Configuration and request/response types for the SDK A2A client.
 * Protocol types (A2ATask, A2AMessage, etc.) are re-exported from @sly/types.
 */

export type {
  A2AAgentCard,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
  A2AMessage,
  A2APart,
  A2ATextPart,
  A2ADataPart,
  A2AFilePart,
  A2AArtifact,
  A2ASkill,
  A2ACapabilities,
  A2AConfiguration,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2AInputRequiredContext,
  A2ASendMessageRequest,
  A2AGetTaskRequest,
  A2AListTasksOptions,
  A2AListTasksResponse,
  A2ACustomTool,
  A2ACreateCustomToolRequest,
} from '@sly/types';
