# Refinely V3 Local POC

This folder is a clean local proof of concept for the next Refinely pipeline.

The goal is to turn a plain-English business requirement into Jira-ready features and standardized Gherkin acceptance requirements, grounded in:

- uploaded work instructions
- project backlog examples
- project-specific roles, rules, exceptions, and style

V3 is intentionally separate from the existing Forge app and legacy V1/V2 code. The core engine should stay dependency-light and testable locally.

## Pipeline

1. Plan the requirement into requirement-derived business capabilities.
2. Compile work instructions and backlog examples into compact context cards.
3. Retrieve a small context pack against the capability plan.
4. Generate a draft from the capability plan and context pack.
5. Label each feature/AR with provenance: requirement, work instruction, backlog pattern, golden example, or assumption.
6. Validate Gherkin shape, business-outcome language, and evidence grounding.

## Local Commands

From the repo root:

```sh
npm --prefix v3 test
npm --prefix v3 run demo
```

Use a custom requirement:

```sh
npm --prefix v3 run build
node v3/dist/src/cli.js --requirement "Allow dispatch managers to approve urgent service work and notify planners when eligibility rules fail."
```

Gemini run:

```sh
GEMINI_API_KEY=... node v3/dist/src/cli.js --provider gemini --requirement "..."
```

If `GEMINI_API_KEY` is present, the CLI defaults to a Gemini 2.5 Flash planner plus Gemini 2.5 Flash generator. Without a key, it falls back to deterministic `heuristic`, so tests and quick demos do not spend tokens.

## Boundary Rules

- `v3/src/**` must not import from `../src/**`.
- Forge, Jira writeback, and app storage belong in future thin adapters only.
- Legacy V2 is not a benchmark and should not shape this POC.
- The output must make grounding visible through evidence references.
