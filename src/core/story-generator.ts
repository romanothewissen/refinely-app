/**
 * Two-pass feature generation pipeline.
 *
 * Pass 1: Decompose requirement into features (summary, description, process_code, story_points)
 * Pass 2: Write GIVEN/WHEN/THEN acceptance requirements for each feature
 *
 * All LLM calls route through the configured provider abstraction.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Feature,
  ClarifyQuestion,
  ClarifyAnswer,
  TenantConfig,
  GenerationResult,
  DiscoveryCoverageDimension,
  DiscoveryCoverageResult,
  InitiativeGroup,
  PlannerDecision,
  ScopeMode,
  ValidationViolation,
  TokenUsageSummary,
} from '../types';
import { callLlm, callLlmJson, callLlmJsonWithUsage } from './llm';
import { getTierModel } from '../services/billing';
import { buildHeuristicPlannerDecision, buildPlannerDecision } from './planner';
import {
  buildDecompositionSystemPrompt,
  buildArSystemPrompt,
  buildClarifySystemPrompt,
  buildEvaluateSystemPrompt,
  buildInitiativeGroupingSystemPrompt,
  buildRefineSystemPrompt,
  buildSingleFeatureRefineSystemPrompt,
  buildRefineSufficiencyPrompt,
  formatGoldExample,
} from './prompts';
import { validateFeatures } from './quality-validator';

// ─── Types from LLM response ──────────────────────────────────────────────────

interface RawFeature {
  summary?: string;
  description?: string;
  /** Snake_case (preferred in prompts) */
  acceptance_requirements?: unknown[];
  /** Some models return camelCase — we merge both */
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
}

interface RawInitiativeGroup {
  id?: string;
  title?: string;
  summary?: string;
  feature_ids?: unknown[];
  featureIds?: unknown[];
}

interface RawCoverageDimension {
  key?: string;
  label?: string;
  required?: boolean;
  score?: number;
  status?: string;
  evidence?: string;
}

interface ClarifyQuestionPlan {
  min: number;
  max: number;
  target: number;
  clarity: 'clear' | 'medium' | 'vague';
}

interface FeaturePlan {
  min: number;
  max: number;
  target: number;
  shape: 'narrow' | 'balanced' | 'broad';
  complexity: 'low' | 'medium' | 'high';
}

interface ArPlan {
  min: number;
  max: number;
  target: number;
  depth: 'lean' | 'standard' | 'thorough';
}

interface ClarifyAmbiguityAssessment {
  level: 'clear' | 'medium' | 'vague';
  score: number;
  reasons: string[];
  questionPlan: { min: number; max: number; target: number };
  generatedQuestions: number;
}

const CLARIFY_CATEGORY_ORDER = [
  'Roles & Personas',
  'Trigger & Context',
  'Functional Flow',
  'Business Rules & Exceptions',
  'Success & Measurement',
] as const;

const CLARIFY_CATEGORY_ALIASES: Array<{ match: RegExp; canonical: (typeof CLARIFY_CATEGORY_ORDER)[number] }> = [
  { match: /(role|persona|user|actor|stakeholder|owner)/i, canonical: 'Roles & Personas' },
  { match: /(trigger|context|event|timing|dependency|integration|input)/i, canonical: 'Trigger & Context' },
  { match: /(flow|workflow|journey|process|step)/i, canonical: 'Functional Flow' },
  { match: /(rule|exception|policy|constraint|edge|permission|override)/i, canonical: 'Business Rules & Exceptions' },
  { match: /(success|measurement|metric|audit|trace|report|outcome)/i, canonical: 'Success & Measurement' },
];

function getProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenaiApiKey: config.generatorConfig.azureOpenaiApiKey,
    azureOpenaiEndpoint: config.generatorConfig.azureOpenaiEndpoint,
    azureOpenaiDeployment: config.generatorConfig.azureOpenaiDeployment,
    azureOpenaiApiVersion: config.generatorConfig.azureOpenaiApiVersion,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;
}

function normaliseQuestionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactSuggestion(raw: unknown): string {
  const text = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  const words = text.split(' ');
  return words.slice(0, 48).join(' ');
}

function canonicalizeClarifyCategory(category: string): (typeof CLARIFY_CATEGORY_ORDER)[number] {
  const cleaned = String(category ?? '').trim();
  const directMatch = CLARIFY_CATEGORY_ORDER.find((item) => item.toLowerCase() === cleaned.toLowerCase());
  if (directMatch) return directMatch;
  return CLARIFY_CATEGORY_ALIASES.find((item) => item.match.test(cleaned))?.canonical ?? 'Functional Flow';
}

function sortClarifyingQuestions(questions: ClarifyQuestion[]): ClarifyQuestion[] {
  return questions
    .map((question, index) => ({
      index,
      question: {
        ...question,
        category: canonicalizeClarifyCategory(question.category),
      },
    }))
    .sort((left, right) => {
      const categoryDelta =
        CLARIFY_CATEGORY_ORDER.indexOf(left.question.category as (typeof CLARIFY_CATEGORY_ORDER)[number]) -
        CLARIFY_CATEGORY_ORDER.indexOf(right.question.category as (typeof CLARIFY_CATEGORY_ORDER)[number]);
      return categoryDelta !== 0 ? categoryDelta : left.index - right.index;
    })
    .map((item) => item.question);
}

function buildRequirementAnchor(requirement: string): string {
  const cleaned = requirement.replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'this requirement';
  const words = cleaned.split(' ');
  return words.length <= 12 ? cleaned : `${words.slice(0, 12).join(' ')}...`;
}

function buildFallbackRequirementSignals(requirement: string) {
  const signals = extractDomainSignals([requirement]).slice(0, 8);
  const actor =
    requirement.match(/^\s*an?\s+([A-Za-z0-9/-]{2,}(?:\s+[A-Za-z0-9/-]{2,}){0,2})\s+must\b/i)?.[1] ??
    requirement.match(/\bas\s+an?\s+([A-Za-z0-9/-]{2,}(?:\s+[A-Za-z0-9/-]{2,}){0,2})\b/i)?.[1] ??
    signals[0] ??
    'the primary user';
  const decisionObject =
    requirement.match(/\b(?:provided|shown|assigned|generated|created|given|offered)\s+an?\s+([^,.]+)/i)?.[1]?.trim() ??
    requirement.match(/\b(?:determine|schedule|assign|route|prioritize|recommend)\s+([^,.]+)/i)?.[1]?.trim() ??
    signals.slice(0, 3).join(' ') ??
    'the final decision';
  const factors = (
    requirement.match(/\bbased on\s+([^,.]+)/i)?.[1] ??
    requirement.match(/\busing\s+([^,.]+)/i)?.[1] ??
    ''
  )
    .split(/\s+(?:and|or)\s+|,\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);

  return {
    actor,
    decisionObject,
    factorA: factors[0] ?? signals[1] ?? 'priority factors',
    factorB: factors[1] ?? signals[2] ?? 'timing constraints',
    contextA: signals[1] ?? factors[0] ?? 'business context',
    contextB: signals[2] ?? factors[1] ?? 'operational constraints',
  };
}

