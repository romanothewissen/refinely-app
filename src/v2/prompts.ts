import type { JsonSchema } from '../core/json-schema';
import type {
  V2CapabilityReasoningArtifact,
  V2ClassifiedAnswer,
  V2DiscoveryQuestion,
  V2PromptBudget,
  V2ScopeHypothesis,
  V2TriageResult,
} from './types';

export const V2_PROMPT_BUDGETS: Record<V2PromptBudget['stage'], V2PromptBudget> = {
  triage: { stage: 'triage', maxSystemChars: 1200, maxUserChars: 1600 },
  scope_hypothesis: { stage: 'scope_hypothesis', maxSystemChars: 1400, maxUserChars: 1800 },
  discover: { stage: 'discover', maxSystemChars: 1800, maxUserChars: 2200 },
  capability_reasoning: { stage: 'capability_reasoning', maxSystemChars: 2000, maxUserChars: 2600 },
  feature_formatter: { stage: 'feature_formatter', maxSystemChars: 1200, maxUserChars: 1800 },
  ar_writer: { stage: 'ar_writer', maxSystemChars: 1700, maxUserChars: 2200 },
};

export const V2_TRIAGE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['capability_breadth', 'ask_clarity', 'actor_clarity'],
  additionalProperties: false,
  properties: {
    capability_breadth: { type: 'integer', minimum: 1, maximum: 5 },
    ask_clarity: { type: 'integer', minimum: 1, maximum: 5 },
    actor_clarity: { type: 'integer', minimum: 1, maximum: 5 },
  },
};

function trimText(value: string, maxChars: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 24).trimEnd()} ...[trimmed]`;
}

function compactList(items: string[], max = 5): string {
  return items.slice(0, max).map((item) => `- ${trimText(item, 160)}`).join('\n');
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
    openDecisions: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        required: ['title', 'detail', 'blocking'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 4, maxLength: 100 },
          detail: { type: 'string', minLength: 6, maxLength: 200 },
          blocking: { type: 'boolean' },
        },
      },
    },
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
      items: {
        type: 'object',
        required: ['given', 'when', 'then'],
        additionalProperties: false,
        properties: {
          given: { type: 'string', minLength: 6, maxLength: 220 },
          when: { type: 'string', minLength: 6, maxLength: 220 },
          then: { type: 'string', minLength: 6, maxLength: 220 },
        },
      },
    },
  },
};

export function measurePromptSizes(systemPrompt: string, userMessage: string) {
  return {
    systemChars: systemPrompt.length,
    userChars: userMessage.length,
  };
}

export function buildScopeHypothesisSystemPrompt(): string {
  return trimText(
    [
      'You identify the smallest set of meaningful business capabilities implied by a requirement.',
      'Focus on business outcomes, not CRUD fragments or implementation steps.',
      'Return 1-6 core capabilities, proposed actor slots, and the unresolved questions that could change scope.',
      'Use neutral actor labels when confidence is low.',
      'Do not write acceptance requirements or implementation detail.',
    ].join(' '),
    V2_PROMPT_BUDGETS.scope_hypothesis.maxSystemChars,
  );
}

export function buildTriageSystemPrompt(): string {
  return trimText(
    [
      'You only size how much clarification is needed before backlog-quality decomposition.',
      'Score only the requirement and excerpt provided by the user.',
      'Do not write discovery questions, solution details, features, or acceptance requirements.',
      'Return JSON only with: capability_breadth, ask_clarity, actor_clarity.',
      'Rubric: capability_breadth (1=single capability, 3=several related outcomes, 5=many distinct outcomes).',
      'Rubric: ask_clarity (1=goals/scope unclear, 3=partially specified, 5=scope and constraints are clear).',
      'Rubric: actor_clarity (1=no usable accountability, 3=partial role hints, 5=clear initiator/performer/approver-observer).',
    ].join(' '),
    V2_PROMPT_BUDGETS.triage.maxSystemChars,
  );
}

export function buildTriageUserMessage(input: { requirement: string; attachmentText?: string }): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 1100)}`,
    input.attachmentText?.trim()
      ? `Evidence excerpt (use only what is here):\n${trimText(input.attachmentText, 420)}`
      : '',
    'Return JSON matching the schema.',
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.triage.maxUserChars);
}

