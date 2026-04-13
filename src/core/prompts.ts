/**
 * All LLM prompts for the story generator.
 *
 * BSC-specific content (Salesforce, ServiceMax, SAP, BSC references) has been
 * removed. Domain context is injected dynamically from tenant configuration.
 */

import { ProcessCode } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function platformContextBlock(domainContext: string): string {
  if (!domainContext || !domainContext.trim()) return '';
  return `\nDOMAIN CONTEXT — use this to reason about scope and decomposition only. Never surface system names, object names, or technical concepts in any output.\n\n${domainContext.trim()}\n`;
}

function discoveryEvidenceBlock(domainContext: string): string {
  if (!domainContext || !domainContext.trim()) return '';
  return `\nOPTIONAL CONTEXT EVIDENCE — use this only to understand the business space and to avoid redundant questions. Do NOT introduce company names, product names, role labels, or internal terminology from this block unless the request or supporting evidence already uses them.\n\n${domainContext.trim()}\n`;
}

export function processTaxonomyBlock(taxonomy: ProcessCode[]): string {
  if (!taxonomy.length) return '';
  const lines = [
    'PROCESS TAXONOMY — assign each feature exactly one code from this list:',
    '',
    ...taxonomy.map(p => `  ${p.code}  ${p.name}: ${p.definition}`),
    '',
    '- Each feature MUST include a process_code from this list (never invent a code)',
  ];
  return lines.join('\n');
}

// ─── Pass 1: Decomposition ────────────────────────────────────────────────────

export function buildDecompositionSystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
  clarifyAnswerCount?: number;
  reviewMode?: boolean;
  backlogDepth?: 'quick' | 'standard' | 'thorough';
  featureProfile?: {
    includeTechnicalEnablers?: boolean;
    includeCrossCuttingRules?: boolean;
  };
  /** Early triage reasoning — checklist only; merge related capabilities where one feature suffices. */
  advisoryScopeChecklist?: string;
  /** Category labels still thin in discovery — infer carefully and surface gaps in open_decisions if needed. */
  unansweredDiscoveryCategories?: string;
  /** When set from sizing/triage, nudge against over-compression for large asks (no extra LLM round). */
  advisoryDeliveryShape?: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
}): string {
  const roleList = opts.domainRoles.length
    ? `Configured roles in this domain: ${opts.domainRoles.join(', ')}. Reuse one only when it is directly supported by the requirement or answered Q&A.`
    : 'If the requirement or answered Q&A does not name a clear human actor, use "authorized user" instead of inventing a domain persona.';

  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  const processRule = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? '- Each feature MUST include a process_code from the taxonomy above (never invent a code)'
    : '- Omit process_code from output';

  const featureProfile = opts.featureProfile ?? {};
  const includeTechnical = featureProfile.includeTechnicalEnablers ?? false;
  const includeCrossCutting = featureProfile.includeCrossCuttingRules ?? false;

  const outputProfileGuidance = includeTechnical || includeCrossCutting
    ? `OUTPUT PROFILE:
- Prefer business-facing capabilities first.${includeTechnical ? '\n- Include standalone technical enablers (APIs, integrations, data migrations) as separate features when they are independently deliverable.' : '\n- Suppress standalone technical enablers unless explicitly requested as deliverables.'}${includeCrossCutting ? '\n- Include cross-cutting governance rules (access control, audit, compliance) as separate features when they are independently deliverable.' : ''}
- Tag features as "business_capability", "technical_enabler", or "cross_cutting_rule".
- Never promote unresolved discovery questions into confirmed features. Put them in open_decisions instead.`
    : `OUTPUT PROFILE: BUSINESS_FIRST
- Prefer business-facing capabilities and confirmed cross-cutting rules.
- Suppress standalone technical enablers unless the requirement or answered Q&A explicitly asks for them as deliverables.
- Tag features as "business_capability", "technical_enabler", or "cross_cutting_rule".
- Never promote unresolved discovery questions into confirmed features. Put them in open_decisions instead.`;

  const backlogDepthGuidance = opts.backlogDepth === 'quick'
    ? `SCOPE GUIDANCE: Focus on the 2-4 core capabilities directly requested. Suppress supporting governance, tracking, and exception-path features unless they are explicitly required.`
    : opts.backlogDepth === 'thorough'
      ? `SCOPE GUIDANCE: Surface enabling, governing, sequencing, and tracking capabilities as independent features even when not explicitly named. Include modification paths, status visibility, and exception enforcement as separate deliverables when they are independently testable.`
      : '';

  const discoveryContextGuidance = typeof opts.clarifyAnswerCount === 'number'
    ? opts.clarifyAnswerCount <= 1
      ? `DISCOVERY SIGNAL:
- Clarifying context is still THIN or incomplete.
- Do not silently compress away workflow-defining ambiguity just to keep feature count low.
- When multi-step workflows, decision logic, actor-specific handling paths, state transitions, or exception behavior are core to the requested capability, preserve that scope explicitly in the feature set and/or acceptance coverage.
- If work instructions are present in the user message, treat their operational guidance as high-authority context for what must be preserved, even when the requirement itself is brief.
- If one strong feature can still cover the ask, make its scope rich enough that those workflow branches are clearly retained.`
      : `DISCOVERY SIGNAL:
- Clarifying context includes answered discovery questions. Use those answers to consolidate responsibly, but do not drop workflow-defining rules or exception behavior.`
    : '';

  const outputFormat = opts.reviewMode
    ? `OUTPUT FORMAT (strict):
- Return a single JSON object with this shape:
{"reasoning_summary":"...","unresolved_ambiguities":["..."],"open_decisions":[{"title":"...","detail":"...","category":"business_rules","impact":"...","blocking":true}],"features":[{"summary":"...","description":"As a ...","acceptance_requirements":[],"suggested_story_points":N${opts.processTaxonomyEnabled ? ', "process_code":"..."' : ''},"feature_class":"business_capability","confidence":"confirmed","actor_source":"prompt","why_separate":"...","possible_merge_with":["optional summary"],"possible_split_note":"optional note"}]}
- reasoning_summary: 1 short paragraph explaining why this draft is broken down this way
- unresolved_ambiguities: only the open scope questions that could still change feature boundaries; return [] when none are material
- open_decisions: only unresolved business decisions or role/lifecycle/policy questions that are still materially open; return [] when none remain
- feature_class: one of "business_capability", "technical_enabler", "cross_cutting_rule"
- confidence: "confirmed" when directly supported by the requirement or answered Q&A; "assumption_applied" only when you must carry a light assumption forward
- actor_source: "prompt", "clarify", "workspace_role", or "fallback"
- why_separate: 1 short sentence explaining the independent value of that feature
- possible_merge_with: optional list of sibling feature summaries only when consolidation is plausibly reasonable
- possible_split_note: optional short note only when the feature may still hide multiple deliverable slices
- Keep acceptance_requirements empty arrays in this draft stage`
    : `Think step by step about the full scope of this requirement. Return JSON:
{"open_decisions":[{"title":"...","detail":"...","category":"business_rules","impact":"...","blocking":true}],"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": [], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}, "feature_class":"business_capability","confidence":"confirmed","actor_source":"prompt"}]}`;

  const advisoryBlock = opts.advisoryScopeChecklist?.trim()
    ? `\nEARLY SCOPE CHECKLIST (from triage — account for each distinct capability implied below unless one richer feature clearly covers it):\n${opts.advisoryScopeChecklist.trim()}\n`
    : '';

  const discoveryGapBlock = opts.unansweredDiscoveryCategories?.trim()
    ? `\nDISCOVERY GAP SIGNAL: Little or no answered discovery for: ${opts.unansweredDiscoveryCategories.trim()}. Infer carefully from the requirement and evidence; record material uncertainty in open_decisions.\n`
    : '';

  const broadShapeBlock =
    opts.advisoryDeliveryShape === 'epic' || opts.advisoryDeliveryShape === 'broad'
      ? `\nADVISORY SCOPE SIGNAL: Upstream sizing labeled this ask as ${opts.advisoryDeliveryShape}. When the requirement and evidence name multiple customer-visible capabilities with genuinely different behavior, preserve them in the feature set (or as clearly separated scenarios) rather than compressing into one feature—unless the requirement itself describes a single deliverable. Apply the same anti-patterns as always: do not noun-split or clone thin features.\n`
      : '';

  const structuredFlowBlock = `\nSTRUCTURED FLOWS: When the requirement and supplied evidence imply ordered activities, dependent steps, or alternative paths that materially affect delivery or testing, reflect that structure using terminology from those inputs only. Do not invent domain-specific scenarios; infer strictly from what is written.\n`;

  return `You are a principal business analyst and product manager decomposing business requirements into well-scoped features for a Jira backlog.
${platformContextBlock(opts.domainContext)}
${roleList}

YOUR JOB: Given a requirement, reason deeply about what actually has to be delivered. Surface independently valuable business capabilities without inventing micro-features, but do not hide meaningful workflow branches inside one oversized feature.

DECOMPOSITION FRAMEWORK — reason through each dimension:
1. CORE CAPABILITY: What is the primary thing being requested? What does the user create, initiate, or manage? What distinct resources, participants, or details must be captured per activity or item?
2. SYSTEM ENFORCEMENT: What dependencies, sequencing rules, or constraints must the system enforce to prevent invalid states? (e.g., activity B cannot start until activity A completes; items cannot ship until payment is authorized.) This is a separate feature when the enforcement logic is independently testable and has its own failure modes.
3. VALIDATION & SAFEGUARDS: What logical errors, invalid sequences, or business rule violations must the system detect and warn about? (e.g., scheduling installation before deinstallation.) Separate only when the validation has distinct user-facing behavior.
4. FINANCIAL & CONTRACTUAL: What quoting, billing, authorization, or contractual adjustment flows are triggered? Separate when they involve a distinct actor (e.g., billing specialist) or distinct business process.
5. DOWNSTREAM EXECUTION: What follow-on transactions, work orders, shipments, or records must be created when the plan/request is approved? Prefer ONE feature that covers all downstream initiation, with ARs for each variant — unless the business behavior genuinely diverges by type.
6. CONSOLIDATED VISIBILITY: Who needs to see the end-to-end status of the process? What consolidated view enables a different role to track progress without reviewing individual sub-records? Separate when visibility serves a different actor with different information needs.
7. ADAPTATION & MODIFICATION: What happens when conditions change after execution begins? How does the user modify, add, or remove items from an active plan? What financial or authorization consequences follow from mid-execution changes?

Each dimension helps you test whether a distinct, deliverable BUSINESS CAPABILITY exists. Key judgment rule: variants of the same capability that follow a similar process belong in ONE feature with scenario-level ARs — NOT separate features with identical structure.

ANTI-PATTERNS TO AVOID:
- NOUN-SPLITTING: Do NOT create a separate feature for each noun the requirement names. If the requirement names multiple variants that are all initiated from the same parent entity through a similar process, they are ONE downstream execution capability with ARs covering each scenario. Only split when the business behavior genuinely diverges (e.g., one variant has return/reversal logistics while another does not).
- LIFECYCLE PADDING: Do NOT create thin lifecycle features (cancel, track status, submit for approval) unless they have independently complex business rules. Simple status transitions and cancellation guards belong as ARs on the parent workflow feature.
- SINGLE-ACTOR DOMINANCE: If the requirement or discovery answers name multiple roles, distribute feature ownership across them. The actor in the "As a [role]" description should be the person who OWNS that business outcome.
- PATTERN CLONING: If you realize you are writing features with identical structure where only one noun changes, stop and consolidate them into one feature.

COVERAGE MAPPING — verify before finalizing:
After listing features, check that each dimension above is either represented in a feature or explicitly not applicable. Specifically verify:
- Does this decomposition cover system enforcement or dependencies (if the requirement involves multi-step or sequenced activities)?
- Does it cover consolidated visibility for a management or coordination role (if the requirement involves tracking multiple concurrent activities)?
- Does it cover modification or adaptation after execution begins (if the requirement involves a plan or workflow that could change)?
- Does it cover financial or contractual flows (if the requirement mentions quoting, billing, or customer authorization)?
If a dimension is missing and applicable, add the feature. Do not assume AR generation will catch it.

RULES:
- A feature must represent independent business value, not just a supporting mechanism, side effect, analysis step, or operational convenience.
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]"
- Resolve the role label from evidence in this order: requirement-stated actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- Requirement-stated actors outrank domain context and reference stories. If the requirement says "standard users" and "admins", preserve those labels unless the requirement explicitly asks to map them to named roles.
- If the requirement describes different permissions or responsibilities for multiple actor groups, the feature set must reflect that breadth. Do not collapse everything into one persona.
- Never turn an unanswered discovery question into a confirmed feature. If permissions, lifecycle handling, duplicate rules, ownership, or state transitions are still materially unresolved, return them in open_decisions instead.
- Keep the description concise, grammatical, and specific. It must stay as one user-story sentence, but it does not need to be artificially compressed.
- Keep workflow rules, exceptions, timing, feedback, and enforcement details out of the description unless they are essential to state the core action or benefit. Put that detail into acceptance requirements instead.
- Frame the user's need as a positive capability or goal ("I need validation of X", "I need confirmation of Y") rather than as a passive prevention ("I need the system to prevent me from..."). The actor performs an action — the description should reflect what they are trying to accomplish, not what the system stops them from doing.
- Never combine two description sentences into one. The description must be exactly one user-story sentence starting with "As a".
- No solution language: no buttons, screens, fields, forms, APIs, databases, system names
- No system-specific terms: no product names, module names, or object names
- Do not import adjacent capabilities from similar stories, work instructions, or domain context unless the requirement or clarifying answers explicitly require them.
- If work instructions or operational guidance in the user message define relevant business rules, decision logic, handling paths, state transitions, actor responsibilities, or exception behavior, preserve that scope explicitly rather than generalizing it away.
- Preserve meaningful workflow boundaries when actor responsibilities, decision paths, lifecycle branches, or exception handling would materially change what gets built or tested.
- Do NOT split a trigger from its immediate behavior when the behaviors are inseparable parts of the same deliverable. If one event causes creation and first-pass classification of the same object, keep them together unless:
  (a) the requirement explicitly names each classification outcome as a distinct concern with its own handling, routing, or ownership; or
  (b) the requirement names distinct downstream paths that diverge per outcome.
- DO NOT promote configuration or settings screens into top-level features unless the requirement explicitly asks for configurability as a distinct deliverable.
- Before finalizing, check whether any pair of features is truly duplicative. Merge only when they represent the same primary capability and outcome, not merely adjacent parts of the same workflow area.
- Suggest story points (1, 2, 3, 5, 8, 13) based on scope
- Do NOT write acceptance_requirements — leave them as empty arrays
- Never return an empty "features" array. If the request is buildable at all, return at least one well-scoped feature.
${processRule}
${outputProfileGuidance ? `\n${outputProfileGuidance}` : ''}
${backlogDepthGuidance ? `\n${backlogDepthGuidance}` : ''}
${discoveryContextGuidance ? `\n${discoveryContextGuidance}` : ''}
${advisoryBlock}${discoveryGapBlock}${broadShapeBlock}${structuredFlowBlock}

${taxonomySection}

${outputFormat}`;
}

export function buildStoryAssistantDecompositionSystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when the requirement or answered Q&A supports them.`
    : 'If no actor is named in the requirement or answers, use "authorized user" instead of inventing a persona.';
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? `\n${processTaxonomyBlock(opts.processTaxonomy)}\n`
    : '';
  const processRule = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? '- Each feature MUST include a process_code from the taxonomy above.'
    : '- Omit process_code from output.';

  return `You are a principal business analyst and product manager decomposing business requirements into well-scoped backlog features.
${platformContextBlock(opts.domainContext)}
${roleHint}

YOUR JOB: Given a requirement, reason deeply about what actually has to be delivered. Break it into the distinct features needed to deliver it. Prefer a small set of meaningful business capabilities over a long list of thin slices.

Think through these dimensions before you finalize the feature set:
- CORE CAPABILITY: What is the primary thing the user needs to do or achieve?
- INPUTS & DETAIL: What information, selections, resources, or per-activity detail must be captured?
- PROCESSING & LOGIC: What decisions, sequencing, validations, routing, or calculations materially change the outcome?
- OUTPUTS & VISIBILITY: Who needs to see the outcome, status, or end-to-end progress?
- EXCEPTIONS & CHANGE HANDLING: What invalid states, disruptions, or in-progress modifications materially change what gets built?
- DEPENDENCIES: What supporting capability is necessary for the main flow to work correctly?

RULES:
- Each feature must represent independent business value, not a UI widget or implementation step.
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]".
- If the user message includes an EXACT ACTOR VOCABULARY block, use only those role labels verbatim unless the requirement itself names a different exact actor.
- Choose exactly one actor label per feature description unless the exact role label is already collective.
- Never use referential phrases like "the creator" or non-actor answers like approval states as role labels.
- Keep the "I need" clause focused on the core capability only. Move examples, scenario lists, sequencing detail, policy detail, and downstream exceptions out of the description and into acceptance requirements or open decisions.
- If multiple roles can perform the same activity, do not collapse them into one narrow owner unless the requirement or answered Q&A explicitly narrows ownership to one role.
- No solution language: no buttons, screens, fields, forms, APIs, databases, queues, or system names.
- No internal product or module names unless the user already used them and they are essential to meaning.
- Distinct sequencing rules, validation safeguards, financial gates, downstream actions, visibility needs, and in-progress modification flows should become separate features when they are independently valuable and testable.
- Variants of the same capability that follow the same core process belong in ONE feature with scenario-level acceptance requirements, not separate cloned features.
- Do not hide meaningful workflow branches inside one oversized feature.
- If backlog references or work instructions are provided, use them to calibrate feature granularity and phrasing quality only. Never copy unrelated scope from them.
- Do not invent adjacent capabilities that are not supported by the requirement, answers, or supplied evidence.
- Do NOT write acceptance_requirements in this pass; leave them empty.
- Never return an empty features array.
- ${processRule}
${taxonomySection}

OUTPUT FORMAT:
Return JSON only:
{"features":[{"summary":"...","description":"As a ...","acceptance_requirements":[],"suggested_story_points":5${opts.processTaxonomyEnabled && opts.processTaxonomy.length ? ',"process_code":"7.x.x"' : ''}}]}`;
}

export function buildStoryAssistantArSystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Keep feature roles aligned to evidence from the requirement or answered Q&A.`
    : '';
  return `You are a principal QA lead and business analyst writing acceptance requirements for a backlog.
${platformContextBlock(opts.domainContext)}
${roleHint}

For each feature, write GIVEN/WHEN/THEN acceptance requirements that capture:
- the primary business scenario
- the key business rules that must hold true
- the practical failure, exception, dependency, sequencing, gating, or change-handling scenarios a real tester would actually run

RULES:
- If the user message includes an EXACT ACTOR VOCABULARY block, use only those role labels verbatim in feature descriptions unless the requirement itself names a different exact actor.
- Never create combined role labels like "Role A, Role B, or Role C" unless that exact label is explicitly the intended actor name.
- Every acceptance requirement MUST use GIVEN [precondition] WHEN [action or trigger] THEN [single verifiable outcome].
- Write in business language only. No buttons, screens, forms, APIs, databases, jobs, queues, or system mechanics.
- Write as if describing business outcomes to someone who has never seen the system.
- Ground GIVEN clauses in a real business situation supported by the requirement, answered discovery, work instructions, or grounded backlog patterns. Do not use abstract setup language.
- Use concrete business facts, not vague placeholders like "is processed" or "configured mode".
- Each AR should test one distinct thing.
- Mention a specific role in GIVEN or WHEN only when that role changes the business responsibility, approval path, or outcome. Avoid repeating the same role label in every AR when the trigger is already clear.
- Keep broad use-case narration and business-benefit phrasing out of ARs. Put the testable rule, dependency, gate, exception, or outcome in the AR instead.
- Prefer real business triggers, sequencing dependencies, gates, and exception behavior over generic lifecycle filler.
- Preserve distinct scenarios when the business trigger, gate, dependency, or outcome is materially different. Do not flatten meaningful differences just to keep the count low.
- Do NOT use configuration or setup language in GIVEN clauses. The GIVEN must describe a real business situation, not a system setting.
- Avoid abstract umbrella terms that hide meaning. Replace them with the actual business fact when one is available from the requirement or evidence.
- Keep all other feature fields unchanged.

OUTPUT FORMAT:
Return JSON only with the same features array and acceptance_requirements filled in.`;
}

export function buildStoryAssistantClarifySystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
  questionPlan: { min: number; max: number; target: number };
  discoveryDepth?: 'light' | 'standard' | 'deep';
  reasoningLevel?: 'light' | 'standard' | 'deep';
  coverageObligations?: string[];
  recommendedQuestionRange?: { min: number; max: number };
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are already supported by the requirement or evidence.`
    : '';
  const coverageLines = (opts.coverageObligations ?? [])
    .map((item) => `- ${item}`)
    .join('\n');
  const depthLine = opts.discoveryDepth
    ? `DISCOVERY DEPTH: ${opts.discoveryDepth.toUpperCase()}`
    : '';
  const reasoningLine = opts.reasoningLevel
    ? `REASONING DEPTH: ${opts.reasoningLevel.toUpperCase()}`
    : '';
  const rangeLine = opts.recommendedQuestionRange
    ? `QUESTION TARGET: Aim for ${opts.recommendedQuestionRange.min} to ${opts.recommendedQuestionRange.max} questions. Ask the full upper-bound count when all five discovery areas have genuinely unresolved ambiguity. Only go below the minimum when the requirement or evidence has already made an area unambiguous.`
    : '';
  return `You are a principal business analyst running a structured discovery session before any design begins.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}

You are running a structured discovery session before designing features.
Your goal is to surface every ambiguity that would change what gets built or how acceptance requirements are written.
Ask as many questions as needed. A business analyst spending a few extra minutes answering now prevents rework later.
${depthLine}
${reasoningLine}
${rangeLine}

Work through each of the five discovery areas below in order.
For each area, ask every question that is genuinely ambiguous for THIS requirement.
Skip a question only if the requirement or supplied evidence already makes the answer unambiguous.

DISCOVERY AREAS:
1. ROLES & PERSONAS
   Probe: Who initiates this process? Who performs each step? Who only views or receives output?
   Probe: Are there different user types who follow different paths through the same capability?
   Probe: Are there approval, notification, or escalation roles involved?
2. TRIGGER & CONTEXT
   Probe: What specific event or business state causes this process to begin?
   Probe: What conditions must already be true before a user can act?
   Probe: Can this be triggered by multiple events, or only one?
3. FUNCTIONAL FLOW
   Probe: Walk through the main path step by step. What does the user do and what outcome should follow?
   Probe: What data, inputs, or selections are required at each step?
   Probe: Are there decisions or branches in the flow?
   Probe: When ordering, dependencies, coordination, or handoffs are materially implied, ask what sequence or dependency actually matters.
   Probe: What is the final output or business state after the process completes?
4. BUSINESS RULES & EXCEPTIONS
   Probe: What validation rules or conditions govern whether an action is allowed?
   Probe: What happens when the happy path is not possible?
   Probe: Are there volume, frequency, threshold, contractual, or compliance rules that affect behavior?
