import { Hono } from 'hono';
import { z } from 'zod';
import { createClient } from '../db/client.js';
import {
  mapStreamFromDb,
  logAudit,
  isValidUUID,
  getPaginationParams,
  paginationResponse,
  getEnv,
} from '../utils/helpers.js';
import { createBalanceService } from '../services/balances.js';
import { createLimitService } from '../services/limits.js';
import {
  calculateStreamState,
  calculateBuffer,
  calculateMinimumFunding,
  logStreamEvent,
  updateStreamState,
} from '../services/streams.js';
import { ValidationError, NotFoundError, InsufficientBalanceError } from '../middleware/error.js';

const streams = new Hono();

// ============================================
// VALIDATION SCHEMAS
// ============================================

const createStreamSchema = z.object({
  senderAccountId: z.string().uuid(),
  receiverAccountId: z.string().uuid(),
  flowRatePerMonth: z.number().positive(),
  fundingAmount: z.number().positive().optional(), // If not provided, uses minimum funding
  description: z.string().max(500).optional(),
  category: z.enum(['payroll', 'subscription', 'rental', 'services', 'other']).optional(),
});

const topUpSchema = z.object({
  amount: z.number().positive(),
});

const withdrawSchema = z.object({
  amount: z.number().positive().optional(), // If not provided, withdraws all available
});

// ============================================
// GET /v1/streams - List streams
// ============================================
streams.get('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Parse query params
  const query = c.req.query();
  const { page, limit } = getPaginationParams(query);
  const status = query.status;
  const health = query.health;
  const category = query.category;
  
  let dbQuery = supabase
    .from('streams')
    .select('*', { count: 'exact' })
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .order('created_at', { ascending: false });
  
  if (status) {
    dbQuery = dbQuery.eq('status', status);
  }
  // Note: health filter is applied AFTER real-time calculation
  if (category) {
    dbQuery = dbQuery.eq('category', category);
  }
  
  const { data, error } = await dbQuery;
  
  if (error) {
    console.error('Error fetching streams:', error);
    return c.json({ error: 'Failed to fetch streams' }, 500);
  }
  
  // Calculate real-time state for each stream
  let streams = (data || []).map(row => {
    const stream = mapStreamFromDb(row);
    
    // Update with real-time calculation for active streams
    if (row.status === 'active') {
      const calculation = calculateStreamState({
        status: row.status,
        startedAt: row.started_at,
        totalStreamed: parseFloat(row.total_streamed) || 0,
        totalWithdrawn: parseFloat(row.total_withdrawn) || 0,
        totalPausedSeconds: row.total_paused_seconds || 0,
        flowRatePerSecond: parseFloat(row.flow_rate_per_second),
        fundedAmount: parseFloat(row.funded_amount),
        bufferAmount: parseFloat(row.buffer_amount),
        pausedAt: row.paused_at,
      });
      
      stream.streamed = {
        total: calculation.balance.total,
        withdrawn: calculation.balance.withdrawn,
        available: calculation.balance.available,
      };
      stream.funding.runway = {
        seconds: calculation.runway.seconds,
        display: calculation.runway.display,
      };
      stream.health = calculation.runway.health;
    }
    
    return stream;
  });
  
  // Apply health filter AFTER real-time calculation (since health changes dynamically)
  if (health) {
    streams = streams.filter(s => s.health === health);
  }
  
  // Apply pagination after filtering
  const total = streams.length;
  const paginatedStreams = streams.slice((page - 1) * limit, page * limit);
  
  return c.json(paginationResponse(paginatedStreams, total, { page, limit }));
});

