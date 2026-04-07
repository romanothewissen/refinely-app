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

AI-powered Jira refinement for turning rough requirements into backlog-ready stories and GIVEN / WHEN / THEN acceptance requirements.

### Tagline Alternatives

1. Turn rough Jira requirements into structured backlog-ready stories.
2. Refine ideas into clearer Jira features and acceptance requirements.
3. Speed up backlog preparation with AI-assisted story refinement in Jira.

### Full Overview

Use this when the Marketplace overview field needs to stay under 250 characters:

Refinely turns rough Jira requirements into backlog-ready stories. Start from the global page or an issue action, answer clarifying questions when needed, generate acceptance requirements, and push approved work back to Jira.

If you have more room available, expand with the details below:

The app appears in two places inside Jira: a global page named `Refinely` for net-new refinement work and an issue action named `Refine Stories` for starting from an existing Jira issue. Users can enter a short requirement, optionally include supporting attachment text, choose workspace or project context, and let Refinely analyze the request.

When a requirement is ambiguous, Refinely can run a discovery step that asks focused follow-up questions before generating output. It then proposes structured feature candidates, descriptions, and GIVEN / WHEN / THEN acceptance requirements, and supports iterative refinement when a user wants to improve or adjust the result.

For teams that want more consistency, admins can configure project-specific mappings, backlog context, work-instruction guidance, AI provider settings, and optional trust controls such as PII masking, transparency reports, and audit trail features. Approved output can be pushed back into Jira as Story, Task, Bug, or Epic items.

### Marketplace `More details` Section

Use this as the paste-ready long-form version for the listing's `More details` field:

Refinely is a Jira Cloud app for teams that receive rough business requests and need to turn them into backlog-ready stories without leaving Jira. The app adds two entry points inside Jira: a global page called `Refinely` and an issue action called `Refine Stories`. Teams can start from a blank requirement in the global page or from an existing Jira issue when they want to refine work that is already in the backlog.

Refinely helps users move from ambiguity to a structured draft. A user enters a requirement, optionally includes attachment text or project context, and Refinely analyzes the request. If the request is still too ambiguous, the app asks targeted clarification questions first. After that, Refinely generates structured feature candidates with descriptions and GIVEN / WHEN / THEN acceptance requirements so the team has a stronger starting point for delivery planning.

After installation, a Jira admin should complete this setup:

1. Open `Refinely` in Jira and go to `Settings`.
2. Choose the AI provider for the workspace and enter the required API key.
3. Select the Jira project configuration to support and configure issue mappings, field mappings, and optional issue-linking behavior.
4. Optionally configure backlog context, work-instruction documents, and privacy controls such as PII masking, transparency reports, and audit trail settings.
5. Save the configuration.

Once setup is complete, an end user can use the app like this:

1. Open the `Refinely` global page for a new requirement, or open an existing Jira issue and choose `Refine Stories`.
2. Enter the requirement text and optionally add supporting attachment content or select project context.
3. Answer clarification questions if Refinely requests more detail.
4. Review the generated features, descriptions, and acceptance requirements.
5. Push approved output back into Jira as a Story, Task, Bug, or Epic.

Refinely is intended for product managers, business analysts, delivery leads, and software teams that want faster backlog preparation and more consistent acceptance requirements inside Jira.

### Key Features

- Start from a Jira global page or directly from the `Refine Stories` issue action on an existing issue
- Turn short requirement text into structured feature candidates and Jira-ready story drafts
- Draft GIVEN / WHEN / THEN acceptance requirements for each generated feature
- Ask targeted clarification questions before generation when the requirement is underspecified
- Refine generated output iteratively with additional guidance and revision comparison
- Push approved output back into Jira as Story, Task, Bug, or Epic items
- Configure project-specific mappings, backlog context, and work-instruction guidance
- Optionally enable PII masking, transparency reports, and audit trail features
- Show monthly usage guidance in-app with warning-based thresholding instead of a hard stop

### Ideal Customer / Use Cases

- Product teams preparing backlog items from rough intake
- Business analysts translating business requests into clearer Jira work
- Delivery teams standardizing story structure and acceptance requirements
- Jira teams that want faster requirement refinement without leaving Jira

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
