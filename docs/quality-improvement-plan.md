# Refinely AR Quality Improvement Plan

**Date**: 2025-01-21
**Status**: Approved — Ready for Implementation

## Root Cause Summary

JSA (Jira Story Assistant) produces higher-quality ARs than Refinely because of 7 structural differences, most converging on a single root cause: **JSA had baked-in BSC domain expertise (gold examples, platform context, role vocabulary), while Refinely is domain-agnostic and must dynamically inject context — and that injection is failing.**

| JSA Advantage | Refinely Deficit |
|---------------|-----------------|
| BSC gold-standard exemplars (curated deployed stories) | Generic domain-agnostic anchors / weak backlog pool |
| BSC platform context (hardcoded 60+ line block) | Dynamic domain context (often empty/truncated) |
| Batch AR generation (sees all ARs at once) | Per-feature AR generation (siblings are summaries only) |
| 5-category discovery, "ask as needed" | 6-category discovery, budget-constrained |
| Focused prompt (~15 rules) | Over-engineered prompt (~40+ rules + length budgets) |
| gemini-2.5-pro + 16k thinking (always) | Configurable model + 0-8k thinking (profile-dependent) |
| Hard role constraint ("verbatim") | Soft role suggestion ("use most appropriate") |
| Full-length discovery answers | Aggressively truncated answers (360/280/2200 chars) |

---

## Implementation Plan (7 Changes)

### #1: Gold Story Picker (🔴 Critical — Highest Impact)

**Problem**: The AR anchor bundle (`ar-anchor-bundle.ts`) contains 5 generic domain-agnostic examples. When the tenant's backlog has better examples, the quality gate (`EXEMPLAR_QUALITY_FLOOR = 38`) often rejects them, falling back to generic anchors. The model never sees domain-specific AR patterns.

**Solution**:
- During backlog cache build, score every story's AR quality using existing `scoreExemplarQuality()`
- Store the top 10-15 scored stories as `goldStoryKeys` in tenant config
- Surface gold story candidates in Settings → Project Setup with quality score badges and ✅/❌ toggles
- Admin confirms or adjusts selection (lean setup — no manual input required)
- At generation time, fetch gold stories from backlog cache and inject their ARs as few-shot exemplars
- **Gold stories REPLACE the generic anchor bundle** when available; anchor bundle is last resort only

**Files affected**:
- `src/core/similar-stories.ts` — Add gold story scoring during cache build
- `src/services/story-assistant-pipeline.ts` — Inject gold story ARs into AR pass
- `src/core/prompts.ts` — Add gold story exemplar section to `buildArSystemPrompt`
- `src/frontend/src/SettingsView.tsx` — Add gold story picker UI in Project Setup
- `src/types.ts` — Add `goldStoryKeys` to TenantConfig

**Token budget**: Gold exemplars replace anchor bundle — same token slot, no net increase.

---

### #2: Relax Clause Length Budget (🔴 Critical — Quick Win)

**Problem**: The AR system prompt enforces `GIVEN under 22 words, WHEN under 22 words, THEN under 18 words`. This directly fights against compound preconditions and concrete business nouns — the very things that make JSA's ARs superior. A compound GIVEN like "GIVEN a service plan includes both billable and covered items AND customer authorization has been recorded" is 17 words just for the precondition — leaving no room for the actual condition.

**Solution**: Remove the `CLAUSE LENGTH BUDGET` rule entirely from `buildArSystemPrompt()`. Replace with a softer guidance: "Keep each clause focused on one business condition, trigger, or outcome. Split the AR rather than overloading a single clause."

**Files affected**:
- `src/core/prompts.ts` — Remove `CLAUSE LENGTH BUDGET` paragraph from `buildArSystemPrompt`

**Token budget**: Saves ~50 tokens on system prompt.

---

### #3: Domain Pattern Extractor (🟡 Major)

**Problem**: The AR model has no domain-specific vocabulary to draw from. JSA hardcodes BSC roles ("Service Support Specialist") and terminology ("service plan", "work order", "entitlement check"). Refinely falls back to generic roles ("authorized user") and abstract terms.

**Solution**:
- When gold stories are selected (or backlog cache rebuilt), run a lightweight LLM pass over the gold stories
- Extract: (1) canonical role names, (2) core domain terminology, (3) AR structural patterns
- Store as compact `domainPatterns` block in tenant config (~200 chars)
- Inject into decomposition + AR system prompts as "DOMAIN VOCABULARY" section
- Automatic — no admin input required, runs during "Rebuild Cache"

**Example output**:
```json
{
  "roles": ["Service Support Specialist", "Service Manager", "Billing Specialist"],
  "coreTerminology": ["service plan", "work order", "entitlement", "loaner", "parts shipment"],
  "arStyle": "compound-given-with-concrete-then"
}
```

