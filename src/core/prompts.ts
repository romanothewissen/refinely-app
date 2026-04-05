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

export function formatGoldExample(item: {
  summary?: string;
  description?: string;
  acceptance_criteria?: string;
  story_points?: number;
}, descMax?: number, acMax?: number): string {
  let desc = item.description || '(no description)';
  if (descMax && desc.length > descMax) desc = desc.slice(0, descMax) + '…';

  const lines = [
    `Example Feature: ${item.summary || ''}`,
    `Description: ${desc}`,
    'Acceptance Requirements:',
  ];

  let ac = item.acceptance_criteria || '';
  if (ac) {
    if (acMax && ac.length > acMax) ac = ac.slice(0, acMax) + '…';
    for (const line of ac.trim().split('\n')) {
      const t = line.trim();
      if (t && (t.startsWith('-') || t.startsWith('*') || /GIVEN|WHEN|THEN/i.test(t))) {
        lines.push(`  - ${t.replace(/^[-*]\s*/, '')}`);
      } else if (t) {
        lines.push(`  - ${t}`);
      }
    }
  } else {
    lines.push('  - (none)');
  }

  if (item.story_points != null) lines.push(`(Story points: ${item.story_points})`);
  return lines.join('\n');
}

// ─── Pass 1: Decomposition ────────────────────────────────────────────────────

