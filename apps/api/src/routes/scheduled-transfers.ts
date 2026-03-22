import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  logAudit,
  isValidUUID,
  getPaginationParams,
  paginationResponse,
  getEnv,
} from '../utils/helpers.js';
import { ValidationError, NotFoundError } from '../middleware/error.js';
import { getScheduledTransferWorker } from '../workers/scheduled-transfers.js';

const scheduledTransfers = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createScheduleSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid().optional(),
  toPaymentMethodId: z.string().uuid().optional(),
  amount: z.number().positive(),
  currency: z.string().default('USDC'),
  description: z.string().max(500).optional(),
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly', 'custom']),
  intervalValue: z.number().int().positive().default(1),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(), // 0=Sunday
  timezone: z.string().default('UTC'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  maxOccurrences: z.number().int().positive().optional(),
  retryEnabled: z.boolean().default(true),
  maxRetryAttempts: z.number().int().positive().default(3),
  retryWindowDays: z.number().int().positive().default(14),
});

// ============================================
// Helper: Calculate next execution time
// ============================================
function calculateNextExecution(
  frequency: string,
  intervalValue: number,
  dayOfMonth: number | undefined,
  dayOfWeek: number | undefined,
  lastExecution: Date | null,
  startDate: Date
): Date {
  const now = new Date();
  const base = lastExecution || startDate;
  const next = new Date(base);
  
  switch (frequency) {
    case 'daily':
      next.setDate(next.getDate() + intervalValue);
      break;
    case 'weekly':
      next.setDate(next.getDate() + (7 * intervalValue));
      if (dayOfWeek !== undefined) {
        const currentDay = next.getDay();
        const daysToAdd = (dayOfWeek - currentDay + 7) % 7;
        next.setDate(next.getDate() + daysToAdd);
      }
      break;
    case 'biweekly':
      next.setDate(next.getDate() + (14 * intervalValue));
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + intervalValue);
      if (dayOfMonth !== undefined) {
        next.setDate(dayOfMonth);
      }
      break;
    default:
      next.setDate(next.getDate() + intervalValue);
  }
  
  return next;
}

// ============================================
// GET /v1/scheduled-transfers - List schedules
// ============================================
scheduledTransfers.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const status = query.status;
  const accountId = query.accountId;
  
  let dbQuery = supabase
    .from('transfer_schedules')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);
  
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  if (accountId && isValidUUID(accountId)) {
    dbQuery = dbQuery.eq('from_account_id', accountId);
  }
  
  const { data, count, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching schedules:', error);
    return c.json({ error: 'Failed to fetch schedules' }, 500);
  }
  
  return c.json(paginationResponse(data || [], count || 0, { page, limit }));
});

// ============================================
// POST /v1/scheduled-transfers - Create schedule
// ============================================
scheduledTransfers.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createScheduleSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const {
    fromAccountId,
    toAccountId,
    toPaymentMethodId,
    amount,
    currency,
    description,
    frequency,
    intervalValue,
    dayOfMonth,
    dayOfWeek,
    timezone,
    startDate,
    endDate,
    maxOccurrences,
    retryEnabled,
    maxRetryAttempts,
    retryWindowDays,
  } = parsed.data;
  
  // Validate accounts
  if (!toAccountId && !toPaymentMethodId) {
    throw new ValidationError('Either toAccountId or toPaymentMethodId must be provided');
  }
  
  const { data: fromAccount, error: fromError } = await supabase
    .from('accounts')
    .select('id, name')
    .eq('id', fromAccountId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fromError || !fromAccount) {
    throw new NotFoundError('Source account', fromAccountId);
  }

  if (toAccountId) {
    const { data: toAccount, error: toError } = await supabase
      .from('accounts')
      .select('id, name')
      .eq('id', toAccountId)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .single();
    
    if (toError || !toAccount) {
      throw new NotFoundError('Destination account', toAccountId);
    }
  }
  
  // Calculate next execution
  const startDateObj = new Date(startDate);
  const nextExecution = calculateNextExecution(
    frequency,
    intervalValue,
    dayOfMonth,
    dayOfWeek,
    null,
    startDateObj
  );
  
  // Create schedule
  const { data: schedule, error: createError } = await supabase
    .from('transfer_schedules')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      from_account_id: fromAccountId,
      to_account_id: toAccountId || null,
      to_payment_method_id: toPaymentMethodId || null,
      amount,
      currency,
      description,
      frequency,
      interval_value: intervalValue,
      day_of_month: dayOfMonth || null,
      day_of_week: dayOfWeek || null,
      timezone,
      start_date: startDate,
      end_date: endDate || null,
      max_occurrences: maxOccurrences || null,
      status: 'active',
      next_execution: nextExecution.toISOString(),
      retry_enabled: retryEnabled,
      max_retry_attempts: maxRetryAttempts,
      retry_window_days: retryWindowDays,
      initiated_by_type: ctx.actorType,
      initiated_by_id: ctx.actorId,
      initiated_by_name: ctx.actorName,
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating schedule:', createError);
    return c.json({ error: 'Failed to create schedule' }, 500);
  }
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer_schedule',
    entityId: schedule.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      frequency,
      amount,
      nextExecution: nextExecution.toISOString(),
    },
  });
  
  return c.json({ data: schedule }, 201);
});

