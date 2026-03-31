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
import { buildPlannerDecision } from './planner';
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
    bedrockAccessKeyId: config.generatorConfig.bedrockAccessKeyId,
    bedrockSecretAccessKey: config.generatorConfig.bedrockSecretAccessKey,
    bedrockSessionToken: config.generatorConfig.bedrockSessionToken,
    bedrockRegion: config.generatorConfig.bedrockRegion,
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
  return words.slice(0, 10).join(' ');
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
      category: String((x as any).category ?? 'Functional Flow').trim() || 'Functional Flow',
      question: String((x as any).question ?? '').trim(),
      suggestions: Array.isArray((x as any).suggestions)
        ? (x as any).suggestions.map((s: unknown) => compactSuggestion(s)).filter(Boolean).slice(0, 3)
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
  const templates: ClarifyQuestion[] = [
    {
      category: 'Roles & Personas',
      question: 'Which role is responsible for accepting, reordering, or overriding the proposed schedule?',
      suggestions: ['Dispatcher', 'Team lead', 'Fully automatic'],
    },
    {
      category: 'Functional Flow',
      question: 'How should criticality and due date be weighted when they conflict for two jobs?',
      suggestions: ['Criticality wins', 'Due date wins', 'Configurable weighted score'],
    },
    {
      category: 'Business Rules & Exceptions',
      question: 'What should happen when the optimal slot violates skill, parts, or availability constraints?',
      suggestions: ['Pick next best slot', 'Escalate for manual assignment', 'Flag unschedulable'],
    },
    {
      category: 'Trigger & Context',
      question: 'When should schedules be generated or recalculated?',
      suggestions: ['Nightly batch', 'On new request', 'On-demand by dispatcher'],
    },
    {
      category: 'Success & Measurement',
      question: 'What defines an optimal schedule outcome for this process?',
      suggestions: ['Max SLA compliance', 'Critical jobs completed first', 'Balanced utilization'],
    },
  ];

  const seed = requirement.toLowerCase().includes('schedule')
    ? templates
    : templates.map((q, idx) => ({
        ...q,
        question: idx === 0
          ? 'Which user role owns the final decision for this requirement?'
          : q.question,
      }));

  return seed.slice(0, Math.max(0, needed));
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
      maxTokens: 4096,
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
  plannerDecision?: PlannerDecision;
  onPass1Complete?: (featureCount: number) => Promise<void>;
}): Promise<GenerationResult> {
  const { requirement, clarifyAnswers, attachmentText, goldExamplesText, similarStoriesText, wiContextText, config, plannerDecision, onPass1Complete } = opts;
  const { generatorConfig } = config;
  const decision = plannerDecision ?? await buildPlannerDecision({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    config,
    reasoningMode: config.aiExecutionPolicy.defaultReasoningMode,
    outputMode: config.aiExecutionPolicy.defaultOutputMode,
    policy: config.aiExecutionPolicy,
  });
  const providerOpts = {
    ...getProviderOpts(config),
  } as const;

  // Build user message — include all context
  const contextSections: string[] = [`REQUIREMENT: ${requirement}`];

  if (clarifyAnswers.length) {
    const qaText = clarifyAnswers
      .map(a => `Q: ${a.question}\nA: ${a.answer}`)
      .join('\n\n');
    contextSections.push(`CLARIFICATION Q&A:\n${qaText}`);
  }

  if (attachmentText) {
    contextSections.push(`ATTACHMENT CONTEXT:\n${attachmentText.slice(0, 8000)}`);
  }

  if (wiContextText) {
    contextSections.push(`WORK INSTRUCTIONS:\n${wiContextText}`);
  }

  if (goldExamplesText) {
    contextSections.push(`GOLD STANDARD EXAMPLES (for high-level format reference):\n${goldExamplesText}`);
  }

  if (similarStoriesText) {
    contextSections.push(`SIMILAR STORIES FROM BACKLOG (most relevant matching stories for business context — use these to understand how this organization typically writes stories and ARs for this specific domain):\n${similarStoriesText}`);
  }

  const userMessage = contextSections.join('\n\n---\n\n');

  // ── Pass 1: Decomposition ──
  const pass1System = buildDecompositionSystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    processTaxonomy: config.processTaxonomy,
    processTaxonomyEnabled: config.processTaxonomyEnabled,
    featurePlan: decision.featurePlan,
  });

  const pass1Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(generatorConfig.decompositionModel, config.tier),
    systemPrompt: pass1System,
    userMessage,
    maxTokens: generatorConfig.maxTokens,
    ...providerOpts,
  });

  const pass1Features = clampFeatureCandidates(pass1Result.data.features ?? [], decision.featurePlan);

  // Notify caller so it can emit a progress event before the slow pass 2 LLM call
  if (onPass1Complete) await onPass1Complete(pass1Features.length);

  // ── Pass 2: Acceptance Requirements ──
  const pass2System = buildArSystemPrompt({
    domainContext: config.domainContext,
    arPlan: decision.arPlan,
  });

  const pass2UserMessage = `${userMessage}\n\n---\n\nFEATURES FROM PASS 1 (fill in acceptance_requirements for each):\n${JSON.stringify(pass1Features, null, 2)}`;

  // Pass 2 often needs more output tokens than pass 1 (many GWT strings per feature).
  const pass2MaxTokens = Math.max(generatorConfig.maxTokens ?? 8192, 16384);

  const pass2Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(generatorConfig.arModel, config.tier),
    systemPrompt: pass2System,
    userMessage: pass2UserMessage,
    maxTokens: pass2MaxTokens,
    ...providerOpts,
  });

  // Merge: use pass2 ARs; fall back to pass1 if pass2 missing or empty
  const rawFeatures = pass2Result.data.features?.length
    ? mergeFeatures(pass1Features, pass2Result.data.features)
    : pass1Features;

  const features = rawFeatures.map(normaliseFeature);
  const violations = validateFeatures(features, config);
  let initiativeGroups: InitiativeGroup[] | undefined;
  let initiativeGroupingUsage: TokenUsageSummary | undefined;

  if (decision.useHierarchy && features.length > 0) {
    const groupingResult = await buildInitiativeGroups({
      requirement,
      features,
      config,
    });
    initiativeGroups = groupingResult.initiativeGroups;
    initiativeGroupingUsage = groupingResult.tokenUsage;
  }

  const tokenUsage: TokenUsageSummary = {
    input: pass1Result.usage.input + pass2Result.usage.input + (initiativeGroupingUsage?.input ?? 0),
    output: pass1Result.usage.output + pass2Result.usage.output + (initiativeGroupingUsage?.output ?? 0),
    total:
      pass1Result.usage.input +
      pass1Result.usage.output +
      pass2Result.usage.input +
      pass2Result.usage.output +
      (initiativeGroupingUsage?.total ?? 0),
    byStage: {
      decomposition: toStageUsage(pass1Result.usage),
      acceptanceRequirements: toStageUsage(pass2Result.usage),
      ...(initiativeGroupingUsage?.byStage ?? {}),
    },
  };

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
    plannerDecision: decision,
    initiativeGroups,
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
  plannerDecision?: PlannerDecision;
}): Promise<{ questions: ClarifyQuestion[]; tokenUsage: TokenUsageSummary; ambiguityAssessment: ClarifyAmbiguityAssessment }> {
  const { requirement, attachmentText, wiContextText, goldExamplesText, similarStoriesText, config, plannerDecision } = opts;
  const decision = plannerDecision ?? await buildPlannerDecision({
    requirement,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
    config,
    reasoningMode: config.aiExecutionPolicy.defaultReasoningMode,
    outputMode: config.aiExecutionPolicy.defaultOutputMode,
    policy: config.aiExecutionPolicy,
  });
  const questionPlan = decision.questionPlan;
  const contextCharBudget = decision.reasoningMode === 'deep'
    ? { attachment: 4000, wi: 4000, gold: 5000, similar: 5000 }
    : { attachment: 2200, wi: 2200, gold: 3000, similar: 3000 };
  const clarifyMaxTokens = decision.reasoningMode === 'deep' ? 2600 : 1800;
  const clarifyTopUpMaxTokens = decision.reasoningMode === 'deep' ? 1400 : 900;

  const contextParts: string[] = [`REQUIREMENT: ${requirement}`];
  if (attachmentText) contextParts.push(`ATTACHMENT: ${attachmentText.slice(0, contextCharBudget.attachment)}`);
  if (wiContextText) contextParts.push(`WORK INSTRUCTIONS EXCERPT: ${wiContextText.slice(0, contextCharBudget.wi)}`);
  if (goldExamplesText) contextParts.push(`DEPLOYED GOLD EXAMPLES:\n${goldExamplesText.slice(0, contextCharBudget.gold)}`);
  if (similarStoriesText) contextParts.push(`RELATED DEPLOYED BACKLOG ITEMS:\n${similarStoriesText.slice(0, contextCharBudget.similar)}`);

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
    questionPlan,
  });

  const raw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
    model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
    systemPrompt: system,
    userMessage: contextParts.join('\n\n'),
    maxTokens: clarifyMaxTokens,
    ...getProviderOpts(config),
  });

  let totalInputTokens = raw.usage.input;
  let totalOutputTokens = raw.usage.output;
  let filteredQuestions = dedupeQuestions(parseQuestionCandidates(raw.data)).slice(0, questionPlan.max);
  const desiredQuestionCount = Math.min(
    questionPlan.max,
    Math.max(questionPlan.min, questionPlan.target),
  );

  if (filteredQuestions.length < desiredQuestionCount) {
    const needed = desiredQuestionCount - filteredQuestions.length;
    const topUpUserMessage = [
      contextParts.join('\n\n'),
      `ALREADY GENERATED QUESTIONS (do not repeat):\n${filteredQuestions.map((q, idx) => `${idx + 1}. ${q.question}`).join('\n') || '(none)'}`,
      `Generate exactly ${needed} additional clarifying questions that are non-overlapping with the existing list.`,
      'Return JSON array only in this shape: [{"category":"...","question":"...","suggestions":["..."]}]',
    ].join('\n\n---\n\n');

    const topUpRaw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
      model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
      systemPrompt: system,
      userMessage: topUpUserMessage,
      maxTokens: clarifyTopUpMaxTokens,
      ...getProviderOpts(config),
    });
    totalInputTokens += topUpRaw.usage.input;
    totalOutputTokens += topUpRaw.usage.output;

    filteredQuestions = dedupeQuestions([
      ...filteredQuestions,
      ...parseQuestionCandidates(topUpRaw.data),
    ]).slice(0, questionPlan.max);
  }

  if (filteredQuestions.length < desiredQuestionCount) {
    const needed = desiredQuestionCount - filteredQuestions.length;
    filteredQuestions = dedupeQuestions([
      ...filteredQuestions,
      ...buildFallbackQuestions(requirement, needed),
    ]).slice(0, questionPlan.max);
  }

  const totalTokens = totalInputTokens + totalOutputTokens;

  return {
    questions: filteredQuestions,
    tokenUsage: {
      input: totalInputTokens,
      output: totalOutputTokens,
      total: totalTokens,
      byStage: { clarify: { input: totalInputTokens, output: totalOutputTokens, total: totalTokens } },
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
    maxTokens: 4096,
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
    maxTokens: 4096,
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
    model: config.generatorConfig.themeModel,
    systemPrompt: 'Generate a concise 5-8 word title summarizing this requirement. Output the title only, no quotes.',
    userMessage: requirement,
    maxTokens: 32,
    ...getProviderOpts(config),
  });
  return res.text.replace(/^["']|["']$/g, '').trim() || requirement.slice(0, 60);
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
    maxTokens: 2048,
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

function toStageUsage(usage: { input: number; output: number }) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
  };
}
