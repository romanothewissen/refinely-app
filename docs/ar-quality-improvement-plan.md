# AR Quality Improvement Plan v2 — Features, Use Cases & Acceptance Requirements

**Date:** 2026-04-17  
**Scope:** Persistent weakness in actor quality and AR depth across "balanced" pipeline profile  
**Status:** Draft — re-assessed after Cursor implemented v1 plan items  
**Domain Constraint:** All changes must remain domain-agnostic — no hardcoded industry terms, roles, or workflow assumptions

---

## 0. What's Already Been Implemented

Cursor implemented the 7 items from the original `quality-improvement-plan.md`:

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Gold Story Picker | ✅ Done | `selectGoldStories()`, `GoldStoryPool`, `formatGoldStoryExemplars()` in `similar-stories.ts` |
| 2 | Clause Length Budget removed | ✅ Done | No length budget in current `buildArSystemPrompt()` |
| 3 | Domain Pattern Extractor | ✅ Done | `DomainPatterns` interface, `domainVocabBlock` injected into AR prompt |
| 4 | Discovery Answer Truncation raised | ✅ Done | Per-answer: 600, custom: 500, Q&A slice: 4000, obligation: 400, compact clarify: 4000 |
| 5 | Domain Context Helper | ✅ Done | 3 guided fields (PLATFORMS, BUSINESS OBJECTS, HANDOFFS) in `SettingsView.tsx` |
| 6 | Thinking Budget increased | ✅ Done | `acceptanceRequirementsReasoningEffort()` returns `'medium'` for balanced+quality |
| 7 | Prompt Simplification | ✅ Partially done | AR prompt is leaner but still ~30 rules; some redundancy remains |

**Despite these improvements, the core problems persist.** The user's export still shows:
- 9/11 features with generic actors (82%)
- ~21/39 ARs expressing CRUD persistence rather than capability (54%)
- 5/11 features with structurally cloned ARs (45%)

**Why the v1 changes didn't fix it:** The v1 plan focused on *context injection* (gold stories, domain patterns, discovery limits, thinking budget) — giving the LLM better inputs and more compute. But the LLM still defaults to shallow patterns because:
1. **No deterministic enforcement** catches CRUD-THEN or generic actors — they pass all quality gates
2. **The AR prompt still lacks** explicit WHEN-clause business-moment guidance and expanded BAD/GOOD examples
3. **The decomposition prompt still allows** "authorized user" as an easy fallback without requiring role decomposition
4. **Gold stories and domain patterns are empty** for new tenants with no backlog — the fallback path is still the common path

---

## 1. Problem Statement (unchanged)

Two systemic quality failures persist:

1. **Weak use-case actors** — Generic bucket labels ("any authorized service team member", "authorized user") instead of true business roles with accountability.
2. **Shallow acceptance requirements** — CRUD persistence statements ("the plan reflects the required order", "the activity is added to the plan") instead of capability-shaped requirements expressing what the system *enables*, not what it *stores*.

### User's Example

**Current (shallow):**
> GIVEN a service plan contains multiple activities that must be performed in a specific order  
> WHEN an authorized service team member defines a sequential dependency between them  
> THEN the plan reflects the required order of execution for those activities

**Desired (capability-shaped):**
> GIVEN service activities may have to occur in a certain sequence  
> WHEN the plan is being drafted  
> THEN the sequence of activities must be able to be indicated

---

## 2. Root-Cause Analysis — Updated

### 2.1 Actor Weakness

| # | Root Cause | v1 Addressed? | Still Active? | Notes |
|---|-----------|---------------|----------------|-------|
| A1 | Decomposition prompt allows "authorized user" as easy fallback | ❌ | ✅ | Line 82: *"use 'authorized user' instead of inventing a domain persona"* — still the default path |
| A2 | Generic role deny-list doesn't catch "authorized service team member" (no "any" prefix) | ❌ | ✅ | `GENERIC_ROLE_DENYLIST_PATTERNS` still misses `/\bas\s+an?\s+authori[sz]ed\s+\w+\s+team\s+member/i` |
| A3 | Discovery doesn't probe deeply enough for role specificity | ❌ | ✅ | `user_personas` probes still accept team names without decomposition |
| A4 | Role coverage tracking is informational, not enforced | ❌ | ✅ | `buildRoleCoverage()` still only feeds metadata |
| A5 | Persona role inference is optional | ❌ | ✅ | Still requires explicit configuration |
| A6 | **NEW:** Domain patterns from gold stories are empty for new tenants | ✅ (implemented) | ✅ (still a problem) | Gold stories require existing backlog — new tenants get no role vocabulary |

