/**
 * A2A protocol support (Google Agent-to-Agent Protocol)
 *
 * Provides SDK methods for:
 * - Discovering agent capabilities (Agent Cards)
 * - Sending tasks to agents (message/send)
 * - Managing task lifecycle (get, cancel, respond)
 * - Registering custom tools for agents
 */

export * from './types';
export { A2AClient } from './client';