// ============================================
// POST /v1/streams - Create stream
// ============================================
streams.post('/', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  // Check for idempotency
  const idempotencyKey = c.req.header('X-Idempotency-Key');
  
  if (idempotencyKey) {
    const { data: existing } = await supabase
      .from('streams')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('idempotency_key', idempotencyKey)
      .single();
    
    if (existing) {
      return c.json({ data: mapStreamFromDb(existing) });
    }
  }
  
  // Parse and validate
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = createStreamSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { senderAccountId, receiverAccountId, flowRatePerMonth, fundingAmount, description, category } = parsed.data;
  
  // Can't stream to self
  if (senderAccountId === receiverAccountId) {
    throw new ValidationError('Cannot create stream to the same account');
  }
  
  // Validate accounts
  const [senderResult, receiverResult] = await Promise.all([
    supabase
      .from('accounts')
      .select('id, name, balance_available, tenant_id')
      .eq('id', senderAccountId)
      .eq('environment', getEnv(ctx))
      .single(),
    supabase
      .from('accounts')
      .select('id, name, tenant_id')
      .eq('id', receiverAccountId)
      .eq('environment', getEnv(ctx))
      .single(),
  ]);
  
  if (senderResult.error || !senderResult.data) {
    throw new NotFoundError('Sender account', senderAccountId);
  }
  if (receiverResult.error || !receiverResult.data) {
    throw new NotFoundError('Receiver account', receiverAccountId);
  }
  
  const sender = senderResult.data;
  const receiver = receiverResult.data;
  
  // Verify same tenant
  if (sender.tenant_id !== ctx.tenantId || receiver.tenant_id !== ctx.tenantId) {
    throw new ValidationError('Both accounts must belong to your tenant');
  }
  
  // Calculate flow rate per second
  const flowRatePerSecond = flowRatePerMonth / (30 * 24 * 60 * 60);
  
  // Calculate buffer and minimum funding
  const bufferAmount = calculateBuffer(flowRatePerSecond);
  const minimumFunding = calculateMinimumFunding(flowRatePerSecond);
  const actualFunding = fundingAmount || minimumFunding;
  
  if (actualFunding < minimumFunding) {
    throw new ValidationError('Insufficient funding amount', {
      provided: actualFunding,
      minimum: minimumFunding,
      buffer: bufferAmount,
      note: 'Minimum funding is buffer (4 hours) + 7 days runway',
    });
  }
  
  // Check sender has sufficient balance
  const availableBalance = parseFloat(sender.balance_available) || 0;
  if (availableBalance < actualFunding) {
    throw new InsufficientBalanceError(availableBalance, actualFunding);
  }
  
  // If agent is creating, check limits
  if (ctx.actorType === 'agent') {
    const limitService = createLimitService(supabase);
    const limitCheck = await limitService.checkStreamLimit(ctx.actorId, flowRatePerMonth);
    
    if (!limitCheck.allowed) {
      throw new ValidationError(`Stream creation blocked: ${limitCheck.reason}`, {
        limitType: limitCheck.limitType,
        limit: limitCheck.limit,
        used: limitCheck.used,
        requested: limitCheck.requested,
      });
    }
  }
  
  // Calculate initial runway
  const runwaySeconds = Math.floor(actualFunding / flowRatePerSecond);
  
  // Create stream
  const now = new Date().toISOString();
  const { data: stream, error: createError } = await supabase
    .from('streams')
    .insert({
      tenant_id: ctx.tenantId,
      environment: getEnv(ctx),
      status: 'active',
      sender_account_id: senderAccountId,
      sender_account_name: sender.name,
      receiver_account_id: receiverAccountId,
      receiver_account_name: receiver.name,
      initiated_by_type: ctx.actorType,
      initiated_by_id: ctx.actorId,
      initiated_by_name: ctx.actorName,
      initiated_at: now,
      managed_by_type: ctx.actorType,
      managed_by_id: ctx.actorId,
      managed_by_name: ctx.actorName,
      managed_by_can_modify: true,
      managed_by_can_pause: true,
      managed_by_can_terminate: true,
      flow_rate_per_second: flowRatePerSecond,
      flow_rate_per_month: flowRatePerMonth,
      currency: 'USDC',
      funded_amount: actualFunding,
      buffer_amount: bufferAmount,
      total_streamed: 0,
      total_withdrawn: 0,
      total_paused_seconds: 0,
      runway_seconds: runwaySeconds,
      health: runwaySeconds > 7 * 24 * 60 * 60 ? 'healthy' : runwaySeconds > 24 * 60 * 60 ? 'warning' : 'critical',
      description: description || null,
      category: category || 'other',
      started_at: now,
      idempotency_key: idempotencyKey,
    })
    .select()
    .single();
  
  if (createError) {
    console.error('Error creating stream:', createError);
    return c.json({ error: 'Failed to create stream' }, 500);
  }
  
  // Hold funds from sender
  const balanceService = createBalanceService(supabase);
  try {
    await balanceService.holdForStream(senderAccountId, stream.id, actualFunding, bufferAmount);
  } catch (error: any) {
    // Rollback stream creation
    await supabase.from('streams').delete().eq('id', stream.id).eq('environment', getEnv(ctx));
    throw error;
  }
  
  // Update agent stream stats if applicable
  if (ctx.actorType === 'agent') {
    const limitService = createLimitService(supabase);
    await limitService.updateAgentStreamStats(ctx.actorId, 1, flowRatePerMonth);
  }
  
  // Log stream event
  await logStreamEvent(supabase, stream.id, ctx.tenantId, 'created', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, {
    fundedAmount: actualFunding,
    flowRatePerMonth,
    runwaySeconds,
  });
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'stream',
    entityId: stream.id,
    action: 'created',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: {
      sender: sender.name,
      receiver: receiver.name,
      flowRatePerMonth,
      fundedAmount: actualFunding,
    },
  });
  
  return c.json({ data: mapStreamFromDb(stream) }, 201);
});