export function buildDecompositionSystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
  featurePlan?: {
    min: number;
    max: number;
    target: number;
    shape: 'minimal' | 'narrow' | 'balanced' | 'broad' | 'epic';
    complexity: 'trivial' | 'low' | 'medium' | 'high' | 'very_high';
  };
}): string {
  const roleList = opts.domainRoles.length
    ? `Roles in this domain: ${opts.domainRoles.join(', ')}.`
    : 'Infer appropriate business roles from the requirement context.';

  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  const processRule = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? '- Each feature MUST include a process_code from the taxonomy above (never invent a code)'
    : '- Omit process_code from output';

  const planningGuidance = (() => {
    if (!opts.featurePlan) return '';
    const { shape, complexity, max, target } = opts.featurePlan;
    const base = `OUTPUT CALIBRATION:
- The requirement shape appears: ${shape.toUpperCase()}
- The requirement complexity appears: ${complexity.toUpperCase()}
- Produce approximately ${target} features. Do not exceed ${max}.`;

    if (shape === 'minimal')
      return `${base}
- This is a FOCUSED, small requirement. Output exactly ${target} feature(s).
- Do NOT decompose further unless there are genuinely independent capabilities.
- One well-scoped feature is better than three micro-features.
- If the ask is a single capability, return exactly 1 feature.`;

    if (shape === 'narrow')
      return `${base}
- This is a tightly scoped requirement. Aim for ${target} features.
- Do NOT split into trivial or UI-level features.
- Combine related concerns into a single feature rather than over-splitting.
- Do not exceed ${max} features.`;

    if (shape === 'epic')
      return `${base}
- This is a COMPLEX, multi-workflow requirement. Produce approximately ${target} features.
- Each distinct workflow, role-specific capability, or independently testable behavior MUST be its own feature.
- DO NOT collapse multiple workflows into a single feature.
- Keep the feature set practical for one generation run; prefer the most important independently deliverable capabilities first.
- Do not exceed ${max} features in a single response.`;

    if (shape === 'broad')
      return `${base}
- This is a broad requirement covering multiple capabilities. Produce approximately ${target} features.
- Work through the decomposition framework: what generates the output? What feeds into it? Who uses it? What can go wrong? What changes dynamically? Each independently deliverable answer is a feature.
- Each distinct workflow or role-specific behavior should be its own feature.
- Do not exceed ${max} features in a single response.`;

    // balanced (default)
    return `${base}
- Produce approximately ${target} features. Work through the decomposition framework: what generates the output? What feeds into it? Who uses it? What can go wrong? What changes dynamically? Each independently deliverable answer is a feature.
- Do NOT split into trivial or UI-level sub-tasks. Do not exceed ${max} features.`;
  })();

  return `You are a principal business analyst and product manager decomposing business requirements into well-scoped features for a Jira backlog.
${platformContextBlock(opts.domainContext)}
${roleList}

YOUR JOB: Given a short requirement, think deeply about everything it actually takes to deliver it. A requirement like "show an optimized schedule based on criticality" implies much more than one feature — think about what generates the schedule, what data feeds it, who uses it, what disrupts it, and what supporting capabilities are needed.

DECOMPOSITION FRAMEWORK — reason through each dimension:
1. CORE CAPABILITY: What is the primary thing being requested?
2. INPUTS & DATA: What information does this need? What feeds into it?
3. PROCESSING & LOGIC: What decisions, calculations, prioritization, or rules are involved?
4. OUTPUTS & VISIBILITY: Who sees the results? Who else needs awareness?
5. EXCEPTIONS & CHANGES: What disrupts the normal flow? What changes dynamically?
6. DEPENDENCIES: What supporting capabilities need to exist?

Each dimension that represents a distinct, deliverable capability should become its own feature. Use judgment — not every dimension needs a separate feature.

RULES:
- Each feature description MUST be: "As a [role], I need to [action] so that [benefit]"
- Use business roles appropriate to the domain (from the list above if provided)
- Requirement-stated actors outrank domain context and reference stories. If the requirement says "standard users" and "admins", preserve those labels unless the requirement explicitly asks to map them to named roles.
- If the requirement describes different permissions or responsibilities for multiple actor groups, the feature set must reflect that breadth. Do not collapse everything into one persona.
- No solution language: no buttons, screens, fields, forms, APIs, databases, system names
- No system-specific terms: no product names, module names, or object names
- Suggest story points (1, 2, 3, 5, 8, 13) based on scope
- Do NOT write acceptance_requirements — leave them as empty arrays
- Never return an empty "features" array. If the request is buildable at all, return at least one well-scoped feature.
${processRule}
${planningGuidance ? `\n${planningGuidance}` : ''}

${taxonomySection}

Think step by step about the full scope of this requirement, then output JSON:
{"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": [], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
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
    const { min, max, target, depth } = opts.arPlan;
    const base = `AR CALIBRATION:
- Target ${min}-${max} acceptance requirements per feature (target ${target})
- Depth should be ${depth.toUpperCase()}`;

    if (depth === 'minimal')
      return `${base}
- Write only ${min}-${max} ARs per feature covering the happy path.
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
- Do not over-specify very small, straightforward features.`;

    // standard / thorough
    return `${base}
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
- No solution language: no buttons, screens, fields, forms, clicks, APIs, databases
- No system-specific terms: no product names, module names, system object names
- Write as if describing business outcomes to someone who has never seen the system
- Be CONCEPTUAL — describe behavior patterns, never invent example values (e.g. never "when the weighting is 20", always "when a weighting is configured")
- Each AR tests one distinct thing
- If an AR refers to the same actor named in the feature description, use that exact same role label
- Do not replace the feature role with synonyms like user, worker, technician, operator, service professional, or agent unless the feature description itself uses that term

COMMON MISTAKES TO AVOID:
- BAD GIVEN: "GIVEN a contract is configured for shipment-based activation" → GOOD: "GIVEN a service contract is linked to a piece of equipment that has been shipped"
- Never reference internal system concepts or admin configurations as preconditions
- Avoid abstract umbrella terms: "activation type", "trigger event", "configured mode"
${arGuidance ? `\n${arGuidance}` : ''}

OUTPUT FORMAT (strict):
- Return a single JSON object: {"features":[...]} — same number of features as input, same order and same "summary" strings.
- Each feature MUST include the key "acceptance_requirements" (snake_case, array of strings). Do NOT use "acceptanceRequirements" (camelCase).
- Each string MUST be one full requirement in the form: GIVEN ... WHEN ... THEN ... (you may use line breaks inside the string for readability).
- Fill at least 2–4 acceptance_requirements per feature unless the feature is truly trivial (then at least 1).

Output JSON: same features array with acceptance_requirements arrays filled in. Keep summary, description, suggested_story_points, and process_code unchanged from the input unless you must fix a typo.`;
}

// ─── Requirement Triage (fast LLM-based assessment) ─────────────────────────

export function buildTriageSystemPrompt(): string {
  return `You are a senior business analyst doing a quick triage of a software requirement. Your job is to assess scope, complexity, and ambiguity so the pipeline knows how many features, acceptance requirements, and clarifying questions to produce.

Before assessing any field, count these four structural properties of the requirement:
  1. Independently deliverable capabilities — each distinct input the system must receive, decision it must make, output it must produce, and exception path it must handle is a potential capability.
  2. Autonomous decisions — things the system must decide on its own: rules it enforces, rankings it produces, selections it resolves, conflicts it handles, without a human intervening at each step.
  3. Distinct actor groups — roles with different permissions, different views of the data, or different responsibilities in the process.
  4. Unresolved discovery categories — how many of these six remain unstated: actors, trigger/context, information, business rules, lifecycle, edge cases.

These counts drive all five fields below. Do not anchor to word count or vocabulary.

Return a JSON object with:
- "estimatedFeatures": number (1-15) — how many independently deliverable capabilities this requirement implies (count from property 1 above)
- "estimatedQuestions": number (4-15) — how many clarifying questions are needed before implementation
  - 4-6: 5 or 6 discovery categories are already resolved by the requirement text
  - 7-9: 3 or 4 categories are resolved; several remain unstated
  - 10-12: only 1 or 2 categories are resolved; key decisions, lifecycle, or roles are undefined
  - 13-15: 0 or 1 categories are resolved; the requirement names a goal but specifies almost nothing
  A requirement that resolves fewer than 2 discovery categories almost always needs 10+ questions regardless of length.
- "shape": one of "minimal", "narrow", "balanced", "broad", "epic"
  - minimal: 1 independently deliverable capability (1 feature)
  - narrow: 2-3 capabilities (1-3 features)
  - balanced: 4-6 capabilities (3-6 features)
  - broad: 6-9 capabilities (5-9 features)
  - epic: 9+ capabilities with multiple actor groups and many decision points (8-15 features)
- "complexity": one of "trivial", "low", "medium", "high", "very_high"
  - trivial: 0 autonomous decisions, 1 actor group, 0 enforced rules, single happy path
  - low: 1-2 autonomous decisions, 1 actor group, a few explicit rules
  - medium: 3-4 autonomous decisions, 1-2 actor groups, several explicit rules and some edge cases
  - high: 5+ autonomous decisions, 2-3 actor groups, many rules, multiple exception paths
  - very_high: many autonomous decisions across multiple actor groups, many enforced rules, many exception paths — the system must resolve most of its own complexity at each step
- "arDepth": one of "minimal", "lean", "standard", "thorough", "comprehensive"
  - minimal: 1 happy path, no rules, no exception paths stated or implied
  - lean: 1-2 explicit rules, low risk if under-specified
  - standard: rules, actor responsibilities, and key edge cases are all explicitly stated in the requirement
  - thorough: structural counts (decisions, actors, rules) are high relative to what the text states — implied behavior must be covered
  - comprehensive: the requirement names a goal but leaves most decisions, rules, and exception paths unstated — the ARs must specify behavior the requirement does not

STRUCTURAL REASONING — apply before finalising all fields:
- Count what must be built, not what was written. A requirement that names a goal without specifying the mechanism implies more features, higher complexity, and more questions than its length suggests.
- Shape and complexity should reflect the structural burden of what must be built — decisions, actors, rules, and exception paths — not the vocabulary used to describe it.
- "standard" arDepth requires that rules, actors, and edge cases are explicitly stated. If structural counts are high but the text is short, use "thorough" or "comprehensive".
- When uncertain between two levels on any field, choose the higher one.

Output JSON only: {"estimatedFeatures": N, "estimatedQuestions": N, "shape": "...", "complexity": "...", "arDepth": "..."}`;
}

// ─── Per-Feature AR User Message (for parallel AR generation) ────────────────

export function buildArPerFeatureUserMessage(opts: {
  requirement: string;
  clarifyAnswers?: { question: string; answer: string }[];
  feature: { summary: string; description: string; suggested_story_points?: number; process_code?: string };
}): string {
  const reqText = (opts.requirement || '').trim().slice(0, 2000);
  const parts = [`REQUIREMENT:\n${reqText}`];

  const answers = opts.clarifyAnswers ?? [];
  if (answers.length > 0) {
    const qaText = answers
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n')
      .slice(0, 1500);
    parts.push(`CLARIFYING Q&A:\n${qaText}`);
  }

  parts.push(
    `---\n\nFEATURE TO WRITE ACCEPTANCE REQUIREMENTS FOR:\n${JSON.stringify(opts.feature, null, 2)}`,
  );

  return parts.join('\n\n');
}

// ─── Clarifying Questions ─────────────────────────────────────────────────────

export function buildClarifySystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
  domainSignals?: string[];
  questionPlan?: { min: number; max: number; target: number };
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are already relevant to the request or supporting evidence.`
    : '';
  const domainSignalHint = opts.domainSignals?.length
    ? `Important domain signals from the requirement and supporting evidence: ${opts.domainSignals.join(', ')}. Reuse these concrete business terms when they sharpen the question.`
    : '';
  const questionPlanHint = opts.questionPlan
    ? `Discovery range for this request: ${opts.questionPlan.min}-${opts.questionPlan.max} questions with an ideal target of ${opts.questionPlan.target}. Lean toward the upper half only when ambiguity is still material.`
    : 'Discovery count should follow the range provided in the user message. If no range is supplied, use your judgment and avoid filler.';

  return `You are a principal business analyst running a structured discovery session before any design begins. You have deep knowledge of enterprise business processes and use the context below to ask sharper scoping questions.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}
${domainSignalHint}

YOUR MISSION:
- Surface every ambiguity that would change what gets built or how acceptance requirements are written.
- Ask a frontloaded batch of high-value discovery questions that removes the biggest business ambiguity before implementation.
- Reuse concrete nouns from the requirement and supporting evidence when they make the question sharper.
- Never invent company-specific internal terms, role taxonomies, product names, or workflow labels that are not already present in the request, supporting evidence, or known domain roles.
- Think like an experienced BA who is trying to prevent rework: probe for ownership, preconditions, decision logic, downstream impact, lifecycle, and exceptions before anyone writes requirements.

WORKING COVERAGE AREAS:
- Roles & Personas: who initiates, owns, approves, receives, overrides, or is affected
  Probe for primary actor, downstream visibility, approvals, escalation, and exceptions to the default role model.
- Trigger & Context: what event starts the flow, what must already be true, and what business outcome defines a successful first pass
  Probe for initiation points, qualifying conditions, channel or entry-point differences, and what "done correctly" means.
- Information Architecture: what information, identifiers, records, outputs, or linkages the process needs
  Probe for required captured data, reuse of existing records, identifiers, downstream updates, and what must stay visible.
- Business Rules: what decisions, constraints, prioritisation, sequencing, thresholds, or override policies govern the flow
  Probe for eligibility, routing logic, tie-breakers, approvals, timing rules, and anything that changes the outcome.
- State & Lifecycle: what statuses, transitions, retries, reopens, or reversals matter
  Probe for lifecycle milestones, handoffs, reopening behaviour, and what event advances or reverses the work.
- Edge Cases & Exceptions: what happens when the happy path breaks
  Probe for missing data, duplicates, conflicting signals, unavailable channels, and fallback handling.

INTERNAL TAXONOMY:
- Map each question to exactly one fixed categoryKey:
  - context_trigger
  - user_personas
  - information_architecture
  - business_rules
  - state_lifecycle
  - edge_cases_exceptions

DISCOVERY RULES:
- Every question must be specific to THIS requirement, not generic boilerplate.
- Preserve user-provided nouns exactly unless the evidence makes a better, more precise business noun obvious.
- If the requirement already names the actor, business object, or workflow in a clear way, keep that wording instead of replacing it with a ref/doc term.
- Use supporting evidence to avoid redundant questions and to understand the business context, not to inject jargon for its own sake.
- Evaluate all 6 taxonomy categories, then ask only from the ones that are still materially unresolved.
- ${questionPlanHint}
- Do not ask multiple variations of the same question.
- Every question must be specific enough that the answer would materially change scope, design, or acceptance requirements.
- Prefer one visible question per main business decision.
- CRITICAL: Each question must cover exactly one business decision. Never bundle two questions using numbers (1. ... 2. ...), letters ((a)...(b)...), semicolons, bullets, or "and also" constructions. If you find yourself wanting to ask two related things, pick the more important one for this card — the other can be a separate question if it is genuinely distinct.
- A question may be rich and specific when that makes the ambiguity clearer, but it must end with a single answerable prompt.
- A question may be longer than a terse chip-style prompt when the tradeoff needs that extra clarity.
- Questions should usually be rich, specific business prompts rather than clipped one-liners. Use enough wording to make the tradeoff or ambiguity concrete, while keeping the card focused on one main decision.
- Do not use quotation marks (" " ' ') around any terms, values, or phrases. Write the word directly without wrapping it in quotes. Do not include parenthetical evidence references or stacked qualifiers.
- Name the actual business object, actor, rule, exception, or downstream impact whenever the evidence supports it.
- Strong questions often probe ownership, eligibility, tie-breakers, exception handling, downstream visibility, or auditability.
- For optimization, scheduling, assignment, prioritization, ranking, or automation asks, you usually need coverage across ownership, decision factors, timing, exceptions, overrides, and visibility when those details remain ambiguous.
- Suggestions should be medium-length starter answers or fuller phrase fragments, not terse chips and not mini-paragraphs. They should help the user answer quickly while still exposing the likely tradeoffs.
- Keep the suggestions aligned to the actual question being asked; do not broaden them into a different decision area just to make the set feel more complete.
- Provide exactly 4 suggestions per question.

OUTPUT CONTRACT:
Return JSON only in this shape:
{
  "discoveryProfile": {
    "scope": "narrow|moderate|broad|very_broad",
    "complexity": "low|medium|high|very_high",
    "ambiguity": "low|medium|high",
    "missingCategoryKeys": ["context_trigger", "business_rules"],
    "recommendedInitialCount": 8,
    "followupCap": 4
  },
  "questions": [
    {
      "categoryKey": "context_trigger",
      "intent": "trigger_event",
      "question": "...",
      "suggestions": ["...", "...", "...", "..."]
    }
  ]
}

OUTPUT RULES:
- "recommendedInitialCount" must be between 4 and 12.
- "followupCap" must be between 1 and 8.
- The number of questions returned must exactly match "recommendedInitialCount".
- "missingCategoryKeys" must contain only keys from the fixed taxonomy above.
- Every question must include exactly one fixed "categoryKey" and one concise "intent".
- Every question should be a single focused prompt even when the wording is richer than a short atomic sentence.
- Each question should read like one clear business decision, not a request for an exhaustive list.
- Do NOT output free-form category labels like "TRIGGER / CONTEXT & INPUTS".`;
}

