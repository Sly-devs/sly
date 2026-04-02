# PayOS Documentation

This directory contains all documentation for the PayOS platform - the agentic economy platform with AI-native agent support and money streaming capabilities.

## Directory Structure

```
docs/
├── README.md                      # This file - documentation guide
│
├── guides/                        # Developer guides and workflows
│   ├── README.md                  # Guides overview
│   ├── onboarding/               # Getting started guides
│   ├── development/              # Development workflows
│   ├── testing/                  # Testing procedures
│   └── deployment/               # Deployment guides
│
├── protocols/                     # Payment protocol documentation
│   ├── README.md                  # Protocol overview
│   ├── x402/                     # HTTP 402 Payment Protocol
│   ├── ap2/                      # Agentic Payment Protocol v2
│   └── acp/                      # Agent Commerce Protocol
│
├── architecture/                  # System architecture
│   ├── README.md                  # Architecture overview
│   ├── INFRASTRUCTURE.md          # Production infrastructure
│   ├── wallet-schema.md           # Wallet database design
│   ├── data-model-strategy.md     # Data models
│   └── ml-treasury.md             # ML treasury management
│
├── security/                      # Security documentation
│   ├── README.md                  # Security overview
│   ├── RLS_STRATEGY.md            # Multi-tenant isolation
│   ├── RLS_TESTING.md             # RLS testing procedures
│   └── security-review.md         # Security audit
│
├── deployment/                    # Production deployment
│   ├── README.md                  # Deployment guide
│   ├── DEPLOYMENT_QUICK_START.md  # Quick deployment
│   └── ...                       # Detailed deployment docs
│
├── prd/                          # Product Requirements Documents
│   └── PayOS_PRD_Development.md  # Main PRD (all epics)
│
├── completed/                    # Archived completion documents
│   ├── README.md                 # Archive overview
│   ├── epics/                   # Completed epic summaries
│   ├── stories/                 # Completed story reports
│   ├── sessions/                # Development session logs
│   └── bugfixes/                # Bug fix summaries
│
├── reports/                      # Test reports and analysis
└── testing/                      # Testing documentation
```

## Quick Navigation

### I need to...

| Task | Documentation |
|------|---------------|
| Get started as a new developer | [guides/onboarding/GEMINI_START_HERE.md](guides/onboarding/GEMINI_START_HERE.md) |
| Understand the system architecture | [architecture/README.md](architecture/README.md) |
| Learn about payment protocols | [protocols/README.md](protocols/README.md) |
| Implement x402 protocol | [protocols/x402/README.md](protocols/x402/README.md) |
| Work with AP2 or ACP | [protocols/ap2/README.md](protocols/ap2/README.md), [protocols/acp/README.md](protocols/acp/README.md) |
| Understand security & RLS | [security/README.md](security/README.md) |
| Deploy to production | [deployment/README.md](deployment/README.md) |
| Migrate from mock to real data | [guides/development/MOCK_TO_API_MIGRATION.md](guides/development/MOCK_TO_API_MIGRATION.md) |
| Test the SDK | [guides/development/SDK_TESTING_GUIDE.md](guides/development/SDK_TESTING_GUIDE.md) |
| Test the UI | [guides/testing/UI_VALIDATION_GUIDE.md](guides/testing/UI_VALIDATION_GUIDE.md) |
| Run regression tests | [guides/onboarding/GEMINI_REGRESSION_CHECKLIST.md](guides/onboarding/GEMINI_REGRESSION_CHECKLIST.md) |
| Review product requirements | [prd/PayOS_PRD_Development.md](prd/PayOS_PRD_Development.md) |

## Key Documentation by Category

### For New Developers

**Start here:**
1. [guides/onboarding/GEMINI_START_HERE.md](guides/onboarding/GEMINI_START_HERE.md) - Quick start guide
2. [architecture/README.md](architecture/README.md) - System architecture overview
3. [guides/development/MOCK_TO_API_MIGRATION.md](guides/development/MOCK_TO_API_MIGRATION.md) - Development workflow

**Then explore:**
- [protocols/README.md](protocols/README.md) - Payment protocols (x402, AP2, ACP)
- [security/README.md](security/README.md) - Security practices
- [guides/testing/VALIDATION_GUIDE.md](guides/testing/VALIDATION_GUIDE.md) - Testing guide

### For Protocol Integration

**x402 Protocol (HTTP Micropayments):**
- [protocols/x402/README.md](protocols/x402/README.md) - Protocol overview
- [protocols/x402/X402_SDK_GUIDE.md](protocols/x402/X402_SDK_GUIDE.md) - SDK integration
- [protocols/x402/X402_MANUAL_TESTING_GUIDE.md](protocols/x402/X402_MANUAL_TESTING_GUIDE.md) - Testing

**AP2 Protocol (Advanced Agent Payments):**
- [protocols/ap2/README.md](protocols/ap2/README.md) - Protocol overview
- [protocols/ap2/AP2_FOUNDATION_COMPLETE.md](protocols/ap2/AP2_FOUNDATION_COMPLETE.md) - Implementation

**ACP Protocol (Agent Commerce):**
- [protocols/acp/README.md](protocols/acp/README.md) - Protocol overview
- [protocols/acp/ACP_FOUNDATION_IMPLEMENTATION_COMPLETE.md](protocols/acp/ACP_FOUNDATION_IMPLEMENTATION_COMPLETE.md) - Implementation

### For Architecture & Design

- [architecture/README.md](architecture/README.md) - System architecture overview
- [architecture/INFRASTRUCTURE.md](architecture/INFRASTRUCTURE.md) - Production infrastructure
- [architecture/wallet-schema.md](architecture/wallet-schema.md) - Wallet database design
- [architecture/data-model-strategy.md](architecture/data-model-strategy.md) - Data models