const DOMAIN_SIGNAL_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'and', 'any', 'are', 'around', 'because',
  'been', 'before', 'being', 'between', 'both', 'business', 'but', 'capability', 'can', 'could',
  'does', 'each', 'from', 'have', 'into', 'must', 'need', 'needs', 'only', 'other', 'over',
  'same', 'should', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'under', 'using', 'when', 'where', 'which', 'while', 'with', 'would',
]);

function extractDomainSignals(parts: string[]): string[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    const matches = part.match(/\b[A-Za-z][A-Za-z0-9/-]{2,}\b/g) ?? [];
    for (const raw of matches) {
      const normalized = raw.trim();
      const lower = normalized.toLowerCase();
      if (DOMAIN_SIGNAL_STOPWORDS.has(lower)) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const frequencyDelta = right[1] - left[1];
      return frequencyDelta !== 0 ? frequencyDelta : right[0].length - left[0].length;
    })
    .map(([signal]) => signal)
    .slice(0, 14);
}

function parseQuestionCandidates(rawData: unknown): ClarifyQuestion[] {
  let candidates: any[] = [];
  if (Array.isArray(rawData)) {
    candidates = rawData;
  } else if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).questions)) {
    candidates = (rawData as any).questions;
  } else if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).features)) {
    candidates = (rawData as any).features;
  }

  return candidates
    .filter(x => typeof x === 'object' && x !== null && typeof (x as any).question === 'string')
    .map(x => ({
      category: canonicalizeClarifyCategory(String((x as any).category ?? 'Functional Flow').trim() || 'Functional Flow'),
      question: String((x as any).question ?? '').trim(),
      suggestions: Array.isArray((x as any).suggestions)
        ? (x as any).suggestions.map((s: unknown) => compactSuggestion(s)).filter(Boolean).slice(0, 5)
        : [],
    }))
    .filter(q => q.question.length > 0);
}

function dedupeQuestions(questions: ClarifyQuestion[]): ClarifyQuestion[] {
  const seen = new Set<string>();
  const result: ClarifyQuestion[] = [];
  for (const q of questions) {
    const key = normaliseQuestionKey(q.question);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(q);
  }
  return result;
}

function buildFallbackQuestions(requirement: string, needed: number): ClarifyQuestion[] {
  const normalizedRequirement = requirement.toLowerCase();
  const anchor = buildRequirementAnchor(requirement);
  const focus = buildFallbackRequirementSignals(requirement);
  const targetedTemplates: Array<{ matches: RegExp; question: ClarifyQuestion }> = [
    {
      matches: /\b(optimal|optimi[sz]e|optimization|priority|prioriti[sz]|criticality|due date|sla|weight|score|trade[- ]off|ranking|rank|urgency)\b/i,
      question: {
        category: 'Business Rules & Exceptions',
        question: `For "${anchor}", when ${focus.factorA} conflicts with ${focus.factorB}, how should the system rank options and break ties?`,
        suggestions: [
          `Always prioritize ${focus.factorA}, then use ${focus.factorB} as a secondary tiebreaker.`,
          `Use a weighted scoring model that balances ${focus.factorA}, ${focus.factorB}, and operational feasibility.`,
          `Allow configurable precedence rules so each business unit can tune the ranking logic.`,
        ],
      },
    },
    {
      matches: /\b(schedule|assign|allocation|allocate|dispatch|route|queue|sequence|sequencing|slot|calendar|timeline|reschedul)\w*\b/i,
      question: {
        category: 'Trigger & Context',
        question: `For "${anchor}", what events should create, recalculate, or adjust ${focus.decisionObject} as ${focus.contextA} or ${focus.contextB} change?`,
        suggestions: [
          `Recalculate immediately when critical inputs, availability, or priorities change.`,
          `Refresh on scheduled planning checkpoints plus exceptional business events.`,
          `Let users trigger recalculation manually, but also automate it for high-impact changes.`,
        ],
      },
    },
    {
      matches: /\b(approval|approve|review|override|manual|escalat)\w*\b/i,
      question: {
        category: 'Roles & Personas',
        question: `For "${anchor}", who can review, override, or approve ${focus.decisionObject}, and under what conditions?`,
        suggestions: [
          `Only the operational owner can change it, with all overrides fully logged.`,
          `Supervisors can approve exception cases when the normal policy would miss commitments.`,
          `No manual override is allowed once the decision has been published downstream.`,
        ],
      },
    },
    {
      matches: /\b(integration|sync|import|export|api|feed|source|external|vendor|upstream|downstream)\b/i,
      question: {
        category: 'Trigger & Context',
        question: `For "${anchor}", what upstream data or dependent processes must be available before ${focus.decisionObject} can be trusted, and what should happen when they are missing or stale?`,
        suggestions: [
          `Block the decision until required source data is present and validated.`,
          `Use the last known good data, but flag the result for operational review.`,
          `Proceed with a degraded result only when the business impact is low and visible.`,
        ],
      },
    },
    {
      matches: /\b(notif|alert|visible|dashboard|report|audit|history|trace)\w*\b/i,
      question: {
        category: 'Success & Measurement',
        question: `For "${anchor}", who needs visibility into ${focus.decisionObject}, and what level of traceability or explanation is required?`,
        suggestions: [
          `Show only the final outcome and the most important reason behind it.`,
          `Expose the key ranking factors so planners can understand why this option won.`,
          `Keep a full audit trail of every recalculation, override, and downstream change.`,
        ],
      },
    },
  ];

  const templates: ClarifyQuestion[] = [
    {
      category: 'Roles & Personas',
      question: `For "${anchor}", which role owns ${focus.decisionObject}, and which other roles are directly affected when it changes?`,
      suggestions: [
        `One accountable owner manages the final outcome, with others only informed afterward.`,
        `Operational planning owns it, but downstream execution teams are directly impacted.`,
        `Ownership shifts by process step, with one role proposing and another approving.`,
      ],
    },
    {
      category: 'Trigger & Context',
      question: `For "${anchor}", what business event should trigger ${focus.decisionObject}, and what context about ${focus.actor}, ${focus.contextA}, or ${focus.contextB} must already be known?`,
      suggestions: [
        `Trigger it when a new business need enters planning and core inputs are complete.`,
        `Trigger it when a relevant status, priority, or timing condition changes materially.`,
        `Run it on a scheduled planning cadence, with extra runs for exception events.`,
      ],
    },
    {
      category: 'Functional Flow',
      question: `For "${anchor}", what should the happy-path flow look like from the first trigger to a finalized ${focus.decisionObject} for ${focus.actor}?`,
      suggestions: [
        `A straight-through flow calculates the recommendation and immediately publishes it.`,
        `The system proposes an outcome first, then a planner reviews it before release.`,
        `The flow varies depending on urgency, policy constraints, or business segment.`,
      ],
    },
    {
      category: 'Functional Flow',
      question: `For "${anchor}", what inputs or facts about ${focus.actor}, ${focus.contextA}, and ${focus.contextB} should the system consider before finalizing ${focus.decisionObject}?`,
      suggestions: [
        `Use only the current request and the operational data available right now.`,
        `Combine the request with historical patterns, reference rules, and live constraints.`,
        `Blend policy data, recent changes, and execution capacity before making the decision.`,
      ],
    },
    {
      category: 'Business Rules & Exceptions',
      question: `For "${anchor}", what rules or constraints must always be respected, even when they conflict with the preferred ${focus.decisionObject}?`,
      suggestions: [
        `Hard business policies always override optimization or convenience goals.`,
        `Role permissions and contractual commitments limit which outcomes are allowed.`,
        `Operational capacity, timing windows, and required capabilities cannot be violated.`,
      ],
    },
    {
      category: 'Business Rules & Exceptions',
      question: `For "${anchor}", what should happen when the ideal ${focus.decisionObject} cannot be achieved or the required information is missing?`,
      suggestions: [
        `Stop and request human action whenever the missing data could change the decision materially.`,
        `Proceed with a visible warning when the business can tolerate a lower-confidence result.`,
        `Apply a defined fallback policy and capture why the preferred option was not possible.`,
      ],
    },
    {
      category: 'Business Rules & Exceptions',
      question: `For "${anchor}", where are the key tradeoffs or policy decisions that could change ${focus.decisionObject} across different scenarios?`,
      suggestions: [
        `One enterprise-wide rule set should govern every scenario consistently.`,
        `Teams can tune thresholds, but the core ranking policy stays centrally managed.`,
        `The policy changes by case attributes, service tier, or operational urgency.`,
      ],
    },
    {
      category: 'Success & Measurement',
      question: `For "${anchor}", how should users know ${focus.decisionObject} is correct, and what business outcome defines success?`,
      suggestions: [
        `Success means the outcome follows policy and rarely requires manual correction.`,
        `Success means better turnaround time without sacrificing high-priority commitments.`,
        `Success means planners trust the recommendation and spend less time reworking it.`,
      ],
    },
    {
      category: 'Roles & Personas',
      question: `For "${anchor}", who needs to see, validate, act on, or be notified after ${focus.decisionObject} is produced?`,
      suggestions: [
        `Only the direct owner and the person executing the work need immediate visibility.`,
        `The owner plus the operational coordination team need to review and act on it.`,
        `Multiple downstream stakeholders need updates because the decision affects follow-on work.`,
      ],
    },
    {
      category: 'Trigger & Context',
      question: `For "${anchor}", what related processes, systems, or teams does ${focus.decisionObject} depend on, and how should those dependencies affect behavior?`,
      suggestions: [
        `It is mostly independent, with only one source system supplying required facts.`,
        `It depends on one upstream planning process that must complete before calculation.`,
        `It spans multiple teams or systems, so handoff failures must change the behavior visibly.`,
      ],
    },
    {
      category: 'Business Rules & Exceptions',
      question: `For "${anchor}", which exceptions need their own handling because the standard path to ${focus.decisionObject} would be risky, invalid, or misleading?`,
      suggestions: [
        `Permission or policy exceptions require a separate approval or review path.`,
        `Data quality problems should suspend the decision until the missing facts are corrected.`,
        `Capacity, timing, or dependency conflicts need their own fallback handling.`,
      ],
    },
    {
      category: 'Success & Measurement',
      question: `For "${anchor}", what level of explanation, auditability, or history should be retained so teams can trust and review ${focus.decisionObject} later?`,
      suggestions: [
        `Keep only the final choice and the top reasons that influenced it.`,
        `Capture the major decisions, overrides, and recalculation triggers for later review.`,
        `Store full traceability for every change because auditability is business-critical.`,
      ],
    },
    {
      category: 'Success & Measurement',
      question: `For "${anchor}", what should be configurable versus fixed so different business units or teams can use ${focus.decisionObject} consistently?`,
      suggestions: [
        `Keep the core logic fixed globally and allow only a few threshold settings.`,
        `Allow configuration of thresholds, windows, and tie-break priorities by context.`,
        `Let each business unit configure policies while keeping one common audit model.`,
      ],
    },
    {
      category: 'Functional Flow',
      question: `For "${anchor}", what volume, timing, or responsiveness expectations would materially change how ${focus.decisionObject} should behave?`,
      suggestions: [
        `Low volume is acceptable, so some manual validation can remain in the loop.`,
        `Near real-time decisions are needed because delays materially hurt operations.`,
        `High volume and strict SLAs require stable automation with minimal human intervention.`,
      ],
    },
  ];

  const prioritized = targetedTemplates
    .filter((template) => template.matches.test(normalizedRequirement))
    .map((template) => template.question);

  return dedupeQuestions([...prioritized, ...templates]).slice(0, Math.max(0, needed));
}

