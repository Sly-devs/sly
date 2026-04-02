# PayOS Architecture Documentation

This directory contains system architecture, design patterns, and technical infrastructure documentation for PayOS.

## Overview

Sly is a multi-tenant agentic economy platform built with a modern, AI-native architecture. The system supports multiple payment protocols, agent-driven commerce, and real-time money streaming.

## Documentation Index

### System Architecture

| Document | Description | Purpose |
|----------|-------------|---------|
| [three-layer-architecture.md](three-layer-architecture.md) | **Three-layer design** | Protocols → Transfers → Settlement |
| [INFRASTRUCTURE.md](INFRASTRUCTURE.md) | Production infrastructure | Deployment platforms, monitoring, scaling |
| [wallet-schema.md](wallet-schema.md) | Wallet schema design | Database schema for wallets and transactions |
| [data-model-strategy.md](data-model-strategy.md) | Data model strategy | Core data models and relationships |
| [ml-treasury.md](ml-treasury.md) | ML treasury management | Machine learning for treasury operations |

## Core Architecture

### System Components

```
┌─────────────────────────────────────────────────────┐
│                   Client Layer                       │
├──────────────────┬──────────────────┬───────────────┤
│   Web Dashboard  │    Main UI       │  Sample Apps  │
│   (Next.js)      │   (Vite+React)   │  (SDK demos)  │
└────────┬─────────┴────────┬─────────┴───────┬───────┘
         │                  │                 │
         └──────────────────┼─────────────────┘
                            │
                ┌───────────▼───────────┐
                │     API Gateway       │
                │      (Hono)          │
                │   Rate Limiting      │
                │   Authentication     │
                └───────────┬───────────┘
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
    ┌────▼────┐      ┌──────▼──────┐    ┌─────▼─────┐
    │ x402    │      │    AP2      │    │    ACP    │
    │Protocol │      │  Protocol   │    │ Protocol  │
    └────┬────┘      └──────┬──────┘    └─────┬─────┘
         │                  │                  │
         └──────────────────┼──────────────────┘
                            │
                ┌───────────▼───────────┐
                │   Service Layer       │
                │  - Wallets            │
                │  - Transfers          │
                │  - Settlements        │
                │  - Analytics          │
                └───────────┬───────────┘
                            │
                ┌───────────▼───────────┐
                │   Data Layer          │
                │   Supabase            │
                │   - PostgreSQL        │
                │   - Row-Level Security│
                │   - Real-time subs    │
                └───────────────────────┘
```

### Technology Stack

**Backend:**
- Runtime: Node.js 20+
- Framework: Hono (lightweight, fast)
- Database: PostgreSQL (via Supabase)
- ORM: Supabase client library
- Authentication: Supabase Auth + custom middleware
- Rate limiting: In-memory (production: Redis)

**Frontend:**
- Main UI: Vite + React + TypeScript
- Dashboard: Next.js 15 + React + TypeScript
- State: React Query for data fetching
- Styling: Tailwind CSS
- Components: Custom component library

**Infrastructure:**
- API Hosting: Railway
- Frontend Hosting: Vercel
- Database: Supabase (hosted PostgreSQL)
- Monitoring: Railway/Vercel built-in
- CDN: Vercel Edge Network

## Key Architectural Patterns

### Multi-Tenancy

**Row-Level Security (RLS):**
- All data scoped to `tenant_id`
- PostgreSQL RLS policies enforce isolation
- Application code filters by tenant context
- Prevents cross-tenant data leaks

See [../security/RLS_STRATEGY.md](../security/RLS_STRATEGY.md) for details.

### Triple Authentication

PayOS supports three authentication methods:

1. **API Keys** (`pk_test_*` / `pk_live_*`)
   - For partner integrations
   - Stored as hash with prefix
   - Environment-aware (test/live)

2. **JWT Sessions** (Supabase Auth tokens)
   - For dashboard users
   - 15-minute expiry, auto-refresh
   - Role-based permissions

3. **Agent Tokens** (`agent_*`)
   - For AI agents
   - Stored as hash with prefix
   - KYA tier validation

All auth flows converge to a unified `RequestContext` for consistent authorization.

### Wallet Architecture

See [wallet-schema.md](wallet-schema.md) for detailed schema.

**Key features:**
- Double-entry accounting
- Atomic transaction processing
- Balance caching with reconciliation
- Transaction history and audit trail
- Multi-currency support
- Real-time balance updates

### Data Model Strategy

See [data-model-strategy.md](data-model-strategy.md) for comprehensive data model documentation.

**Core entities:**
- Tenants (organizations)
- Accounts (persons/businesses)
- Agents (AI actors)
- Wallets (fund storage)
- Transfers (fund movement)
- Streams (continuous payments)

### ML Treasury Management

See [ml-treasury.md](ml-treasury.md) for machine learning integration.

**Features:**
- Predictive cash flow forecasting
- Anomaly detection
- Risk scoring
- Automated treasury operations
- Agent behavior analysis

## Infrastructure

See [INFRASTRUCTURE.md](INFRASTRUCTURE.md) for production infrastructure details.

### Deployment Architecture

