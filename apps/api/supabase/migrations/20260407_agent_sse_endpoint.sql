-- Add 'sse' to agent endpoint_type for real-time task streaming.
-- Agents can now choose their delivery mechanism:
--   webhook: Sly POSTs task to agent's URL (existing, production-ready)
--   a2a: Sly forwards via JSON-RPC message/send (existing)
--   sse: Agent connects to GET /v1/a2a/agents/:id/tasks/stream (new)
--   x402: HTTP 402 challenge/payment flow (existing)
--   none: No endpoint (manual mode)

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_endpoint_type_check;
ALTER TABLE agents ADD CONSTRAINT agents_endpoint_type_check
  CHECK (endpoint_type IN ('none', 'webhook', 'a2a', 'x402', 'sse'));
