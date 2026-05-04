import type { JsonSchema } from '../core/json-schema';
import type {
  V2CapabilityReasoningArtifact,
  V2ClassifiedAnswer,
  V2DiscoveryQuestion,
  V2DiscoverySynthesis,
  V2FinalGenerationResponse,
  V2PromptBudget,
  V2ScopeHypothesis,
  V2TriageResult,
} from './types';

export const V2_PROMPT_BUDGETS: Record<V2PromptBudget['stage'], V2PromptBudget> = {
  triage: { stage: 'triage', maxSystemChars: 1200, maxUserChars: 1600 },
  scope_hypothesis: { stage: 'scope_hypothesis', maxSystemChars: 1400, maxUserChars: 2800 },
  discover: { stage: 'discover', maxSystemChars: 1700, maxUserChars: 3600 },
  discovery_synthesis: { stage: 'discovery_synthesis', maxSystemChars: 1700, maxUserChars: 5200 },
  final_generation: { stage: 'final_generation', maxSystemChars: 1800, maxUserChars: 6200 },
  coverage_repair: { stage: 'coverage_repair', maxSystemChars: 1400, maxUserChars: 5200 },
  // Legacy prompt budgets retained for saved audit compatibility and older tests.
  capability_reasoning: { stage: 'capability_reasoning', maxSystemChars: 2000, maxUserChars: 3600 },
  feature_formatter: { stage: 'feature_formatter', maxSystemChars: 1200, maxUserChars: 2200 },
  ar_writer: { stage: 'ar_writer', maxSystemChars: 1700, maxUserChars: 2600 },
};

export const V2_TRIAGE_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'complexity',
    'ambiguity',
    'workflow_depth',
    'actor_clarity',
    'must_cover_behaviors',
    'unresolved_decision_themes',
    'recommended_discovery_count',
    'ar_depth',
  ],
  additionalProperties: false,
  properties: {
    complexity: { type: 'integer', minimum: 1, maximum: 5 },
    ambiguity: { type: 'integer', minimum: 1, maximum: 5 },
    workflow_depth: { type: 'integer', minimum: 1, maximum: 5 },
    actor_clarity: { type: 'integer', minimum: 1, maximum: 5 },
    must_cover_behaviors: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 5, maxLength: 160 } },
    unresolved_decision_themes: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 5, maxLength: 160 } },
    recommended_discovery_count: { type: 'integer', minimum: 0, maximum: 15 },
    ar_depth: { type: 'string', enum: ['light', 'standard', 'deep'] },
  },
};

