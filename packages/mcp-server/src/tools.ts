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
  // B2C Checkout — single high-level tool (Epic 88)
  // ==========================================================================
  {
    name: 'sly_buy',
    description:
      'Single B2C checkout entry point — ALWAYS prefer this for buying on behalf of a Sly user. ' +
      'Wraps merchant resolution, cart pricing, policy enforcement, magic-link approval, ' +
      'and charging the user\'s vaulted payment method (Stripe). ' +
      'Use this INSTEAD OF acp_create_checkout / acp_complete_checkout / ucp_create_checkout / ucp_complete_checkout. ' +
      'Returns one of: ' +
      '(1) { status: "approval_required", approval_id, approve_url, total, items, card_on_file } — the user MUST tap approve_url to authorize. ' +
      'IMPORTANT: When you get this response, surface the approve_url to the user AND IMMEDIATELY call sly_buy_status({ approval_id, wait: 60 }) ' +
      'so you wait server-side for the tap. Do NOT re-call sly_buy on the same cart — that creates a duplicate checkout. ' +
      '(2) { status: "completed", charge: { brand, last4, id }, transfer_id, total } — charge cleared, no approval was needed (under per-tx threshold). ' +
      'You do NOT need to know the buyer\'s email, payment-instrument id, or merchant id beyond a name — Sly resolves all of that server-side.',
    inputSchema: {
      type: 'object',
      properties: {
        merchant: {
          type: 'string',
          description:
            'Merchant identifier. Accepts a human name ("El Trapiche"), an invu_merchant_id ("invu_eltrapiche"), or an account UUID. Case-insensitive substring match on names.',
        },
        items: {
          type: 'array',
          minItems: 1,
          description:
            'Cart lines. Each item\'s `name` is matched (case-insensitive) against the merchant\'s catalog — you don\'t need exact item ids. Quantities default to 1.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Product name or substring (matched against catalog).' },
              quantity: { type: 'integer', minimum: 1, default: 1 },
            },
            required: ['name'],
          },
        },
      },
      required: ['merchant', 'items'],
    },
  },

  {
    name: 'sly_buy_status',
    description:
      'Long-poll a Sly checkout approval until the user has tapped the approve link, the charge clears, or the approval is denied/expired. ' +
      'Call this IMMEDIATELY after sly_buy returns status: "approval_required" — pass the approval_id from that response and wait: 60. ' +
      'The server holds the connection open up to `wait` seconds, returning as soon as the state is terminal: ' +
      '{ status: "completed", charge, transfer_id, receipt_message } when the user approved and the card was charged, ' +
      '{ status: "denied" } if the user denied, ' +
      '{ status: "expired" } if the approval timed out, ' +
      'or { status: "approval_required" } / { status: "approved_pending_charge" } if the wait elapsed without resolution (call again to keep waiting).',
    inputSchema: {
      type: 'object',
      properties: {
        approval_id: { type: 'string', description: 'The approval_id returned by sly_buy.' },
        wait: { type: 'integer', minimum: 0, maximum: 60, default: 60, description: 'Seconds to long-poll. Max 60.' },
      },
      required: ['approval_id'],
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
    name: 'whoami',
    description: 'Identify the calling identity — who AM I, what wallet do I have, what scopes can I act on. CALL THIS FIRST when starting a task involving paid actions or wallet reads, especially after a fresh session. When connected via an agent token (agent_* or sess_*), returns the agent\'s id, name, KYA tier, parent account, environment, and the agent\'s primary on-chain wallet (address + USDC balance). When connected via a tenant API key (pk_live_* / pk_test_*), returns tenant info and `defaultAgentId: null` — meaning the caller must pass `agentId` explicitly on every paid tool. Tools like x402_fetch and agent_x402_sign auto-default `agentId` to the calling agent\'s id when present, so prefer agent-token auth. Reading this before paid calls prevents the "wrong wallet" / "no funds" confusion when a tenant has multiple agents.',
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
      required: ['tier'],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: ['amount'],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
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
      required: [],
    },
  },
  {
    name: 'agent_wallet_fund',
    description: "Request funds for an agent's wallet from its parent account's wallet. The agent specifies the amount needed and USDC is transferred from the parent account's primary wallet.",
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'UUID of the agent whose wallet to fund',
        },
        amount: {
          type: 'number',
          description: 'Amount of USDC to transfer to the agent wallet',
        },
        sourceWalletId: {
          type: 'string',
          description: 'UUID of the source wallet to fund from (optional, defaults to parent account primary wallet)',
        },
      },
      required: ['amount'],
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
      required: [],
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
  {
    name: 'agent_evm_key_provision',
    description: 'Provision a Sly-custodial secp256k1 EVM key for an agent so they can sign EIP-3009 payloads for spec-compliant x402 payments. Idempotent — returns the existing key if one already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
      },
      required: [],
    },
  },
  {
    name: 'agent_x402_wallet',
    description: 'Get the agent\'s x402 signing wallet — the EVM EOA used to pay external x402-protected endpoints. Returns the address, environment-appropriate chain (Base mainnet for live agents, Base Sepolia for test), and the LIVE on-chain USDC balance queried directly from the chain RPC. Use this to answer "what\'s my balance?" — the old agent_wallet_get tool only sees Circle custodial wallets and returns null for x402-only agents.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
      },
      required: [],
    },
  },
  {
    name: 'agent_x402_sign',
    description: 'Sign an EIP-3009 transferWithAuthorization payload using the agent\'s managed EVM key. Returns a spec-compliant signature that any x402 facilitator can verify. Use this to pay EXTERNAL x402-protected endpoints (as opposed to x402_pay which is for Sly\'s internal marketplace API).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent whose EOA will sign' },
        to: { type: 'string', description: 'Recipient EVM address (from the 402 response\'s payTo field)' },
        value: { type: 'string', description: 'Amount in token units as decimal string (e.g. "100000" for 0.1 USDC at 6 decimals)' },
        chainId: { type: 'number', description: 'Chain ID — required. 8453 = Base mainnet, 84532 = Base Sepolia. No default (pass the chainId from the 402 challenge\'s `network` field).' },
        validBefore: { type: 'number', description: 'Unix seconds deadline — signature rejected after this time' },
        validAfter: { type: 'number', description: 'Unix seconds start time (default 0)', default: 0 },
        nonce: { type: 'string', description: '32-byte hex nonce (auto-generated if omitted)' },
      },
      required: ['to', 'value', 'validBefore', 'chainId'],
    },
  },
  {
    name: 'x402_build_payment_header',
    description: 'Client-side helper. Given a 402 challenge (the JSON body OR a single entry from its `accepts[]`) and a signed EIP-3009 payload (output of agent_x402_sign), returns the base64-encoded value to set as the `X-PAYMENT` request header. Handles both x402 v1 (`network: "base"`) and v2 (`network: "eip155:8453"`) envelope shapes. No API roundtrip.',
    inputSchema: {
      type: 'object',
      properties: {
        challenge: {
          type: 'object',
          description: 'The parsed 402 response body, or a single `accepts[]` entry. Must contain at least `scheme` and `network`; `x402Version` is read from the outer body when present.',
        },
        signed: {
          type: 'object',
          description: 'The object returned by agent_x402_sign: `{ signature, from, to, value, validAfter, validBefore, nonce }`.',
        },
      },
      required: ['challenge', 'signed'],
    },
  },
  {
    name: 'x402_probe',
    description: 'Inspect an x402-protected endpoint WITHOUT paying. Sends `method url` with no X-PAYMENT, parses the 402 challenge (from body OR `payment-required` response header), and returns structured info: price, supported networks, vendor, body schema, auth requirements, and a protocol classification (standard-x402 / agentkit-gated / prepay / api-key-gated / free / broken). Also includes: `fallback.url` when the 402 body advertises a free/demo endpoint (TrustLayer-style); `reputation` with tenant-specific history for the host (totalCalls, successRate, classificationHistogram, recommendation: trusted/caution/avoid/unknown). Always check `reputation.recommendation` AND `fallback` BEFORE calling x402_fetch — skip `avoid` vendors outright, use fallbacks for low-volume reads. Zero-cost, read-only — never signs or spends.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target URL to inspect' },
        method: { type: 'string', description: 'HTTP method (default GET)', default: 'GET' },
        body: { type: 'string', description: 'Optional request body (some vendors require a body even for the unpaid probe)' },
        headers: {
          type: 'object',
          description: 'Optional additional request headers',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'x402_discover',
    description: 'Query the Agentic.Market public catalog for x402-protected services. Returns a filtered, paginated list of endpoints matching your criteria. Use this to find cheap endpoints before probing them individually. Free — no payment needed.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across service name, description, category' },
        category: { type: 'string', description: 'Filter by category (e.g. "Inference", "Data", "Search", "Media")' },
        maxPriceUsdc: { type: 'number', description: 'Filter to endpoints whose per-call price is at most this many USDC (e.g. 0.01 = penny endpoints only)' },
        method: { type: 'string', description: 'Filter by HTTP method (GET / POST / PATCH / …)' },
        limit: { type: 'number', description: 'Max services to return (default 20, max 100)', default: 20 },
      },
      required: [],
    },
  },
  {
    name: 'x402_fetch',
    description: 'One-shot paid fetch. Sends `method url` with no payment, detects a 402 response, signs an EIP-3009 authorization using the agent\'s managed EVM key, then retries with the `X-PAYMENT` header set — returning the final response. Use this instead of wiring agent_x402_sign + x402_build_payment_header + two separate HTTP calls. Safe against silent overcharging via `maxPrice`.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the paying agent' },
        url: { type: 'string', description: 'Target URL (external x402-protected endpoint)' },
        method: { type: 'string', description: 'HTTP method (default GET)', default: 'GET' },
        body: { type: 'string', description: 'Optional request body for POST/PUT (raw string, already JSON-stringified if JSON)' },
        headers: {
          type: 'object',
          description: 'Optional additional request headers (e.g. {"Content-Type":"application/json"})',
          additionalProperties: { type: 'string' },
        },
        maxPrice: {
          type: 'string',
          description: 'Hard cap on the challenge amount, in token micro-units as a decimal string (e.g. "50000" = 0.05 USDC). Reject if the 402 asks for more. Omit to disable the cap.',
        },
        agentReason: {
          type: 'string',
          description: 'Short human-readable reason for this call — "what am I trying to accomplish?" (e.g. "Look up trust score for agent 53 before referring the buyer"). Persisted on the transfer so the quality rating later has a yardstick. Max 500 chars.',
        },
        expectedFields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field names the response is expected to contain (e.g. ["trustScore", "sybilRisk"]). If the vendor returns valid JSON missing these fields, a quality rating can flag it. Derived from the x402_probe bazaar.schema when present.',
        },
        linkedProbeTransferId: {
          type: 'string',
          description: 'Optional transfer id from a prior x402_probe that surfaced this endpoint — lets the dashboard chain "probed → paid → rated."',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'agent_fund_eoa',
    description: 'Bridge USDC from an agent\'s Circle custodial wallet to their managed EVM EOA. Required before the EOA can pay external x402 endpoints on-chain.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
        amount: { type: 'string', description: 'USDC amount as decimal string (default "1")', default: '1' },
      },
      required: [],
    },
  },
  {
    name: 'agent_refill_faucet',
    description: 'Request a Circle testnet faucet drip to top up the agent\'s Circle custodial wallet. Rate-limited by Circle (~1 drip per 2 hours per address).',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
      },
      required: [],
    },
  },
  {
    name: 'x402_endpoint_reputation',
    description: 'Look up reliability history for an x402 vendor before paying. Aggregates every external x402 call this tenant has made to the given host and returns: totalCalls, successRate, classificationHistogram (which failure codes dominated), avgDurationMs, totalUsdcSpent, totalUsdcWasted (paid-but-failed), and a `recommendation` code — one of `trusted` (≥90% success, ≥3 calls), `caution` (40–90% success), `avoid` (<40%), or `unknown` (fewer than 3 calls). Use before x402_fetch to skip known-broken vendors (like StableTravel / PaySponge) and favor known-good ones (like mesh.heurist.xyz). Pass `host` as the bare hostname (e.g. "api.slamai.dev"). `window` defaults to 30d.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Hostname to look up (e.g. "mesh.heurist.xyz"). Lowercased + trimmed server-side.' },
        window: { type: 'string', description: 'Lookback window — "24h", "7d", or "30d" (default 30d).' },
        env: { type: 'string', description: 'Filter to a specific environment: "live" or "test". Defaults to the caller\'s current environment.' },
      },
      required: ['host'],
    },
  },
  {
    name: 'x402_rate_vendor',
    description: 'Leave a thumbs-up or thumbs-down rating on an x402 vendor, with an optional note. Upserts — one rating per (calling agent, host). Lets agents capture signal beyond raw success rate: "data was wrong even though HTTP 200", "great docs and fast", "broken during US business hours", etc. Visible to tenant owners on the vendor dashboard. Use after a few calls to a vendor to contribute to the tenant\'s reputation corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Hostname to rate (e.g. "api.slamai.dev")' },
        thumb: { type: 'string', enum: ['up', 'down'], description: 'up for good, down for bad' },
        note: { type: 'string', description: 'Optional free-text rationale (max 1000 chars)' },
      },
      required: ['host', 'thumb'],
    },
  },
  {
    name: 'x402_rate_call',
    description: 'Rate the quality of ONE specific x402 call (per-transfer), not the vendor overall. Use after receiving a paid response to flag whether the vendor actually delivered what was asked. Upserts — one rating per (transfer, rater) so a second call from the same rater updates the first. Feeds the `deliveredCorrectness` and `avgResultScore` columns on the vendor leaderboard: a vendor with 100% HTTP success but 30% correctness reads as WORSE than a 70% success / 95% correctness vendor. Catches vendors that return valid-looking-but-useless JSON (`{"result":"no data"}` with HTTP 200).',
    inputSchema: {
      type: 'object',
      properties: {
        transferId: { type: 'string', description: 'UUID of the x402 transfer to rate (returned from x402_fetch as transferId).' },
        deliveredWhatAsked: { type: 'boolean', description: 'Hard gate — did the response actually contain the information the agent was looking for?' },
        satisfaction: {
          type: 'string',
          enum: ['excellent', 'acceptable', 'partial', 'unacceptable'],
          description: 'Qualitative tier. `excellent` = exactly what was asked; `acceptable` = usable; `partial` = some fields missing or stale; `unacceptable` = wrong data, hallucinated, empty.',
        },
        score: {
          type: 'number',
          description: '0–100 quality score. Feeds `avgResultScore` on the vendor leaderboard. 90+ excellent, 60–89 acceptable, 30–59 partial, <30 unacceptable.',
        },
        flags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Zero or more tags pinpointing the failure mode. Common flags: `stale_data`, `partial_response`, `hallucinated`, `rate_limited`, `schema_mismatch`, `empty_payload`, `wrong_entity`.',
        },
        note: {
          type: 'string',
          description: 'Optional free-text comment — what was asked vs. what came back. Max 2000 chars.',
        },
      },
      required: ['transferId', 'deliveredWhatAsked', 'satisfaction', 'score'],
    },
  },
  {
    name: 'request_scope',
    description: 'Ask the tenant owner for elevated permission to perform a privileged action across sibling agents or treasury. Default agent-token scope (`agent`) only lets you act on your OWN agent — read your wallet, sign your own x402 calls, etc. To read other agents in the tenant (`tenant_read`), modify their policies (`tenant_write`), or move funds between agents (`treasury`), you MUST first call this and have a tenant owner approve. Until approved, you will hit 403 SCOPE_REQUIRED on the privileged route. The request is async — it writes a pending audit row and returns a request_id. The tenant owner sees it in /dashboard/security/scopes and approves or denies. Re-call the privileged tool only after `scope_status({ requestId })` returns `approved`. Pick `lifecycle: "one_shot"` for a single call, `"standing"` for a session-bound burst (capped: tenant_read=60min, tenant_write=15min, treasury=one_shot only).',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['tenant_read', 'tenant_write', 'treasury'],
          description: 'Privilege tier. `tenant_read` = read sibling agents/balances/transfers. `tenant_write` = mutate sibling agent state (policies, skills, status). `treasury` = move funds between agents (always one_shot).',
        },
        lifecycle: {
          type: 'string',
          enum: ['one_shot', 'standing'],
          description: '`one_shot` = consumed on first use, anchored to your current session. `standing` = persists until expiry (or revoke), capped per scope.',
        },
        purpose: {
          type: 'string',
          description: 'Plain-English explanation shown to the tenant owner at decision time. Min 8 / max 500 chars. Always concrete — "Read agent Tina-2\'s wallet balance to plan a fund split", not "Read sibling agent".',
        },
        durationMinutes: {
          type: 'number',
          description: 'Standing-grant duration; ignored for one_shot. Hard ceilings: tenant_read=60, tenant_write=15.',
        },
        intent: {
          type: 'object',
          description: 'Optional structured context — { mcp_tool, route, target_agent_id, target_account_id, args } — written to the audit trail.',
        },
      },
      required: ['scope', 'lifecycle', 'purpose'],
    },
  },
  {
    name: 'scope_status',
    description: 'Check the current elevated-scope context for the calling agent, or the status of a previously-submitted scope request. With no `requestId`, returns `current_scope` (`agent` baseline or `tenant_read`/`tenant_write`/`treasury`) plus all active grants currently applicable. With `requestId`, returns the lifecycle of that specific request: `pending` (awaiting tenant owner), `approved` (with the issued grant), or `denied` (with reason).',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: {
          type: 'string',
          description: 'Optional UUID of a request returned from request_scope. Omit to inspect the current effective scope of the calling session.',
        },
      },
    },
  },
  {
    name: 'x402_list_vendors',
    description: 'List every x402 vendor this tenant has tried, sorted by volume, with per-vendor reliability scores. Returns the same shape as x402_endpoint_reputation but for every host. Useful for "which vendors have I wasted money on?" audits or picking alternatives in a category. Default window 30d.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Lookback window — "24h", "7d", or "30d" (default 30d).' },
        env: { type: 'string', description: 'Filter to a specific environment: "live" or "test". Defaults to the caller\'s current environment.' },
      },
    },
  },
  {
    name: 'wallet_topup_link',
    description: 'Generate a one-time Coinbase Pay URL that lets the tenant top up any Sly wallet by clicking a link — ideal for chat. Works for agent_eoa, circle_custodial, and external wallets with an on-chain address. USDC is delivered straight to the wallet on Base; Sly never touches the funds. The URL is self-contained (embeds a short-lived session token pinned to the destination address) and expires in ~5 minutes. Accept optional `presetAmountUsdc` to pre-fill a dollar amount. Return includes { url, walletAddress, network, expiresAt, instructions } — agents should share the url and tell the tenant it expires soon.',
    inputSchema: {
      type: 'object',
      properties: {
        walletId: { type: 'string', description: 'UUID of the destination wallet' },
        presetAmountUsdc: { type: 'number', description: 'Pre-fill the Coinbase checkout with this USD amount (optional)' },
      },
      required: ['walletId'],
    },
  },
  {
    name: 'agent_enable_auto_refill',
    description: 'Enable automatic USDC top-ups for an agent EOA. A background worker watches the on-chain balance and tops it up from the tenant Circle master whenever it falls below `threshold`, refilling up to `target`. All refills are bounded by a per-day cap and KYA limits. Returns the saved policy.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
        threshold: { type: 'number', description: 'USDC balance below which the worker will refill (e.g. 0.20)' },
        target: { type: 'number', description: 'USDC balance the worker will refill UP TO (must be > threshold). E.g. 1.00' },
        dailyCap: { type: 'number', description: 'Max USDC auto-refilled per UTC day. Default: 5.00' },
      },
      required: ['threshold', 'target'],
    },
  },
  {
    name: 'agent_disable_auto_refill',
    description: 'Turn off automatic USDC top-ups for an agent EOA. The existing policy (threshold/target/daily cap) is preserved so re-enabling is a single call. Running refills are not aborted, but no new ones will be attempted.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
      },
      required: [],
    },
  },
  {
    name: 'agent_auto_refill_status',
    description: 'Read the current auto-refill policy and last-run state for an agent. Returns enabled flag, threshold, target, dailyCap, dailySpent (resets at UTC midnight), lastRunAt, lastStatus (ok | master_underfunded | circle_error | capped | config_invalid | no_evm_key | rpc_error | skipped_dust), and lastError.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'UUID of the agent' },
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

  // ==========================================================================
  // Support Tools (Intercom Fin)
  // ==========================================================================
  {
    name: 'explain_rejection',
    description: 'Explain why a transaction was rejected. Returns a human-readable explanation with actionable resolution options. Provide at least one of error_code, transaction_id, or agent_id.',
    inputSchema: {
      type: 'object',
      properties: {
        error_code: {
          type: 'string',
          description: 'The error code from the rejection (e.g., DAILY_LIMIT_EXCEEDED, INSUFFICIENT_BALANCE)',
        },
        transaction_id: {
          type: 'string',
          description: 'UUID of the rejected transaction',
        },
        agent_id: {
          type: 'string',
          description: 'UUID of the agent whose limits to check',
        },
      },
      required: [],
    },
  },
  {
    name: 'request_limit_increase',
    description: 'Submit a request to increase an agent\'s spending limit. Creates a pending request that must be approved by a human operator.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'UUID of the agent requesting the increase',
        },
        limit_type: {
          type: 'string',
          enum: ['per_transaction', 'daily', 'monthly'],
          description: 'Which limit to increase',
        },
        requested_amount: {
          type: 'number',
          description: 'The new desired limit amount (in USD)',
        },
        reason: {
          type: 'string',
          description: 'Business justification for the increase',
        },
        duration: {
          type: 'string',
          enum: ['temporary_24h', 'temporary_7d', 'permanent'],
          description: 'How long the increase should last (default: permanent)',
        },
      },
      required: ['agent_id', 'limit_type', 'requested_amount', 'reason'],
    },
  },
  {
    name: 'open_dispute',
    description: 'Open a dispute for a completed transaction. Use when an agent or customer believes a transaction was incorrect, unauthorized, or the service was not received.',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: {
          type: 'string',
          description: 'UUID of the transaction to dispute',
        },
        reason: {
          type: 'string',
          enum: ['service_not_received', 'duplicate_charge', 'unauthorized', 'amount_incorrect', 'quality_issue', 'other'],
          description: 'Reason for the dispute',
        },
        description: {
          type: 'string',
          description: 'Detailed description of the issue',
        },
        requested_resolution: {
          type: 'string',
          enum: ['full_refund', 'partial_refund', 'credit', 'other'],
          description: 'What resolution is being requested (optional)',
        },
      },
      required: ['transaction_id', 'reason', 'description'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Escalate an issue to a human support operator. Use when the issue is too complex for automated resolution, the agent explicitly requests human help, or there is a security concern.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'UUID of the agent (optional)',
        },
        reason: {
          type: 'string',
          enum: ['complex_issue', 'agent_requested', 'security_concern', 'policy_exception', 'bug_report'],
          description: 'Why this is being escalated',
        },
        summary: {
          type: 'string',
          description: 'Summary of the issue for the human operator',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Priority level (default: medium). Critical = 1h response, High = 4h, Medium = 24h, Low = 48h',
        },
      },
      required: ['reason', 'summary'],
    },
  },
];
