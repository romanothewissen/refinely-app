# Atlassian Marketplace Submission Packet

Last updated: April 6, 2026

This packet is meant to be copied into the Atlassian Marketplace submission flow for the Forge app **Refinely**.

## Core App Details

- App name: `Refinely`
- App ID: `ari:cloud:ecosystem::app/c2222793-707f-4f79-b0ca-66356a03ba2f`
- Hosting model: `Forge`
- Supported product: `Jira Cloud`
- Pricing model: `Paid via Atlassian`
- Support contact: `https://smartif.ai/support`
- Security policy: `https://smartif.ai/security`
- Privacy policy: `https://smartif.ai/privacy`
- Terms of service: `https://smartif.ai/terms`
- Setup documentation: `https://smartif.ai/docs/setup`

## Architecture Summary

- Forge-hosted Jira Cloud app with two entry points:
  - Jira global page
  - Jira issue action
- React Custom UI frontend hosted through Forge static resources
- Single resolver surface for UI actions and admin configuration
- Long-running workflows delegated to Forge queues for:
  - clarify
  - generation
  - refinement
  - admin-triggered backlog cache refresh
- Persistent state stored in Forge storage for:
  - tenant configuration
  - user/session history
  - work-instruction metadata
  - backlog cache/theme index
  - optional transparency and audit records
- Third-party AI provider API keys stored in Forge secret storage
- Similar-story retrieval gated by explicit user browse-permission checks before app-level Jira reads are used
- AI execution supports the currently declared external providers:
  - Anthropic
  - Google Gemini
  - OpenAI

## Current Launch Positioning

Use this wording for Marketplace submission and launch materials:

- Refinely is launching as a Jira Cloud Forge app focused on backlog refinement and acceptance-requirement generation.
- The current launch packaging should be described around the app that exists today, not future roadmap packaging.
- Marketplace-facing copy should emphasize the current Standard launch offering and avoid presenting Advanced or Enterprise tiers as generally available unless they are actually configured for sale.
- Optional compliance-oriented features exist in the product surface, but Marketplace copy should describe them conservatively unless they are fully released and supported in launch operations.

## Likely Rejection Cause

If Atlassian says the listing has "not enough details", the weak point is usually the version-specific `More details` field rather than the short summary.

Use the listing to show all three of these clearly:

- what the app does inside Jira
- how an admin sets it up after install
- what an end user does on the first run

Operational note:

- In Marketplace, confirm you are editing the reviewable version created during submission. Atlassian review can happen against the Marketplace-generated release version, so do not rely only on the initial draft copy.

## Listing Copy

### Short Summary

Say goodbye to poorly defined tickets. Refinely uses deep context to turn your rough ideas into well-structured, ready-to-work Jira stories.

### Tagline Alternatives

1. No more vague tickets: Turn ideas into structured work.
2. In-context backlog refinement for high-performing teams.
3. Stop the "garbage in, garbage out" cycle with smart, grounded refinement.

### Full Overview

Use this when the Marketplace overview field needs to stay under 250 characters:

Say goodbye to vague tickets. Refinely actively grounds its work in your project's history to ask the right clarifying questions and draft well-structured features, saving your team hours of back-and-forth.

If you have more room available, expand with the details below:

Ever struggled to get a Jira ticket ready for development because vital context was missing or the ask was too vague? Refinely solves the "garbage in, garbage out" problem. It’s an intelligent backlog refinement tool that actively helps your team fully specify requirements before a single line of code is written.

Instead of generic AI text generation that lacks an understanding of your project, Refinely deeply integrates with your existing context. It asks the right clarifying questions up-front and drafts structured features with GIVEN / WHEN / THEN acceptance models that your engineers will actually love. It saves product managers and business analysts hours of guesswork, ensuring your team has exactly what it needs to deliver value.

### Marketplace `More details` Section

Use this as the paste-ready long-form version for the listing's `More details` field:

**Why your team needs Refinely**
We've all seen Jira boards filled with one-line descriptions or "one-pass AI rewrites" that simply regurgitate the prompt without adding any real substance. These tickets lead to endless clarification meetings, misaligned expectations, and slow delivery. Refinely fundamentally changes this workflow by acting as an in-context sidekick that actively grounds its work in your project's previously deployed stories and instructions.

**How it makes your life better**
Refinely helps users move from ambiguity to a perfectly structured draft:
- **No More Vague Tickets:** Refinely analyzes your initial ask and automatically highlights what's missing by asking targeted, domain-specific questions.
- **Deeply Grounded Context:** It learns from your previously deployed story cache and work instructions, so its output actually matches your team's unique way of working—not just a generic template.
- **Ready for Development:** Get perfectly structured features, functional descriptions, and precise GIVEN / WHEN / THEN acceptance criteria without the headache.
- **Bring Your Own Key (BYOK):** Keep full control over your AI costs and data by using your own Anthropic, Google Gemini, or OpenAI API keys securely.

**Admin Setup Summary**
1. Open `Refinely` in Jira and go to `Settings`.
2. Choose your preferred AI provider and securely enter your API key (BYOK).
3. Select your Jira project configuration.
4. Set up your custom work-instruction documents and context.
5. Save the configuration.

