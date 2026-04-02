# PayOS Demo Guide

## Overview

This is a comprehensive B2B fintech demo showcasing Sly — the agentic economy platform. The demo includes three distinct user interfaces with full light/dark mode support.

## Demo Navigation

Use the **floating menu** in the top-right corner to switch between different views:

### 🏢 Partner Admin Dashboard (Desktop)

The fintech partner's main interface for managing their payout platform.

**1. Dashboard**
- KPI cards showing volume, employers, contractors, and revenue
- Real-time compliance alerts with AI recommendations
- Interactive charts (volume over time, payouts by corridor)
- Recent activity feed with status badges

**2. AI Compliance Flag Detail ⭐ (The "Wow" Feature)**
- Detailed transaction analysis with AI-powered insights
- Risk assessment with visual scoring
- AI-suggested actions with step-by-step recommendations
- Transaction timeline and document management
- This showcases the AI differentiator with a polished, professional UI

**3. AI Support Agent**
- Natural language chat interface for querying platform data
- Suggested query chips for common questions
- Structured response cards with transaction details
- Chat history sidebar
- Sample conversation showing transaction lookup

### 🏢 Employer Admin Dashboard (Desktop)

The interface for companies paying contractors.

**1. Dashboard**
- Large wallet balance card with USD/USDC breakdown
- Contractor overview with status tracking
- Recent transactions with visual categorization
- Upcoming scheduled payouts

**2. Payout Flow**
- 4-step wizard: Select → Enter Amounts → Add Memo → Review
- Visual progress indicator
- Real-time total calculation
- Fee breakdown and confirmation

### 📱 Contractor Mobile App

The mobile experience for individual contractors receiving payments.

**1. Home**
- Balance display with USD/USDC breakdown
- Pending payouts indicator
- Quick action buttons (Send, Withdraw, Card, More)
- Recent transactions with special "Agent Payment" badges
- Bottom navigation bar

**2. Card**
- Beautiful virtual card design with gradient background
- Show/hide card number and CVV
- Copy card details with confirmation
- Freeze/unfreeze card toggle
- Add to Apple Pay / Google Pay buttons
- Spending limits display
- Recent card transactions

**3. Transaction Detail** (Bottom Sheet)
- Detailed transaction information
- Special UI for AI Agent Payments with robot icon
- Fee breakdown
- Reference ID with copy button
- Download receipt option

## Key Features Highlighted

### 🤖 AI Integration
- **Compliance Copilot**: Analyzes flagged transactions and provides risk assessments
- **Support Agent**: Natural language interface for platform queries
- **Agent Payments**: Special transaction type processed by AI agents (shown in mobile app)

### 🎨 Design System
- **Colors**: Professional blue primary, success green, warning amber, error red
- **Typography**: Clean hierarchy using Inter font family
- **Components**: Reusable buttons, cards, badges, inputs
- **Dark Mode**: Full support across all screens with proper contrast

### 💡 Fintech Best Practices
- Clear hierarchy and information architecture
- Status badges for quick scanning
- Visual indicators (trends, risk levels)
- Transparent fee breakdowns
- Copy-to-clipboard functionality
- Responsive layouts

## Technical Implementation

### Design System (`/styles/globals.css`)
- Custom color palette with semantic tokens
- Dark mode variables
- Typography scale
- Spacing and shadow systems

### Reusable Components (`/components/ui/`)
- Button (4 variants, 3 sizes)
- Card (flexible padding)
- Badge (5 variants)
- Input (with label and error states)
- StatCard (with trend indicators)

### Layout Components
- Sidebar with nested navigation
- TopBar with search and dark mode toggle
- Mobile bottom navigation

### Feature Screens
- 3 Partner screens showcasing AI features
- 2 Employer screens showing payout workflow
- 3 Contractor screens for mobile experience

## What Makes This Special

1. **AI-First**: The compliance and support features showcase how AI enhances fintech operations
2. **Multi-Sided Platform**: Three distinct user types with tailored experiences
3. **Agent Payments**: Unique feature showing AI agents making payments on behalf of employers
4. **Professional Polish**: Stripe/Mercury-inspired design with attention to detail
5. **Dark Mode**: Complete theme support throughout

## Next Steps & Extensibility

The design system is built to easily add:
- Additional screens from the original spec (KYB onboarding, treasury intelligence, etc.)
- More chart types and data visualizations
- Additional transaction types
- Real-time notifications
- More AI features

All components follow a consistent pattern and can be easily extended or customized.
