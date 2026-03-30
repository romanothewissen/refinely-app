# Licensing Strategy: Refinely Tiers & Build Plan

To maximize Marketplace revenue while providing value to all team sizes, we will implement three distinct tiers.

---

## 1. Proposed License Tiers

| Feature | **Free** (Trial/Small Team) | **Standard** (Growth) | **Premium** (Enterprise) |
| :--- | :--- | :--- | :--- |
| **Target Audience** | Individual devs / Startups | Scaling teams (10–50 users) | Large organizations |
| **Monthly Generations** | 5 | 250 | Unlimited |
| **Gold Standard Sources** | 1 Project context | 5 Project contexts | Unlimited |
| **Work Instructions** | 2 Reference PDFs | 15 Reference PDFs | Unlimited |
| **Available Models** | Flash-based (Fast/Small) | All standard (Pro/Mini) | High-end models (GPT-4o/Claude) |
| **Custom Branding** | No | No | Yes (Logo & Theme) |
| **Process Taxonomy** | No | No | Yes (ISO/Custom) |
| **Marketplace Pricing** | Free App | $5 / user / month | $12 / user / month |

---

## 2. Build Plan: Functional Implementation

### Phase 1: Backend Alignment [DONE]
- **License-to-Tier Mapping**: Update `src/services/billing.ts` to automatically assign the `Standard` or `Premium` tier based on the Marketplace license type (`COMMERCIAL` vs `TRIAL`).
- **Strict Enforcement**:
    - Update `checkGenerationAllowed` to reject requests if the Marketplace license is `None` or `Inactive`.
    - Block "Enterprise-only" fields (Branding, Taxonomy) if the license isn't `COMMERCIAL`.

### Phase 2: UI Updates (Settings & Billing) [DONE]
- **New Billing Tab**: Add a `Pricing & Usage` tab in `SettingsView.tsx`.
- **Usage Progress Bar**: Visualize monthly generation consumption (e.g., "12 / 100 used").
- **Upgrade Prompts**: 
    - Display "Standard" feature badges on locked UI elements (e.g., similar story toggle).
    - Add context-aware "Upgrade to Pro" buttons when limits are reached.

### Phase 3: Marketplace Packaging
- **Pricing Profiles**: Configure the Atlassian Marketplace listing with "Per User" pricing.
- **Trial Setup**: Enable a 30-day Free Trial for the Standard tier.

---

## 3. Immediate Next Steps
1. [x] **Update `types.ts`**: Rename tiers and adjust limit numbers to match the proposal.
2. [x] **Enhance `SettingsView.tsx`**: Add the usage visualization.
3. [ ] **Deploy to Production Environment**: Use `forge deploy -e production` to test the licensing bridge.

> [!NOTE]
> **Data Residency**: All usage data is stored in Forge Storage within the customer's region, maintaining compliance with the "Standard" and "Premium" tier requirements for Enterprise customers.