**How it works for your team**
1. Open the `Refinely` global page, or use the `Refine Stories` action on an existing Jira issue.
2. Enter your raw objective or requirement.
3. Answer targeted clarification questions to extract exactly what the development team needs.
4. Review the drafted features and acceptance requirements, grounded in your cached project history.
5. Push the polished output straight to your Jira backlog!

### Key Features

- **In-Context Story Generation:** Leverages your previously deployed stories and project instructions for grounded, highly relevant results.
- **Active Discovery:** Asks targeted clarification questions before generation to ensure nothing is missed.
- **Not Just "AI Slop":** Escapes the generic one-pass rewrite trap by drafting robust features and GIVEN/WHEN/THEN acceptance requirements.
- **Bring Your Own Key (BYOK):** Connect your own secure API keys for Anthropic, Google, or OpenAI to manage cost and control data.
- **Iterative Refinement:** Review word-level diffs and easily chat with your drafted stories before syncing them to Jira.
- **Start Anywhere:** Initiate refinement directly from a Jira global page or right on an existing issue.

### Ideal Customer / Use Cases

- Product managers and business analysts looking to produce higher quality, structured Jira tickets with less effort.
- Delivery teams tired of missing context and vague requirements.
- Teams seeking a secure, BYOK solution to inject intelligent, grounded refinement into their Agile workflow.

## Pricing and Tiering Guidance

Use this wording to keep Marketplace copy aligned with the currently shippable product:

- Describe the launch around the current Standard offering.
- If you mention the `free` behavior in the codebase, position it as fallback or trial behavior, not as a separately marketed production tier unless Marketplace pricing is configured that way.
- Do not describe Advanced or Enterprise as active customer tiers in Marketplace copy until they are implemented, priced, and operationally supported.
- Do not promise unlimited work instructions, compliance packs, dedicated SLA options, or enterprise-only packaging in the Marketplace listing unless those are truly available at launch.

## Permissions Justification

The current Forge manifest requests these scopes:

### `read:jira-work`

Used to read Jira issues, issue content, project context, and related metadata that serve as input for requirement refinement and story generation.

### `write:jira-work`

Used to create Jira issues and write generated output back into Jira when a user chooses to push generated work items into a project.

### `read:jira-user`

Used to resolve the signed-in user context and selected Jira user details, including reporter and assignee resolution for issue creation workflows.

### `storage:app`

Used to persist tenant configuration, usage counters, cached backlog/theme data, work-instruction metadata, conversation/session pointers, and optional transparency or audit records.

## Remote Hosts and Data Sent

The app currently declares these remote hosts in the Forge manifest:

### `https://api.anthropic.com`

Used when a workspace selects Anthropic as its active AI provider.

Data sent:

- Requirement text entered by the user
- Relevant Jira issue content selected for refinement
- Optional supporting text derived from attachments or guidance
- Optional masked prompt content when PII masking is enabled

### `https://generativelanguage.googleapis.com`

Used when a workspace selects Google Gemini as its active AI provider.

Data sent:

- Requirement text entered by the user
- Relevant Jira issue content selected for refinement
- Optional supporting text derived from attachments or guidance
- Optional masked prompt content when PII masking is enabled

### `https://api.openai.com`

Used when a workspace selects OpenAI as its active AI provider.

Data sent:

- Requirement text entered by the user
- Relevant Jira issue content selected for refinement
- Optional supporting text derived from attachments or guidance
- Optional masked prompt content when PII masking is enabled

### Reviewer Note

Only the content needed to fulfill a user-initiated refinement or generation request is sent to the configured provider. The app supports optional PII masking controls that can redact supported patterns before outbound model calls when enabled by the tenant.

## Usage Threshold Positioning

Use this wording if Marketplace review asks about usage controls:

- The Standard plan includes a monthly generation guidance threshold.
- Reaching that threshold triggers an in-app warning and support contact path.
- The current implementation does not hard-block generation at the threshold.
- This threshold is positioned as soft usage guidance rather than a strict hard cap.

## Site and Documentation Alignment Notes

Keep the public website and legal/documentation pages aligned to these launch facts:

- Brand name should be `Smartif.ai` across the app, site, and Marketplace materials.
- Supported AI providers in public launch copy should align with the app’s current launch posture and declared remote hosts.
- Admin setup docs should not present Azure, AWS, Enterprise presets, or enterprise-only packs as launch-critical requirements unless those paths are truly supported.
- Public pricing pages should not present Advanced and Enterprise as active launch tiers if Marketplace is launching with a simpler Standard-focused offer.
- Privacy and terms pages should match the current legal owner, support email, and provider disclosures used by the app and Marketplace packet.

### Current repo alignment status