export function buildFallbackClarifyingQuestions(
  requirement: string,
  questionPlan: Pick<ClarifyQuestionPlan, 'min' | 'max' | 'target'>,
): ClarifyQuestion[] {
  const desiredQuestionCount = Math.min(
    questionPlan.max,
    Math.max(questionPlan.min, questionPlan.target),
  );
  return buildFallbackQuestions(requirement, desiredQuestionCount);
}

function throwAfterTimeout(timeoutMs: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
  });
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function sumUsage(usages: Array<{ input: number; output: number }>) {
  return usages.reduce(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
    }),
    { input: 0, output: 0 },
  );
}


function resolveGenerationStageTimeouts(reasoningMode: PlannerDecision['reasoningMode']) {
  // These are safety-net timeouts to catch genuine hangs (network issues, unresponsive model),
  // NOT performance targets. Real calls can legitimately take 60-120s on deep mode.
  // The queue has 900s total, so there is plenty of headroom.
  if (reasoningMode === 'deep') {
    return {
      pass1Ms: 120000,   // 2 min — Opus decomposition with large context
      pass2Ms: 240000,   // 4 min — Opus AR writing for a broad initiative
      groupingMs: 45000,
    };
  }

  return {
    pass1Ms: 90000,    // 90s — Sonnet decomposition
    pass2Ms: 150000,   // 2.5 min — Sonnet AR writing
    groupingMs: 30000,
  };
}

function truncateContext(text: string, maxChars: number): string {
  if (!text) return '';
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function buildGenerationContextSections(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  goldExamplesText: string;
  similarStoriesText: string;
  mode: 'pass1' | 'pass2';
  reasoningMode: PlannerDecision['reasoningMode'];
}): string[] {
  // Pass 1 (decomposition): full context — gold examples and similar stories inform the feature shape.
  // Pass 2 (AR writing): lean context — the features from pass 1 already carry the decomposition
  //   reasoning; pass 2 only needs the requirement, Q&A, and a small WI excerpt for domain accuracy.
  const budgets = opts.mode === 'pass1'
    ? (
      opts.reasoningMode === 'deep'
        ? { attachment: 5000, wi: 12000, gold: 6000, similar: 5000 }
        : { attachment: 1800, wi: 4500, gold: 2400, similar: 1800 }
    )
    : (
      // Pass 2 only needs WI context — it grounds ARs in real process steps and conditions.
      // Gold examples and similar stories were already used in pass 1.
      opts.reasoningMode === 'deep'
        ? { attachment: 600, wi: 4000, gold: 0, similar: 0 }
        : { attachment: 400, wi: 2500, gold: 0, similar: 0 }
    );

  const sections: string[] = [`REQUIREMENT: ${opts.requirement}`];

  if (opts.clarifyAnswers.length) {
    const qaText = opts.clarifyAnswers
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n');
    sections.push(`CLARIFICATION Q&A:\n${qaText}`);
  }

  if (opts.attachmentText) {
    sections.push(`ATTACHMENT CONTEXT:\n${truncateContext(opts.attachmentText, budgets.attachment)}`);
  }

  if (opts.wiContextText) {
    sections.push(`WORK INSTRUCTIONS:\n${truncateContext(opts.wiContextText, budgets.wi)}`);
  }

  if (opts.mode === 'pass1' && opts.goldExamplesText) {
    sections.push(`GOLD STANDARD EXAMPLES (for high-level format reference):\n${truncateContext(opts.goldExamplesText, budgets.gold)}`);
  }

  if (opts.mode === 'pass1' && opts.similarStoriesText) {
    sections.push(`SIMILAR STORIES FROM BACKLOG (for business context and writing style cues):\n${truncateContext(opts.similarStoriesText, budgets.similar)}`);
  }
  // Pass 2 does not need similar stories — features from pass 1 already reflect that context.

  return sections;
}