export function buildScopeHypothesisUserMessage(input: {
  requirement: string;
  attachmentText?: string;
  triage: V2TriageResult;
  domainContext?: string;
}): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 900)}`,
    input.attachmentText?.trim() ? `Attachment context:\n${trimText(input.attachmentText, 360)}` : '',
    input.domainContext?.trim() ? `Optional domain context:\n${trimText(input.domainContext, 320)}` : '',
    `Triage hints:\n- discovery mode: ${input.triage.discoveryMode}\n- likely capability count: ${input.triage.likelyCapabilityCount}\n- crud risk: ${input.triage.crudRisk}`,
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.scope_hypothesis.maxUserChars);
}

export function buildDiscoverySystemPrompt(): string {
  return trimText(
    [
      'You write only material discovery questions.',
      'Questions must be neutral, non-leading, and specific to the requirement.',
      'Do not assume role names that are not already confirmed.',
      'Ask only questions that can materially change capability boundaries, actor accountability, business rules, or lifecycle handling.',
      'Prefer concise questions and short suggestion chips.',
    ].join(' '),
    V2_PROMPT_BUDGETS.discover.maxSystemChars,
  );
}

export function buildDiscoveryUserMessage(input: {
  requirement: string;
  triage: V2TriageResult;
  scopeHypothesis: V2ScopeHypothesis;
  domainContext?: string;
}): string {
  const parts = [
    `Requirement:\n${trimText(input.requirement, 900)}`,
    `Proposed capabilities:\n${compactList(input.scopeHypothesis.capabilities.map((capability) => `${capability.label}: ${capability.rationale}`), 6)}`,
    `Open uncertainties:\n${compactList(input.scopeHypothesis.openQuestions, 6) || '- none'}`,
    input.domainContext?.trim() ? `Optional domain context:\n${trimText(input.domainContext, 260)}` : '',
    `Generate up to ${input.triage.questionBudget} high-value discovery questions for this round only.`,
  ].filter(Boolean);
  return trimText(parts.join('\n\n'), V2_PROMPT_BUDGETS.discover.maxUserChars);
}

export function buildCapabilityReasoningSystemPrompt(): string {
  return trimText(
    [
      'You are the thinker pass.',
      'Refine capability boundaries, actor accountability, rules, edge cases, and open decisions.',
      'Do not format final feature descriptions yet.',
      'Preserve meaningful workflow depth and exception handling.',
      'Avoid CRUD decomposition unless the requirement is explicitly administrative.',
    ].join(' '),
    V2_PROMPT_BUDGETS.capability_reasoning.maxSystemChars,
  );
}

export function buildCapabilityReasoningUserMessage(input: {
  requirement: string;
  scopeHypothesis: V2ScopeHypothesis;
  classifiedAnswers: V2ClassifiedAnswer[];
  evidenceSummary: string;
}): string {
  const materialAnswers = input.classifiedAnswers
    .filter((answer) => answer.materiality !== 'trivial')
    .map((answer) => `${answer.question} => ${answer.answer}`);

  const parts = [
    `Requirement:\n${trimText(input.requirement, 800)}`,
    `Confirmed capability hypothesis:\n${compactList(input.scopeHypothesis.capabilities.map((capability) => capability.label), 6)}`,
    materialAnswers.length ? `Material discovery answers:\n${compactList(materialAnswers, 8)}` : '',
    input.evidenceSummary ? `Compact evidence:\n${trimText(input.evidenceSummary, 420)}` : '',
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
  const payload = data as { capability_breadth?: unknown; ask_clarity?: unknown; actor_clarity?: unknown } | null;
  const entries = [
    payload?.capability_breadth,
    payload?.ask_clarity,
    payload?.actor_clarity,
  ];
  const valid = entries.every((entry) => Number.isInteger(entry) && Number(entry) >= 1 && Number(entry) <= 5);
  return valid ? null : 'Triage output must provide 1-5 integer scores for breadth, ask clarity, and actor clarity.';
}

export function validateScopeHypothesis(data: unknown): string | null {
  const payload = data as V2ScopeHypothesis | null;
  return payload?.capabilities?.length ? null : 'Scope hypothesis must contain at least one capability.';
}

export function validateReasoningArtifact(data: unknown): string | null {
  const payload = data as V2CapabilityReasoningArtifact | null;
  return payload?.capabilities?.length ? null : 'Capability reasoning must contain at least one capability.';
}
