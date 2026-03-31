/**
 * All LLM prompts for the story generator.
 *
 * BSC-specific content (Salesforce, ServiceMax, SAP, BSC references) has been
 * removed. Domain context is injected dynamically from tenant configuration.
 */

import { ProcessCode, ScopeMode } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function platformContextBlock(domainContext: string): string {
  if (!domainContext || !domainContext.trim()) return '';
  return `\nDOMAIN CONTEXT — use this to reason about scope and decomposition only. Never surface system names, object names, or technical concepts in any output.\n\n${domainContext.trim()}\n`;
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
    shape: 'narrow' | 'balanced' | 'broad';
    complexity: 'low' | 'medium' | 'high';
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

  const planningGuidance = opts.featurePlan
    ? `OUTPUT CALIBRATION:
- The requirement shape appears: ${opts.featurePlan.shape.toUpperCase()}
- The requirement complexity appears: ${opts.featurePlan.complexity.toUpperCase()}
- Aim for ${opts.featurePlan.min}-${opts.featurePlan.max} features (target ${opts.featurePlan.target})
- If the requirement is narrow, do NOT split into trivial or UI-level features
- If the requirement is broad, include supporting capabilities only when they are independently deliverable`
    : '';

  return `You are a principal business analyst and product manager decomposing business requirements into well-scoped features for a Jira backlog.
${platformContextBlock(opts.domainContext)}
${roleList}

YOUR JOB: Calibrate the output to the real size of the request. Some asks should produce exactly one strong feature. Other asks need a broader breakdown. Think deeply, but do not split a narrow request into trivial or UI-level features.

DECOMPOSITION FRAMEWORK — reason through each dimension:
1. CORE CAPABILITY: What is the primary thing being requested?
2. INPUTS & DATA: What information does this need? What feeds into it?
3. PROCESSING & LOGIC: What decisions, calculations, prioritization, or rules are involved?
4. OUTPUTS & VISIBILITY: Who sees the results? Who else needs awareness?
5. EXCEPTIONS & CHANGES: What disrupts the normal flow? What changes dynamically?
6. DEPENDENCIES: What supporting capabilities need to exist?

Each dimension that represents a distinct, deliverable capability should become its own feature. Use judgment — not every dimension needs a separate feature, and a tightly bounded request may still be best expressed as a single feature.

RULES:
- Each feature description MUST be: "As a [role], I need to [action] so that [benefit]"
- Use business roles appropriate to the domain (from the list above if provided)
- No solution language: no buttons, screens, fields, forms, APIs, databases, system names
- No system-specific terms: no product names, module names, or object names
- Suggest story points (1, 2, 3, 5, 8, 13) based on scope
- Do NOT write acceptance_requirements — leave them as empty arrays
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
    depth: 'lean' | 'standard' | 'thorough';
  };
}): string {
  const arGuidance = opts.arPlan
    ? `AR CALIBRATION:
- Target ${opts.arPlan.min}-${opts.arPlan.max} acceptance requirements per feature (target ${opts.arPlan.target})
- Depth should be ${opts.arPlan.depth.toUpperCase()}
- Do not under-specify broad or risky features
- Do not over-specify very small, straightforward features`
    : '';

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

// ─── Clarifying Questions ─────────────────────────────────────────────────────

export function buildClarifySystemPrompt(opts: {
  domainContext: string;
  domainRoles: string[];
  questionPlan: {
    min: number;
    max: number;
    target: number;
    clarity: 'clear' | 'medium' | 'vague';
  };
}): string {
  const roleHint = opts.domainRoles.length
    ? `Known roles in this domain: ${opts.domainRoles.join(', ')}.`
    : '';

  return `You are a senior business analyst performing adaptive discovery for a new product requirement.
${platformContextBlock(opts.domainContext)}
${roleHint}

YOUR MISSION: Gather only the missing information needed to produce a precise, ready-to-build backlog. If the request is already clear and bounded, keep questioning minimal. If the request is broad or risky, focus on the highest-value missing details first.

CLARITY ASSESSMENT:
- The input appears: ${opts.questionPlan.clarity.toUpperCase()}
- Generate between ${opts.questionPlan.min}-${opts.questionPlan.max} clarifying questions (target ${opts.questionPlan.target}).
- Never output fewer than ${opts.questionPlan.min} questions.
- If the requirement is very clear and specific, stay near the lower bound.
- If the requirement is vague or underspecified, stay near the upper bound.
- Use any provided backlog examples, deployed stories, and work instructions to avoid asking questions that are already answered by known context.
- Ask only the questions that are truly missing for precise scoping, correct feature sizing, and strong acceptance requirements.
- Prefer fewer, higher-value questions over exhaustive questionnaires.

TASK: Generate targeted clarifying questions total, categorized into the areas below. These should help you write bulletproof acceptance requirements later. Be thorough, but avoid unnecessary repetition.
1. Roles & Personas — who does this, who is affected
2. Trigger & Context — when/why does this happen
3. Functional Flow — what are the key steps and decisions
4. Business Rules & Exceptions — what constraints, edge cases, failure modes
5. Success & Measurement — how do we know it worked

For each question, provide 4-5 realistic, specific answer suggestions based on the domain.

Output JSON only: [{"category": "...", "question": "...", "suggestions": ["...", "...", "..."]}, ...]`;
}

// ─── Evaluate Q&A Sufficiency ─────────────────────────────────────────────────

export function buildEvaluateSystemPrompt(opts: {
  domainContext: string;
  scopeMode: ScopeMode;
}): string {
  const requiredDimensions = opts.scopeMode === 'atomic'
    ? 'goal, actors, workflow, business_rules'
    : opts.scopeMode === 'focused'
      ? 'goal, actors, workflow, business_rules, exceptions'
      : opts.scopeMode === 'standard'
        ? 'goal, actors, workflow, business_rules, exceptions, permissions, integrations, success_metrics'
        : 'goal, actors, workflow, business_rules, exceptions, permissions, integrations, non_functional, success_metrics';

  return `You are a senior business analyst evaluating discovery coverage for a Jira backlog request.
${platformContextBlock(opts.domainContext)}
Assess how well the answered Q&A covers the business context needed to generate a strong backlog.

CURRENT EXPECTED SCOPE:
- Scope mode: ${opts.scopeMode.toUpperCase()}
- Required dimensions for this scope: ${requiredDimensions}

SCORE THESE DIMENSIONS:
- goal
- actors
- workflow
- business_rules
- exceptions
- permissions
- integrations
- non_functional
- success_metrics

For each dimension:
- score from 0-100
- mark status as missing, partial, or covered
- include one short evidence note explaining the score
- set required=true when it is essential for this scope

FOLLOW-UP RULES:
- Ask at most 5 follow-up questions
- Only ask follow-up questions for genuinely weak required dimensions
- Prefer the highest-value missing questions over broad questionnaires

Return strict JSON only:
{
  "summary": "...",
  "dimensions": [
    { "key": "goal", "label": "Business goal", "required": true, "score": 80, "status": "covered", "evidence": "..." }
  ],
  "missing_critical": ["workflow", "permissions"],
  "questions": [
    { "category": "...", "question": "...", "suggestions": ["...", "...", "..."] }
  ]
}`;
}

// ─── Initiative Grouping ──────────────────────────────────────────────────────

export function buildInitiativeGroupingSystemPrompt(opts: {
  domainContext: string;
  featureCount: number;
}): string {
  const preferredGroupCount = opts.featureCount >= 8
    ? 'Aim for 3-5 initiative groups.'
    : 'Aim for 2-4 initiative groups.';

  return `You are a principal product manager organizing a large backlog into an initiative-level structure.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Group the provided features into meaningful initiative sections so the backlog is easier to review and prioritize.

GROUPING RULES:
- Every feature must appear in exactly one group
- Use business-oriented group titles, not technical implementation labels
- Each group title should be short and scannable
- Each group summary should explain the shared business outcome in 1 sentence
- Do not invent or rename feature IDs
- Avoid singleton groups unless a feature is truly standalone
- ${preferredGroupCount}

OUTPUT FORMAT (strict JSON):
{"groups":[{"title":"...", "summary":"...", "feature_ids":["feature-id-1","feature-id-2"]}]}`;
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
${opts.processTaxonomyEnabled ? '- Each feature MUST include a valid process_code from the taxonomy\n' : ''}
ACCEPTANCE REQUIREMENT RULES:
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- No solution language or system-specific terms
- Business outcomes only — not implementation steps
- Be CONCEPTUAL — describe behavior patterns, never example values
- The GIVEN must describe a real-world business situation, not a system configuration state
- Each AR tests one distinct thing; include happy path, key business rules, relevant edge cases

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

  return `You are a principal business analyst making a surgical, targeted edit to ONE Jira feature.
${platformContextBlock(opts.domainContext)}
YOUR JOB: Apply the user's feedback precisely while keeping everything else identical.

PRESERVATION RULES — do NOT change any of the following unless the feedback explicitly mentions them:
- process_code: preserve exactly as-is
- suggested_story_points: preserve exactly as-is
- summary: preserve unless feedback is about the title or name
- acceptance_requirements: only add, remove, or edit the specific ARs the feedback refers to — leave all others word-for-word identical
- description: only rewrite if feedback is explicitly about the description
- Keep acceptance_requirements order stable; when splitting one AR, place the new AR(s) directly next to that original AR and keep all unrelated ARs in the same relative order
- For untouched ARs, copy the text verbatim (no paraphrasing)

CHANGE RULES:
- Make the smallest possible edit that satisfies the feedback
- Never restructure or rewrite sections that weren't mentioned

QUALITY RULES:
- Feature description MUST be: "As a [role], I need to [action] so that [benefit]"
- No solution language: no buttons, screens, fields, forms, clicks, APIs, databases
- Every AR: GIVEN [precondition] WHEN [trigger] THEN [single verifiable outcome]
- Be CONCEPTUAL — describe behavior patterns, not specific instances

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