### 2.2 AR Shallowness

| # | Root Cause | v1 Addressed? | Still Active? | Notes |
|---|-----------|---------------|----------------|-------|
| B1 | CAPABILITY-SHAPED THEN rule too easily satisfied | ❌ | ✅ | Only 2 BAD/GOOD pairs; LLM interprets "reflects" as capability verb |
| B2 | No deterministic check for CRUD-flavored THEN | ❌ | ✅ | quality-validator has no CRUD-THEN detection |
| B3 | AR depth calibration at "standard" is passive | ❌ | ✅ | "Cover materially distinct branches" = write the obvious scenarios |
| B4 | WHEN clauses default to actor + CRUD verb | ❌ | ✅ | No business-moment guidance in prompt |
| B5 | SCENARIO DEPTH section is advisory, not enforced | ❌ | ✅ | No deterministic check for structural cloning |
| B6 | AR repair doesn't target CRUD-THEN specifically | ❌ | ✅ | Repair only triggers on existing violation categories |
| B7 | Sibling feature context doesn't prevent structural cloning | ❌ | ✅ | LLM still produces identical templates across features |
| B8 | **NEW:** Gold story exemplars are empty for new tenants | ✅ (implemented) | ✅ (still a problem) | No backlog = no exemplars = fallback to generic patterns |

---

## 3. Improvement Plan v2

### Design Principle: Domain-Agnostic Enforcement

All changes must work for **any domain** — no hardcoded industry terms, role names, or workflow assumptions. The enforcement patterns must be structural (detecting CRUD verbs, generic actor patterns) not domain-specific (detecting "service plan" or "work order").

---

### Phase 1: Deterministic Quality Gates (P1 — Highest Impact)

These add enforcement that catches the specific patterns observed. They don't change prompts — they add violations that trigger repair.

#### 1A. CRUD-THEN Detection in quality-validator.ts

**What:** Detect THEN clauses that express mere persistence rather than capability.

**Domain-agnostic patterns to flag:**
```typescript
const CRUD_FLAVORED_THEN_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bis\s+added\s+to\s+the\b/i, label: 'persistence: added to' },
  { pattern: /\bis\s+created\s+and\s+linked?\b/i, label: 'persistence: created and linked' },
  { pattern: /\breflects\s+the\b/i, label: 'persistence: reflects the' },
  { pattern: /\bis\s+updated\s+to\s+\w+/i, label: 'persistence: status update' },
  { pattern: /\bis\s+visible\s+from\s+the\b/i, label: 'persistence: visible from' },
  { pattern: /\bincludes\s+(?:the\s+)?(?:new|updated|required)\b/i, label: 'persistence: includes' },
  { pattern: /\bare\s+created\s+based\s+on\b/i, label: 'persistence: created based on' },
  { pattern: /\bthe\s+\w+\s+is\s+not\s+automatically\s+\w+/i, label: 'persistence: not automatically updated' },
];
```

**Trigger:** When ≥50% of a feature's ARs match a CRUD-flavored THEN pattern, emit:
> *"AR THEN clauses express persistence/crud outcomes rather than business capabilities; reframe to state what the feature enables, decides, enforces, or makes possible"*

**Files:** `src/core/quality-validator.ts`

#### 1B. Strengthen Generic Actor Detection

**What:** Expand `GENERIC_ROLE_DENYLIST_PATTERNS` to catch the patterns that currently evade detection.

**New domain-agnostic patterns:**
```typescript
{ pattern: /\bas\s+an?\s+authori[sz]ed\s+\w+\s+team\s+member\b/i, label: 'generic authorized team member' },
{ pattern: /\bas\s+an?\s+\w+\s+team\s+member\b/i, label: 'generic team member' },
{ pattern: /\bas\s+an?\s+member\s+of\s+the\b/i, label: 'generic member of team' },
```

