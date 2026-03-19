/**
 * MCP Tool Definitions
 *
 * All Sly MCP tools extracted for reuse across transports
 * (stdio for Claude Desktop, HTTP for remote clients like Intercom Fin).
 */

import { Tool } from '@modelcontextprotocol/sdk/types.js';

export const tools: Tool[] = [
  // ==========================================================================
  // Core Settlement Tools
  // ==========================================================================
  {
    name: 'get_settlement_quote',
    description: 'Get a settlement quote for cross-border payment with FX rates and fees',
    inputSchema: {
      type: 'object',
      properties: {
        fromCurrency: {
          type: 'string',
          enum: ['USD', 'BRL', 'MXN', 'USDC'],
          description: 'Source currency',
        },
        toCurrency: {
          type: 'string',
          enum: ['USD', 'BRL', 'MXN', 'USDC'],
          description: 'Destination currency',
        },
        amount: {
          type: 'string',
          description: 'Amount to convert',
        },
        rail: {
          type: 'string',
          enum: ['pix', 'spei', 'wire', 'usdc'],
          description: 'Settlement rail (optional)',
        },
      },
      required: ['fromCurrency', 'toCurrency', 'amount'],
    },
  },
  {
    name: 'create_settlement',
    description: 'Execute a settlement using a quote',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'string',
          description: 'Quote ID from get_settlement_quote',
        },
        destinationAccountId: {
          type: 'string',
          description: 'Destination account ID',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata',
        },
      },
      required: ['quoteId', 'destinationAccountId'],
    },
  },
  {
    name: 'get_settlement_status',
    description: 'Check the status of a settlement',
    inputSchema: {
      type: 'object',
      properties: {
        settlementId: {
          type: 'string',
          description: 'Settlement ID',
        },
      },
      required: ['settlementId'],
    },
  },

  // ==========================================================================
  // UCP (Universal Commerce Protocol) Tools
  // ==========================================================================
  {
    name: 'ucp_discover',
    description: 'Discover a UCP merchant\'s capabilities by fetching their /.well-known/ucp profile. Use this to find out what a merchant supports before creating a checkout.',
    inputSchema: {
      type: 'object',
      properties: {
        merchantUrl: {
          type: 'string',
          description: 'The merchant\'s base URL (e.g., https://shop.example.com)',
        },
      },
      required: ['merchantUrl'],
    },
  },

  // UCP Checkout Session Management
  {
    name: 'ucp_create_checkout',
    description: 'Create a UCP checkout session with line items, buyer info, and payment configuration. Sessions expire after 6 hours by default.',
    inputSchema: {
      type: 'object',
      properties: {
        currency: {
          type: 'string',
          description: 'ISO 4217 pricing currency, exactly 3 characters (e.g., "USD", "BRL", "MXN"). This is the display/pricing currency — the actual payment method (USDC, card, etc.) is set via the payment instrument.',
        },
        line_items: {
          type: 'array',
          description: 'Items in the checkout',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique item identifier (required, e.g., "item_sneakers")' },
              name: { type: 'string', description: 'Item name' },
              quantity: { type: 'integer', description: 'Quantity (positive integer)' },
              unit_price: { type: 'integer', description: 'Price per unit in cents (e.g., 2999 = $29.99)' },
              total_price: { type: 'integer', description: 'Line total in cents (quantity * unit_price)' },
              description: { type: 'string', description: 'Item description (optional)' },
              image_url: { type: 'string', description: 'Product image URL (optional)' },
              product_url: { type: 'string', description: 'Product page URL (optional)' },
            },
            required: ['id', 'name', 'quantity', 'unit_price', 'total_price'],
          },
        },
        buyer: {
          type: 'object',
          description: 'Buyer information (optional)',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' },
            phone: { type: 'string' },
          },
        },
        shipping_address: {
          type: 'object',
          description: 'Shipping address (optional)',
          properties: {
            line1: { type: 'string' },
            line2: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postal_code: { type: 'string' },
            country: { type: 'string' },
          },
          required: ['line1', 'city', 'postal_code', 'country'],
        },
        payment_config: {
          type: 'object',
          description: 'Payment configuration (optional)',
          properties: {
            handlers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Accepted payment handlers',
            },
            default_handler: { type: 'string' },
            capture_method: { type: 'string', enum: ['automatic', 'manual'] },
          },
        },
        payment_instruments: {
          type: 'array',
          description: 'Payment instruments. If provided, the first is auto-selected — the checkout can skip the add-instrument step and go straight to ready_for_complete.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique instrument identifier (e.g., "pi_sly_usdc_1")' },
              handler: { type: 'string', description: 'Payment handler (e.g., "sly")' },
              type: { type: 'string', description: 'Instrument type (e.g., "usdc", "card")' },
              last4: { type: 'string', description: 'Last 4 digits (optional)' },
              brand: { type: 'string', description: 'Brand name (optional)' },
            },
            required: ['id', 'handler', 'type'],
          },
        },
        checkout_type: {
          type: 'string',
          enum: ['physical', 'digital', 'service'],
          description: 'Checkout type. "digital" and "service" skip the shipping address requirement. Default: "physical".',
        },
        metadata: {
          type: 'object',
          description: 'Custom metadata (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'Agent ID to attribute this checkout to (optional)',
        },
      },
      required: ['currency', 'line_items'],
    },
  },
  {
    name: 'ucp_get_checkout',
    description: 'Get UCP checkout session details including line items, totals, payment instruments, and messages.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'UUID of the checkout session',
        },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'ucp_list_checkouts',
    description: 'List UCP checkout sessions with optional filtering by status or agent.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['incomplete', 'requires_escalation', 'ready_for_complete', 'complete_in_progress', 'completed', 'canceled'],
          description: 'Filter by checkout status (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID (optional)',
        },
        page: { type: 'number', description: 'Page number (optional)' },
        limit: { type: 'number', description: 'Results per page (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'ucp_update_checkout',
    description: 'Update a UCP checkout session — change line items, addresses, buyer info, or metadata. Cannot update completed or cancelled checkouts.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'UUID of the checkout session',
        },
        line_items: {
          type: 'array',
          description: 'Updated line items (optional)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              quantity: { type: 'number' },
              unit_price: { type: 'number' },
              total_price: { type: 'number' },
            },
            required: ['name', 'quantity', 'unit_price', 'total_price'],
          },
        },
        buyer: { type: 'object', description: 'Updated buyer info (optional)' },
        shipping_address: { type: 'object', description: 'Updated shipping address (optional)' },
        billing_address: { type: 'object', description: 'Updated billing address (optional)' },
        metadata: { type: 'object', description: 'Updated metadata (optional)' },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'ucp_complete_checkout',
    description: 'Complete a UCP checkout — processes payment and creates an order. The checkout must have all required fields and a selected payment instrument. If a mandate_id is in the checkout metadata, the mandate budget must have sufficient remaining balance or the checkout will be rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'UUID of the checkout session to complete',
        },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'ucp_cancel_checkout',
    description: 'Cancel a UCP checkout session.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'UUID of the checkout session to cancel',
        },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'ucp_add_payment_instrument',
    description: 'Add a payment instrument (method) to a UCP checkout session.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'UUID of the checkout session',
        },
        id: {
          type: 'string',
          description: 'Unique instrument identifier (e.g., "pi_sly_usdc_1")',
        },
        handler: {
          type: 'string',
          description: 'Payment handler identifier (e.g., "stripe", "sly")',
        },
        type: {
          type: 'string',
          description: 'Instrument type (e.g., "card", "wallet", "usdc")',
        },
        last4: {
          type: 'string',
          description: 'Last 4 digits for display (optional)',
        },
        brand: {
          type: 'string',
          description: 'Card brand or wallet name (optional)',
        },
        metadata: {
          type: 'object',
          description: 'Additional instrument data (optional)',
        },
      },
      required: ['checkoutId', 'id', 'handler', 'type'],
    },
  },

  {
    name: 'ucp_batch_checkout',
    description: 'Create and complete multiple UCP checkouts in one call. Each checkout spec should include all required fields (line_items, buyer, shipping_address or checkout_type=digital/service, and payment_instruments). Checkouts that reach ready_for_complete are auto-completed. Returns an array of results.',
    inputSchema: {
      type: 'object',
      properties: {
        checkouts: {
          type: 'array',
          description: 'Array of checkout specifications to create and complete',
          items: {
            type: 'object',
            properties: {
              currency: { type: 'string', description: 'ISO 4217 currency (e.g., "USD")' },
              line_items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    quantity: { type: 'integer' },
                    unit_price: { type: 'integer' },
                    total_price: { type: 'integer' },
                    description: { type: 'string' },
                  },
                  required: ['id', 'name', 'quantity', 'unit_price', 'total_price'],
                },
              },
              buyer: {
                type: 'object',
                properties: {
                  email: { type: 'string' },
                  name: { type: 'string' },
                },
              },
              shipping_address: {
                type: 'object',
                properties: {
                  line1: { type: 'string' },
                  city: { type: 'string' },
                  postal_code: { type: 'string' },
                  country: { type: 'string' },
                  state: { type: 'string' },
                },
                required: ['line1', 'city', 'postal_code', 'country'],
              },
              payment_instruments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    handler: { type: 'string' },
                    type: { type: 'string' },
                  },
                  required: ['id', 'handler', 'type'],
                },
              },
              checkout_type: {
                type: 'string',
                enum: ['physical', 'digital', 'service'],
              },
              metadata: { type: 'object' },
              agent_id: { type: 'string', description: 'Agent ID to attribute this checkout to' },
            },
            required: ['currency', 'line_items'],
          },
        },
      },
      required: ['checkouts'],
    },
  },

  {
    name: 'ucp_batch_complete',
    description: 'Batch-complete multiple pending UCP checkouts. Adds a payment instrument to each checkout and completes it in one call. Use after ucp_batch_checkout when checkouts were created without payment instruments.',
    inputSchema: {
      type: 'object',
      properties: {
        checkout_ids: {
          type: 'array',
          description: 'Array of checkout UUIDs to complete',
          items: { type: 'string' },
        },
        default_payment_instrument: {
          type: 'object',
          description: 'Payment instrument applied to all checkouts',
          properties: {
            id: { type: 'string' },
            handler: { type: 'string' },
            type: { type: 'string' },
          },
          required: ['id', 'handler', 'type'],
        },
      },
      required: ['checkout_ids', 'default_payment_instrument'],
    },
  },

  // UCP Order Management
  {
    name: 'ucp_list_orders',
    description: 'List UCP orders with optional filtering by status or agent.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
          description: 'Filter by order status (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID (optional)',
        },
        page: { type: 'number', description: 'Page number (optional)' },
        limit: { type: 'number', description: 'Results per page (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'ucp_get_order',
    description: 'Get UCP order details including line items, payment info, fulfillment events, and adjustments.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'UUID of the order',
        },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'ucp_update_order_status',
    description: 'Update UCP order status. Valid transitions: confirmed → processing → shipped → delivered.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'UUID of the order',
        },
        status: {
          type: 'string',
          enum: ['processing', 'shipped', 'delivered'],
          description: 'New order status',
        },
      },
      required: ['orderId', 'status'],
    },
  },
  {
    name: 'ucp_cancel_order',
    description: 'Cancel a UCP order. Optionally provide a reason.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'UUID of the order to cancel',
        },
        reason: {
          type: 'string',
          description: 'Cancellation reason (optional)',
        },
      },
      required: ['orderId'],
    },
  },
  {
    name: 'ucp_add_fulfillment_event',
    description: 'Record a fulfillment event on a UCP order (e.g., shipped, in_transit, delivered).',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'UUID of the order',
        },
        type: {
          type: 'string',
          enum: ['shipped', 'in_transit', 'out_for_delivery', 'delivered', 'returned'],
          description: 'Event type',
        },
        description: {
          type: 'string',
          description: 'Event description',
        },
        tracking_number: {
          type: 'string',
          description: 'Tracking number (optional)',
        },
        carrier: {
          type: 'string',
          description: 'Shipping carrier (optional)',
        },
      },
      required: ['orderId', 'type', 'description'],
    },
  },

  // ==========================================================================
  // Merchant Catalog Tools
  // ==========================================================================
  {
    name: 'list_merchants',
    description: 'List merchants with product catalogs available in the tenant. Filter by type, country, or search by name.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Merchant type filter (e.g., "restaurant", "bar", "hotel", "retail")',
        },
        country: {
          type: 'string',
          description: 'Country code filter (e.g., "PA", "CR")',
        },
        search: {
          type: 'string',
          description: 'Search merchants by name',
        },
        limit: {
          type: 'number',
          description: 'Max results (default 50, max 100)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_merchant',
    description: 'Get a merchant\'s full product catalog by ID. Returns all products with prices, categories, and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        merchantId: {
          type: 'string',
          description: 'Merchant UUID or merchant_id (e.g., "invu_merch_003")',
        },
      },
      required: ['merchantId'],
    },
  },

  // ==========================================================================
  // Agent Management Tools
  // ==========================================================================
  {
    name: 'list_accounts',
    description: 'List entity records (persons and businesses) in the tenant\'s payment ledger. Use this to find a business entity for agent creation.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['person', 'business'],
          description: 'Filter by account type (optional)',
        },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'suspended'],
          description: 'Filter by account status (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_account',
    description: 'Register a new person or business entity in the tenant\'s payment ledger. This adds a data record — it does not create a login or sign up for any external service.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['person', 'business'],
          description: 'Account type',
        },
        name: {
          type: 'string',
          description: 'Account holder name (1-255 chars)',
        },
        email: {
          type: 'string',
          description: 'Email address (optional)',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata',
        },
      },
      required: ['type', 'name'],
    },
  },
  {
    name: 'update_account',
    description: 'Update an entity record in the tenant\'s payment ledger. Can change name, email, or metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'UUID of the account to update',
        },
        name: {
          type: 'string',
          description: 'New name (optional)',
        },
        email: {
          type: 'string',
          description: 'New email (optional)',
        },
        metadata: {
          type: 'object',
          description: 'Metadata object (replaces existing)',
        },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'get_tenant_info',
    description: 'Get information about the current tenant/organization this API key belongs to.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_agent',
    description: 'Register a new AI agent under a business account. The agent can then be verified and given spending mandates.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'UUID of the parent business account',
        },
        name: {
          type: 'string',
          description: 'Name for the agent (e.g., "Shopping Agent")',
        },
        description: {
          type: 'string',
          description: 'Description of what the agent does (optional)',
        },
      },
      required: ['accountId', 'name'],
    },
  },
  {
    name: 'verify_agent',
    description: 'Verify an agent at a KYA (Know Your Agent) tier. Higher tiers unlock higher spending limits. Tier 1 is sufficient for most use cases.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent to verify',
        },
        tier: {
          type: 'number',
          enum: [1, 2, 3],
          description: 'KYA verification tier (1=Standard, 2=Advanced, 3=Enterprise)',
        },
      },
      required: ['agentId', 'tier'],
    },
  },
  {
    name: 'get_agent',
    description: 'Get details of a specific agent including its KYA tier, status, and permissions.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_agent_limits',
    description: 'Get the spending limits and current usage for an agent. Shows per-transaction and daily limits based on KYA tier.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'get_agent_transactions',
    description: 'Get transaction history for an agent. Returns all UCP and ACP checkouts attributed to the agent, with pagination and optional date filters.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
        limit: {
          type: 'number',
          description: 'Max results per page (default 20)',
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default 0)',
        },
        from: {
          type: 'string',
          description: 'Filter from date (ISO 8601, optional)',
        },
        to: {
          type: 'string',
          description: 'Filter to date (ISO 8601, optional)',
        },
      },
      required: ['agentId'],
    },
  },

  {
    name: 'delete_agent',
    description: 'Delete an agent. Removes the agent record. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent to delete',
        },
      },
      required: ['agentId'],
    },
  },

  // ==========================================================================
  // AP2 (Agent-to-Agent Protocol) Mandate Tools
  // ==========================================================================
  {
    name: 'ap2_cancel_mandate',
    description: 'Cancel an active mandate. Sets status to cancelled so no further executions can be made.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateId: {
          type: 'string',
          description: 'UUID or external mandate_id of the mandate to cancel',
        },
      },
      required: ['mandateId'],
    },
  },
  {
    name: 'ap2_create_mandate',
    description: 'Create a spending mandate that authorizes an agent to spend up to a budget. The mandate tracks spending and enforces limits.',
    inputSchema: {
      type: 'object',
      properties: {
        mandate_id: {
          type: 'string',
          description: 'Unique identifier for the mandate (e.g., "mandate_shopping_001")',
        },
        agent_id: {
          type: 'string',
          description: 'UUID of the agent this mandate is for',
        },
        account_id: {
          type: 'string',
          description: 'UUID of the account funding the mandate',
        },
        authorized_amount: {
          type: 'number',
          description: 'Maximum amount the agent can spend under this mandate',
        },
        currency: {
          type: 'string',
          description: 'Currency for the mandate (default: USD)',
        },
        mandate_type: {
          type: 'string',
          enum: ['intent', 'cart', 'payment'],
          description: 'Type of mandate (default: payment)',
        },
        description: {
          type: 'string',
          description: 'Human-readable description of what this mandate is for (optional)',
        },
        expires_at: {
          type: 'string',
          description: 'ISO 8601 expiration timestamp (optional)',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata. Use "priority" key (number 1-3) to set mandate priority: 1=High, 2=Medium, 3=Low. Example: {"priority": 1}',
        },
        mandate_data: {
          type: 'object',
          description: 'Optional mandate data (e.g., destination info, constraints)',
        },
      },
      required: ['mandate_id', 'agent_id', 'account_id', 'authorized_amount'],
    },
  },
  {
    name: 'ap2_get_mandate',
    description: 'Get mandate details including execution history, remaining budget, and status.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateId: {
          type: 'string',
          description: 'The mandate ID',
        },
      },
      required: ['mandateId'],
    },
  },
  {
    name: 'ap2_execute_mandate',
    description: 'Execute a payment against a mandate. Deducts from the mandate budget and creates a transfer.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateId: {
          type: 'string',
          description: 'The mandate ID to execute against',
        },
        amount: {
          type: 'number',
          description: 'Amount to pay',
        },
        currency: {
          type: 'string',
          description: 'Currency (should match mandate currency)',
        },
        description: {
          type: 'string',
          description: 'Description of this payment (optional)',
        },
        order_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of UCP order IDs funded by this execution (optional)',
        },
      },
      required: ['mandateId', 'amount'],
    },
  },
  {
    name: 'ap2_list_mandates',
    description: 'List mandates with optional filtering by status, agent, or account.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'completed', 'cancelled', 'expired'],
          description: 'Filter by mandate status (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID (optional)',
        },
        account_id: {
          type: 'string',
          description: 'Filter by account ID (optional)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (optional)',
        },
      },
      required: [],
    },
  },

  {
    name: 'ap2_update_mandate',
    description: 'Update a mandate. Can change authorized_amount, expires_at, status, metadata, mandate_data, or description.',
    inputSchema: {
      type: 'object',
      properties: {
        mandateId: {
          type: 'string',
          description: 'UUID or external mandate_id of the mandate to update',
        },
        authorized_amount: {
          type: 'number',
          description: 'New authorized amount (optional)',
        },
        status: {
          type: 'string',
          description: 'New status (optional)',
        },
        expires_at: {
          type: 'string',
          description: 'New expiration timestamp ISO 8601 (optional)',
        },
        metadata: {
          type: 'object',
          description: 'Updated metadata object. Use "priority" key (number 1-3) to set priority: 1=High, 2=Medium, 3=Low (optional)',
        },
        mandate_data: {
          type: 'object',
          description: 'Updated mandate_data object (optional)',
        },
        description: {
          type: 'string',
          description: 'Updated description (optional)',
        },
      },
      required: ['mandateId'],
    },
  },

  // ==========================================================================
  // ACP (Agentic Commerce Protocol) Checkout Tools
  // ==========================================================================
  {
    name: 'acp_create_checkout',
    description: 'Create a checkout session with items for an agent to purchase. This is the first step in the shopping flow.',
    inputSchema: {
      type: 'object',
      properties: {
        checkout_id: {
          type: 'string',
          description: 'Unique identifier for the checkout (e.g., "checkout_001")',
        },
        agent_id: {
          type: 'string',
          description: 'UUID of the agent making the purchase',
        },
        account_id: {
          type: 'string',
          description: 'UUID of the account funding the checkout (optional, defaults to agent\'s account)',
        },
        merchant_id: {
          type: 'string',
          description: 'Identifier for the merchant (e.g., "merchant_nike")',
        },
        items: {
          type: 'array',
          description: 'Array of items to purchase',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Item name',
              },
              description: {
                type: 'string',
                description: 'Item description (optional)',
              },
              quantity: {
                type: 'number',
                description: 'Quantity to purchase',
              },
              unit_price: {
                type: 'number',
                description: 'Price per unit',
              },
              total_price: {
                type: 'number',
                description: 'Total price for this line item (quantity * unit_price)',
              },
            },
            required: ['name', 'quantity', 'unit_price', 'total_price'],
          },
        },
        tax_amount: {
          type: 'number',
          description: 'Tax amount (optional)',
        },
        shipping_amount: {
          type: 'number',
          description: 'Shipping amount (optional)',
        },
        payment_method: {
          type: 'string',
          description: 'Payment method (optional)',
        },
        checkout_data: {
          type: 'object',
          description: 'Additional checkout data (optional)',
        },
      },
      required: ['checkout_id', 'agent_id', 'merchant_id', 'items'],
    },
  },
  {
    name: 'acp_get_checkout',
    description: 'Get checkout details including items, totals, and current status.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'The checkout ID',
        },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'acp_complete_checkout',
    description: 'Complete and pay for a checkout. Use the checkout UUID (not the string checkout_id). In sandbox, a test payment token is generated automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        checkoutId: {
          type: 'string',
          description: 'The checkout UUID (id field, not checkout_id)',
        },
        shared_payment_token: {
          type: 'string',
          description: 'Shared payment token. In sandbox, defaults to a test token (spt_test_...) if omitted.',
        },
        payment_method: {
          type: 'string',
          description: 'Payment method (optional)',
        },
      },
      required: ['checkoutId'],
    },
  },
  {
    name: 'acp_list_checkouts',
    description: 'List checkouts with optional filtering by status, agent, or merchant.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'completed', 'cancelled', 'expired'],
          description: 'Filter by checkout status (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID (optional)',
        },
        merchant_id: {
          type: 'string',
          description: 'Filter by merchant ID (optional)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (optional)',
        },
      },
      required: [],
    },
  },

  {
    name: 'acp_batch_checkout',
    description: 'Batch-create multiple ACP checkout sessions in one call. Each checkout spec should include all required fields (checkout_id, agent_id, account_id, merchant_id, items). Returns an array of results.',
    inputSchema: {
      type: 'object',
      properties: {
        checkouts: {
          type: 'array',
          description: 'Array of ACP checkout specifications to create',
          items: {
            type: 'object',
            properties: {
              checkout_id: { type: 'string', description: 'Unique identifier for the checkout' },
              agent_id: { type: 'string', description: 'UUID of the agent making the purchase' },
              account_id: { type: 'string', description: 'UUID of the account funding the checkout' },
              merchant_id: { type: 'string', description: 'Identifier for the merchant' },
              merchant_name: { type: 'string', description: 'Merchant display name (optional)' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    description: { type: 'string' },
                    quantity: { type: 'number' },
                    unit_price: { type: 'number' },
                    total_price: { type: 'number' },
                  },
                  required: ['name', 'quantity', 'unit_price', 'total_price'],
                },
              },
              tax_amount: { type: 'number', description: 'Tax amount (optional)' },
              shipping_amount: { type: 'number', description: 'Shipping amount (optional)' },
              currency: { type: 'string', description: 'Currency (default: USDC)' },
              metadata: { type: 'object', description: 'Custom metadata (optional)' },
            },
            required: ['checkout_id', 'agent_id', 'account_id', 'merchant_id', 'items'],
          },
        },
      },
      required: ['checkouts'],
    },
  },

  // ==========================================================================
  // Wallet Management Tools
  // ==========================================================================
  {
    name: 'list_wallets',
    description: 'List wallets for the current tenant. Can filter by account, agent, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        owner_account_id: {
          type: 'string',
          description: 'Filter by owner account UUID (optional)',
        },
        managed_by_agent_id: {
          type: 'string',
          description: 'Filter by managing agent UUID (optional)',
        },
        status: {
          type: 'string',
          enum: ['active', 'frozen', 'depleted'],
          description: 'Filter by wallet status (optional)',
        },
        page: {
          type: 'number',
          description: 'Page number (optional)',
        },
        limit: {
          type: 'number',
          description: 'Results per page (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_wallet',
    description: 'Create a new wallet for an account. Supports internal (Sly-managed), Circle custodial, and Circle MPC wallet types.',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: {
          type: 'string',
          description: 'UUID of the account that owns this wallet',
        },
        name: {
          type: 'string',
          description: 'Human-readable wallet name (optional)',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'EURC'],
          description: 'Wallet currency (default: USDC)',
        },
        walletType: {
          type: 'string',
          enum: ['internal', 'circle_custodial', 'circle_mpc'],
          description: 'Wallet type (default: internal)',
        },
        blockchain: {
          type: 'string',
          enum: ['base', 'eth', 'polygon', 'avax', 'sol'],
          description: 'Blockchain network (optional)',
        },
        initialBalance: {
          type: 'number',
          description: 'Initial balance to fund the wallet with (optional)',
        },
        managedByAgentId: {
          type: 'string',
          description: 'UUID of an agent that manages this wallet (optional)',
        },
        purpose: {
          type: 'string',
          description: 'Purpose of the wallet (optional)',
        },
      },
      required: ['accountId'],
    },
  },
  {
    name: 'get_wallet',
    description: 'Get wallet details including balance and recent transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          description: 'UUID of the wallet',
        },
      },
      required: ['walletId'],
    },
  },
  {
    name: 'get_wallet_balance',
    description: 'Get the current balance of a wallet with sync status information.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          description: 'UUID of the wallet',
        },
      },
      required: ['walletId'],
    },
  },
  {
    name: 'wallet_deposit',
    description: 'Deposit funds into a wallet from an account.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          description: 'UUID of the wallet to deposit into',
        },
        amount: {
          type: 'number',
          description: 'Amount to deposit',
        },
        fromAccountId: {
          type: 'string',
          description: 'UUID of the source account',
        },
        reference: {
          type: 'string',
          description: 'Reference note for the deposit (optional)',
        },
      },
      required: ['walletId', 'amount', 'fromAccountId'],
    },
  },
  {
    name: 'wallet_withdraw',
    description: 'Withdraw funds from a wallet to an account.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          description: 'UUID of the wallet to withdraw from',
        },
        amount: {
          type: 'number',
          description: 'Amount to withdraw',
        },
        destinationAccountId: {
          type: 'string',
          description: 'UUID of the destination account',
        },
        reference: {
          type: 'string',
          description: 'Reference note for the withdrawal (optional)',
        },
      },
      required: ['walletId', 'amount', 'destinationAccountId'],
    },
  },
  {
    name: 'wallet_test_fund',
    description: 'Add test funds to a wallet (sandbox/test mode only). Max 100,000 USDC per request.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: {
          type: 'string',
          description: 'UUID of the wallet to fund',
        },
        amount: {
          type: 'number',
          description: 'Amount of test funds to add (max 100,000)',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'EURC'],
          description: 'Currency (default: USDC)',
        },
        reference: {
          type: 'string',
          description: 'Reference note (optional)',
        },
      },
      required: ['walletId', 'amount'],
    },
  },

  // ==========================================================================
  // Agent Wallet Policy Tools (Epic 18)
  // ==========================================================================
  {
    name: 'agent_wallet_evaluate_policy',
    description: 'Evaluate contract policy for an agent payment (dry-run). Returns approve/escalate/deny decision with detailed check results and optional counter-offer.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent whose wallet policy to evaluate',
        },
        amount: {
          type: 'number',
          description: 'Payment amount to evaluate',
        },
        currency: {
          type: 'string',
          description: 'Currency (default: USDC)',
        },
        action_type: {
          type: 'string',
          enum: ['payment', 'escrow_create', 'escrow_release', 'contract_sign', 'negotiation_check', 'counterparty_check'],
          description: 'Type of action to evaluate (default: negotiation_check)',
        },
        contract_type: {
          type: 'string',
          description: 'Contract type (e.g. payment, escrow, subscription, loan)',
        },
        counterparty_agent_id: {
          type: 'string',
          description: 'UUID of the counterparty agent (optional)',
        },
        counterparty_address: {
          type: 'string',
          description: 'Wallet address of external counterparty (optional)',
        },
      },
      required: ['agentId', 'amount'],
    },
  },
  {
    name: 'agent_wallet_get_exposures',
    description: 'List per-counterparty exposure windows (24h/7d/30d) for an agent wallet. Shows active contracts, escrows, and total volume per counterparty.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'agent_wallet_get_evaluations',
    description: 'Get the policy evaluation audit log for an agent wallet. Shows historical approve/escalate/deny decisions with check details.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
        page: {
          type: 'number',
          description: 'Page number (optional)',
        },
        limit: {
          type: 'number',
          description: 'Results per page (optional)',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'agent_wallet_get',
    description: "Get an agent's wallet details including balance, status, and spending policy.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'agent_wallet_freeze',
    description: "Freeze an agent's wallet, disabling all payments. Use to emergency-stop an agent.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent whose wallet to freeze',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'agent_wallet_unfreeze',
    description: "Unfreeze an agent's wallet, re-enabling payments.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent whose wallet to unfreeze',
        },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'agent_wallet_set_policy',
    description: "Set or update the spending and contract policy on an agent's wallet. Supports daily/monthly limits, approval thresholds, counterparty blocklists, exposure caps, and contract type restrictions.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent',
        },
        dailySpendLimit: {
          type: 'number',
          description: 'Daily spending limit in wallet currency (optional)',
        },
        monthlySpendLimit: {
          type: 'number',
          description: 'Monthly spending limit (optional)',
        },
        requiresApprovalAbove: {
          type: 'number',
          description: 'Amount above which human approval is required (optional)',
        },
        approvedVendors: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of approved vendor domains (optional)',
        },
        contractPolicy: {
          type: 'object',
          description: 'Contract policy rules (optional)',
          properties: {
            counterpartyBlocklist: {
              type: 'array',
              items: { type: 'string' },
              description: 'Blocked agent IDs or addresses',
            },
            counterpartyAllowlist: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowed agent IDs or addresses (if set, only these are permitted)',
            },
            minCounterpartyKyaTier: {
              type: 'number',
              description: 'Minimum counterparty KYA tier (0-3)',
            },
            allowedContractTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Allowed contract types (e.g. payment, escrow)',
            },
            blockedContractTypes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Blocked contract types (e.g. loan)',
            },
            maxExposure24h: {
              type: 'number',
              description: 'Max 24h exposure per counterparty',
            },
            maxExposure7d: {
              type: 'number',
              description: 'Max 7d exposure per counterparty',
            },
            maxExposure30d: {
              type: 'number',
              description: 'Max 30d exposure per counterparty',
            },
            maxActiveContracts: {
              type: 'number',
              description: 'Max active contracts per counterparty',
            },
            maxActiveEscrows: {
              type: 'number',
              description: 'Max active escrows per counterparty',
            },
            escalateAbove: {
              type: 'number',
              description: 'Amount above which to escalate to human approval',
            },
          },
        },
      },
      required: ['agentId'],
    },
  },

  // ==========================================================================
  // x402 Micropayment Tools
  // ==========================================================================
  {
    name: 'x402_create_endpoint',
    description: 'Register an x402 payment endpoint. This defines a paid API route with pricing, volume discounts, and webhook notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Endpoint name (1-255 chars)',
        },
        path: {
          type: 'string',
          description: 'API path (must start with /, max 500 chars)',
        },
        method: {
          type: 'string',
          enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ANY'],
          description: 'HTTP method',
        },
        description: {
          type: 'string',
          description: 'What this endpoint provides (optional, max 1000 chars)',
        },
        accountId: {
          type: 'string',
          description: 'UUID of the account receiving payments',
        },
        basePrice: {
          type: 'number',
          description: 'Price per request in token units (e.g., 0.50 for $0.50 USDC). Min 0.0001, max 999999.',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'EURC'],
          description: 'Payment currency (default: USDC)',
        },
        volumeDiscounts: {
          type: 'array',
          description: 'Volume discount tiers (optional)',
          items: {
            type: 'object',
            properties: {
              threshold: { type: 'integer', description: 'Minimum call count to qualify for discount' },
              priceMultiplier: { type: 'number', description: 'Price multiplier (0-1, e.g., 0.9 = 10% off)' },
            },
            required: ['threshold', 'priceMultiplier'],
          },
        },
        webhookUrl: {
          type: 'string',
          description: 'URL to notify on payment (optional, must be valid URL)',
        },
        network: {
          type: 'string',
          description: 'Blockchain network (default: base-mainnet)',
        },
      },
      required: ['name', 'path', 'method', 'accountId', 'basePrice'],
    },
  },
  {
    name: 'x402_list_endpoints',
    description: 'List x402 payment endpoints with optional filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'paused', 'disabled'],
          description: 'Filter by endpoint status (optional)',
        },
        account_id: {
          type: 'string',
          description: 'Filter by account UUID (optional)',
        },
        page: {
          type: 'number',
          description: 'Page number (optional)',
        },
        limit: {
          type: 'number',
          description: 'Results per page (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'x402_get_endpoint',
    description: 'Get x402 endpoint details including pricing, stats, and recent transactions.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: {
          type: 'string',
          description: 'UUID of the endpoint',
        },
      },
      required: ['endpointId'],
    },
  },
  {
    name: 'x402_pay',
    description: 'Make an x402 micropayment to a paid endpoint. Deducts from a wallet and returns a payment proof JWT.',
    inputSchema: {
      type: 'object',
      properties: {
        endpointId: {
          type: 'string',
          description: 'UUID of the x402 endpoint to pay',
        },
        walletId: {
          type: 'string',
          description: 'UUID of the wallet to pay from',
        },
        amount: {
          type: 'number',
          description: 'Payment amount (must match endpoint basePrice)',
        },
        currency: {
          type: 'string',
          enum: ['USDC', 'EURC'],
          description: 'Payment currency (must match endpoint currency)',
        },
        method: {
          type: 'string',
          description: 'HTTP method of the request being paid for (e.g., "GET")',
        },
        path: {
          type: 'string',
          description: 'Path of the request being paid for (e.g., "/api/data")',
        },
      },
      required: ['endpointId', 'walletId', 'amount', 'currency', 'method', 'path'],
    },
  },
  {
    name: 'x402_verify',
    description: 'Verify an x402 payment was completed. Supports fast JWT verification or database verification.',
    inputSchema: {
      type: 'object',
      properties: {
        jwt: {
          type: 'string',
          description: 'JWT payment proof for fast verification (~1ms)',
        },
        requestId: {
          type: 'string',
          description: 'Request ID for database verification (use with transferId)',
        },
        transferId: {
          type: 'string',
          description: 'Transfer ID for database verification (use with requestId)',
        },
      },
      required: [],
    },
  },

  // ==========================================================================
  // A2A Tools (Google Agent-to-Agent Protocol)
  // ==========================================================================
  {
    name: 'a2a_discover_agent',
    description: 'Discover a remote A2A agent by URL. Fetches the agent\'s Agent Card from /.well-known/agent.json, a /card URL, or a per-agent discovery URL (/a2a/{id}/.well-known/agent.json). Returns the agent\'s capabilities, skills, and payment protocols.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Base URL of the remote agent (e.g., https://example.com), direct card URL ending in /card, or per-agent .well-known URL',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'a2a_send_task',
    description: 'Send a message to a local or remote A2A v1.0 agent (message/send). For local agents, provide agent_id. For remote agents, provide remote_url. The message should contain parts describing what the agent should do.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Local Sly agent ID (for sending to a local agent)',
        },
        remote_url: {
          type: 'string',
          description: 'Remote A2A JSON-RPC endpoint URL (for sending to an external agent)',
        },
        message: {
          type: 'string',
          description: 'Text message to send to the agent (will be wrapped as a text part)',
        },
        context_id: {
          type: 'string',
          description: 'Context ID for multi-turn conversations (optional)',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'a2a_get_task',
    description: 'Get the status and details of an A2A task, including its messages, artifacts, and payment info.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The A2A task ID',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'a2a_list_tasks',
    description: 'List A2A tasks for the tenant. Can filter by agent, state, and direction (inbound/outbound).',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID',
        },
        state: {
          type: 'string',
          enum: ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled', 'rejected'],
          description: 'Filter by task state',
        },
        direction: {
          type: 'string',
          enum: ['inbound', 'outbound'],
          description: 'Filter by direction',
        },
        limit: {
          type: 'number',
          description: 'Number of results per page (default: 20, max: 100)',
        },
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
        },
      },
      required: [],
    },
  },

  // ==========================================================================
  // MPP (Machine Payments Protocol) Tools
  // ==========================================================================
  {
    name: 'mpp_pay',
    description: 'Make a one-shot MPP payment to a service. The payment goes through governance checks (spending limits, approval thresholds) before execution.',
    inputSchema: {
      type: 'object',
      properties: {
        service_url: {
          type: 'string',
          description: 'URL of the service to pay (e.g., "https://api.example.com")',
        },
        amount: {
          type: 'number',
          description: 'Payment amount',
        },
        currency: {
          type: 'string',
          description: 'Currency (default: USDC)',
        },
        intent: {
          type: 'string',
          description: 'Description of what the payment is for (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'UUID of the agent making the payment',
        },
        wallet_id: {
          type: 'string',
          description: 'UUID of the wallet to pay from (optional)',
        },
      },
      required: ['service_url', 'amount', 'agent_id'],
    },
  },
  {
    name: 'mpp_open_session',
    description: 'Open a streaming MPP payment session with a deposit. Sessions allow multiple voucher payments to a service within a budget.',
    inputSchema: {
      type: 'object',
      properties: {
        service_url: {
          type: 'string',
          description: 'URL of the service',
        },
        deposit_amount: {
          type: 'number',
          description: 'Initial deposit amount for the session',
        },
        max_budget: {
          type: 'number',
          description: 'Maximum total budget for the session (optional)',
        },
        agent_id: {
          type: 'string',
          description: 'UUID of the agent',
        },
        wallet_id: {
          type: 'string',
          description: 'UUID of the wallet',
        },
        currency: {
          type: 'string',
          description: 'Currency (default: USDC)',
        },
      },
      required: ['service_url', 'deposit_amount', 'agent_id', 'wallet_id'],
    },
  },
  {
    name: 'mpp_get_session',
    description: 'Get MPP session details including voucher history, spending, and remaining budget.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'UUID of the session',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'mpp_list_sessions',
    description: 'List MPP sessions with optional filtering by agent or status.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'Filter by agent ID (optional)',
        },
        status: {
          type: 'string',
          enum: ['active', 'closed', 'expired', 'exhausted'],
          description: 'Filter by session status (optional)',
        },
        limit: {
          type: 'number',
          description: 'Results per page (default: 50)',
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default: 0)',
        },
      },
      required: [],
    },
  },
  {
    name: 'mpp_close_session',
    description: 'Close an active MPP session. Remaining funds are returned to the wallet.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'UUID of the session to close',
        },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'mpp_list_transfers',
    description: 'List MPP payment transfers with optional filtering by service URL or session.',
    inputSchema: {
      type: 'object',
      properties: {
        service_url: {
          type: 'string',
          description: 'Filter by service URL (optional)',
        },
        session_id: {
          type: 'string',
          description: 'Filter by session ID (optional)',
        },
        limit: {
          type: 'number',
          description: 'Results per page (default: 50)',
        },
        offset: {
          type: 'number',
          description: 'Offset for pagination (default: 0)',
        },
      },
      required: [],
    },
  },
  {
    name: 'mpp_verify_receipt',
    description: 'Verify an MPP payment receipt. Checks that the receipt is valid and matches a completed transfer.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt_id: {
          type: 'string',
          description: 'The receipt ID to verify',
        },
      },
      required: ['receipt_id'],
    },
  },
];