```
┌──────────────┐
│   GitHub     │
│   Actions    │
└──────┬───────┘
       │ (CI/CD)
       │
   ┌───▼────────────────┐
   │                    │
┌──▼──────┐      ┌──────▼──────┐
│ Railway │      │   Vercel    │
│  (API)  │◄────►│ (Frontend)  │
└──┬──────┘      └──────┬──────┘
   │                    │
   │                    │
   └────────┬───────────┘
            │
       ┌────▼─────┐
       │ Supabase │
       │(Database)│
       └──────────┘
```

### Scaling Strategy

**Horizontal Scaling:**
- Stateless API servers (can run multiple instances)
- Database connection pooling
- Redis for session storage (planned)
- CDN for static assets

**Vertical Scaling:**
- Database read replicas
- Caching layer (Redis)
- Background job workers
- Async processing queues

### Performance Optimization

**API Layer:**
- Request/response compression
- Response caching (planned)
- Database query optimization
- N+1 query prevention
- Pagination for large datasets

**Database Layer:**
- Indexes on frequently queried columns
- Materialized views for analytics
- Partitioning for large tables (planned)
- Connection pooling
- Query plan optimization

**Frontend Layer:**
- Code splitting
- Lazy loading
- React Query caching
- Debounced searches
- Virtual scrolling for lists

## Security Architecture

### Authentication Flow

```
1. Client → API: Request with credentials
2. API → Middleware: Extract and validate credentials
3. Middleware → DB: Verify credentials (hash comparison)
4. Middleware → Context: Set tenant/user/agent context
5. API → Handler: Process request with context
6. Handler → DB: Query with tenant filter
7. DB → RLS: Verify tenant access
8. DB → Handler: Return filtered results
9. Handler → Client: Send response
```

### Authorization Layers

**Layer 1: Authentication**
- Verify credentials (API key / JWT / agent token)
- Extract tenant ID

**Layer 2: RLS Policies**
- PostgreSQL RLS enforces tenant isolation
- Prevents accidental cross-tenant access

**Layer 3: Application Logic**
- Role-based permissions (owner/admin/member/viewer)
- Feature flags
- KYC/KYB/KYA tier checks
- Spending limits

### Data Security

- **Encryption at rest**: Supabase default encryption
- **Encryption in transit**: HTTPS/TLS only
- **Secrets management**: Environment variables
- **Token hashing**: Argon2 for API keys/agent tokens
- **Audit logging**: All mutations logged
- **CORS**: Restricted to known domains
- **Rate limiting**: Per-IP and per-key limits

See [../security/](../security/) for detailed security documentation.

## API Design

### RESTful Conventions

```
GET    /v1/resource          # List resources
GET    /v1/resource/:id      # Get single resource
POST   /v1/resource          # Create resource
PUT    /v1/resource/:id      # Replace resource (full update)
PATCH  /v1/resource/:id      # Update resource (partial)
DELETE /v1/resource/:id      # Delete resource
```

### Response Format

**Success:**
```json
{
  "id": "123",
  "name": "Example",
  "status": "active"
}
```

**List:**
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

**Error:**
```json
{
  "error": "Resource not found",
  "details": { "resourceId": "123" }
}
```

### Error Codes

- `400` - Validation error
- `401` - Authentication required
- `403` - Forbidden (insufficient permissions)
- `404` - Resource not found
- `429` - Rate limit exceeded
- `500` - Internal server error

## Database Design

### Schema Principles

1. **Normalized data**: Avoid duplication
2. **RLS on all tables**: Multi-tenant isolation
3. **Foreign key constraints**: Data integrity
4. **Indexes**: Query performance
5. **Audit columns**: `created_at`, `updated_at`
6. **Soft deletes**: Preserve history (where needed)

### Migration Strategy

- All migrations in `apps/api/supabase/migrations/`
- Naming: `YYYYMMDD_description.sql`
- Include RLS policies in migration
- Test locally before applying to production
- Keep migrations idempotent when possible

## Testing Architecture

### Test Layers

**Unit Tests:**
- Test individual functions
- Mock external dependencies
- Fast execution (<1s per suite)

**Integration Tests:**
- Test full request/response cycle
- Use real database (test environment)
- Verify RLS policies
- Slower execution (~5-10s per suite)

**End-to-End Tests:**
- Test UI flows
- Use sample apps
- Manual and automated scenarios

See [../guides/testing/](../guides/testing/) for testing documentation.

## Related Documentation

- [Protocol Documentation](../protocols/) - x402, AP2, ACP protocols
- [Security Documentation](../security/) - RLS, authentication, security
- [Deployment Documentation](../deployment/) - Production deployment
- [Developer Guides](../guides/) - Development workflows
- [PRD](../prd/PayOS_PRD_Development.md) - Product requirements

## Contributing

When updating architecture documentation:

1. Update relevant architecture documents
2. Update diagrams if architecture changes
3. Cross-reference related documentation
4. Include migration guides for breaking changes
5. Update this README if adding new documents

---

**Last Updated:** January 20, 2026
**Maintained By:** PayOS Team

For the main documentation index, see [/docs/README.md](../README.md)