**Important:** These patterns are domain-agnostic — they match "authorized [any-noun] team member" regardless of the domain noun. They don't hardcode "service" or any industry term.

**Files:** `src/core/quality-validator.ts`

#### 1C. WHEN-Clause CRUD-Action Detection

**What:** Detect WHEN clauses that are just "actor + CRUD verb + object" without expressing a business moment.

**Domain-agnostic pattern:**
```typescript
const WHEN_CRUD_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\b(?:adds?|removes?|creates?|updates?|deletes?|modifies?)\s+(?:an?\s+)?\w+\s+(?:to|from|on|in)\s+(?:the\s+)?/i, label: 'CRUD action in WHEN' },
];
```

**Trigger:** When ≥60% of a feature's WHEN clauses match, emit:
> *"AR WHEN clauses describe CRUD actions rather than business moments or triggers; reframe to express the business situation that triggers the behavior"*

**Files:** `src/core/quality-validator.ts`

---

### Phase 2: Prompt Engineering (P1 — Prevents Problems at Source)

#### 2A. Expand CAPABILITY-SHAPED THEN BAD/GOOD Examples

**What:** Add 5 more BAD/GOOD pairs covering the exact patterns from the user's export.

**Current (2 pairs):**
```
BAD: "THEN the plan reflects the execution order"
GOOD: "THEN the relative order of those items can be expressed"

BAD: "THEN the item is added to the plan"
GOOD: "THEN that line item is available on the plan"
```

**Add (5 domain-agnostic pairs):**
```
BAD: "THEN the activity is added to the plan"
GOOD: "THEN that activity is available on the plan for scheduling"

BAD: "THEN the plan's status is updated to finalized"
GOOD: "THEN the plan is confirmed as complete and ready for execution"

BAD: "THEN the current status of each follow-on action is visible from the plan"
GOOD: "THEN the progress of each follow-on action can be tracked from the plan"

BAD: "THEN the creation of a plan is prevented"
GOOD: "THEN a plan cannot be initiated until the prerequisite conditions are met"

BAD: "THEN the existing order is not automatically updated"
GOOD: "THEN the existing order requires manual review before any changes take effect"
```

**Key principle:** Each GOOD THEN states what becomes **possible, true, or enforced** — not what data was stored. These examples are domain-agnostic (no industry-specific terms).

**Files:** `src/core/prompts.ts` → `buildArSystemPrompt()`

#### 2B. WHEN-Clause Business-Moment Guidance

**What:** Add explicit guidance that WHEN should name business moments, not CRUD actions.

**New section (domain-agnostic):**
```
WHEN-CLAUSE BUSINESS MOMENTS:
- WHEN should name the business moment, situation, or trigger — not just "who does what to the data".
- Prefer: "WHEN the plan is being drafted", "WHEN a plan is ready for execution", "WHEN entitlements are checked", "WHEN a required resource becomes unavailable"
- Avoid: "WHEN an authorized team member adds an activity", "WHEN the owner generates a quote", "WHEN an authorized team member finalizes the plan"
- The actor is already established by the feature description. WHEN should advance the narrative by naming the business situation, not repeating who is acting.
- Exception: When a DIFFERENT actor than the feature owner performs the action, name that actor in WHEN.
```

**Files:** `src/core/prompts.ts` → `buildArSystemPrompt()`

#### 2C. Capability Verb Vocabulary for THEN Clauses

**What:** Provide the LLM with positive vocabulary for capability-shaped THEN clauses.

**New section (domain-agnostic):**
```
CAPABILITY VERBS FOR THEN CLAUSES:
Prefer these to express business capability:
- can be [expressed/indicated/specified/determined/tracked/identified]
- is [available/eligible/prevented until/enforced as/constrained to]
- must be [able to/confirmed as]
- becomes [eligible for/available for/ready for]
- requires [manual review/approval before/confirmation before]

Avoid these persistence-adjacent verbs:
- is added to, is created, is updated, reflects, includes, contains, shows, displays, is visible from, is linked to
```

**Files:** `src/core/prompts.ts` → `buildArSystemPrompt()`

#### 2D. Strengthen Actor Resolution in Decomposition Prompt

**What:** Make the decomposition prompt demand specific business roles, not permission levels.

