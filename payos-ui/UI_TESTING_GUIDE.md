# PayOS UI Testing Guide

**Version:** 2.1  
**Date:** December 16, 2025  
**Purpose:** Comprehensive UI testing instructions for automated testing (Gemini)

---

## 🎯 PRIORITY TESTING - Mock-to-API Migration Complete!

**IMPORTANT:** The following pages have been migrated from mock data to real API data. Test these FIRST:

✅ **Story 12.3 - Accounts (COMPLETE)**
✅ **Story 12.4 - Transactions/Transfers (COMPLETE)**
✅ **Story 12.5 - Cards/Payment Methods (COMPLETE)**

### Test Data Available (Acme Corporation Tenant):
- **7 Accounts**: Maria Garcia, Carlos Martinez, Ana Silva, Juan Perez, Sofia Rodriguez, TechCorp Inc, StartupXYZ
- **5 Transfers**: Various statuses (completed, pending, failed)
- **4 Payment Methods**: Cards ending in 4521, 2847, 8834, 9182
- **3 Agents**: Maria's assistant, TechCorp ops bot, Sofia's manager
- **2 Streams**: Active payment streams

### Expected Behavior:
- **Loading States**: Spinner should show while fetching data
- **Error States**: Red error box with retry button if API fails
- **Empty States**: User-friendly message when no data exists
- **Real Data**: All data should come from the database, not hardcoded

---

## ⚠️ Common Issues & Troubleshooting

### Session Management Issues

**Problem:** Navigation to detail pages fails with "Invalid ID", "Not Found", or "Session Expired" errors.

**Causes:**
1. **Expired JWT Token:** Sessions expire after a period of inactivity (default: 1 hour)
2. **No Active Session:** You're not logged in or the token was cleared
3. **Cross-Tenant Access:** Attempting to access data from a different tenant

**Solutions:**
1. **Refresh the Page:** Press `Cmd/Ctrl + R` to reload
2. **Re-login:** Navigate to `http://localhost:5173/login` and sign in again
3. **Check Browser Console:** Look for `401 Unauthorized` or `Session expired` errors
4. **Clear Local Storage:** If issues persist, open DevTools → Application → Local Storage → Clear All
5. **Verify Test User:** Ensure you're using the correct test account credentials

**How to Identify Session Issues:**
- API calls return `401 Unauthorized` status
- Error messages mention "Session expired" or "Please log in"
- List pages load but detail pages fail
- Previously working pages suddenly show errors

**Prevention:**
- Keep the browser tab active while testing
- Refresh tokens by making API calls (clicking around) every 15 minutes
- Use the "Keep me signed in" option (if available)

### Detail Page Navigation Issues

**Problem:** Clicking on list items doesn't navigate to detail pages, or shows "Not Found" errors.

