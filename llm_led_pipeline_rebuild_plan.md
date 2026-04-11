# LLM-Led Pipeline Rebuild Plan

This plan captures the recommended reset of the Refinely pipeline back toward a simpler, stronger flow:

`requirement -> discovery -> follow-up if needed -> output`

The intent is to restore output depth and trust without slowing the product down unnecessarily and without pushing too many decisions onto the user in the canvas.

---

## 1. Product Direction

### Core goals
- Make the pipeline primarily LLM-led from triage through generation.
- Keep the system domain-, company-, system-, and role-agnostic.
- Catch missing depth upstream, before the draft reaches the canvas.
- Reduce user decision-making in the main flow.
- Preserve the canvas as a light correction surface, not a rescue workflow.

### Principles
- Use the LLM for meaning, sufficiency, missing coverage, and decomposition decisions.
- Use deterministic code for guardrails, routing, validation, preservation, and UI orchestration.
- Default to one strong discovery round, one follow-up round only when needed, then generate.
- If a late gap is surfaced, it must be a one-click add flow, not a restructuring exercise.
- Avoid visible “we may have missed all this” UX unless the system has already tried to repair the draft internally.

---

## 2. Current Problems To Fix

### Discovery and sufficiency
- The code supports sufficiency and follow-up stages, but users often experience only one visible question round.
- In [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L3598), weak follow-up questions are dropped and sufficiency is effectively forced true when no usable follow-up questions remain.
- In [src/core/discovery.ts](/Users/romano/Documents/refinely/refinely-app/src/core/discovery.ts#L1193), the repaired discovery profile normalizes around the finalized question count, which can legitimize under-asking.

### Generation depth
- Acceptance requirement depth is not being meaningfully driven by discovery today.
- In [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L2793), pass 2 uses a hardcoded default AR plan with `depth: 'standard'`.
- That same default is reused throughout AR generation and backfill in [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L2997).

### Over-consolidation
- Decomposition still has a strong bias toward folding supporting behavior into parent features.
- The prompt guidance in [src/core/prompts.ts](/Users/romano/Documents/refinely/refinely-app/src/core/prompts.ts#L142), [src/core/prompts.ts](/Users/romano/Documents/refinely/refinely-app/src/core/prompts.ts#L164), and [src/core/prompts.ts](/Users/romano/Documents/refinely/refinely-app/src/core/prompts.ts#L172) can compress meaningful workflow distinctions.
- The generator can also auto-tighten drafts before the user sees them in [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L2887).

### Canvas reliability
- `add_requirements` still routes through the broad refine path in [src/queues/refine.ts](/Users/romano/Documents/refinely/refinely-app/src/queues/refine.ts#L96).
- The refine prompt still asks for the complete final feature set in [src/core/prompts.ts](/Users/romano/Documents/refinely/refinely-app/src/core/prompts.ts#L938), so small additions can rewrite unrelated features.

### Late and noisy gap surfacing
- The current visible `Missing something?` section in [src/frontend/src/MainContent.tsx](/Users/romano/Documents/refinely/refinely-app/src/frontend/src/MainContent.tsx#L2759) adds user-facing uncertainty after generation.
- The frontend gap helper in [src/frontend/src/canvasChange.ts](/Users/romano/Documents/refinely/refinely-app/src/frontend/src/canvasChange.ts#L553) is useful as a UI aid, but should not be the primary mechanism for preserving business depth.

---

## 3. Target End State

The app should feel like this:

1. User enters a requirement.
2. The system asks strong initial discovery questions.
3. The system performs a real sufficiency check.
4. If needed, the system asks one targeted follow-up round.
5. The system generates a draft that is already materially complete.
6. If the system still detects a likely omission, it runs one internal repair pass before showing the draft.
7. The user can accept the output or make small, reliable adjustments.

The canvas should support light cleanup, not compensate for weak upstream generation.

---

## 4. Architectural Reset

### Stage A: LLM-led triage

Keep a fast triage stage, but make it output more than a size forecast.

It should produce:
- complexity
- ambiguity
- discovery question budget
- expected AR depth
- must-cover behaviors
- non-collapsible distinctions
- unresolved decision themes

This remains domain-agnostic because the model infers these from the actual requirement and context, not from hardcoded domain rules.

### Stage B: LLM-led discovery round 1

Discovery should ask the highest-value questions against the unresolved decisions and must-cover behaviors from triage.

It should prioritize:
- missing business rules
- key routing and matching decisions
- missing actor or ownership decisions
- lifecycle behavior
- exception handling
- required identifiers, linkage, and reference data when implied

### Stage C: LLM-led sufficiency controller

After answers are provided, run a single LLM sufficiency controller that returns one of:
- `ask_followup`
- `ready_to_generate`
- `ready_with_open_decisions`

If it returns `ask_followup`, it must produce only delta questions for unresolved areas.

If it believes discovery is insufficient but produces unusable follow-up questions:
- retry once, or
- continue with explicit open decisions carried forward,

but never silently promote the requirement to sufficient.

### Stage D: Discovery synthesis artifact

Before generation, create one structured discovery artifact that both decomposition and AR generation must consume.

It should contain:
- resolved facts
- unresolved decisions
- must-cover behaviors
- non-collapsible distinctions
- target AR depth
- desired breadth of decomposition

This becomes the contract between discovery and generation.

### Stage E: LLM-led decomposition with explicit coverage mapping

Decomposition should produce:
- features
- per-feature rationale
- a coverage map that shows where each must-cover behavior is represented

If a must-cover behavior is not included in a feature, it must be explicitly marked unresolved rather than silently dropped.

### Stage F: LLM-led AR generation

AR generation must consume the same discovery artifact and actual AR depth target.

Its job is not just to make ARs syntactically complete. It must preserve:
- rules
- exceptions
- matching behavior
- routing behavior
- key linkage or identification behavior
- manual-review paths when ambiguity remains

### Stage G: Internal repair, not late user burden

Post-generation coverage review can remain, but it should be used primarily to trigger one internal repair pass before the user sees the result.

Only surface a missing area when:
- the repair pass still cannot resolve it confidently, or
- the issue is genuinely open-ended and needs human direction

If surfaced, the action should be one click:
- `Add this missing area`
- `Keep current draft`

---

## 5. Execution Phases

### Phase 0: Stabilize the current pipeline

Goal: stop the worst regressions before deeper redesign.

#### Changes
- Fix discovery fail-open behavior in [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L3598).
- Stop normalizing the discovery profile downward in [src/core/discovery.ts](/Users/romano/Documents/refinely/refinely-app/src/core/discovery.ts#L1193).
- Wire AR depth from triage/discovery into pass 2 instead of the hardcoded standard plan in [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L2793).
- Narrow or disable auto-tighten in [src/core/story-generator.ts](/Users/romano/Documents/refinely/refinely-app/src/core/story-generator.ts#L2887) unless overlap is extremely obvious.
- Demote or hide the large `Missing something?` panel in [src/frontend/src/MainContent.tsx](/Users/romano/Documents/refinely/refinely-app/src/frontend/src/MainContent.tsx#L2759).

#### Acceptance criteria
- A high-ambiguity requirement can no longer silently skip follow-up just because follow-up questions were weak.
- Discovery profiles retain their intended depth signal.
- ARs become visibly more detailed when discovery signals high ambiguity or broad scope.
- The canvas no longer opens with a large, trust-undermining gap panel by default.

### Phase 1: Make discovery authoritative

Goal: replace the loose handoff between discovery and generation with a strong structured contract.

#### Changes
- Rework triage to emit must-cover behaviors and unresolved decision themes.
- Replace the current sufficiency behavior with a controller that returns `ask_followup`, `ready_to_generate`, or `ready_with_open_decisions`.
- Create a structured discovery synthesis artifact.
- Ensure this artifact is stored in session state and reused across generation and edits.

#### Acceptance criteria
- Follow-up discovery appears when ambiguity truly remains.
- Users experience at most one targeted follow-up round in the normal flow.
- The generator receives a structured view of what must be preserved.

### Phase 2: Rebuild decomposition around coverage obligations

Goal: stop meaningful workflow distinctions from being compressed away.

#### Changes
- Update the decomposition prompt in [src/core/prompts.ts](/Users/romano/Documents/refinely/refinely-app/src/core/prompts.ts) so must-cover behaviors and non-collapsible distinctions are first-class instructions.
- Require a coverage map from decomposition.
- Reduce consolidation bias where it hides independently testable or workflow-defining behavior.
- Keep the overlap detector only as a validator, not as a primary feature-shaping tool.

#### Acceptance criteria
- The generator can still produce compact feature sets, but it does not drop distinct create vs update vs classify vs resolve paths when they are materially different.
- Coverage obligations are either represented or explicitly left open.

### Phase 3: Rebuild AR generation around depth and preservation

Goal: make AR output materially stronger without adding extra user effort.

#### Changes
- Feed the real AR depth target into pass 2.
- Include must-cover behaviors and unresolved decisions in AR generation prompts.
- Ensure AR generation can preserve operationally important rules without drifting into system-specific implementation language.
- Use the post-generation coverage review as an internal repair trigger.

#### Acceptance criteria
- ARs are longer only when they need to be.
- Important rules, exceptions, and linkage behavior are preserved when implied by the requirement or clarified in discovery.
- Coverage review improves the draft before the user sees it.

### Phase 4: Simplify the canvas to light cleanup

Goal: reduce user burden and make changes reliable.

#### Changes
- Remove or heavily demote the big visible missing-coverage section.
- Make `add_requirements` truly append-only and feature-local instead of routing through full refine.
- Keep `add_feature` append-only.
- Reserve full rewrites only for explicit reorganization requests.
- If a late gap must be surfaced, present it as a one-click add action.

#### Acceptance criteria
- Asking to add one acceptance requirement does not rewrite unrelated features.
- Asking to add one missing feature appends it without restructuring the whole canvas.
- The canvas feels lighter because it is no longer compensating for upstream uncertainty.

### Phase 5: Add regression protection

Goal: stop future quality regressions from slipping through.

#### Changes
- Add end-to-end generation tests for representative ambiguous requirements.
- Add snapshot or contract tests for:
  - follow-up triggering
  - AR depth calibration
  - preservation of must-cover behaviors
  - append-only change operations
- Add telemetry for:
  - follow-up rate
  - repair-pass rate
  - user change frequency after generation
  - “add missing area” usage

#### Acceptance criteria
- The same requirement no longer oscillates wildly in structure and depth without a clear reason.
- Regressions like “fewer features, shorter ARs, less coverage” are caught before shipping.

---

## 6. UI and UX Implications

### Default experience
- Keep the main flow simple: prompt, questions, output.
- Keep user decisions minimal.
- Do not ask the user to choose between refine modes unless they explicitly want to reorganize the draft.

### Discovery UX
- Show when a follow-up round is happening and why.
- Explain that the system is validating completeness before generation, not just collecting random extra questions.

### Output UX
- Show a clean draft first.
- Only surface unresolved decisions or late missing areas when they remain genuinely unresolved after internal repair.
- If surfaced, keep the action simple and local.

---

## 7. What Should Remain Deterministic

These areas should stay code-driven:
- schema validation
- preserving unchanged features exactly
- append-only application of local changes
- UI routing and stage orchestration
- token usage accounting
- retry and timeout policy
- overlap and duplication warnings as advisory metadata only

These areas should be LLM-led:
- sufficiency
- follow-up discovery
- missing coverage inference
- decomposition
- AR depth and content decisions
- whether a distinction is materially meaningful

---

## 8. Recommended Build Order

1. Phase 0 hotfixes
2. Discovery authority rebuild
3. Decomposition coverage mapping
4. AR depth and internal repair
5. Canvas simplification
6. Regression harness and telemetry

This order restores quality first, then improves architecture, then reduces UI burden.

---

## 9. Success Metrics

The rebuild is successful when:
- users reliably see follow-up discovery when ambiguity remains
- outputs preserve depth without excessive feature sprawl
- fewer drafts need manual correction in the canvas
- append-only edits behave predictably
- the canvas feels lighter because it is used less for recovery
- the same input produces more stable quality across runs

---

## 10. Short Version

Refinely should not rely on visible end-of-flow gap detection to compensate for weak upstream generation.

The right direction is:
- stronger LLM-led discovery
- a real sufficiency and follow-up controller
- a structured discovery contract
- generation that must preserve coverage obligations
- internal repair before user exposure
- a smaller, more reliable canvas for cleanup only