function buildFallbackFeatureSummary(requirement: string): string {
  const cleaned = requirement
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^as a .*?,\s*i need to\s+/i, '')
    .replace(/^to\s+/i, '');
  const firstSentence = cleaned.split(/[.!?]/)[0]?.trim() ?? '';
  const summary = firstSentence
    .replace(/\bso that\b[\s\S]*$/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 10)
    .join(' ');

  if (!summary) return 'Deliver requested business outcome';
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function inferFallbackRole(requirement: string, config: TenantConfig): string {
  const explicitRole = requirement.match(/\bAs a[n]?\s+([^,]+),/i)?.[1]?.trim();
  if (explicitRole) return explicitRole;
  if (config.domainRoles?.length) return config.domainRoles[0];
  return 'business user';
}

function buildFallbackDescription(requirement: string, config: TenantConfig): string {
  const role = inferFallbackRole(requirement, config);
  const benefitMatch = requirement.match(/\bso that\s+([^.!?]+)/i)?.[1]?.trim();
  const benefit = benefitMatch || 'the intended business outcome is delivered consistently';
  return `As a ${role}, I need to complete the requested business process with the right rules and decisions so that ${benefit}`;
}

function fallbackStoryPoints(complexity: FeaturePlan['complexity']): number {
  if (complexity === 'high') return 8;
  if (complexity === 'medium') return 5;
  return 3;
}

function buildFallbackFeatureCandidates(
  requirement: string,
  config: TenantConfig,
  decision: PlannerDecision,
): RawFeature[] {
  return [
    {
      summary: buildFallbackFeatureSummary(requirement),
      description: buildFallbackDescription(requirement, config),
      acceptance_requirements: [],
      suggested_story_points: fallbackStoryPoints(decision.featurePlan.complexity),
      process_code:
        config.processTaxonomyEnabled && config.processTaxonomy.length
          ? config.processTaxonomy[0].code
          : undefined,
    },
  ];
}

function buildFallbackAcceptanceRequirements(arPlan: ArPlan): string[] {
  const templates = [
    'GIVEN a valid business case exists and the required information is available WHEN the requested business capability is initiated THEN the expected business outcome is delivered for the responsible role',
    'GIVEN the request is subject to defined business rules or prioritization criteria WHEN the requested business capability evaluates the case THEN the resulting outcome follows those rules consistently',
    'GIVEN the request cannot be completed under the current conditions or contains conflicting information WHEN the requested business capability is assessed THEN the case is clearly flagged for the appropriate follow-up action',
    'GIVEN the outcome affects approvals, ownership, or downstream responsibilities WHEN the requested business capability reaches a decision THEN the correct business party receives the resulting responsibility',
    'GIVEN the request depends on related business context or upstream activity WHEN the requested business capability processes the case THEN the outcome remains consistent with that connected business context',
  ];

  const target = Math.max(2, Math.min(arPlan.target, arPlan.depth === 'thorough' ? 4 : 3));
  return templates.slice(0, target);
}

function ensureAcceptanceRequirements(
  rawFeatures: RawFeature[],
  arPlan: ArPlan,
): RawFeature[] {
  const minimumRequired = Math.max(2, Math.min(arPlan.min, arPlan.depth === 'thorough' ? 4 : 3));

  return rawFeatures.map((feature) => {
    const existing = getRawAcceptanceArray(feature);
    if (existing.length >= minimumRequired) {
      return feature;
    }

    const fallbacks = buildFallbackAcceptanceRequirements(arPlan).slice(0, minimumRequired - existing.length);
    return {
      ...feature,
      acceptance_requirements: [...existing, ...fallbacks],
    };
  });
}

function clampFeatureCandidates(rawFeatures: RawFeature[], featurePlan: FeaturePlan): RawFeature[] {
  if (featurePlan.max <= 0) return [];
  return rawFeatures.slice(0, featurePlan.max);
}

const DISCOVERY_DIMENSIONS: Array<{ key: DiscoveryCoverageDimension['key']; label: string }> = [
  { key: 'goal', label: 'Business goal' },
  { key: 'actors', label: 'Actors and roles' },
  { key: 'workflow', label: 'Workflow and triggers' },
  { key: 'business_rules', label: 'Business rules' },
  { key: 'exceptions', label: 'Exceptions and edge cases' },
  { key: 'permissions', label: 'Permissions and approvals' },
  { key: 'integrations', label: 'Integrations and dependencies' },
  { key: 'non_functional', label: 'Non-functional and compliance needs' },
  { key: 'success_metrics', label: 'Success metrics' },
];

function getRequiredCoverageDimensionKeys(scopeMode: ScopeMode): string[] {
  switch (scopeMode) {
    case 'atomic':
      return ['goal', 'actors', 'workflow', 'business_rules'];
    case 'focused':
      return ['goal', 'actors', 'workflow', 'business_rules', 'exceptions'];
    case 'standard':
      return ['goal', 'actors', 'workflow', 'business_rules', 'exceptions', 'permissions', 'integrations', 'success_metrics'];
    case 'initiative':
      return ['goal', 'actors', 'workflow', 'business_rules', 'exceptions', 'permissions', 'integrations', 'non_functional', 'success_metrics'];
    default:
      return ['goal', 'actors', 'workflow', 'business_rules'];
  }
}

function parseCoverageDimensionCandidates(rawData: unknown): RawCoverageDimension[] {
  if (Array.isArray(rawData)) return rawData as RawCoverageDimension[];
  if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).dimensions)) {
    return (rawData as any).dimensions as RawCoverageDimension[];
  }
  return [];
}

function normaliseCoverageStatus(value: string | undefined, score: number): DiscoveryCoverageDimension['status'] {
  const normalised = String(value ?? '').trim().toLowerCase();
  if (normalised === 'missing' || normalised === 'partial' || normalised === 'covered') {
    return normalised;
  }
  if (score >= 75) return 'covered';
  if (score >= 40) return 'partial';
  return 'missing';
}

function normaliseCoverageDimensions(rawData: unknown, scopeMode: ScopeMode): DiscoveryCoverageDimension[] {
  const requiredKeys = new Set(getRequiredCoverageDimensionKeys(scopeMode));
  const rawDimensions = parseCoverageDimensionCandidates(rawData);
  const byKey = new Map<string, RawCoverageDimension>();

  rawDimensions.forEach(dimension => {
    const key = String(dimension.key ?? '').trim().toLowerCase();
    if (!key || byKey.has(key)) return;
    byKey.set(key, dimension);
  });

  return DISCOVERY_DIMENSIONS.map(definition => {
    const candidate = byKey.get(definition.key) ?? {};
    const rawScore = Number(candidate.score);
    const score = Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : 0;
    const required = typeof candidate.required === 'boolean' ? candidate.required : requiredKeys.has(definition.key);

    return {
      key: definition.key,
      label: String(candidate.label ?? '').trim() || definition.label,
      required,
      score,
      status: normaliseCoverageStatus(candidate.status, score),
      evidence: String(candidate.evidence ?? '').trim() || 'No evidence captured.',
    };
  });
}