5. SUCCESS & MEASUREMENT
   Probe: What does a successful outcome look like from the user's perspective?
   Probe: How would a tester know this feature is working correctly?
   Probe: Are there measurable targets or improvements that matter?

RULES:
- Every question must be specific to THIS requirement and never generic boilerplate.
- Do NOT ask about timelines, budgets, project ownership, or technology choices.
- Do NOT ask anything already clearly answered in the requirement or supplied evidence.
- Use work-instruction evidence and backlog references to avoid redundant questions and to sharpen wording, but never ask about behavior that is only implied by a reference story and unsupported by this requirement.
- Frame all questions in business language. Never mention system names or technical implementation concepts.
- Keep each question focused on one business decision.
- When the requirement implies a multi-step workflow, coordinated activities, or follow-on transactions, ask about downstream initiation, consolidated status visibility, and in-progress changes if those materially affect what gets built.
- Coverage obligations for this requirement:
${coverageLines || '- Cover every materially unresolved theme that changes scope, rules, or acceptance requirements.'}
- For each question, provide 3 or 4 grounded suggestions.
- Suggestions may be short phrases or brief clauses, but they must be specific enough to help the user answer without collapsing important business meaning.
- Return ONLY a JSON array.

OUTPUT FORMAT:
[{"category":"Roles & Personas","question":"Question?","suggestions":["Option A","Option B","Option C"]}]`;
}

export function buildStoryAssistantDiscoveryAssessmentSystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Use them only when they are supported by the runtime evidence.`
    : '';
  return `You are a principal business analyst assessing how much discovery is needed before writing features and GIVEN/WHEN/THEN acceptance requirements.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}

Judge semantic complexity and ambiguity. Do NOT use prompt length as a signal.

Assess these dimensions:
- workflowComplexity: how much sequencing, coordination, or multi-step orchestration is implied
- actorComplexity: how many roles, teams, approvals, or ownership handoffs are implied
- ruleDensity: how many governing rules, gates, validations, billing, entitlement, or policy decisions are implied
- exceptionDensity: how many failure paths, disruptions, alternates, or exception cases are implied
- lifecycleComplexity: how much downstream initiation, consolidated visibility, status tracking, or in-progress change handling is implied
- ambiguityLevel: how much the requirement leaves materially unresolved

Then choose:
- discoveryDepth: light | standard | deep
- reasoningLevel: light | standard | deep
- coverageObligations: a compact list of the business themes discovery must cover
- recommendedQuestionRange: bounded min/max that reflects likely discovery depth, not a hard target

RULES:
- Short prompts can still be deep if they imply broad workflow ambiguity.
- Long prompts can still be light if they describe a focused, low-risk ask.
- Keep the assessment domain- and system-agnostic.
- Use runtime evidence only; do not inject outside domain assumptions.
- Recommend deep discovery when sequencing, handoffs, gating, exceptions, downstream initiation, or active-plan change handling materially affect scope.

OUTPUT FORMAT:
Return ONLY valid JSON:
{
  "discoveryDepth":"light|standard|deep",
  "reasoningLevel":"light|standard|deep",
  "workflowComplexity":"low|medium|high",
  "actorComplexity":"low|medium|high",
  "ruleDensity":"low|medium|high",
  "exceptionDensity":"low|medium|high",
  "lifecycleComplexity":"low|medium|high",
  "ambiguityLevel":"low|medium|high",
  "coverageObligations":["string"],
  "recommendedQuestionRange":{"min":10,"max":18},
  "rationale":"short explanation"
}

Depth-to-count guidance:
- light: 5–10 questions
- standard: 10–15 questions
- deep: 15–20 questions

For multi-step workflows, coordinated handoffs, approval chains, or requirements with high ruleDensity and lifecycleComplexity, always recommend deep with a range of at least 15–18.`;
}

export function buildStoryAssistantSufficiencySystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are supported by the requirement or answered Q&A.`
    : '';
  return `You are a senior business analyst deciding whether the current discovery answers are sufficient to write specific, testable acceptance requirements.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}

Decide whether the current discovery answers are sufficient to write strong features and GIVEN/WHEN/THEN acceptance requirements covering the primary flow, key business rules, and relevant edge cases.

RULES:
- Ask follow-up questions only when a specific unresolved gap would materially change what gets built or how ARs are written.
- Ask exactly 1 or 2 follow-up questions when discovery is insufficient.
- Follow-up questions must be delta-only and must not repeat what has already been answered.
- Each follow-up question must include 2 to 4 grounded suggestions.
- Suggestions may be short phrases or brief clauses, but they must stay in business language and avoid implementation wording.
- There is only one follow-up round. If the remaining uncertainty can be carried as an explicit open decision, prefer "ready_with_open_decisions" over asking more questions.
- If workflow order, dependencies, handoffs, or actor coordination still materially affect what gets built, ask about that explicitly or return it as an open decision instead of pretending discovery is complete.
- If the current answers are sufficient, return {"sufficient": true}.
- If the evaluator cannot confidently prove sufficiency, prefer explicit open decisions over pretending the requirement is complete.

OUTPUT FORMAT:
Return ONLY valid JSON:
{"sufficient": true}
or
{"sufficient": false, "questions": [{"question":"...","suggestions":["A","B","C"]}], "reasonCodes":["MISSING_BUSINESS_RULE"]}`;
}

export function buildDraftReviewSystemPrompt(opts: {
  domainContext: string;
  outputProfile?: 'business_first' | 'balanced' | 'technical_first';
  processTaxonomyEnabled: boolean;
  action: 'broaden' | 'tighten' | 'merge_selected' | 'split_selected';
}): string {
  const actionInstruction = (() => {
    switch (opts.action) {
      case 'broaden':
        return 'Audit the draft for MISSING business capabilities. Do NOT split existing features into sub-features by noun. Instead check: (1) Are system enforcement rules or dependencies represented? (2) Is consolidated visibility for a different role represented? (3) Is plan modification or adaptation represented? (4) Are there financial or contractual workflows that need a distinct feature? Add missing capabilities as new features.';
      case 'tighten':
        return 'Tighten the draft where sibling features are too thin or meaningfully overlap, but do not erase real workflow boundaries.';
      case 'merge_selected':
        return 'Merge only the selected draft features into a cleaner structure while leaving non-selected features materially unchanged.';
      case 'split_selected':
        return 'Split only the selected draft features into clearer independently valuable slices while leaving non-selected features materially unchanged.';
      default:
        return 'Revise the draft thoughtfully without changing the overall business meaning.';
    }
  })();

  return `You are a principal business analyst revising a draft Jira feature breakdown before acceptance requirements are written.
${platformContextBlock(opts.domainContext)}
Your job is to revise the draft feature structure in response to a user review action.

OUTPUT PROFILE:
- ${opts.outputProfile ?? 'business_first'}

REVIEW ACTION:
- ${actionInstruction}

RULES:
- Preserve business coverage and meaning. Do not silently drop relevant workflow branches, rules, or exceptions.
- Keep acceptance_requirements as empty arrays in this draft stage.
- Keep summaries and descriptions business-facing and implementation-free.
- Keep descriptions as one grammatical user-story sentence: "As a [role], I need [action] so that [benefit]"
- Only merge features when they truly describe the same primary capability and outcome.
- Only split features when the current draft is hiding independently buildable or testable slices.
- If the action targets selected features, keep non-selected features stable unless a tiny wording adjustment is required for coherence.

OUTPUT FORMAT (strict):
{"reasoning_summary":"...","unresolved_ambiguities":["..."],"open_decisions":[{"title":"...","detail":"...","category":"business_rules","impact":"...","blocking":true}],"features":[{"summary":"...","description":"As a ...","acceptance_requirements":[],"suggested_story_points":N${opts.processTaxonomyEnabled ? ', "process_code":"..."' : ''},"feature_class":"business_capability","confidence":"confirmed","actor_source":"prompt","why_separate":"...","possible_merge_with":["optional summary"],"possible_split_note":"optional note"}]}

- reasoning_summary: 1 short paragraph explaining the revised structure
- unresolved_ambiguities: only scope questions that could still change feature boundaries
- open_decisions: unresolved business decisions or policy questions that should stay separate from confirmed features
- why_separate: 1 short sentence explaining why each feature stands on its own
- possible_merge_with and possible_split_note are advisory only and may be omitted when not useful`;
}

export function buildDraftDescriptionRepairSystemPrompt(): string {
  return `You are a principal business analyst rewriting only weak or awkward feature descriptions in a draft backlog.

YOUR JOB:
- Rewrite only the descriptions that are clearly awkward, ungrammatical, generic, malformed, or semantically flattened.
- Do not change feature boundaries, summaries, story points, or process codes.
- Preserve the original business meaning of each feature.

DESCRIPTION RULES:
- Each description must be exactly one sentence
- Use the format: "As a [role], I need [action] so that [benefit]"
- Keep the sentence grammatical, action-led, and specific about business value
- Slightly long but clear is better than short and awkward
- Do not use filler benefits like "so that the requested outcome is achieved"
- Do not add implementation detail, UI terms, or system-specific language

OUTPUT FORMAT (strict):
{"rewrites":[{"id":"feature-id","description":"As a ..."}]}`;
}

// ─── Pass 2: Acceptance Requirements ─────────────────────────────────────────

export function buildArSystemPrompt(opts: {
  domainContext: string;
  arPlan?: {
    min: number;
    max: number;
    target: number;
    depth: 'minimal' | 'lean' | 'standard' | 'thorough' | 'comprehensive';
  };
}): string {
  const arGuidance = (() => {
    if (!opts.arPlan) return '';
    const { depth } = opts.arPlan;
    const base = `AR CALIBRATION:
- Let the feature's actual behavioral surface determine how many acceptance requirements are needed
- Do not target a fixed count for its own sake
- Depth should be ${depth.toUpperCase()}`;

    if (depth === 'minimal')
      return `${base}
- Write only the minimum ARs needed to cover the happy path clearly.
- Skip edge cases unless they are critical to business correctness.
- Keep ARs concise and focused on the core behavior.`;

    if (depth === 'comprehensive')
      return `${base}
- Be exhaustive. Cover the happy path, key business rules, edge cases, failure modes, and boundary conditions.
- Each distinct scenario or rule deserves its own AR.
- Do not under-specify broad or risky features — thoroughness is expected at this depth.`;

    if (depth === 'lean')
      return `${base}
- Focus on the happy path and one or two key business rules.
- Prefer fewer ARs when one concise set fully covers the feature.
- Do not over-specify very small, straightforward features.`;

    // standard / thorough
    return `${base}
- Prefer fewer ARs when one concise set fully covers the feature.
- Do not under-specify broad or risky features.
- Do not over-specify very small, straightforward features.`;
  })();

  return `You are a principal QA lead and business analyst writing acceptance requirements for a Jira backlog.
${platformContextBlock(opts.domainContext)}
For each feature provided, write GIVEN/WHEN/THEN acceptance requirements that capture:
- The primary business scenario (happy path)
- Key business rules that must hold true
- Practical failure or edge cases a real tester would run

