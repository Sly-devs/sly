/**
 * Webhook Management API
 * 
 * Endpoints for managing webhook subscriptions and viewing delivery status.
 * 
 * Story 27.5: Robust Webhook Delivery System
 * - Partner webhook testing interface
 * - Webhook delivery dashboard with success rate
 * - Event replay capability for debugging
 * - Webhook logs retention (30 days)
 * - Webhook health monitoring
 * 
 * @module routes/webhooks
 */

import { Hono } from 'hono';
import { z } from 'zod';
import crypto from 'crypto';
import { createClient } from '../db/client.js';
import { authMiddleware } from '../middleware/auth.js';
import { getEnv } from '../utils/helpers.js';

const app = new Hono();

// Apply auth middleware
app.use('*', authMiddleware);

// ============================================
// Validation Schemas
// ============================================

const createWebhookSchema = z.object({
  url: z.string().url(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  events: z.array(z.string()).min(1),
});

const updateWebhookSchema = z.object({
  url: z.string().url().optional(),
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  events: z.array(z.string()).min(1).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

const replayWebhookSchema = z.object({
  deliveryIds: z.array(z.string().uuid()).optional(),
  eventTypes: z.array(z.string()).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  status: z.enum(['failed', 'dlq', 'all']).optional().default('dlq'),
  limit: z.number().min(1).max(100).optional().default(10),
});

// ============================================
// Routes - Static paths FIRST (before parameterized routes)
// ============================================

/**
 * GET /v1/webhooks/stats
 * Get webhook delivery statistics for dashboard
 */
app.get('/stats', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();

    // Get date range (default: last 24 hours)
    const hoursBack = parseInt(c.req.query('hours') || '24');
    const startDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    // Get delivery counts by status
    const { data: statusCounts, error: statusError } = await supabase
      .from('webhook_deliveries')
      .select('status')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .gte('created_at', startDate);

    if (statusError) {
      console.error('[Webhooks] Stats error:', statusError);
      return c.json({ error: 'Failed to fetch stats' }, 500);
    }

    // Calculate stats
    const counts = {
      total: statusCounts?.length || 0,
      pending: 0,
      processing: 0,
      delivered: 0,
      failed: 0,
      dlq: 0,
    };

    statusCounts?.forEach((d: any) => {
      if (d.status in counts) {
        (counts as any)[d.status]++;
      }
    });

    const successRate = counts.total > 0 
      ? Math.round((counts.delivered / counts.total) * 10000) / 100 
      : 100;

    // Get endpoint health
    const { data: endpoints, error: endpointError } = await supabase
      .from('webhook_endpoints')
      .select('id, name, url, status, consecutive_failures, last_success_at, last_failure_at')
      .eq('tenant_id', ctx.tenantId);

    if (endpointError) {
      console.error('[Webhooks] Endpoint stats error:', endpointError);
      return c.json({ error: 'Failed to fetch endpoint stats' }, 500);
    }

    // Get recent failures with response info
    const { data: recentFailures, error: failureError } = await supabase
      .from('webhook_deliveries')
      .select('id, endpoint_url, event_type, last_response_code, last_response_body, last_attempt_at, attempts, status')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .in('status', ['failed', 'dlq'])
      .order('last_attempt_at', { ascending: false })
      .limit(10);

    return c.json({
      data: {
        period: {
          hours: hoursBack,
          startDate,
          endDate: new Date().toISOString(),
        },
        summary: {
          ...counts,
          successRate: `${successRate}%`,
          healthy: successRate >= 99.5,
        },
        endpoints: endpoints?.map((e) => ({
          ...e,
          health: e.status === 'active' && (e.consecutive_failures || 0) < 3 
            ? 'healthy' 
            : e.consecutive_failures >= 10 
              ? 'critical' 
              : 'degraded',
        })),
        recentFailures,
      },
    });
  } catch (error) {
    console.error('[Webhooks] Stats error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/webhooks/events
 * List all webhook event types
 */
app.get('/events', async (c) => {
  // Return supported event types
  return c.json({
    data: [
      // Transfer events
      { type: 'transfer.created', description: 'A new transfer was created' },
      { type: 'transfer.completed', description: 'A transfer was completed successfully' },
      { type: 'transfer.failed', description: 'A transfer failed' },
      { type: 'transfer.refunded', description: 'A transfer was refunded' },
      
      // x402 events
      { type: 'x402.payment.completed', description: 'An x402 payment was processed' },
      { type: 'x402.endpoint.created', description: 'A new x402 endpoint was registered' },
      
      // AP2 events
      { type: 'ap2.mandate.created', description: 'A new AP2 mandate was created' },
      { type: 'ap2.mandate.executed', description: 'An AP2 mandate was executed' },
      { type: 'ap2.mandate.revoked', description: 'An AP2 mandate was revoked' },
      
      // ACP events
      { type: 'acp.checkout.created', description: 'A new ACP checkout was created' },
      { type: 'acp.checkout.completed', description: 'An ACP checkout was completed' },
      { type: 'acp.checkout.expired', description: 'An ACP checkout expired' },
      
      // Account events
      { type: 'account.created', description: 'A new account was created' },
      { type: 'account.updated', description: 'An account was updated' },
      { type: 'account.balance.low', description: 'Account balance fell below threshold' },
      
      // Batch events
      { type: 'batch.created', description: 'A new batch was created' },
      { type: 'batch.processing', description: 'A batch is being processed' },
      { type: 'batch.completed', description: 'A batch was completed' },
      { type: 'batch.failed', description: 'A batch failed' },
      
      // Reconciliation events
      { type: 'reconciliation.completed', description: 'A reconciliation run completed' },
      { type: 'reconciliation.discrepancy', description: 'A discrepancy was detected' },
      
      // Settlement events
      { type: 'settlement.initiated', description: 'A settlement was initiated' },
      { type: 'settlement.completed', description: 'A settlement completed successfully' },
      { type: 'settlement.failed', description: 'A settlement failed' },
      
      // Test event
      { type: 'webhook.test', description: 'Test webhook event' },
      
      // Wildcard
      { type: '*', description: 'Subscribe to all events' },
    ],
  });
});

/**
 * POST /v1/webhooks/replay
 * Replay webhook events (for debugging)
 */
app.post('/replay', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();
    const validated = replayWebhookSchema.parse(body);
    
    const supabase = createClient();
    
    // Build query for deliveries to replay
    let query = supabase
      .from('webhook_deliveries')
      .select('id, endpoint_id, endpoint_url, event_type, event_id, payload')
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx));
    
    // Filter by specific delivery IDs
    if (validated.deliveryIds && validated.deliveryIds.length > 0) {
      query = query.in('id', validated.deliveryIds);
    }
    
    // Filter by event types
    if (validated.eventTypes && validated.eventTypes.length > 0) {
      query = query.in('event_type', validated.eventTypes);
    }
    
    // Filter by date range
    if (validated.startDate) {
      query = query.gte('created_at', validated.startDate);
    }
    if (validated.endDate) {
      query = query.lte('created_at', validated.endDate);
    }
    
    // Filter by status
    if (validated.status !== 'all') {
      query = query.eq('status', validated.status);
    } else {
      query = query.in('status', ['failed', 'dlq']);
    }
    
    query = query.order('created_at', { ascending: false }).limit(validated.limit);
    
    const { data: deliveries, error } = await query;
    
    if (error) {
      console.error('[Webhooks] Replay query error:', error);
      return c.json({ error: 'Failed to fetch deliveries for replay' }, 500);
    }
    
    if (!deliveries || deliveries.length === 0) {
      return c.json({ 
        data: { replayed: 0 }, 
        message: 'No matching deliveries found for replay' 
      });
    }
    
    // Create new delivery records for replay
    const replayedIds: string[] = [];
    
    for (const delivery of deliveries) {
      const newDelivery = {
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        endpoint_id: delivery.endpoint_id,
        endpoint_url: delivery.endpoint_url,
        event_type: delivery.event_type,
        event_id: delivery.event_id,
        payload: {
          ...delivery.payload,
          _replayed: true,
          _original_delivery_id: delivery.id,
          _replayed_at: new Date().toISOString(),
        },
        status: 'pending',
        idempotency_key: `replay_${delivery.id}_${Date.now()}`,
      };
      
      const { data: created, error: insertError } = await supabase
        .from('webhook_deliveries')
        .insert(newDelivery)
        .select('id')
        .single();
      
      if (created) {
        replayedIds.push(created.id);
      } else if (insertError) {
        console.error('[Webhooks] Replay insert error:', insertError);
      }
    }
    
    return c.json({
      data: {
        replayed: replayedIds.length,
        deliveryIds: replayedIds,
      },
      message: `${replayedIds.length} webhook(s) queued for replay`,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[Webhooks] Replay error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/webhooks/deliveries/dlq
 * List deliveries in Dead Letter Queue
 */
app.get('/deliveries/dlq', async (c) => {
  try {
    const ctx = c.get('ctx');
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;
    
    const supabase = createClient();
    
    const { data, error, count } = await supabase
      .from('webhook_deliveries')
      .select('*', { count: 'exact' })
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('status', 'dlq')
      .order('dlq_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      console.error('[Webhooks] DLQ list error:', error);
      return c.json({ error: 'Failed to fetch DLQ' }, 500);
    }
    
    return c.json({
      data,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error('[Webhooks] DLQ error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /v1/webhooks/deliveries/dlq
 * Purge Dead Letter Queue
 */
app.delete('/deliveries/dlq', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();
    
    // Only purge old DLQ items (>7 days)
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
      .from('webhook_deliveries')
      .delete()
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .eq('status', 'dlq')
      .lt('dlq_at', cutoff)
      .select('id');
    
    if (error) {
      console.error('[Webhooks] DLQ purge error:', error);
      return c.json({ error: 'Failed to purge DLQ' }, 500);
    }
    
    return c.json({
      data: { purged: data?.length || 0 },
      message: `${data?.length || 0} DLQ items purged (older than 7 days)`,
    });
  } catch (error) {
    console.error('[Webhooks] DLQ purge error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// Routes - CRUD for webhook endpoints
// ============================================

/**
 * POST /v1/webhooks
 * Create a new webhook endpoint
 */
app.post('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const body = await c.req.json();
    const validated = createWebhookSchema.parse(body);

    const supabase = createClient();

    // Generate webhook secret
    const secret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
    const secretPrefix = secret.slice(0, 12);

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .insert({
        tenant_id: ctx.tenantId,
        url: validated.url,
        name: validated.name,
        description: validated.description,
        events: validated.events,
        secret_hash: secretHash,
        secret_prefix: secretPrefix,
        status: 'active',
      })
      .select()
      .single();

    if (error) {
      console.error('[Webhooks] Create error:', error);
      return c.json({ error: 'Failed to create webhook endpoint' }, 500);
    }

    return c.json({
      data: {
        ...data,
        secret, // Only shown once!
        secret_hash: undefined,
      },
      message: 'Webhook endpoint created. Save the secret - it will not be shown again.',
    }, 201);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[Webhooks] Create error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/webhooks
 * List webhook endpoints
 */
app.get('/', async (c) => {
  try {
    const ctx = c.get('ctx');
    const supabase = createClient();

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select('*')
      .eq('tenant_id', ctx.tenantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Webhooks] List error:', error);
      return c.json({ error: 'Failed to fetch webhook endpoints' }, 500);
    }

    // Remove secret hash from response
    const sanitized = data.map(({ secret_hash, ...rest }) => rest);

    return c.json({ data: sanitized });
  } catch (error) {
    console.error('[Webhooks] List error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/webhooks/:id
 * Get webhook endpoint details
 */
app.get('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (error || !data) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }

    // Remove secret hash
    const { secret_hash, ...sanitized } = data;

    return c.json({ data: sanitized });
  } catch (error) {
    console.error('[Webhooks] Get error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * PATCH /v1/webhooks/:id
 * Update webhook endpoint
 */
app.patch('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const body = await c.req.json();
    const validated = updateWebhookSchema.parse(body);

    const supabase = createClient();

    const { data, error } = await supabase
      .from('webhook_endpoints')
      .update({
        ...validated,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .select()
      .single();

    if (error || !data) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }

    const { secret_hash, ...sanitized } = data;

    return c.json({ data: sanitized });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'Validation failed', details: error.errors }, 400);
    }
    console.error('[Webhooks] Update error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * DELETE /v1/webhooks/:id
 * Delete webhook endpoint
 */
app.delete('/:id', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    const { error } = await supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);

    if (error) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }

    return c.json({ message: 'Webhook endpoint deleted' });
  } catch (error) {
    console.error('[Webhooks] Delete error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/webhooks/:id/test
 * Send a test webhook
 */
app.post('/:id/test', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    // Verify endpoint exists
    const { data: endpoint, error } = await supabase
      .from('webhook_endpoints')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (error || !endpoint) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }

    // Queue test webhook
    const testEvent = {
      type: 'webhook.test',
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      data: {
        message: 'This is a test webhook from PayOS',
        endpoint_id: endpoint.id,
        endpoint_name: endpoint.name,
      },
    };

    const { error: queueError } = await supabase
      .from('webhook_deliveries')
      .insert({
        tenant_id: ctx.tenantId,
        environment: getEnv(ctx),
        endpoint_id: endpoint.id,
        endpoint_url: endpoint.url,
        event_type: 'webhook.test',
        event_id: testEvent.id,
        payload: testEvent,
        status: 'pending',
      });

    if (queueError) {
      console.error('[Webhooks] Test webhook queue error:', queueError);
      return c.json({ error: 'Failed to queue test webhook' }, 500);
    }

    return c.json({
      message: 'Test webhook queued for delivery',
      event: testEvent,
    });
  } catch (error) {
    console.error('[Webhooks] Test error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * GET /v1/webhooks/:id/deliveries
 * List deliveries for a webhook endpoint
 */
app.get('/:id/deliveries', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const page = parseInt(c.req.query('page') || '1');
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
    const offset = (page - 1) * limit;

    const supabase = createClient();

    // Verify endpoint exists
    const { data: endpoint } = await supabase
      .from('webhook_endpoints')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();

    if (!endpoint) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }

    // Fetch deliveries
    const { data, error, count } = await supabase
      .from('webhook_deliveries')
      .select('*', { count: 'exact' })
      .eq('endpoint_id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('[Webhooks] Deliveries list error:', error);
      return c.json({ error: 'Failed to fetch deliveries' }, 500);
    }

    return c.json({
      data,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    });
  } catch (error) {
    console.error('[Webhooks] Deliveries error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/webhooks/deliveries/:id/retry
 * Manually retry a failed delivery
 */
app.post('/deliveries/:id/retry', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();

    // Update delivery to pending status
    const { data, error } = await supabase
      .from('webhook_deliveries')
      .update({
        status: 'pending',
        next_retry_at: null,
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .in('status', ['failed', 'dlq'])
      .select()
      .single();

    if (error || !data) {
      return c.json({ error: 'Delivery not found or not retryable' }, 404);
    }

    return c.json({
      message: 'Delivery queued for retry',
      data,
    });
  } catch (error) {
    console.error('[Webhooks] Retry error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

// ============================================
// Parameterized routes LAST - for specific endpoint operations
// ============================================

/**
 * GET /v1/webhooks/:id/health
 * Get health status for a specific webhook endpoint
 */
app.get('/:id/health', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();
    
    // Get endpoint details
    const { data: endpoint, error: endpointError } = await supabase
      .from('webhook_endpoints')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();
    
    if (endpointError || !endpoint) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }
    
    // Get delivery stats for last 24 hours
    const startDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    
    const { data: deliveries, error: deliveryError } = await supabase
      .from('webhook_deliveries')
      .select('status, last_response_code, last_response_time_ms, created_at')
      .eq('endpoint_id', id)
      .eq('tenant_id', ctx.tenantId)
      .eq('environment', getEnv(ctx))
      .gte('created_at', startDate);
    
    if (deliveryError) {
      console.error('[Webhooks] Health check error:', deliveryError);
      return c.json({ error: 'Failed to fetch health data' }, 500);
    }
    
    // Calculate health metrics
    const total = deliveries?.length || 0;
    const delivered = deliveries?.filter((d: any) => d.status === 'delivered').length || 0;
    const failed = deliveries?.filter((d: any) => d.status === 'failed' || d.status === 'dlq').length || 0;
    const avgResponseTime = deliveries && deliveries.length > 0
      ? Math.round(
          deliveries
            .filter((d: any) => d.last_response_time_ms)
            .reduce((sum: number, d: any) => sum + (d.last_response_time_ms || 0), 0) / 
          deliveries.filter((d: any) => d.last_response_time_ms).length || 1
        )
      : 0;
    
    const successRate = total > 0 ? Math.round((delivered / total) * 10000) / 100 : 100;
    
    // Determine health status
    let health: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (endpoint.status !== 'active') {
      health = 'critical';
    } else if (endpoint.consecutive_failures >= 10) {
      health = 'critical';
    } else if (endpoint.consecutive_failures >= 3 || successRate < 95) {
      health = 'degraded';
    }
    
    return c.json({
      data: {
        endpoint: {
          id: endpoint.id,
          name: endpoint.name,
          url: endpoint.url,
          status: endpoint.status,
          consecutiveFailures: endpoint.consecutive_failures,
          lastSuccessAt: endpoint.last_success_at,
          lastFailureAt: endpoint.last_failure_at,
        },
        health,
        metrics: {
          period: '24h',
          total,
          delivered,
          failed,
          pending: total - delivered - failed,
          successRate: `${successRate}%`,
          avgResponseTimeMs: avgResponseTime,
        },
        recommendations: health !== 'healthy' ? [
          endpoint.consecutive_failures >= 3 
            ? 'Check endpoint availability and error logs' 
            : null,
          successRate < 95 
            ? 'Review recent failed deliveries for error patterns' 
            : null,
          avgResponseTime > 5000 
            ? 'Endpoint response time is slow, consider optimization' 
            : null,
        ].filter(Boolean) : [],
      },
    });
  } catch (error) {
    console.error('[Webhooks] Health check error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * POST /v1/webhooks/:id/rotate-secret
 * Rotate webhook signing secret
 */
app.post('/:id/rotate-secret', async (c) => {
  try {
    const ctx = c.get('ctx');
    const { id } = c.req.param();
    const supabase = createClient();
    
    // Verify endpoint exists
    const { data: endpoint, error } = await supabase
      .from('webhook_endpoints')
      .select('id')
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId)
      .single();
    
    if (error || !endpoint) {
      return c.json({ error: 'Webhook endpoint not found' }, 404);
    }
    
    // Generate new secret
    const newSecret = `whsec_${crypto.randomBytes(32).toString('hex')}`;
    const newSecretHash = crypto.createHash('sha256').update(newSecret).digest('hex');
    const newSecretPrefix = newSecret.slice(0, 12);
    
    // Update endpoint with new secret
    const { error: updateError } = await supabase
      .from('webhook_endpoints')
      .update({
        secret_hash: newSecretHash,
        secret_prefix: newSecretPrefix,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('tenant_id', ctx.tenantId);
    
    if (updateError) {
      console.error('[Webhooks] Secret rotation error:', updateError);
      return c.json({ error: 'Failed to rotate secret' }, 500);
    }
    
    return c.json({
      data: {
        secret: newSecret, // Only shown once!
        secretPrefix: newSecretPrefix,
      },
      message: 'Webhook secret rotated. Save the new secret - it will not be shown again.',
    });
  } catch (error) {
    console.error('[Webhooks] Secret rotation error:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default app;