// ============================================
// GET /v1/scheduled-transfers/:id - Get schedule
// ============================================
scheduledTransfers.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const scheduleId = c.req.param('id');
  
  if (!isValidUUID(scheduleId)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  
  const { data: schedule, error } = await supabase
    .from('transfer_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !schedule) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  // Get execution history (transfers created by this schedule)
  const { data: executions } = await supabase
    .from('transfers')
    .select('*')
    .eq('schedule_id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false })
    .limit(50);
  
  return c.json({
    data: {
      ...schedule,
      executions: executions || [],
    },
  });
});

// ============================================
// POST /v1/scheduled-transfers/:id/pause - Pause schedule
// ============================================
scheduledTransfers.post('/:id/pause', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const scheduleId = c.req.param('id');
  
  if (!isValidUUID(scheduleId)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  
  const { data: schedule, error: fetchError } = await supabase
    .from('transfer_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !schedule) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  if (schedule.status !== 'active') {
    throw new ValidationError(`Cannot pause schedule with status: ${schedule.status}`);
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('transfer_schedules')
    .update({
      status: 'paused',
      updated_at: new Date().toISOString(),
    })
    .eq('id', scheduleId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error pausing schedule:', updateError);
    return c.json({ error: 'Failed to pause schedule' }, 500);
  }
  
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer_schedule',
    entityId: scheduleId,
    action: 'paused',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({ data: updated });
});

// ============================================
// POST /v1/scheduled-transfers/:id/resume - Resume schedule
// ============================================
scheduledTransfers.post('/:id/resume', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const scheduleId = c.req.param('id');
  
  if (!isValidUUID(scheduleId)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  
  const { data: schedule, error: fetchError } = await supabase
    .from('transfer_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !schedule) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  if (schedule.status !== 'paused') {
    throw new ValidationError(`Cannot resume schedule with status: ${schedule.status}`);
  }
  
  // Recalculate next execution if needed
  let nextExecution = schedule.next_execution;
  if (!nextExecution || new Date(nextExecution) < new Date()) {
    const startDate = new Date(schedule.start_date);
    const lastExecution = schedule.last_execution ? new Date(schedule.last_execution) : null;
    nextExecution = calculateNextExecution(
      schedule.frequency,
      schedule.interval_value,
      schedule.day_of_month || undefined,
      schedule.day_of_week || undefined,
      lastExecution,
      startDate
    ).toISOString();
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('transfer_schedules')
    .update({
      status: 'active',
      next_execution: nextExecution,
      updated_at: new Date().toISOString(),
    })
    .eq('id', scheduleId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error resuming schedule:', updateError);
    return c.json({ error: 'Failed to resume schedule' }, 500);
  }
  
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer_schedule',
    entityId: scheduleId,
    action: 'resumed',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({ data: updated });
});

// ============================================
// POST /v1/scheduled-transfers/:id/cancel - Cancel schedule
// ============================================
scheduledTransfers.post('/:id/cancel', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const scheduleId = c.req.param('id');
  
  if (!isValidUUID(scheduleId)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  
  const { data: schedule, error: fetchError } = await supabase
    .from('transfer_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !schedule) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  if (schedule.status === 'cancelled' || schedule.status === 'completed') {
    throw new ValidationError(`Cannot cancel schedule with status: ${schedule.status}`);
  }
  
  const { data: updated, error: updateError } = await supabase
    .from('transfer_schedules')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString(),
    })
    .eq('id', scheduleId)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (updateError) {
    console.error('Error cancelling schedule:', updateError);
    return c.json({ error: 'Failed to cancel schedule' }, 500);
  }
  
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'transfer_schedule',
    entityId: scheduleId,
    action: 'cancelled',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
  });
  
  return c.json({ data: updated });
});

// ============================================
// POST /v1/scheduled-transfers/:id/execute-now - Execute immediately (demo mode)
// ============================================
scheduledTransfers.post('/:id/execute-now', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  const scheduleId = c.req.param('id');
  
  if (!isValidUUID(scheduleId)) {
    throw new ValidationError('Invalid schedule ID format');
  }
  
  // Verify schedule belongs to tenant
  const { data: schedule, error: fetchError } = await supabase
    .from('transfer_schedules')
    .select('*')
    .eq('id', scheduleId)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !schedule) {
    throw new NotFoundError('Schedule', scheduleId);
  }

  if (schedule.status !== 'active' && schedule.status !== 'paused') {
    throw new ValidationError(`Cannot execute schedule with status: ${schedule.status}`);
  }
  
  // Manually trigger execution
  const worker = getScheduledTransferWorker();
  try {
    await worker.triggerExecution(scheduleId);
    
    // Refresh schedule data
    const { data: updated } = await supabase
      .from('transfer_schedules')
      .select('*')
      .eq('id', scheduleId)
      .single();
    
    return c.json({
      data: updated,
      message: 'Schedule executed successfully',
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

export default scheduledTransfers;