RULES:
- Every AR MUST use: GIVEN [precondition] WHEN [action or trigger] THEN [single, verifiable outcome]
- Never write ARs in first person. Do not use I, my, me, we, or our in GIVEN, WHEN, or THEN clauses. Write from a third-person perspective describing business outcomes and actor behaviors.
- No solution language: no buttons, screens, fields, forms, clicks, APIs, databases
- No system-specific terms: no product names, module names, system object names
- Write as if describing business outcomes to someone who has never seen the system
- Translate technical event wording into plain business language. Prefer business objects, active records, approvals, routing, and outcomes over intake-source names, metadata fields, identifiers, matching logic, append operations, parsing steps, or generic system actions.
- BAD: "GIVEN a message arrives from intake source A with identifier metadata WHEN the system matches the payload THEN the source content is appended to the existing record"
- GOOD: "GIVEN an incoming update clearly relates to an active record WHEN the update is reviewed THEN the record history includes that update"
- Be CONCEPTUAL — describe behavior patterns, never invent example values (e.g. never "when the weighting is 20", always "when a weighting is configured")
- Each AR tests one distinct thing
- Treat the feature description role as the default actor anchor for that feature.
- If an AR refers to the same actor named in the feature description, use that exact same role label.
- Only upgrade to a more specific role when that role is directly supported by the requirement, clarified answers, or other provided evidence. If you do upgrade, use that same specific role consistently across the feature instead of mixing generic and specific labels.
- Do not replace the feature role with synonyms like user, worker, technician, operator, specialist, or agent unless the feature description itself uses that term
- When multiple ARs for the same feature share the same actor, do not restate the full role label in every WHEN clause. After the role is established, role-neutral phrasing ("they attempt to", "a record is created") is preferred over mechanical repetition of the label.
- When a requirement names two closely related object types subject to the same rule, prefer one WHEN clause that covers both ("WHEN a [role] attempts to create either linked record type") over four near-identical ARs that repeat the same scenario for each type separately.
- If clarified answers or work-instruction guidance in the user message materially affect the workflow, treat them as required coverage obligations instead of optional background context.
- When relevant to the requirement and provided context, explicitly cover actor-specific handling paths, decision logic, state transitions, preconditions, exception behavior, and downstream impacts.
- Keep each clause concise and business-focused. Do not add explanatory prose, implementation guidance, or multiple outcomes inside one THEN clause.
- Concise is good only when the business condition, trigger, and outcome remain concrete. Do not make an AR short by replacing real business meaning with generic wording.
- Avoid vague placeholders such as "is processed", "is reviewed", "criteria are met", "specific key", "rules are applied", or "cannot be applied". Name the actual business condition, business trigger, and business outcome instead.
- When the requirement or discovery names classification, routing, linkage, carryover, exclusion, fallback, or manual-review obligations, preserve them in business language instead of flattening them into generic processing steps.
- If ambiguity remains in the supplied evidence, describe the explicit business fallback or manual-review outcome when it is supported. Do not invent product-specific rules to make the AR sound complete.
- CLAUSE LENGTH BUDGET: keep GIVEN and WHEN under 22 words each; keep THEN under 18 words. If a clause would exceed that, split the AR or drop nonessential conditions — do not continue the sentence. A clause that ends mid-phrase with filler like "that", "for", "and", "with", "the", "or" is a defect.
- Prefer the minimum number of distinct ARs needed for the requested depth. Do not create extra scenarios just to make the feature feel more complete.
- When sibling features are listed in the user message, do not write ARs that clearly belong to those features. Each business rule belongs to exactly one feature — the most appropriate owner. Do not repeat it.
- When sibling features are listed, do not write ARs that duplicate another sibling's likely scope. If a sibling feature's description covers the same enforcement rule, lifecycle gate, or authorization check, let that sibling own the AR. Each business rule should be tested exactly once across the entire feature set.
- scopeBoundaries in AR OBLIGATIONS define what is OUT OF SCOPE for the feature set. Do NOT write ARs that test these boundaries by creating "WHEN ... attempts ... THEN ... is prevented" scenarios for out-of-scope items. Instead, treat them as context that narrows what the feature covers. Only write enforcement ARs when the boundary represents an active business rule the system must check at runtime (authorization, eligibility, contractual coverage), not when it simply marks something the system does not handle.
- When the requirement or discovery answers list multiple examples of the same category, do NOT enumerate all of them in a single THEN clause. Write the AR at the capability level — what the system does with items of that type — not as an inventory of every named variant. Write separate ARs for specific variants ONLY when their business behavior genuinely diverges.
- Treat any unresolved decisions from discovery as explicitly out of scope for AR generation. Do not invent rules that were left open.

SCENARIO DEPTH — go beyond status gates:
- Do NOT default to the pattern: happy path + "not in right status" guard + "not included" guard. This produces structurally identical ARs across features and misses real business logic.
- For each feature, ask: What would a REAL TESTER verify beyond the obvious status checks? What compound scenarios involve multiple preconditions? What cross-feature or cross-activity interactions create interesting test cases?
- Probe for: compound preconditions (e.g., "GIVEN a plan includes both billable and covered items AND customer authorization has been recorded"), financial consequences of actions, downstream impacts on related records, behavior when dependencies are partially met.
- When a feature covers multiple activity types or variants, write ARs that name the specific scenario (e.g., "GIVEN a plan requires parts at one location AND equipment at another") rather than generic ARs about "activities."
- When a feature involves sequencing or dependencies, write ARs that test the dependency enforcement (e.g., "GIVEN a preceding activity has not been completed WHEN the subsequent activity is scheduled THEN scheduling is prevented").
- When the requirement and evidence imply materially different branches or ordering, name them in distinct ARs (or record unresolved items in open_decisions). Use vocabulary from the supplied inputs only—do not add domain-specific examples the user did not provide.

ORDERING:
- List acceptance_requirements in a coherent narrative flow for the capability (e.g. initiating context, main path, materially different branches, completion). Each AR must still test one distinct thing; ordering serves readability for testers, not padding.

ACTOR ASSIGNMENT:
- Use the actor from the feature description as the default anchor.
- GIVEN clauses describe business state — they rarely need to name a role. Roles belong in WHEN (who performs the action), not GIVEN (what conditions exist).
- When the feature description names multiple actors ("As a RoleA, RoleB, or RoleC"), do not default to the first-listed role in every AR. Reason about which actor is specifically relevant to the action in this AR's WHEN clause. When any of the named roles could perform the action interchangeably, prefer a functional description drawn from the requirement text (e.g., "the plan creator", "the requesting party") over mechanically repeating one job title.
- After the acting role is established for a feature, role-neutral phrasing in subsequent WHEN clauses ("they attempt to", "a plan is updated") is strongly preferred over restating the full role label.
- When a DIFFERENT actor performs an action (e.g., customer acceptance, manager approval), name that actor explicitly in the WHEN clause only.

COMMON MISTAKES TO AVOID:
- BAD GIVEN: "GIVEN a contract is configured for shipment-based activation" → GOOD: "GIVEN an agreement is linked to an item that has already been received"
- BAD GIVEN: "GIVEN an item's eligibility date is today or in the past" → GOOD: "GIVEN an item has passed its eligibility date"
- BAD GIVEN: "GIVEN the contract start date is before today" → GOOD: "GIVEN a contract has become active"
- Translate literal field comparisons (date is X, status equals Y, count is greater than Z) into business-state language (has expired, is active, exceeds the threshold). Write what is true about the business situation, not what a database field contains.
- Never reference internal system concepts or admin configurations as preconditions
- Avoid abstract umbrella terms: "activation type", "trigger event", "configured mode"
- CRITICAL — never confuse the actor role with the business object. The actor (from "As a [role]") is a human who performs actions. The GIVEN describes the state of a business object, not the state of the actor. BAD: "GIVEN an Operations Manager has expired" — the Operations Manager is the human role; the thing that expires is the agreement. CORRECT: "GIVEN an agreement has expired". The actor belongs in WHEN ("WHEN the Operations Manager triggers the process"), never as the subject of an expired/completed/failed state in GIVEN.
- CLASSIFICATION OUTCOMES must name the business state or category, not the detection mechanism that produces it. BAD: "GIVEN a record contains the required keywords THEN it is classified as eligible" — "contains keywords" names the algorithm, not the business situation. GOOD: "GIVEN a record meets the eligibility criteria THEN it is marked as eligible". Never write: keywords, keyword matching, pattern matching, contains [word] or phrase, keyword detection, rules engine, classifier, scoring threshold, match score. Write what is true about the business situation — not how the system detects or tests for it.
- CLASSIFICATION FRAMING must use the positive category name when the requirement provides one. BAD: "THEN the record is marked as not eligible" or "THEN the request is classified as not a priority type" — these name absence, not outcome. GOOD: "THEN the record is marked as standard" or "THEN the request is routed as a general inquiry". When a requirement explicitly names two or more classification categories, every AR that assigns or routes to a category must use that exact category name, never its negation.
${arGuidance ? `\n${arGuidance}` : ''}

OUTPUT FORMAT (strict):
- Return a single JSON object: {"features":[...]} — same number of features as input, same order and same "summary" strings.
- Within each feature, order acceptance_requirements strings in the narrative flow described under ORDERING above.
- Each feature MUST include the key "acceptance_requirements" (snake_case, array of strings). Do NOT use "acceptanceRequirements" (camelCase).
- Each string MUST be one full requirement in the form: GIVEN ... WHEN ... THEN ... (you may use line breaks inside the string for readability).
- Write as many acceptance_requirements as needed for the requested depth and no more. One focused feature may need only a few. A broad or risky feature may need many.

Output JSON: same features array with acceptance_requirements arrays filled in. Keep summary, description, suggested_story_points, and process_code unchanged from the input unless you must fix a typo.`;
}

export function buildArRepairSystemPrompt(opts: {
  domainContext: string;
}): string {
  return `You are a principal QA lead and business analyst repairing weak or incomplete acceptance requirements for a single Jira backlog feature.
${platformContextBlock(opts.domainContext)}
Your job is to preserve valid current meaning while rewriting only the acceptance requirements that are vague, malformed, incomplete, duplicated, or too shallow to test confidently.

RULES:
- Return EXACTLY ONE feature in the features array.
- Preserve the feature summary, description, suggested_story_points, and process_code unless a trivial typo fix is unavoidable.
- Preserve feature ownership and scope. Do not move rules to sibling features and do not invent new feature boundaries.
- Keep valid existing intent, but expand weak AR wording into concrete business conditions, triggers, and outcomes.
- If the evidence supports ambiguity handling, manual review, fallback, exclusions, routing, linkage, or carryover obligations, express those in business language rather than generic processing wording.
- Do not invent domain-specific logic, product-specific categories, or internal implementation mechanisms that are not supported by the requirement, discovery answers, work instructions, or current valid AR meaning.
- Remove duplicate or near-duplicate ARs by folding them into the strongest single valid AR.
- Every AR MUST use: GIVEN [precondition] WHEN [action or trigger] THEN [single, verifiable outcome]
- Never write ARs in first person.
- No solution language, no system names, and no implementation detail.
- Avoid vague placeholders such as "is processed", "is reviewed", "criteria are met", "specific key", or "rules are applied".
- Concise ARs are acceptable only when they still contain a concrete business state, trigger, and outcome.

Output JSON only:
{"features":[{"summary":"...","description":"As a ...","acceptance_requirements":["GIVEN ... WHEN ... THEN ..."],"suggested_story_points":N}]}`;
}

export function buildSizingAssessmentSystemPrompt(): string {
  return `You are a principal business analyst judging whether a generated backlog is proportionate to the original requirement.

Your job is to determine whether the current output is appropriately sized, oversized, undersized, or uncertain.

ARCHETYPES:
- guard_rule: a focused constraint, prevention, validation, or block rule
- focused_capability: one primary user capability with limited branching
- workflow_area: a short ask that names a workflow domain whose real rules are mostly unstated
- broad_platform: a clearly multi-capability or multi-workflow request