**Injection format**:
```
DOMAIN VOCABULARY — use these roles and terms when they fit the requirement:
Roles: Service Support Specialist, Service Manager, Billing Specialist
Core terminology: service plan, work order, entitlement, loaner, parts shipment
AR style: This organization writes compound GIVEN preconditions with concrete business objects in THEN clauses.
```

**Files affected**:
- `src/core/similar-stories.ts` — Add `extractDomainPatterns()` function
- `src/core/prompts.ts` — Add domain vocabulary injection to `buildDecompositionSystemPrompt` and `buildArSystemPrompt`
- `src/types.ts` — Add `domainPatterns` to TenantConfig
- `src/queues/generation.ts` — Call extractor during cache rebuild

**Token budget**: ~200 chars added to system prompt. Offset by prompt simplification (#7).

---

### #4: Fix Discovery Answer Truncation (🟡 Major)

**Problem**: Discovery answers are aggressively truncated before reaching the generation prompts, losing critical domain-specific context that users provided.

Current limits:

| Location | Current Limit | Effect |
|----------|--------------|--------|
| `buildArPerFeatureUserMessage` Q&A slice | 2200 chars | All Q&A combined per feature AR call |
| `formatClarifyAnswersForPrompt` answer trim | 360 chars | Per-answer in decomposition pass |
| `formatClarifyAnswersForPrompt` custom answer trim | 280 chars | Per-custom-answer in decomposition |
| `PASS1_CONTEXT_LIMITS.clarify` | 5000 chars | Total Q&A budget for decomposition |
| `PASS1_CONTEXT_LIMITS_COMPACT.clarify` | 3000 chars | Compact mode Q&A budget |
| `PASS2_CONTEXT_LIMITS.clarify` | 4000 chars | AR pass Q&A budget |
| `summarizeAnswerForObligation` | 220 chars | Used for AR obligations — extremely aggressive |

**Solution**: Raise limits to preserve meaningful answer content:

| Location | Old Limit | New Limit | Rationale |
|----------|-----------|-----------|-----------|
| Q&A slice (AR per-feature) | 2200 | 4000 | Allow 4-6 full answers to survive |
| Per-answer trim | 360 | 600 | A good workflow answer needs ~500 chars |
| Custom answer trim | 280 | 500 | Same rationale |
| Obligation summary | 220 | 400 | Allow compound conditions in obligations |
| Compact clarify limit | 3000 | 4000 | Small increase to preserve quality |

Keep `PASS1_CONTEXT_LIMITS.clarify` (5000) and `PASS2_CONTEXT_LIMITS.clarify` (4000) unchanged — they're already reasonable total budgets.

**Files affected**:
- `src/core/story-generator.ts` — Raise `trimForPrompt` limits in `summarizeAnswerForObligation` and `formatClarifyAnswersForPrompt`
- `src/core/prompts.ts` — Raise Q&A slice limit in `buildArPerFeatureUserMessage`
- `src/core/story-generator.ts` — Raise `PASS1_CONTEXT_LIMITS_COMPACT.clarify` from 3000→4000

**Token budget**: ~1000-2000 additional input tokens per generation. Worth it — this is the user's own domain context.

---

### #5: Domain Context Helper (🟠 Moderate)

**Problem**: The domain context textarea in Settings → Project Setup is a blank box. Most admins don't know what to write, so they leave it empty. The model then has no platform awareness.

**Solution**: Replace the blank textarea with 3 guided questions:

1. **What platforms or systems does your work connect to?**
   *e.g., "We run field service on Salesforce/ServiceMax and back-office on SAP"*
2. **What are the main business objects in your domain?**
   *e.g., "service plans, work orders, entitlements, parts shipments"*
3. **What are the key handoffs between teams or systems?**
   *e.g., "When a service plan is approved, work orders and parts shipments are created in the back-office system"*

The three answers compile into the existing `domainContext` string:
```
DOMAIN CONTEXT — use this to reason about scope and decomposition only. Never surface system names in output.

PLATFORMS: [answer 1]
BUSINESS OBJECTS: [answer 2]
HANDOFFS & INTEGRATIONS: [answer 3]
```

This maps directly to JSA's `_platform_context_block()` structure, but is domain-agnostic and populated by the admin.

**Files affected**:
- `src/frontend/src/SettingsView.tsx` — Replace single textarea with 3 guided inputs
- `src/core/prompts.ts` — No change (already consumes `domainContext` string)

**Token budget**: Zero change — same `domainContext` field, just better structured input.

---

### #6: Increase Thinking Budget for AR Pass (🟠 Moderate)

**Problem**: On `balanced` profile (the default), the AR generation pass gets only `low` reasoning effort (~4k thinking tokens). JSA uses 16k thinking tokens for the same pass. Complex AR generation that requires reasoning about dependencies, sequencing, exceptions, and cross-feature boundaries needs deeper thinking.

**Solution**: Change `pipelineReasoningEffort()`:
- `fast` → `none` (unchanged — speed priority)
- `balanced` → `medium` for AR pass only (was `low`) — ~8k thinking tokens
- `quality` → `medium` (unchanged)

Apply specifically to the AR generation call in `runParallelArPass` and `generateAcceptanceRequirementsForFeature`, not to all stages.

**Files affected**:
- `src/core/story-generator.ts` — Override `reasoningEffort` to `'medium'` in AR generation calls when profile is `balanced`

**Token budget**: ~4k additional thinking tokens per AR feature call. With 3-5 features, that's ~12-20k additional thinking tokens total. Acceptable for quality improvement on the most important pass.

---

### #7: Simplify AR System Prompt (🟠 Moderate)

**Problem**: The AR system prompt in `buildArSystemPrompt()` contains ~40+ rules with sub-rules, anti-patterns, and examples. When you give an LLM 40 rules, it struggles to satisfy all of them simultaneously. The clause length budget, actor assignment rules, and classification framing rules collectively dilute the core quality guidance.

**Solution**: Reduce to ~20 focused rules, organized by priority:

**Keep (high-impact)**:
- GIVEN/WHEN/THEN format
- No first person
- Business language only (no UI/system terms)
- Concrete business nouns in THEN, not abstract verbs
- Each AR tests one distinct thing
- GIVEN = real business situation, not config/setup
- Cover happy path + key rules + realistic edge cases
- Narrative ordering for readability
- Actor from feature description as default anchor
- Role-neutral phrasing after first establishment
- Sibling feature deduplication (one rule, not three)
- Classification: use positive category names
- SCENARIO DEPTH: go beyond status gates

**Remove (low-impact, dilute focus)**:
- Clause length budget (removed in #2)
- Detailed actor assignment sub-rules (redundant with default anchor rule)
- scopeBoundaries/AR OBLIGATIONS detailed rules
- Variant enumeration rules (covered by "each AR tests one thing")
- Multiple BAD/GOOD examples (keep 2-3 most impactful, remove rest)
- Classification detection mechanism rules (too specific)
- Cross-feature interaction rules (covered by scenario depth)
- Repetitive "do not" patterns that say the same thing 3 ways

Let the **gold story exemplars** (#1) teach structure and depth — they're more effective than rules for LLMs.

**Files affected**:
- `src/core/prompts.ts` — Rewrite `buildArSystemPrompt()` body

**Token budget**: Saves ~800-1200 tokens on system prompt. Offsets the domain vocabulary injection (#3) and Q&A limit increases (#4).

---

## Token Budget Summary

| Change | Input Tokens | Output Tokens | Net Effect |
|--------|-------------|---------------|------------|
| #1 Gold Story Picker | Same slot as anchor bundle | No change | **Neutral** |
| #2 Clause Length Budget | -50 tokens (prompt) | +100 tokens (longer ARs) | **+50** |
| #3 Domain Patterns | +200 tokens (vocabulary) | No change | **+200** |
| #4 Discovery Q&A Limits | +1000-2000 tokens | No change | **+1500** |
| #5 Domain Context Helper | No change | No change | **Neutral** |
| #6 Thinking Budget | +4k thinking tokens × 3-5 features | No change | **+12-20k thinking** |
| #7 Prompt Simplification | -800-1200 tokens (prompt) | No change | **-1000** |

**Net input token increase**: ~750-950 per generation (offset by thinking budget which is cheaper)
**Net thinking token increase**: ~12-20k (only on `balanced`/`quality` profiles, only for AR pass)

---

## Implementation Order

1. **#2** — Quick win, 5 minutes
2. **#4** — Quick win, 15 minutes
3. **#6** — Quick win, 10 minutes
4. **#7** — Prompt rewrite, 30 minutes
5. **#1** — Gold Story Picker, 2-3 hours (backend + frontend)
6. **#3** — Domain Pattern Extractor, 1-2 hours (depends on #1)
7. **#5** — Domain Context Helper, 30 minutes (frontend only)

---

## Design Principle

**Admin setup stays lean and clean.** The Gold Story Picker and Domain Pattern Extractor are fully automatic — the admin just clicks "Rebuild Cache" and the system figures it out. The Domain Context Helper replaces one blank textarea with three specific prompts that are easy to answer. No prompt engineering required from the user.