**Checklist:**
1. ✅ Verify the ID in the URL is a valid UUID (format: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
2. ✅ Check browser console for JavaScript errors
3. ✅ Confirm the API server is running (`lsof -ti:4000`)
4. ✅ Test the API endpoint directly using curl or Postman
5. ✅ Check Network tab in DevTools for failed requests
6. ✅ Verify RLS policies allow access to the data

**Example Test:**
```bash
# Test API endpoint (replace with your token)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  http://localhost:4000/v1/compliance/flags/5c1a3570-b4ae-4586-a91d-cb29ea71dcad
```

### API Connection Issues

**Problem:** "Connection Refused" or "Network Error" when making API calls.

**Solutions:**
1. **Start the API Server:**
   ```bash
   cd /Users/haxaco/Dev/PayOS/apps/api
   pnpm dev
   ```
2. **Verify Port:** Ensure API is running on port 4000 (`lsof -ti:4000`)
3. **Check Environment Variables:** Verify `VITE_API_URL` is set correctly in `.env`
4. **CORS Issues:** Clear browser cache and restart both servers

---

## Overview

Sly is the agentic economy platform. This guide covers all user flows for testing the dashboard UI.

### Application URL
- **Development:** http://localhost:3001 (updated port)
- **API:** http://localhost:4000

### Test User Context
- **User:** John Smith (Partner Admin)
- **Company:** Acme Fintech
- **Role:** Full administrative access

---

## Navigation Structure

### Primary Navigation (Sidebar)
| Route | Page | Badge |
|-------|------|-------|
| `/` | Home | — |
| `/accounts` | Accounts | — |
| `/transactions` | Transactions | — |
| `/cards` | Cards | — |
| `/compliance` | Compliance | 23 |
| `/disputes` | Disputes | 3 |
| `/treasury` | Treasury | — |
| `/agents` | Agents | — |
| `/reports` | Reports | — |

### Developer Navigation
| Route | Page |
|-------|------|
| `/api-keys` | API Keys |
| `/webhooks` | Webhooks |
| `/request-logs` | Request Logs |

### Configuration Navigation
| Route | Page |
|-------|------|
| `/templates` | Templates |
| `/verification-tiers` | Verification Tiers |
| `/agent-verification-tiers` | Agent Tiers (KYA) |
| `/settings` | Settings |

---

## Test Flows

### Flow 1: Home Dashboard

**Route:** `/`

**Steps:**
1. Navigate to Home page
2. Verify header shows "Home" with current date
3. Verify statistics cards display:
   - Accounts (12,847 with MTD growth)
   - Volume ($2.4M with MTD growth)
   - Cards (8,234 with MTD growth)
   - Pending Flags (23)
4. Verify AI Insights panel shows actionable items
5. Verify Volume by Corridor chart displays with time toggle (7D, 30D, 90D)
6. Verify "Requires Attention" section with risk badges
7. Verify Recent Activity feed shows transactions

**Expected Results:**
- All cards are clickable and navigate to respective pages
- Chart updates when time period is changed
- Activity items show proper formatting

---

### Flow 2: Accounts List

**Route:** `/accounts`

**Steps:**
1. Navigate to Accounts page
2. Verify page header "Accounts"
3. Verify search input is present
4. Verify filter dropdowns (Type, Status, Country)
5. Verify accounts table displays with columns:
   - Account (name, ID, type badge)
   - Balance
   - Status
   - Country
   - Created date
6. Click on an account row
7. Verify navigation to account detail page

**Test Data:**
- Person accounts: Maria Garcia, Ana Souza, Juan Perez, Carlos Martinez
- Business accounts: TechCorp Inc, Digital Services LLC, CloudSoft Inc

---

### Flow 3: Account Detail - Person

**Route:** `/accounts/acc_person_001`

**Steps:**
1. Navigate to Maria Garcia's account
2. Verify breadcrumb: Accounts > Maria Garcia
3. Verify header card shows:
   - Profile picture/avatar
   - Name: Maria Garcia
   - Email: maria.garcia@email.com
   - Phone: +54 11 1234 5678
   - Country: Argentina
   - Account ID: acc_person_001
   - Status badge: Active
   - Tier badge: T2 · Verified
4. Verify Balance card shows breakdown (USD, USDC)
5. Verify Card card shows card details
6. Verify tab navigation:
   - Overview
   - Transactions
   - **Payment Methods** ← New
   - Streams
   - Agents
   - Relationships
   - Documents
   - Logs

**Sub-Flow 3a: Overview Tab**
1. Click Overview tab
2. Verify AI Summary panel
3. Verify Recent Transactions list
4. Verify Relationships panel
5. Verify Verification checklist

**Sub-Flow 3c: Send Funds (Payment Creation)**
1. In the account header section, locate the action buttons:
   - "Edit" button (gray)
   - **"Send Funds" button (blue/primary)** ← Payment entry point
   - "Suspend/Activate" button (gray)
   - More options menu (gray)
2. Click the **"Send Funds"** button
3. Verify the New Payment modal opens
4. **Important:** The payment will originate from the account being viewed (Maria Garcia in this case)
5. In the modal, verify:
   - "From" account is pre-filled with current account (Maria Garcia)
   - "To" account selector is available
   - Amount input field
   - Currency selector
   - Description field
   - Payment type toggle (Transaction vs Stream)
6. Test canceling the modal
7. Test submitting a payment (if API is connected)

**Sub-Flow 3b: Payment Methods Tab** ← New Feature
1. Click "Payment Methods" tab
2. Verify header: "Payment Methods" with "Add Payment Method" button
3. Verify payment methods list shows:
   - Primary Checking (Wells Fargo, ****4521) - Default, Verified
   - USDC Wallet (Base, 0x1234...abcd) - Verified
   - Savings Account (Chase, ****8765) - Pending
4. Test "Set Default" button on non-default method
5. Test "Add Payment Method" button opens modal
6. In modal, verify:
   - Method type dropdown (Bank Account, Crypto Wallet)
   - Form fields change based on type selection
   - Bank account: Bank Name, Account Last 4, Routing Last 4
   - Wallet: Network dropdown, Wallet Address
   - "Set as default" checkbox
   - Cancel and Add buttons

---

### Flow 4: Account Detail - Business

**Route:** `/accounts/acc_biz_001`

**Steps:**
1. Navigate to TechCorp Inc's account
2. Verify business-specific fields:
   - Company name
   - EIN/Tax ID
   - Business type
   - Registered address
3. Verify tabs include business-specific content
4. In the account header section, locate the action buttons:
   - **"Create Payout" button (blue/primary)** ← Payment entry point for businesses
   - "Add Contractor" button (gray)
   - "Edit" button (gray)
   - More options menu (gray)
5. Click the **"Create Payout"** button
6. Verify the New Payment modal opens
7. **Important:** The payout will originate from the business account being viewed (TechCorp Inc)
8. The modal should pre-fill the "From" account with the business account

**Note:** Business accounts use "Create Payout" terminology, while person accounts use "Send Funds". Both open the same New Payment modal, but the terminology reflects the business context (payouts to contractors) vs personal context (sending funds to another account).

---

### Flow 5: Transactions List

**Route:** `/transactions`

**Steps:**
1. Navigate to Transactions page
2. Verify page header
3. Verify search and filter controls
4. Verify transactions table with columns:
   - Transaction ID
   - Type (Transfer, Card Spend, Deposit, etc.)
   - From/To
   - Amount
   - Status
   - Date
5. Click on a transaction row
6. Verify transaction detail panel opens

---

### Flow 6: Disputes Page ← New Feature

**Route:** `/disputes`

**Steps:**
1. Navigate to Disputes page via sidebar
2. Verify page header: "Disputes" with subtitle
3. Verify "AI Insights" button in header

**Step 6a: Alert Banner**
1. Verify alert banner shows: "2 disputes due within 7 days"
2. Verify "Review Now" button is present

**Step 6b: Status Cards**
Verify 5 status cards:
| Card | Value |
|------|-------|
| Open | 1 |
| Under Review | 1 |
| Escalated | 1 |
| Resolved | 1 |
| At Risk | $1,950 |

**Step 6c: Search and Filter**
1. Verify search input placeholder: "Search by name, ID, or transaction..."
2. Verify status dropdown with options:
   - All Status
   - Open
   - Under Review
   - Escalated
   - Resolved
3. Test filtering by different statuses

**Step 6d: Disputes Table**
Verify table columns:
- Dispute (ID, date)
- Parties (claimant → respondent)
- Amount (disputed / total)
- Reason
- Due Date (with "X days left" indicator)
- Status (badge)
- Actions (menu button)

Verify dispute rows:
| ID | Claimant | Respondent | Amount | Reason | Status |
|----|----------|------------|--------|--------|--------|
| dsp_001 | Maria Garcia | Digital Services LLC | $500 | Service Not Received | Open |
| dsp_002 | TechCorp Inc | John Smith Consulting | $250 | Incorrect Amount | Under Review |
| dsp_003 | Ana Souza | CloudSoft Inc | $1,200 | Duplicate Charge | Escalated |
| dsp_004 | Juan Perez | TechCorp Inc | $350 | Quality Issue | Resolved |

**Step 6e: Dispute Detail Slide-over**
1. Click on first dispute row (Maria Garcia)
2. Verify slide-over opens from right
3. Verify header shows:
   - "Dispute Details"
   - Dispute ID: dsp_001
   - Status badge: Open
   - Close (X) button
4. Verify "Original Transaction" section:
   - Amount: $500 USDC
   - Status: Completed with date
   - "View Transaction" link
5. Verify Parties section:
   - Claimant: Maria Garcia (Filed dispute)
   - Respondent: Digital Services LLC (Must respond)
6. Verify "Claim Details" grid:
   - Reason: Service Not Received
   - Amount Disputed: $500
   - Requested Resolution: Full Refund
   - Due Date: [date]
7. Verify "Claimant's Statement" text block
8. Verify "Admin Actions" section:
   - "Resolve Dispute" button
   - "Escalate" button
9. Click close button, verify slide-over closes

**Step 6f: Test Different Dispute States**
1. Click on Under Review dispute (dsp_002)
2. Verify status badge shows "Under Review" (blue)
3. Click on Escalated dispute (dsp_003)
4. Verify status badge shows "Escalated" (red)
5. Click on Resolved dispute (dsp_004)
6. Verify status badge shows "Resolved" (green)
7. Verify resolved disputes don't show action buttons

---

### Flow 7: Compliance Page

**Route:** `/compliance`

**Steps:**
1. Navigate to Compliance page
2. Verify compliance flags queue
3. Verify risk level badges (High, Medium, Low)
4. Click on a flag to view detail

---

### Flow 8: Cards Page

**Route:** `/cards`

**Steps:**
1. Navigate to Cards page
2. Verify cards list with:
   - Card number (masked)
   - Cardholder name
   - Type (Virtual/Physical)
   - Status
   - Balance/Limit
3. Click on a card to view detail

**Route:** `/cards/card_001`

**Steps:**
1. Verify card detail page shows:
   - Card visual
   - Card number
   - Expiry date
   - CVV (hidden)
   - Recent transactions
   - Spending limits
   - Controls (freeze, cancel)

---

### Flow 9: Treasury Page

**Route:** `/treasury`

**Steps:**
1. Navigate to Treasury page
2. Verify treasury overview:
   - Total balance across corridors
   - Float balances by currency
3. Verify corridor health indicators
4. Test adding funds flow

---

### Flow 10: Agents Page

**Route:** `/agents`

**Steps:**
1. Navigate to Agents page
2. Verify agents table with:
   - Agent name
   - Owner account
   - KYA tier
   - Status
   - Capabilities
3. Click on an agent row

**Route:** `/agents/agt_001`

**Steps:**
1. Verify agent detail with tabs:
   - Overview
   - Activity
   - Authentication
   - KYA
   - Streams
2. Verify API key display
3. Verify permissions list

---

### Flow 11: Reports Page

**Route:** `/reports`

**Steps:**
1. Navigate to Reports page
2. Verify tabs: Financial, Compliance, Activity
3. Test date range picker
4. Test export functionality
5. Verify charts and summaries

---

### Flow 12: API Keys Page

**Route:** `/api-keys`

**Steps:**
1. Navigate to API Keys page
2. Verify existing API keys list
3. Test "Create New Key" flow
4. Verify key permissions display
5. Test revoke key flow

---

### Flow 13: Webhooks Page

**Route:** `/webhooks`

**Steps:**
1. Navigate to Webhooks page
2. Verify webhook endpoints list
3. Test "Add Webhook" flow
4. Verify event type selection
5. Test webhook testing/ping

---

### Flow 14: Settings Page

**Route:** `/settings`

**Steps:**
1. Navigate to Settings page
2. Verify sections:
   - Profile settings
   - Company settings
   - Notification preferences
   - Security settings
3. Test form editing and saving

---

### Flow 15: New Payment Modal

**Entry Points:**
- **Account Detail Page (Person):** "Send Funds" button in account header
- **Account Detail Page (Business):** "Create Payout" button in account header
- **Note:** There is NO global "New Payment" button. Payments must originate from a specific account.

**Steps:**
1. Navigate to an Account Detail page (e.g., `/accounts/acc_person_001`)
2. Click the "Send Funds" button (person) or "Create Payout" button (business)
3. Verify modal opens with:
   - **From account:** Pre-filled with the account being viewed (cannot be changed)
   - **To account selector:** Dropdown to select recipient
   - **Amount input:** Enter payment amount
   - **Currency selector:** USD, USDC, etc.
   - **Description field:** Optional payment description
   - **Payment type toggle:** Transaction (one-time) vs Stream (recurring)
4. If "Stream" type selected:
   - Duration options (indefinite or fixed months)
   - Funding method (minimum or monthly)
   - Auto-pause options
5. If "Transaction" type with "Make Recurring" enabled:
   - Frequency dropdown (daily, weekly, monthly, etc.)
   - Start date picker
   - End date picker (optional)
   - Max occurrences (optional)
6. Test form validation (required fields)
7. Test canceling the modal
8. Submit and verify success (if API connected)

**Important Design Principle:**
- Payments always originate from a specific account
- The "From" account is determined by which account detail page you're viewing
- This ensures proper balance tracking and audit trails
- No global payment creation - all payments are account-scoped

---

### Flow 16: Global Search

**Steps:**
1. Click search bar in header
2. Type a search query
3. Verify search suggestions appear
4. Verify results are categorized:
   - Accounts
   - Transactions
   - Agents
5. Click a result, verify navigation

---

### Flow 17: AI Assistant

**Steps:**
1. Click floating AI button (bottom-right)
2. Verify chat panel opens
3. Type a question
4. Verify AI response appears
5. Test follow-up questions
6. Close chat panel

---

### Flow 18: Dark Mode Toggle

**Steps:**
1. Find dark mode toggle in header
2. Click to switch to dark mode
3. Verify all components render correctly in dark mode
4. Verify text is readable
5. Verify badges/status indicators maintain contrast
6. Switch back to light mode

---

### Flow 19: Sandbox/Environment Indicator

**Steps:**
1. Verify "Sandbox" badge in header
2. Click to see environment info
3. Verify environment-specific styling

---

## Error State Testing

### Empty States
Test each page with no data:
- Accounts page with no accounts
- Transactions page with no transactions
- Disputes page with no disputes
- Payment Methods tab with no methods

### Loading States
- Verify loading spinners appear during data fetch
- Verify skeleton loaders for list items

### Error States
- Test API failure handling
- Verify error messages are user-friendly
- Test retry functionality

---

## Responsive Testing

### Breakpoints
| Width | Device |
|-------|--------|
| 320px | Mobile S |
| 375px | Mobile M |
| 425px | Mobile L |
| 768px | Tablet |
| 1024px | Laptop |
| 1440px | Desktop |

### Mobile-Specific Tests
1. Verify sidebar collapses to hamburger menu
2. Verify tables become scrollable or stack
3. Verify modals are full-screen
4. Verify touch targets are 44px minimum

---

## Accessibility Testing

### Keyboard Navigation
1. Tab through all interactive elements
2. Verify focus states are visible
3. Test Enter/Space for buttons
4. Test Escape to close modals

### Screen Reader
1. Verify proper heading hierarchy
2. Verify form labels are associated
3. Verify status badges have aria-labels
4. Verify dynamic content announces changes

---

## Performance Testing

### Metrics to Monitor
- First Contentful Paint (FCP) < 1.5s
- Largest Contentful Paint (LCP) < 2.5s
- Time to Interactive (TTI) < 3s
- Cumulative Layout Shift (CLS) < 0.1

### Heavy Data Tests
- Load accounts page with 100+ accounts
- Load transactions with 500+ items
- Load disputes with 50+ disputes

---

## Browser Compatibility

### Required Browsers
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

### Test Each Browser For
- Layout consistency
- JavaScript functionality
- Form validation
- Modal behavior
- Animations

---

## Test Data Reference

### Accounts
| ID | Name | Type | Status |
|----|------|------|--------|
| acc_person_001 | Maria Garcia | Person | Active |
| acc_person_002 | Ana Souza | Person | Active |
| acc_person_003 | Juan Perez | Person | Active |
| acc_person_004 | Carlos Martinez | Person | Active |
| acc_biz_001 | TechCorp Inc | Business | Active |
| acc_biz_002 | Digital Services LLC | Business | Active |
| acc_biz_003 | CloudSoft Inc | Business | Active |

### Disputes
| ID | Status | Days Left |
|----|--------|-----------|
| dsp_001 | Open | 13 |
| dsp_002 | Under Review | 5 |
| dsp_003 | Escalated | 0 |
| dsp_004 | Resolved | — |

### Payment Methods (for acc_person_001)
| Label | Type | Status |
|-------|------|--------|
| Primary Checking | Bank Account | Default, Verified |
| USDC Wallet | Crypto Wallet | Verified |
| Savings Account | Bank Account | Pending |

---

## Checklist Summary

### Critical Flows (Must Pass)
- [x] Home dashboard loads correctly
- [x] Accounts list and detail pages work
- [x] Disputes page displays all elements
- [x] Dispute detail slide-over opens/closes
- [x] Payment Methods tab shows methods
- [x] Add Payment Method modal works
- [x] Navigation between all pages works
- [x] Dark mode toggle works
- [x] Search functionality works (Partially verified)

### Feature-Specific Tests
- [x] Dispute status filtering
- [x] Dispute status badges render correctly
- [x] Due date warnings display
- [x] Payment method verification badges
- [x] Set Default button on payment methods
- [x] AI Insights panels display
- [ ] Organization profile endpoints (API only)

### Edge Cases
- [ ] Empty state displays
- [ ] Error handling
- [ ] Loading states
- [ ] Mobile responsiveness

---

## New Flows: Organization & Auth (Phase 1.5)

These flows are primarily API-level for now (the UI does not yet expose full org/team management), but Gemini should still verify them via HTTP calls.

### Flow 20: Self-Service Signup (API)

- **Goal**: Verify that a new organization and owner user can be created via API and that API keys and session tokens are returned.
- **Preconditions**:
  - API server running at `http://localhost:4000`
  - No existing user with the target email
- **Steps**:
  1. Call `POST /v1/auth/signup` with a fresh email:
     ```bash
     curl -s -X POST http://localhost:4000/v1/auth/signup \
       -H "Content-Type: application/json" \
       -d '{
         "email": "gemini-signup-<timestamp>@example.com",
         "password": "SecureP@ss123456",
         "organizationName": "Gemini Test Org <timestamp>",
         "userName": "Gemini Owner"
       }'
     ```
  2. Verify the response structure:
     - `user.id`, `user.email`, `user.name` present.
     - `tenant`/`organization` object with `id`, `name`, `status`.
     - `apiKeys.test.key` and `apiKeys.live.key` present.
     - `session.accessToken` and `session.refreshToken` present (may be `null` if token creation fails; treat as non-blocking).
  3. Confirm that keys look like:
     - `pk_test_...`
     - `pk_live_...`
  4. Confirm that keys are only shown in this response (they will not be retrievable later).

- **Expected Result**:
  - HTTP `201`.
  - Organization is created and visible in subsequent calls (see next flow).

### Flow 21: Login & Me (API)

- **Goal**: Verify login, lockout protection, and `/v1/auth/me`.
- **Steps**:
  1. Use the email/password from Flow 20.
  2. Call `POST /v1/auth/login`:
     ```bash
     curl -s -X POST http://localhost:4000/v1/auth/login \
       -H "Content-Type: application/json" \
       -d '{
         "email": "<signup-email>",
         "password": "SecureP@ss123456"
       }'
     ```
  3. Verify:
     - `user.id`, `user.email`, `user.role` (`owner`), `user.name` are present.
     - `tenant` object has `id`, `name`, `status: "active"`.
     - `session.accessToken` and `session.refreshToken` are non-empty strings.
  4. Call `GET /v1/auth/me` with the `accessToken`:
     ```bash
     TOKEN="<access-token-from-login>"
     curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/auth/me
     ```
  5. Verify:
     - The same user and tenant information as login.

- **Negative Case**:
  - Call `POST /v1/auth/login` with the correct email and wrong password at least once.
  - Expected: HTTP `400` with `{ "error": "Invalid credentials" }`.

- **Expected Result**:
  - Login works with valid creds, fails correctly with invalid ones.
  - `/v1/auth/me` returns current user and organization.

### Flow 22: Organization Profile (API)

- **Goal**: Verify `GET /v1/organization` and `PATCH /v1/organization` for the current user’s organization.
- **Steps**:
  1. Obtain an `accessToken` via Flow 21.
  2. Call `GET /v1/organization`:
     ```bash
     TOKEN="<access-token-from-login>"
     curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/organization
     ```
  3. Verify:
     - Response has an `organization` object.
     - Fields: `id`, `name`, `status`, `createdAt`, `updatedAt`.
  4. Call `PATCH /v1/organization` to change the name:
     ```bash
     curl -s -X PATCH http://localhost:4000/v1/organization \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{
         "name": "Updated Org Name (Gemini)"
       }'
     ```
  5. Verify:
     - Response `organization.name` matches the new name.
     - `updatedAt` is later than the previous value.
  6. Call `GET /v1/organization` again and confirm the updated name persists.

- **Negative Cases**:
  - Call `GET /v1/organization` without `Authorization` → expect `401`.
  - Call `PATCH /v1/organization` with no body `{}` → expect `400` with `error: "No changes provided"`.

- **Expected Result**:
  - Authenticated users see their organization.
  - Owners/admins can rename the organization.

### Flow 23: Organization Team (API)

- **Goal**: Verify `GET /v1/organization/team` returns the list of team members for the current organization.
- **Steps**:
  1. Obtain an `accessToken` via Flow 21 (login as the owner user).
  2. Call `GET /v1/organization/team`:
     ```bash
     TOKEN="<access-token-from-login>"
     curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4000/v1/organization/team
     ```
  3. Verify:
     - Response has a `members` array.
     - For the initial owner-only setup:
       - `members.length` is at least 1.
       - The first member has:
         - `role: "owner"`
         - `name` matching the signup or login user (e.g., `"Test User"` / `"Gemini Owner"`).
         - `invited: false`
         - `createdAt` and `updatedAt` timestamps.
  4. (Later, when invites are implemented) verify that invited-but-not-accepted users show:
     - `invited: true`
     - `inviteExpiresAt` is in the future.
     - `inviteAcceptedAt` is `null`.

- **Negative Cases**:
  - Call `GET /v1/organization/team` without `Authorization` → expect `401`.

- **Expected Result**:
  - Authenticated users can list all team members for their organization.
  - Owners/admins can see who is active vs invited (once invites are wired).

> Note: For now, the dashboard UI does not yet expose a full organization settings page. These flows are **API-only** and are meant to ensure backend correctness before the UI is wired up.

### Flow 24: Organization Team Role & Removal Safety (API)

- **Goal**: Verify that role changes and removals are protected (cannot remove last owner, cannot leave via team API).
- **Preconditions**:
  - Only one member exists (the owner created in Flow 20).
- **Steps**:
  1. Obtain an `accessToken` via Flow 21.
  2. Try to change the owner’s role:
     ```bash
     TOKEN="<access-token-from-login>"
     OWNER_ID="<user-id-from-Flows-20-21>"
     curl -s -X PATCH http://localhost:4000/v1/organization/team/$OWNER_ID \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{ "role": "admin" }' | jq '.'
     ```
  3. Verify:
     - HTTP `400`.
     - Response `{ "error": "Cannot change role of the last owner" }`.
  4. Try to remove the owner via team API:
     ```bash
     curl -s -X DELETE http://localhost:4000/v1/organization/team/$OWNER_ID \
       -H "Authorization: Bearer $TOKEN" | jq '.'
     ```
  5. Verify:
     - HTTP `400`.
     - Response `{ "error": "Use account settings to leave organization" }`.

- **Expected Result**:
  - The last owner cannot be demoted or removed via the team API.
  - Owners must use a dedicated flow (to be implemented) to leave/transfer ownership.

---

### Flow 25: Send Team Invite (API)

- **Goal**: Verify that owners and admins can invite new members to their organization.
- **Pre-requisite**: Complete Flow 20 (signup) and Flow 21 (login) to get an `accessToken` for the owner user.
- **Steps**:
  1. Obtain the `accessToken` for the owner user.
  2. Send a POST request to create a team invite:
     ```bash
     OWNER_TOKEN="<access-token-from-login>"
     curl -s -X POST http://localhost:4000/v1/organization/team/invite \
       -H "Authorization: Bearer $OWNER_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{
         "email": "newteammember@example.com",
         "role": "member",
         "name": "New Team Member"
       }' | jq '.'
     ```
  3. **Verify**:
     - HTTP `201` status code.
     - Response contains `invite` object with:
       - `id`: UUID of the invite
       - `email`: The invited email
       - `role`: The specified role
       - `name`: The specified name (optional)
       - `expiresAt`: Expiry timestamp (7 days from now)
       - `inviteUrl`: URL with token for accepting the invite
  4. **Note**: Save the `inviteUrl` token for Flow 27.
  5. Test that a viewer cannot send invites:
     ```bash
     VIEWER_TOKEN="<access-token-for-viewer>"
     curl -s -X POST http://localhost:4000/v1/organization/team/invite \
       -H "Authorization: Bearer $VIEWER_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{
         "email": "unauthorized@example.com",
         "role": "member"
       }' | jq '.'
     ```
  6. **Verify**: HTTP `403` status, error: `"Forbidden"`.

- **Expected Result**:
  - Owners and admins can successfully create team invites.
  - Viewers and members are forbidden from sending invites.
  - The invite is stored with a secure token and 7-day expiry.

---

### Flow 26: List Pending Invites (API)

- **Goal**: Verify that owners and admins can view all pending (unaccepted) invites for their organization.
- **Pre-requisite**: Complete Flow 25 to create at least one pending invite.
- **Steps**:
  1. Obtain the `accessToken` for the owner user.
  2. Send a GET request to list pending invites:
     ```bash
     OWNER_TOKEN="<access-token-from-login>"
     curl -s -X GET http://localhost:4000/v1/organization/team/invites \
       -H "Authorization: Bearer $OWNER_TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response contains `invites` array with pending invites.
     - Each invite has:
       - `id`: UUID
       - `email`: Invited email
       - `role`: Invited role
       - `name`: Invited name (if provided)
       - `expiresAt`: Expiry timestamp
       - `expired`: Boolean indicating if the invite is expired
       - `createdAt`: Creation timestamp
       - `updatedAt`: Last update timestamp
     - Accepted invites (with `accepted_at` set) are NOT in the list.

- **Expected Result**:
  - Owners and admins can see all pending invites.
  - Accepted invites are filtered out.
  - Expired invites are marked with `expired: true`.

---

### Flow 27: Accept Team Invite (API)

- **Goal**: Verify that a user can accept a team invite and join an organization.
- **Pre-requisite**: Complete Flow 25 to create an invite and obtain the `token` from the `inviteUrl`.
- **Steps**:
  1. Extract the token from the `inviteUrl` (e.g., `http://localhost:3000/accept-invite?token=<TOKEN>`).
  2. Send a POST request to accept the invite:
     ```bash
     INVITE_TOKEN="<token-from-invite-url>"
     curl -s -X POST http://localhost:4000/v1/auth/accept-invite \
       -H "Content-Type: application/json" \
       -d '{
         "token": "'$INVITE_TOKEN'",
         "password": "SecureNewPass@123",
         "name": "New Team Member"
       }' | jq '.'
     ```
  3. **Verify**:
     - HTTP `201` status code.
     - Response contains:
       - `user`: Object with `id`, `email`, `name`, `role` (as specified in the invite)
       - `tenant`: Object with organization details (`id`, `name`, `status`)
       - `session`: Object with `accessToken` and `refreshToken`
  4. Verify the new user can log in:
     ```bash
     curl -s -X POST http://localhost:4000/v1/auth/login \
       -H "Content-Type: application/json" \
       -d '{
         "email": "<invited-email>",
         "password": "SecureNewPass@123"
       }' | jq '.'
     ```
  5. **Verify**: Login succeeds, user is associated with the correct organization.
  6. Verify the user appears in the team list (Flow 23).
  7. Test edge cases:
     - **Already accepted**: Try to accept the same invite again.
       ```bash
       curl -s -X POST http://localhost:4000/v1/auth/accept-invite \
         -H "Content-Type: application/json" \
         -d '{
           "token": "'$INVITE_TOKEN'",
           "password": "AnotherPass@123"
         }' | jq '.'
       ```
       **Verify**: HTTP `400` status, error: `"This invite has already been accepted"`.
     - **Invalid token**: Use a non-existent or malformed token.
       **Verify**: HTTP `400` status, error: `"Invalid or expired invite token"`.

- **Expected Result**:
  - Users can successfully accept invites and join the organization.
  - A new user account is created (or existing account is linked if the email already exists in Supabase Auth but has no profile).
  - The user is assigned the role specified in the invite.
  - The invite is marked as accepted and no longer appears in the pending invites list.
  - Already-accepted invites cannot be reused.

---

### Flow 28: Create API Key (API)

- **Goal**: Verify that users can create new API keys for test and live environments.
- **Pre-requisite**: Complete Flow 21 (login) to get an `accessToken`.
- **Steps**:
  1. Obtain the `accessToken` for an owner or admin user.
  2. Create a test environment API key:
     ```bash
     TOKEN="<access-token-from-login>"
     curl -s -X POST http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{
         "name": "Test Backend Key",
         "environment": "test",
         "description": "API key for testing"
       }' | jq '.'
     ```
  3. **Verify**:
     - HTTP `201` status code.
     - Response contains `apiKey` object with:
       - `id`: UUID
       - `name`: "Test Backend Key"
       - `environment`: "test"
       - `prefix`: First 12 chars of the key (e.g., "pk_test_abc1")
       - `key`: Full API key (shown ONCE) - format: `pk_test_<32_random_chars>`
       - `description`: "API key for testing"
       - `expiresAt`: null (or specified expiry)
       - `createdAt`: Timestamp
     - Response includes warning: "This key will only be shown once. Please save it securely."
  4. Save the full `key` value for later testing.
  5. Create a live environment API key:
     ```bash
     curl -s -X POST http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer $TOKEN" \
       -H "Content-Type: application/json" \
       -d '{
         "name": "Production Backend Key",
         "environment": "live",
         "description": "API key for production",
         "expiresAt": "2026-12-31T23:59:59Z"
       }' | jq '.'
     ```
  6. **Verify**: Same as above, but `environment` is "live" and `expiresAt` is set.

- **Expected Result**:
  - API keys are created with 256-bit random entropy.
  - Full key is shown only once on creation.
  - Key prefix is stored for identification.
  - Keys are stored as SHA-256 hashes (not verified in API, internal only).

---

### Flow 29: List API Keys (API)

- **Goal**: Verify that users can list all API keys for their organization, with optional filtering by environment.
- **Pre-requisite**: Complete Flow 28 to create some API keys.
- **Steps**:
  1. Obtain the `accessToken`.
  2. List all API keys:
     ```bash
     TOKEN="<access-token-from-login>"
     curl -s -X GET http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer $TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response contains `apiKeys` array.
     - Each key has:
       - `id`, `name`, `environment`, `prefix`, `description`, `status`, `expiresAt`, `lastUsedAt`, `createdAt`, `updatedAt`, `createdBy`
     - Full `key` is NOT returned (only `prefix`).
     - Keys are sorted by `createdAt` descending (newest first).
  4. Filter by test environment:
     ```bash
     curl -s -X GET "http://localhost:4000/v1/api-keys?environment=test" \
       -H "Authorization: Bearer $TOKEN" | jq '.apiKeys[] | {name, environment, prefix}'
     ```
  5. **Verify**: Only keys with `environment: "test"` are returned.
  6. Filter by live environment:
     ```bash
     curl -s -X GET "http://localhost:4000/v1/api-keys?environment=live" \
       -H "Authorization: Bearer $TOKEN" | jq '.apiKeys[] | {name, environment, prefix}'
     ```
  7. **Verify**: Only keys with `environment: "live"` are returned.

- **Expected Result**:
  - All API keys for the organization are listed.
  - Full keys are never exposed (only prefix).
  - Filtering by environment works correctly.

---

### Flow 30: Get API Key Details (API)

- **Goal**: Verify that users can retrieve detailed information about a specific API key.
- **Pre-requisite**: Complete Flow 28 or 29 to have a key ID.
- **Steps**:
  1. Obtain the `accessToken` and a key `id` from Flow 29.
  2. Get key details:
     ```bash
     TOKEN="<access-token-from-login>"
     KEY_ID="<key-id-from-list>"
     curl -s -X GET "http://localhost:4000/v1/api-keys/$KEY_ID" \
       -H "Authorization: Bearer $TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response contains `apiKey` object with detailed fields:
       - `id`, `name`, `environment`, `prefix`, `description`, `status`, `expiresAt`
       - `lastUsedAt`, `lastUsedIp` (null if never used)
       - `createdAt`, `updatedAt`, `createdBy` (user ID)
     - Full `key` is NOT returned.

- **Expected Result**:
  - Detailed information is returned for the specified key.
  - Last used timestamp and IP are available (for auditing).

---

### Flow 31: Revoke API Key (API)

- **Goal**: Verify that users can revoke API keys with proper permission checks.
- **Pre-requisite**: Complete Flow 28 to create a key to revoke.
- **Steps**:
  1. Obtain the `accessToken` and a key `id` to revoke.
  2. Revoke the key:
     ```bash
     TOKEN="<access-token-from-login>"
     KEY_ID="<key-id-to-revoke>"
     curl -s -X DELETE "http://localhost:4000/v1/api-keys/$KEY_ID" \
       -H "Authorization: Bearer $TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response: `{ "success": true }`.
  4. Verify the key status changed:
     ```bash
     curl -s -X GET "http://localhost:4000/v1/api-keys/$KEY_ID" \
       -H "Authorization: Bearer $TOKEN" | jq '.apiKey | {status, revokedAt: .updatedAt}'
     ```
  5. **Verify**: `status` is "revoked", `updatedAt` reflects revocation time.
  6. Test permission check - viewer trying to revoke owner's key:
     ```bash
     VIEWER_TOKEN="<viewer-access-token>"
     OWNER_KEY_ID="<owner-key-id>"
     curl -s -X DELETE "http://localhost:4000/v1/api-keys/$OWNER_KEY_ID" \
       -H "Authorization: Bearer $VIEWER_TOKEN" | jq '.'
     ```
  7. **Verify**: HTTP `403` status, error: "You can only revoke your own API keys".

- **Expected Result**:
  - API keys are immediately revoked (status changed to "revoked").
  - Members can only revoke their own keys.
  - Admins and owners can revoke any key in the organization.
  - Security event logged: `api_key_revoked`.

---

### Flow 32: Rotate API Key (API)

- **Goal**: Verify that users can rotate API keys with a 24-hour grace period.
- **Pre-requisite**: Complete Flow 28 to create a key to rotate.
- **Steps**:
  1. Obtain the `accessToken` and a key `id` to rotate.
  2. Rotate the key:
     ```bash
     TOKEN="<access-token-from-login>"
     KEY_ID="<key-id-to-rotate>"
     curl -s -X POST "http://localhost:4000/v1/api-keys/$KEY_ID/rotate" \
       -H "Authorization: Bearer $TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `201` status code.
     - Response contains:
       - `newApiKey`: Object with new key details, including full `key` (shown ONCE).
       - `oldApiKey`: Object with old key `id`, `prefix`, and `gracePeriodEnds` timestamp (24 hours from now).
       - `warning`: "The new key will only be shown once. The old key will remain valid for 24 hours."
  4. Save the new `key` value.
  5. Verify the old key status:
     ```bash
     curl -s -X GET "http://localhost:4000/v1/api-keys/$KEY_ID" \
       -H "Authorization: Bearer $TOKEN" | jq '.apiKey | {status, gracePeriodEndsAt}'
     ```
  6. **Verify**: `status` is "grace_period" (if implemented) or remains "active" for 24 hours.
  7. Verify the new key is active:
     ```bash
     NEW_KEY_ID="<new-key-id-from-response>"
     curl -s -X GET "http://localhost:4000/v1/api-keys/$NEW_KEY_ID" \
       -H "Authorization: Bearer $TOKEN" | jq '.apiKey | {name, status, environment}'
     ```
  8. **Verify**: New key is `active`, name includes "(Rotated)", same environment as old key.

- **Expected Result**:
  - New API key is created with same environment and description.
  - Old key enters grace period (valid for 24 hours).
  - Full new key is shown only once.
  - Security event logged: `api_key_rotated`.

---

### Flow 33: Test JWT Auth Middleware (API)

- **Goal**: Verify that JWT tokens from Supabase Auth work with all protected API endpoints.
- **Pre-requisite**: Complete Flow 21 (login) to get a JWT access token.
- **Steps**:
  1. Login and obtain JWT access token:
     ```bash
     LOGIN_RESPONSE=$(curl -s -X POST http://localhost:4000/v1/auth/login \
       -H "Content-Type: application/json" \
       -d '{"email": "your-email@example.com", "password": "YourPassword123"}')
     JWT_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.session.accessToken')
     echo "JWT Token: ${JWT_TOKEN:0:30}..."
     ```
  2. Call a protected endpoint (e.g., `/v1/api-keys`):
     ```bash
     curl -s -X GET http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer $JWT_TOKEN" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response contains data (e.g., `apiKeys` array).
     - No authentication errors.
  4. Test with an invalid/expired JWT:
     ```bash
     curl -s -X GET http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer invalid_jwt_token" | jq '.'
     ```
  5. **Verify**: HTTP `401` status, error: "Invalid or expired session token".

- **Expected Result**:
  - JWT tokens work seamlessly with all protected endpoints.
  - Request context includes: `tenantId`, `actorType: 'user'`, `userId`, `userRole`, `userName`.
  - Invalid JWTs are rejected with clear error messages.

---

### Flow 34: Test API Key Auth Middleware (API)

- **Goal**: Verify that API keys from the `api_keys` table work with all protected API endpoints and track usage.
- **Pre-requisite**: Complete Flow 28 to create an API key.
- **Steps**:
  1. Use an API key created earlier:
     ```bash
     API_KEY="pk_test_abc123xyz..."  # From Flow 28
     ```
  2. Call a protected endpoint (e.g., `/v1/accounts`):
     ```bash
     curl -s -X GET http://localhost:4000/v1/accounts \
       -H "Authorization: Bearer $API_KEY" | jq '.'
     ```
  3. **Verify**:
     - HTTP `200` status code.
     - Response contains accounts data.
     - No authentication errors.
  4. Check that `last_used_at` and `last_used_ip` are tracked:
     ```bash
     # Login with JWT to check the API key details
     JWT_TOKEN="<your-jwt-token>"
     API_KEY_ID="<api-key-id>"
     curl -s -X GET "http://localhost:4000/v1/api-keys/$API_KEY_ID" \
       -H "Authorization: Bearer $JWT_TOKEN" | jq '.apiKey | {lastUsedAt, lastUsedIp}'
     ```
  5. **Verify**: `lastUsedAt` is recent, `lastUsedIp` is set.
  6. Test with a revoked API key:
     ```bash
     # Revoke the key first (via JWT auth)
     curl -s -X DELETE "http://localhost:4000/v1/api-keys/$API_KEY_ID" \
       -H "Authorization: Bearer $JWT_TOKEN"
     # Try to use the revoked key
     curl -s -X GET http://localhost:4000/v1/accounts \
       -H "Authorization: Bearer $API_KEY" | jq '.'
     ```
  7. **Verify**: HTTP `401` status, error: "API key is not active".

- **Expected Result**:
  - API keys work with all protected endpoints.
  - Request context includes: `tenantId`, `actorType: 'api_key'`, `apiKeyId`, `apiKeyEnvironment`.
  - `last_used_at` and `last_used_ip` are updated on each request.
  - Revoked, expired, or invalid keys are rejected.
  - Legacy API keys (from `tenants` table) still work as fallback.

---

### Flow 35: Test Auth Middleware - Multiple Auth Types (API)

- **Goal**: Verify that the auth middleware correctly handles API keys, JWTs, and agent tokens.
- **Pre-requisite**: Have API keys, JWT tokens, and agent tokens (if applicable) ready.
- **Steps**:
  1. Test API key (pk_test_*):
     ```bash
     curl -s -X GET http://localhost:4000/v1/accounts \
       -H "Authorization: Bearer pk_test_..." | jq '.accounts | length'
     ```
  2. Test JWT (eyJ*):
     ```bash
     curl -s -X GET http://localhost:4000/v1/api-keys \
       -H "Authorization: Bearer eyJ..." | jq '.apiKeys | length'
     ```
  3. Test agent token (agent_*) if applicable:
     ```bash
     curl -s -X GET http://localhost:4000/v1/some-endpoint \
       -H "Authorization: Bearer agent_..." | jq '.'
     ```
  4. Test with missing Authorization header:
     ```bash
     curl -s -X GET http://localhost:4000/v1/accounts | jq '.'
     ```
  5. **Verify**: HTTP `401` status, error: "Missing or invalid authorization header".
  6. Test with malformed token:
     ```bash
     curl -s -X GET http://localhost:4000/v1/accounts \
       -H "Authorization: Bearer invalid_token_format" | jq '.'
     ```
  7. **Verify**: HTTP `401` status, error: "Invalid token format".

- **Expected Result**:
  - All three auth types (API key, JWT, agent) work correctly.
  - Missing or malformed tokens are rejected with appropriate errors.
  - Security events are logged for all auth attempts.

---

## 🎯 PRIORITY UI FLOWS - Mock-to-API Migration Testing

### Flow 36: Accounts Page - Real API Data (Story 12.3) 🆕

- **Goal**: Verify that the Accounts page displays real data from the API with proper loading and error states.
- **Pre-requisite**: API server running on port 4000, UI server on port 3001.
- **Steps**:
  1. Navigate to `http://localhost:3001/accounts`
  2. **Verify Loading State**:
     - Spinner or skeleton rows should appear briefly
  3. **Verify Data Display**:
     - Should show **7 accounts** (not hardcoded mock data)
     - Account names: Maria Garcia, Carlos Martinez, Ana Silva, Juan Perez, Sofia Rodriguez, TechCorp Inc, StartupXYZ
     - Each account shows: name, email, type (person/business), verification status
  4. **Verify Stats**:
     - Total Accounts: 7
     - Active: (count of active accounts)
     - Person/Business breakdown should match real data
  5. **Verify Search**: Type "Maria" - should filter to Maria Garcia only
  6. **Verify Sorting**: Click column headers - data should re-sort
  7. **Click any account** - should navigate to account detail page

- **Expected Result**:
  - ✅ Real data from database (not mock data)
  - ✅ Loading spinner shows during fetch
  - ✅ All 7 accounts visible
  - ✅ Navigation to detail pages works
  - ✅ Search and filters functional

- **Error Testing**:
  1. Stop the API server (`kill` port 4000 process)
  2. Refresh the page
  3. **Verify**: Red error banner with message "Failed to load accounts"
  4. **Verify**: Retry button visible
  5. Restart API, click retry
  6. **Verify**: Data loads successfully

---

### Flow 37: Account Detail Page - Real API Data (Story 12.3) 🆕

- **Goal**: Verify account detail pages load real data and handle navigation correctly.
- **Pre-requisite**: On Accounts page with 7 accounts visible.
- **Steps**:
  1. Click on **"Maria Garcia"** account
  2. **Verify URL**: Should be `/accounts/{uuid}` (real UUID, not hardcoded)
  3. **Verify Breadcrumb**: "Accounts > Maria Garcia" (clickable)
  4. **Verify Account Details**:
     - Name: Maria Garcia
     - Email: maria.garcia@example.com
     - Type: Person
     - Currency: USDC
     - Verification: Tier 2, Verified
     - Balance: $0 (or real balance)
  5. **Verify Tabs**: Overview, Transactions, Agents, Streams
  6. Click **Transactions** tab - should show transactions for this account
  7. Click **Back to Accounts** - should return to list
  8. Test with different account (TechCorp Inc - business account)
  9. **Verify**: Business account shows different fields (company info, etc.)

- **Expected Result**:
  - ✅ Real data for each account
  - ✅ URLs use real UUIDs
  - ✅ Person vs Business accounts render correctly
  - ✅ Tabs and navigation work
  - ✅ Breadcrumbs functional

- **Error Testing**:
  1. Navigate to `/accounts/invalid-uuid-12345`
  2. **Verify**: "Account not found" message
  3. **Verify**: Back button visible

---

### Flow 38: Transactions Page - Real API Data (Story 12.4) 🆕

- **Goal**: Verify Transactions page displays real transfers from the API.
- **Pre-requisite**: API server running, 5 transfers seeded in database.
- **Steps**:
  1. Navigate to `http://localhost:3001/transactions`
  2. **Verify Loading State**:
     - Skeleton rows appear during load
  3. **Verify Data Display**:
     - Should show **5 transfers** (not mock data)
     - Each row shows: From account, To account, Amount, Status, Type, Date
     - Status badges: Completed (green), Pending (yellow), Failed (red)
  4. **Verify Stats/AI Insights**:
     - Should show real counts (e.g., "5 transfers analyzed")
     - Status breakdown matches table data
  5. **Verify Status Filter**:
     - Click "Completed" filter - shows only completed transfers
     - Click "Pending" filter - shows only pending transfers
     - Click "Failed" filter - shows only failed transfers
     - Click "All" - shows all 5 transfers
  6. **Verify Row Click**:
     - Click any transaction row
     - Should navigate to transaction detail page with correct ID

- **Expected Result**:
  - ✅ 5 real transfers from database
  - ✅ Correct from/to account names
  - ✅ Real amounts and statuses
  - ✅ Filters work correctly
  - ✅ Navigation to detail works

- **Error Testing**:
  1. Stop API server
  2. Refresh page
  3. **Verify**: Error banner with "Failed to load transfers"
  4. **Verify**: Retry button works

---

### Flow 39: Transaction Detail Page - Real API Data (Story 12.4) 🆕

- **Goal**: Verify transaction detail pages show complete transfer information.
- **Pre-requisite**: On Transactions page with 5 transfers visible.
- **Steps**:
  1. Click on any **completed transfer** (green status)
  2. **Verify URL**: `/transactions/{uuid}` (real UUID)
  3. **Verify Breadcrumb**: "Transactions > Transfer {ID}"
  4. **Verify Transaction Flow**:
     - From account name and avatar
     - Arrow indicator
     - To account name and avatar
     - Amount displayed prominently
  5. **Verify Details Section**:
     - Transfer ID (real UUID)
     - Status badge (Completed/Pending/Failed)
     - Description
     - Amount
     - Created date
  6. **Verify Status-Specific UI**:
     - **Completed**: Green checkmark, no banner
     - **Pending**: Yellow banner "Transfer in progress"
     - **Failed**: Red banner "Transfer failed"
  7. Click **Back to Transactions** - return to list
  8. Test with **pending transfer** - verify pending UI
  9. Test with **failed transfer** - verify failed UI

- **Expected Result**:
  - ✅ All transfer details accurate
  - ✅ From/To account names correct
  - ✅ Status banners show for pending/failed
  - ✅ Real timestamps and amounts
  - ✅ Navigation works

- **Error Testing**:
  1. Navigate to `/transactions/invalid-uuid-99999`
  2. **Verify**: "Transaction not found" message

---

### Flow 40: Cards Page - Real API Data (Story 12.5) 🆕

- **Goal**: Verify Cards page displays real payment methods from the API.
- **Pre-requisite**: API server running, 4 payment methods seeded.
- **Steps**:
  1. Navigate to `http://localhost:3001/cards`
  2. **Verify Loading State**:
     - Skeleton rows during fetch
  3. **Verify Data Display**:
     - Should show **4 cards** (not mock data)
     - Card numbers: •••• 4521, •••• 2847, •••• 8834, •••• 9182
     - Cardholders: Maria Garcia, Carlos Martinez, TechCorp Inc, Ana Silva
     - Labels: Visa ****4521, Mastercard ****2847, etc.
  4. **Verify Stats**:
     - Total: 4
     - Active/Verified: (based on real data)
     - Default: (count of default cards)
  5. **Verify Status Badges**:
     - "Verified" badge (green) for verified cards
     - "Unverified" badge (gray) for unverified
     - "Default" badge (blue) for default payment methods
  6. **Verify Security**:
     - **Only last 4 digits shown** (no full PAN)
     - No CVV visible
  7. Click any card row - should navigate to card detail

- **Expected Result**:
  - ✅ 4 real payment methods from database
  - ✅ Correct last 4 digits
  - ✅ Cardholder names accurate
  - ✅ Status badges correct
  - ✅ **Security compliant** (no full PAN)

- **Error Testing**:
  1. Stop API server
  2. Refresh page
  3. **Verify**: Error banner "Failed to load payment methods"
  4. **Verify**: Retry button works

---

### Flow 41: Card Detail Page - Real API Data (Story 12.5) 🆕

- **Goal**: Verify card detail pages show payment method information securely.
- **Pre-requisite**: On Cards page with 4 cards visible.
- **Steps**:
  1. Click on **Visa ****4521** (Maria Garcia's card)
  2. **Verify URL**: `/cards/{uuid}` (real payment method ID)
  3. **Verify Breadcrumb**: "Cards > •••• 4521" or label name
  4. **Verify Card Visual**:
     - PayOS branding
     - Card type: card
     - Last 4 digits: 4521
     - **Security message**: "Full card number hidden for security"
  5. **Verify Details**:
     - Cardholder: Maria Garcia
     - Status: Verified/Unverified
     - Default: Yes/No
     - Created date
  6. **Verify Security**:
     - ❌ NO full PAN visible
     - ❌ NO CVV visible
     - ✅ Only last 4 digits shown
     - ✅ "Eye" icon for PAN is disabled with security tooltip
  7. **Verify Card Activity Section**:
     - Shows "No card activity yet" (transactions not linked to payment methods yet)
  8. Click **Back to Cards** - return to list
  9. Test with different cards (Mastercard ****2847, etc.)

- **Expected Result**:
  - ✅ All payment method details accurate
  - ✅ **SECURITY**: No full PAN or CVV exposed
  - ✅ Last 4 digits correct for each card
  - ✅ Cardholder names match database
  - ✅ Status and default flags accurate

- **Error Testing**:
  1. Navigate to `/cards/invalid-uuid-12345`
  2. **Verify**: "Card not found" message

---

### Flow 42: Empty State Testing 🆕

- **Goal**: Verify empty states display correctly when no data exists.
- **Pre-requisite**: Ability to test with a tenant that has no data.
- **Steps**:
  1. **Accounts Empty State**:
     - If all accounts deleted or fresh tenant
     - Navigate to `/accounts`
     - **Verify**: Empty state message "No accounts found"
     - **Verify**: CTA button "Create Account" visible
  2. **Transactions Empty State**:
     - Navigate to `/transactions`
     - **Verify**: "No transfers found" message
     - **Verify**: Suggestion to create a transfer
  3. **Cards Empty State**:
     - Navigate to `/cards`
     - **Verify**: "No cards found" message
     - **Verify**: "Issue your first card" suggestion

- **Expected Result**:
  - ✅ User-friendly empty states (not just blank pages)
  - ✅ Clear messaging about what's missing
  - ✅ CTAs to create first item

---

### Flow 43: Loading States Testing 🆕

- **Goal**: Verify loading states appear correctly during data fetching.
- **Pre-requisite**: Ability to simulate slow network or add artificial delay.
- **Steps**:
  1. **Accounts Loading**:
     - Navigate to `/accounts`
     - During load: **Verify** spinner or skeleton rows visible
     - After load: **Verify** real data appears, loading state disappears
  2. **Transactions Loading**:
     - Navigate to `/transactions`
     - **Verify**: Skeleton rows with animated pulse effect
     - **Verify**: 4-5 skeleton rows as placeholders
  3. **Cards Loading**:
     - Navigate to `/cards`
     - **Verify**: Loading indicators in table
  4. **Detail Pages Loading**:
     - Navigate to any detail page (account, transaction, card)
     - **Verify**: Centered spinner while fetching single item
     - **Verify**: Page content appears after load

- **Expected Result**:
  - ✅ Loading states visible during fetch
  - ✅ No "flash of empty content"
  - ✅ Smooth transition to loaded state
  - ✅ Professional UX (skeletons match final layout)

---

### Flow 44: End-to-End User Journey 🆕

- **Goal**: Test complete user flow across all migrated pages.
- **Pre-requisite**: Fresh browser session, all servers running.
- **Steps**:
  1. **Start**: Navigate to `http://localhost:3001/accounts`
  2. **View Accounts**: See 7 accounts, verify real data
  3. **Select Account**: Click "Maria Garcia"
  4. **View Details**: See Maria's account details
  5. **View Transactions**: Click Transactions tab
  6. **Navigate to Transaction**: Click a transaction from Maria's account
  7. **View Transaction**: See complete transfer details
  8. **Back to Transactions**: Use breadcrumb or back button
  9. **View All Transactions**: Navigate to `/transactions` from sidebar
  10. **View Cards**: Navigate to `/cards` from sidebar
  11. **View Card**: Click Maria's Visa ****4521
  12. **Verify Security**: Confirm no full PAN visible
  13. **Return Home**: Use navigation

- **Expected Result**:
  - ✅ All pages load real data
  - ✅ Navigation flows smoothly
  - ✅ No 404 errors
  - ✅ No console errors
  - ✅ Consistent UX across all pages

---

### Flow 45: API Integration Verification 🆕

- **Goal**: Verify UI is correctly calling the API endpoints.
- **Pre-requisite**: Browser DevTools open (Network tab).
- **Steps**:
  1. Navigate to `/accounts`
  2. **Network Tab**: Verify `GET http://localhost:4000/v1/accounts` called
  3. **Response**: 200 OK, JSON with 7 accounts
  4. Navigate to `/transactions`
  5. **Network Tab**: Verify `GET http://localhost:4000/v1/transfers` called
  6. **Response**: 200 OK, JSON with 5 transfers
  7. Navigate to `/cards`
  8. **Network Tab**: Verify `GET http://localhost:4000/v1/payment-methods?type=card` called
  9. **Response**: 200 OK, JSON with 4 payment methods
  10. Navigate to `/accounts/{id}`
  11. **Network Tab**: Verify `GET http://localhost:4000/v1/accounts/{id}` called
  12. Check all requests include:
      - `Authorization: Bearer {token}` header
      - Proper tenant isolation (only data for current tenant)

- **Expected Result**:
  - ✅ All API calls use correct endpoints
  - ✅ Auth headers present
  - ✅ Responses contain real data (not mock)
  - ✅ No 404 or 500 errors
  - ✅ Tenant isolation working

---

## 🆕 EPIC 9: DEMO POLISH FEATURES (Stories 9.1-9.5)

### Flow 46: Reports Page - Generate & Download Reports (Story 9.1) 🆕

**Route:** `/reports`

**Goal:** Verify reports can be generated, downloaded, and deleted using real API data.

**Steps:**
1. Navigate to `/reports`
2. **Verify Page Elements**:
   - ✅ Header: "Reports" with "Generate Report" button
   - ✅ Report Types Grid: 5 cards (Transactions, Streams, Accounts, Agents, Financial Summary)
   - ✅ Recent Reports section (may be empty on first visit)

3. **Test Report Type Cards**:
   - Click on "Transaction History" card
   - **Expected**: Generate modal opens with "transactions" pre-selected

4. **Generate a Report**:
   - Click "Generate Report" button in header
   - **Modal appears** with:
     - Report Type dropdown (5 options)
     - Date Range inputs (start date, end date)
     - Format buttons (CSV, JSON, PDF)
   - Select "Transaction History"
   - Set date range: Last 30 days (default is already set)
   - Select format: CSV
   - Click "Generate" button
   - **Expected**:
     - Button shows "Generating..." with spinner
     - Modal closes on success
     - New report appears in "Recent Reports" section
     - Report shows: name, type, format, row count, date range, status "ready"

5. **Test Download**:
   - Find the newly generated report
   - Click "Download" button
   - **Expected**: 
     - CSV file downloads
     - File contains transaction data (check file content)
     - Network tab shows: `GET /v1/reports/{id}/download`

6. **Test Multiple Reports**:
   - Generate "Accounts Report" (JSON format)
   - Generate "Streams Report" (CSV format)
   - **Verify**:
     - All 3 reports visible in list
     - Each shows correct type, format, row count
     - Download buttons work for all

7. **Test Delete**:
   - Click trash icon on one report
   - **Expected**: Report removed from list
   - Network tab shows: `DELETE /v1/reports/{id}`

8. **Test Loading State**:
   - Refresh page
   - **Expected**: Spinner shows while fetching reports

9. **Test Empty State** (if no reports exist):
   - Delete all reports
   - **Expected**: Empty state with icon, message, "Generate Report" CTA

10. **Test Error Handling**:
    - Stop API server
    - Try to generate report
    - **Expected**: Red error box shows with message
    - Restart API server
    - **Verify**: Can generate reports again

**API Endpoints Verified:**
- `GET /v1/reports` - List reports
- `POST /v1/reports` - Generate report
- `GET /v1/reports/:id/download` - Download report
- `DELETE /v1/reports/:id` - Delete report

**Expected Results:**
- ✅ Report generation works for all 5 types
- ✅ All 3 formats (CSV, JSON, PDF) download successfully
- ✅ Reports show correct metadata (row count, date range)
- ✅ Delete functionality works
- ✅ Loading/error/empty states display correctly
- ✅ No console errors

---

### Flow 47: Streams Page - Real Data Verification (Story 9.2) 🆕

**Route:** `/streams`

**Goal:** Verify streams page displays real data and all features work correctly.

**Steps:**
1. Navigate to `/streams`
2. **Verify Page Elements**:
   - ✅ Header: "Money Streams" with "Create Stream" button
   - ✅ Stats Row: 4 cards (Total Streams, Monthly Outflow, Total Funded, Total Streamed)
   - ✅ Search bar and filter buttons (Status, Health)
   - ✅ Streams table with columns: Stream, Flow Rate, Balance, Health, Status, Category

3. **Verify Stats Cards**:
   - **Total Streams**: Shows count (e.g., "2")
   - **Monthly Outflow**: Dollar amount (sum of all active stream flow rates)
   - **Total Funded**: Total amount funded across all streams
   - **Total Streamed**: Lifetime total streamed amount
   - **Check Math**: Verify totals match data in table

4. **Test Search**:
   - Type in search box (e.g., "Maria")
   - **Expected**: Table filters to matching streams
   - Clear search
   - **Expected**: All streams show again

5. **Test Status Filter**:
   - Click "Active" button
   - **Expected**: Only active streams shown
   - Click "Paused" button
   - **Expected**: Only paused streams shown (may be empty)
   - Click "All Status"
   - **Expected**: All streams show

6. **Test Health Filter**:
   - Click "Healthy" button
   - **Expected**: Only healthy streams shown (green badge)
   - Click "Warning" button
   - **Expected**: Only warning streams shown (amber badge)
   - Click "Critical" button
   - **Expected**: Only critical streams shown (red badge)
   - Click "All Health"
   - **Expected**: All streams show

7. **Verify Stream Table Rows**:
   - Each row should show:
     - **Stream**: Sender → Receiver names
     - **Flow Rate**: Per month + per day calculation
     - **Balance**: Remaining balance + progress bar
     - **Health Badge**: Colored icon (healthy/warning/critical)
     - **Status Badge**: Colored icon (active/paused/cancelled)
     - **Category**: Stream category (e.g., "Payroll", "Subscription")
   - **Progress Bar**: Visual indicator showing % streamed (purple bar)

8. **Test Row Click** (if detail page exists):
   - Click on a stream row
   - **Expected**: Navigates to `/streams/{id}` (detail page may not exist yet)
   - If 404, that's okay - Story 9.2 only covers list page

9. **Test Loading State**:
   - Refresh page
   - **Expected**: Spinner shows while fetching streams

10. **Test Empty State**:
    - Apply filters that return no results (e.g., status="cancelled")
    - **Expected**: 
      - Empty state with icon
      - Message: "No streams match your filters"
      - Subtext: "Try adjusting your search or filters"

11. **Test Error Handling**:
    - Stop API server
    - Refresh page
    - **Expected**: Red error box with "Failed to load streams" + retry button
    - Click "Try again"
    - Restart API server
    - **Expected**: Streams load successfully

**API Endpoints Verified:**
- `GET /v1/streams` - List streams with filters

**Expected Results:**
- ✅ Real stream data displays (not mock)
- ✅ Stats calculations are correct
- ✅ Search and filters work correctly
- ✅ Health badges show correct colors
- ✅ Balance progress bars are accurate
- ✅ Loading/error/empty states work
- ✅ No console errors

---

### Flow 48: Empty States - Consistency Check (Story 9.3) 🆕

**Goal:** Verify all list pages have proper empty states when no data exists.

**Test Matrix:**

| Page | Route | Empty State Test |
|------|-------|------------------|
| **Accounts** | `/accounts` | Delete all accounts → "No accounts yet" with "Create Account" button |
| **Transactions** | `/transactions` | Apply filter with no results → "No transactions match your filters" |
| **Cards** | `/cards` | Delete all cards → "No payment methods yet" with "Add Payment Method" button |
| **Agents** | `/agents` | Apply filter with no results → "No agents match your filters" |
| **Streams** | `/streams` | Apply filter with no results → "No streams match your filters" |
| **Reports** | `/reports` | Delete all reports → "No reports generated yet" with "Generate Report" button |
| **Compliance** | `/compliance` | If no flags → "No compliance flags" |
| **Disputes** | `/disputes` | If no disputes → "No disputes" |

**Steps for Each Page:**
1. Navigate to page
2. Trigger empty state (delete data OR apply filter with no results)
3. **Verify Empty State Contains**:
   - ✅ Icon/Emoji (large, centered)
   - ✅ Title (bold, descriptive)
   - ✅ Description (helpful subtext)
   - ✅ CTA Button (optional, for create actions)
4. Click CTA button (if present)
5. **Expected**: Opens create modal OR navigates to create page

**Expected Results:**
- ✅ All list pages have empty states
- ✅ Consistent design (icon + title + description)
- ✅ Helpful messaging (not just "No data")
- ✅ Different messages for "no data" vs "no results" (filters)
- ✅ Dark mode support (text remains readable)

---

### Flow 49: Loading Skeletons - Visual Consistency (Story 9.4) 🆕

**Goal:** Verify loading skeletons appear and match actual component layouts.

**Test Matrix:**

| Component | Where to Test | Skeleton Type |
|-----------|---------------|---------------|
| **Table Skeleton** | Any list page (accounts, transactions, agents) | Multiple rows with pulsing gray bars |
| **Card Skeleton** | Dashboard stats, agent cards | Rectangle with pulsing sections |
| **Detail Skeleton** | Account/transaction detail pages | Two-column layout with pulsing bars |
| **List Page Skeleton** | Streams, reports, cards | Stats + table skeleton |

**Steps:**
1. **Test Table Skeleton**:
   - Navigate to `/accounts`
   - **Observe**: Before data loads, skeleton rows appear
   - **Verify**:
     - ✅ Pulsing animation (gray bars fade in/out)
     - ✅ 5-10 skeleton rows
     - ✅ Columns match actual table columns
     - ✅ Smooth transition from skeleton → real data

2. **Test Card Skeleton**:
   - Navigate to `/agents`
   - **Observe**: Stats cards show skeleton before data loads
   - **Verify**:
     - ✅ 4 card skeletons in grid
     - ✅ Pulsing animation
     - ✅ Layout matches actual stat cards
     - ✅ Dark mode: Gray bars visible on dark background

3. **Test Detail Page Skeleton**:
   - Navigate to `/accounts/{id}`
   - **Observe**: Detail page skeleton appears
   - **Verify**:
     - ✅ Two-column layout
     - ✅ Multiple pulsing sections
     - ✅ Matches actual detail page structure

4. **Test List Page Skeleton**:
   - Navigate to `/streams`
   - **Observe**: Full page skeleton (stats + table)
   - **Verify**:
     - ✅ Stats row skeleton (4 cards)
     - ✅ Search bar skeleton
     - ✅ Filter buttons skeleton
     - ✅ Table skeleton (header + rows)

5. **Test Slow Network**:
   - Open DevTools → Network tab
   - Throttle to "Slow 3G"
   - Navigate to any list page
   - **Verify**:
     - ✅ Skeleton shows immediately (no blank white page)
     - ✅ Skeleton visible for 2-3 seconds
     - ✅ Smooth transition to real content

6. **Test Dark Mode**:
   - Toggle dark mode (if available)
   - Navigate to any page
   - **Verify**:
     - ✅ Skeletons use `bg-gray-700` (visible on dark background)
     - ✅ Animation still visible
     - ✅ Contrast is sufficient

**Expected Results:**
- ✅ Skeletons appear on all loading states
- ✅ Pulsing animation works smoothly
- ✅ Layouts match actual components
- ✅ No "flash of unstyled content" (FOUC)
- ✅ Dark mode skeletons are visible
- ✅ Skeletons disappear when data loads

---

### Flow 50: Error States - Comprehensive Error Handling (Story 9.5) 🆕

**Goal:** Verify error states are consistent and retry functionality works.

**Test Scenarios:**

#### **Scenario 1: Network Error**
1. Stop API server (`pkill -f "pnpm dev"` in api directory)
2. Navigate to `/accounts`
3. **Expected**:
   - ✅ Red error box appears
   - ✅ Icon: AlertCircle (red)
   - ✅ Title: "Failed to load accounts" (or similar)
   - ✅ Message: Describes error (e.g., "Network request failed")
   - ✅ Retry button with icon
4. Click "Try again" button
5. **Expected**: Attempts to refetch (will fail again since server is down)
6. Restart API server
7. Click "Try again" button
8. **Expected**: Data loads successfully

#### **Scenario 2: API Error (500 Internal Server Error)**
1. Modify API to return 500 error (temporarily)
2. Navigate to `/transactions`
3. **Expected**:
   - ✅ Red error box appears
   - ✅ Error message from API shown (if available)
   - ✅ Retry button present
4. Fix API
5. Click "Try again"
6. **Expected**: Data loads successfully

#### **Scenario 3: Not Found Error (404)**
1. Navigate to `/accounts/invalid-uuid-12345`
2. **Expected**:
   - ✅ Centered empty state OR error message
   - ✅ Icon: 🔍 (magnifying glass)
   - ✅ Title: "Account not found"
   - ✅ Message: "The account you're looking for doesn't exist..."
   - ✅ "Go back" button
3. Click "Go back"
4. **Expected**: Navigates to `/accounts`

#### **Scenario 4: React Error Boundary**
1. **Trigger**: Force a JavaScript error (e.g., access undefined property)
2. **Expected**:
   - ✅ ErrorBoundary catches error
   - ✅ Fallback UI shows:
     - Red box with AlertCircle icon
     - "Something went wrong" heading
     - Error message displayed
     - "Try again" button
3. Click "Try again"
4. **Expected**: Component resets and attempts to render again

#### **Scenario 5: Validation Error**
1. Try to create a report with invalid date range (end before start)
2. **Expected**:
   - ✅ Validation error appears below field OR in modal
   - ✅ Red text with error message
   - ✅ Form submission blocked

#### **Scenario 6: Toast Notifications** (if implemented)
1. Successfully create/update/delete an item
2. **Expected**:
   - ✅ Success toast appears (green)
   - ✅ Message describes action (e.g., "Report generated successfully")
   - ✅ Toast auto-dismisses after 3-5 seconds

**Error State Components to Verify:**
- ✅ `ErrorDisplay` - Generic error with retry
- ✅ `NetworkErrorDisplay` - Connection-specific error
- ✅ `NotFoundError` - 404 errors
- ✅ `ErrorBoundary` - Catches React errors

**Expected Results:**
- ✅ All errors show user-friendly messages (not technical jargon)
- ✅ Retry buttons work correctly
- ✅ Error messages are specific (not just "Error occurred")
- ✅ Network errors distinguished from API errors
- ✅ 404 errors show different UI than 500 errors
- ✅ ErrorBoundary prevents entire app crash
- ✅ Dark mode: Error boxes remain readable

---

### Flow 51: End-to-End Demo Polish Flow 🆕

**Goal:** Comprehensive test combining all Epic 9 features.

**Steps:**
1. **Start Fresh**:
   - Clear browser cache
   - Restart API server
   - Navigate to `/`

2. **Test Reports Workflow**:
   - Go to `/reports`
   - Generate "Transaction History" report (CSV)
   - **Verify**: Loading skeleton → Report appears
   - Download report
   - **Verify**: CSV file downloads with data
   - Delete report
   - **Verify**: Empty state shows (if no other reports)

3. **Test Streams Workflow**:
   - Go to `/streams`
   - **Verify**: Loading skeleton → Stats + Table appear
   - Apply health filter: "Critical"
   - **Verify**: Empty state OR filtered results
   - Reset filter to "All Health"
   - Search for a stream
   - **Verify**: Results filter correctly

4. **Test Error Recovery**:
   - Stop API server
   - Navigate to `/accounts`
   - **Verify**: Error state shows
   - Click "Try again" (will fail)
   - Restart API server
   - Click "Try again"
   - **Verify**: Data loads successfully

5. **Test Loading Performance**:
   - Open DevTools → Network tab
   - Navigate between pages rapidly:
     - `/accounts` → `/transactions` → `/cards` → `/agents` → `/streams` → `/reports`
   - **Verify**:
     - ✅ Skeletons show immediately (no blank screens)
     - ✅ No duplicate API calls
     - ✅ Smooth transitions
     - ✅ No console errors

6. **Test Dark Mode** (if implemented):
   - Toggle dark mode
   - Visit each page
   - **Verify**:
     - ✅ Skeletons visible
     - ✅ Error states readable
     - ✅ Empty states contrast sufficient

**Expected Results:**
- ✅ All Epic 9 features working together seamlessly
- ✅ No conflicts between components
- ✅ Consistent UX across all pages
- ✅ Performance is smooth (< 2s load times)
- ✅ Error handling is robust
- ✅ No console errors or warnings

---

## 🔒 Epic 15: Row-Level Security (RLS) Testing

### Overview

**Purpose:** Verify that tenant data isolation is working correctly at the application level. While RLS is enforced at the database level, we need to verify that the UI and API correctly respect tenant boundaries.

**What We're Testing:**
- ✅ Users can only see their own tenant's data
- ✅ Cross-tenant access is blocked
- ✅ Error handling for unauthorized access
- ✅ API correctly filters by tenant

**What We CANNOT Test (Database-Level):**
- ❌ Direct database RLS policies
- ❌ Service role bypass scenarios
- ❌ JWT claim manipulation

---

### Test Flow 20: Multi-Tenant Data Isolation

**Priority:** P0 (Critical Security)

**Prerequisites:**
- Two test users with different tenant IDs
- Both users have test data (accounts, transactions, etc.)

**Steps:**

1. **Setup Test Users:**
   - Note: You may need to create test users manually or use existing seed data
   - User A: Should belong to Tenant A (e.g., "Acme Corporation")
   - User B: Should belong to Tenant B (e.g., "TechCorp Inc")

2. **Test Account Isolation:**
   - Log in as User A
   - Navigate to `/accounts`
   - Note the account names and IDs visible
   - Log out
   - Log in as User B
   - Navigate to `/accounts`
   - **Verify:**
     - ✅ Different accounts are shown
     - ✅ No accounts from User A's tenant are visible
     - ✅ Account count may be different

3. **Test Transaction Isolation:**
   - As User A: Navigate to `/transactions`
   - Note transaction IDs and amounts
   - Log out
   - As User B: Navigate to `/transactions`
   - **Verify:**
     - ✅ Different transactions are shown
     - ✅ No transactions from User A's tenant are visible

4. **Test Payment Methods Isolation:**
   - As User A: Navigate to an account detail page → Payment Methods tab
   - Note payment method IDs
   - Log out
   - As User B: Navigate to an account detail page → Payment Methods tab
   - **Verify:**
     - ✅ Different payment methods are shown
     - ✅ Cannot access User A's payment methods

5. **Test Direct ID Access (Cross-Tenant):**
   - As User A: Get an account ID from the accounts list
   - Copy the account ID from the URL (e.g., `/accounts/{id}`)
   - Log out
   - Log in as User B
   - Try to access User A's account directly: Navigate to `/accounts/{user-a-account-id}`
   - **Verify:**
     - ✅ Returns 404 or "Account not found"
     - ✅ OR shows error message
     - ✅ Does NOT show User A's account data

6. **Test Disputes Isolation:**
   - As User A: Navigate to `/disputes`
   - Note dispute IDs
   - Log out
   - As User B: Navigate to `/disputes`
   - **Verify:**
     - ✅ Different disputes are shown
     - ✅ Cannot access User A's disputes

7. **Test Compliance Flags Isolation:**
   - As User A: Navigate to `/compliance`
   - Note flag IDs
   - Log out
   - As User B: Navigate to `/compliance`
   - **Verify:**
     - ✅ Different compliance flags are shown
     - ✅ Cannot access User A's flags

8. **Test Agents Isolation:**
   - As User A: Navigate to `/agents`
   - Note agent IDs
   - Log out
   - As User B: Navigate to `/agents`
   - **Verify:**
     - ✅ Different agents are shown
     - ✅ Cannot access User A's agents

**Expected Results:**
- ✅ Complete data isolation between tenants
- ✅ No cross-tenant data leakage
- ✅ Proper error handling for unauthorized access
- ✅ All list views show only tenant's own data

**If Issues Found:**
- Report immediately as **P0 security issue**
- Include:
  - Which data was leaked
  - Steps to reproduce
  - Screenshots showing cross-tenant data

---

### Test Flow 21: API-Level Tenant Isolation

**Priority:** P0 (Critical Security)

**Prerequisites:**
- Two API keys from different tenants (if available)
- OR use browser DevTools to inspect API calls

**Steps:**

1. **Monitor API Calls:**
   - Open DevTools → Network tab
   - Filter by "Fetch/XHR"

2. **Test Accounts API:**
   - As User A: Navigate to `/accounts`
   - In Network tab, find the API call to `/v1/accounts`
   - Check the response - note account IDs
   - Log out
   - As User B: Navigate to `/accounts`
   - Check the API response
   - **Verify:**
     - ✅ Different account IDs in responses
     - ✅ No overlap between responses

3. **Test Transactions API:**
   - As User A: Navigate to `/transactions`
   - Check API response for `/v1/transfers` or similar
   - Log out
   - As User B: Navigate to `/transactions`
   - Check API response
   - **Verify:**
     - ✅ Different transaction IDs
     - ✅ No cross-tenant transactions

4. **Test Direct API Access:**
   - As User A: Get an account ID from the UI
   - In DevTools Console, try:
     ```javascript
     fetch('/v1/accounts/{user-a-account-id}', {
       headers: { 'Authorization': 'Bearer {user-b-token}' }
     })
     ```
   - **Verify:**
     - ✅ Returns 404 or 403 error
     - ✅ Does NOT return account data

**Expected Results:**
- ✅ API responses are tenant-scoped
- ✅ Direct ID access is blocked
- ✅ Proper HTTP error codes (404/403) for unauthorized access

---

### Test Flow 22: Error Handling for Unauthorized Access

**Priority:** P1

**Steps:**

1. **Test 404 Handling:**
   - Log in as User A
   - Try to access a non-existent account: `/accounts/00000000-0000-0000-0000-000000000000`
   - **Verify:**
     - ✅ Shows "Account not found" or similar message
     - ✅ Does NOT show error stack trace
     - ✅ User can navigate back

2. **Test Cross-Tenant Access:**
   - Log in as User A
   - Get a valid account ID from User A's tenant
   - Log out
   - Log in as User B
   - Try to access User A's account ID
   - **Verify:**
     - ✅ Shows "Account not found" or "Access denied"
     - ✅ Does NOT reveal that account exists
     - ✅ Generic error message (no information leakage)

3. **Test Invalid IDs:**
   - Try accessing with malformed UUIDs
   - Try accessing with random strings
   - **Verify:**
     - ✅ Proper validation error
     - ✅ No crashes or stack traces

**Expected Results:**
- ✅ Generic error messages (no information leakage)
- ✅ No stack traces exposed to users
- ✅ Graceful error handling
- ✅ Users can recover from errors

---

### RLS Testing Checklist

After completing RLS test flows, verify:

**Data Isolation ✅**
- [ ] User A cannot see User B's accounts
- [ ] User A cannot see User B's transactions
- [ ] User A cannot see User B's payment methods
- [ ] User A cannot see User B's disputes
- [ ] User A cannot see User B's compliance flags
- [ ] User A cannot see User B's agents

**Access Control ✅**
- [ ] Direct ID access blocked (404/403)
- [ ] API responses are tenant-scoped
- [ ] No cross-tenant data in API responses

**Error Handling ✅**
- [ ] Generic error messages (no info leakage)
- [ ] No stack traces exposed
- [ ] Users can recover from errors

**Security ✅**
- [ ] No tenant ID in URLs or client-side code
- [ ] JWT tokens properly scoped
- [ ] API keys properly isolated

---

## 📝 Testing Summary Checklist

After completing all priority flows, verify:

### Core Functionality ✅
- [ ] Accounts page displays 7 real accounts
- [ ] Account detail pages load correctly
- [ ] Transactions page displays 5 real transfers
- [ ] Transaction detail pages show complete info
- [ ] Cards page displays 4 real payment methods
- [ ] Card detail pages load correctly

### UI States ✅
- [ ] Loading states appear and disappear correctly
- [ ] Error states show with retry buttons
- [ ] Empty states have clear messaging
- [ ] Success states display real data

### Security ✅
- [ ] Cards: Only last 4 digits visible (no full PAN)
- [ ] Cards: No CVV exposed
- [ ] Auth: All API calls include Authorization header
- [ ] Tenant: Data isolation working (only tenant's data shown)

### Navigation ✅
- [ ] All detail pages accessible from list views
- [ ] Breadcrumbs work correctly
- [ ] Back buttons functional
- [ ] No 404 errors on valid routes

### Performance ✅
- [ ] Pages load within 2 seconds
- [ ] No unnecessary API calls (check Network tab)
- [ ] Smooth transitions between pages

### Epic 9: Demo Polish Features ✅
- [ ] **Reports (9.1)**: Generate, download, delete reports work
- [ ] **Streams (9.2)**: Page displays real data with filters and stats
- [ ] **Empty States (9.3)**: All list pages have consistent empty states
- [ ] **Loading Skeletons (9.4)**: Skeletons appear and match layouts
- [ ] **Error States (9.5)**: Errors show with retry, boundary catches crashes

---

*End of Testing Guide*

