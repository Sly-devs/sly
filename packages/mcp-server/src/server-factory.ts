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
import type { Sly } from '@sly/sdk';
import { tools } from './tools.js';

/**
 * Create an MCP Server with all Sly tools registered.
 *
 * @param sly - Authenticated Sly SDK instance
 * @param apiUrl - Base API URL for direct fetch calls (batch operations)
 * @param apiKey - API key for direct fetch Authorization headers
 * @returns Configured MCP Server (not yet connected to a transport)
 */
export function createMcpServer(sly: Sly, apiUrl: string, apiKey: string): Server {
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
        const quote = await sly.getSettlementQuote(args as any);
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
        const settlement = await sly.createSettlement(args as any);
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
        const settlement = await sly.getSettlement(settlementId);
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
        const profile = await sly.ucp.discover(merchantUrl);
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
        const result = await sly.request('/v1/ucp/checkouts', {
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
        const result = await sly.request(`/v1/ucp/checkouts/${checkoutId}`);
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
        const result = await sly.request(`/v1/ucp/checkouts${query ? `?${query}` : ''}`);
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
        const result = await sly.request(`/v1/ucp/checkouts/${checkoutId}`, {
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
        const result = await sly.request(`/v1/ucp/checkouts/${checkoutId}/complete`, {
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
        const result = await sly.request(`/v1/ucp/checkouts/${checkoutId}/cancel`, {
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
        const result = await sly.request(`/v1/ucp/checkouts/${checkoutId}/instruments`, {
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
        const batchRes = await fetch(`${apiUrl}/v1/ucp/checkouts/batch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
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

        const batchRes = await fetch(`${apiUrl}/v1/ucp/checkouts/batch-complete`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
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
        const result = await sly.request(`/v1/ucp/orders${query ? `?${query}` : ''}`);
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
        const result = await sly.request(`/v1/ucp/orders/${orderId}`);
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
        const result = await sly.request(`/v1/ucp/orders/${orderId}/status`, {
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
        const result = await sly.request(`/v1/ucp/orders/${orderId}/cancel`, {
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
        const result = await sly.request(`/v1/ucp/orders/${orderId}/events`, {
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
        const result = await sly.request(`/v1/ucp/merchants${query ? `?${query}` : ''}`);
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
        const result = await sly.request(`/v1/ucp/merchants/${merchantId}`);
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
        const result = await sly.request(`/v1/accounts${query ? `?${query}` : ''}`);
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
        const result = await sly.request('/v1/accounts', {
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
        const result = await sly.request(`/v1/accounts/${accountId}`, {
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
        const result = await sly.request('/v1/context/whoami');
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
        const result = await sly.request('/v1/agents', {
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
        const result = await sly.request(`/v1/agents/${agentId}/verify`, {
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
        const result = await sly.request(`/v1/agents/${agentId}`);
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
        const result = await sly.request(`/v1/agents/${agentId}/limits`);
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
        const result = await sly.request(`/v1/agents/${agentId}/transactions${query ? `?${query}` : ''}`);
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
        const result = await sly.request(`/v1/agents/${agentId}`, {
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
        const result = await sly.request(`/v1/ap2/mandates/${mandateId}/cancel`, {
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
        const result = await sly.ap2.createMandate({
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
        const result = await sly.ap2.getMandate(mandateId);
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
        const result = await sly.ap2.executeMandate(mandateId, {
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
        const result = await sly.ap2.listMandates({
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
        const result = await sly.request(`/v1/ap2/mandates/${mandateId}`, {
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
        const result = await sly.acp.createCheckout({
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
        const result = await sly.acp.getCheckout(checkoutId);
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
        const result = await sly.acp.completeCheckout(checkoutId, {
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
        const result = await sly.acp.listCheckouts({
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

        const batchRes = await fetch(`${apiUrl}/v1/acp/checkouts/batch`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
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
        const result = await sly.request(`/v1/wallets${query ? `?${query}` : ''}`);
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
        const result = await sly.request('/v1/wallets', {
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
        const result = await sly.request(`/v1/wallets/${walletId}`);
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
        const result = await sly.request(`/v1/wallets/${walletId}/balance`);
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
        const result = await sly.request(`/v1/wallets/${walletId}/deposit`, {
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
        const result = await sly.request(`/v1/wallets/${walletId}/withdraw`, {
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
        const result = await sly.request(`/v1/wallets/${walletId}/test-fund`, {
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
        const result = await sly.request(`/v1/agents/${agentId}/wallet/policy/evaluate`, {
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
        const result = await sly.request(`/v1/agents/${agentId}/wallet/exposures`);
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
        const result = await sly.request(`/v1/agents/${agentId}/wallet/policy/evaluations${qs ? `?${qs}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_get': {
        const { agentId } = args as { agentId: string };
        const result = await sly.request(`/v1/agents/${agentId}/wallet`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_freeze': {
        const { agentId } = args as { agentId: string };
        const result = await sly.request(`/v1/agents/${agentId}/wallet/freeze`, {
          method: 'POST',
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'agent_wallet_unfreeze': {
        const { agentId } = args as { agentId: string };
        const result = await sly.request(`/v1/agents/${agentId}/wallet/unfreeze`, {
          method: 'POST',
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
        const result = await sly.request(`/v1/agents/${agentId}/wallet/policy`, {
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
        const result = await sly.request('/v1/x402/endpoints', {
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
        const result = await sly.request(`/v1/x402/endpoints${query ? `?${query}` : ''}`);
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
        const result = await sly.request(`/v1/x402/endpoints/${endpointId}`);
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
        const result = await sly.request('/v1/x402/pay', {
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
        const result = await sly.request('/v1/x402/verify', {
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

      // ====================================================================
      // A2A Tools
      // ====================================================================
      case 'a2a_discover_agent': {
        const { url } = args as { url: string };
        const result = await sly.request('/v1/a2a/discover', {
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
        const result = await sly.request('/v1/a2a/tasks', {
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
        const result = await sly.request(`/v1/a2a/tasks/${task_id}`, {
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
        const result = await sly.request(`/v1/a2a/tasks${query ? `?${query}` : ''}`, {
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
        const result = await sly.request('/v1/mpp/pay', {
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
        const result = await sly.request('/v1/mpp/sessions', {
          method: 'POST',
          body: JSON.stringify({ service_url, deposit_amount, max_budget, agent_id, wallet_id, currency }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_get_session': {
        const { session_id } = args as { session_id: string };
        const result = await sly.request(`/v1/mpp/sessions/${session_id}`);
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
        const result = await sly.request(`/v1/mpp/sessions${query ? `?${query}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_close_session': {
        const { session_id } = args as { session_id: string };
        const result = await sly.request(`/v1/mpp/sessions/${session_id}/close`, {
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
        const result = await sly.request(`/v1/mpp/transfers${query ? `?${query}` : ''}`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      case 'mpp_verify_receipt': {
        const { receipt_id } = args as { receipt_id: string };
        const result = await sly.request('/v1/mpp/receipts/verify', {
          method: 'POST',
          body: JSON.stringify({ receipt_id }),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error: any) {
    const details = error.details || error.errors || '';
    const detailsStr = details ? `\nDetails: ${JSON.stringify(details, null, 2)}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}${detailsStr}`,
        },
      ],
      isError: true,
    };
  }
  });

  return server;
}
