# Sly Scanner — Design Partner Agreement

This is a one-page, good-faith agreement between **Sly** and **{{PARTNER_NAME}}** ("Partner") for participation in the Sly Scanner design-partner program.

## 1. What Partner gets

- **2,500 Sly Scanner credits**, granted on the Effective Date. Credits do not expire while Partner holds design-partner status.
- **Scale-tier pricing** (US$0.020 per credit) locked in for **12 months** after the initial 2,500 credits are exhausted, regardless of published list price changes.
- **First right of refusal** on new scanner features, including access during private betas before public launch.
- **Direct line to the product team**: named Slack channel or shared email thread for questions, bugs, and feature requests.

## 2. What Partner provides

- **Logo + one case study**: Sly may publish Partner's logo on the Sly site and use the case study in sales decks, blog posts, and conference talks. Partner reviews + approves the case study before publication. Partner may revoke logo usage on 30 days' notice.
- **30-min monthly feedback call** with Partner's product lead for the first 6 months.
- **One early-bird testimonial** (1–3 sentences) within 14 days of Partner's first production-scale scan run. Sly drafts; Partner approves.

## 3. Access

- Sly will issue a production scanner API key (`psk_live_...`) to a Partner-designated recipient via a secure channel (1Password shared vault or equivalent).
- The key is scoped to: `scan`, `batch`, `read`, `tests`. Rate-limited at 120 requests/minute per key.
- Partner agrees to rotate the key if it is ever exposed, committed to version control, or suspected of compromise. Sly will rotate on 24 hours' notice if a security event requires it.

## 4. Data use

- **Reads are shared corpus.** Partner may read any merchant scan produced by any tenant — this is the point. No Partner has exclusive access to scan data.
- **Writes are tenant-tagged.** Partner's scan/batch/test requests create rows tagged with Partner's Sly tenant ID, used only for billing + attribution. No cross-partner PII is exposed.
- Partner **may** use scanner output internally, in its own product, in sales materials, and in aggregated research. Partner **may not** resell raw scan data as a standalone data product.
- Sly **may** use aggregate usage statistics (counts, patterns) for product development and marketing. Sly **will not** publish Partner's individual queries or results without written consent.

## 5. Duration and renewal

- **Initial term: 6 months** from the Effective Date.
- **Auto-renews** for another 6 months if both parties are actively engaged (credits consumed in the prior 30 days + at least one monthly call attended).
- Either party may terminate on **30 days' written notice**.
- Upon termination, unused credits remain consumable for **90 days**; the 12-month Scale-pricing lock-in continues to apply to any top-up purchases during that window.

## 6. Confidentiality

- Roadmap details shared during monthly calls are confidential for 12 months.
- Sly will not disclose Partner's integration details or usage patterns publicly without consent.
- Nothing in this section applies to aggregated, anonymized statistics.

## 7. No warranties, limited liability

- Scanner is provided **as-is** during the beta. Sly makes no SLA commitments at the design-partner tier (SLAs available in enterprise agreements).
- Each party's total liability is capped at the total fees paid by Partner in the 12 months preceding the claim, or US$5,000, whichever is greater.

## 8. Governance

- Governed by the laws of the State of Delaware, USA.
- Any disputes resolved first by good-faith negotiation, then by mediation in San Francisco, CA.

---

## Signatures

**Sly**

- Name: _____________________________
- Title: _____________________________
- Date: _____________________________
- Signature: _________________________

**{{PARTNER_NAME}}**

- Name: _____________________________
- Title: _____________________________
- Date: _____________________________
- Signature: _________________________

---

*Template owner: `@founders-team`. Review and approve before first send. Last updated: 2026-04-23.*