// ─── Evaluate Q&A Sufficiency ─────────────────────────────────────────────────

export function buildEvaluateSystemPrompt(opts: {
  domainContext: string;
  domainRoles?: string[];
  domainSignals?: string[];
  minQuestions: number;
  maxQuestions: number;
}): string {
  const roleHint = opts.domainRoles?.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}. Reuse them only when they are already supported by the requirement or answered Q&A.`
    : '';
  const domainSignalHint = opts.domainSignals?.length
    ? `Important business terms already present in the requirement or answered Q&A: ${opts.domainSignals.join(', ')}. Reuse these concrete nouns when they sharpen a follow-up question.`
    : '';

  return `You are a principal business analyst evaluating whether the current discovery answers are sufficient to move into implementation planning.
${discoveryEvidenceBlock(opts.domainContext)}
${roleHint}
${domainSignalHint}

Assess whether the answered discovery set now contains enough information to write precise, testable acceptance requirements that cover the main path, key business rules, and important exceptions.

RULES:
- Stay grounded in the actual requirement, supporting evidence, and answered Q&A.
- Reuse concrete business nouns from the requirement and prior answers when available.
- Do NOT invent company-specific internal terms, product names, role taxonomies, or workflow labels that are not already present in the evidence.
- Evaluate sufficiency against this fixed taxonomy:
  - context_trigger
  - user_personas
  - information_architecture
  - business_rules
  - state_lifecycle
  - edge_cases_exceptions