- The site content in this repo should stay aligned to `Smartif.ai` branding, the current support email, and the current launch-provider posture.
- Pricing copy has been repositioned around the current Standard launch tier, 30-day Marketplace trial, and higher-threshold contact path for larger teams.
- Privacy, terms, security, and admin setup copy have been rewritten to avoid overstating residency, compliance packs, or roadmap-only packaging.
- Before submission, verify that the deployed public site at `smartif.ai` matches the repository version and that the live pages remain in sync with Marketplace answers.

## Documentation Links for Listing

Use these links in the Marketplace listing:

- Documentation: `https://smartif.ai/docs/setup`
- Security policy: `https://smartif.ai/security`
- Privacy policy: `https://smartif.ai/privacy`
- Terms of service: `https://smartif.ai/terms`
- Support: `https://smartif.ai/support`

## Suggested Installation / Setup Notes

You can use this in your listing documentation or installation instructions:

1. Install `Refinely` into Jira Cloud.
2. Open the `Refinely` global page in Jira and go to `Settings`.
3. Choose the workspace AI provider and enter the required API key.
4. Configure project mappings, field mappings, issue types, and optional issue-linking behavior.
5. Optionally configure backlog context, work-instruction references, and privacy controls.
6. Open `Refinely` for a new requirement or use `Refine Stories` from an existing Jira issue.
7. Enter a requirement, answer any clarification questions, and review the generated output.
8. Push approved stories back into Jira.

## Marketplace Reviewer Notes

Use this if Atlassian asks for extra explanation:

- The app is Jira Cloud only and uses Forge-hosted UI and backend functions.
- The core user value is AI-assisted requirement refinement and structured backlog generation inside Jira.
- The app can optionally cache backlog metadata and project guidance to improve relevance.
- Some trust-oriented controls are tenant-configurable, including PII masking, transparency reports, and audit-trail features.
- The listing's long-form `More details` section should include the install, admin setup, and first-use steps above so reviewers can confirm the app matches the described flow.

## Privacy & Security Tab Draft Answers

These are draft answers based on the current codebase. They should be reviewed once more in Marketplace before submission.

### 1. Does your app store End-User Data outside of Atlassian products and services?

Suggested answer: `No`

Rationale:

- The codebase stores tenant/application state in Forge storage.
- The app sends prompt content to configured third-party AI providers for processing, but the code does not intentionally persist End-User Data in an external vendor database controlled by this app.

### 2. Does your app process End-User Data outside of Atlassian products and services or outside of the end-user's browser?

Suggested answer: `Yes`

Suggested data types:

- Content posted, received, or shared in the app by end users
- Jira issue summaries, descriptions, comments, or related requirement text
- Atlassian account identifiers or display context when needed for app behavior

Rationale:

- The backend may send relevant Jira-derived prompt content to Anthropic, Google Gemini, or OpenAI depending on tenant configuration.

### 3. Does your app log End-User Data?

Suggested answer: `No`

Reviewer note:

- Based on code inspection, the app does not intentionally log End-User Data as an application feature.
- Before submission, confirm your operational logging practices match this answer.

### 4. Does your app process and/or store End-User Data in logs outside of Atlassian products and services?

Suggested answer: `No`

Reviewer note:

- This answer assumes no external log shipping of End-User Data.
- Confirm this against your real deployment and operational tooling.

### 5. Does your app share End-User Data with any third party entities?

Suggested answer: `Yes`

Suggested third parties:

- Anthropic
- Google
- OpenAI

Suggested explanation:

Refinely shares only the content necessary to fulfill a user-initiated AI refinement or generation request with the workspace's configured model provider.

### 6. Does your app support data residency?

Suggested answer: `Do not claim support unless you are prepared to document the exact in-scope data and the effect of external AI providers.`

Recommended submission posture:

- If you have not formally documented this with Atlassian’s required in-scope End-User Data detail, answer conservatively.

### 7. Does your app offer tenant-controlled security or privacy features?

Suggested answer: `Yes`

Suggested examples:

- Optional PII masking before model calls
- Optional transparency reports
- Optional audit trail features
- Project-scoped admin configuration

## Screenshot Guidance

Prepare these 8 core Marketplace screenshots for the listing:

1. **Jira Initiation** — Launching Refinely from a Jira issue sidebar.
2. **Context Ingestion** — Automatic reading of backlog and project context.
3. **AI Discovery** — Clarifying questions to surface requirements gaps.
4. **Sufficiency Check** — Verified grounding before backlog generation.
5. **Standardized Draft** — Generated Features and GIVEN/WHEN/THEN ARs.
6. **AI Refinement** — Bulk conversational editing across the canvas.
7. **Redline Review** — Word-level diff transparency before pushing.
8. **Jira Sync** — Final push confirmation and issue creation in Jira.

## Final Pre-Submission Checklist

- Confirm the public URLs are live:
  - `https://smartif.ai/security`
  - `https://smartif.ai/privacy`
  - `https://smartif.ai/terms`
  - `https://smartif.ai/docs/setup`
- Confirm support should remain `https://smartif.ai/support`
- Confirm production deployment is current
- Confirm Marketplace vendor profile is complete
- Upload screenshots and branding assets
- Complete the Privacy & Security tab using the reviewed answers above
- Be ready to explain each requested scope and each remote host