function getCoverageThreshold(scopeMode: ScopeMode): number {
  switch (scopeMode) {
    case 'atomic':
      return 60;
    case 'focused':
      return 65;
    case 'standard':
      return 70;
    case 'initiative':
      return 75;
    default:
      return 65;
  }
}

function buildCoverageSummary(dimensions: DiscoveryCoverageDimension[], missingCritical: string[]): string {
  if (!dimensions.length) return 'Coverage analysis was unavailable.';
  if (!missingCritical.length) return 'Discovery coverage is strong enough to generate the backlog.';

  const weakestRequired = dimensions
    .filter(dimension => dimension.required)
    .sort((left, right) => left.score - right.score)
    .slice(0, 2)
    .map(dimension => dimension.label.toLowerCase());

  if (!weakestRequired.length) {
    return 'Some important discovery areas still need stronger coverage.';
  }

  return `Coverage is still weakest around ${weakestRequired.join(' and ')}.`;
}

function normaliseCoverageResult(rawData: unknown, questions: ClarifyQuestion[], scopeMode: ScopeMode): DiscoveryCoverageResult {
  const dimensions = normaliseCoverageDimensions(rawData, scopeMode);
  const requiredDimensions = dimensions.filter(dimension => dimension.required);
  const requiredAverage = requiredDimensions.length
    ? Math.round(requiredDimensions.reduce((total, dimension) => total + dimension.score, 0) / requiredDimensions.length)
    : 0;
  const threshold = getCoverageThreshold(scopeMode);

  const rawMissing = rawData && typeof rawData === 'object' && Array.isArray((rawData as any).missing_critical)
    ? ((rawData as any).missing_critical as unknown[]).map(value => String(value ?? '').trim()).filter(Boolean)
    : [];

  const derivedMissing = requiredDimensions
    .filter(dimension => dimension.score < threshold || dimension.status !== 'covered')
    .map(dimension => dimension.label);

  const missingCritical = Array.from(new Set([...(rawMissing.length ? rawMissing : []), ...derivedMissing]));
  const hasHardGap = requiredDimensions.some(dimension => dimension.score < 45 || dimension.status === 'missing');
  const canGenerate = requiredAverage >= threshold && !hasHardGap;
  const summary = rawData && typeof rawData === 'object' && typeof (rawData as any).summary === 'string'
    ? String((rawData as any).summary).trim()
    : buildCoverageSummary(dimensions, missingCritical);

  return {
    sufficient: canGenerate,
    canGenerate,
    shouldContinueDiscovery: !canGenerate && questions.length > 0,
    overallScore: requiredAverage,
    summary,
    missingCritical,
    dimensions,
    questions,
  };
}

function parseInitiativeGroupCandidates(rawData: unknown): RawInitiativeGroup[] {
  if (Array.isArray(rawData)) return rawData as RawInitiativeGroup[];
  if (rawData && typeof rawData === 'object' && Array.isArray((rawData as any).groups)) {
    return (rawData as any).groups as RawInitiativeGroup[];
  }
  return [];
}

function buildFallbackInitiativeGroups(features: Feature[]): InitiativeGroup[] {
  if (!features.length) return [];
  return [
    {
      id: uuidv4(),
      title: 'Initiative backlog',
      summary: 'Grouped view was unavailable, so the generated backlog is shown as one initiative section.',
      featureIds: features.map(feature => feature.id),
    },
  ];
}

function normaliseInitiativeGroups(rawData: unknown, features: Feature[]): InitiativeGroup[] {
  const candidates = parseInitiativeGroupCandidates(rawData);
  const featureIds = new Set(features.map(feature => feature.id));
  const assigned = new Set<string>();
  const groups: InitiativeGroup[] = [];

  candidates.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return;
    const title = String(candidate.title ?? '').trim();
    if (!title) return;

    const rawFeatureIds = Array.isArray(candidate.feature_ids)
      ? candidate.feature_ids
      : Array.isArray(candidate.featureIds)
        ? candidate.featureIds
        : [];

    const featureIdsForGroup = rawFeatureIds
      .map(value => String(value ?? '').trim())
      .filter(Boolean)
      .filter(id => featureIds.has(id))
      .filter(id => {
        if (assigned.has(id)) return false;
        assigned.add(id);
        return true;
      });

    if (!featureIdsForGroup.length) return;

    groups.push({
      id: String(candidate.id ?? '').trim() || uuidv4(),
      title,
      summary: String(candidate.summary ?? '').trim() || `Group ${index + 1}`,
      featureIds: featureIdsForGroup,
    });
  });

  const unassigned = features
    .map(feature => feature.id)
    .filter(id => !assigned.has(id));

  if (unassigned.length) {
    if (groups.length) {
      groups[groups.length - 1] = {
        ...groups[groups.length - 1],
        featureIds: [...groups[groups.length - 1].featureIds, ...unassigned],
      };
    } else {
      return buildFallbackInitiativeGroups(features);
    }
  }

  return groups;
}

async function buildInitiativeGroups(opts: {
  requirement: string;
  features: Feature[];
  config: TenantConfig;
}): Promise<{ initiativeGroups: InitiativeGroup[]; tokenUsage?: TokenUsageSummary }> {
  const { requirement, features, config } = opts;

  if (features.length <= 1) {
    return { initiativeGroups: buildFallbackInitiativeGroups(features) };
  }

  const systemPrompt = buildInitiativeGroupingSystemPrompt({
    domainContext: config.domainContext,
    featureCount: features.length,
  });

  const userMessage = [
    `REQUIREMENT: ${requirement}`,
    `FEATURES:\n${JSON.stringify(features.map(feature => ({
      id: feature.id,
      summary: feature.summary,
      description: feature.description,
      storyPoints: feature.storyPoints,
      processCode: feature.processCode,
    })), null, 2)}`,
  ].join('\n\n---\n\n');

  try {
    const result = await callLlmJsonWithUsage<{ groups?: RawInitiativeGroup[] } | RawInitiativeGroup[]>({
      model: getTierModel(config.generatorConfig.themeModel, config.tier),
      systemPrompt,
      userMessage,
      ...getProviderOpts(config),
    });

    const initiativeGroups = normaliseInitiativeGroups(result.data, features);

    return {
      initiativeGroups: initiativeGroups.length ? initiativeGroups : buildFallbackInitiativeGroups(features),
      tokenUsage: {
        input: result.usage.input,
        output: result.usage.output,
        total: result.usage.input + result.usage.output,
        byStage: {
          initiativeGrouping: toStageUsage(result.usage),
        },
      },
    };
  } catch (error) {
    console.warn('[story-generator] Initiative grouping failed; falling back to a single section:', error);
    return { initiativeGroups: buildFallbackInitiativeGroups(features) };
  }
}

// ─── Main Generation ──────────────────────────────────────────────────────────