- If the answers are sufficient, return no more questions.
- If the answers are not sufficient, return only DELTA questions that close the remaining gaps.
- Never repeat or lightly rephrase a question that was already asked.
- Ask between ${opts.minQuestions}-${opts.maxQuestions} follow-up questions only when needed.
- Keep follow-up questions specific, high leverage, and grounded in the actual business object or actor.
- Prefer one visible follow-up question per remaining business gap, even when the wording is richer than a terse prompt.
- If the requirement already names the actor, business object, or workflow in a clear way, keep that wording instead of replacing it with a ref/doc term.
- Avoid quotes, parenthetical evidence references, and “list everything that applies” wording unless the evidence truly requires it.
- Avoid generic umbrella terms like "the capability", "the process", or "the system" when a concrete noun is available.
- Keep the wording direct and business-focused, but detailed enough to make the unresolved tradeoff explicit.
- Provide exactly 4 suggestions per follow-up question, and make them medium-length starter answers that reflect likely business tradeoffs in this request.
- Keep follow-up suggestions tightly aligned to the exact follow-up question being asked.
- Return only fixed-category follow-up questions with "categoryKey" and "intent".
- Also return "missingCategoryKeys" and compact uppercase "reasonCodes" that explain why more discovery is needed.

Return JSON only in one of these shapes:
{"sufficient": true, "missingCategoryKeys": [], "reasonCodes": []}
{"sufficient": false, "missingCategoryKeys": ["business_rules"], "reasonCodes": ["MISSING_RULES"], "questions": [{"categoryKey": "business_rules", "intent": "decision_logic", "question": "...", "suggestions": ["...", "...", "...", "..."]}]}`;
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
- Do not silently drop still-relevant business rules, edge cases, or outcomes from the existing features during consolidation
- Preserve unchanged business meaning and coverage unless the feedback explicitly narrows or removes it
- Never output partial AR text, truncated THEN statements, or placeholder rewrites

FEATURE RULES:
- Each feature description MUST be: "As a [role], I need to [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, APIs, databases, system names
- No system-specific terms
- Let the feedback determine the scope of change. If the user asks for a tone or audience shift like "less technical" or "more business-friendly", rewrite the affected descriptions and ARs accordingly.
- Requirement-stated actors outrank domain context and reference stories. If the requirement uses labels like "standard users" and "admins", preserve those labels unless the feedback explicitly asks to rename them.
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy\n' : ''}
ACCEPTANCE REQUIREMENT RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- No solution language or system-specific terms
- Business outcomes only — not implementation steps
- Be CONCEPTUAL — describe behavior patterns, never example values
- The GIVEN must describe a real-world business situation, not a system configuration state
- Each AR tests one distinct thing; include happy path, key business rules, relevant edge cases
- Keep role naming consistent with each feature description; when an AR refers to the same actor, reuse the exact role label from "As a [role]"
- Requirement-stated actors outrank domain context and reference stories. Do not rename them into domain personas unless the requirement explicitly does so.

${taxonomySection}

Output JSON: {"features": [{"summary": "...", "description": "As a ...", "acceptance_requirements": ["GIVEN ... WHEN ... THEN ...", ...], "suggested_story_points": N${opts.processTaxonomyEnabled ? ', "process_code": "..."' : ''}}]}`;
}

// ─── Single Feature Refinement ────────────────────────────────────────────────

export function buildSingleFeatureRefineSystemPrompt(opts: {
  domainContext: string;
  processTaxonomy: ProcessCode[];
  processTaxonomyEnabled: boolean;
}): string {
  const taxonomySection = opts.processTaxonomyEnabled && opts.processTaxonomy.length
    ? processTaxonomyBlock(opts.processTaxonomy)
    : '';

  return `You are a principal business analyst refining ONE Jira feature based on user feedback.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Decide what needs to change to satisfy the user's feedback, then rewrite only the necessary parts while preserving the feature's intent, scope, and business meaning.
If an ORIGINAL REQUIREMENT is provided in the user message, treat that as the source of truth for actor labels, scope, and business intent.

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
- Feature description MUST be: "As a [role], I need to [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, clicks, APIs, databases
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Be CONCEPTUAL — describe behavior patterns, not specific instances
- Preserve role wording exactly: if the feature description says "As a [role]", do not rename that actor inside related ARs unless the feedback explicitly changes the role

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