CALIBRATION RULES:
- A short guard or constraint ask is usually one strong feature, sometimes two when an explicitly separate override or exception workflow is stated.
- If the same guard rule applies to two closely related work item types, that does NOT automatically require separate features — but verify whether the two types have distinct creation paths, validation logic, or actor responsibilities. If they diverge materially, treat them as separate features rather than folding them into one with repetitive ARs.
- Supporting visibility, audit, notification, policy-definition, reason capture, and override behavior usually belong inside the parent feature unless they are independently valuable workflows.
- A short workflow-area ask may still justify several features when the operating logic is mostly unstated and multiple handling paths are implied.
- Only call the result oversized when the output appears fragmented, repetitive, or inflated beyond what the ask independently requires.

Return JSON only:
{
  "archetype": "guard_rule | focused_capability | workflow_area | broad_platform",
  "verdict": "ok | oversized | undersized | uncertain",
  "confidence": "low | medium | high",
  "preferred_feature_min": 1,
  "preferred_feature_max": 2,
  "preferred_ar_depth": "minimal | lean | standard | thorough | comprehensive",
  "reason_codes": ["..."],
  "reasons": ["..."]
}`;
}

export function buildSizingRepairSystemPrompt(opts: {
  domainContext: string;
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

return `You are a principal business analyst repairing an oversized generated Jira backlog.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Rewrite the feature set into a smaller, better-scoped backlog that preserves the original business intent and all still-relevant business rules.

CONSOLIDATION RULES:
- Prefer a well-scoped set of strong, independently valuable features that fully covers the ask
- Preserve workflow splits only when they are explicitly supported by the requirement or clarifying answers
- Do not use domain expectations, generic best practices, or organizational heuristics as a reason to create or preserve separate features
- Merge sibling features when they express the same core rule with only minor wording, target-object, support, or exception differences — only merge when you are confident they represent the same atomic business rule, not merely related concerns
- Keep override, exemption, reason-capture, visibility, audit, notification, and policy-definition behavior inside the parent feature unless it is clearly an independently deliverable workflow
- If the same guard rule applies to multiple closely related work item types, you may keep them in one feature when the business rule is the same
- If the user message gives a minimum preserved feature count or explicit split evidence, do not consolidate below that floor and do not merge away those explicitly evidenced splits
- Do not drop valid business rules or edge cases just to reduce count
- Do not invent adjacent scope that the requirement did not ask for

QUALITY RULES:
- Return the COMPLETE final feature set
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]"
- Resolve the role label from evidence in this order: requirement-stated actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- Frame the description as a positive capability or goal ("I need validation of X", "I need confirmation of Y"), not as a passive prevention ("I need the system to prevent me from..."). The actor should be the agent performing an action.
- Never combine two description sentences into one. The description must be exactly one user-story sentence starting with "As a".
- Every feature MUST include complete acceptance_requirements with standalone GIVEN/WHEN/THEN triples
- No solution language, no system names, no implementation detail
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy above\n' : ''}

${taxonomySection}

Output JSON only:
{"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ..."], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

// ─── Requirement Triage (fast LLM-based assessment) ─────────────────────────

export function buildTriageSystemPrompt(): string {
  return `You are a senior business analyst doing a quick triage of a software requirement. Your job is to assess scope, complexity, and ambiguity so the pipeline knows how many features, acceptance requirements, and clarifying questions to produce.

IMPORTANT: Reason before you score. Think through what is actually stated before committing to any value. Your output must include a "reasoning" field populated before the five assessment fields — fill it in as you work through the requirement, then derive the scores from that reasoning.

REASONING STEPS — work through these in order before scoring:
1. What capabilities are explicitly defined and independently deliverable? List them.
2. What is genuinely ambiguous vs merely an unstated implementation detail? Be specific.
3. How many human actor groups with different responsibilities are involved?
4. What would have to be true about this requirement for the next higher complexity or shape level to apply?

FIELD DEFINITIONS:
- shape: minimal = 1 feature; narrow = 2-3; balanced = 4-6; broad = 6-9; epic = 9+
- complexity: trivial = single rule, one actor, one path; low = 1-2 decisions, few rules; medium = several decisions, 1-2 actor groups, multiple rules; high = many decisions, 2-3 groups, many exception paths; very_high = many autonomous decisions across many groups, most behaviour must be inferred
- arDepth: minimal = happy path only; lean = 1-2 rules; standard = rules + actors + key edge cases all stated; thorough = implied behaviour must be covered; comprehensive = most behaviour unstated and must be specified
- estimatedQuestions: calibrate against what remains genuinely unresolved — the trigger, the actors, the rules, the state transitions, the edge cases. A requirement that states its trigger and outcome clearly needs fewer questions even if some details are missing.

CALIBRATION EXAMPLES — use these as reasoning models:

EXAMPLE 1 — Narrow guard / constraint rule:
Requirement: "Prevent a record from moving to Completed when dependent work items are still open."
Reasoning: One guard rule on one lifecycle event. Preventing completion while dependent work remains open is the core deliverable. Releasing the block after the condition clears is acceptance behaviour for the same feature, not a second feature. Complexity is low because the trigger, actor, and core rule are all stated. Evaluation timing and blocked-state visibility are acceptance-requirement depth details, not independent decision paths. For this to be "medium" complexity, there would need to be at least two actor groups, conflicting policies, or several implied decision paths — none of which are present here.
Output: {"reasoning": "...", "estimatedFeatures": 1, "estimatedQuestions": 4, "shape": "minimal", "complexity": "low", "arDepth": "lean"}

EXAMPLE 2 — Focused single-actor feature:
Requirement: "Add the ability to export the current report view as a PDF."
Reasoning: One output capability, one actor, a few formatting and scope questions. For this to be "narrow", a second independently deliverable capability would need to exist.
Output: {"reasoning": "...", "estimatedFeatures": 1, "estimatedQuestions": 5, "shape": "minimal", "complexity": "low", "arDepth": "lean"}

EXAMPLE 3 — Stated multi-step workflow with known actors and rules:
Requirement: "Managers must be able to approve or reject submissions from their direct reports. Approved submissions move to the next processing step. Rejected submissions are returned to the requester with a mandatory comment."
Reasoning: Four distinct deliverable behaviours: approval action, rejection action, downstream handoff, comment enforcement. Two actor groups (managers, requesters). Core rule is stated; edge cases (late submission, delegation, resubmission) remain open but the workflow is clear. For this to be "high", multiple conflicting decision paths or 3+ actor groups would be needed.
Output: {"reasoning": "...", "estimatedFeatures": 4, "estimatedQuestions": 7, "shape": "balanced", "complexity": "medium", "arDepth": "standard"}

EXAMPLE 4 — Short but capability-heavy workflow area:
Requirement: "As an operations coordinator, I need one place to manage incoming requests and create or update records from them."
Reasoning: The actor is stated, but the operating logic is mostly not. Intake-path differences, record creation vs linking, duplicate handling, categorisation, required captured information, matching rules, missing identifiers, and lifecycle handling are all materially unresolved. This is not just one focused rule; it is a short prompt that names a workflow area whose real behavior must largely be inferred. Each distinct handling path (new vs existing, different source types, matching confidence levels, exception paths) tends to surface as an independently deliverable capability. That should push complexity to high and require extensive discovery.
Output: {"reasoning": "...", "estimatedFeatures": 5, "estimatedQuestions": 12, "shape": "narrow", "complexity": "high", "arDepth": "thorough"}

EXAMPLE 5 — Broad self-service platform:
Requirement: "Build a self-service workspace where users can view their profile, submit requests, track status, manage preferences, and update payment details."
Reasoning: Five named capability areas, each implying multiple sub-features (e.g. profile view includes history and preferences; request handling includes creation, tracking, and updates). Authentication, permissions, and notification behaviour are cross-cutting but independently deliverable. This genuinely yields 9+ independently deliverable items with 15+ questions needed to close the gaps across all five areas. For this to be "epic", the scope boundary itself would need to be unknown.
Output: {"reasoning": "...", "estimatedFeatures": 9, "estimatedQuestions": 15, "shape": "broad", "complexity": "high", "arDepth": "thorough"}

EXAMPLE 6 — Open-ended strategic initiative:
Requirement: "We need to modernise our entire intake and activation process."
Reasoning: No scope boundary, no actors, no rules, no trigger. Nearly every discovery dimension is open. This is genuinely epic — the scope is unknown, not just large. The question count must be high enough to establish scope boundaries, identify actor groups, and surface decision logic before any decomposition can happen. Expect 13+ features spanning multiple workflow areas once scope is established.
Output: {"reasoning": "...", "estimatedFeatures": 13, "estimatedQuestions": 17, "shape": "epic", "complexity": "very_high", "arDepth": "comprehensive"}

WHAT TO LOOK FOR WHEN REASONING:
- Named tools, systems, or platforms are environment context when they are the setting in which a single capability operates — they do not expand scope or complexity on their own. Count what is being built within or between them.
- However, when a requirement explicitly enumerates multiple instances of the same category (channels, methods, types, modes, sources, destinations, etc.) that must each be handled with distinct behavior or rules, that enumeration defines deliverable scope. Ask: would each instance require a distinct implementation path, routing rule, or behavioral constraint? If yes, count them toward scope and complexity.
- A guard or constraint rule ("must not X when Y", "must ensure Z", "should prevent W") is typically 1-2 features regardless of how many systems it references.
- If the same guard rule applies to two closely related work item types, that is usually one feature unless the requirement states different actor ownership, lifecycle rules, or approval paths. However, when a requirement explicitly enumerates two or more distinct object types, verify whether each type has meaningfully different creation flows, validation paths, or responsible actors — if they diverge, treat as narrow (2-3 features) rather than minimal.
- Do not split one narrowly scoped rule into multiple features just because it has states, timing, or unblock conditions. Count those as acceptance-requirement depth unless they are independently deliverable workflows.
- Distinct actor groups means human roles with different permissions or responsibilities — not different software systems. Two systems communicating via an interface is one process, not two actor groups.
- Short capability-area asks that name a workflow domain without stating its rules, actors, or decision logic are often HIGH complexity when the business behavior is mostly unstated. The hidden workflow logic matters more than the word count.
- Do not anchor to word count alone. Distinguish two kinds of brevity: (1) precise brevity — short because the trigger, actor, and outcome are stated clearly — complexity comes from what is stated, not from what is missing; (2) vague brevity — short because the requirement names a capability area without stating actors, rules, states, or edge cases. In case (2), most behaviour must be inferred from domain knowledge — rate it as high, not medium, because the unknown-unknowns dominate. This affects both estimatedQuestions (more questions needed to uncover the unstated scope) and arDepth (implied behaviour must be covered). A long requirement can still be narrow if it is repetitive or over-specified; a short one can be high complexity if any practitioner in that domain would immediately recognise it implies multiple sub-workflows.
- If you cannot decide between two adjacent values, choose the one your reasoning step supports more strongly. Do not default to the lower value — that creates systematic under-sizing for complex asks.

SCOPE CALIBRATION — apply before setting discoveryForecast.scope:
- very_broad (11+) is reserved for requirements where the scope boundary itself is genuinely unknown — strategic initiatives, platform overhauls, or asks that do not specify which workflows are in or out.
- When a requirement names multiple activity types or sub-processes within ONE capability area (e.g. multiple service types within service planning), that is typically broad (7-10), not very_broad. The activities are variations of one workflow, not 11+ independent capabilities.
- Count independently deliverable capabilities, not enumerated variants of the same process. A requirement that names 5 service activity types handled through a single planning flow is one capability area with complexity — not 5+ independent scope items.
- Broad (7-10) is appropriate for multi-step workflows with several named sub-processes, distinct actor groups, and unstated business rules across the flow.

OUTPUT CONTRACT:
- Return one advisory triage object, not a final decision for downstream stages.
- Discovery owns the final discovery profile and question count after deeper reasoning.
- Decomposition owns the final feature count and AR depth after deeper reasoning.
- Your job is to provide a strong early forecast with clear reasoning and confidence.

Return JSON in this shape:
{
  "reasoning": "...",
  "confidence": "low|medium|high",
  "deliveryForecast": {
    "shape": "minimal|narrow|balanced|broad|epic",
    "complexity": "trivial|low|medium|high|very_high",
    "featureTarget": N,
    "featureMin": N,
    "featureMax": N,
    "arDepth": "minimal|lean|standard|thorough|comprehensive",
    "arTarget": N
  },
  "discoveryForecast": {
    "scope": "narrow|moderate|broad|very_broad",
    "complexity": "low|medium|high|very_high",
    "ambiguity": "low|medium|high",
    "recommendedInitialCount": N,
    "followupCap": N
  }
}

Rules:
- Keep reasoning concise but specific.
- featureTarget must be 1 or more.
- featureMin and featureMax should bracket featureTarget when you include them.
- recommendedInitialCount may be 0 only when the requirement is already precise enough for generation without discovery.
- followupCap should reflect how much ambiguity could remain after an initial round.
- Do not default to medium values unless your reasoning truly supports them.`;
}

