# Marketplace Form Answers

Last updated: April 6, 2026

This is the short copy-paste version for the Atlassian Marketplace listing flow.

## Core Details

- App name: `Refinely`
- Hosting: `Forge`
- Product: `Jira Cloud`
- Pricing model: `Paid via Atlassian`
- Support: `https://smartif.ai/support`
- Privacy policy: `https://smartif.ai/privacy`
- Terms of service: `https://smartif.ai/terms`
- Admin/setup docs: `https://smartif.ai/docs/setup`

## Listing Copy

### Short Summary

AI-powered Jira refinement that turns rough requirements into backlog-ready stories and acceptance requirements.

### Tagline

Turn rough Jira requirements into structured backlog-ready stories.

### Overview

Refinely turns rough Jira requirements into backlog-ready stories. Start from the global page or an issue action, answer clarifying questions when needed, generate acceptance requirements, and push approved work back to Jira.

### More Details

Use this in the version-specific Marketplace `More details` field:

Refinely is a Jira Cloud app for teams that need to turn rough business requests into backlog-ready stories without leaving Jira. The app adds a global page called `Refinely` and an issue action called `Refine Stories`, so teams can either start from a blank requirement or refine an existing Jira issue.

After install, a Jira admin opens `Refinely` and goes to `Settings` to choose the AI provider, enter the required API key, configure project mappings and field mappings, and optionally set backlog context, work-instruction documents, issue-linking behavior, and privacy controls such as PII masking, transparency reports, and audit trail settings.

Once configured, end users can enter a requirement, answer targeted clarification questions if needed, review generated features and acceptance requirements, and push approved output back into Jira as Story, Task, Bug, or Epic items.

### Quick Start

1. Install `Refinely` into Jira Cloud.
2. Open `Refinely` and complete admin setup in `Settings`.
3. Start from the global page or use `Refine Stories` on an existing Jira issue.
4. Enter the requirement and answer any clarification questions.
5. Review the generated stories and acceptance requirements.
6. Push approved output back into Jira.

## Key Features

- Generate Jira-ready feature candidates from short business requirements
- Draft structured GIVEN / WHEN / THEN acceptance requirements
- Start from a Jira issue action or from a dedicated Jira global page
- Refine generated output iteratively with additional guidance
- Create Jira issues directly from generated output
- Configure project-specific mappings, context, and work-instruction guidance
- Show included monthly usage guidance with an in-app warning instead of a hard generation stop

## Launch Positioning

- Current launch offer: `Standard`
- Trial: `30-day Marketplace trial`
- Usage policy: `Soft monthly usage guidance, not a hard cap`
- Larger-team path: `Contact support for higher soft-threshold guidance and future packaging`

## Scope Justifications

### `read:jira-work`

Used to read Jira issues, issue content, project context, and related metadata that serve as input for requirement refinement and story generation.

### `write:jira-work`

Used to create Jira issues and write generated output back into Jira when a user chooses to push generated work items into a project.

### `read:jira-user`

Used to resolve the signed-in user context and selected Jira user details for issue creation and assignment workflows.

### `manage:jira-configuration`

Used to inspect Jira configuration metadata needed for admin setup and mapping, including fields, statuses, issue types, permissions checks, and project-specific creation configuration.

### `storage:app`

Used to persist tenant configuration, usage counters, cached backlog/theme data, work-instruction metadata, conversation/session pointers, and optional transparency or audit records.

## Remote Hosts

### `https://api.anthropic.com`

Used when a workspace selects Anthropic as its active AI provider.

### `https://generativelanguage.googleapis.com`

Used when a workspace selects Google Gemini as its active AI provider.

### `https://api.openai.com`

Used when a workspace selects OpenAI as its active AI provider.

## Privacy & Security Answers

### 1. Does your app store End-User Data outside of Atlassian products and services?

Answer: `No`

### 2. Does your app process End-User Data outside of Atlassian products and services or outside of the end-user's browser?

Answer: `Yes`

Data types:

- Jira issue summaries, descriptions, comments, and related requirement text
- Content entered by users during refinement and clarification
- Atlassian account identifiers or display context when needed for app behavior

Explanation:

Relevant Jira-derived prompt content may be sent to Anthropic, Google Gemini, or OpenAI depending on tenant configuration.

### 3. Does your app log End-User Data?

Answer: `No`

### 4. Does your app process and/or store End-User Data in logs outside of Atlassian products and services?

Answer: `No`

### 5. Does your app share End-User Data with any third party entities?

Answer: `Yes`

Third parties:

- Anthropic
- Google
- OpenAI

Explanation:

Refinely shares only the content necessary to fulfill a user-initiated AI refinement or generation request with the workspace's configured model provider.

### 6. Does your app support data residency?

Recommended answer: `No`

Reason:

Do not claim data residency support unless you are prepared to document the exact in-scope End-User Data and the effect of third-party AI provider processing.

### 7. Does your app offer tenant-controlled security or privacy features?

Answer: `Yes`

Examples:

- Optional PII masking before model calls
- Optional transparency reports
- Optional audit trail features
- Project-scoped admin configuration

## Screenshot Checklist

Prepare at least these screenshots:

1. Jira global page showing the requirement refinement workflow.
2. Clarification flow showing how Refinely asks follow-up questions.
3. Generated feature list with GIVEN / WHEN / THEN acceptance requirements.
4. Settings view showing AI setup and project mapping configuration.
5. Jira issue creation or push-to-Jira flow.

## Final Checks

- Confirm the version-specific Marketplace `More details` field is populated with install, setup, and first-use steps, not just marketing copy
- Confirm you are editing the reviewable Marketplace-created version before resubmitting
- Confirm the live site matches the current repo:
  - `https://smartif.ai/privacy`
  - `https://smartif.ai/terms`
  - `https://smartif.ai/docs/setup`
- Confirm support should remain `https://smartif.ai/support`
- Confirm no external log shipping contradicts the Privacy & Security answers
- Confirm production deployment is current
- Confirm the Marketplace vendor profile is complete
