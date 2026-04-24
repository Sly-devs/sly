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

      case 'agent_x402_wallet': {
        const { agentId } = args as { agentId: string };
        // One call gets us the EOA (idempotent — returns existing key if present).
        const keyRes: any = await ctx.sly.request(`/v1/agents/${agentId}/evm-keys`, {
          method: 'POST',
          body: '{}',
        });
        const eoa: string | undefined = keyRes?.data?.ethereumAddress || keyRes?.ethereumAddress;
        if (!eoa) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              provisioned: false,
              note: 'No EVM key could be provisioned. This agent may not be active, or the API rejected the request.',
              rawKeyResponse: keyRes,
            }, null, 2) }],
          };
        }
        // Second call fetches the agent row so we can pick the right chain.
        const agentRes: any = await ctx.sly.request(`/v1/agents/${agentId}`);
        const envField: string | undefined = agentRes?.data?.environment || agentRes?.environment;
        const agentEnv: 'live' | 'test' = envField === 'live' ? 'live' : 'test';

        const chainConfig = agentEnv === 'live'
          ? {
              chainId: 8453,
              network: 'base',
              rpc: 'https://mainnet.base.org',
              usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              explorer: 'https://basescan.org',
            }
          : {
              chainId: 84532,
              network: 'base-sepolia',
              rpc: 'https://sepolia.base.org',
              usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              explorer: 'https://sepolia.basescan.org',
            };

        // Query on-chain USDC balance directly — bypasses any internal-ledger
        // mirror so the user sees the real number.
        const callData = '0x70a08231' + '0'.repeat(24) + eoa.slice(2).toLowerCase();
        let balanceUsdc: number | null = null;
        let balanceError: string | null = null;
        try {
          const res = await fetch(chainConfig.rpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0', id: 1, method: 'eth_call',
              params: [{ to: chainConfig.usdc, data: callData }, 'latest'],
            }),
          });
          const j: any = await res.json();
          if (j?.result) {
            balanceUsdc = parseInt(j.result, 16) / 1e6;
          } else {
            balanceError = j?.error?.message || 'no result';
          }
        } catch (e: any) {
          balanceError = e?.message || String(e);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({
            provisioned: true,
            address: eoa,
            environment: agentEnv,
            chain: {
              id: chainConfig.chainId,
              network: chainConfig.network,
              explorerUrl: `${chainConfig.explorer}/address/${eoa}`,
            },
            onchainUsdc: balanceUsdc,
            usdcContract: chainConfig.usdc,
            balanceError,
            note: balanceUsdc === 0
              ? `EOA has 0 USDC on ${chainConfig.network}. To fund: send USDC on the Base network (not Ethereum) to the address above.`
              : balanceUsdc === null
                ? 'Could not read on-chain balance — check balanceError field.'
                : `Spendable USDC on ${chainConfig.network}: ${balanceUsdc}`,
          }, null, 2) }],
        };
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

      case 'x402_probe': {
        const {
          url,
          method = 'GET',
          body: probeBody,
          headers: probeHeaders = {},
        } = args as { url: string; method?: string; body?: string; headers?: Record<string, string> };

        // Best-effort reputation lookup — Epic 81. Tenant-scoped via the
        // authenticated MCP session. Don't block the probe on this; if
        // reputation isn't available (new tenant, network blip, etc.)
        // just proceed without it. Done outside the try-blocks below
        // so it runs once per probe regardless of 402/non-402 path.
        let probeHost: string | null = null;
        try { probeHost = new URL(url).hostname.toLowerCase(); } catch {}
        let reputation: any = null;
        if (probeHost) {
          try {
            const repRes: any = await ctx.sly.request(`/v1/analytics/x402-vendors/${encodeURIComponent(probeHost)}?window=30d`);
            reputation = repRes?.data ?? null;
          } catch {
            reputation = null;
          }
        }

        const probeInit: RequestInit = {
          method,
          headers: { 'Accept': 'application/json', ...probeHeaders },
        };
        if (probeBody !== undefined) probeInit.body = probeBody;

        const tStart = Date.now();
        let probeRes: Response;
        try {
          probeRes = await fetch(url, probeInit);
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({
            reachable: false,
            error: e?.message || String(e),
            classification: { code: 'UNKNOWN', explanation: `Network-level failure reaching ${url}` },
          }, null, 2) }] };
        }
        const durationMs = Date.now() - tStart;
        const text = await probeRes.text();
        const parsedBody = safeParseJson(text);

        // Non-402 responses — endpoint is either free, requires auth, or errored.
        if (probeRes.status !== 402) {
          let protocol: string;
          if (probeRes.status >= 200 && probeRes.status < 300) protocol = 'free';
          else if (probeRes.status === 401) protocol = 'api-key-gated';
          else if (probeRes.status === 403) protocol = 'forbidden';
          else if (probeRes.status === 404) protocol = 'endpoint-missing';
          else if (probeRes.status >= 500) protocol = 'vendor-broken';
          else protocol = 'other';
          return { content: [{ type: 'text', text: JSON.stringify({
            reachable: true,
            paid: false,
            requiresPayment: false,
            status: probeRes.status,
            statusText: probeRes.statusText,
            durationMs,
            protocol,
            bodyPreview: text.slice(0, 1024),
            note: protocol === 'free' ? 'Endpoint responded without requiring payment. Safe to call directly with standard fetch.'
              : protocol === 'api-key-gated' ? 'Endpoint requires an API key, not x402 payment. Use Epic 78 credential vault once shipped.'
              : `Endpoint returned ${probeRes.status} — inspect body before proceeding.`,
            reputation,
          }, null, 2) }] };
        }

        // 402 — parse challenge from body OR payment-required header
        let challenge: any = parsedBody;
        if (!challenge || typeof challenge !== 'object' || !pickX402Accept(challenge)) {
          const fromHeader = decodePaymentRequiredHeader(probeRes.headers.get('payment-required'));
          if (fromHeader) challenge = fromHeader;
        }
        const accept = pickX402Accept(challenge);
        // Some vendors embed a free / demo fallback URL in the 402 body
        // (e.g. TrustLayer's {"x-trustlayer":{"demo":{"url":"..."}}}).
        // Expose it in the probe response so agents can choose to use
        // the free endpoint instead of paying — before spending a cent.
        const fallbackUrl = parsedBody && typeof parsedBody === 'object'
          ? findDemoUrl(parsedBody)
          : null;

        // Classify what KIND of x402 this is before signing
        let protocolCode: string = 'standard-x402';
        let protocolNotes: string[] = [];
        if (challenge?.extensions?.agentkit || challenge?.agentkit) {
          protocolCode = 'agentkit-gated';
          protocolNotes.push('Requires AgentKit proof-of-humanity signature (Epic 80). Not supported yet.');
        }
        if (challenge?.authOptions?.x402Wallet?.topUp) {
          protocolCode = 'prepay';
          protocolNotes.push('Uses pre-pay balance model (Venice-style). Not standard X-PAYMENT per-call.');
        }
        if (challenge?.authOptions?.apiKey) {
          protocolNotes.push('Also accepts API key auth as alternative.');
        }
        if (!accept) {
          protocolCode = 'unparseable';
          protocolNotes.push('402 returned but no usable accepts[] entry found in body or header.');
        } else if (networkToChainId(accept.network) === null) {
          protocolCode = 'unsupported-network';
          protocolNotes.push(`Network "${accept.network}" is not an EVM chain we support today.`);
        }

        // Parse pricing + resource info
        const amount = accept?.amount || accept?.maxAmountRequired || null;
        const amountUsdc = amount ? Number(amount) / 1_000_000 : null;
        const chainId = accept ? networkToChainId(accept.network) : null;
        const resource = challenge?.resource || null;
        const bodySchema = challenge?.extensions?.bazaar?.info?.input
          || challenge?.extensions?.bazaar?.schema?.properties?.input
          || null;

        return { content: [{ type: 'text', text: JSON.stringify({
          reachable: true,
          paid: false,
          requiresPayment: true,
          protocol: protocolCode,
          x402Version: challenge?.x402Version ?? null,
          price: {
            amountMicroUnits: amount,
            amountUsdc,
            asset: accept?.asset ?? null,
          },
          payTo: accept?.payTo ?? null,
          network: accept?.network ?? null,
          chainId,
          maxTimeoutSeconds: accept?.maxTimeoutSeconds ?? null,
          resource: resource ? {
            url: resource.url,
            description: resource.description,
            method: resource.method || method,
            mimeType: resource.mimeType,
          } : null,
          bodySchema,
          allAccepts: Array.isArray(challenge?.accepts) ? challenge.accepts.map((a: any) => ({
            scheme: a.scheme,
            network: a.network,
            amount: a.amount || a.maxAmountRequired,
            payTo: a.payTo,
            supported: networkToChainId(a.network) !== null,
          })) : null,
          notes: protocolNotes,
          classification: protocolCode === 'standard-x402' ? null : {
            code: protocolCode === 'agentkit-gated' ? 'AGENTKIT_REQUIRED'
              : protocolCode === 'prepay' ? 'NON_STANDARD_AUTH_PREPAY'
              : protocolCode === 'unsupported-network' ? 'UNSUPPORTED_NETWORK'
              : 'UNKNOWN',
            explanation: protocolNotes.join(' '),
          },
          // Free/demo fallback URL detected in the 402 body, if any.
          // Callers can hit this without paying; rate-limited by the
          // vendor. Same detection logic as the post-failure classifier.
          fallback: fallbackUrl ? {
            url: fallbackUrl,
            note: 'Vendor advertised a free fallback endpoint in the 402 body. Rate limits apply — use for low-volume reads before committing to the paid path.',
          } : null,
          // Epic 81 — per-tenant historical reliability for this host.
          // Agents should prefer `avoid` vendors' fallbacks or skip them
          // outright; `trusted` vendors are the green light.
          reputation,
          recommendation: (() => {
            if (reputation?.recommendation === 'avoid') {
              return `AVOID: ${reputation.reasoning} ${fallbackUrl ? `Use the vendor's demo fallback at ${fallbackUrl} instead.` : 'Find an alternative.'}`;
            }
            if (reputation?.recommendation === 'caution') {
              return `CAUTION: ${reputation.reasoning} Pay via x402_fetch only if you can tolerate the failure rate. Cost: $${amountUsdc?.toFixed(4) ?? '?'} USDC.`;
            }
            if (fallbackUrl) {
              return `Vendor offers a free fallback at ${fallbackUrl} — try that first for low-volume reads. Paid path costs $${amountUsdc?.toFixed(4) ?? '?'} USDC/call via x402_fetch.`;
            }
            if (protocolCode === 'standard-x402') {
              const repNote = reputation?.recommendation === 'trusted'
                ? ` Vendor reputation: trusted (${reputation.completedCount}/${reputation.totalCalls} success).`
                : reputation?.recommendation === 'unknown'
                  ? ' No tenant history yet — treat as pioneer call.'
                  : '';
              return `Safe to pay via x402_fetch with maxPrice cap. Estimated cost per call: $${amountUsdc?.toFixed(4) ?? '?'} USDC.${repNote}`;
            }
            return protocolNotes.join(' ');
          })(),
        }, null, 2) }] };
      }

      case 'x402_discover': {
        const {
          query,
          category,
          maxPriceUsdc,
          method: methodFilter,
          limit = 20,
        } = args as {
          query?: string;
          category?: string;
          maxPriceUsdc?: number;
          method?: string;
          limit?: number;
        };
        const cap = Math.min(Math.max(1, Number(limit) || 20), 100);

        // Agentic.Market's public catalog. Free, no auth.
        const catalogUrl = query
          ? `https://api.agentic.market/v1/services/search?q=${encodeURIComponent(query)}`
          : `https://api.agentic.market/v1/services?limit=${cap}`;

        let catalogData: any;
        try {
          const res = await fetch(catalogUrl);
          if (!res.ok) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Catalog returned HTTP ${res.status}`, url: catalogUrl }) }] };
          }
          catalogData = await res.json();
        } catch (e: any) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: e?.message || String(e), url: catalogUrl }) }] };
        }

        const services: any[] = Array.isArray(catalogData?.services) ? catalogData.services : [];
        const matches: any[] = [];
        const q = query?.toLowerCase();
        for (const svc of services) {
          if (category && String(svc.category || '').toLowerCase() !== category.toLowerCase()) continue;
          // Flatten endpoints — one match per (service × endpoint) pair so
          // price filtering works correctly.
          const endpoints: any[] = Array.isArray(svc.endpoints) ? svc.endpoints : [];
          for (const ep of endpoints) {
            if (methodFilter && String(ep.method || '').toUpperCase() !== methodFilter.toUpperCase()) continue;
            const priceRaw = ep.pricing?.amount;
            const priceUsdc = priceRaw && priceRaw !== '' ? Number(priceRaw) : null;
            if (maxPriceUsdc != null && priceUsdc != null && priceUsdc > Number(maxPriceUsdc)) continue;
            if (q) {
              const hay = `${svc.name} ${svc.description} ${svc.category} ${ep.description} ${ep.url} ${ep.providerName || ''}`.toLowerCase();
              if (!hay.includes(q)) continue;
            }
            matches.push({
              service: svc.name,
              serviceId: svc.id,
              provider: ep.providerName || svc.provider,
              category: svc.category,
              url: ep.url,
              method: ep.method || 'GET',
              description: ep.description,
              priceUsdc,
              priceDisplay: priceUsdc != null
                ? `$${priceUsdc.toFixed(Math.max(3, priceUsdc < 0.01 ? 4 : 3))}`
                : (priceRaw === '' ? 'free / unknown' : '?'),
              network: ep.pricing?.network,
              quality: svc.quality || null,
              serviceUrl: svc.domain ? `https://${svc.domain}` : null,
            });
            if (matches.length >= cap) break;
          }
          if (matches.length >= cap) break;
        }

        // Sort: known price ascending, then unknown/free last
        matches.sort((a, b) => {
          if (a.priceUsdc != null && b.priceUsdc == null) return -1;
          if (a.priceUsdc == null && b.priceUsdc != null) return 1;
          if (a.priceUsdc != null && b.priceUsdc != null) return a.priceUsdc - b.priceUsdc;
          return 0;
        });

        return { content: [{ type: 'text', text: JSON.stringify({
          count: matches.length,
          totalServicesScanned: services.length,
          filters: { query: query || null, category: category || null, maxPriceUsdc: maxPriceUsdc ?? null, method: methodFilter || null, limit: cap },
          matches: matches.slice(0, cap),
          note: matches.length === 0
            ? 'No endpoints matched the filters. Try broader criteria or remove maxPriceUsdc.'
            : `Use x402_probe on a specific URL to inspect before paying, or x402_fetch(agentId, url, ...) to pay and call in one shot.`,
        }, null, 2) }] };
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

        // Some facilitators (StableTravel on Vercel, others) return the
        // challenge only in the `payment-required` header with an empty
        // body — try the body first, fall through to the header if the body
        // didn't contain a usable challenge.
        const challengeText = await firstRes.text();
        let challenge = safeParseJson(challengeText);
        if (!challenge || typeof challenge !== 'object' || !pickX402Accept(challenge)) {
          const headerChallenge = decodePaymentRequiredHeader(firstRes.headers.get('payment-required'));
          if (headerChallenge) challenge = headerChallenge;
        }
        const accept = pickX402Accept(challenge);
        if (!accept) {
          throw new Error(`402 response has no usable accepts[] entry in body or 'payment-required' header. Raw body: ${challengeText.slice(0, 300)}`);
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

        // Enrich the sign request with resource metadata pulled from the 402
        // challenge so the ledger row describes WHAT was paid for — not just
        // the recipient address. Most x402 services include `resource` in the
        // challenge body; fall back to URL-derived fields if not.
        const resourceFromChallenge = (challenge && typeof challenge === 'object' && challenge.resource && typeof challenge.resource === 'object')
          ? challenge.resource : {};
        let derivedHost: string | null = null;
        let derivedPath: string | null = null;
        try {
          const parsed = new URL(url);
          derivedHost = parsed.hostname;
          derivedPath = parsed.pathname;
        } catch { /* url was malformed — no-op */ }
        const resourcePayload = {
          url: resourceFromChallenge.url || url,
          host: derivedHost,
          path: derivedPath,
          method: String(method).toUpperCase(),
          description: resourceFromChallenge.description || null,
          mimeType: resourceFromChallenge.mimeType || null,
          // Heuristic: if the URL is listed on agentic.market, stamp it. A
          // real marketplace registry could replace this later.
          marketplace: derivedHost ? marketplaceForHost(derivedHost) : null,
        };

        const signed = await ctx.sly.request(`/v1/agents/${agentId}/x402-sign`, {
          method: 'POST',
          body: JSON.stringify({ to: payTo, value: amount, chainId, validBefore, resource: resourcePayload }),
        }) as any;

        // Defensive fallback: once sign succeeds a ledger row exists. If
        // ANYTHING after this throws (network error, timeout, parser blowup,
        // unexpected vendor response shape), we MUST still terminate the row
        // so it doesn't sit pending until the expired-cleanup worker reaps it
        // with a generic "signature_expired" reason.
        const safeRecord = async (failureReason: string, extra: any = {}) => {
          if (!signed?.transferId) return null;
          try {
            return await ctx.sly.request(`/v1/transfers/${signed.transferId}/record-settlement`, {
              method: 'POST',
              body: JSON.stringify({ failureReason: failureReason.slice(0, 500), ...extra }),
            });
          } catch (e: any) {
            console.error('[x402_fetch] safeRecord failed:', e?.message || e);
            return null;
          }
        };

        let headerValue: string;
        try {
          headerValue = buildX402PaymentHeader(challenge, signed);
        } catch (e: any) {
          await safeRecord(`Failed to build X-PAYMENT envelope: ${e?.message || String(e)}`);
          throw e;
        }

        const secondInit: RequestInit = {
          method,
          headers: { ...baseHeaders, 'X-PAYMENT': headerValue },
        };
        if (body !== undefined) secondInit.body = body;

        let secondRes: Response;
        let secondText: string;
        let durationMs: number;
        const tStart = Date.now();
        try {
          secondRes = await fetch(url, secondInit);
          secondText = await secondRes.text();
          durationMs = Date.now() - tStart;
        } catch (e: any) {
          // Network-level failure between us and the vendor. Sign happened,
          // but we never got a response to classify — record as such.
          durationMs = Date.now() - tStart;
          const reason = `Network error calling vendor: ${e?.message || String(e)}`;
          await safeRecord(reason, {
            responseMetadata: { durationMs, bodyIsJson: false, sizeBytes: 0 },
            classification: {
              code: 'UNKNOWN',
              explanation: reason,
              recommendation: 'Retry; possible transient network issue or vendor unreachable.',
            },
          });
          return {
            content: [{ type: 'text', text: JSON.stringify({
              paid: false,
              status: null,
              error: reason,
              signedAuthorization: { transferId: signed.transferId || null, nonce: signed.nonce, from: signed.from, to: signed.to, value: signed.value, chainId: signed.chainId },
              ledgerReconciled: { ok: true, transferId: signed.transferId, outcome: 'cancelled', failureReason: reason },
            }, null, 2) }],
          };
        }
        const paid = secondRes.status >= 200 && secondRes.status < 300;
        const paymentResponseHeader = secondRes.headers.get('x-payment-response') || null;
        const contentType = secondRes.headers.get('content-type') || null;
        const parsedBody = safeParseJson(secondText);
        const bodyIsJson = typeof parsedBody === 'object' && parsedBody !== null;

        // Build response metadata + run classifier. Wrapped defensively so a
        // bug in either step can't leave the ledger row pending.
        let responseMetadata: any;
        let failureClassification: FailureClassification | null = null;
        try {
          responseMetadata = {
            status: secondRes.status,
            statusText: secondRes.statusText,
            contentType,
            sizeBytes: secondText.length,
            durationMs,
            bodyPreview: secondText.slice(0, 2048),
            bodyIsJson,
            headers: {
              ...(paymentResponseHeader ? { 'x-payment-response': paymentResponseHeader } : {}),
              ...(secondRes.headers.get('www-authenticate') ? { 'www-authenticate': secondRes.headers.get('www-authenticate') as string } : {}),
              ...(secondRes.headers.get('x-error') ? { 'x-error': secondRes.headers.get('x-error') as string } : {}),
            },
          };
          if (!paid) {
            failureClassification = classifyX402Failure({
              challenge,
              responseStatus: secondRes.status,
              responseBody: parsedBody,
              responseBodyRaw: secondText,
              responseHeaders: {
                'x-payment-response': paymentResponseHeader,
                'www-authenticate': secondRes.headers.get('www-authenticate'),
                'x-error': secondRes.headers.get('x-error'),
              },
            });
          }
        } catch (e: any) {
          // Metadata/classifier threw. Still try to terminate the row with
          // minimal info so we don't leak a pending orphan.
          console.error('[x402_fetch] metadata/classify error:', e?.message || e);
          responseMetadata = responseMetadata || {
            status: secondRes.status,
            sizeBytes: (secondText || '').length,
            durationMs,
            bodyIsJson: false,
          };
        }

        // Always write back to the ledger. Success path gets tx_hash +
        // response_metadata; failure path gets failure_reason +
        // response_metadata + classification. This keeps the row terminal so
        // the x402-expired-cleanup worker doesn't later cancel a row we
        // already have a final answer for.
        let settlementRecorded: any = null;
        const receipt = decodeX402PaymentResponse(paymentResponseHeader);
        if (signed.transferId) {
          try {
            const recordBody: any = { responseMetadata };
            if (paid && receipt?.transaction) {
              recordBody.txHash = receipt.transaction;
              if (receipt.network) recordBody.network = receipt.network;
              if (receipt.payer) recordBody.payer = receipt.payer;
            } else if (!paid) {
              // Prefer the classifier's human-readable explanation as the
              // failure_reason so dashboards and logs are immediately useful.
              recordBody.failureReason = (failureClassification?.explanation || (() => {
                const reason = (bodyIsJson && (parsedBody as any).error)
                  ? (typeof (parsedBody as any).error === 'string'
                      ? (parsedBody as any).error
                      : (parsedBody as any).error?.message || JSON.stringify((parsedBody as any).error).slice(0, 200))
                  : `HTTP ${secondRes.status} ${secondRes.statusText || ''}`.trim();
                return String(reason);
              })()).slice(0, 500);
              if (failureClassification) {
                recordBody.classification = {
                  code: failureClassification.code,
                  explanation: failureClassification.explanation,
                  recommendation: failureClassification.recommendation || null,
                };
              }
            }
            const recordRes = await ctx.sly.request(`/v1/transfers/${signed.transferId}/record-settlement`, {
              method: 'POST',
              body: JSON.stringify(recordBody),
            });
            settlementRecorded = {
              ok: true,
              transferId: signed.transferId,
              outcome: paid ? 'completed' : 'cancelled',
              txHash: recordBody.txHash || null,
              failureReason: recordBody.failureReason || null,
              classification: recordBody.classification || null,
              response: recordRes,
            };
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
              durationMs,
              contentType,
              sizeBytes: secondText.length,
              paymentResponseHeader,
              settlement: receipt,
              failureClassification,
              ledgerReconciled: settlementRecorded,
              signedAuthorization: {
                from: signed.from,
                to: signed.to,
                value: signed.value,
                chainId: signed.chainId,
                nonce: signed.nonce,
                transferId: signed.transferId || null,
              },
              // Propagate soft spending-policy warnings from x402-sign
              // so the agent / caller can log or escalate before the
              // wallet hits its cap. These are advisory — the payment
              // already went through.
              walletPolicyWarnings: Array.isArray(signed.warnings) && signed.warnings.length > 0
                ? signed.warnings
                : undefined,
              body: parsedBody,
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

      case 'x402_endpoint_reputation': {
        const { host, window, env } = args as { host: string; window?: string; env?: 'live' | 'test' };
        if (!host) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'host is required' }, null, 2) }] };
        }
        const qs = new URLSearchParams();
        if (window) qs.set('window', window);
        if (env) qs.set('env', env);
        const path = `/v1/analytics/x402-vendors/${encodeURIComponent(host)}${qs.toString() ? `?${qs.toString()}` : ''}`;
        const result = await ctx.sly.request(path);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'x402_rate_vendor': {
        const { host, thumb, note } = args as { host: string; thumb: 'up' | 'down'; note?: string };
        if (!host || (thumb !== 'up' && thumb !== 'down')) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: 'host and thumb (up|down) are required' }, null, 2) }] };
        }
        const result = await ctx.sly.request(`/v1/analytics/x402-vendors/${encodeURIComponent(host.toLowerCase().trim())}/rate`, {
          method: 'POST',
          body: JSON.stringify({ thumb, note }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'x402_list_vendors': {
        const { window, env } = args as { window?: string; env?: 'live' | 'test' };
        const qs = new URLSearchParams();
        if (window) qs.set('window', window);
        if (env) qs.set('env', env);
        const path = `/v1/analytics/x402-vendors${qs.toString() ? `?${qs.toString()}` : ''}`;
        const result = await ctx.sly.request(path);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'wallet_topup_link': {
        const { walletId, presetAmountUsdc } = args as {
          walletId: string;
          presetAmountUsdc?: number;
        };
        const result = await ctx.sly.request('/v1/funding/topup-link', {
          method: 'POST',
          body: JSON.stringify({
            wallet_id: walletId,
            preset_amount_usdc: presetAmountUsdc,
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'agent_enable_auto_refill': {
        const { agentId, threshold, target, dailyCap } = args as {
          agentId: string;
          threshold: number;
          target: number;
          dailyCap?: number;
        };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/auto-refill`, {
          method: 'PATCH',
          body: JSON.stringify({
            enabled: true,
            threshold,
            target,
            dailyCap: dailyCap ?? 5,
          }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'agent_disable_auto_refill': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/auto-refill`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'agent_auto_refill_status': {
        const { agentId } = args as { agentId: string };
        const result = await ctx.sly.request(`/v1/agents/${agentId}/auto-refill`, {
          method: 'GET',
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

// Best-effort marketplace attribution based on hostname. Agentic.Market is the
// first "registry of x402 endpoints" we integrate against. Additional known
// marketplaces can be added here without touching API or dashboard code.
function marketplaceForHost(host: string): string | null {
  const h = host.toLowerCase();
  // Known Agentic.Market listed services — not exhaustive, just the ones
  // we've verified. A future dynamic registry lookup would replace this.
  const agenticMarketHosts = new Set([
    'api.slamai.dev',
    'stabletravel.dev',
    'llm.bankr.bot',
    'api.venice.ai',
    'api.messari.io',
    'blockrun.ai',
    'docs.anthropic.com',
  ]);
  if (agenticMarketHosts.has(h) || h.endsWith('.agentic.market') || h === 'agentic.market') {
    return 'agentic.market';
  }
  return null;
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

// Classify why an x402 paid call failed. Gives the dashboard something more
// actionable than raw HTTP status. Ordered from most-specific to most-general;
// first match wins.
//
// Classification codes are stable contract — see epic-80 for the full taxonomy.
export type X402FailureCode =
  | 'AGENTKIT_REQUIRED'             // Exa-style: dual-auth, need human-proof signature
  | 'NON_STANDARD_AUTH_PREPAY'      // Venice-style: pre-pay balance + custom header
  | 'FACILITATOR_REJECTED_SILENT'   // PaySponge-style: 402 returned again, no error detail
  | 'FACILITATOR_REJECTED_INVALID'  // Facilitator explicitly said our sig is invalid
  | 'VENDOR_BACKEND_ERROR'          // 5xx from upstream service
  | 'VENDOR_EMPTY_RESPONSE'         // 5xx with zero-length body (runtime crash)
  | 'AUTH_REQUIRED'                 // 401 — API key gate, not x402
  | 'FORBIDDEN'                     // 403 — allowlist / scope miss
  | 'HTTP_CLIENT_ERROR'             // other 4xx
  | 'HTTP_SERVER_ERROR'             // other 5xx
  | 'UNKNOWN';

interface FailureClassification {
  code: X402FailureCode;
  explanation: string;          // one-line human-readable
  recommendation?: string;       // next-step hint (e.g. "skip this vendor", "wait and retry")
}

// Some vendors return a 402 body that includes a free/demo fallback URL
// pointing to a rate-limited endpoint the caller can use without paying.
// Shape varies; scan the body for common conventions so we can surface
// the URL in the failure recommendation. Returns the first match or null.
function findDemoUrl(body: any): string | null {
  if (!body || typeof body !== 'object') return null;
  const seen = new Set<any>();
  const queue: any[] = [body];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [key, val] of Object.entries(node)) {
      // Direct hit: a "demo" / "free" / "fallback" block with a url.
      if (/^(demo|free|fallback|unpaid|anonymous)$/i.test(key) && val && typeof val === 'object') {
        const url = (val as any).url || (val as any).href || (val as any).endpoint;
        if (typeof url === 'string' && /^https?:\/\//.test(url)) return url;
      }
      // Or a flat string field named demoUrl / freeUrl / fallbackUrl.
      if (/^(demo|free|fallback|unpaid|anonymous)_?url$/i.test(key) && typeof val === 'string' && /^https?:\/\//.test(val)) {
        return val;
      }
      if (val && typeof val === 'object') queue.push(val);
    }
  }
  return null;
}

function classifyX402Failure(args: {
  challenge: any;
  responseStatus: number;
  responseBody: any;             // parsed if JSON, string if not
  responseBodyRaw: string;
  responseHeaders: Record<string, string | null>;
}): FailureClassification {
  const { challenge, responseStatus, responseBody, responseBodyRaw, responseHeaders } = args;
  const bodyIsObj = typeof responseBody === 'object' && responseBody !== null;
  const errorField = bodyIsObj ? (responseBody.error ?? responseBody.message) : null;
  const errorString = typeof errorField === 'string'
    ? errorField
    : errorField?.message || (errorField ? JSON.stringify(errorField) : '');
  const errorTag = bodyIsObj ? responseBody.tag : null;

  // AgentKit / proof-of-humanity detection — check both the original challenge
  // AND the error response. Exa's 400 response doesn't echo the agentkit block;
  // we correlate by tag + challenge extensions.
  const challengeHasAgentKit =
    challenge?.extensions?.agentkit ||
    challenge?.agentkit ||
    (Array.isArray(challenge?.accepts) &&
      challenge.accepts.some((a: any) => a?.extra?.agentkit || a?.extensions?.agentkit));
  if (challengeHasAgentKit || errorTag === 'X402_INVALID_SIGNATURE') {
    return {
      code: 'AGENTKIT_REQUIRED',
      explanation: 'Vendor requires an AgentKit proof-of-humanity signature (e.g. World ID on Worldcoin Chain) in addition to x402 payment. Sly does not provision human-attested keys yet.',
      recommendation: 'Track as coverage gap (Epic 80). Skip this vendor until we add human-attested custody.',
    };
  }

  // Non-standard auth (Venice-style pre-pay)
  const authOptions = challenge?.authOptions;
  if (authOptions?.x402Wallet?.topUp || authOptions?.apiKey) {
    const modes = Object.keys(authOptions).join('/');
    return {
      code: 'NON_STANDARD_AUTH_PREPAY',
      explanation: `Vendor declared non-standard auth options (${modes}) — typically a pre-pay balance or API key rather than per-call X-PAYMENT. Our signature was correct; their facilitator doesn't honor it.`,
      recommendation: 'Skip this vendor unless we add a pre-pay / keyed-auth adapter.',
    };
  }

  // Facilitator rejected our payment explicitly
  if (responseStatus === 400 && /invalid.*signature|invalid.*payment/i.test(errorString)) {
    return {
      code: 'FACILITATOR_REJECTED_INVALID',
      explanation: `Facilitator rejected our signature as invalid: "${errorString.slice(0, 120)}". Envelope + sig verified compliant with @x402/core reference; most likely facilitator-side bug or undocumented requirement.`,
      recommendation: 'File a coverage gap; correlate with facilitator if support channel exists.',
    };
  }

  // Facilitator silently rejects — 402 returned with the same challenge again.
  // Some vendors attach a demo / free fallback URL in the 402 body (e.g.
  // TrustLayer's {"x-trustlayer":{"demo":{"url":"..."}}}). Surface it in the
  // recommendation so the caller can fall back without guessing.
  if (responseStatus === 402) {
    const demoUrl = bodyIsObj ? findDemoUrl(responseBody) : null;
    const base = 'Facilitator returned 402 again after receiving X-PAYMENT, with no error detail. Likely their paid path is not operational or requires a non-standard scheme.';
    if (demoUrl) {
      return {
        code: 'FACILITATOR_REJECTED_SILENT',
        explanation: base,
        recommendation: `Vendor advertised a free fallback at ${demoUrl} — use it for this call. File a bug with the vendor if you need the paid endpoint.`,
      };
    }
    return {
      code: 'FACILITATOR_REJECTED_SILENT',
      explanation: base,
      recommendation: 'Skip this vendor; worth a bug report with their support.',
    };
  }

  if (responseStatus === 401) {
    return {
      code: 'AUTH_REQUIRED',
      explanation: 'Vendor returned 401 — they require traditional API-key authentication, not x402 payment.',
      recommendation: 'Use an API key via the credential vault (Epic 78) when shipped.',
    };
  }

  if (responseStatus === 403) {
    return {
      code: 'FORBIDDEN',
      explanation: `Vendor returned 403 — allowlist, scope, or geo restriction: "${errorString.slice(0, 120) || responseBodyRaw.slice(0, 120)}"`,
      recommendation: 'Check if vendor requires additional setup / whitelist.',
    };
  }

  if (responseStatus >= 500) {
    if (responseBodyRaw.length === 0) {
      return {
        code: 'VENDOR_EMPTY_RESPONSE',
        explanation: `Vendor returned ${responseStatus} with empty body — likely an upstream runtime crash after (or despite) accepting payment.`,
        recommendation: 'Retry later; monitor vendor reliability.',
      };
    }
    return {
      code: 'VENDOR_BACKEND_ERROR',
      explanation: `Vendor returned ${responseStatus} with error: "${errorString.slice(0, 120) || responseBodyRaw.slice(0, 120)}"`,
      recommendation: 'Retry later; likely transient.',
    };
  }

  if (responseStatus >= 400 && responseStatus < 500) {
    return {
      code: 'HTTP_CLIENT_ERROR',
      explanation: `Vendor returned ${responseStatus}: "${errorString.slice(0, 120) || responseBodyRaw.slice(0, 120)}"`,
      recommendation: 'Check request body against vendor schema.',
    };
  }

  return {
    code: 'UNKNOWN',
    explanation: `Unexpected status ${responseStatus}. Response preview: ${responseBodyRaw.slice(0, 120)}`,
  };
}

// Return the first `accepts[]` entry we can actually sign for. Some
// facilitators offer multiple network options (e.g. StableTravel returns
// both Base and Solana); we skip entries whose network isn't one of the
// EVM chains we have USDC configured for.
function pickX402Accept(challenge: any): any | null {
  if (!challenge || typeof challenge !== 'object') return null;
  if (Array.isArray(challenge.accepts) && challenge.accepts.length > 0) {
    // Prefer a supported EVM entry; fall back to the first entry so the
    // caller gets a clear error downstream if nothing matches.
    const supported = challenge.accepts.find((a: any) => {
      if (!a || typeof a !== 'object') return false;
      return networkToChainId(a.network) !== null;
    });
    return supported || challenge.accepts[0];
  }
  if (challenge.scheme && challenge.network) return challenge;
  return null;
}

// Parse the base64-encoded `payment-required` response header that some
// facilitators (StableTravel on Vercel, others following the x402 header-
// based challenge pattern) use INSTEAD of a JSON body. Returns null if the
// header is missing or malformed.
function decodePaymentRequiredHeader(header: string | null | undefined): any | null {
  if (!header) return null;
  try {
    const json = typeof Buffer !== 'undefined'
      ? Buffer.from(header, 'base64').toString('utf8')
      // @ts-ignore — atob in edge/browser
      : decodeURIComponent(escape(atob(header)));
    return JSON.parse(json);
  } catch {
    return null;
  }
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

// Build the base64-encoded X-PAYMENT value. We include `scheme` and `network`
// at the top level because some facilitators (SlamAI) REQUIRE them; others
// (PaySponge, @x402/core reference) tolerate them. The @x402/core source
// doesn't include them, but real-world facilitator compatibility beats spec
// purity — their presence never breaks anything observed in our test matrix.
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
      authorization: {
        from: signed.from,
        to: signed.to,
        value: String(signed.value),
        validAfter: String(signed.validAfter ?? 0),
        validBefore: String(signed.validBefore),
        nonce: signed.nonce,
      },
      signature: signed.signature,
    },
  };

  const json = JSON.stringify(envelope);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(json, 'utf8').toString('base64');
  }
  // @ts-ignore — btoa exists in Edge/browser runtimes
  return btoa(unescape(encodeURIComponent(json)));
}