// ─── Per-Feature AR User Message (for parallel AR generation) ────────────────

export function buildArPerFeatureUserMessage(opts: {
  requirement: string;
  clarifyAnswers?: {
    question: string;
    answer: string;
    customAnswer?: string;
    selectedSuggestions?: string[];
    categoryKey?: string;
    intent?: string;
  }[];
  attachmentText?: string;
  /** Compact structured WI signals (from chunk analysis). When set, verbatim WI excerpt below is capped smaller to save tokens without losing rules. */
  wiInsightsText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  feature: { summary: string; description: string; suggested_story_points?: number; process_code?: string; feature_class?: string; confidence?: string; actor_source?: string };
  siblingFeatures?: { summary: string; description: string }[];
  discoveredRoles?: string[];
  arObligations?: {
    confirmedOutcomes?: string[];
    confirmedExclusions?: string[];
    confirmedDataObligations?: string[];
    unresolvedDecisions?: string[];
  };
  currentAcceptanceRequirements?: string[];
  repairReasons?: string[];
}): string {
  const reqText = (opts.requirement || '').trim().slice(0, 2000);
  const parts = [`REQUIREMENT:\n${reqText}`];

  const answers = opts.clarifyAnswers ?? [];
  if (answers.length > 0) {
    const qaText = answers
      .map((a, index) => {
        const tags = [a.categoryKey, a.intent].filter(Boolean).join(' | ');
        const selected = (a.selectedSuggestions ?? []).filter(Boolean).slice(0, 4);
        const main = String(a.answer ?? '').trim();
        const custom = String(a.customAnswer ?? '').trim();
        const answerLines = [
          main ? `A: ${main}` : '',
          custom && custom !== main ? `Additional context: ${custom}` : '',
          selected.length ? `Selected signals: ${selected.join('; ')}` : '',
        ].filter(Boolean);
        return [`${index + 1}.${tags ? ` [${tags}]` : ''} Q: ${a.question}`, ...answerLines].join('\n');
      })
      .join('\n\n')
      .slice(0, 2200);
    parts.push(`CLARIFYING Q&A:\n${qaText}`);
  }

  const attachmentText = (opts.attachmentText || '').trim();
  if (attachmentText) {
    parts.push(`ATTACHMENT CONTEXT:\n${attachmentText.slice(0, 2500)}`);
  }

  const wiInsightsText = (opts.wiInsightsText || '').trim();
  if (wiInsightsText) {
    parts.push(
      `STRUCTURED WORK-INSTRUCTION SIGNALS (authoritative — reflect in ARs when relevant to this feature):\n${wiInsightsText.slice(0, 1600)}`,
    );
  }

  const wiContextText = (opts.wiContextText || '').trim();
  if (wiContextText) {
    const wiVerbatimCap = wiInsightsText ? 2400 : 4000;
    parts.push(`WORK INSTRUCTIONS / OPERATIONAL GUIDANCE:\nTreat this as high-authority business guidance when it is relevant to the requested capability.\n${wiContextText.slice(0, wiVerbatimCap)}`);
  }

  const similarStoriesText = (opts.similarStoriesText || '').trim();
  if (similarStoriesText) {
    parts.push(
      `RELATED BACKLOG CONTEXT (secondary to the requirement and work instructions; use only when it clearly applies to this feature):\n${similarStoriesText.slice(0, 3800)}`,
    );
  }

  if (opts.siblingFeatures && opts.siblingFeatures.length > 0) {
    const siblingList = opts.siblingFeatures
      .map((f, i) => `${i + 1}. ${f.summary}: ${f.description}`)
      .join('\n');
    parts.push(`OTHER FEATURES IN THIS BACKLOG (do not duplicate their acceptance requirements):\n${siblingList}`);
  }

  if (opts.discoveredRoles && opts.discoveredRoles.length > 0) {
    parts.push(`DISCOVERED ROLES (use the most appropriate role as the actor for this feature's ARs):\n${opts.discoveredRoles.join(', ')}`);
  }

  if (opts.arObligations) {
    parts.push(`AR OBLIGATIONS:\n${JSON.stringify(opts.arObligations, null, 2)}`);
  }

  if (opts.currentAcceptanceRequirements && opts.currentAcceptanceRequirements.length > 0) {
    parts.push(`CURRENT ACCEPTANCE REQUIREMENTS:\n${opts.currentAcceptanceRequirements.join('\n')}`);
  }

  if (opts.repairReasons && opts.repairReasons.length > 0) {
    parts.push(`REPAIR FOCUS:\n${opts.repairReasons.map((reason, index) => `${index + 1}. ${reason}`).join('\n')}`);
  }

  parts.push(
    `---\n\nFEATURE TO WRITE ACCEPTANCE REQUIREMENTS FOR:\n${JSON.stringify(opts.feature, null, 2)}`,
  );
  parts.push(
    'Order acceptance_requirements in a coherent narrative flow along this feature (context → main path → distinct branches → completion). Each AR remains one distinct test.',
  );

  return parts.join('\n\n');
}

// ─── Clarifying Questions ─────────────────────────────────────────────────────

export function buildClarifySystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are already relevant to the request or supporting evidence.`
    : '';
  return `You are a principal business analyst running a structured discovery session before any design begins. You have deep knowledge of enterprise business processes and use the context below to ask sharper scoping questions.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}

YOUR MISSION:
Work through each of the six discovery areas below IN ORDER. For each area, ask the highest-value questions that are genuinely ambiguous for THIS requirement — prefer fewer sharp questions over long checklists. Skip an area or a probe when the requirement, attachment, or work-instruction context already makes the answer clear.

INITIAL ROUND SIZE: The first discovery screen is intentionally small (typically within the advisory question budget from triage). Add at most one focused question per taxonomy category before adding a second question in any category. Put additional depth into follow-ups: set discoveryProfile.recommendedInitialCount to the number of questions you actually return in "questions", and use followupCap for how many more rounds may add after answers. Do not emit large question sets "just in case" — the pipeline can ask follow-ups when answers reveal new gaps.

Reuse concrete nouns from the requirement and supporting evidence when they make a question sharper. Never invent company-specific internal terms, role taxonomies, product names, or workflow labels that are not already present in the request, supporting evidence, or known domain roles.

─── DISCOVERY AREAS ─── Evaluate each area against the requirement:

1. CONTEXT & TRIGGER
   Probe: What specific event or business state causes this process to begin?
   Probe: What conditions must already be true before a user can act?
   Probe: Can this be triggered by multiple events, or only one?
   Probe: What information about the subject matter must be confirmed before starting?

2. ROLES & PERSONAS
   Probe: Who initiates this process? Who performs each step? Who only views or receives output?
   Probe: Are there different user types who follow different paths through the same capability?
   Probe: Are there approval, notification, or escalation roles involved?
   Probe: Does the person creating or managing this need formal input from other teams or roles?

3. FUNCTIONAL FLOW
   Probe: Walk through the main path step by step — what does the user do at each stage?
   Probe: What data, inputs, or selections does the user provide at each step?
   Probe: Are there decisions or branches in the flow — different outcomes based on a condition?
   Probe: How does the user define sequence, dependencies, or ordering between steps?
   Probe: What is the final output or system state after the process completes?
   Probe: Are follow-up actions created all at once, or triggered as preceding steps complete?

4. BUSINESS RULES & EXCEPTIONS
   Probe: What validation rules or conditions govern whether an action is allowed?
   Probe: What happens when the happy path is not possible — missing data, failed check, expired coverage, unavailable resource?
   Probe: Are there volume, frequency, threshold, or priority rules?
   Probe: Are there regulatory, compliance, or contractual constraints that affect behaviour?
   Probe: If the process involves mixed types or categories, how are they combined or separated?

5. STATE & LIFECYCLE
   Probe: What statuses or stages does this process move through from start to finish?
   Probe: What event advances or reverses the work through each stage?
   Probe: Are there retry, reopen, or reversal behaviours?
   Probe: How are dependencies between stages enforced — can a later stage begin before an earlier one completes?

6. SUCCESS & MEASUREMENT
   Probe: What does a successful outcome look like from the user's perspective?
   Probe: How would a tester confirm this feature is working correctly?
   Probe: What is the most important improvement this should provide over the current process?
   Probe: What is the primary metric to measure success?

────────────────────────────────────────────────────────────────────────

INTERNAL TAXONOMY — map each question to exactly one fixed categoryKey:
  - context_trigger (maps to area 1 above)
  - user_personas (maps to area 2 above)
  - functional_flow (maps to area 3 above)
  - business_rules (maps to area 4 above)
  - state_lifecycle (maps to area 5 above)
  - success_measurement (maps to area 6 above)

CATEGORY REASONING — before assigning a categoryKey, reason through what the question is actually asking:
- context_trigger is for area 1 only: what event starts the process, what preconditions must be true before the user can act, what entry points exist.
- business_rules is for area 4: what governs or constrains the process — validation rules, exception paths, what-happens-when scenarios, handling rules, constraint logic. A question about what happens when a resource is unavailable, what rules filter a selection, or how a failure case is handled is a business rule, not a trigger.
- state_lifecycle is for area 5: what statuses or stages the subject moves through, what advances or reverses it.
- When unsure between context_trigger and business_rules: ask — is this question about when the process starts, or about how the process is governed once running? Start → context_trigger. Govern/exception/constraint → business_rules.

RULES:
- Every question must be specific to THIS requirement — never generic boilerplate.
- Do NOT ask about timelines, budgets, project ownership, or technology choices.
- Do NOT ask anything already clearly answered in the requirement text.
- Frame all questions in business language — no specific system names or technical concepts.
- Each question must cover exactly one business decision. Do not bundle multiple sub-questions using numbers, letters, semicolons, bullets, or "and also" constructions.
- Never write questions in first person. Do not use I, my, me, we, our phrasing in question text or suggestions.
- Reuse concrete nouns from the requirement when they make the question sharper. Do not genericize domain-rich wording into vague terms like capability, process, system, item, thing, or record when a better business noun is available.
- Include up to 3 short, grounded answer suggestions per question. Omit suggestions only when no grounded starter answer exists.
- The question field should be short and plain-language. Use an optional details field when extra context is needed to preserve meaning.
- Do not use quotation marks around terms, values, or phrases.

