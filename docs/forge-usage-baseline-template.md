# Forge Usage Baseline Template

Use this template weekly (or per release) to track storage costs before/after optimization.

## Scope

- App:
- Environment:
- Date range:
- Compared against release:

## Forge Usage and Costs

| Metric | Value | Prior baseline | Delta |
| --- | ---: | ---: | ---: |
| Storage reads (GB) |  |  |  |
| Storage writes (GB) |  |  |  |
| Functions (GB-seconds) |  |  |  |
| Logs writes (GB) |  |  |  |
| Estimated cost (USD) |  |  |  |

## Site Breakdown (top 5 non-zero consumers)

| Site | Reads (GB) | Writes (GB) | Notes |
| --- | ---: | ---: | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

## Flow Attribution Notes

- Generation polling:
- Clarify polling:
- Queue heartbeat/progress writes:
- Conversation persistence:
- Compliance/activity writes:
- Backlog/WI cache refresh:

## Action Items

- [ ] Keep current rollout
- [ ] Tune polling/heartbeat
- [ ] Reduce payload sizes
- [ ] Advance SQL migration step