// ============================================
// GET /v1/streams/:id - Get single stream
// ============================================
streams.get('/:id', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  const { data, error } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (error || !data) {
    throw new NotFoundError('Stream', id);
  }

  const stream = mapStreamFromDb(data);

  // Calculate real-time state
  if (data.status === 'active') {
    const calculation = calculateStreamState({
      status: data.status,
      startedAt: data.started_at,
      totalStreamed: parseFloat(data.total_streamed) || 0,
      totalWithdrawn: parseFloat(data.total_withdrawn) || 0,
      totalPausedSeconds: data.total_paused_seconds || 0,
      flowRatePerSecond: parseFloat(data.flow_rate_per_second),
      fundedAmount: parseFloat(data.funded_amount),
      bufferAmount: parseFloat(data.buffer_amount),
      pausedAt: data.paused_at,
    });
    
    stream.streamed = {
      total: calculation.balance.total,
      withdrawn: calculation.balance.withdrawn,
      available: calculation.balance.available,
    };
    stream.funding.runway = {
      seconds: calculation.runway.seconds,
      display: calculation.runway.display,
    };
    stream.health = calculation.runway.health;
  }
  
  return c.json({ data: stream });
});

// ============================================
// POST /v1/streams/:id/pause - Pause stream
// ============================================
streams.post('/:id/pause', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  const { data: stream, error: fetchError } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !stream) {
    throw new NotFoundError('Stream', id);
  }

  if (stream.status !== 'active') {
    throw new ValidationError(`Cannot pause stream with status: ${stream.status}`);
  }
  
  // Check permissions if agent
  if (ctx.actorType === 'agent' && stream.managed_by_type === 'agent' && stream.managed_by_id !== ctx.actorId) {
    throw new ValidationError('You do not have permission to pause this stream');
  }
  
  // Calculate current streamed amount before pausing
  const calculation = calculateStreamState({
    status: stream.status,
    startedAt: stream.started_at,
    totalStreamed: parseFloat(stream.total_streamed) || 0,
    totalWithdrawn: parseFloat(stream.total_withdrawn) || 0,
    totalPausedSeconds: stream.total_paused_seconds || 0,
    flowRatePerSecond: parseFloat(stream.flow_rate_per_second),
    fundedAmount: parseFloat(stream.funded_amount),
    bufferAmount: parseFloat(stream.buffer_amount),
    pausedAt: stream.paused_at,
  });
  
  const now = new Date().toISOString();
  
  const { data, error } = await supabase
    .from('streams')
    .update({
      status: 'paused',
      paused_at: now,
      total_streamed: calculation.balance.total,
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (error) {
    console.error('Error pausing stream:', error);
    return c.json({ error: 'Failed to pause stream' }, 500);
  }
  
  // Log event
  await logStreamEvent(supabase, id, ctx.tenantId, 'paused', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, { totalStreamed: calculation.balance.total });
  
  return c.json({ data: mapStreamFromDb(data) });
});

