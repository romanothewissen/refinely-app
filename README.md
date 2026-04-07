# Refinely

Refinely is a Forge app for Jira Cloud that helps teams turn rough requirements into structured backlog-ready features and acceptance requirements.

## What It Does

- Generates well-scoped Jira-ready feature candidates from short requirements
- Produces GIVEN / WHEN / THEN acceptance requirements
- Supports issue-action and global-page entry points inside Jira
- Lets admins tune project-specific context, mappings, and model configuration
- Can create Jira issues directly from generated output

## Marketplace-Facing Notes

- Hosting model: Atlassian Forge
- Supported host product: Jira Cloud
- Licensing: paid-via-Atlassian enabled in the Forge manifest
- Third-party AI processing: Anthropic, Google Gemini, and OpenAI may be used depending on workspace configuration

## Requested Jira Permissions

- `read:jira-work`
  Required to read issues, projects, and related Jira content used as generation input.
- `write:jira-work`
  Required to create or update Jira issues from generated output.
- `read:jira-user`
  Required to resolve current-user context and selected assignee/reporter information.
- `storage:app`
  Required to store tenant configuration, cached backlog data, usage counters, and optional audit/transparency records.

## Remote Hosts

- `https://api.anthropic.com`
  Used when a workspace selects Anthropic as its active LLM provider.
- `https://generativelanguage.googleapis.com`
  Used when a workspace selects Google Gemini as its active LLM provider.
- `https://api.openai.com`
  Used when a workspace selects OpenAI as its active LLM provider.

Only the content needed to fulfill a generation or refinement request is sent to the configured provider.

## Local Development

Install dependencies:

```bash
npm install
cd src/frontend && npm install
```

Run verification:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Production Build

```bash
npm run build
forge deploy -e production
```

## Support

- Support: `https://smartif.ai/support`
- Security policy: `https://smartif.ai/security`
- Privacy policy: `https://smartif.ai/privacy`
- Terms of service: `https://smartif.ai/terms`
- Setup documentation: `https://smartif.ai/docs/setup`
