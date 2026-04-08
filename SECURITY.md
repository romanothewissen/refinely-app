# Security Policy

Last updated: April 7, 2026

## Contact

For security reports, vulnerability disclosures, or urgent trust questions, contact:

- `support@smartif.ai`

## Vulnerability Reporting

- Report suspected vulnerabilities privately by email.
- Include the affected app version, Jira product context, reproduction steps, and any relevant logs or screenshots.
- Smartif.ai will acknowledge security reports, investigate, and coordinate remediation and disclosure timing as appropriate.

## Hosting and Data Handling

- Refinely is a Forge-hosted Jira Cloud app.
- App state is stored in Forge-hosted storage.
- Third-party AI provider API keys are stored using Forge secret storage.
- The app can send customer-provided requirement content to configured AI providers declared in the Forge manifest:
  - Anthropic
  - Google Gemini
  - OpenAI

## Protective Controls

- Optional PII masking can redact supported patterns before outbound model calls.
- Optional transparency reports can capture which context sources influenced generation.
- Optional audit trail controls can record key administrative and runtime events.
- Similar-story retrieval is project-scoped and gated by user permission checks before app-level Jira reads are used.

## Incident Handling

- Smartif.ai will notify customers and Atlassian in the event of a confirmed security incident or critical vulnerability affecting the app.
- Notifications will include known impact, affected capabilities, and remediation guidance when available.