### For Security & Compliance

- [security/README.md](security/README.md) - Security overview
- [security/RLS_STRATEGY.md](security/RLS_STRATEGY.md) - Multi-tenant isolation strategy
- [security/RLS_TESTING.md](security/RLS_TESTING.md) - RLS testing procedures
- [security/security-review.md](security/security-review.md) - Security audit

### For Testing

- [guides/testing/VALIDATION_GUIDE.md](guides/testing/VALIDATION_GUIDE.md) - Complete validation guide
- [guides/testing/UI_VALIDATION_GUIDE.md](guides/testing/UI_VALIDATION_GUIDE.md) - UI testing
- [guides/testing/PAGINATION_TESTING_GUIDE.md](guides/testing/PAGINATION_TESTING_GUIDE.md) - Pagination testing
- [guides/onboarding/GEMINI_TESTING_INSTRUCTIONS.md](guides/onboarding/GEMINI_TESTING_INSTRUCTIONS.md) - AI-assisted testing

### For Deployment

- [deployment/README.md](deployment/README.md) - Deployment guide
- [deployment/DEPLOYMENT_QUICK_START.md](deployment/DEPLOYMENT_QUICK_START.md) - Quick deployment
- [deployment/DEPLOYMENT_PREPARATION.md](deployment/DEPLOYMENT_PREPARATION.md) - Comprehensive guide
- [deployment/ENVIRONMENT_VARIABLES.md](deployment/ENVIRONMENT_VARIABLES.md) - Configuration reference

### For Product Requirements

- [prd/PayOS_PRD_Development.md](prd/PayOS_PRD_Development.md) - Main PRD
  - Epics 1-16: Core platform features
  - Epic 17: x402 Gateway Infrastructure
  - Epic 18: AP2 Foundation
  - Epic 19: ACP Foundation
  - Epic 20: Streaming Payments
  - Epic 21: Code Coverage
  - Epic 22+: UI & Quality

## Documentation Standards

### Creating New Documentation

**Location guidelines:**
- Protocol docs → `protocols/{protocol-name}/`
- Development guides → `guides/development/`
- Testing guides → `guides/testing/`
- Architecture docs → `architecture/`
- Security docs → `security/`
- Deployment docs → `deployment/`
- PRD updates → `prd/`
- Completed work → `completed/`

**Naming conventions:**
- Protocol docs: `PROTOCOL_FEATURE.md`
- Guides: `FEATURE_GUIDE.md`
- Status reports: `FEATURE_STATUS.md`
- Test reports: `FEATURE_TEST_REPORT.md`

**Document structure:**
- Clear title and purpose
- Table of contents for long docs (>100 lines)
- Consistent heading hierarchy (# → ## → ### → ####)
- Code examples where applicable
- Cross-references to related docs
- "Last updated" date

### README Requirements

Every major directory should have a README.md with:
- Directory purpose and overview
- Index of documents with descriptions
- Quick start guide or navigation
- Links to related documentation
- Last updated date

## Current Status (December 29, 2025)

### Completed Epics

- ✅ Epic 1-16: Core platform (foundation → security)
- ✅ Epic 17: x402 Gateway Infrastructure (production-ready)
- ✅ Epic 22: Seed Data & Final UI Integration

### In Progress

- 🔄 Epic 18-20: Multi-protocol foundation (AP2, ACP complete, x402 optimizations)
- 🔄 Epic 23: Dashboard Performance & API Optimization

### Protocol Status

| Protocol | Status | Documentation |
|----------|--------|---------------|
| x402 | Production | [protocols/x402/](protocols/x402/) |
| AP2 | Foundation Complete | [protocols/ap2/](protocols/ap2/) |
| ACP | Foundation Complete | [protocols/acp/](protocols/acp/) |

## Project Overview

**Sly** is the agentic economy platform with:

- **Multi-Tenant Architecture**: Row-Level Security (RLS) for data isolation
- **Triple Authentication**: API keys, JWT sessions, agent tokens
- **Payment Protocols**: x402, AP2, ACP for various use cases
- **AI-Native Design**: First-class support for AI agents
- **Money Streaming**: Real-time per-second payment flows
- **KYA Framework**: Know Your Agent verification tiers

**Tech Stack:**
- Backend: Hono + Node.js + PostgreSQL (Supabase)
- Frontend: Next.js + Vite + React + TypeScript
- Deployment: Railway (API) + Vercel (UI) + Supabase (DB)

See [architecture/README.md](architecture/README.md) for complete architecture details.

## Contributing to Documentation

When updating documentation:

1. Find the appropriate directory using the structure above
2. Create or update the relevant document
3. Update the directory's README.md if needed
4. Add cross-references to related documentation
5. Update this main README if adding new categories
6. Include "Last updated" date in your document

## Documentation Maintenance

**Regular updates:**
- Update status sections when epics complete
- Archive completed documents to `completed/`
- Update protocol documentation with new features
- Keep README files current with directory contents
- Update cross-references when files move

**Quality checks:**
- All links work (no broken references)
- Code examples are tested and working
- Screenshots and diagrams are current
- Consistent formatting and style
- Clear and concise writing

---

**Last Updated:** December 29, 2025
**Maintained By:** PayOS Team

**For questions or contributions, see the appropriate subdirectory README:**
- [guides/README.md](guides/README.md) - Developer guides
- [protocols/README.md](protocols/README.md) - Protocol documentation
- [architecture/README.md](architecture/README.md) - Architecture docs
- [security/README.md](security/README.md) - Security documentation
- [deployment/README.md](deployment/README.md) - Deployment guides
