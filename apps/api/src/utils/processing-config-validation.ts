/**
 * Shared validation for agent processing_mode + processing_config.
 * Used by both routes/agents.ts (REST API) and routes/a2a.ts (A2A config endpoint).
 */

export const VALID_PROCESSING_MODES = ['managed', 'webhook', 'manual'] as const;
export type ProcessingMode = (typeof VALID_PROCESSING_MODES)[number];

export interface ProcessingConfigValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate processing_config against the given processing_mode.
 *
 * - `managed` → requires `model` (string) + `systemPrompt` (string, ≤10k chars)
 * - `webhook`  → requires `callbackUrl` (HTTPS or localhost)
 * - `manual`   → config must be empty
 */
export function validateProcessingConfig(
  mode: string,
  config: Record<string, unknown>,
): ProcessingConfigValidationResult {
  if (!VALID_PROCESSING_MODES.includes(mode as ProcessingMode)) {
    return { valid: false, error: 'processing_mode must be one of: managed, webhook, manual' };
  }

  if (mode === 'managed') {
    if (!config.model || typeof config.model !== 'string' || (config.model as string).trim() === '') {
      return { valid: false, error: 'managed mode requires a non-empty model string' };
    }
    if (!config.systemPrompt || typeof config.systemPrompt !== 'string' || (config.systemPrompt as string).trim() === '') {
      return { valid: false, error: 'managed mode requires a non-empty systemPrompt' };
    }
    if ((config.systemPrompt as string).length > 10000) {
      return { valid: false, error: 'systemPrompt must be 10000 characters or less' };
    }
    if (config.maxTokens !== undefined) {
      const maxTokens = Number(config.maxTokens);
      if (isNaN(maxTokens) || maxTokens < 512 || maxTokens > 200000) {
        return { valid: false, error: 'maxTokens must be between 512 and 200000' };
      }
    }
    if (config.temperature !== undefined) {
      const temp = Number(config.temperature);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        return { valid: false, error: 'temperature must be between 0 and 2' };
      }
    }
  } else if (mode === 'webhook') {
    if (!config.callbackUrl || typeof config.callbackUrl !== 'string') {
      return { valid: false, error: 'webhook mode requires a callbackUrl' };
    }
    try {
      const url = new URL(config.callbackUrl as string);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        return { valid: false, error: 'callbackUrl must use HTTPS (or localhost for development)' };
      }
    } catch {
      return { valid: false, error: 'callbackUrl must be a valid URL' };
    }
    if (config.timeoutMs !== undefined) {
      const timeout = Number(config.timeoutMs);
      if (isNaN(timeout) || timeout < 1000 || timeout > 120000) {
        return { valid: false, error: 'timeoutMs must be between 1000 and 120000' };
      }
    }
  } else if (mode === 'manual') {
    const keys = Object.keys(config);
    if (keys.length > 0) {
      return { valid: false, error: 'manual mode does not accept processing config' };
    }
  }

  return { valid: true };
}
