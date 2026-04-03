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
    const { shape, complexity, min, max, target } = opts.featurePlan;
    const base = `OUTPUT CALIBRATION:
- The requirement shape appears: ${shape.toUpperCase()}
- The requirement complexity appears: ${complexity.toUpperCase()}
- Aim for ${min}-${max} features (target ${target})`;

    if (shape === 'minimal')
      return `${base}
- This is a FOCUSED, small requirement. Output exactly ${target} feature(s).
- Do NOT decompose further unless there are genuinely independent capabilities.
- One well-scoped feature is better than three micro-features.
- If the ask is a single capability, return exactly 1 feature.`;

    if (shape === 'narrow')
      return `${base}
- This is a tightly scoped requirement. Keep features to ${min}-${max}.
- Do NOT split into trivial or UI-level features.
- Combine related concerns into a single feature rather than over-splitting.`;

    if (shape === 'epic')
      return `${base}
- This is a COMPLEX, multi-workflow requirement. It MUST produce ${min}-${max} features.
- Each distinct workflow, role-specific capability, or independently testable behavior MUST be its own feature.
- DO NOT collapse multiple workflows into a single feature.
- Keep the feature set practical for one generation run; prefer the most important independently deliverable capabilities first.
- Do not exceed ${max} features in a single response.`;

    if (shape === 'broad')
      return `${base}
- This is a broad requirement covering multiple capabilities. Target ${target} features.
- Include supporting capabilities only when they are independently deliverable.
- Each distinct workflow or role-specific behavior should be its own feature.
- Do not exceed ${max} features in a single response.`;

    // balanced (default)
    return `${base}
- If the requirement is narrow, do NOT split into trivial or UI-level features.
- If the requirement is broad, include supporting capabilities only when they are independently deliverable.`;
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
  return `You are a senior business analyst doing a quick triage of a software requirement. Your job is to assess the scope and complexity so the decomposition step knows how many features to produce.

Think about what it actually takes to deliver the requirement:
- What are the distinct capabilities, workflows, or independently deliverable pieces?
- How many decision dimensions, business rules, or roles are involved?
- Is this a small tweak (1 feature) or a multi-workflow epic (10+ features)?

Return a JSON object with:
- "estimatedFeatures": number (1-15) — how many independent, deliverable features this requirement implies
- "shape": one of "minimal", "narrow", "balanced", "broad", "epic"
  - minimal: a single small change or addition (1 feature)
  - narrow: a tightly scoped capability (1-3 features)
  - balanced: a moderate requirement with a few distinct parts (3-6 features)
  - broad: a multi-capability requirement (5-9 features)
  - epic: a complex multi-workflow requirement with many moving parts (8-15 features)
- "complexity": one of "trivial", "low", "medium", "high", "very_high"
  - trivial: no business rules, single happy path
  - low: a few straightforward rules
  - medium: multiple rules, some edge cases
  - high: many rules, multiple roles, exception handling
  - very_high: cross-cutting concerns, complex orchestration, many roles and workflows
- "arDepth": one of "minimal", "lean", "standard", "thorough", "comprehensive"
  - minimal: 1-2 acceptance requirements per feature
  - lean: 2-3 per feature
  - standard: 3-5 per feature
  - thorough: 4-6 per feature
  - comprehensive: 5-8 per feature

Be precise. A short sentence can still imply a broad, complex system. "Optimize scheduling based on criticality and due dates" is NOT narrow — it implies schedule generation, data inputs, scoring/weighting, visibility, exception handling, and more.

Output JSON only: {"estimatedFeatures": N, "shape": "...", "complexity": "...", "arDepth": "..."}`;
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
- Use supporting evidence to avoid redundant questions and to understand the business context, not to inject jargon for its own sake.
- Evaluate all 6 taxonomy categories, then ask only from the ones that are still materially unresolved.
- ${questionPlanHint}
- Do not ask multiple variations of the same question.
- Every question must be specific enough that the answer would materially change scope, design, or acceptance requirements.
- One visible question may bundle 2-4 tightly related sub-prompts when they belong to the same primary categoryKey and a stakeholder would naturally answer them together.
- When you group related sub-prompts, keep them inside one coherent question string and prefer inline numbering like "1." "2." "3." so the parts stay readable.
- Do not mix multiple categoryKeys inside one visible question. Group only within a single primary category.
- Questions should usually be rich, specific business prompts rather than clipped one-liners. Use as much wording as needed to make the tradeoff or ambiguity concrete.
- Name the actual business object, actor, rule, exception, or downstream impact whenever the evidence supports it.
- Strong questions often probe ownership, eligibility, tie-breakers, exception handling, downstream visibility, or auditability.
- For optimization, scheduling, assignment, prioritization, ranking, or automation asks, you usually need coverage across ownership, decision factors, timing, exceptions, overrides, and visibility when those details remain ambiguous.
- Suggestions should be longer starter answers or fuller phrase fragments, not terse chips. They should help the user answer quickly while still exposing the likely tradeoffs.
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
- Grouped questions are allowed, but they must still map to exactly one "categoryKey" and one "intent".
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
- Ask between ${opts.minQuestions}-${opts.maxQuestions} follow-up questions only when needed, and prefer 1-3 grouped follow-up questions when one grouped prompt can close a single category gap cleanly.
- Keep follow-up questions specific, high leverage, and grounded in the actual business object or actor.
- One visible follow-up question may bundle 2-4 tightly related sub-prompts when they belong to the same primary categoryKey and the user would naturally answer them together.
- Do not mix multiple categoryKeys inside one visible follow-up question.
- Avoid generic umbrella terms like "the capability", "the process", or "the system" when a concrete noun is available.
- Keep the wording direct and business-focused, but detailed enough to make the unresolved tradeoff explicit.
- Provide exactly 4 suggestions per follow-up question, and make them longer starter answers that reflect likely business tradeoffs in this request.
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