// ============================================
// POST /v1/streams/:id/resume - Resume stream
// ============================================
streams.post('/:id/resume', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  const { data: stream, error: fetchError } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !stream) {
    throw new NotFoundError('Stream', id);
  }

  if (stream.status !== 'paused') {
    throw new ValidationError(`Cannot resume stream with status: ${stream.status}`);
  }
  
  // Calculate paused duration
  const pausedAt = new Date(stream.paused_at).getTime();
  const now = Date.now();
  const pausedSeconds = Math.floor((now - pausedAt) / 1000);
  const totalPausedSeconds = (stream.total_paused_seconds || 0) + pausedSeconds;
  
  const { data, error } = await supabase
    .from('streams')
    .update({
      status: 'active',
      paused_at: null,
      total_paused_seconds: totalPausedSeconds,
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (error) {
    console.error('Error resuming stream:', error);
    return c.json({ error: 'Failed to resume stream' }, 500);
  }
  
  // Log event
  await logStreamEvent(supabase, id, ctx.tenantId, 'resumed', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, { pausedSeconds, totalPausedSeconds });
  
  return c.json({ data: mapStreamFromDb(data) });
});

// ============================================
// POST /v1/streams/:id/cancel - Cancel stream
// ============================================
streams.post('/:id/cancel', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  const { data: stream, error: fetchError } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !stream) {
    throw new NotFoundError('Stream', id);
  }

  if (stream.status === 'cancelled') {
    throw new ValidationError('Stream is already cancelled');
  }
  
  // Calculate final state
  const calculation = calculateStreamState({
    status: stream.status,
    startedAt: stream.started_at,
    totalStreamed: parseFloat(stream.total_streamed) || 0,
    totalWithdrawn: parseFloat(stream.total_withdrawn) || 0,
    totalPausedSeconds: stream.total_paused_seconds || 0,
    flowRatePerSecond: parseFloat(stream.flow_rate_per_second),
    fundedAmount: parseFloat(stream.funded_amount),
    bufferAmount: parseFloat(stream.buffer_amount),
    pausedAt: stream.paused_at,
  });
  
  const now = new Date().toISOString();
  
  // Update stream status
  const { data, error } = await supabase
    .from('streams')
    .update({
      status: 'cancelled',
      cancelled_at: now,
      total_streamed: calculation.balance.total,
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (error) {
    console.error('Error cancelling stream:', error);
    return c.json({ error: 'Failed to cancel stream' }, 500);
  }
  
  // Release funds back to sender
  const balanceService = createBalanceService(supabase);
  const returnBuffer = parseFloat(stream.buffer_amount);
  await balanceService.releaseFromStream(
    stream.sender_account_id,
    id,
    calculation.balance.total,
    returnBuffer
  );
  
  // Update agent stream stats if applicable
  if (stream.managed_by_type === 'agent') {
    const limitService = createLimitService(supabase);
    await limitService.updateAgentStreamStats(
      stream.managed_by_id,
      -1,
      -parseFloat(stream.flow_rate_per_month)
    );
  }
  
  // Log event
  await logStreamEvent(supabase, id, ctx.tenantId, 'cancelled', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, {
    totalStreamed: calculation.balance.total,
    totalWithdrawn: calculation.balance.withdrawn,
    returnedToSender: parseFloat(stream.funded_amount) - calculation.balance.total,
  });
  
  // Audit log
  await logAudit(supabase, {
    tenantId: ctx.tenantId,
    entityType: 'stream',
    entityId: id,
    action: 'cancelled',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    actorName: ctx.actorName,
    metadata: { totalStreamed: calculation.balance.total },
  });
  
  return c.json({ data: mapStreamFromDb(data) });
});

