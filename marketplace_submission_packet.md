# Atlassian Marketplace Submission Packet

Last updated: April 5, 2026

This packet is meant to be copied into the Atlassian Marketplace submission flow for the Forge app **Refinely**.

## Core App Details

- App name: `Refinely`
- App ID: `ari:cloud:ecosystem::app/c2222793-707f-4f79-b0ca-66356a03ba2f`
- Hosting model: `Forge`
- Supported product: `Jira Cloud`
- Pricing model: `Paid via Atlassian`
- Support contact: `mailto:romano.thewissen@gmail.com`
- Privacy policy: `https://simplif.ai/privacy`
- Terms of service: `https://simplif.ai/terms`
- Setup documentation: `https://simplif.ai/docs/setup`

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
  - backlog cache refresh
- Persistent state stored in Forge storage for:
  - tenant configuration
  - user/session history
  - work-instruction metadata
  - backlog cache/theme index
  - optional transparency and audit records
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

## Listing Copy

### Short Summary

AI-powered Jira story refinement for turning rough requirements into backlog-ready features and acceptance requirements.

### Tagline Alternatives

1. Turn rough Jira requirements into structured backlog-ready stories.
2. Refine ideas into clearer Jira features and acceptance requirements.
3. Speed up backlog preparation with AI-assisted story refinement in Jira.

### Full Overview

Refinely helps Jira teams turn incomplete or rough requirements into clearer, backlog-ready work items without leaving Jira.

The app supports both a Jira global page and an issue action workflow, so teams can either work from a central refinement space or start directly from an existing Jira issue. Refinely generates structured feature candidates, drafts GIVEN / WHEN / THEN acceptance requirements, and supports iterative refinement when users want to clarify or improve the result.

For teams that want more consistency, Refinely also supports project-specific configuration, including project context, issue mapping, backlog-aware retrieval, and optional work-instruction guidance. Generated output can be pushed back into Jira as issues, helping teams move from ambiguous requirements to actionable backlog items faster.

### Key Features

- Generate Jira-ready feature candidates from short business requirements
- Draft structured GIVEN / WHEN / THEN acceptance requirements
- Start from a Jira issue action or from a dedicated Jira global page
- Refine generated output iteratively with additional guidance
- Create Jira issues directly from generated output
- Configure project-specific mappings, context, and backlog guidance
- Show included monthly usage guidance with in-app warning instead of a hard generation stop
- Optionally use backlog retrieval, work instructions, transparency reports, audit trail, and PII masking controls

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

### `manage:jira-configuration`

Used to inspect Jira configuration metadata needed for admin setup and mapping, including project permissions checks, fields, statuses, issue types, and project-specific creation configuration.

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

- Brand name should be `Simplif.ai`, not legacy `Smartif.ai`.
- Supported AI providers in public launch copy should align with the app’s current launch posture and declared remote hosts.
- Admin setup docs should not present Azure, AWS, Enterprise presets, or enterprise-only packs as launch-critical requirements unless those paths are truly supported.
- Public pricing pages should not present Advanced and Enterprise as active launch tiers if Marketplace is launching with a simpler Standard-focused offer.
- Privacy and terms pages should match the current legal owner, support email, and provider disclosures used by the app and Marketplace packet.

### Current repo alignment status

- The site content in this repo has been aligned to `Simplif.ai` branding, the current support email, and the current launch-provider posture.
- Pricing copy has been repositioned around the current Standard launch tier, 30-day Marketplace trial, and higher-threshold contact path for larger teams.
- Privacy, terms, security, and admin setup copy have been rewritten to avoid overstating residency, compliance packs, or roadmap-only packaging.
- Before submission, verify that the deployed public site at `simplif.ai` matches the repository version and that the live pages remain in sync with Marketplace answers.

## Documentation Links for Listing

Use these links in the Marketplace listing:

- Documentation: `https://simplif.ai/docs/setup`
- Privacy policy: `https://simplif.ai/privacy`
- Terms of service: `https://simplif.ai/terms`
- Support: `mailto:romano.thewissen@gmail.com`

## Suggested Installation / Setup Notes

You can use this in your listing documentation or installation instructions:

1. Install the app into Jira Cloud.
2. Open Refinely from the Jira global page or from a Jira issue action.
3. Configure project mappings, issue types, and project context as needed.
4. Optionally configure backlog guidance, work-instruction references, and AI provider settings.
5. Generate candidate backlog items and acceptance requirements.
6. Push approved output back into Jira.

## Marketplace Reviewer Notes

Use this if Atlassian asks for extra explanation:

- The app is Jira Cloud only and uses Forge-hosted UI and backend functions.
- The core user value is AI-assisted requirement refinement and structured backlog generation inside Jira.
- The app can optionally cache backlog metadata and project guidance to improve relevance.
- Some trust-oriented controls are tenant-configurable, including PII masking, transparency reports, and audit-trail features.

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

Prepare at least these Marketplace screenshots:

1. Jira global page showing requirement refinement workflow
2. Generated feature list and acceptance requirements
3. Settings/configuration view showing project mappings or model setup
4. Optional screenshot of Jira issue creation flow

## Final Pre-Submission Checklist

- Confirm the public URLs are live:
  - `https://simplif.ai/privacy`
  - `https://simplif.ai/terms`
  - `https://simplif.ai/docs/setup`
- Confirm support should remain `romano.thewissen@gmail.com`
- Confirm production deployment is current
- Confirm Marketplace vendor profile is complete
- Upload screenshots and branding assets
- Complete the Privacy & Security tab using the reviewed answers above
- Be ready to explain each requested scope and each remote host
