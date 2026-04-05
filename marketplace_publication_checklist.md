# Atlassian Marketplace Publication Checklist

This checklist outlines the steps required to publish your Forge app, **`Refinely`**, to the Atlassian Marketplace.

## 1. Technical & Manifest Requirements (Project Specific)
Ensure your `manifest.yml` is production-ready.

- [ ] **Licensing**: If you plan to charge for your app, add the following to your `manifest.yml`:
  ```yaml
  app:
    licensing:
      enabled: true
  ```
- [ ] **Production Scopes**: Review your scopes (`read:jira-work`, `write:jira-work`, `read:jira-user`, `storage:app`). Ensure you only have the minimum required scopes.
- [ ] **External Fetch URLs**: Your current addresses are `https://api.anthropic.com`, `https://generativelanguage.googleapis.com`, and `https://api.openai.com`. Ensure these are correct and note them for the Marketplace submission (you'll need to explain why they are used).
- [ ] **Egress Check**: Ensure any external data transfer complies with Atlassian's data privacy policies.

## 2. Preparing Documentation & Legal
You will need these links/files for the submission form:

- [ ] **Privacy Policy**: Publish a public link explaining how you handle user data (especially important since you use external LLM providers).
- [ ] **Terms of Service**: Publish your end-user license agreement (EULA) at a public URL.
- [ ] **Support Link**: A way for customers to contact you for help (e.g., a Jira Service Management portal or an email address).
- [ ] **Setup Documentation**: Publish documentation that explains installation, configuration, and expected permissions.
- [ ] **Data Security & Privacy (DSP)**: You must complete the DSP questionnaire during the submission process.
- [ ] **Website Alignment Check**: Ensure the public site matches the app’s actual launch state for branding, provider support, pricing/tiering, legal owner, support contact, and admin setup instructions.
- [ ] **Legacy Brand Removal**: Remove remaining `Smartif.ai` references from the public site, metadata, footer, privacy, and terms pages.
- [ ] **Provider Disclosure Alignment**: Ensure public pages only describe provider options and egress paths that match the current Marketplace launch posture and Forge manifest.
- [ ] **Tiering Alignment**: Remove or clearly mark roadmap-only `Advanced` / `Enterprise` packaging from the public site unless those tiers are actually available for sale at launch.
- [ ] **Admin Docs Alignment**: Ensure setup documentation reflects the current support email and does not require enterprise/compliance-pack flows for baseline launch setup.

## 3. Marketing Assets
Visual consistency is key for Marketplace approval.

- [ ] **App Icon**: 144x144px PNG (or larger).
- [ ] **Screenshots**: At least 3 high-quality screenshots (1280x800px recommended).
- [ ] **App Description**:
    - **Summary**: A short 1-line catchphrase.
    - **Product Overview**: Detailed explanation of features and benefits.
- [ ] **Vendor Profile**: Ensure your Marketplace Vendor account is fully set up with a logo and description.
- [ ] **Launch Messaging Consistency**: Make sure Marketplace copy does not promise roadmap-only plans or enterprise packs that are not actually available at launch.
- [ ] **Trust Claim Review**: Review all public trust/security badges and claims so they stay within what can be accurately supported during Marketplace review.

## 4. Deployment & Distribution
- [ ] **Deploy to Production**: Use the production environment for the final Marketplace version.
  ```bash
  forge deploy -e production
  forge install -e production
  ```
- [ ] **Distribution Settings**: 
    1. Go to the [Developer Console](https://developer.atlassian.com/console/myapps/).
    2. Select your app -> **Distribution**.
    3. Change the distribution status to **Sharing**.
    4. Note the **Marketplace listing link** generated.

## 5. Submission Steps
1. [ ] Log in to the [Atlassian Marketplace](https://marketplace.atlassian.com/).
2. [ ] Click **Manage Vendor** -> **Create new app**.
3. [ ] Provide the **App ID** (ari:cloud:ecosystem::app/c2222793-707f-4f79-b0ca-66356a03ba2f) from your manifest.
4. [ ] Fill out the listing details (Screenshots, Descriptions, Categories).
5. [ ] Submit for Approval.

> [!IMPORTANT]
> **Approval Time**: Atlassian typically takes 5–10 business days to review your app. They may reach out with feedback or required changes via an ECOHELP ticket.

> [!TIP]
> **Beta Testing**: You can share a direct install link with early users *before* the Marketplace listing is public by using the "Sharing" mode in the Developer Console.