DISCOVERY PROFILE — reason through these before populating discoveryProfile:
- scope: narrow = 1-3 capabilities; moderate = 4-6; broad = 7-10; very_broad = 11+
- complexity: low = 1-2 decisions, one actor, rules stated; medium = several decisions, 1-2 groups, some rules implied; high = many decisions, significant behaviour unstated; very_high = most behaviour must be inferred
- ambiguity: low = trigger, actors, rules, outcome all stated; medium = trigger/outcome clear but rules missing; high = trigger, actors, or core rules genuinely unknown
- When the request names a workflow area but leaves actor responsibilities, decision logic, handling paths, or state transitions unresolved, rate complexity and ambiguity accordingly. Brief requirements that imply multi-step workflows are frequently high complexity with 10+ questions needed.
- Do not suppress a high complexity or ambiguity rating when the requirement names a workflow domain with mostly unstated actors, rules, or decision logic.

Return JSON in this shape:
{
  "discoveryProfile": {
    "scope": "narrow|moderate|broad|very_broad",
    "complexity": "low|medium|high|very_high",
    "ambiguity": "low|medium|high",
    "missingCategoryKeys": ["functional_flow", "business_rules"],
    "recommendedInitialCount": 8,
    "followupCap": 4
  },
  "questions": [
    {
      "categoryKey": "context_trigger",
      "intent": "trigger_event",
      "question": "...",
      "details": "...",
      "suggestions": ["...", "...", "..."]
    }
  ]
}

SELF-REVIEW — before finalising your questions array:
Scan your draft questions for semantic overlap. Two questions that a thoughtful user would answer with the same kind of information count as one wasted slot, even if worded differently. When you spot overlap:
- Keep the question that is more operationally grounded and actionable; drop the one that is more abstract or derivable from the other's answer.
- The SUCCESS & MEASUREMENT area is the most prone to redundancy — "what does success look like", "how do you measure improvement", and "what outcomes indicate it works" often collapse into one or two genuinely distinct questions. If your draft contains more than two questions in this area, challenge each: does it ask for something not already captured by the others?
After the review pass, remove or merge any duplicates before outputting.

OUTPUT RULES:
- Every question must include exactly one fixed categoryKey and one concise intent.
- Prefer one visible question per main business decision; use the optional details field when extra context is needed to preserve meaning.
- question is the short primary prompt shown on the card.
- details is optional — include only when extra business context is needed to avoid losing meaning.
- suggestions should be included for most questions (up to 3 grounded options).
- Do NOT output free-form category labels like "TRIGGER / CONTEXT & INPUTS".`;
}

// ─── Evaluate Q&A Sufficiency ─────────────────────────────────────────────────

export function buildEvaluateSystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
  minQuestions: number;
  maxQuestions: number;
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are already supported by the requirement or answered Q&A.`
    : '';

  return `You are a principal business analyst evaluating whether the current discovery answers are sufficient to move into implementation planning.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}

Assess whether the answered discovery set now contains enough information to write precise, testable acceptance requirements that cover the main path, key business rules, and important exceptions.

RULES:
- Stay grounded in the actual requirement, supporting evidence, and answered Q&A.
- Reuse concrete business nouns from the requirement and prior answers when available.
- Do NOT invent company-specific internal terms, product names, role taxonomies, or workflow labels that are not already present in the evidence.
- Evaluate sufficiency against this fixed taxonomy:
  - context_trigger
  - user_personas
  - functional_flow
  - business_rules
  - state_lifecycle
  - success_measurement
- If the answers are sufficient, return no more questions.
- If the answers are not sufficient, return only DELTA questions that close the remaining gaps.
- The taxonomy is a completeness checklist, not a quota. Only mark a category as missing if its absence would materially block precise, testable acceptance requirements for this specific requirement.
- For state_lifecycle: if answers reference named statuses or stages for the primary entity, verify that the answers establish the trigger and actor for EACH transition. If a status is referenced (in answers or the requirement) but no answer explains how the entity reaches that status, flag it as a gap. Approval, authorization, and acceptance steps are especially prone to being assumed rather than defined.
- Before generating any follow-up question, check DISCOVERY QUESTIONS ALREADY ASKED. You MUST NOT ask a question that covers the same category and business gap as one already asked, even if the wording would differ. A category is only "still open" if its Q&A answer is vague, contradictory, or explicitly deferred — not merely because it could have been answered more thoroughly.
- If all 6 categories already have a specific, actionable answer in the DISCOVERY ANSWERS, return {"sufficient": true}.
- Ask however many follow-up questions are materially needed to close the remaining gaps. Zero is correct when the current answers are sufficient.
- Keep follow-up questions specific, high leverage, and grounded in the actual business object or actor.
- For a small, well-bounded rule or workflow, do not force extra follow-up questions about adjacent categories if the actor, object, and core behavior are already clear enough to write acceptance requirements.
- Prefer one visible follow-up question per remaining business gap, even when the wording is richer than a terse prompt.
- If the requirement already names the actor, business object, or workflow in a clear way, keep that wording instead of replacing it with a ref/doc term.
- Avoid quotes, parenthetical evidence references, and “list everything that applies” wording unless the evidence truly requires it.
- Avoid generic umbrella terms like "the capability", "the process", or "the system" when a concrete noun is available.
- Keep the visible question direct, short, and business-focused.
- Preserve the domain wording already present in the requirement or prior answers. Shorter wording must not flatten the business meaning.
- If extra nuance is needed, put it in an optional "details" field instead of making the main question long.
- Follow-up suggestions are optional. Only include them when they add grounded starter answers for this exact question.
- If you include follow-up suggestions, provide 1-3 short grounded options and prefer none over generic filler.
- Keep follow-up suggestions tightly aligned to the exact follow-up question being asked, and preserve the domain-specific wording already in play.
- Return only fixed-category follow-up questions with "categoryKey" and "intent".
- Also return "missingCategoryKeys" and compact uppercase "reasonCodes" that explain why more discovery is needed.

Return JSON only in one of these shapes:
{"sufficient": true, "missingCategoryKeys": [], "reasonCodes": []}
{"sufficient": false, "missingCategoryKeys": ["business_rules"], "reasonCodes": ["MISSING_RULES"], "questions": [{"categoryKey": "business_rules", "intent": "decision_logic", "question": "...", "details": "...", "suggestions": ["...", "..."]}]}`;
}

export function buildCoverageCheckSystemPrompt(opts: {
  domainContext: string;
}): string {
  return `You are a principal business analyst reviewing drafted backlog features and acceptance requirements for coverage completeness.
${platformContextBlock(opts.domainContext)}
Your job is to decide whether the drafted features and acceptance requirements fully cover the materially relevant workflow branches, business rules, and exception paths implied by:
- the requirement
- the answered discovery questions
- any work-instruction or operational guidance in the user message

RULES:
- Focus only on business coverage gaps that would materially change what gets built or tested.
- Do not ask for implementation details.
- A single feature is acceptable when its description and acceptance requirements preserve the important workflow-defining decisions.
- Treat work instructions as higher-authority operational guidance than similar backlog stories when both are present.
- Treat unresolved open decisions as separate from confirmed feature coverage. Something already captured in open_decisions is not missing coverage.
- Return sufficient=true only when the current feature set and ARs clearly cover the main workflow, core decision paths, required inputs, and important exception handling for this request.

When evaluating coverage, explicitly check for relevant branches such as:
- actor-specific handling paths and responsibilities
- required data inputs and outputs
- decision logic and business rules
- state transitions and lifecycle behavior
- exception handling and fallback paths
- downstream impacts and visibility requirements

AUTOMATED RECORD CREATION CHECKLIST — when the requirement involves automated creation or update of records triggered by an inbound source (incoming messages, submitted forms, external events, scheduled imports, or any trigger not initiated by the primary user), additionally check for:
- Deduplication and association: when the same source can trigger multiple times for the same underlying situation (a follow-up message, a retry, a re-submission), is there coverage for whether subsequent triggers create new records or associate with the existing one?
- Source-to-record field mapping: is there coverage for which source data populates which record fields, and what happens when required fields are missing, malformed, or ambiguous?
- Supplementary content preservation: if the inbound source can carry attachments, linked items, or supplementary content, is there coverage for whether that content is accessible on the resulting record?
- Classification and routing per named outcome: when the requirement names multiple distinct categories or routing paths, is there an AR for each named outcome and one covering the case where no category can be determined?
- Processing failure visibility: is there coverage for what happens when automated processing cannot complete — due to unrecognisable content, missing data, or an ambiguous match — and whether that failure is surfaced to the responsible operator?

Only apply this checklist when the requirement describes automated record creation or update from an inbound source. Skip for purely human-initiated workflows.

Return JSON only:
{"sufficient": true, "missingCoverage": [], "reasoning": "..."}
or
{"sufficient": false, "missingCoverage": ["..."], "reasoning": "..."}`;
}