**Current (line 194):**
> *"Do NOT invent composite bucket actors such as 'any authorized …', 'any … team member', 'relevant stakeholder', or 'appropriate user' — those are not accountable roles."*

**Strengthen to (domain-agnostic):**
```
ACTOR RESOLUTION — strict rules:
- Every feature must be owned by a specific, accountable business role — not a generic team, committee, or "authorized" bucket.
- "Authorized [domain] team member", "authorized user", "[domain] team member" are NOT acceptable role labels. They describe access, not accountability.
- If the requirement names a team but not a role within it, infer the most specific accountable role from the action: the person who creates a plan is a "Planner" (not "team member"), the person who coordinates execution is a "Coordinator" (not "authorized member"), the person who owns the case is a "Case Owner" (not "any authorized user").
- When discovery answers name a team, decompose it: who within that team initiates? Who approves? Who executes? Each is a different role.
- If no specific role can be grounded in evidence, use "authorized user" as a LAST RESORT and flag it in open_decisions as a role gap that must be resolved.
- The actor in "As a [role]" must be a person with a job title or business responsibility, not a permission level.
```

**Critical domain-agnostic note:** The examples ("Planner", "Coordinator", "Case Owner") are **structural role patterns** derived from the action (planning, coordinating, owning), not hardcoded domain roles. They apply to any domain.

**Files:** `src/core/prompts.ts` → `buildDecompositionSystemPrompt()` and `buildStoryAssistantDecompositionSystemPrompt()`

#### 2E. Structural-Clone Detection Guidance

**What:** Prevent the LLM from producing structurally identical ARs across features.

**New section (domain-agnostic):**
```
STRUCTURAL VARIETY — avoid template cloning:
- Do not produce ARs that follow the same template across features with only the noun swapped.
- BAD pattern: "GIVEN [active plan] WHEN [actor] [adds/removes/changes] [noun] THEN [noun] is [added/removed/changed] on the plan" — repeated across features.
- Instead, vary the AR structure: some test preconditions, some test enforcement rules, some test downstream impacts, some test edge cases.
- For each feature, ask: What would a skilled tester check BEYOND the obvious CRUD operations? What business rules constrain this? What happens when preconditions are partially met? What downstream consequences follow?
```

**Files:** `src/core/prompts.ts` → `buildArSystemPrompt()`

---

### Phase 3: Repair Loop Improvements (P2 — Close the Loops)

#### 3A. CRUD-THEN Repair Trigger

**What:** When the new CRUD-THEN quality check fires, generate specific repair reasons.

**Repair reasons (domain-agnostic):**
```
"THEN clause '{thenText}' expresses persistence rather than business capability — reframe to state what becomes possible, true, or enforced"
"WHEN clause '{whenText}' describes a CRUD action rather than a business moment — reframe to express the business situation that triggers this behavior"
```

**Files:** `src/core/story-generator.ts` (repair trigger logic)

#### 3B. Actor Repair Trigger

**What:** When the strengthened generic actor check fires, trigger description repair.

**Repair reason (domain-agnostic):**
```
"Feature actor '{actorLabel}' is a generic authorized-role bucket, not an accountable business role — resolve to a specific job title or business responsibility grounded in the requirement or discovery answers"
```

**Files:** `src/core/story-generator.ts` (repair trigger logic)

#### 3C. Make AR Repair Prompt Explicitly Check for CRUD-THEN

**What:** Even when repair is triggered for other reasons, the repair prompt should also check for and fix CRUD-THEN patterns.

**Add to `buildArRepairSystemPrompt()`:**
```
ADDITIONAL REPAIR CHECK:
- After repairing the flagged issues, also review every THEN clause: does it express a business capability (what becomes possible, true, or enforced) or merely persistence (what was stored, updated, or reflected)? Rewrite any persistence-flavored THEN to state the capability.
- Also review every WHEN clause: does it name a business moment or trigger, or just describe who does what to the data? Rewrite any CRUD-flavored WHEN to name the business situation.
```

**Files:** `src/core/prompts.ts` → `buildArRepairSystemPrompt()`

---

### Phase 4: Discovery & Role Improvements (P3 — Upstream)

#### 4A. Strengthen Discovery Role Probing

**What:** Add more specific probing in the `user_personas` discovery category.

