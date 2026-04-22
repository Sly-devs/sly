/**
 * MCP Server Factory
 *
 * Creates a configured MCP Server instance that can be connected
 * to any transport (stdio, HTTP, etc.).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { Sly } from '@sly_ai/sdk';
import { tools } from './tools.js';

/**
 * Mutable runtime context for the MCP server.
 * Allows switching environments (sandbox ↔ production) without restart.
 */
export interface McpContext {
  sly: Sly;
  apiUrl: string;
  apiKey: string;
  environment: string;
  keys: Record<string, string>;
  urls: Record<string, string>;
}

/**
 * Create an MCP Server with all Sly tools registered.
 */
export function createMcpServer(
  sly: Sly,
  apiUrl: string,
  apiKey: string,
  keys?: Record<string, string>,
  urls?: Record<string, string>,
): Server {
  const ctx: McpContext = {
    sly,
    apiUrl,
    apiKey,
    environment: apiKey.startsWith('pk_live_') ? 'production' : 'sandbox',
    keys: keys || {},
    urls: urls || {},
  };
  const server = new Server(
    {
      name: '@sly/mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: [
        'This is the Sly payment platform MCP server.',
        '"Accounts" in this system are merchant or entity records within the tenant\'s own payment ledger — NOT user accounts on external services.',
        'Creating, updating, and listing accounts are standard data-management operations authorized by the tenant\'s API key.',
        'These tools manage the tenant\'s own internal data. They do not sign up for external services, create login credentials, or register on third-party platforms.',
      ].join(' '),
    }
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  // Register tool execution handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
    switch (name) {
      case 'get_settlement_quote': {
        const quote = await ctx.sly.getSettlementQuote(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(quote, null, 2),
            },
          ],
        };
      }

      case 'create_settlement': {
        const settlement = await ctx.sly.createSettlement(args as any);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(settlement, null, 2),
            },
          ],
        };
      }

      case 'get_settlement_status': {
        const { settlementId } = args as { settlementId: string };
        const settlement = await ctx.sly.getSettlement(settlementId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(settlement, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // UCP Tools
      // ======================================================================

      case 'ucp_discover': {
        const { merchantUrl } = args as { merchantUrl: string };
        const profile = await ctx.sly.ucp.discover(merchantUrl);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(profile, null, 2),
            },
          ],
        };
      }

      case 'ucp_create_checkout': {
        const {
          currency, line_items, buyer, shipping_address, payment_config,
          payment_instruments, checkout_type, metadata, agent_id,
        } = args as {
          currency: string;
          line_items: Array<{ id?: string; name: string; quantity: number; unit_price: number; total_price: number; description?: string; image_url?: string; product_url?: string }>;
          buyer?: { email?: string; name?: string; phone?: string };
          shipping_address?: { line1: string; line2?: string; city: string; state?: string; postal_code: string; country: string };
          payment_config?: { handlers?: string[]; default_handler?: string; capture_method?: string };
          payment_instruments?: Array<{ id: string; handler: string; type: string; last4?: string; brand?: string }>;
          checkout_type?: 'physical' | 'digital' | 'service';
          metadata?: Record<string, any>;
          agent_id?: string;
        };
        const body: Record<string, any> = { currency, line_items, buyer, shipping_address, payment_config, metadata };
        if (payment_instruments) body.payment_instruments = payment_instruments;
        if (checkout_type) body.checkout_type = checkout_type;
        if (agent_id) body.agent_id = agent_id;
        const result = await ctx.sly.request('/v1/ucp/checkouts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_get_checkout': {
        const { checkoutId } = args as { checkoutId: string };
        const result = await ctx.sly.request(`/v1/ucp/checkouts/${checkoutId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_list_checkouts': {
        const params = new URLSearchParams();
        if (args && (args as any).status) params.set('status', (args as any).status);
        if (args && (args as any).agent_id) params.set('agent_id', (args as any).agent_id);
        if (args && (args as any).page) params.set('page', String((args as any).page));
        if (args && (args as any).limit) params.set('limit', String((args as any).limit));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/ucp/checkouts${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_update_checkout': {
        const { checkoutId, ...updates } = args as {
          checkoutId: string;
          line_items?: any[];
          buyer?: any;
          shipping_address?: any;
          billing_address?: any;
          metadata?: any;
        };
        const result = await ctx.sly.request(`/v1/ucp/checkouts/${checkoutId}`, {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_complete_checkout': {
        const { checkoutId } = args as { checkoutId: string };
        const result = await ctx.sly.request(`/v1/ucp/checkouts/${checkoutId}/complete`, {
          method: 'POST',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_cancel_checkout': {
        const { checkoutId } = args as { checkoutId: string };
        const result = await ctx.sly.request(`/v1/ucp/checkouts/${checkoutId}/cancel`, {
          method: 'POST',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_add_payment_instrument': {
        const { checkoutId, id: instrumentId, handler, type: instrumentType, last4, brand, metadata } = args as {
          checkoutId: string;
          id: string;
          handler: string;
          type: string;
          last4?: string;
          brand?: string;
          metadata?: Record<string, any>;
        };
        const result = await ctx.sly.request(`/v1/ucp/checkouts/${checkoutId}/instruments`, {
          method: 'POST',
          body: JSON.stringify({ id: instrumentId, handler, type: instrumentType, last4, brand, metadata }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_batch_checkout': {
        const { checkouts } = args as {
          checkouts: Array<{
            currency: string;
            line_items: Array<{ id?: string; name: string; quantity: number; unit_price: number; total_price: number; description?: string }>;
            buyer?: { email?: string; name?: string };
            shipping_address?: { line1: string; city: string; postal_code: string; country: string; state?: string };
            payment_instruments?: Array<{ id: string; handler: string; type: string }>;
            checkout_type?: 'physical' | 'digital' | 'service';
            metadata?: Record<string, any>;
            agent_id?: string;
          }>;
        };

        // Single API call to batch create + auto-complete
        const batchRes = await fetch(`${ctx.apiUrl}/v1/ucp/checkouts/batch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ctx.apiKey}`,
            'Content-Type': 'application/json',
            'X-Environment': ctx.apiKey.startsWith('pk_live_') ? 'live' : 'test',
          },
          body: JSON.stringify({
            checkouts,
            auto_complete: true,
          }),
        });
        const batchJson = await batchRes.json() as any;
        const batchData = batchJson?.data || batchJson;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(batchData, null, 2),
            },
          ],
        };
      }

      case 'ucp_batch_complete': {
        const { checkout_ids, default_payment_instrument } = args as {
          checkout_ids: string[];
          default_payment_instrument: { id: string; handler: string; type: string };
        };

        const batchRes = await fetch(`${ctx.apiUrl}/v1/ucp/checkouts/batch-complete`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ctx.apiKey}`,
            'Content-Type': 'application/json',
            'X-Environment': ctx.apiKey.startsWith('pk_live_') ? 'live' : 'test',
          },
          body: JSON.stringify({ checkout_ids, default_payment_instrument }),
        });
        const batchJson = await batchRes.json() as any;
        const batchData = batchJson?.data || batchJson;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(batchData, null, 2),
            },
          ],
        };
      }

      case 'ucp_list_orders': {
        const params = new URLSearchParams();
        if (args && (args as any).status) params.set('status', (args as any).status);
        if (args && (args as any).agent_id) params.set('agent_id', (args as any).agent_id);
        if (args && (args as any).page) params.set('page', String((args as any).page));
        if (args && (args as any).limit) params.set('limit', String((args as any).limit));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/ucp/orders${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_get_order': {
        const { orderId } = args as { orderId: string };
        const result = await ctx.sly.request(`/v1/ucp/orders/${orderId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_update_order_status': {
        const { orderId, status } = args as { orderId: string; status: string };
        const result = await ctx.sly.request(`/v1/ucp/orders/${orderId}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_cancel_order': {
        const { orderId, reason } = args as { orderId: string; reason?: string };
        const result = await ctx.sly.request(`/v1/ucp/orders/${orderId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ucp_add_fulfillment_event': {
        const { orderId, type: eventType, description, tracking_number, carrier } = args as {
          orderId: string;
          type: string;
          description: string;
          tracking_number?: string;
          carrier?: string;
        };
        const result = await ctx.sly.request(`/v1/ucp/orders/${orderId}/events`, {
          method: 'POST',
          body: JSON.stringify({ type: eventType, description, tracking_number, carrier }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // Merchant Catalog Tools
      // ======================================================================

      case 'list_merchants': {
        const params = new URLSearchParams();
        if (args && (args as any).type) params.set('type', (args as any).type);
        if (args && (args as any).country) params.set('country', (args as any).country);
        if (args && (args as any).search) params.set('search', (args as any).search);
        if (args && (args as any).limit) params.set('limit', String((args as any).limit));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/ucp/merchants${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_merchant': {
        const { merchantId } = args as { merchantId: string };
        const result = await ctx.sly.request(`/v1/ucp/merchants/${merchantId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // Agent Management Tools
      // ======================================================================

      case 'list_accounts': {
        const params = new URLSearchParams();
        if (args && (args as any).type) params.set('type', (args as any).type);
        if (args && (args as any).status) params.set('status', (args as any).status);
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/accounts${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'create_account': {
        const { type, name: accountName, email, metadata } = args as {
          type: string;
          name: string;
          email?: string;
          metadata?: Record<string, any>;
        };
        const body: any = { type, name: accountName };
        if (email) body.email = email;
        if (metadata) body.metadata = metadata;
        const result = await ctx.sly.request('/v1/accounts', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'update_account': {
        const {
          accountId,
          name: accountName,
          email,
          metadata,
        } = args as {
          accountId: string;
          name?: string;
          email?: string;
          metadata?: Record<string, any>;
        };
        const body: any = {};
        if (accountName !== undefined) body.name = accountName;
        if (email !== undefined) body.email = email;
        if (metadata !== undefined) body.metadata = metadata;
        const result = await ctx.sly.request(`/v1/accounts/${accountId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_tenant_info': {
        const result = await ctx.sly.request('/v1/context/whoami');
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'create_agent': {
        const { accountId, name: agentName, description } = args as {
          accountId: string;
          name: string;
          description?: string;
        };
        const result = await ctx.sly.request('/v1/agents', {
          method: 'POST',
          body: JSON.stringify({
            accountId,
            name: agentName,
            description,
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'verify_agent': {
        const { agentId, tier } = args as { agentId: string; tier: number };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/verify`, {
          method: 'POST',
          body: JSON.stringify({ tier }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_agent': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_agent_limits': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/limits`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_agent_transactions': {
        const { agentId, limit: txLimit, offset: txOffset, from, to } = args as {
          agentId: string;
          limit?: number;
          offset?: number;
          from?: string;
          to?: string;
        };
        const params = new URLSearchParams();
        if (txLimit) params.set('limit', String(txLimit));
        if (txOffset) params.set('offset', String(txOffset));
        if (from) params.set('from', from);
        if (to) params.set('to', to);
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/agents/${agentId}/transactions${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'delete_agent': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}`, {
          method: 'DELETE',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // AP2 Mandate Tools
      // ======================================================================

      case 'ap2_cancel_mandate': {
        const { mandateId } = args as { mandateId: string };
        const result = await ctx.sly.request(`/v1/ap2/mandates/${mandateId}/cancel`, {
          method: 'PATCH',
          body: JSON.stringify({}),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ap2_create_mandate': {
        const {
          mandate_id,
          agent_id,
          account_id,
          authorized_amount,
          currency,
          mandate_type,
          description,
          expires_at,
          metadata,
          mandate_data,
        } = args as {
          mandate_id: string;
          agent_id: string;
          account_id: string;
          authorized_amount: number;
          currency?: string;
          mandate_type?: string;
          description?: string;
          expires_at?: string;
          metadata?: object;
          mandate_data?: object;
        };
        const result = await ctx.sly.ap2.createMandate({
          mandate_id,
          agent_id,
          account_id,
          authorized_amount,
          currency,
          mandate_type: (mandate_type as 'intent' | 'cart' | 'payment') || 'payment',
          mandate_data: mandate_data || (description ? { description } : undefined),
          metadata,
          expires_at,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ap2_get_mandate': {
        const { mandateId } = args as { mandateId: string };
        const result = await ctx.sly.ap2.getMandate(mandateId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ap2_execute_mandate': {
        const { mandateId, amount, currency, description, order_ids } = args as {
          mandateId: string;
          amount: number;
          currency?: string;
          description?: string;
          order_ids?: string[];
        };
        const result = await ctx.sly.ap2.executeMandate(mandateId, {
          amount,
          currency,
          description,
          order_ids,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ap2_list_mandates': {
        const { status, agent_id, account_id, limit } = (args || {}) as {
          status?: 'active' | 'completed' | 'cancelled' | 'expired';
          agent_id?: string;
          account_id?: string;
          limit?: number;
        };
        const result = await ctx.sly.ap2.listMandates({
          status,
          agent_id,
          account_id,
          limit,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'ap2_update_mandate': {
        const { mandateId, ...updateFields } = args as {
          mandateId: string;
          authorized_amount?: number;
          status?: string;
          expires_at?: string;
          metadata?: object;
          mandate_data?: object;
          description?: string;
        };
        const result = await ctx.sly.request(`/v1/ap2/mandates/${mandateId}`, {
          method: 'PATCH',
          body: JSON.stringify(updateFields),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // ACP Checkout Tools
      // ======================================================================

      case 'acp_create_checkout': {
        const {
          checkout_id,
          agent_id,
          account_id,
          merchant_id,
          items,
          tax_amount,
          shipping_amount,
          payment_method,
          checkout_data,
        } = args as {
          checkout_id: string;
          agent_id: string;
          account_id?: string;
          merchant_id: string;
          items: Array<{
            name: string;
            description?: string;
            quantity: number;
            unit_price: number;
            total_price: number;
          }>;
          tax_amount?: number;
          shipping_amount?: number;
          payment_method?: string;
          checkout_data?: Record<string, any>;
        };
        const result = await ctx.sly.acp.createCheckout({
          checkout_id,
          agent_id,
          account_id: account_id || '',
          merchant_id,
          items,
          tax_amount,
          shipping_amount,
          payment_method,
          checkout_data,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'acp_get_checkout': {
        const { checkoutId } = args as { checkoutId: string };
        const result = await ctx.sly.acp.getCheckout(checkoutId);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'acp_complete_checkout': {
        const { checkoutId, shared_payment_token, payment_method } = args as {
          checkoutId: string;
          shared_payment_token?: string;
          payment_method?: string;
        };
        const token = shared_payment_token || `spt_test_${Date.now()}`;
        const result = await ctx.sly.acp.completeCheckout(checkoutId, {
          shared_payment_token: token,
          payment_method,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'acp_list_checkouts': {
        const { status, agent_id, merchant_id, limit } = (args || {}) as {
          status?: 'pending' | 'completed' | 'cancelled' | 'expired';
          agent_id?: string;
          merchant_id?: string;
          limit?: number;
        };
        const result = await ctx.sly.acp.listCheckouts({
          status: status as any,
          agent_id,
          merchant_id,
          limit,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'acp_batch_checkout': {
        const { checkouts } = args as {
          checkouts: Array<{
            checkout_id: string;
            agent_id: string;
            account_id: string;
            merchant_id: string;
            merchant_name?: string;
            items: Array<{ name: string; description?: string; quantity: number; unit_price: number; total_price: number }>;
            tax_amount?: number;
            shipping_amount?: number;
            currency?: string;
            metadata?: Record<string, any>;
          }>;
        };

        const batchRes = await fetch(`${ctx.apiUrl}/v1/acp/checkouts/batch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ctx.apiKey}`,
            'Content-Type': 'application/json',
            'X-Environment': ctx.apiKey.startsWith('pk_live_') ? 'live' : 'test',
          },
          body: JSON.stringify({ checkouts }),
        });
        const batchJson = await batchRes.json() as any;
        const batchData = batchJson?.data || batchJson;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(batchData, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // Wallet Management Tools
      // ======================================================================

      case 'list_wallets': {
        const params = new URLSearchParams();
        if (args && (args as any).owner_account_id) params.set('owner_account_id', (args as any).owner_account_id);
        if (args && (args as any).managed_by_agent_id) params.set('managed_by_agent_id', (args as any).managed_by_agent_id);
        if (args && (args as any).status) params.set('status', (args as any).status);
        if (args && (args as any).page) params.set('page', String((args as any).page));
        if (args && (args as any).limit) params.set('limit', String((args as any).limit));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/wallets${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'create_wallet': {
        const {
          accountId,
          name: walletName,
          currency,
          walletType,
          blockchain,
          initialBalance,
          managedByAgentId,
          purpose,
        } = args as {
          accountId: string;
          name?: string;
          currency?: string;
          walletType?: string;
          blockchain?: string;
          initialBalance?: number;
          managedByAgentId?: string;
          purpose?: string;
        };
        const result = await ctx.sly.request('/v1/wallets', {
          method: 'POST',
          body: JSON.stringify({
            accountId,
            name: walletName,
            currency,
            walletType,
            blockchain,
            initialBalance,
            managedByAgentId,
            purpose,
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_wallet': {
        const { walletId } = args as { walletId: string };
        const result = await ctx.sly.request(`/v1/wallets/${walletId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'get_wallet_balance': {
        const { walletId } = args as { walletId: string };
        const result = await ctx.sly.request(`/v1/wallets/${walletId}/balance`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'wallet_deposit': {
        const { walletId, amount, fromAccountId, reference } = args as {
          walletId: string;
          amount: number;
          fromAccountId: string;
          reference?: string;
        };
        const result = await ctx.sly.request(`/v1/wallets/${walletId}/deposit`, {
          method: 'POST',
          body: JSON.stringify({ amount, fromAccountId, reference }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'wallet_withdraw': {
        const { walletId, amount, destinationAccountId, reference } = args as {
          walletId: string;
          amount: number;
          destinationAccountId: string;
          reference?: string;
        };
        const result = await ctx.sly.request(`/v1/wallets/${walletId}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({ amount, destinationAccountId, reference }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'wallet_test_fund': {
        const { walletId, amount, currency, reference } = args as {
          walletId: string;
          amount: number;
          currency?: string;
          reference?: string;
        };
        const result = await ctx.sly.request(`/v1/wallets/${walletId}/test-fund`, {
          method: 'POST',
          body: JSON.stringify({ amount, currency, reference }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // Agent Wallet Policy Tools (Epic 18)
      // ======================================================================

      case 'agent_wallet_evaluate_policy': {
        const { agentId, amount, currency, action_type, contract_type, counterparty_agent_id, counterparty_address } =
          args as {
            agentId: string;
            amount: number;
            currency?: string;
            action_type?: string;
            contract_type?: string;
            counterparty_agent_id?: string;
            counterparty_address?: string;
          };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/policy/evaluate`, {
          method: 'POST',
          body: JSON.stringify({
            amount,
            currency: currency || 'USDC',
            action_type: action_type || 'negotiation_check',
            contract_type,
            counterparty_agent_id,
            counterparty_address,
          }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_get_exposures': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/exposures`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_get_evaluations': {
        const { agentId, page, limit } = args as { agentId: string; page?: number; limit?: number };
        const params = new URLSearchParams();
        if (page) params.set('page', String(page));
        if (limit) params.set('limit', String(limit));
        const qs = params.toString();
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/policy/evaluations${qs ? `?${qs}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_get': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_freeze': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/freeze`, {
          method: 'POST',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_unfreeze': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/unfreeze`, {
          method: 'POST',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_fund': {
        const { agentId, amount, sourceWalletId } = args as {
          agentId: string;
          amount: number;
          sourceWalletId?: string;
        };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/request-funds`, {
          method: 'POST',
          body: JSON.stringify({
            amount,
            ...(sourceWalletId ? { source_wallet_id: sourceWalletId } : {}),
          }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_set_policy': {
        const { agentId, ...policyFields } = args as {
          agentId: string;
          dailySpendLimit?: number;
          monthlySpendLimit?: number;
          requiresApprovalAbove?: number;
          approvedVendors?: string[];
          contractPolicy?: Record<string, unknown>;
        };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/policy`, {
          method: 'PUT',
          body: JSON.stringify(policyFields),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // ======================================================================
      // x402 Micropayment Tools
      // ======================================================================

      case 'x402_create_endpoint': {
        const {
          name: endpointName,
          path,
          method,
          description,
          accountId,
          basePrice,
          currency,
          volumeDiscounts,
          webhookUrl,
        } = args as {
          name: string;
          path: string;
          method?: string;
          description?: string;
          accountId: string;
          basePrice: number;
          currency?: string;
          volumeDiscounts?: Array<{ minCalls: number; discountPercent: number }>;
          webhookUrl?: string;
        };
        const result = await ctx.sly.request('/v1/x402/endpoints', {
          method: 'POST',
          body: JSON.stringify({
            name: endpointName,
            path,
            method,
            description,
            accountId,
            basePrice,
            currency,
            volumeDiscounts,
            webhookUrl,
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'x402_list_endpoints': {
        const params = new URLSearchParams();
        if (args && (args as any).status) params.set('status', (args as any).status);
        if (args && (args as any).account_id) params.set('account_id', (args as any).account_id);
        if (args && (args as any).page) params.set('page', String((args as any).page));
        if (args && (args as any).limit) params.set('limit', String((args as any).limit));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/x402/endpoints${query ? `?${query}` : ''}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'x402_get_endpoint': {
        const { endpointId } = args as { endpointId: string };
        const result = await ctx.sly.request(`/v1/x402/endpoints/${endpointId}`);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'x402_pay': {
        const { endpointId, walletId, amount, currency, method: httpMethod, path: endpointPath } = args as {
          endpointId: string;
          walletId: string;
          amount: number;
          currency: string;
          method: string;
          path: string;
        };
        const requestId = crypto.randomUUID();
        const result = await ctx.sly.request('/v1/x402/pay', {
          method: 'POST',
          body: JSON.stringify({
            endpointId,
            requestId,
            amount,
            currency,
            walletId,
            method: httpMethod,
            path: endpointPath,
            timestamp: Math.floor(Date.now() / 1000),
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'x402_verify': {
        const { jwt, requestId, transferId } = args as {
          jwt?: string;
          requestId?: string;
          transferId?: string;
        };
        const result = await ctx.sly.request('/v1/x402/verify', {
          method: 'POST',
          body: JSON.stringify({ jwt, requestId, transferId }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'agent_evm_key_provision': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/evm-keys`, {
          method: 'POST',
          body: '{}',
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'agent_x402_sign': {
        const { agentId, to, value, chainId, validBefore, validAfter, nonce } = args as {
          agentId: string;
          to: string;
          value: string;
          chainId?: number;
          validBefore: number;
          validAfter?: number;
          nonce?: string;
        };
        if (chainId === undefined || chainId === null) {
          throw new Error('chainId is required. 8453 = Base mainnet, 84532 = Base Sepolia. Read it from the 402 challenge\'s `network` field.');
        }
        const result = await ctx.sly.request(`/v1/agents/${agentId}/x402-sign`, {
          method: 'POST',
          body: JSON.stringify({ to, value, chainId, validBefore, validAfter: validAfter || 0, nonce }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'x402_build_payment_header': {
        const { challenge, signed } = args as { challenge: any; signed: any };
        const value = buildX402PaymentHeader(challenge, signed);
        return { content: [{ type: 'text', text: JSON.stringify({ header: 'X-PAYMENT', value }, null, 2) }] };
      }

      case 'x402_fetch': {
        const {
          agentId,
          url,
          method = 'GET',
          body,
          headers = {},
          maxPrice,
        } = args as {
          agentId: string;
          url: string;
          method?: string;
          body?: string;
          headers?: Record<string, string>;
          maxPrice?: string;
        };

        const baseHeaders: Record<string, string> = { 'Accept': 'application/json', ...headers };
        const firstInit: RequestInit = { method, headers: baseHeaders };
        if (body !== undefined) firstInit.body = body;

        const firstRes = await fetch(url, firstInit);
        if (firstRes.status !== 402) {
          const text = await firstRes.text();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                paid: false,
                status: firstRes.status,
                body: safeParseJson(text),
              }, null, 2),
            }],
          };
        }

        const challengeText = await firstRes.text();
        const challenge = safeParseJson(challengeText);
        const accept = pickX402Accept(challenge);
        if (!accept) {
          throw new Error(`402 response has no usable accepts[] entry. Raw: ${challengeText.slice(0, 500)}`);
        }
        if (accept.scheme && accept.scheme !== 'exact') {
          throw new Error(`Unsupported x402 scheme "${accept.scheme}". Only "exact" is supported today.`);
        }
        if (maxPrice && BigInt(accept.amount || accept.maxAmountRequired || '0') > BigInt(maxPrice)) {
          throw new Error(`Challenge amount ${accept.amount || accept.maxAmountRequired} exceeds maxPrice ${maxPrice}. Aborting.`);
        }

        const chainId = networkToChainId(accept.network);
        if (!chainId) {
          throw new Error(`Cannot derive chainId from network "${accept.network}". Supported: base, base-sepolia, eip155:8453, eip155:84532.`);
        }

        const timeoutSec = Number(accept.maxTimeoutSeconds) > 0 ? Number(accept.maxTimeoutSeconds) : 300;
        const validBefore = Math.floor(Date.now() / 1000) + timeoutSec;
        const amount = String(accept.amount ?? accept.maxAmountRequired);
        const payTo = accept.payTo;
        if (!payTo || !amount) {
          throw new Error(`Challenge is missing payTo or amount/maxAmountRequired: ${JSON.stringify(accept)}`);
        }

        const signed = await ctx.sly.request(`/v1/agents/${agentId}/x402-sign`, {
          method: 'POST',
          body: JSON.stringify({ to: payTo, value: amount, chainId, validBefore }),
        }) as any;

        const headerValue = buildX402PaymentHeader(challenge, signed);

        const secondInit: RequestInit = {
          method,
          headers: { ...baseHeaders, 'X-PAYMENT': headerValue },
        };
        if (body !== undefined) secondInit.body = body;
        const secondRes = await fetch(url, secondInit);
        const secondText = await secondRes.text();
        const paid = secondRes.status >= 200 && secondRes.status < 300;
        const paymentResponseHeader = secondRes.headers.get('x-payment-response') || null;

        // If the facilitator settled and returned a tx hash, reconcile the
        // ledger so the transfer row flips from 'pending' to 'completed'.
        // Fire-and-forget style — the paid response is still returned to the
        // caller even if reconciliation fails.
        let settlementRecorded: any = null;
        const receipt = decodeX402PaymentResponse(paymentResponseHeader);
        if (paid && receipt?.transaction && signed.transferId) {
          try {
            const recordRes = await ctx.sly.request(`/v1/transfers/${signed.transferId}/record-settlement`, {
              method: 'POST',
              body: JSON.stringify({
                txHash: receipt.transaction,
                network: receipt.network || undefined,
                payer: receipt.payer || undefined,
              }),
            });
            settlementRecorded = { ok: true, transferId: signed.transferId, txHash: receipt.transaction, response: recordRes };
          } catch (e: any) {
            settlementRecorded = { ok: false, transferId: signed.transferId, error: e?.message || String(e) };
          }
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              paid,
              status: secondRes.status,
              paymentResponseHeader,
              settlement: receipt,
              ledgerReconciled: settlementRecorded,
              signedAuthorization: {
                from: signed.from,
                to: signed.to,
                value: signed.value,
                chainId: signed.chainId,
                nonce: signed.nonce,
                transferId: signed.transferId || null,
              },
              body: safeParseJson(secondText),
            }, null, 2),
          }],
        };
      }

      case 'agent_fund_eoa': {
        const { agentId, amount } = args as { agentId: string; amount?: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/fund-eoa`, {
          method: 'POST',
          body: JSON.stringify({ amount: amount || '1' }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'agent_refill_faucet': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/wallet/refill-faucet`, {
          method: 'POST',
          body: '{}',
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      // ====================================================================
      // A2A Tools
      // ====================================================================
      case 'a2a_discover_agent': {
        const { url } = args as { url: string };
        const result = await ctx.sly.request('/v1/a2a/discover', {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'a2a_send_task': {
        const { agent_id, remote_url, message, context_id } = args as {
          agent_id?: string;
          remote_url?: string;
          message: string;
          context_id?: string;
        };
        const result = await ctx.sly.request('/v1/a2a/tasks', {
          method: 'POST',
          body: JSON.stringify({
            agent_id,
            remote_url,
            message: {
              parts: [{ text: message }],
            },
            context_id,
          }),
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'a2a_get_task': {
        const { task_id } = args as { task_id: string };
        const result = await ctx.sly.request(`/v1/a2a/tasks/${task_id}`, {
          method: 'GET',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case 'a2a_list_tasks': {
        const { agent_id, state, direction, limit, page } = args as {
          agent_id?: string;
          state?: string;
          direction?: string;
          limit?: number;
          page?: number;
        };
        const params = new URLSearchParams();
        if (agent_id) params.set('agent_id', agent_id);
        if (state) params.set('state', state);
        if (direction) params.set('direction', direction);
        if (limit) params.set('limit', String(limit));
        if (page) params.set('page', String(page));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/a2a/tasks${query ? `?${query}` : ''}`, {
          method: 'GET',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // ======================================================================
      // MPP Tools
      // ======================================================================

      case 'mpp_pay': {
        const { service_url, amount, currency, intent, agent_id, wallet_id } = args as {
          service_url: string;
          amount: number;
          currency?: string;
          intent?: string;
          agent_id: string;
          wallet_id?: string;
        };
        const result = await ctx.sly.request('/v1/mpp/pay', {
          method: 'POST',
          body: JSON.stringify({ service_url, amount, currency, intent, agent_id, wallet_id }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_open_session': {
        const { service_url, deposit_amount, max_budget, agent_id, wallet_id, currency } = args as {
          service_url: string;
          deposit_amount: number;
          max_budget?: number;
          agent_id: string;
          wallet_id: string;
          currency?: string;
        };
        const result = await ctx.sly.request('/v1/mpp/sessions', {
          method: 'POST',
          body: JSON.stringify({ service_url, deposit_amount, max_budget, agent_id, wallet_id, currency }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_get_session': {
        const { session_id } = args as { session_id: string };
        const result = await ctx.sly.request(`/v1/mpp/sessions/${session_id}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_list_sessions': {
        const { agent_id, status, limit, offset } = args as {
          agent_id?: string;
          status?: string;
          limit?: number;
          offset?: number;
        };
        const params = new URLSearchParams();
        if (agent_id) params.set('agent_id', agent_id);
        if (status) params.set('status', status);
        if (limit) params.set('limit', String(limit));
        if (offset) params.set('offset', String(offset));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/mpp/sessions${query ? `?${query}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_close_session': {
        const { session_id } = args as { session_id: string };
        const result = await ctx.sly.request(`/v1/mpp/sessions/${session_id}/close`, {
          method: 'POST',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_list_transfers': {
        const { service_url, session_id, limit, offset } = args as {
          service_url?: string;
          session_id?: string;
          limit?: number;
          offset?: number;
        };
        const params = new URLSearchParams();
        if (service_url) params.set('service_url', service_url);
        if (session_id) params.set('session_id', session_id);
        if (limit) params.set('limit', String(limit));
        if (offset) params.set('offset', String(offset));
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/mpp/transfers${query ? `?${query}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_verify_receipt': {
        const { receipt_id } = args as { receipt_id: string };
        const result = await ctx.sly.request('/v1/mpp/receipts/verify', {
          method: 'POST',
          body: JSON.stringify({ receipt_id }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // ====================================================================
      // Support Tools (Intercom Fin)
      // ====================================================================
      case 'explain_rejection': {
        const { error_code, transaction_id, agent_id } = args as {
          error_code?: string;
          transaction_id?: string;
          agent_id?: string;
        };
        const params = new URLSearchParams();
        if (error_code) params.set('error_code', error_code);
        if (transaction_id) params.set('transaction_id', transaction_id);
        if (agent_id) params.set('agent_id', agent_id);
        const query = params.toString();
        const result = await ctx.sly.request(`/v1/support/explain-rejection${query ? `?${query}` : ''}`, {
          method: 'GET',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'request_limit_increase': {
        const { agent_id, limit_type, requested_amount, reason, duration } = args as {
          agent_id: string;
          limit_type: string;
          requested_amount: number;
          reason: string;
          duration?: string;
        };
        const body: Record<string, any> = { agent_id, limit_type, requested_amount, reason };
        if (duration) body.duration = duration;
        const result = await ctx.sly.request('/v1/support/limit-requests', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'open_dispute': {
        const { transaction_id, reason, description, requested_resolution } = args as {
          transaction_id: string;
          reason: string;
          description: string;
          requested_resolution?: string;
        };
        const body: Record<string, any> = {
          transferId: transaction_id,
          reason,
          description,
        };
        if (requested_resolution) body.requestedResolution = requested_resolution;
        const result = await ctx.sly.request('/v1/disputes', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'escalate_to_human': {
        const { agent_id, reason, summary, priority } = args as {
          agent_id?: string;
          reason: string;
          summary: string;
          priority?: string;
        };
        const body: Record<string, any> = { reason, summary };
        if (agent_id) body.agent_id = agent_id;
        if (priority) body.priority = priority;
        const result = await ctx.sly.request('/v1/support/escalations', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      // ======================================================================
      // Environment Management Tools
      // ======================================================================

      case 'get_environment': {
        const masked = ctx.apiKey.slice(0, 12) + '***';
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ environment: ctx.environment, apiKeyPrefix: masked, availableEnvironments: Object.keys(ctx.keys) }, null, 2),
          }],
        };
      }

      case 'switch_environment': {
        const { environment: targetEnv } = args as { environment: 'sandbox' | 'production' };
        if (targetEnv === ctx.environment) {
          return { content: [{ type: 'text', text: JSON.stringify({ message: `Already in ${targetEnv} environment`, environment: ctx.environment, apiKeyPrefix: ctx.apiKey.slice(0, 12) + '***' }, null, 2) }] };
        }
        const targetKey = ctx.keys[targetEnv];
        if (!targetKey) {
          const hint = targetEnv === 'production' ? 'Set SLY_API_KEY_LIVE in your MCP server config (.mcp.json)' : 'Set SLY_API_KEY in your MCP server config (.mcp.json)';
          return { content: [{ type: 'text', text: `Error: No API key configured for "${targetEnv}" environment. ${hint}` }], isError: true };
        }
        const targetUrl = ctx.urls[targetEnv] || ctx.apiUrl;
        ctx.sly = new Sly({ apiKey: targetKey, apiUrl: targetUrl });
        ctx.apiKey = targetKey;
        ctx.apiUrl = targetUrl;
        ctx.environment = targetEnv;
        return { content: [{ type: 'text', text: JSON.stringify({ message: `Switched to ${targetEnv} environment`, environment: ctx.environment, apiKeyPrefix: ctx.apiKey.slice(0, 12) + '***' }, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    // Defensive coercion: never let a non-string message render as "[object Object]".
    // The SDK always throws Error instances with string messages, but a future non-Error
    // throw (e.g. a plain object) would otherwise leak through the template literal.
    let message: string;
    if (error instanceof Error && typeof error.message === 'string') {
      message = error.message;
    } else if (typeof error === 'string') {
      message = error;
    } else if (error && typeof error.message === 'string') {
      message = error.message;
    } else {
      try {
        message = JSON.stringify(error);
      } catch {
        message = String(error);
      }
    }
    const code = error?.code ? ` [${error.code}]` : '';
    const status = error?.status ? ` (HTTP ${error.status})` : '';
    const details = error?.details || error?.data?.error?.suggestion || error?.errors || '';
    const detailsStr = details ? `\nDetails: ${JSON.stringify(details, null, 2)}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Error${code}${status}: ${message}${detailsStr}`,
        },
      ],
      isError: true,
    };
  }
  });

  return server;
}

// ---------------------------------------------------------------------------
// x402 envelope helpers (local — no API roundtrip)
// ---------------------------------------------------------------------------

function safeParseJson(text: string): any {
  try { return JSON.parse(text); } catch { return text; }
}

// Decode the base64 X-PAYMENT-RESPONSE receipt that x402 facilitators return
// after settling an authorization on-chain. Shape:
// { success, errorReason, payer, transaction, network }
function decodeX402PaymentResponse(header: string | null): {
  success?: boolean;
  errorReason?: string | null;
  payer?: string;
  transaction?: string;
  network?: string;
} | null {
  if (!header) return null;
  try {
    const json = typeof Buffer !== 'undefined'
      ? Buffer.from(header, 'base64').toString('utf8')
      // @ts-ignore — atob for edge runtimes
      : decodeURIComponent(escape(atob(header)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// Return the first usable `accepts[]` entry. Accepts either the full 402 body
// (with `accepts: [...]`) or a single entry already unwrapped by the caller.
function pickX402Accept(challenge: any): any | null {
  if (!challenge || typeof challenge !== 'object') return null;
  if (Array.isArray(challenge.accepts) && challenge.accepts.length > 0) {
    return challenge.accepts[0];
  }
  if (challenge.scheme && challenge.network) return challenge;
  return null;
}

// Map x402's varying network identifiers to a numeric EVM chainId.
// v1 uses short names ("base", "base-sepolia"); v2 uses CAIP-2 ("eip155:8453").
function networkToChainId(network: string | undefined): number | null {
  if (!network) return null;
  const n = String(network).toLowerCase();
  if (n === 'base' || n === 'eip155:8453') return 8453;
  if (n === 'base-sepolia' || n === 'eip155:84532') return 84532;
  const m = n.match(/^eip155:(\d+)$/);
  if (m) return Number(m[1]);
  return null;
}

// Build the base64-encoded X-PAYMENT value. Matches both v1 and v2 shapes —
// the payload is identical; only the outer envelope's x402Version / network
// naming differs. We echo the server's own network string so we don't have
// to know which form it wants.
function buildX402PaymentHeader(challenge: any, signed: any): string {
  const accept = pickX402Accept(challenge) || {};
  const x402Version =
    (challenge && typeof challenge === 'object' && challenge.x402Version) || 2;
  const scheme = accept.scheme || 'exact';
  const network = accept.network || (signed.chainId === 84532 ? 'base-sepolia' : 'base');

  const envelope = {
    x402Version,
    scheme,
    network,
    payload: {
      signature: signed.signature,
      authorization: {
        from: signed.from,
        to: signed.to,
        value: String(signed.value),
        validAfter: String(signed.validAfter ?? 0),
        validBefore: String(signed.validBefore),
        nonce: signed.nonce,
      },
    },
  };

  // Use Buffer when available (Node), fall back to btoa for edge/browser.
  const json = JSON.stringify(envelope);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  // @ts-ignore — btoa exists in Edge/browser runtimes
  return btoa(unescape(encodeURIComponent(json)));
}