function trimText(value: string, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 24).trimEnd()} ...[trimmed]`;
}

function compactList(items: string[], max = 5, maxItemChars = 160): string {
  return items.slice(0, max).map((item) => `- ${trimText(item, maxItemChars)}`).join('\n');
}

function compactDiscoveryAnswers(items: V2ClassifiedAnswer[], max = 12): string {
  return items
    .slice(0, max)
    .map((answer) => `- [${answer.categoryKey}/${answer.materiality}] ${trimText(answer.question, 160)} => ${trimText(answer.answer, 600)}`)
    .join('\n');
}

const ACTOR_SLOT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    initiator: { type: 'string' },
    performer: { type: 'string' },
    approver: { type: 'string' },
    observer: { type: 'string' },
  },
};

const OPEN_DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['title', 'detail', 'blocking'],
  additionalProperties: false,
  properties: {
    title: { type: 'string', minLength: 4, maxLength: 100 },
    detail: { type: 'string', minLength: 6, maxLength: 200 },
    blocking: { type: 'boolean' },
  },
};

const ACCEPTANCE_REQUIREMENT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['given', 'when', 'then'],
  additionalProperties: false,
  properties: {
    given: { type: 'string', minLength: 6, maxLength: 260 },
    when: { type: 'string', minLength: 6, maxLength: 260 },
    then: { type: 'string', minLength: 6, maxLength: 260 },
  },
};

export const V2_SCOPE_HYPOTHESIS_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['capabilities', 'actorSlots', 'openQuestions', 'confidence'],
  additionalProperties: false,
  properties: {
    capabilities: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['id', 'label', 'rationale', 'confidence'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 32 },
          label: { type: 'string', minLength: 6, maxLength: 120 },
          rationale: { type: 'string', minLength: 8, maxLength: 220 },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
      },
    },
    actorSlots: ACTOR_SLOT_SCHEMA,
    openQuestions: { type: 'array', items: { type: 'string', minLength: 5, maxLength: 180 }, maxItems: 6 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

export const V2_DISCOVERY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['questions'],
  additionalProperties: false,
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 15,
      items: {
        type: 'object',
        required: ['id', 'categoryKey', 'question', 'rationale', 'suggestions'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 32 },
          categoryKey: {
            type: 'string',
            enum: ['context_trigger', 'user_personas', 'functional_flow', 'business_rules', 'state_lifecycle', 'success_measurement'],
          },
          question: { type: 'string', minLength: 12, maxLength: 180 },
          rationale: { type: 'string', minLength: 8, maxLength: 160 },
          suggestions: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 90 },
          },
        },
      },
    },
  },
};

export const V2_SYNTHESIS_SCHEMA: JsonSchema = {
  type: 'object',
  required: [
    'resolvedFacts',
    'actorMap',
    'businessRules',
    'workflowSteps',
    'lifecycleStates',
    'exceptions',
    'successMeasures',
    'mustCoverBehaviors',
    'openDecisions',
    'arDepth',
    'featureTarget',
  ],
  additionalProperties: false,
  properties: {
    resolvedFacts: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 5, maxLength: 180 } },
    actorMap: ACTOR_SLOT_SCHEMA,
    businessRules: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 5, maxLength: 180 } },
    workflowSteps: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 5, maxLength: 180 } },
    lifecycleStates: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 3, maxLength: 120 } },
    exceptions: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 5, maxLength: 180 } },
    successMeasures: { type: 'array', maxItems: 6, items: { type: 'string', minLength: 5, maxLength: 160 } },
    mustCoverBehaviors: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 5, maxLength: 180 } },
    openDecisions: { type: 'array', maxItems: 8, items: OPEN_DECISION_SCHEMA },
    arDepth: { type: 'string', enum: ['light', 'standard', 'deep'] },
    featureTarget: { type: 'integer', minimum: 1, maximum: 6 },
  },
};

export const V2_FINAL_GENERATION_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['features', 'coverageMap'],
  additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['summary', 'description', 'suggested_story_points', 'acceptanceRequirements'],
        additionalProperties: false,
        properties: {
          summary: { type: 'string', minLength: 6, maxLength: 120 },
          description: { type: 'string', minLength: 20, maxLength: 260 },
          suggested_story_points: { type: 'integer', minimum: 1, maximum: 13 },
          process_code: { type: 'string' },
          acceptanceRequirements: {
            type: 'array',
            minItems: 2,
            maxItems: 12,
            items: ACCEPTANCE_REQUIREMENT_SCHEMA,
          },
        },
      },
    },
    coverageMap: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        required: ['mustCoverBehavior'],
        additionalProperties: false,
        properties: {
          mustCoverBehavior: { type: 'string', minLength: 5, maxLength: 180 },
          featureSummary: { type: 'string', maxLength: 120 },
          openDecisionTitle: { type: 'string', maxLength: 100 },
        },
      },
    },
  },
};

// Legacy schemas are retained for imports in tests and older code paths.
export const V2_REASONING_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['capabilities', 'actorSlots', 'mustCarryRules', 'edgeCases', 'openDecisions'],
  additionalProperties: false,
  properties: {
    capabilities: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['capabilityId', 'label', 'boundary', 'ownerRole', 'mustCarryRules', 'edgeCases'],
        additionalProperties: false,
        properties: {
          capabilityId: { type: 'string', minLength: 1, maxLength: 32 },
          label: { type: 'string', minLength: 6, maxLength: 120 },
          boundary: { type: 'string', minLength: 8, maxLength: 240 },
          ownerRole: { type: 'string', minLength: 3, maxLength: 90 },
          mustCarryRules: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 5, maxLength: 180 } },
          edgeCases: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 5, maxLength: 180 } },
        },
      },
    },
    actorSlots: ACTOR_SLOT_SCHEMA,
    mustCarryRules: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 5, maxLength: 180 } },
    edgeCases: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', minLength: 5, maxLength: 180 } },
    openDecisions: { type: 'array', maxItems: 6, items: OPEN_DECISION_SCHEMA },
  },
};

export const V2_FEATURE_FORMATTER_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['features'],
  additionalProperties: false,
  properties: {
    features: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: {
        type: 'object',
        required: ['summary', 'description', 'suggested_story_points'],
        additionalProperties: false,
        properties: {
          summary: { type: 'string', minLength: 6, maxLength: 120 },
          description: { type: 'string', minLength: 20, maxLength: 220 },
          suggested_story_points: { type: 'integer', minimum: 1, maximum: 13 },
          process_code: { type: 'string' },
        },
      },
    },
  },
};

export const V2_AR_WRITER_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['acceptanceRequirements'],
  additionalProperties: false,
  properties: {
    acceptanceRequirements: {
      type: 'array',
      minItems: 2,
      maxItems: 12,
      items: ACCEPTANCE_REQUIREMENT_SCHEMA,
    },
  },
};

export function measurePromptSizes(systemPrompt: string, userMessage: string) {
  return {
    systemChars: systemPrompt.length,
    userChars: userMessage.length,
  };
}

export function buildTriageSystemPrompt(): string {
  return trimText(
    [
      'You profile a business requirement before backlog generation.',
      'Size complexity, ambiguity, workflow depth, actor clarity, discovery count, AR depth, must-cover behaviors, and unresolved decision themes.',
      'Score only from the supplied requirement and excerpt.',
      'Do not write discovery questions, solution details, features, or acceptance requirements.',
      'Return JSON only.',
      'Rubric: complexity 1=single small change, 3=several related behaviors, 5=many workflow-defining behaviors.',
      'Rubric: ambiguity 1=mostly clear, 3=some important gaps, 5=many unresolved decisions.',
      'Rubric: workflow_depth 1=simple CRUD, 3=multi-step, 5=stateful/routing/exception-heavy.',
      'Rubric: actor_clarity 1=no usable accountability, 3=partial role hints, 5=clear initiator/performer/approver-observer.',
    ].join(' '),
    V2_PROMPT_BUDGETS.triage.maxSystemChars,
  );
}

export function buildTriageUserMessage(input: { requirement: string; attachmentText?: string }): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 1100)}`,
    input.attachmentText?.trim()
      ? `Evidence excerpt:\n${trimText(input.attachmentText, 420)}`
      : '',
    'Return JSON matching the schema.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.triage.maxUserChars);
}

