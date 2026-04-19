-- Phase 3: Add environment column to remaining tenant-scoped transactional tables
-- Phase 1: accounts, agents, transfers, streams
-- Phase 2: ap2_mandates, ap2_mandate_executions, acp_checkouts, ucp_checkout_sessions, x402_endpoints, mpp_sessions
-- Phase 3: everything below

-- ============================================
-- HIGH PRIORITY — Core transactional tables
-- ============================================

-- Wallets
ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_wallets_tenant_env
  ON wallets (tenant_id, environment);

-- Ledger Entries
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_ledger_entries_tenant_env
  ON ledger_entries (tenant_id, environment);

-- Quotes
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_quotes_tenant_env
  ON quotes (tenant_id, environment);

-- Disputes
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_disputes_tenant_env
  ON disputes (tenant_id, environment);

-- Refunds
ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_refunds_tenant_env
  ON refunds (tenant_id, environment);

-- Card Transactions
ALTER TABLE card_transactions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_card_transactions_tenant_env
  ON card_transactions (tenant_id, environment);

-- Payment Methods
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_payment_methods_tenant_env
  ON payment_methods (tenant_id, environment);

-- Settlement Records
ALTER TABLE settlement_records
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_settlement_records_tenant_env
  ON settlement_records (tenant_id, environment);

-- Settlements
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_settlements_tenant_env
  ON settlements (tenant_id, environment);

-- Transfer Schedules
ALTER TABLE transfer_schedules
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_transfer_schedules_tenant_env
  ON transfer_schedules (tenant_id, environment);

-- Transfer Batches
ALTER TABLE transfer_batches
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_transfer_batches_tenant_env
  ON transfer_batches (tenant_id, environment);

-- Transfer Batch Items
ALTER TABLE transfer_batch_items
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_transfer_batch_items_tenant_env
  ON transfer_batch_items (tenant_id, environment);

-- UCP Orders
ALTER TABLE ucp_orders
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_ucp_orders_tenant_env
  ON ucp_orders (tenant_id, environment);

-- UCP Settlements
ALTER TABLE ucp_settlements
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_ucp_settlements_tenant_env
  ON ucp_settlements (tenant_id, environment);

-- Webhook Events (no tenant_id — index on environment only)
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_webhook_events_env
  ON webhook_events (environment);

-- Webhook Deliveries
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_env
  ON webhook_deliveries (tenant_id, environment);

-- ============================================
-- MEDIUM PRIORITY — Supporting data tables
-- ============================================

-- A2A Tasks
ALTER TABLE a2a_tasks
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_tenant_env
  ON a2a_tasks (tenant_id, environment);

-- A2A Messages
ALTER TABLE a2a_messages
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_a2a_messages_tenant_env
  ON a2a_messages (tenant_id, environment);

-- A2A Artifacts
ALTER TABLE a2a_artifacts
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_tenant_env
  ON a2a_artifacts (tenant_id, environment);

-- A2A Audit Events
ALTER TABLE a2a_audit_events
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_a2a_audit_events_tenant_env
  ON a2a_audit_events (tenant_id, environment);

-- A2A Task Feedback
ALTER TABLE a2a_task_feedback
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_a2a_task_feedback_tenant_env
  ON a2a_task_feedback (tenant_id, environment);

-- Agent Payment Approvals
ALTER TABLE agent_payment_approvals
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_agent_payment_approvals_tenant_env
  ON agent_payment_approvals (tenant_id, environment);

-- Payment Intents
ALTER TABLE payment_intents
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_payment_intents_tenant_env
  ON payment_intents (tenant_id, environment);

-- Handler Payments
ALTER TABLE handler_payments
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_handler_payments_tenant_env
  ON handler_payments (tenant_id, environment);

-- Treasury Accounts
ALTER TABLE treasury_accounts
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_treasury_accounts_tenant_env
  ON treasury_accounts (tenant_id, environment);

-- Treasury Transactions
ALTER TABLE treasury_transactions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_treasury_transactions_tenant_env
  ON treasury_transactions (tenant_id, environment);

-- Workflow Instances
ALTER TABLE workflow_instances
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_workflow_instances_tenant_env
  ON workflow_instances (tenant_id, environment);

-- Workflow Step Executions
ALTER TABLE workflow_step_executions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_workflow_step_executions_tenant_env
  ON workflow_step_executions (tenant_id, environment);

-- Simulations
ALTER TABLE simulations
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_simulations_tenant_env
  ON simulations (tenant_id, environment);

-- Funding Sources
ALTER TABLE funding_sources
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_funding_sources_tenant_env
  ON funding_sources (tenant_id, environment);

-- Funding Transactions
ALTER TABLE funding_transactions
  ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'test'
  CHECK (environment IN ('test', 'live'));
CREATE INDEX IF NOT EXISTS idx_funding_transactions_tenant_env
  ON funding_transactions (tenant_id, environment);