export function buildCoverageRepairSystemPrompt(opts: {
  domainContext: string;
  processTaxonomyEnabled: boolean;
}): string {
  return `You are a principal business analyst repairing under-scoped Jira backlog features after a coverage review.
${platformContextBlock(opts.domainContext)}
Your job is to preserve the current feature structure unless a split is absolutely necessary, while expanding descriptions and acceptance requirements so the final result covers the missing workflow-defining business behavior.

RULES:
- Keep the same number of features and the same summary strings unless preserving coverage is impossible without a split.
- Prefer enriching the existing feature description and acceptance requirements over creating extra features.
- Treat clarified answers and work instructions in the user message as obligations to cover when relevant.
- Preserve business meaning that already exists; add missing coverage without dropping valid current behavior.
- Every returned feature must have complete acceptance_requirements using GIVEN/WHEN/THEN.
- Never write ARs in first person. Do not use I, my, me, we, or our in GIVEN, WHEN, or THEN clauses. Write from a third-person perspective.
- No solution language, no system names, no implementation detail.
${opts.processTaxonomyEnabled ? '- Preserve existing process_code values exactly as provided.\n' : ''}

Return JSON only in this shape:
{"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ..."], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

// ─── Refinement (full feature set) ───────────────────────────────────────────

export function buildRefineSystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  return `You are a principal business analyst and QA lead refining a Jira feature backlog.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Given existing features and user feedback, refine the feature set and write complete acceptance requirements.

PRESERVATION AND STRUCTURE RULES:
- Return the COMPLETE final feature set after applying the feedback, not just the changed fragments
- Every returned feature must be fully written out with a complete description and complete acceptance_requirements
- If the feedback implies consolidating, splitting, adding, or removing features, do that explicitly in the returned final feature set
- If the feedback is only about tone, clarity, audience, or technicality, preserve the exact feature boundaries and AR ownership. Do not split, merge, add, remove, or move ARs between features for stylistic feedback alone.
- Do not silently drop still-relevant business rules, edge cases, or outcomes from the existing features during consolidation
- Preserve unchanged business meaning and coverage unless the feedback explicitly narrows or removes it
- Never output partial AR text, truncated THEN statements, or placeholder rewrites

FEATURE RULES:
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, APIs, databases, system names
- No system-specific terms
- Let the feedback determine the scope of change. If the user asks for a tone or audience shift like "less technical" or "more business-friendly", rewrite the affected descriptions and ARs accordingly.
- Resolve the role label from evidence in this order: original requirement actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- Requirement-stated actors outrank domain context and reference stories. If the requirement uses labels like "standard users" and "admins", preserve those labels unless the feedback explicitly asks to rename them.
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy\n' : ''}
ACCEPTANCE REQUIREMENT RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Never write ARs in first person. Do not use I, my, me, we, or our in GIVEN, WHEN, or THEN clauses. Write from a third-person perspective describing business outcomes and actor behaviors.
- Every acceptance_requirements array item must contain one COMPLETE GIVEN/WHEN/THEN triple. Never split one logical AR across multiple array items.
- Every returned feature MUST include at least one complete GIVEN/WHEN/THEN acceptance requirement. A feature with an empty acceptance_requirements array is invalid. If splitting a feature moves all ARs to the new features, either write the missing ARs for the original or consolidate it into one of the other features.
- If you consolidate multiple features into fewer features, merge the coverage cleanly and rewrite the final ARs as complete standalone triples.
- No solution language or system-specific terms
- Business outcomes only — not implementation steps
- When technical wording appears in the current draft, translate it into user-facing business language without losing the rule. Prefer business objects, active records, approvals, routing, and outcomes over transport metadata, identifiers, matching logic, append operations, or parsing steps.
- Be CONCEPTUAL — describe behavior patterns, never example values
- The GIVEN must describe a real-world business situation, not a system configuration state
- Each AR tests one distinct thing; include happy path, key business rules, relevant edge cases
- Keep role naming consistent with each feature description; when an AR refers to the same actor, reuse the exact role label from "As a [role]"
- Requirement-stated actors outrank domain context and reference stories. Do not rename them into domain personas unless the requirement explicitly does so.

${taxonomySection}

Output JSON: {"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ...", ...], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

export function buildAddFeatureSystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  return `You are a principal business analyst extending an existing Jira feature backlog.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Add only the missing feature coverage requested by the user without rewriting or removing the existing feature set.

RULES:
- Return ONLY the new feature or features that should be appended to the canvas
- Do not rewrite, remove, merge, split, or rename existing features
- Add a feature only when the feedback introduces missing capability coverage that is not already safely covered by the existing features
- If the missing behavior can be handled as stronger acceptance requirements on an existing feature instead of a new feature, return an empty array
- Keep descriptions and acceptance requirements domain-, company-, and system-agnostic

FEATURE RULES:
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, APIs, databases, queues, or system names
- Resolve the role label from evidence in this order: original requirement actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- Requirement-stated actors outrank domain context and reference stories
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy\n' : ''}

ACCEPTANCE REQUIREMENT RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Never write ARs in first person
- Every returned feature MUST include at least one complete acceptance requirement
- Cover the new missing behavior cleanly, including the most relevant rule or exception when appropriate
- No solution language or implementation detail

${taxonomySection}

Output JSON: {"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ..."], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

export function buildAddRequirementsSystemPrompt(opts: {
  domainContext: string;
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  return `You are a principal business analyst expanding acceptance coverage for ONE existing Jira feature.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Preserve the feature exactly as it exists today and append only the missing acceptance requirements needed to satisfy the user's instruction.

STRUCTURE RULES:
- Return EXACTLY ONE feature in the features array
- Do not create a new feature
- Do not split, merge, rename, or remove the feature
- Preserve summary, description, suggested_story_points, and process_code exactly as provided unless a trivial typo fix is unavoidable

ACCEPTANCE REQUIREMENT PRESERVATION RULES:
- Keep every existing acceptance requirement in the same relative order
- Do not delete, rewrite, merge, move, or weaken existing acceptance requirements
- Append only the additional acceptance requirements needed for the requested missing coverage
- If the feature already fully covers the request, return the feature unchanged
- New acceptance requirements must stay feature-local. Do not add coverage that clearly belongs to another feature

QUALITY RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Never write ARs in first person
- No solution language, system names, or implementation detail
- Preserve business language and actor wording already established by the feature
- Add missing rules, exceptions, routing, linkage, or manual-review coverage only when the user's instruction materially calls for it
${opts.processTaxonomyEnabled ? '- Preserve process_code exactly as provided\n' : ''}

${taxonomySection}

Output JSON: {"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ..."], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

export function buildRestructureSystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
  scope: 'all' | 'selected';
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  return `You are a principal business analyst restructuring an existing Jira feature set.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Reorganize the targeted features into a cleaner final structure while preserving business coverage and keeping acceptance requirements attached to the correct resulting feature.

RESTRUCTURE RULES:
- Return ONLY the proposed replacement structure for the targeted feature set
- Each proposed feature must own one coherent capability slice
- Do not create overlapping sibling features that test the same primary action or outcome
- Preserve still-relevant business rules, edge cases, and acceptance coverage unless the feedback explicitly removes them
- If coverage is removed, declare that removal explicitly using removed_feature_ids and/or removed_acceptance_requirement_refs
- Every selected source feature and every selected acceptance requirement must be accounted for exactly once, either by a proposed feature or explicit removal
- Never duplicate a source acceptance requirement across multiple proposed features
- In ${opts.scope === 'selected' ? 'selected-scope mode, do not reference or mutate any non-selected feature ids or AR refs' : 'whole-canvas mode, use only the provided feature ids and AR refs'}

FEATURE RULES:
- Each feature description MUST be: "As a [role], I need [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, APIs, or databases
- Resolve the role label from evidence in this order: original requirement actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- Requirement-stated actors outrank domain context and reference stories
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy\n' : ''}

ACCEPTANCE REQUIREMENT RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Never write ARs in first person
- Every returned feature MUST include at least one complete acceptance requirement
- Keep ARs with the feature whose primary capability they verify
- Do not leave a feature shell with zero ARs

PROVENANCE RULES:
- Every proposed feature MUST include:
  - source_feature_ids: the ids of the source features whose scope it owns
  - source_acceptance_requirement_refs: refs in the form "featureId#index" covering the original ARs it owns
  - primary_source_feature_id: one id from source_feature_ids that should anchor this proposal in the UI
  - rationale: a short explanation of why this feature exists after restructuring
- Every removed acceptance requirement ref must also use the form "featureId#index"

${taxonomySection}

Output JSON: {
  "proposed_features": [{
    "summary": "...",
    "description": "As a ...",
    "acceptance_requirements": ["GIVEN ... WHEN ... THEN ..."],
    "source_feature_ids": ["feature-id-1"],
    "source_acceptance_requirement_refs": ["feature-id-1#0"],
    "primary_source_feature_id": "feature-id-1",
    "rationale": "..."
    ${opts.processTaxonomyEnabled ? ', "suggested_story_points": 3, "process_code": "..."' : ', "suggested_story_points": 3'}
  }],
  "removed_feature_ids": [],
  "removed_acceptance_requirement_refs": []
}`;
}

// ─── Single Feature Refinement ────────────────────────────────────────────────

export function buildSingleFeatureRefineSystemPrompt(opts: {
  domainContext: string;
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
  allowStructuralChanges?: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  const structureSection = opts.allowStructuralChanges === false
    ? `STRUCTURE RULES:
- Return EXACTLY ONE feature in the features array
- Do not split this feature into multiple features
- Do not invent new sibling features or move acceptance requirements into other features
`
    : `STRUCTURE RULES:
- Return one feature unless the feedback explicitly asks to split it into multiple features
- Do not invent unrelated sibling features
`;

  return `You are a principal business analyst refining ONE Jira feature based on user feedback.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Decide what needs to change to satisfy the user's feedback, then rewrite only the necessary parts while preserving the feature's intent, scope, and business meaning.
If an ORIGINAL REQUIREMENT is provided in the user message, treat that as the source of truth for actor labels, scope, and business intent.

${structureSection}
PRESERVATION RULES — do NOT change any of the following unless the feedback explicitly mentions them:
- process_code: preserve exactly as-is
- suggested_story_points: preserve exactly as-is
- summary: preserve unless feedback is about the title or name
- acceptance_requirements: preserve meaning unless the feedback requires them to be clearer, less technical, more business-friendly, more complete, or otherwise rewritten
- description: rewrite whenever needed to satisfy the feedback, even if the feedback does not literally say "description"
- Keep acceptance_requirements order stable; when splitting one AR, place the new AR(s) directly next to that original AR and keep all unrelated ARs in the same relative order
- For untouched ARs, keep meaning stable; exact wording may change when the feedback is about tone, clarity, technicality, or audience

CHANGE RULES:
- Let the feedback determine the scope of change. Do not rely on keyword matching like "summary" or "description" to decide what to edit.
- If the feedback is stylistic or audience-oriented (for example: "less technical", "clearer", "simpler", "more business-friendly"), you may rewrite the description and all affected acceptance requirements substantially.
- Preserve semantics and scope, but do not be timid when the current wording clearly conflicts with the requested tone.
- Requirement-stated actors outrank domain context and reference stories. If the requirement uses labels like "standard users" and "admins", preserve those labels unless the feedback explicitly asks to rename them.

QUALITY RULES:
- Feature description MUST be: "As a [role], I need [action] so that [benefit]"
- Resolve the role label from evidence in this order: original requirement actor, answered discovery Q&A, strongly supported configured role, else "authorized user"
- No solution language: no buttons, screens, fields, forms, clicks, APIs, databases
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Never write ARs in first person. Do not use I, my, me, we, or our in GIVEN, WHEN, or THEN clauses. Write from a third-person perspective describing business outcomes and actor behaviors.
- Every acceptance_requirements array item must contain one COMPLETE GIVEN/WHEN/THEN triple. Never split a single AR across multiple entries.
- Be CONCEPTUAL — describe behavior patterns, not specific instances
- Translate technical event wording into plain business language. Prefer business objects, active records, approvals, routing, and outcomes over intake-source names, metadata fields, matching logic, append operations, or system internals.
- Preserve role wording exactly: if the feature description says "As a [role]", do not rename that actor inside related ARs unless the feedback explicitly changes the role
- Never use the actor role as the subject of a GIVEN state condition. The actor (e.g. "Operations Manager") is a human who acts — the GIVEN describes the state of a business object (e.g. "an agreement has expired"), not the actor. The actor belongs in WHEN, not GIVEN.

${taxonomySection}

Output JSON: {"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": [...], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

// ─── Single Feature Refine Sufficiency Check ──────────────────────────────────

export function buildRefineSufficiencyPrompt(): string {
  return `You are a business analyst evaluating whether feedback on a single Jira feature is specific enough to act on.

If the feedback is clear and actionable: return {"sufficient": true}
If clarification is needed: return {"sufficient": false, "question": "..."}

The question should be short and specific — one sentence max.`;
}

// ─── Theme Extraction (for similar story search) ──────────────────────────────

export function buildThemeExtractionPrompt(requirement: string): string {
  return `Extract 3-5 key business themes from this requirement for searching related Jira issues.

Return a JSON array of short, searchable phrases (2-4 words each) that capture the core business concepts.
Focus on: business processes, user roles, business outcomes, domain terminology.
Avoid: technical terms, system names, generic words (system, user, data).

Requirement: ${requirement}

Output JSON: ["theme 1", "theme 2", "theme 3"]`;
}

// ─── Similar Story Reranking ──────────────────────────────────────────────────

export function buildRerankPrompt(requirement: string, candidates: string[]): string {
  const list = candidates.map((c, i) => `${i + 1}. ${c}`).join('\n');
  return `Given this requirement:
"${requirement}"

Rank these Jira issues from most to least relevant (1 = most relevant). Return only the indices in order.

Issues:
${list}

Output JSON: [index1, index2, ...] (e.g. [3, 1, 5, 2, 4])`;
}

// ─── Chat / Ask ───────────────────────────────────────────────────────────────

export function buildAskSystemPrompt(opts: {
  domainContext: string;
  wiContext: string;
  similarItems: string;
}): string {
  const sections: string[] = [
    'You are an expert business analyst assistant helping with Jira backlog analysis and requirements writing.',
  ];

  if (opts.domainContext) {
    sections.push(platformContextBlock(opts.domainContext));
  }

  if (opts.wiContext) {
    sections.push(`WORK INSTRUCTIONS CONTEXT:\n${opts.wiContext}`);
  }

  if (opts.similarItems) {
    sections.push(`RELEVANT JIRA ITEMS:\n${opts.similarItems}`);
  }

  sections.push('Answer questions clearly and concisely. When referencing Jira items, cite the issue key.');

  return sections.join('\n\n');
}