**Current:** *"Who initiates this process? Who performs each step? Who only views or receives output?"*

**Strengthen to (domain-agnostic):**
```
Probe: Name the specific job titles or business responsibilities of each person involved — not teams, departments, or permission levels.
Probe: If the requirement names a team, who WITHIN that team performs each action? Decompose the team into its roles.
Probe: Who is accountable for the outcome of each feature? That person is the feature owner.
```

**Files:** `src/core/prompts.ts` → `buildClarifySystemPrompt()`

#### 4B. Role-Challenge in Discovery Sufficiency Evaluation

**What:** When evaluating discovery sufficiency, check whether roles are specific enough.

**New check (domain-agnostic):**
```
ROLE SPECIFICITY CHECK:
- If all answered role questions resolve to team names, department names, or "authorized" buckets, discovery is NOT sufficient for role resolution.
- Mark user_personas as insufficient when no specific job titles or business responsibilities have been identified.
- Generate a follow-up question that specifically asks: "Within the [team name], which specific role is responsible for [action]?"
```

**Files:** `src/core/prompts.ts` → `buildEvaluateSystemPrompt()`

#### 4C. Automatic Persona Role Inference

**What:** Automatically run persona role inference from existing backlog stories when generating.

**Implementation:** Before decomposition, if `personaRoles` are empty, auto-run `inferProjectPersonaRoles()` and feed results as `domainRoles`.

**Files:** `src/core/story-generator.ts` (pipeline orchestration)

---

### Phase 5: AR Depth Calibration (P3 — Lower Priority)

#### 5A. Raise "Standard" Depth Floor

**What:** Strengthen the "standard" depth guidance to push for deeper ARs.

**Current:** *"Cover materially distinct branches and business-rule outcomes when they exist."*

**Strengthen to (domain-agnostic):**
```
STANDARD depth means:
- Every AR's THEN must express a business capability, rule, or observable truth — never mere persistence.
- Include at least one AR that tests a business rule or constraint beyond the happy path.
- Include at least one AR that tests a downstream impact or dependency enforcement.
- WHEN clauses should name business moments, not CRUD actions.
- If all your ARs follow the same template (GIVEN precondition WHEN actor adds/changes/removes THEN item is added/changed/removed), you are writing CRUD requirements, not business requirements. Vary the structure.
```

**Files:** `src/core/prompts.ts` → `buildArSystemPrompt()`

---

## 4. Priority & Sequencing — Updated

| Priority | Item | Phase | Effort | Impact | Domain-Agnostic? |
|----------|------|-------|--------|--------|-------------------|
| **P1** | 1A: CRUD-THEN detection | Phase 1 | Small | High | ✅ Structural patterns only |
| **P1** | 2A: Expand BAD/GOOD examples | Phase 2 | Small | High | ✅ No industry terms |
| **P1** | 2B: WHEN-clause business-moment guidance | Phase 2 | Small | High | ✅ Domain-agnostic examples |
| **P1** | 2D: Strengthen actor resolution | Phase 2 | Small | High | ✅ Structural role patterns |
| **P2** | 1B: Strengthen generic actor detection | Phase 1 | Small | Medium | ✅ Matches any domain noun |
| **P2** | 2C: Capability verb vocabulary | Phase 2 | Small | Medium | ✅ No domain terms |
| **P2** | 2E: Structural-clone guidance | Phase 2 | Small | Medium | ✅ Template-level only |
| **P2** | 3A: CRUD-THEN repair trigger | Phase 3 | Medium | Medium | ✅ Structural repair |
| **P2** | 3B: Actor repair trigger | Phase 3 | Medium | Medium | ✅ Structural repair |
| **P2** | 3C: Repair prompt CRUD check | Phase 3 | Small | Medium | ✅ Domain-agnostic |
| **P2** | 5A: Raise "standard" depth floor | Phase 5 | Small | Medium | ✅ No domain terms |
| **P3** | 1C: WHEN-clause CRUD detection | Phase 1 | Small | Low-Medium | ✅ Structural patterns |
| **P3** | 4A: Strengthen discovery role probing | Phase 4 | Small | Medium | ✅ Domain-agnostic probes |
| **P3** | 4B: Role-challenge in sufficiency eval | Phase 4 | Small | Low-Medium | ✅ Domain-agnostic |
| **P3** | 4C: Automatic persona role inference | Phase 4 | Medium | Medium | ✅ Uses existing backlog |