// ============================================
// POST /v1/streams/:id/top-up - Add funds
// ============================================
streams.post('/:id/top-up', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  
  const parsed = topUpSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { amount } = parsed.data;
  
  const { data: stream, error: fetchError } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !stream) {
    throw new NotFoundError('Stream', id);
  }

  if (stream.status === 'cancelled') {
    throw new ValidationError('Cannot top-up cancelled stream');
  }
  
  // Check sender has sufficient balance
  const { data: sender } = await supabase
    .from('accounts')
    .select('balance_available')
    .eq('id', stream.sender_account_id)
    .eq('environment', getEnv(ctx))
    .single();
  
  const availableBalance = parseFloat(sender?.balance_available) || 0;
  if (availableBalance < amount) {
    throw new InsufficientBalanceError(availableBalance, amount);
  }
  
  // Calculate new funding and runway
  const newFundedAmount = parseFloat(stream.funded_amount) + amount;
  const flowRatePerSecond = parseFloat(stream.flow_rate_per_second);
  
  // Current streamed
  const calculation = calculateStreamState({
    status: stream.status,
    startedAt: stream.started_at,
    totalStreamed: parseFloat(stream.total_streamed) || 0,
    totalWithdrawn: parseFloat(stream.total_withdrawn) || 0,
    totalPausedSeconds: stream.total_paused_seconds || 0,
    flowRatePerSecond,
    fundedAmount: parseFloat(stream.funded_amount),
    bufferAmount: parseFloat(stream.buffer_amount),
    pausedAt: stream.paused_at,
  });
  
  const newRunwaySeconds = Math.floor((newFundedAmount - calculation.balance.total) / flowRatePerSecond);
  
  // Update stream
  const { data, error } = await supabase
    .from('streams')
    .update({
      funded_amount: newFundedAmount,
      runway_seconds: newRunwaySeconds,
      health: newRunwaySeconds > 7 * 24 * 60 * 60 ? 'healthy' : newRunwaySeconds > 24 * 60 * 60 ? 'warning' : 'critical',
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();

  if (error) {
    console.error('Error updating stream:', error);
    return c.json({ error: 'Failed to top-up stream' }, 500);
  }
  
  // Hold additional funds
  const balanceService = createBalanceService(supabase);
  await balanceService.holdForStream(stream.sender_account_id, id, amount, 0);
  
  // Log event
  await logStreamEvent(supabase, id, ctx.tenantId, 'topped_up', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, { amount, newFundedAmount, newRunwaySeconds });
  
  return c.json({ data: mapStreamFromDb(data) });
});