export function buildScopeHypothesisSystemPrompt(): string {
  return trimText(
    [
      'You identify the smallest set of meaningful business capabilities implied by a requirement.',
      'Focus on business outcomes, not CRUD fragments or implementation steps.',
      'Return 1-6 core capabilities, tentative actor slots, and unresolved questions that could change scope.',
      'Ground capability labels in concrete business objects, workflow steps, rules, or evidence terms.',
      'If actor evidence is weak, keep actor slots sparse rather than inventing generic roles.',
      'Do not write acceptance requirements or implementation detail.',
    ].join(' '),
    V2_PROMPT_BUDGETS.scope_hypothesis.maxSystemChars,
  );
}

export function buildScopeHypothesisUserMessage(input: {
  requirement: string;
  attachmentText?: string;
  triage: V2TriageResult;
  groundedEvidenceText?: string;
}): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 900)}`,
    input.attachmentText?.trim() ? `Attachment context:\n${trimText(input.attachmentText, 360)}` : '',
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    `Requirement profile:\n- discovery mode: ${input.triage.discoveryMode}\n- likely capability count: ${input.triage.likelyCapabilityCount}\n- workflow depth: ${input.triage.workflowDepth}/5\n- must-cover behaviors:\n${compactList(input.triage.mustCoverBehaviors, 6)}`,
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.scope_hypothesis.maxUserChars);
}

export function buildDiscoverySystemPrompt(): string {
  return trimText(
    [
      'You write only material discovery questions from unresolved decision themes.',
      'Questions must be neutral, non-leading, and specific to the requirement.',
      'Do not assume role names that are not already confirmed.',
      'Each question must mention a concrete actor, object, rule, workflow step, or lifecycle signal already present in the grounded evidence.',
      'Ask only questions that can materially change capability boundaries, actor accountability, business rules, lifecycle handling, exceptions, or success measures.',
      'Prefer concise questions and short suggestion chips.',
    ].join(' '),
    V2_PROMPT_BUDGETS.discover.maxSystemChars,
  );
}

export function buildDiscoveryUserMessage(input: {
  requirement: string;
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  groundedEvidenceText?: string;
}): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 900)}`,
    `Requirement profile:\n- complexity: ${input.triage.complexity}/5\n- ambiguity: ${input.triage.ambiguity}/5\n- workflow depth: ${input.triage.workflowDepth}/5\n- AR depth: ${input.triage.arDepth}`,
    `Must-cover behaviors:\n${compactList(input.triage.mustCoverBehaviors, 8)}`,
    input.triage.unresolvedDecisionThemes.length
      ? `Unresolved decision themes:\n${compactList(input.triage.unresolvedDecisionThemes, 8)}`
      : '',
    `Proposed capabilities:\n${compactList(input.scopeHypothesis.capabilities.map((capability) => `${capability.label}: ${capability.rationale}`), 6)}`,
    `Open uncertainties:\n${compactList(input.scopeHypothesis.openQuestions, 6) || '- none'}`,
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    `Generate up to ${input.triage.questionBudget} high-value discovery questions for this round only.`,
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.discover.maxUserChars);
}