---

## 5. Feature-by-Feature AR Quality Assessment (unchanged from v1)

| Feature | Actor Quality | AR Depth | CRUD-THEN Count | Structural Clone? |
|---------|--------------|----------|-----------------|-------------------|
| F1: Create service plan from case | ✅ "Case Owner" | Medium | 2/4 | No |
| F2: Define activities, parts, labor | ❌ Generic | Low | 3/4 | Yes |
| F3: Sequence activities | ❌ Generic | Low | 3/3 | Yes |
| F4: Determine entitlements | ❌ Generic | Medium | 1/4 | Partial |
| F5: Finalize plan | ❌ Generic | Low | 3/3 | Yes |
| F6: Generate quote | ✅ "Case Owner" | Medium | 1/4 | No |
| F7: Initiate follow-on actions | ❌ Generic | Medium | 1/4 | Partial |
| F8: View consolidated status | ❌ Generic | Low | 2/3 | Partial |
| F9: Track consumption | ❌ Generic | Medium | 1/4 | No |
| F10: Modify plan after execution | ❌ Generic | Low | 3/3 | Yes |
| F11: Pause plan execution | ❌ Generic | Low | 2/3 | Partial |

**Summary:** 82% generic actors, 54% CRUD-THEN, 45% structural clones.

---

## 6. Three Shallow AR Templates (unchanged)

**Template 1: "Happy-path CRUD"** (~40% of all ARs)
```
GIVEN [precondition] WHEN [actor] [adds/creates] [noun] THEN [noun] is [added/created] to [parent]
```

**Template 2: "Status guard"** (~25% of all ARs)
```
GIVEN [precondition NOT met] WHEN [actor] attempts [action] THEN [action] is prevented
```

**Template 3: "Status update"** (~15% of all ARs)
```
GIVEN [precondition met] WHEN [actor] [action] THEN [status] is updated to [new status]
```

These three templates account for ~80% of all ARs. The v1 changes (gold stories, domain patterns, thinking budget) don't address them because they're structural prompt and enforcement gaps, not context gaps.

---

## 7. Success Metrics

After implementing P1 items:
1. **CRUD-THEN rate** drops from ~54% to <20%
2. **Specific actor rate** rises from 18% to >60%
3. **Structural clone rate** drops from 45% to <15%
4. **AR repair trigger rate** for CRUD-THEN: ~30-50% on first gen, <10% after repair

---

## 8. Implementation Order

### Sprint 1 (P1 — immediate)
1. Add CRUD-THEN detection to `quality-validator.ts` (1A)
2. Expand BAD/GOOD examples in `buildArSystemPrompt()` (2A)
3. Add WHEN-clause business-moment guidance (2B)
4. Strengthen actor resolution in decomposition prompt (2D)

### Sprint 2 (P2 — close loops)
5. Strengthen generic actor detection (1B)
6. Add capability verb vocabulary (2C)
7. Add structural-clone guidance (2E)
8. Wire CRUD-THEN and actor violations into repair triggers (3A, 3B)
9. Add CRUD check to repair prompt (3C)
10. Raise "standard" depth floor (5A)

### Sprint 3 (P3 — upstream)
11. Add WHEN-clause CRUD detection (1C)
12. Strengthen discovery role probing (4A)
13. Add role-challenge to sufficiency evaluation (4B)
14. Evaluate automatic persona role inference (4C)

---

## 9. Key Difference from v1 Plan

The v1 plan (`quality-improvement-plan.md`) focused on **context injection** — giving the LLM better inputs (gold stories, domain patterns, longer discovery answers, more thinking tokens). This is necessary but insufficient.

The v2 plan focuses on **structural enforcement** — adding deterministic checks that catch shallow patterns, and prompt guidance that explicitly teaches the LLM what a business-moment WHEN and capability-shaped THEN look like. These are the missing pieces that prevent the LLM from defaulting to CRUD patterns even when it has good context.

**Both plans are complementary.** The v1 changes ensure the LLM has the right context. The v2 changes ensure it uses that context to write capability-shaped ARs rather than falling back to CRUD templates.