export async function generateFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  goldExamplesText: string;
  similarStoriesText: string;
  wiContextText: string;
  config: TenantConfig;
  reasoningMode?: 'fast' | 'deep';
  outputMode?: 'single' | 'auto' | 'full_breakdown';
  plannerDecision?: PlannerDecision;
  onPass1Complete?: (payload: {
    featureCount: number;
    draftFeatures: Feature[];
    arBatchCount: number;
  }) => Promise<void>;
}): Promise<GenerationResult> {
  const {
    requirement,
    clarifyAnswers,
    attachmentText,
    goldExamplesText,
    similarStoriesText,
    wiContextText,
    config,
    reasoningMode,
    outputMode,
    plannerDecision,
    onPass1Complete,
  } = opts;
  const { generatorConfig } = config;
  const decision = plannerDecision ?? buildHeuristicPlannerDecision({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    reasoningMode: reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode,
    outputMode: outputMode ?? config.aiExecutionPolicy.defaultOutputMode,
    policy: config.aiExecutionPolicy,
  });
  const providerOpts = getProviderOpts(config);

  const userMessage = buildGenerationContextSections({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    mode: 'pass1',
    reasoningMode: decision.reasoningMode,
  }).join('\n\n---\n\n');

  // ── Pass 1: Decomposition ──
  const pass1System = buildDecompositionSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
    featurePlan: decision.featurePlan,
  });

  const stageTimeouts = resolveGenerationStageTimeouts(decision.reasoningMode);

  // Pass 1 produces features with empty AR arrays — 3 500 tokens is generous for up to ~15 features.
  const pass1Result = await Promise.race([
    callLlmJsonWithUsage<{ features: RawFeature[] }>({
      model: getTierModel(generatorConfig.decompositionModel, config.tier),
      systemPrompt: pass1System,
      userMessage,
      maxTokens: Math.min(generatorConfig.maxTokens, 3500),
      ...providerOpts,
    }),
    throwAfterTimeout(stageTimeouts.pass1Ms, 'Pass 1 (decomposition)'),
  ]);
  const pass1Usage = pass1Result.usage;
  const pass1Features = clampFeatureCandidates(pass1Result.data.features ?? [], decision.featurePlan);

  if (!pass1Features.length) {
    throw new Error('Feature decomposition returned no valid features.');
  }

  const draftFeatures = pass1Features.map(normaliseFeature);

  if (onPass1Complete) {
    await onPass1Complete({
      featureCount: pass1Features.length,
      draftFeatures,
      arBatchCount: 1,
    });
  }

  // ── Pass 2: Acceptance Requirements ──
  const pass2System = buildArSystemPrompt({
    domainContext: config.domainContext,
    arPlan: decision.arPlan,
  });
  const pass2Context = buildGenerationContextSections({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    mode: 'pass2',
    reasoningMode: decision.reasoningMode,
  }).join('\n\n---\n\n');
  const pass2UserMessage = `${pass2Context}\n\n---\n\nFEATURES FROM PASS 1 (fill in acceptance_requirements for each):\n${JSON.stringify(pass1Features, null, 2)}`;

  // Pass 2 writes ARs only — 5 000 tokens covers ~10 features × 5 thorough ARs with room to spare.
  // On timeout fall back to pass 1 features with generic ARs so the user gets a partial result
  // they can refine rather than a hard failure.
  let pass2Usage = { input: 0, output: 0 };
  let rawFeatures: RawFeature[];
  try {
    const pass2Result = await Promise.race([
      callLlmJsonWithUsage<{ features: RawFeature[] }>({
        model: getTierModel(generatorConfig.arModel, config.tier),
        systemPrompt: pass2System,
        userMessage: pass2UserMessage,
        maxTokens: Math.min(generatorConfig.maxTokens, 5000),
        ...providerOpts,
      }),
      throwAfterTimeout(stageTimeouts.pass2Ms, 'Pass 2 (acceptance requirements)'),
    ]);
    pass2Usage = pass2Result.usage;
    rawFeatures = pass2Result.data.features?.length
      ? mergeFeatures(pass1Features, pass2Result.data.features)
      : ensureAcceptanceRequirements(pass1Features, decision.arPlan);
  } catch (pass2Err) {
    console.warn('[story-generator] Pass 2 timed out — returning pass 1 features with fallback ARs:', pass2Err);
    rawFeatures = ensureAcceptanceRequirements(pass1Features, decision.arPlan);
  }

  const features = rawFeatures.map(normaliseFeature);
  if (!features.length) {
    throw new Error('Acceptance requirement generation returned no valid features.');
  }
  const violations = validateFeatures(features, config);

  const tokenUsage: TokenUsageSummary = {
    input: pass1Usage.input + pass2Usage.input,
    output: pass1Usage.output + pass2Usage.output,
    total: pass1Usage.input + pass1Usage.output + pass2Usage.input + pass2Usage.output,
    byStage: {
      decomposition: toStageUsage(pass1Usage),
      acceptanceRequirements: toStageUsage(pass2Usage),
    },
  };

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
    plannerDecision: decision,
    tokenUsage,
  };
}

// ─── Clarifying Questions ─────────────────────────────────────────────────────