export function buildSynthesisSystemPrompt(): string {
  return trimText(
    [
      'You synthesize discovery into the authoritative contract for backlog generation.',
      'Separate resolved facts from open decisions.',
      'Carry forward every material user answer and every must-cover behavior that affects feature boundaries or AR coverage.',
      'Do not invent implementation detail or silently resolve unknowns.',
      'Set featureTarget to the smallest feature count that preserves independently valuable capability boundaries.',
    ].join(' '),
    V2_PROMPT_BUDGETS.discovery_synthesis.maxSystemChars,
  );
}

export function buildSynthesisUserMessage(input: {
  requirement: string;
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  classifiedAnswers: V2ClassifiedAnswer[];
  groundedEvidenceText?: string;
}): string {
  const materialAnswers = input.classifiedAnswers.filter((answer) => answer.materiality !== 'trivial');
  const parts = [
    `Requirement:\n${trimText(input.requirement, 1000)}`,
    `Requirement profile:\n- complexity: ${input.triage.complexity}/5\n- ambiguity: ${input.triage.ambiguity}/5\n- workflow depth: ${input.triage.workflowDepth}/5\n- actor clarity: ${input.triage.actorClarity}/5\n- requested AR depth: ${input.triage.arDepth}`,
    `Must-cover behaviors from triage:\n${compactList(input.triage.mustCoverBehaviors, 10)}`,
    input.triage.unresolvedDecisionThemes.length ? `Unresolved themes from triage:\n${compactList(input.triage.unresolvedDecisionThemes, 10)}` : '',
    `Confirmed capability hypothesis:\n${compactList(input.scopeHypothesis.capabilities.map((capability) => `${capability.label}: ${capability.rationale}`), 6)}`,
    materialAnswers.length ? `Material discovery answers:\n${compactDiscoveryAnswers(materialAnswers, 12)}` : '',
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    'Return the synthesis JSON. Keep open decisions explicit instead of filling gaps with assumptions.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.discovery_synthesis.maxUserChars);
}

export function buildFinalGenerationSystemPrompt(): string {
  return trimText(
    [
      'You generate Jira-ready business features and acceptance requirements from a discovery synthesis.',
      'Features are independently valuable business capabilities, not CRUD fragments.',
      'Descriptions must use "As a [role], I need ... so that ...".',
      'Acceptance requirements must be GIVEN/WHEN/THEN, business-facing, concrete, and scenario-rich.',
      'Cover primary behavior, material rules, realistic exceptions, lifecycle states, and unresolved open decisions without inventing answers.',
      'Return the complete feature set and map every must-cover behavior to a feature or open decision.',
    ].join(' '),
    V2_PROMPT_BUDGETS.final_generation.maxSystemChars,
  );
}

export function buildFinalGenerationUserMessage(input: {
  requirement: string;
  synthesis: V2DiscoverySynthesis;
  groundedEvidenceText?: string;
  processTaxonomyEnabled?: boolean;
  processCodes?: Array<{ code: string; name: string; definition: string }>;
}): string {
  const taxonomy = input.processTaxonomyEnabled && input.processCodes?.length
    ? `Optional process taxonomy:\n${compactList(input.processCodes.map((entry) => `${entry.code}: ${entry.name} - ${entry.definition}`), 5)}`
    : '';
  const parts = [
    `Requirement:\n${trimText(input.requirement, 900)}`,
    `Discovery synthesis:\n${trimText(JSON.stringify(input.synthesis, null, 2), 3200)}`,
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    taxonomy,
    'Generate the final JSON. Use compact but complete features; do not omit coverage from mustCoverBehaviors.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.final_generation.maxUserChars);
}

export function buildCoverageRepairSystemPrompt(): string {
  return trimText(
    [
      'You repair a generated backlog draft using a small list of coverage failures.',
      'Preserve the current feature structure unless a failure cannot be fixed without adding one feature.',
      'Do not rewrite unrelated coverage.',
      'Return the complete repaired JSON feature set and coverage map.',
    ].join(' '),
    V2_PROMPT_BUDGETS.coverage_repair.maxSystemChars,
  );
}

export function buildCoverageRepairUserMessage(input: {
  requirement: string;
  synthesis: V2DiscoverySynthesis;
  generated: V2FinalGenerationResponse;
  failures: string[];
  groundedEvidenceText?: string;
}): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 800)}`,
    `Discovery synthesis:\n${trimText(JSON.stringify(input.synthesis, null, 2), 2600)}`,
    `Coverage failures to fix:\n${compactList(input.failures, 10)}`,
    `Current generated draft:\n${trimText(JSON.stringify(input.generated, null, 2), 2600)}`,
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    'Return the repaired final-generation JSON.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.coverage_repair.maxUserChars);
}

export function buildCapabilityReasoningSystemPrompt(): string {
  return trimText(
    [
      'You are the thinker pass.',
      'Refine capability boundaries, actor accountability, rules, edge cases, and open decisions.',
      'Do not format final feature descriptions yet.',
      'Preserve meaningful workflow depth and exception handling.',
      'Keep owner roles and capability boundaries grounded in the supplied evidence wording.',
      'Avoid CRUD decomposition unless the requirement is explicitly administrative.',
    ].join(' '),
    V2_PROMPT_BUDGETS.capability_reasoning.maxSystemChars,
  );
}

export function buildCapabilityReasoningUserMessage(input: {
  requirement: string;
  scopeHypothesis: V2ScopeHypothesis;
  classifiedAnswers: V2ClassifiedAnswer[];
  groundedEvidenceText?: string;
}): string {
  const materialAnswers = input.classifiedAnswers
    .filter((answer) => answer.materiality !== 'trivial')
    .map((answer) => `${answer.question} => ${answer.answer}`);

  const parts = [
    `Requirement:\n${trimText(input.requirement, 800)}`,
    `Confirmed capability hypothesis:\n${compactList(input.scopeHypothesis.capabilities.map((capability) => capability.label), 6)}`,
    materialAnswers.length ? `Material discovery answers:\n${compactList(materialAnswers, 8, 260)}` : '',
    input.groundedEvidenceText?.trim() ? input.groundedEvidenceText : '',
    'Output capability boundaries, actor slots, must-carry rules, edge cases, and open decisions.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.capability_reasoning.maxUserChars);
}

export function buildFeatureFormatterSystemPrompt(): string {
  return trimText(
    [
      'You convert capability reasoning into a small, high-quality feature set.',
      'Each feature must represent an independently valuable business capability.',
      'Use "As a [role], I need ... so that ..." descriptions.',
      'Capability labels must contain concrete business objects or workflow nouns from the evidence.',
      'Avoid thin CRUD fragments and vague actor labels.',
      'Leave acceptance requirements out of this step.',
    ].join(' '),
    V2_PROMPT_BUDGETS.feature_formatter.maxSystemChars,
  );
}

export function buildFeatureFormatterUserMessage(input: {
  reasoning: V2CapabilityReasoningArtifact;
  processTaxonomyEnabled?: boolean;
  processCodes?: Array<{ code: string; name: string; definition: string }>;
}): string {
  const taxonomy = input.processTaxonomyEnabled && input.processCodes?.length
    ? `Optional process taxonomy:\n${compactList(input.processCodes.map((entry) => `${entry.code}: ${entry.name} - ${entry.definition}`), 5)}`
    : '';
  const capabilityLines = input.reasoning.capabilities.map((capability) => (
    `${capability.label} | owner=${capability.ownerRole} | boundary=${capability.boundary} | rules=${capability.mustCarryRules.join('; ')} | edges=${capability.edgeCases.join('; ')}`
  ));
  const parts = [
    `Capability reasoning:\n${compactList(capabilityLines, 6)}`,
    input.reasoning.openDecisions.length ? `Open decisions:\n${compactList(input.reasoning.openDecisions.map((decision) => `${decision.title}: ${decision.detail}`), 6)}` : '',
    taxonomy,
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.feature_formatter.maxUserChars);
}

export function buildArWriterSystemPrompt(): string {
  return trimText(
    [
      'You write acceptance requirements for one feature at a time.',
      'Each requirement must be GIVEN/WHEN/THEN, business-facing, testable, and scenario-rich.',
      'Cover primary behavior, key rules, and realistic exceptions when they are implied.',
      'Do not invent implementation detail.',
      'Do not force arbitrary counts; write enough to cover real behavior.',
    ].join(' '),
    V2_PROMPT_BUDGETS.ar_writer.maxSystemChars,
  );
}

export function buildArWriterUserMessage(input: {
  feature: { summary: string; description: string };
  capabilityReasoning: V2CapabilityReasoningArtifact;
}): string {
  const related = input.capabilityReasoning.capabilities.find((item) => item.label === input.feature.summary)
    ?? input.capabilityReasoning.capabilities[0];
  const parts = [
    `Feature summary: ${trimText(input.feature.summary, 120)}`,
    `Feature description: ${trimText(input.feature.description, 220)}`,
    related
      ? `Rules and edge cases:\n${compactList([...related.mustCarryRules, ...related.edgeCases], 8)}`
      : '',
    input.capabilityReasoning.openDecisions.length
      ? `Do not silently resolve these open decisions:\n${compactList(input.capabilityReasoning.openDecisions.map((decision) => decision.title), 4)}`
      : '',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.ar_writer.maxUserChars);
}

export function buildCompactEvidenceSummary(input: {
  domainContext?: string;
  similarStoriesText?: string;
  wiContextText?: string;
}): string {
  const parts = [
    input.domainContext?.trim() ? `Domain context: ${trimText(input.domainContext, 180)}` : '',
    input.similarStoriesText?.trim() ? `Backlog cues: ${trimText(input.similarStoriesText, 160)}` : '',
    input.wiContextText?.trim() ? `Operational cues: ${trimText(input.wiContextText, 160)}` : '',
  ].filter(Boolean);
  return trimText(parts.join('\n'), 520);
}

export function validateDiscoveryQuestions(data: unknown): string | null {
  const payload = data as { questions?: V2DiscoveryQuestion[] } | null;
  return payload?.questions?.length ? null : 'Discovery output must contain at least one usable question.';
}

export function validateTriageScores(data: unknown): string | null {
  const payload = data as Record<string, unknown> | null;
  const legacyEntries = [payload?.capability_breadth, payload?.ask_clarity, payload?.actor_clarity];
  const legacyValid = legacyEntries.every((entry) => Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 5);
  if (legacyValid) return null;

  const entries = [payload?.complexity, payload?.ambiguity, payload?.workflow_depth, payload?.actor_clarity];
  const scoresValid = entries.every((entry) => Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 5);
  const countValid = Number.isInteger(payload?.recommended_discovery_count)
    && Number(payload?.recommended_discovery_count) >= 0
    && Number(payload?.recommended_discovery_count) <= 15;
  const depthValid = payload?.ar_depth === 'light' || payload?.ar_depth === 'standard' || payload?.ar_depth === 'deep';
  const behaviorsValid = Array.isArray(payload?.must_cover_behaviors) && payload.must_cover_behaviors.length > 0;
  return scoresValid && countValid && depthValid && behaviorsValid
    ? null
    : 'Triage output must provide 1-5 integer scores for the requirement profile, must-cover behaviors, discovery count, and AR depth.';
}

export function validateScopeHypothesis(data: unknown): string | null {
  const payload = data as V2ScopeHypothesis | null;
  return payload?.capabilities?.length ? null : 'Scope hypothesis must contain at least one capability.';
}

export function validateReasoningArtifact(data: unknown): string | null {
  const payload = data as V2CapabilityReasoningArtifact | null;
  return payload?.capabilities?.length ? null : 'Capability reasoning must contain at least one capability.';
}

export function validateSynthesis(data: unknown): string | null {
  const payload = data as V2DiscoverySynthesis | null;
  return payload?.mustCoverBehaviors?.length && payload?.featureTarget
    ? null
    : 'Discovery synthesis must contain must-cover behaviors and a feature target.';
}

export function validateFinalGeneration(data: unknown): string | null {
  const payload = data as V2FinalGenerationResponse | null;
  if (!payload?.features?.length) return 'Final generation must contain at least one feature.';
  const missingArs = payload.features.find((feature) => !feature.acceptanceRequirements?.length);
  if (missingArs) return `Feature "${missingArs.summary}" must contain acceptance requirements.`;
  return null;
}