// ============================================
// POST /v1/streams/:id/withdraw - Withdraw funds
// ============================================
streams.post('/:id/withdraw', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  let body;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  
  const parsed = withdrawSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  
  const { data: stream, error: fetchError } = await supabase
    .from('streams')
    .select('*')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();

  if (fetchError || !stream) {
    throw new NotFoundError('Stream', id);
  }

  // Calculate current available balance
  const calculation = calculateStreamState({
    status: stream.status,
    startedAt: stream.started_at,
    totalStreamed: parseFloat(stream.total_streamed) || 0,
    totalWithdrawn: parseFloat(stream.total_withdrawn) || 0,
    totalPausedSeconds: stream.total_paused_seconds || 0,
    flowRatePerSecond: parseFloat(stream.flow_rate_per_second),
    fundedAmount: parseFloat(stream.funded_amount),
    bufferAmount: parseFloat(stream.buffer_amount),
    pausedAt: stream.paused_at,
  });
  
  const availableToWithdraw = calculation.balance.available;
  const withdrawAmount = parsed.data?.amount ?? availableToWithdraw;
  
  if (withdrawAmount <= 0) {
    throw new ValidationError('No funds available to withdraw', {
      available: availableToWithdraw,
    });
  }
  
  if (withdrawAmount > availableToWithdraw) {
    throw new ValidationError('Insufficient available balance', {
      requested: withdrawAmount,
      available: availableToWithdraw,
    });
  }
  
  // Update stream
  const newTotalWithdrawn = parseFloat(stream.total_withdrawn) + withdrawAmount;
  const { data, error } = await supabase
    .from('streams')
    .update({
      total_withdrawn: newTotalWithdrawn,
      total_streamed: calculation.balance.total, // Update with current calculation
    })
    .eq('id', id)
    .eq('environment', getEnv(ctx))
    .select()
    .single();
  
  if (error) {
    console.error('Error updating stream:', error);
    return c.json({ error: 'Failed to withdraw from stream' }, 500);
  }
  
  // Credit receiver account
  const balanceService = createBalanceService(supabase);
  await balanceService.credit({
    accountId: stream.receiver_account_id,
    amount: withdrawAmount,
    referenceType: 'stream_withdrawal',
    referenceId: id,
    description: `Stream withdrawal from ${stream.sender_account_name}`,
  });
  
  // Log event
  await logStreamEvent(supabase, id, ctx.tenantId, 'withdrawn', {
    type: ctx.actorType,
    id: ctx.actorId,
    name: ctx.actorName,
  }, {
    amount: withdrawAmount,
    newTotalWithdrawn,
    remainingAvailable: calculation.balance.total - newTotalWithdrawn,
  });
  
  return c.json({
    data: mapStreamFromDb(data),
    withdrawal: {
      amount: withdrawAmount,
      recipientAccountId: stream.receiver_account_id,
      recipientAccountName: stream.receiver_account_name,
    },
  });
});

// ============================================
// GET /v1/streams/:id/events - Stream events
// ============================================
streams.get('/:id/events', async (c) => {
  const ctx = c.get('ctx');
  const id = c.req.param('id');
  const supabase = createClient();
  
  if (!isValidUUID(id)) {
    throw new ValidationError('Invalid stream ID format');
  }
  
  // Verify stream exists
  const { data: stream } = await supabase
    .from('streams')
    .select('id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx))
    .single();
  
  if (!stream) {
    throw new NotFoundError('Stream', id);
  }
  
  const { data, error } = await supabase
    .from('stream_events')
    .select('*')
    .eq('stream_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (error) {
    console.error('Error fetching stream events:', error);
    return c.json({ error: 'Failed to fetch events' }, 500);
  }
  
  const events = (data || []).map(row => ({
    id: row.id,
    streamId: row.stream_id,
    type: row.event_type,
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      name: row.actor_name,
    },
    data: row.data,
    createdAt: row.created_at,
  }));
  
  return c.json({ data: events });
});

// ============================================
// GET /v1/streams/stats - Aggregate stats
// ============================================
streams.get('/stats', async (c) => {
  const ctx = c.get('ctx');
  const supabase = createClient();
  
  const { data: streams } = await supabase
    .from('streams')
    .select('status, flow_rate_per_month, funded_amount, total_streamed')
    .eq('tenant_id', ctx.tenantId)
    .eq('environment', getEnv(ctx));
  
  const stats = {
    total: streams?.length || 0,
    byStatus: {
      active: 0,
      paused: 0,
      cancelled: 0,
    },
    totalFlowPerMonth: 0,
    totalFunded: 0,
    totalStreamed: 0,
  };
  
  for (const stream of streams || []) {
    if (stream.status === 'active') stats.byStatus.active++;
    else if (stream.status === 'paused') stats.byStatus.paused++;
    else if (stream.status === 'cancelled') stats.byStatus.cancelled++;
    
    if (stream.status === 'active') {
      stats.totalFlowPerMonth += parseFloat(stream.flow_rate_per_month) || 0;
    }
    stats.totalFunded += parseFloat(stream.funded_amount) || 0;
    stats.totalStreamed += parseFloat(stream.total_streamed) || 0;
  }
  
  return c.json({ data: stats });
});

export default streams;