export async function generateClarifyingQuestions(opts: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  goldExamplesText: string;
  similarStoriesText: string;
  config: TenantConfig;
  reasoningMode?: 'fast' | 'deep';
  outputMode?: 'single' | 'auto' | 'full_breakdown';
  plannerDecision?: PlannerDecision;
}): Promise<{ questions: ClarifyQuestion[]; tokenUsage: TokenUsageSummary; ambiguityAssessment: ClarifyAmbiguityAssessment }> {
  const {
    requirement,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    config,
    reasoningMode,
    outputMode,
    plannerDecision,
  } = opts;
  const decision = plannerDecision ?? buildHeuristicPlannerDecision({
    requirement,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    reasoningMode: reasoningMode ?? config.aiExecutionPolicy.defaultReasoningMode,
    outputMode: outputMode ?? config.aiExecutionPolicy.defaultOutputMode,
    policy: config.aiExecutionPolicy,
  });
  const questionPlan = decision.questionPlan;
  // WI context is the dominant signal for question quality — give it the most room.
  // Gold examples and similar stories help avoid asking about what's already known.
  const contextCharBudget = decision.reasoningMode === 'deep'
    ? { attachment: 4000, wi: 14000, gold: 5000, similar: 5000 }
    : { attachment: 2800, wi: 8000, gold: 3200, similar: 3200 };
  // No explicit token cap — the response has a natural ceiling (a bounded JSON
  // array of questions) and truncating it causes silent parse failures.
  // callLlmJsonWithUsage defaults to 8192 when maxTokens is omitted.
  const clarifyMaxTokens = undefined;

  const contextParts: string[] = [`REQUIREMENT: ${requirement}`];
  if (attachmentText) contextParts.push(`ATTACHMENT: ${attachmentText.slice(0, contextCharBudget.attachment)}`);
  if (wiContextText) contextParts.push(`WORK INSTRUCTIONS EXCERPT: ${wiContextText.slice(0, contextCharBudget.wi)}`);
  if (goldExamplesText) contextParts.push(`DEPLOYED GOLD EXAMPLES:\n${goldExamplesText.slice(0, contextCharBudget.gold)}`);
  if (similarStoriesText) contextParts.push(`RELATED DEPLOYED BACKLOG ITEMS:\n${similarStoriesText.slice(0, contextCharBudget.similar)}`);
  const domainSignals = extractDomainSignals([
    requirement,
    attachmentText.slice(0, 1200),
    wiContextText.slice(0, 2200),
    goldExamplesText.slice(0, 2200),
    similarStoriesText.slice(0, 2200),
    ...(config.domainRoles ?? []),
  ]);
  if (domainSignals.length) {
    contextParts.push(`DOMAIN SIGNALS TO REUSE: ${domainSignals.join(', ')}`);
  }

  if (questionPlan.max <= 0) {
    return {
      questions: [],
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
        byStage: { clarify: { input: 0, output: 0, total: 0 } },
      },
      ambiguityAssessment: {
        level: questionPlan.clarity,
        score: decision.ambiguityScore,
        reasons: decision.ambiguityReasons.slice(0, 4),
        questionPlan: { min: questionPlan.min, max: questionPlan.max, target: questionPlan.target },
        generatedQuestions: 0,
      },
    };
  }

  const system = buildClarifySystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    domainSignals,
    questionPlan,
  });

  const desiredQuestionCount = Math.min(
    questionPlan.max,
    Math.max(questionPlan.min, questionPlan.target),
  );
  const raw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
    model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
    systemPrompt: system,
    userMessage: contextParts.join('\n\n'),
    maxTokens: clarifyMaxTokens,
    ...getProviderOpts(config),
  });

  const filteredQuestions = dedupeQuestions(parseQuestionCandidates(raw.data)).slice(0, questionPlan.max);

  if (filteredQuestions.length === 0) {
    // LLM returned nothing parseable — fall back to domain-aware template questions
    // so the user always sees something to answer rather than an error.
    console.warn('[generateClarifyingQuestions] LLM returned 0 valid questions; using fallback template.');
    const fallback = buildFallbackClarifyingQuestions(requirement, questionPlan);
    return {
      questions: fallback,
      tokenUsage: {
        input: raw.usage.input,
        output: raw.usage.output,
        total: raw.usage.input + raw.usage.output,
        byStage: { clarify: { input: raw.usage.input, output: raw.usage.output, total: raw.usage.input + raw.usage.output } },
      },
      ambiguityAssessment: {
        level: questionPlan.clarity,
        score: decision.ambiguityScore,
        reasons: decision.ambiguityReasons.slice(0, 4),
        questionPlan: { min: questionPlan.min, max: questionPlan.max, target: questionPlan.target },
        generatedQuestions: fallback.length,
      },
    };
  }

  if (filteredQuestions.length < questionPlan.min) {
    // Fewer questions than ideal but still usable — proceed rather than throwing.
    console.warn(`[generateClarifyingQuestions] LLM returned ${filteredQuestions.length} questions; target min was ${questionPlan.min}. Proceeding.`);
  }

  const totalTokens = raw.usage.input + raw.usage.output;

  return {
    questions: filteredQuestions,
    tokenUsage: {
      input: raw.usage.input,
      output: raw.usage.output,
      total: totalTokens,
      byStage: { clarify: { input: raw.usage.input, output: raw.usage.output, total: totalTokens } },
    },
    ambiguityAssessment: {
      level: questionPlan.clarity,
      score: decision.ambiguityScore,
      reasons: decision.ambiguityReasons.slice(0, 4),
      questionPlan: { min: questionPlan.min, max: questionPlan.max, target: questionPlan.target },
      generatedQuestions: filteredQuestions.length,
    },
  };
}

// ─── Evaluate Q&A Sufficiency ─────────────────────────────────────────────────

export async function evaluateSufficiency(opts: {
  requirement: string;
  answers: ClarifyAnswer[];
  config: TenantConfig;
  reasoningMode?: 'fast' | 'deep';
}): Promise<DiscoveryCoverageResult> {
  const decision = await buildPlannerDecision({
    requirement: opts.requirement,
    clarifyAnswers: opts.answers,
    attachmentText: '',
    wiContextText: '',
    goldExamplesText: '',
    similarStoriesText: '',
    config: opts.config,
    reasoningMode: opts.reasoningMode ?? opts.config.aiExecutionPolicy.defaultReasoningMode,
    outputMode: opts.config.aiExecutionPolicy.defaultOutputMode,
    policy: opts.config.aiExecutionPolicy,
  });
  const qaText = opts.answers
    .map(a => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  const userMessage = `REQUIREMENT: ${opts.requirement}\n\nQ&A:\n${qaText}`;

  const result = await callLlmJsonWithUsage<{
    summary?: string;
    missing_critical?: string[];
    dimensions?: RawCoverageDimension[];
    questions?: ClarifyQuestion[];
  }>({
    model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
    systemPrompt: buildEvaluateSystemPrompt({
      domainContext: opts.config.domainContext,
      scopeMode: decision.scopeMode,
    }),
    userMessage,
    ...getProviderOpts(opts.config),
  });

  const questions = dedupeQuestions(parseQuestionCandidates(result.data)).slice(0, 5);
  const coverage = normaliseCoverageResult(result.data, questions, decision.scopeMode);

  return {
    ...coverage,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: {
        evaluateCoverage: toStageUsage(result.usage),
      },
    },
  };
}

// ─── Refinement ───────────────────────────────────────────────────────────────

export async function refineFeatures(opts: {
  requirement: string;
  features: Feature[];
  feedback: string;
  config: TenantConfig;
}): Promise<{ features: Feature[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, features, feedback, config } = opts;

  const system = buildRefineSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
  });

  const userMessage = [
    `REQUIREMENT: ${requirement}`,
    `FEEDBACK: ${feedback}`,
    `CURRENT FEATURES:\n${JSON.stringify(features, null, 2)}`,
  ].join('\n\n');

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    maxTokens: config.generatorConfig.maxTokens,
    ...getProviderOpts(config),
  });

  return {
    features: (result.data.features ?? []).map(normaliseFeature),
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { refine: toStageUsage(result.usage) },
    },
  };
}

// ─── Single Feature Refinement ────────────────────────────────────────────────

export async function refineSingleFeature(opts: {
  feature: Feature;
  feedback: string;
  config: TenantConfig;
}): Promise<{ feature: Feature; tokenUsage: TokenUsageSummary }> {
  const { feature, feedback, config } = opts;

  const system = buildSingleFeatureRefineSystemPrompt({
    domainContext: config.domainContext,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
  });

  const userMessage = `FEATURE:\n${JSON.stringify(feature, null, 2)}\n\nFEEDBACK: ${feedback}`;

  const result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(config.generatorConfig.refineModel, config.tier),
    systemPrompt: system,
    userMessage,
    ...getProviderOpts(config),
  });

  const refined = result.data.features?.[0];
  const feedbackLower = feedback.toLowerCase();
  const touchesSummary = /(summary|title|name|rename)/i.test(feedbackLower);
  const touchesDescription = /(description|as a|so that|reword|rewrite)/i.test(feedbackLower);
  const touchesStoryPoints = /(story point|story points|estimate|estimation|sizing|size)/i.test(feedbackLower);
  const touchesProcessCode = /(process code|process_code|taxonomy|code)/i.test(feedbackLower);
  const candidate = refined ? normaliseFeature(refined) : feature;
  const stableResult: Feature = {
    ...feature,
    id: feature.id,
    summary: touchesSummary ? candidate.summary : feature.summary,
    description: touchesDescription ? candidate.description : feature.description,
    acceptanceRequirements: candidate.acceptanceRequirements?.length
      ? candidate.acceptanceRequirements
      : feature.acceptanceRequirements,
    storyPoints: touchesStoryPoints ? (candidate.storyPoints ?? feature.storyPoints) : feature.storyPoints,
    processCode: touchesProcessCode ? (candidate.processCode ?? feature.processCode) : feature.processCode,
  };

  return {
    feature: stableResult,
    tokenUsage: {
      input: result.usage.input,
      output: result.usage.output,
      total: result.usage.input + result.usage.output,
      byStage: { refineSingle: toStageUsage(result.usage) },
    },
  };
}

