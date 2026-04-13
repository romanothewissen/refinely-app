# Forge Storage Rollout Checklist

Use this checklist for storage optimization rollouts and SQL hybrid migration cutovers.

## Pre-rollout

- [ ] Capture baseline from `docs/forge-usage-baseline-template.md`.
- [ ] Confirm latest deployment hash and environment.
- [ ] Verify optimization flags intended for this rollout window.
- [ ] Validate generation, clarify, and refine progress UX on test tenant.

## Stage 1: Development

- [ ] Enable small-write optimization paths.
- [ ] Validate cancellation and completion states still persist correctly.
- [ ] Confirm no regression in conversation/session persistence.
- [ ] Observe read/write usage trend for at least 24-48h.

## Stage 2: Staging

- [ ] Replay representative usage (generation, clarify, refine, backlog refresh).
- [ ] Validate site-level usage deltas are trending down.
- [ ] Confirm no stale-progress incidents in polling UI.
- [ ] Confirm no queue-worker errors linked to progress writes.

## Stage 3: Production canary

- [ ] Enable on one low-risk internal site first.
- [ ] Compare canary site vs control sites for reads/writes.
- [ ] Check support logs for UX regressions (stuck progress, missed completions).

## Rollback triggers

- [ ] Storage reads/writes rise for 3 consecutive days post-rollout.
- [ ] Progress-state mismatch incidents > 1% of active sessions.
- [ ] Queue completion/cancel state delivery misses SLA.

## Rollback plan

- [ ] Disable optimization flags.
- [ ] Redeploy previous known-good app version if needed.
- [ ] Re-collect baseline and root-cause analysis before reattempt.

## SQL hybrid cutover gate

- [ ] SQL schema applied and validated.
- [ ] Dual-write period completed without divergence.
- [ ] Backfill complete and verified.
- [ ] Read path switched to SQL behind feature flag.
- [ ] KVS fallback retained for one rollback window.
