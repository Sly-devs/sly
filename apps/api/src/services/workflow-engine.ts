/**
 * Workflow Engine Service
 *
 * Epic 29: Composable, multi-step workflow processes
 *
 * Handles:
 * - Template CRUD (29.1)
 * - Instance creation & state machine (29.2)
 * - Approval step execution (29.3)
 * - Condition step with expression evaluation (29.4)
 * - Action step integration (29.5)
 * - Notification step (29.6)
 * - Wait step with scheduling (29.7)
 * - Timeout handling (29.8)
 * - Agent-driven execution (29.12)
 * - External step type (29.13)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID, createHmac } from 'crypto';
import { createBalanceService } from './balances.js';

// ============================================
// Types
// ============================================

export type WorkflowTriggerType = 'manual' | 'on_record_change';
export type WorkflowInstanceStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export type WorkflowStepStatus = 'pending' | 'running' | 'waiting_approval' | 'waiting_external' | 'waiting_schedule' | 'approved' | 'rejected' | 'completed' | 'failed' | 'skipped' | 'timed_out';
export type WorkflowStepType = 'approval' | 'condition' | 'action' | 'wait' | 'notification' | 'external';

export interface WorkflowStepDefinition {
  type: WorkflowStepType;
  name: string;
  config: Record<string, unknown>;
}

export interface WorkflowTemplate {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  triggerType: WorkflowTriggerType;
  triggerConfig: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  isActive: boolean;
  version: number;
  createdBy?: string;
  timeoutHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowInstance {
  id: string;
  tenantId: string;
  templateId: string;
  templateVersion: number;
  status: WorkflowInstanceStatus;
  currentStepIndex: number;
  triggerData: Record<string, unknown>;
  context: Record<string, unknown>;
  initiatedBy?: string;
  initiatedByType?: string;
  initiatedByAgentId?: string;
  agentContext?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  timeoutAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepExecution {
  id: string;
  tenantId: string;
  instanceId: string;
  stepIndex: number;
  stepType: WorkflowStepType;
  stepName?: string;
  stepConfig: Record<string, unknown>;
  status: WorkflowStepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string;
  approvedBy?: string;
  approvalDecision?: string;
  approvalReason?: string;
  approvedByAgentId?: string;
  agentReasoning?: string;
  externalRequest?: Record<string, unknown>;
  externalResponse?: Record<string, unknown>;
  callbackToken?: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentWorkflowPermission {
  id: string;
  tenantId: string;
  agentId: string;
  templateId: string;
  canInitiate: boolean;
  canApprove: boolean;
  approvalConditions: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Request types
export interface CreateTemplateRequest {
  name: string;
  description?: string;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  isActive?: boolean;
  timeoutHours?: number;
  createdBy?: string;
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  triggerType?: WorkflowTriggerType;
  triggerConfig?: Record<string, unknown>;
  steps?: WorkflowStepDefinition[];
  isActive?: boolean;
  timeoutHours?: number;
}

export interface CreateInstanceRequest {
  templateId: string;
  triggerData?: Record<string, unknown>;
  initiatedBy?: string;
  initiatedByType?: string;
  initiatedByAgentId?: string;
  agentContext?: Record<string, unknown>;
}

export interface StepApprovalRequest {
  decision: 'approved' | 'rejected';
  approvedBy: string;
  reason?: string;
  approvedByAgentId?: string;
  agentReasoning?: string;
}

export interface CompleteExternalStepRequest {
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
  signature?: string;
}

export interface ListOptions {
  limit?: number;
  offset?: number;
}

export interface TemplateListOptions extends ListOptions {
  isActive?: boolean;
  triggerType?: WorkflowTriggerType;
}

export interface InstanceListOptions extends ListOptions {
  status?: WorkflowInstanceStatus;
  templateId?: string;
  initiatedByAgentId?: string;
}

export interface PendingWorkflowOptions extends ListOptions {
  actorId?: string;
  actorType?: string;
}

// ============================================
// Expression Evaluator (Story 29.4)
// ============================================

export function evaluateExpression(expression: string, data: Record<string, unknown>): boolean {
  // Simple expression evaluator for conditions
  // Supports: trigger.field op value, context.field op value
  // Ops: ==, !=, >, <, >=, <=, contains, starts_with

  try {
    // Handle simple comparisons: "trigger.amount > 1000"
    const comparisonMatch = expression.match(
      /^(\w+(?:\.\w+)*)\s*(==|!=|>=|<=|>|<|contains|starts_with)\s*(.+)$/
    );

    if (comparisonMatch) {
      const [, fieldPath, operator, rawValue] = comparisonMatch;
      const fieldValue = getNestedValue(data, fieldPath);
      const compareValue = parseValue(rawValue.trim());

      return compareValues(fieldValue, operator, compareValue);
    }

    // Handle boolean expressions: "trigger.is_urgent"
    const boolMatch = expression.match(/^(\w+(?:\.\w+)*)$/);
    if (boolMatch) {
      return !!getNestedValue(data, boolMatch[1]);
    }

    // Handle negation: "!trigger.is_urgent"
    const negMatch = expression.match(/^!(\w+(?:\.\w+)*)$/);
    if (negMatch) {
      return !getNestedValue(data, negMatch[1]);
    }

    return false;
  } catch {
    return false;
  }
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

export function parseValue(raw: string): unknown {
  // Remove surrounding quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // Number
  const num = Number(raw);
  if (!isNaN(num)) return num;
  // String fallback
  return raw;
}

export function compareValues(a: unknown, op: string, b: unknown): boolean {
  switch (op) {
    case '==': return a == b;
    case '!=': return a != b;
    case '>': return Number(a) > Number(b);
    case '<': return Number(a) < Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<=': return Number(a) <= Number(b);
    case 'contains': return String(a).includes(String(b));
    case 'starts_with': return String(a).startsWith(String(b));
    default: return false;
  }
}

// ============================================
// Template Variable Interpolation
// ============================================

function interpolateTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, path) => {
    const value = getNestedValue(data, path);
    return value !== undefined ? String(value) : '';
  });
}

function interpolateObject(obj: unknown, data: Record<string, unknown>): unknown {
  if (typeof obj === 'string') {
    return interpolateTemplate(obj, data);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => interpolateObject(item, data));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value, data);
    }
    return result;
  }
  return obj;
}

// ============================================
// Workflow Engine Service
// ============================================

export class WorkflowEngine {
  constructor(
    private supabase: SupabaseClient,
    private environment: 'test' | 'live' = 'test',
  ) {}

  // ============================================
  // Template CRUD (Story 29.1)
  // ============================================

  async createTemplate(tenantId: string, request: CreateTemplateRequest): Promise<WorkflowTemplate> {
    const { data, error } = await this.supabase
      .from('workflow_templates')
      .insert({
        tenant_id: tenantId,
        name: request.name,
        description: request.description || null,
        trigger_type: request.triggerType || 'manual',
        trigger_config: request.triggerConfig || {},
        steps: request.steps,
        is_active: request.isActive !== false,
        version: 1,
        timeout_hours: request.timeoutHours || 168,
        created_by: request.createdBy || null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error(`Template with name '${request.name}' already exists`);
      }
      throw new Error(`Failed to create template: ${error.message}`);
    }

    return this.mapTemplate(data);
  }

  async getTemplate(tenantId: string, templateId: string): Promise<WorkflowTemplate | null> {
    const { data, error } = await this.supabase
      .from('workflow_templates')
      .select('*')
      .eq('id', templateId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return null;
    return this.mapTemplate(data);
  }

  async listTemplates(tenantId: string, options: TemplateListOptions = {}): Promise<{ data: WorkflowTemplate[]; total: number }> {
    let query = this.supabase
      .from('workflow_templates')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (options.isActive !== undefined) {
      query = query.eq('is_active', options.isActive);
    }
    if (options.triggerType) {
      query = query.eq('trigger_type', options.triggerType);
    }

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to list templates: ${error.message}`);

    return {
      data: (data || []).map(row => this.mapTemplate(row)),
      total: count || 0,
    };
  }

  async updateTemplate(tenantId: string, templateId: string, request: UpdateTemplateRequest): Promise<WorkflowTemplate> {
    // Fetch existing to bump version
    const existing = await this.getTemplate(tenantId, templateId);
    if (!existing) throw new Error('Template not found');

    const updates: Record<string, unknown> = {};
    if (request.name !== undefined) updates.name = request.name;
    if (request.description !== undefined) updates.description = request.description;
    if (request.triggerType !== undefined) updates.trigger_type = request.triggerType;
    if (request.triggerConfig !== undefined) updates.trigger_config = request.triggerConfig;
    if (request.steps !== undefined) {
      updates.steps = request.steps;
      updates.version = existing.version + 1;
    }
    if (request.isActive !== undefined) updates.is_active = request.isActive;
    if (request.timeoutHours !== undefined) updates.timeout_hours = request.timeoutHours;

    const { data, error } = await this.supabase
      .from('workflow_templates')
      .update(updates)
      .eq('id', templateId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(`Failed to update template: ${error.message}`);
    return this.mapTemplate(data);
  }

  async deleteTemplate(tenantId: string, templateId: string): Promise<void> {
    const { error } = await this.supabase
      .from('workflow_templates')
      .delete()
      .eq('id', templateId)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(`Failed to delete template: ${error.message}`);
  }

  // ============================================
  // Instance Management (Story 29.2)
  // ============================================

  async createInstance(tenantId: string, request: CreateInstanceRequest): Promise<WorkflowInstance> {
    // Fetch template
    const template = await this.getTemplate(tenantId, request.templateId);
    if (!template) throw new Error('Template not found');
    if (!template.isActive) throw new Error('Template is not active');
    if (template.steps.length === 0) throw new Error('Template has no steps');

    // Check agent permissions if initiated by agent
    if (request.initiatedByAgentId) {
      const perm = await this.getAgentPermission(tenantId, request.initiatedByAgentId, request.templateId);
      if (!perm || !perm.canInitiate) {
        throw new Error('Agent does not have permission to initiate this workflow');
      }
    }

    // Calculate timeout
    const timeoutAt = template.timeoutHours
      ? new Date(Date.now() + template.timeoutHours * 3600 * 1000).toISOString()
      : null;

    const { data, error } = await this.supabase
      .from('workflow_instances')
      .insert({
        tenant_id: tenantId,
        environment: this.environment,
        template_id: template.id,
        template_version: template.version,
        status: 'pending',
        current_step_index: 0,
        trigger_data: request.triggerData || {},
        context: {},
        initiated_by: request.initiatedBy || null,
        initiated_by_type: request.initiatedByType || null,
        initiated_by_agent_id: request.initiatedByAgentId || null,
        agent_context: request.agentContext || null,
        timeout_at: timeoutAt,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create instance: ${error.message}`);

    const instance = this.mapInstance(data);

    // Create step execution records for all steps
    const stepInserts = template.steps.map((step, index) => ({
      tenant_id: tenantId,
      environment: this.environment,
      instance_id: instance.id,
      step_index: index,
      step_type: step.type,
      step_name: step.name,
      step_config: step.config,
      status: 'pending',
    }));

    if (stepInserts.length > 0) {
      const { error: stepError } = await this.supabase
        .from('workflow_step_executions')
        .insert(stepInserts);

      if (stepError) throw new Error(`Failed to create step executions: ${stepError.message}`);
    }

    // Start the workflow automatically
    return this.startInstance(tenantId, instance.id);
  }

  async getInstance(tenantId: string, instanceId: string): Promise<WorkflowInstance | null> {
    const { data, error } = await this.supabase
      .from('workflow_instances')
      .select('*')
      .eq('id', instanceId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return null;
    return this.mapInstance(data);
  }

  async getInstanceWithSteps(tenantId: string, instanceId: string): Promise<{ instance: WorkflowInstance; steps: WorkflowStepExecution[] } | null> {
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance) return null;

    const { data: steps, error } = await this.supabase
      .from('workflow_step_executions')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('tenant_id', tenantId)
      .order('step_index', { ascending: true });

    if (error) throw new Error(`Failed to get steps: ${error.message}`);

    return {
      instance,
      steps: (steps || []).map(row => this.mapStepExecution(row)),
    };
  }

  async listInstances(tenantId: string, options: InstanceListOptions = {}): Promise<{ data: WorkflowInstance[]; total: number }> {
    let query = this.supabase
      .from('workflow_instances')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('environment', this.environment)
      .order('created_at', { ascending: false });

    if (options.status) query = query.eq('status', options.status);
    if (options.templateId) query = query.eq('template_id', options.templateId);
    if (options.initiatedByAgentId) query = query.eq('initiated_by_agent_id', options.initiatedByAgentId);

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to list instances: ${error.message}`);

    return {
      data: (data || []).map(row => this.mapInstance(row)),
      total: count || 0,
    };
  }

  async cancelInstance(tenantId: string, instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance) throw new Error('Instance not found');
    if (['completed', 'failed', 'cancelled', 'timed_out'].includes(instance.status)) {
      throw new Error(`Cannot cancel workflow in '${instance.status}' status`);
    }

    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('workflow_instances')
      .update({ status: 'cancelled', completed_at: now, error: 'Cancelled by user' })
      .eq('id', instanceId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(`Failed to cancel instance: ${error.message}`);
    return this.mapInstance(data);
  }

  // ============================================
  // Step Execution Engine (Stories 29.2-29.7, 29.13)
  // ============================================

  private async startInstance(tenantId: string, instanceId: string): Promise<WorkflowInstance> {
    const now = new Date().toISOString();
    const { data, error } = await this.supabase
      .from('workflow_instances')
      .update({ status: 'running', started_at: now })
      .eq('id', instanceId)
      .eq('tenant_id', tenantId)
      .select()
      .single();

    if (error) throw new Error(`Failed to start instance: ${error.message}`);

    // Execute the first step
    await this.executeCurrentStep(tenantId, instanceId, this.environment);

    // Re-fetch to get latest state
    return (await this.getInstance(tenantId, instanceId))!;
  }

  private async executeCurrentStep(tenantId: string, instanceId: string, environment: 'test' | 'live' = 'test'): Promise<void> {
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance || instance.status !== 'running') return;

    // Get current step execution
    const { data: stepData, error: stepError } = await this.supabase
      .from('workflow_step_executions')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('step_index', instance.currentStepIndex)
      .eq('tenant_id', tenantId)
      .single();

    if (stepError || !stepData) {
      // No more steps - workflow completed
      await this.completeInstance(tenantId, instanceId);
      return;
    }

    const step = this.mapStepExecution(stepData);
    if (step.status !== 'pending') return; // Already running/completed

    // Build step input from trigger_data + accumulated context
    const stepInput = {
      trigger: instance.triggerData,
      context: instance.context,
      step_index: step.stepIndex,
    };

    // Mark step as running
    await this.supabase
      .from('workflow_step_executions')
      .update({ status: 'running', started_at: new Date().toISOString(), input: stepInput })
      .eq('id', step.id);

    try {
      switch (step.stepType) {
        case 'approval':
          await this.executeApprovalStep(tenantId, instance, step);
          break;
        case 'condition':
          await this.executeConditionStep(tenantId, instance, step, stepInput);
          break;
        case 'action':
          await this.executeActionStep(tenantId, instance, step, stepInput);
          break;
        case 'notification':
          await this.executeNotificationStep(tenantId, instance, step, stepInput);
          break;
        case 'wait':
          await this.executeWaitStep(tenantId, instance, step);
          break;
        case 'external':
          await this.executeExternalStep(tenantId, instance, step, stepInput);
          break;
        default:
          throw new Error(`Unknown step type: ${step.stepType}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.failStep(step.id, errorMsg);
      await this.failInstance(tenantId, instanceId, `Step '${step.stepName}' failed: ${errorMsg}`);
    }
  }

  // Story 29.3: Approval Step
  private async executeApprovalStep(tenantId: string, instance: WorkflowInstance, step: WorkflowStepExecution): Promise<void> {
    const config = step.stepConfig;
    const timeoutHours = (config.timeout_hours as number) || 24;
    const expiresAt = new Date(Date.now() + timeoutHours * 3600 * 1000).toISOString();

    await this.supabase
      .from('workflow_step_executions')
      .update({ status: 'waiting_approval', expires_at: expiresAt })
      .eq('id', step.id);

    // Pause the instance while waiting for approval
    await this.supabase
      .from('workflow_instances')
      .update({ status: 'paused' })
      .eq('id', instance.id);

    // Send webhook notification about pending approval
    await this.sendWorkflowWebhook(tenantId, 'workflow.approval_required', {
      instance_id: instance.id,
      step_index: step.stepIndex,
      step_name: step.stepName,
      config,
    });
  }

  // Story 29.4: Condition Step
  private async executeConditionStep(
    tenantId: string,
    instance: WorkflowInstance,
    step: WorkflowStepExecution,
    stepInput: Record<string, unknown>
  ): Promise<void> {
    const config = step.stepConfig;
    const expression = config.expression as string;

    if (!expression) {
      throw new Error('Condition step requires an expression');
    }

    const result = evaluateExpression(expression, stepInput);
    const output = { expression, result };

    await this.completeStep(step.id, output);

    if (result) {
      // Handle if_true directive
      const ifTrue = config.if_true as string;
      if (ifTrue && ifTrue.startsWith('skip_to:')) {
        const skipTo = parseInt(ifTrue.split(':')[1], 10);
        if (!isNaN(skipTo)) {
          // Skip intermediate steps
          await this.skipStepsInRange(tenantId, instance.id, step.stepIndex + 1, skipTo);
          await this.advanceToStep(tenantId, instance.id, skipTo);
          return;
        }
      }
    } else {
      // Handle if_false directive
      const ifFalse = config.if_false as string;
      if (ifFalse && ifFalse.startsWith('skip_to:')) {
        const skipTo = parseInt(ifFalse.split(':')[1], 10);
        if (!isNaN(skipTo)) {
          await this.skipStepsInRange(tenantId, instance.id, step.stepIndex + 1, skipTo);
          await this.advanceToStep(tenantId, instance.id, skipTo);
          return;
        }
      }
    }

    // Default: advance to next step
    await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, output);
  }

  // Story 29.5: Action Step
  private async executeActionStep(
    tenantId: string,
    instance: WorkflowInstance,
    step: WorkflowStepExecution,
    stepInput: Record<string, unknown>
  ): Promise<void> {
    const config = step.stepConfig;
    const action = config.action as string;

    if (!action) {
      throw new Error('Action step requires an action type');
    }

    // Interpolate parameters
    const params = interpolateObject(config.params || {}, stepInput) as Record<string, unknown>;
    let output: Record<string, unknown> = { action, params };

    switch (action) {
      case 'execute_transfer': {
        const transferId = params.transfer_id as string;
        if (!transferId) throw new Error('execute_transfer requires transfer_id');

        // Fetch the transfer, scoped to tenant
        const { data: transfer, error: fetchErr } = await this.supabase
          .from('transfers')
          .select('*')
          .eq('id', transferId)
          .eq('tenant_id', tenantId)
          .single();

        if (fetchErr || !transfer) throw new Error(`Transfer not found: ${transferId}`);
        if (transfer.status !== 'pending') {
          throw new Error(`Transfer ${transferId} is not pending (current status: ${transfer.status})`);
        }

        // Mark as processing
        await this.supabase
          .from('transfers')
          .update({ status: 'processing', processing_at: new Date().toISOString() })
          .eq('id', transferId);

        if (transfer.type === 'internal') {
          // Execute balance movement for internal transfers
          const balanceService = createBalanceService(this.supabase);
          try {
            await balanceService.transfer(
              transfer.from_account_id,
              transfer.to_account_id,
              parseFloat(transfer.amount),
              'transfer',
              transfer.id,
              transfer.description || 'Workflow-executed transfer'
            );
          } catch (balanceErr: any) {
            await this.supabase
              .from('transfers')
              .update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: balanceErr.message })
              .eq('id', transferId);
            throw new Error(`Balance transfer failed: ${balanceErr.message}`);
          }

          await this.supabase
            .from('transfers')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('id', transferId);

          output.result = {
            status: 'completed',
            transfer_id: transferId,
            amount: parseFloat(transfer.amount),
            from_account_id: transfer.from_account_id,
            to_account_id: transfer.to_account_id,
          };
        } else {
          // Cross-border or other types stay in processing (PSP handles completion)
          output.result = {
            status: 'processing',
            transfer_id: transferId,
            amount: parseFloat(transfer.amount),
            from_account_id: transfer.from_account_id,
            to_account_id: transfer.to_account_id,
          };
        }
        break;
      }
      case 'create_transfer': {
        const fromAccountId = params.from_account_id as string;
        const toAccountId = params.to_account_id as string;
        const rawAmount = params.amount;
        const currency = (params.currency as string) || 'USDC';
        const description = (params.description as string) || 'Workflow-created transfer';
        const transferType = (params.type as string) || 'internal';

        if (!fromAccountId || !toAccountId) {
          throw new Error('create_transfer requires from_account_id and to_account_id');
        }

        const amount = parseFloat(String(rawAmount));
        if (!amount || amount <= 0) {
          throw new Error('create_transfer requires a positive amount');
        }

        // Validate both accounts exist and belong to tenant
        const { data: fromAccount, error: fromErr } = await this.supabase
          .from('accounts')
          .select('id, name')
          .eq('id', fromAccountId)
          .eq('tenant_id', tenantId)
          .single();
        if (fromErr || !fromAccount) throw new Error(`Source account not found: ${fromAccountId}`);

        const { data: toAccount, error: toErr } = await this.supabase
          .from('accounts')
          .select('id, name')
          .eq('id', toAccountId)
          .eq('tenant_id', tenantId)
          .single();
        if (toErr || !toAccount) throw new Error(`Destination account not found: ${toAccountId}`);

        const isInternal = transferType === 'internal';

        // Insert the transfer record
        const { data: transfer, error: createErr } = await this.supabase
          .from('transfers')
          .insert({
            tenant_id: tenantId,
            type: transferType,
            status: isInternal ? 'completed' : 'pending',
            from_account_id: fromAccountId,
            from_account_name: fromAccount.name,
            to_account_id: toAccountId,
            to_account_name: toAccount.name,
            initiated_by_type: 'system',
            initiated_by_id: 'workflow-engine',
            initiated_by_name: 'Workflow Engine',
            amount,
            currency,
            destination_amount: amount,
            destination_currency: currency,
            fx_rate: 1,
            fee_amount: 0,
            description,
            completed_at: isInternal ? new Date().toISOString() : null,
          })
          .select()
          .single();

        if (createErr || !transfer) throw new Error(`Failed to create transfer: ${createErr?.message}`);

        // For internal transfers, execute balance movement immediately
        if (isInternal) {
          const balanceService = createBalanceService(this.supabase);
          try {
            await balanceService.transfer(
              fromAccountId,
              toAccountId,
              amount,
              'transfer',
              transfer.id,
              description
            );
          } catch (balanceErr: any) {
            await this.supabase
              .from('transfers')
              .update({ status: 'failed', failed_at: new Date().toISOString(), failure_reason: balanceErr.message })
              .eq('id', transfer.id);
            throw new Error(`Balance transfer failed: ${balanceErr.message}`);
          }
        }

        output.result = {
          status: transfer.status,
          transfer_id: transfer.id,
          amount,
          from_account_id: fromAccountId,
          to_account_id: toAccountId,
        };
        break;
      }
      case 'update_metadata': {
        const entityType = params.entity_type as string;
        const entityId = params.entity_id as string;
        const metadata = params.metadata as Record<string, unknown>;

        if (!entityType || !entityId || !metadata) {
          throw new Error('update_metadata requires entity_type, entity_id, and metadata');
        }

        // Whitelist of supported entity types → table names
        const tableMap: Record<string, string> = {
          account: 'accounts',
          agent: 'agents',
          wallet: 'wallets',
        };
        const tableName = tableMap[entityType];
        if (!tableName) {
          throw new Error(`update_metadata does not support entity_type '${entityType}'. Supported: ${Object.keys(tableMap).join(', ')}`);
        }

        // Fetch existing entity to get current metadata
        const { data: entity, error: fetchErr } = await this.supabase
          .from(tableName)
          .select('id, metadata')
          .eq('id', entityId)
          .eq('tenant_id', tenantId)
          .single();

        if (fetchErr || !entity) throw new Error(`${entityType} not found: ${entityId}`);

        // Shallow-merge new metadata into existing
        const existingMetadata = (entity.metadata && typeof entity.metadata === 'object') ? entity.metadata as Record<string, unknown> : {};
        const mergedMetadata = { ...existingMetadata, ...metadata };

        const { error: updateErr } = await this.supabase
          .from(tableName)
          .update({ metadata: mergedMetadata })
          .eq('id', entityId)
          .eq('tenant_id', tenantId);

        if (updateErr) throw new Error(`Failed to update ${entityType} metadata: ${updateErr.message}`);

        output.result = {
          status: 'updated',
          entity_type: entityType,
          entity_id: entityId,
          metadata: mergedMetadata,
        };
        break;
      }
      default: {
        // Generic action - record what was requested
        output.result = { status: 'executed', action, params };
        break;
      }
    }

    await this.completeStep(step.id, output);
    await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, output);
  }

  // Story 29.6: Notification Step
  private async executeNotificationStep(
    tenantId: string,
    instance: WorkflowInstance,
    step: WorkflowStepExecution,
    stepInput: Record<string, unknown>
  ): Promise<void> {
    const config = step.stepConfig;
    // Read notification_type with fallback to type for backward compat
    const notificationType = (config.notification_type as string) || (config.type as string) || 'webhook';

    let output: Record<string, unknown> = { type: notificationType };

    if (notificationType === 'webhook') {
      const url = interpolateTemplate((config.url as string) || '', stepInput);
      const payload = interpolateObject(config.payload || {}, stepInput);

      if (url) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          output.delivered = response.ok;
          output.status_code = response.status;
        } catch (err) {
          output.delivered = false;
          output.error = err instanceof Error ? err.message : String(err);
        }
      }
    } else if (notificationType === 'email') {
      // Email notification — no email service yet, store intent
      const recipients = config.recipients as string;
      const subject = interpolateTemplate((config.subject as string) || 'Workflow Notification', stepInput);
      const message = interpolateTemplate((config.message as string) || '', stepInput);
      output.pending_email = {
        recipients: recipients ? recipients.split(',').map((r: string) => r.trim()) : [],
        subject,
        message,
      };
      output.delivered = false;
      output.status = 'pending_email';
    } else if (notificationType === 'internal') {
      // Send internal workflow webhook
      await this.sendWorkflowWebhook(tenantId, 'workflow.notification', {
        instance_id: instance.id,
        step_name: step.stepName,
        message: interpolateTemplate((config.message as string) || '', stepInput),
      });
      output.delivered = true;
    }

    await this.completeStep(step.id, output);
    await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, output);
  }

  // Story 29.7: Wait Step
  private async executeWaitStep(
    tenantId: string,
    instance: WorkflowInstance,
    step: WorkflowStepExecution
  ): Promise<void> {
    const config = step.stepConfig;
    const waitType = (config.wait_type as string) || 'duration';

    if (waitType === 'duration') {
      const durationMinutes = (config.duration_minutes as number) || 60;
      const resumeAt = new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();

      await this.supabase
        .from('workflow_step_executions')
        .update({ status: 'waiting_schedule', expires_at: resumeAt })
        .eq('id', step.id);

      await this.supabase
        .from('workflow_instances')
        .update({ status: 'paused' })
        .eq('id', instance.id);
    } else if (waitType === 'until') {
      const untilTime = config.until as string;
      if (!untilTime) throw new Error('Wait step with type "until" requires an "until" timestamp');

      await this.supabase
        .from('workflow_step_executions')
        .update({ status: 'waiting_schedule', expires_at: untilTime })
        .eq('id', step.id);

      await this.supabase
        .from('workflow_instances')
        .update({ status: 'paused' })
        .eq('id', instance.id);
    } else {
      throw new Error(`Unknown wait type: ${waitType}`);
    }
  }

  // Story 29.13: External Step
  private async executeExternalStep(
    tenantId: string,
    instance: WorkflowInstance,
    step: WorkflowStepExecution,
    stepInput: Record<string, unknown>
  ): Promise<void> {
    const config = step.stepConfig;
    const mode = (config.mode as string) || 'sync';
    const url = interpolateTemplate((config.url as string) || '', stepInput);
    const method = ((config.method as string) || 'GET').toUpperCase();
    const timeoutSeconds = (config.timeout_seconds as number) || 30;

    if (!url) throw new Error('External step requires a URL');

    // Build request headers
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.headers && typeof config.headers === 'object') {
      const interpolatedHeaders = interpolateObject(config.headers, stepInput) as Record<string, string>;
      Object.assign(headers, interpolatedHeaders);
    }

    // Build request body
    const body = config.body ? JSON.stringify(interpolateObject(config.body, stepInput)) : undefined;

    const externalRequest = { url, method, headers: Object.keys(headers).length > 1 ? headers : undefined, body: config.body };

    if (mode === 'async') {
      // Async mode: fire request and wait for callback
      const callbackToken = randomUUID();
      const completionTimeoutHours = (config.completion_timeout_hours as number) || 24;
      const expiresAt = new Date(Date.now() + completionTimeoutHours * 3600 * 1000).toISOString();

      await this.supabase
        .from('workflow_step_executions')
        .update({
          status: 'waiting_external',
          external_request: externalRequest,
          callback_token: callbackToken,
          expires_at: expiresAt,
        })
        .eq('id', step.id);

      await this.supabase
        .from('workflow_instances')
        .update({ status: 'paused' })
        .eq('id', instance.id);

      // Fire the async request (don't wait for meaningful response)
      try {
        await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });
      } catch {
        // Async request fire-and-forget; callback will complete the step
      }
    } else {
      // Sync mode: wait for response
      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });

        const responseBody = await response.text();
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(responseBody);
        } catch {
          parsedBody = responseBody;
        }

        const externalResponse = {
          status: response.status,
          body: parsedBody,
        };

        // Check success condition
        const successCondition = config.success_condition as string;
        let success = response.ok;
        if (successCondition) {
          success = evaluateExpression(successCondition, { response: externalResponse });
        }

        // Extract fields if configured
        let extractedFields: Record<string, unknown> = {};
        if (config.extract_fields && typeof config.extract_fields === 'object') {
          for (const [key, pathExpr] of Object.entries(config.extract_fields as Record<string, string>)) {
            extractedFields[key] = getNestedValue({ response: externalResponse }, pathExpr);
          }
        }

        const output = { ...extractedFields, _external_response: externalResponse };

        if (success) {
          await this.supabase
            .from('workflow_step_executions')
            .update({ external_request: externalRequest, external_response: externalResponse })
            .eq('id', step.id);

          await this.completeStep(step.id, output);
          await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, output);
        } else {
          // Handle failure based on config
          const onFailure = (config.on_failure as string) || 'fail_workflow';
          if (onFailure === 'skip') {
            await this.supabase
              .from('workflow_step_executions')
              .update({ status: 'skipped', external_request: externalRequest, external_response: externalResponse, completed_at: new Date().toISOString() })
              .eq('id', step.id);
            await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, {});
          } else {
            throw new Error(`External request failed with status ${response.status}`);
          }
        }
      } catch (err) {
        // Handle retry
        const retryConfig = config.retry_config as { max_retries?: number; backoff_ms?: number } | undefined;
        if (retryConfig && retryConfig.max_retries && retryConfig.max_retries > 0) {
          const onFailure = (config.on_failure as string) || 'fail_workflow';
          if (onFailure === 'skip') {
            await this.supabase
              .from('workflow_step_executions')
              .update({ status: 'skipped', external_request: externalRequest, completed_at: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) })
              .eq('id', step.id);
            await this.advanceToNextStep(tenantId, instance.id, step.stepIndex, {});
            return;
          }
        }
        throw err;
      }
    }
  }

  // ============================================
  // Step Approval (Story 29.3)
  // ============================================

  async approveStep(
    tenantId: string,
    instanceId: string,
    stepIndex: number,
    request: StepApprovalRequest
  ): Promise<WorkflowStepExecution> {
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance) throw new Error('Instance not found');

    const { data: stepData, error: stepError } = await this.supabase
      .from('workflow_step_executions')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('step_index', stepIndex)
      .eq('tenant_id', tenantId)
      .single();

    if (stepError || !stepData) throw new Error('Step not found');
    const step = this.mapStepExecution(stepData);

    if (step.status !== 'waiting_approval') {
      throw new Error(`Step is not waiting for approval (current status: ${step.status})`);
    }

    if (step.stepType !== 'approval') {
      throw new Error('Step is not an approval step');
    }

    // Check required approvers from step config
    const requiredApprovers = step.stepConfig.required_approvers as string[] | undefined;
    if (requiredApprovers?.length) {
      if (!requiredApprovers.includes(request.approvedBy)) {
        throw new Error('You are not an authorized approver for this step');
      }
    }

    // Check agent permissions for approval
    if (request.approvedByAgentId) {
      const perm = await this.getAgentPermission(tenantId, request.approvedByAgentId, instance.templateId);
      if (!perm || !perm.canApprove) {
        throw new Error('Agent does not have permission to approve this workflow');
      }

      // Check approval conditions
      if (perm.approvalConditions) {
        const conditions = perm.approvalConditions;
        if (conditions.step_names && Array.isArray(conditions.step_names)) {
          if (!conditions.step_names.includes(step.stepName)) {
            throw new Error(`Agent is not authorized to approve step '${step.stepName}'`);
          }
        }
        if (conditions.max_amount && typeof conditions.max_amount === 'number') {
          const amount = getNestedValue(instance.triggerData, 'amount');
          if (typeof amount === 'number' && amount > conditions.max_amount) {
            throw new Error(`Amount exceeds agent's approval limit of ${conditions.max_amount}`);
          }
        }
      }
    }

    const now = new Date().toISOString();
    const isApproved = request.decision === 'approved';

    const { data, error } = await this.supabase
      .from('workflow_step_executions')
      .update({
        status: isApproved ? 'approved' : 'rejected',
        approved_by: request.approvedBy,
        approval_decision: request.decision,
        approval_reason: request.reason || null,
        approved_by_agent_id: request.approvedByAgentId || null,
        agent_reasoning: request.agentReasoning || null,
        completed_at: now,
        output: { decision: request.decision, reason: request.reason },
      })
      .eq('id', step.id)
      .select()
      .single();

    if (error) throw new Error(`Failed to update step: ${error.message}`);

    if (isApproved) {
      // Continue the workflow
      await this.supabase
        .from('workflow_instances')
        .update({ status: 'running' })
        .eq('id', instanceId);

      await this.advanceToNextStep(tenantId, instanceId, stepIndex, { decision: 'approved' });
    } else {
      // Rejection fails the workflow
      await this.failInstance(tenantId, instanceId, `Step '${step.stepName}' was rejected: ${request.reason || 'No reason given'}`);
    }

    // Send webhook
    await this.sendWorkflowWebhook(tenantId, isApproved ? 'workflow.step_approved' : 'workflow.step_rejected', {
      instance_id: instanceId,
      step_index: stepIndex,
      step_name: step.stepName,
      decision: request.decision,
      approved_by: request.approvedBy,
    });

    return this.mapStepExecution(data);
  }

  // ============================================
  // External Step Completion (Story 29.13)
  // ============================================

  async completeExternalStep(
    tenantId: string,
    instanceId: string,
    stepIndex: number,
    request: CompleteExternalStepRequest
  ): Promise<WorkflowStepExecution> {
    const { data: stepData, error: stepError } = await this.supabase
      .from('workflow_step_executions')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('step_index', stepIndex)
      .eq('tenant_id', tenantId)
      .single();

    if (stepError || !stepData) throw new Error('Step not found');
    const step = this.mapStepExecution(stepData);

    if (step.status !== 'waiting_external') {
      throw new Error(`Step is not waiting for external completion (current status: ${step.status})`);
    }

    // Verify callback token if signature provided
    if (request.signature && step.callbackToken) {
      const expectedSig = createHmac('sha256', step.callbackToken)
        .update(JSON.stringify(request.result || {}))
        .digest('hex');
      if (request.signature !== expectedSig) {
        throw new Error('Invalid callback signature');
      }
    }

    const now = new Date().toISOString();
    const isSuccess = request.status === 'completed';

    const { data, error } = await this.supabase
      .from('workflow_step_executions')
      .update({
        status: isSuccess ? 'completed' : 'failed',
        external_response: request.result || {},
        output: request.result || {},
        error: request.error || null,
        completed_at: now,
      })
      .eq('id', step.id)
      .select()
      .single();

    if (error) throw new Error(`Failed to update step: ${error.message}`);

    if (isSuccess) {
      await this.supabase
        .from('workflow_instances')
        .update({ status: 'running' })
        .eq('id', instanceId);

      await this.advanceToNextStep(tenantId, instanceId, stepIndex, request.result || {});
    } else {
      await this.failInstance(tenantId, instanceId, `External step '${step.stepName}' failed: ${request.error || 'Unknown error'}`);
    }

    return this.mapStepExecution(data);
  }

  // ============================================
  // Agent Advance (Story 29.12)
  // ============================================

  async advanceInstance(tenantId: string, instanceId: string): Promise<WorkflowInstance> {
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance) throw new Error('Instance not found');

    if (instance.status === 'completed' || instance.status === 'failed' || instance.status === 'cancelled') {
      throw new Error(`Cannot advance workflow in '${instance.status}' status`);
    }

    // Check if current step is in a completable waiting state (e.g. wait step that's ready)
    const { data: stepData } = await this.supabase
      .from('workflow_step_executions')
      .select('*')
      .eq('instance_id', instanceId)
      .eq('step_index', instance.currentStepIndex)
      .eq('tenant_id', tenantId)
      .single();

    if (!stepData) throw new Error('Current step not found');
    const step = this.mapStepExecution(stepData);

    // If step is waiting for schedule and time has passed, complete it
    if (step.status === 'waiting_schedule' && step.expiresAt && new Date(step.expiresAt) <= new Date()) {
      await this.completeStep(step.id, { waited: true, resumed_by: 'advance' });

      await this.supabase
        .from('workflow_instances')
        .update({ status: 'running' })
        .eq('id', instanceId);

      await this.advanceToNextStep(tenantId, instanceId, step.stepIndex, { waited: true });
    }

    return (await this.getInstance(tenantId, instanceId))!;
  }

  // ============================================
  // Pending Workflows API (Story 29.9)
  // ============================================

  async getPendingApprovals(tenantId: string, options: PendingWorkflowOptions = {}): Promise<{ data: WorkflowStepExecution[]; total: number }> {
    let query = this.supabase
      .from('workflow_step_executions')
      .select('*', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('status', 'waiting_approval')
      .order('created_at', { ascending: true });

    const limit = options.limit || 50;
    const offset = options.offset || 0;
    query = query.range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to get pending approvals: ${error.message}`);

    return {
      data: (data || []).map(row => this.mapStepExecution(row)),
      total: count || 0,
    };
  }

  // ============================================
  // Agent Workflow Permissions (Story 29.12)
  // ============================================

  async getAgentPermission(tenantId: string, agentId: string, templateId: string): Promise<AgentWorkflowPermission | null> {
    const { data, error } = await this.supabase
      .from('agent_workflow_permissions')
      .select('*')
      .eq('agent_id', agentId)
      .eq('template_id', templateId)
      .eq('tenant_id', tenantId)
      .single();

    if (error || !data) return null;
    return this.mapAgentPermission(data);
  }

  async setAgentPermission(
    tenantId: string,
    agentId: string,
    templateId: string,
    permissions: { canInitiate?: boolean; canApprove?: boolean; approvalConditions?: Record<string, unknown> }
  ): Promise<AgentWorkflowPermission> {
    const { data, error } = await this.supabase
      .from('agent_workflow_permissions')
      .upsert({
        tenant_id: tenantId,
        agent_id: agentId,
        template_id: templateId,
        can_initiate: permissions.canInitiate ?? false,
        can_approve: permissions.canApprove ?? false,
        approval_conditions: permissions.approvalConditions || {},
      }, { onConflict: 'agent_id,template_id' })
      .select()
      .single();

    if (error) throw new Error(`Failed to set agent permission: ${error.message}`);
    return this.mapAgentPermission(data);
  }

  async listAgentPermissions(tenantId: string, agentId: string): Promise<AgentWorkflowPermission[]> {
    const { data, error } = await this.supabase
      .from('agent_workflow_permissions')
      .select('*')
      .eq('agent_id', agentId)
      .eq('tenant_id', tenantId);

    if (error) throw new Error(`Failed to list agent permissions: ${error.message}`);
    return (data || []).map(row => this.mapAgentPermission(row));
  }

  // ============================================
  // Timeout Handling (Story 29.8)
  // ============================================

  async processTimeouts(): Promise<{ expiredInstances: number; expiredSteps: number }> {
    const { data: instanceCount } = await this.supabase.rpc('expire_workflow_instances');
    const { data: stepCount } = await this.supabase.rpc('expire_workflow_steps');

    return {
      expiredInstances: instanceCount || 0,
      expiredSteps: stepCount || 0,
    };
  }

  // ============================================
  // Private Helpers
  // ============================================

  private async completeStep(stepId: string, output: Record<string, unknown>): Promise<void> {
    await this.supabase
      .from('workflow_step_executions')
      .update({ status: 'completed', output, completed_at: new Date().toISOString() })
      .eq('id', stepId);
  }

  private async failStep(stepId: string, error: string): Promise<void> {
    await this.supabase
      .from('workflow_step_executions')
      .update({ status: 'failed', error, completed_at: new Date().toISOString() })
      .eq('id', stepId);
  }

  private async completeInstance(tenantId: string, instanceId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.supabase
      .from('workflow_instances')
      .update({ status: 'completed', completed_at: now })
      .eq('id', instanceId)
      .eq('tenant_id', tenantId);

    await this.sendWorkflowWebhook(tenantId, 'workflow.completed', { instance_id: instanceId });
  }

  private async failInstance(tenantId: string, instanceId: string, error: string): Promise<void> {
    const now = new Date().toISOString();
    await this.supabase
      .from('workflow_instances')
      .update({ status: 'failed', completed_at: now, error })
      .eq('id', instanceId)
      .eq('tenant_id', tenantId);

    await this.sendWorkflowWebhook(tenantId, 'workflow.failed', { instance_id: instanceId, error });
  }

  private async advanceToNextStep(
    tenantId: string,
    instanceId: string,
    currentIndex: number,
    stepOutput: Record<string, unknown>,
    environment: 'test' | 'live' = 'test'
  ): Promise<void> {
    // Merge step output into instance context
    const instance = await this.getInstance(tenantId, instanceId);
    if (!instance) return;

    const newContext = { ...instance.context, [`step_${currentIndex}`]: stepOutput };
    const nextIndex = currentIndex + 1;

    // Check if there are more steps
    const { data: nextStep } = await this.supabase
      .from('workflow_step_executions')
      .select('id')
      .eq('instance_id', instanceId)
      .eq('step_index', nextIndex)
      .single();

    if (!nextStep) {
      // No more steps, complete the workflow
      await this.supabase
        .from('workflow_instances')
        .update({ current_step_index: nextIndex, context: newContext })
        .eq('id', instanceId);
      await this.completeInstance(tenantId, instanceId);
      return;
    }

    // Advance to next step
    await this.supabase
      .from('workflow_instances')
      .update({ current_step_index: nextIndex, context: newContext, status: 'running' })
      .eq('id', instanceId);

    await this.executeCurrentStep(tenantId, instanceId, environment);
  }

  private async advanceToStep(tenantId: string, instanceId: string, targetIndex: number): Promise<void> {
    await this.supabase
      .from('workflow_instances')
      .update({ current_step_index: targetIndex, status: 'running' })
      .eq('id', instanceId);

    await this.executeCurrentStep(tenantId, instanceId);
  }

  private async skipStepsInRange(tenantId: string, instanceId: string, fromIndex: number, toIndex: number): Promise<void> {
    const now = new Date().toISOString();
    for (let i = fromIndex; i < toIndex; i++) {
      await this.supabase
        .from('workflow_step_executions')
        .update({ status: 'skipped', completed_at: now, output: { skipped_by: 'condition' } })
        .eq('instance_id', instanceId)
        .eq('step_index', i)
        .eq('tenant_id', tenantId);
    }
  }

  private async sendWorkflowWebhook(tenantId: string, eventType: string, data: Record<string, unknown>): Promise<void> {
    try {
      const { data: tenant } = await this.supabase
        .from('tenants')
        .select('webhook_url, webhook_secret')
        .eq('id', tenantId)
        .single();

      if (!tenant?.webhook_url) return;

      const payload = {
        event: eventType,
        timestamp: new Date().toISOString(),
        data,
      };

      const signature = tenant.webhook_secret
        ? createHmac('sha256', tenant.webhook_secret).update(JSON.stringify(payload)).digest('hex')
        : '';

      await fetch(tenant.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PayOS-Event': eventType,
          'X-PayOS-Signature': signature,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      console.error('[WorkflowEngine] Webhook delivery error:', err);
    }
  }

  // ============================================
  // DB Mappers
  // ============================================

  private mapTemplate(row: any): WorkflowTemplate {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      description: row.description || undefined,
      triggerType: row.trigger_type,
      triggerConfig: row.trigger_config || {},
      steps: row.steps || [],
      isActive: row.is_active,
      version: row.version,
      createdBy: row.created_by || undefined,
      timeoutHours: row.timeout_hours || 168,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapInstance(row: any): WorkflowInstance {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      status: row.status,
      currentStepIndex: row.current_step_index,
      triggerData: row.trigger_data || {},
      context: row.context || {},
      initiatedBy: row.initiated_by || undefined,
      initiatedByType: row.initiated_by_type || undefined,
      initiatedByAgentId: row.initiated_by_agent_id || undefined,
      agentContext: row.agent_context || undefined,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      timeoutAt: row.timeout_at || undefined,
      error: row.error || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapStepExecution(row: any): WorkflowStepExecution {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      instanceId: row.instance_id,
      stepIndex: row.step_index,
      stepType: row.step_type,
      stepName: row.step_name || undefined,
      stepConfig: row.step_config || {},
      status: row.status,
      input: row.input || {},
      output: row.output || {},
      error: row.error || undefined,
      approvedBy: row.approved_by || undefined,
      approvalDecision: row.approval_decision || undefined,
      approvalReason: row.approval_reason || undefined,
      approvedByAgentId: row.approved_by_agent_id || undefined,
      agentReasoning: row.agent_reasoning || undefined,
      externalRequest: row.external_request || undefined,
      externalResponse: row.external_response || undefined,
      callbackToken: row.callback_token || undefined,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      expiresAt: row.expires_at || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAgentPermission(row: any): AgentWorkflowPermission {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      agentId: row.agent_id,
      templateId: row.template_id,
      canInitiate: row.can_initiate,
      canApprove: row.can_approve,
      approvalConditions: row.approval_conditions || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

// ============================================
// Factory Function
// ============================================

export function createWorkflowEngine(supabase: SupabaseClient): WorkflowEngine {
  return new WorkflowEngine(supabase);
}