// ─── Refine Feedback Sufficiency ──────────────────────────────────────────────

export async function checkRefineFeedbackSufficiency(opts: {
  feature: Feature;
  feedback: string;
  config: TenantConfig;
}): Promise<{ sufficient: boolean; question?: string }> {
  const userMessage = `FEATURE SUMMARY: ${opts.feature.summary}\nFEEDBACK: "${opts.feedback}"`;

  const result = await callLlmJson<{ sufficient: boolean; question?: string }>({
    model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
    systemPrompt: buildRefineSufficiencyPrompt(),
    userMessage,
    ...getProviderOpts(opts.config),
  });

  return result;
}

// ─── Session Title ────────────────────────────────────────────────────────────

export async function generateSessionTitle(requirement: string, config: TenantConfig): Promise<string> {
  const res = await callLlm({
    model: getTierModel(config.generatorConfig.themeModel, config.tier),
    systemPrompt: `Generate a concise, concrete conversation title for a backlog-generation session.

Rules:
- 4 to 7 words
- Use the real business noun and action from the requirement
- No quotes, no punctuation at the end, no filler like "feature", "request", or "session"
- Prefer titles that would look good in a conversation history list`,
    userMessage: requirement,
    maxTokens: 32,
    ...getProviderOpts(config),
  });
  return normalizeConversationTitle(res.text, requirement);
}

// ─── Ask / Chat ───────────────────────────────────────────────────────────────

export async function askQuestion(opts: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  systemPrompt: string;
  config: TenantConfig;
}): Promise<string> {
  const historyText = opts.history
    .slice(-10)
    .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
    .join('\n');

  const userMessage = historyText
    ? `${historyText}\nUser: ${opts.message}`
    : opts.message;

  const res = await callLlm({
    model: opts.config.generatorConfig.arModel,
    systemPrompt: opts.systemPrompt,
    userMessage,
    ...getProviderOpts(opts.config),
  });

  return res.text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseFeature(raw: RawFeature): Feature {
  return {
    id: uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  };
}

/** Read AR arrays whether the model used snake_case or camelCase. */
function getRawAcceptanceArray(raw: RawFeature): unknown[] {
  const snake = raw.acceptance_requirements;
  const camel = raw.acceptanceRequirements;
  if (Array.isArray(snake) && snake.length) return snake;
  if (Array.isArray(camel) && camel.length) return camel;
  if (Array.isArray(snake)) return snake;
  if (Array.isArray(camel)) return camel;
  return [];
}

function normaliseArs(ars: unknown[]): Array<{ given: string; when: string; then: string }> {
  return ars
    .map(ar => {
      if (typeof ar === 'string') return parseArString(ar);
      if (typeof ar === 'object' && ar !== null) {
        const obj = ar as Record<string, unknown>;
        return {
          given: String(obj.given ?? obj.Given ?? ''),
          when: String(obj.when ?? obj.When ?? ''),
          then: String(obj.then ?? obj.Then ?? ''),
        };
      }
      return null;
    })
    .filter((x): x is { given: string; when: string; then: string } => x !== null && (!!x.given || !!x.when || !!x.then));
}

/** Parse GIVEN/WHEN/THEN; supports multiline clauses (models often wrap lines). */
function parseArString(s: string): { given: string; when: string; then: string } {
  const t = s.trim();
  const givenMatch = t.match(/GIVEN\s+([\s\S]+?)(?=\s+(?:WHEN|THEN)\b|$)/i);
  const whenMatch = t.match(/WHEN\s+([\s\S]+?)(?=\s+THEN\b|$)/i);
  const thenMatch = t.match(/THEN\s+([\s\S]+)$/i);
  
  let given = givenMatch?.[1]?.trim() ?? '';
  let when = whenMatch?.[1]?.trim() ?? '';
  let then = thenMatch?.[1]?.trim() ?? '';

  // Clean up any keywords repeated INSIDE the captured groups (fixes LLM hallucinations)
  given = given.replace(/^(GIVEN|WHEN|THEN)\s+/i, '').trim();
  when = when.replace(/^(GIVEN|WHEN|THEN)\s+/i, '').trim();
  then = then.replace(/^(GIVEN|WHEN|THEN)\s+/i, '').trim();

  if (given || when || then) {
    return { given, when, then };
  }

  // Fallback for unformatted strings
  return { given: '', when: '', then: t.replace(/^(GIVEN|WHEN|THEN)\s+/i, '').trim() };
}

/**
 * Merge pass1 and pass2: prefer pass2's ARs, keep pass1's metadata.
 * Matches by array index when summaries align; otherwise matches by summary text.
 */
function mergeFeatures(pass1: RawFeature[], pass2: RawFeature[]): RawFeature[] {
  if (!pass2.length) return pass1;
  return pass1.map((f1, i) => {
    const k = (f1.summary ?? '').trim().toLowerCase();
    const atI = pass2[i];
    const byIndexOk =
      atI && (atI.summary ?? '').trim().toLowerCase() === k ? atI : undefined;
    const byName = k ? pass2.find(f => (f.summary ?? '').trim().toLowerCase() === k) : undefined;
    const f2 =
      byIndexOk ??
      byName ??
      (pass2.length === pass1.length ? atI : undefined);
    if (!f2) return f1;
    const ar2 = getRawAcceptanceArray(f2);
    const ar1 = getRawAcceptanceArray(f1);
    return {
      ...f1,
      acceptance_requirements: ar2.length ? (ar2 as string[]) : (ar1 as string[]),
    };
  });
}

export { formatGoldExample };

export function normalizeConversationTitle(candidate: string, requirement: string): string {
  const cleaned = String(candidate ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?-]+$/g, '')
    .trim();

  if (cleaned && cleaned.split(/\s+/).length >= 2) {
    return cleaned.slice(0, 88);
  }

  const source = String(requirement ?? '').replace(/\s+/g, ' ').trim();
  const normalized = source
    .replace(/^\s*as a .*?,\s*i need to\s+/i, '')
    .replace(/^\s*an?\s+/i, '')
    .replace(/\s+so that[\s\S]*$/i, '')
    .replace(/\s+based on[\s\S]*$/i, '')
    .trim();
  const words = normalized.split(' ').filter(Boolean);
  const fallback = words.slice(0, 8).join(' ').trim();
  if (fallback) {
    return fallback.charAt(0).toUpperCase() + fallback.slice(1);
  }
  return 'Untitled conversation';
}

function toStageUsage(usage: { input: number; output: number }) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
  };
}
