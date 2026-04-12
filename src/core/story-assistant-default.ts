import type {
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyQuestion,
  DiscoveryProfile,
  Feature,
  GenerationResult,
  GenerationStageDurationsMs,
  TenantConfig,
  TokenUsageSummary,
  WorkInstructionInsightArtifact,
} from '../types';
import { getTierModel } from '../services/billing';
import { callLlmJsonWithUsage } from './llm';
import {
  buildStoryAssistantArSystemPrompt,
  buildStoryAssistantClarifySystemPrompt,
  buildStoryAssistantDecompositionSystemPrompt,
  buildStoryAssistantSufficiencySystemPrompt,
} from './prompts';
import { validateFeatures } from './quality-validator';
import { buildDiscoveryCoverageArtifact } from './discovery';
import {
  annotateFailedAcceptanceRequirementFeatures,
  findFeaturesMissingCompleteAcceptanceRequirements,
  GenerationCancelledError,
  normaliseFeature,
} from './story-generator';

interface RawFeature {
  id?: string;
  summary?: string;
  description?: string;
  acceptance_requirements?: unknown[];
  acceptanceRequirements?: unknown[];
  suggested_story_points?: number;
  process_code?: string;
}

interface RawQuestionCandidate {
  category?: unknown;
  categoryKey?: unknown;
  intent?: unknown;
  question?: unknown;
  details?: unknown;
  suggestions?: unknown[];
}

export interface StoryAssistantClarifyResult {
  questions: ClarifyQuestion[];
  tokenUsage: TokenUsageSummary;
  discoveryProfile: DiscoveryProfile;
  ambiguityAssessment: {
    level: 'clear' | 'medium' | 'vague';
    score: number;
    reasons: string[];
    questionPlan: { min: number; max: number; target: number };
    generatedQuestions: number;
  };
}

export interface StoryAssistantSufficiencyResult {
  sufficient: boolean;
  status: 'ask_followup' | 'ready_to_generate' | 'ready_with_open_decisions';
  questions?: ClarifyQuestion[];
  missingCategoryKeys: ClarifyQuestion['categoryKey'][];
  reasonCodes: string[];
  coverageArtifact: ReturnType<typeof buildDiscoveryCoverageArtifact>;
  warning?: string;
  tokenUsage: TokenUsageSummary;
  durationMs: number;
}

export interface StoryAssistantGenerationResult {
  features: Feature[];
  tokenUsage: TokenUsageSummary;
  stageDurationsMs: GenerationStageDurationsMs;
  failedFeatureIds?: string[];
}

const STORY_ASSISTANT_CATEGORY_LABELS: Record<string, ClarifyCategoryKey> = {
  'roles & personas': 'user_personas',
  'roles and personas': 'user_personas',
  'roles': 'user_personas',
  'personas': 'user_personas',
  'trigger & context': 'context_trigger',
  'trigger and context': 'context_trigger',
  'context & trigger': 'context_trigger',
  'context and trigger': 'context_trigger',
  'functional flow': 'functional_flow',
  'business rules & exceptions': 'business_rules',
  'business rules and exceptions': 'business_rules',
  'business rules': 'business_rules',
  'success & measurement': 'success_measurement',
  'success and measurement': 'success_measurement',
  'success': 'success_measurement',
};

function buildProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;
}

function toStageUsage(usage: { input: number; output: number }) {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.input + usage.output,
  };
}

function buildTokenUsageSummary(stages: Record<string, { input: number; output: number }>): TokenUsageSummary {
  const input = Object.values(stages).reduce((sum, stage) => sum + stage.input, 0);
  const output = Object.values(stages).reduce((sum, stage) => sum + stage.output, 0);
  return {
    input,
    output,
    total: input + output,
    byStage: Object.fromEntries(
      Object.entries(stages).map(([stage, usage]) => [stage, toStageUsage(usage)]),
    ),
  };
}

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value: unknown): string {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ensureQuestionMark(value: string): string {
  const trimmed = cleanText(value).replace(/[?.!]+$/g, '');
  return trimmed ? `${trimmed}?` : '';
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  values.forEach((value) => {
    const cleaned = cleanText(value);
    if (!cleaned) return;
    const key = normalizeKey(cleaned);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(cleaned);
  });
  return result;
}

function trimPromptText(text: string, maxChars: number): string {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated for speed]`;
}

function mergeRequirementAndAttachment(requirement: string, attachmentText: string): string {
  const cleanedRequirement = cleanText(requirement);
  const cleanedAttachment = String(attachmentText ?? '').trim();
  if (!cleanedAttachment) return cleanedRequirement;
  return `Context from attachment:\n\n${cleanedAttachment}\n\nRequirement: ${cleanedRequirement}`;
}

function formatClarifyAnswers(answers: ClarifyAnswer[]): string {
  if (!answers.length) return '';
  return answers
    .map((answer) => `Q: ${cleanText(answer.question)}\nA: ${cleanText(answer.answer) || '(not answered)'}`)
    .join('\n\n');
}

function extractRoles(requirement: string, answers: ClarifyAnswer[] = []): string[] {
  const seen = new Set<string>();
  const roles: string[] = [];

  const addRole = (value: string) => {
    const cleaned = cleanText(value).replace(/\.$/, '');
    if (cleaned.length < 3 || cleaned.length > 80) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roles.push(cleaned);
  };

  answers.forEach((answer) => {
    const question = `${answer.categoryKey ?? ''} ${answer.question}`.toLowerCase();
    if (!/role|persona|who\b|actor/.test(question)) return;
    cleanText(answer.answer)
      .split(/\s*(?:,|;|\band\b)\s*/i)
      .filter(Boolean)
      .forEach(addRole);
  });

  const roleRegex = /\bas\s+an?\s+([A-Za-z][A-Za-z ,/-]{2,60}?)(?:\s*[,.]|\s+(?:i|we|they|who|that|the)\b)/gi;
  for (const match of requirement.matchAll(roleRegex)) {
    addRole(match[1] ?? '');
  }

  return roles;
}

function buildRoleHint(domainRoles: string[] | undefined, requirement: string, answers: ClarifyAnswer[]): string {
  const extractedRoles = extractRoles(requirement, answers);
  const combinedRoles = uniqueStrings([...(domainRoles ?? []), ...extractedRoles]);
  return combinedRoles.length ? `KNOWN ROLES: ${combinedRoles.join(', ')}` : '';
}

function buildClarifyUserMessage(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
  if (input.wiContextText.trim()) {
    parts.push(`Domain context from Work Instructions (use to ask sharper, process-grounded questions):\n${trimPromptText(input.wiContextText, 12000)}`);
  }
  return parts.join('\n\n');
}

function buildSufficiencyUserMessage(input: {
  requirement: string;
  answers: ClarifyAnswer[];
  attachmentText?: string;
  wiContextText?: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText ?? '');
  const parts = [
    `Requirement: ${trimPromptText(mergedRequirement, 12000)}`,
    `Questions and answers so far:\n${formatClarifyAnswers(input.answers) || '(none)'}`,
  ];
  if (input.wiContextText?.trim()) {
    parts.push(`Domain context from Work Instructions:\n${trimPromptText(input.wiContextText, 6000)}`);
  }
  return parts.join('\n\n');
}

function buildGenerationContextMessage(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  roleHint: string;
}) {
  const mergedRequirement = mergeRequirementAndAttachment(input.requirement, input.attachmentText);
  const parts = [`Requirement: ${trimPromptText(mergedRequirement, 16000)}`];
  if (input.roleHint.trim()) {
    parts.push(input.roleHint);
  }
  if (input.clarifyAnswers.length) {
    parts.push(`Clarification answers:\n${formatClarifyAnswers(input.clarifyAnswers)}`);
  }
  if (input.wiContextText.trim()) {
    parts.push(`Domain context from Work Instructions:\n${trimPromptText(input.wiContextText, 12000)}`);
  }
  return parts.join('\n\n');
}

function inferCategoryKey(question: string): ClarifyCategoryKey {
  const normalized = cleanText(question).toLowerCase();
  if (/\bwho\b|\brole\b|\bpersona\b|\bowner\b|\bapproval\b|\bescalation\b/.test(normalized)) {
    return 'user_personas';
  }
  if (/\bmeasure\b|\bmetric\b|\bsuccess\b|\btester\b|\buat\b|\bworking correctly\b/.test(normalized)) {
    return 'success_measurement';
  }
  if (/\bstatus\b|\blifecycle\b|\btransition\b|\breopen\b|\bretry\b/.test(normalized)) {
    return 'state_lifecycle';
  }
  if (/\bsequence\b|\border\b|\bstep\b|\bbranch\b|\bpath\b|\bfinal output\b|\bstate after\b/.test(normalized)) {
    return 'functional_flow';
  }
  if (/\bvalidation\b|\brule\b|\bexception\b|\bthreshold\b|\bconstraint\b|\bcontract\b|\bcompliance\b/.test(normalized)) {
    return 'business_rules';
  }
  return 'context_trigger';
}

function mapCategoryKey(category: unknown, question: string): ClarifyCategoryKey {
  const normalizedCategory = normalizeKey(category);
  if (normalizedCategory && STORY_ASSISTANT_CATEGORY_LABELS[normalizedCategory]) {
    return STORY_ASSISTANT_CATEGORY_LABELS[normalizedCategory];
  }
  return inferCategoryKey(question);
}

export function splitClearlyNumberedStoryAssistantQuestion(question: string): string[] {
  const normalized = cleanText(question);
  if (!normalized) return [];

  const markerRegex = /(?:^|\s)(\d+)\.\s*/g;
  const markers = [...normalized.matchAll(markerRegex)];
  if (markers.length < 2) return [normalized];

  const firstMatch = markers[0];
  if (!firstMatch || firstMatch.index == null) return [normalized];
  const prefix = cleanText(normalized.slice(0, firstMatch.index));
  const segments: string[] = [];

  markers.forEach((match, index) => {
    if (match.index == null) return;
    const segmentStart = match.index + match[0].length;
    const nextStart = index + 1 < markers.length && markers[index + 1].index != null
      ? markers[index + 1].index
      : normalized.length;
    const segmentBody = cleanText(normalized.slice(segmentStart, nextStart));
    if (!segmentBody) return;
    const combined = cleanText(`${prefix ? `${prefix} ` : ''}${segmentBody}`);
    if (combined) segments.push(combined);
  });

  return segments.length >= 2 ? segments : [normalized];
}

function normalizeSuggestions(values: unknown[]): string[] {
  return uniqueStrings(values)
    .map((value) => cleanText(value).replace(/[?.!]+$/g, ''))
    .filter(Boolean)
    .slice(0, 3);
}

function extractQuestionCandidates(rawData: unknown): RawQuestionCandidate[] {
  if (Array.isArray(rawData)) {
    return rawData.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
  }
  if (rawData && typeof rawData === 'object') {
    const candidateObject = rawData as { questions?: unknown; items?: unknown };
    if (Array.isArray(candidateObject.questions)) {
      return candidateObject.questions.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
    }
    if (Array.isArray(candidateObject.items)) {
      return candidateObject.items.filter((item): item is RawQuestionCandidate => typeof item === 'object' && item !== null);
    }
  }
  return [];
}

export function parseStoryAssistantQuestionCandidates(rawData: unknown): ClarifyQuestion[] {
  return extractQuestionCandidates(rawData)
    .flatMap((candidate) => {
      const rawQuestion = cleanText(candidate.question);
      if (!rawQuestion) return [];
      const categoryKey = mapCategoryKey(candidate.categoryKey ?? candidate.category, rawQuestion);
      const category = cleanText(candidate.category)
        || (categoryKey === 'user_personas' ? 'Roles & Personas'
          : categoryKey === 'context_trigger' ? 'Trigger & Context'
          : categoryKey === 'functional_flow' ? 'Functional Flow'
          : categoryKey === 'business_rules' ? 'Business Rules & Exceptions'
          : categoryKey === 'success_measurement' ? 'Success & Measurement'
          : 'State & Lifecycle');
      const intent = cleanText(candidate.intent).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
        || `story_assistant_${categoryKey}`;
      const suggestions = normalizeSuggestions(Array.isArray(candidate.suggestions) ? candidate.suggestions : []);
      const details = cleanText(candidate.details);

      return splitClearlyNumberedStoryAssistantQuestion(rawQuestion).map((segment, index) => ({
        categoryKey,
        category,
        intent: index === 0 ? intent : `${intent}_part_${index + 1}`,
        question: ensureQuestionMark(segment),
        ...(index === 0 && details ? { details } : {}),
        suggestions,
      }));
    })
    .filter((question) => question.question.length > 0);
}

function shouldRetryDiscoveryQuestions(questions: ClarifyQuestion[]): boolean {
  if (questions.length < 4) return true;
  return questions.some((question) => (
    question.suggestions.length !== 3
    || question.question.length > 240
  ));
}

function buildMinimalDiscoveryProfile(questionCount: number): DiscoveryProfile {
  const scope = questionCount >= 9 ? 'broad' : questionCount >= 6 ? 'moderate' : 'narrow';
  const complexity = questionCount >= 9 ? 'high' : questionCount >= 6 ? 'medium' : 'low';
  const ambiguity = questionCount >= 6 ? 'high' : questionCount >= 3 ? 'medium' : 'low';
  return {
    scope,
    complexity,
    ambiguity,
    missingCategoryKeys: [],
    recommendedInitialCount: questionCount,
    followupCap: 2,
    plannedQuestionBudget: questionCount + 2,
    actualQuestionsAsked: questionCount,
    softQuestionBudget: questionCount,
    hardQuestionCap: questionCount + 2,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys: [],
      plannedQuestionBudget: questionCount + 2,
      actualQuestionsAsked: questionCount,
      actualAnswersReceived: 0,
    }),
  };
}

function mergePass2IntoPass1(pass1: RawFeature[], pass2: RawFeature[]): RawFeature[] {
  return pass1.map((feature, index) => {
    const next = pass2[index];
    if (!next) return feature;
    return {
      ...feature,
      ...next,
      acceptance_requirements: next.acceptance_requirements ?? next.acceptanceRequirements ?? [],
    };
  });
}

function featureToRaw(feature: Feature): RawFeature {
  return {
    id: feature.id,
    summary: feature.summary,
    description: feature.description,
    acceptance_requirements: [],
    suggested_story_points: feature.storyPoints,
    process_code: feature.processCode,
  };
}

export async function generateStoryAssistantDefaultClarifyingQuestions(opts: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  config: TenantConfig;
}): Promise<StoryAssistantClarifyResult> {
  void opts.wiInsightsArtifact;
  const providerOpts = buildProviderOpts(opts.config);
  const usageByStage: Record<string, { input: number; output: number }> = {};
  let questions: ClarifyQuestion[] = [];

  for (const attempt of [1, 2]) {
    const result = await callLlmJsonWithUsage<unknown>({
      model: getTierModel(opts.config.generatorConfig.clarifyModel, opts.config.tier),
      systemPrompt: buildStoryAssistantClarifySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        questionPlan: { min: 0, max: 0, target: 0 },
      }),
      userMessage: attempt === 1
        ? buildClarifyUserMessage({
            requirement: opts.requirement,
            attachmentText: opts.attachmentText,
            wiContextText: opts.wiContextText,
          })
        : `${buildClarifyUserMessage({
            requirement: opts.requirement,
            attachmentText: opts.attachmentText,
            wiContextText: opts.wiContextText,
          })}\n\nIMPORTANT: Re-run discovery and return a richer question set. Keep each question focused on one business decision, and give every question exactly 3 short suggestions.`,
      maxTokens: 4096,
      reasoningEffort: 'low',
      ...providerOpts,
    });
    usageByStage[attempt === 1 ? 'clarify' : 'clarifyRetry'] = result.usage;
    questions = parseStoryAssistantQuestionCandidates(result.data);
    if (!shouldRetryDiscoveryQuestions(questions) || attempt === 2) break;
  }

  const discoveryProfile = buildMinimalDiscoveryProfile(questions.length);
  return {
    questions,
    tokenUsage: buildTokenUsageSummary(usageByStage),
    discoveryProfile,
    ambiguityAssessment: {
      level: questions.length >= 8 ? 'vague' : questions.length >= 4 ? 'medium' : 'clear',
      score: questions.length >= 8 ? 8 : questions.length >= 4 ? 5 : 3,
      reasons: ['Discovery is asking every ambiguity that would materially change what gets built.'],
      questionPlan: {
        min: questions.length,
        max: questions.length,
        target: questions.length,
      },
      generatedQuestions: questions.length,
    },
  };
}

export async function evaluateStoryAssistantDefaultSufficiency(opts: {
  requirement: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | Pick<ClarifyQuestion, 'categoryKey' | 'intent' | 'question'>>;
  attachmentText?: string;
  wiContextText?: string;
  config: TenantConfig;
}): Promise<StoryAssistantSufficiencyResult> {
  void opts.askedQuestions;
  const startedAt = Date.now();
  const providerOpts = buildProviderOpts(opts.config);
  try {
    const result = await callLlmJsonWithUsage<unknown>({
      model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
      systemPrompt: buildStoryAssistantSufficiencySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
      }),
      userMessage: buildSufficiencyUserMessage({
        requirement: opts.requirement,
        answers: opts.answers,
        attachmentText: opts.attachmentText,
        wiContextText: opts.wiContextText,
      }),
      maxTokens: 1600,
      reasoningEffort: 'low',
      ...providerOpts,
    });

    const payload = (result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : {});
    const sufficient = payload.sufficient === true;
    const reasonCodes = Array.isArray(payload.reasonCodes)
      ? payload.reasonCodes.map((value) => cleanText(value)).filter(Boolean)
      : [];
    const parsedQuestions = parseStoryAssistantQuestionCandidates(payload).slice(0, 2);
    const missingCategoryKeys = parsedQuestions
      .map((question) => question.categoryKey)
      .filter((value, index, values) => values.indexOf(value) === index);
    const status =
      sufficient ? 'ready_to_generate'
      : parsedQuestions.length > 0 ? 'ask_followup'
      : 'ready_with_open_decisions';

    return {
      sufficient,
      status,
      ...(status === 'ask_followup' ? { questions: parsedQuestions } : {}),
      missingCategoryKeys,
      reasonCodes,
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys,
        plannedQuestionBudget: opts.answers.length + 2,
        actualQuestionsAsked: opts.answers.length,
        actualAnswersReceived: opts.answers.length,
        openNonBlockingDecisions: status === 'ready_with_open_decisions' ? reasonCodes : [],
      }),
      tokenUsage: buildTokenUsageSummary({ clarifyEvaluate: result.usage }),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    return {
      sufficient: false,
      status: 'ready_with_open_decisions',
      missingCategoryKeys: [],
      reasonCodes: ['SUFFICIENCY_EVAL_FAILED'],
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys: [],
        plannedQuestionBudget: opts.answers.length + 2,
        actualQuestionsAsked: opts.answers.length,
        actualAnswersReceived: opts.answers.length,
        openNonBlockingDecisions: ['SUFFICIENCY_EVAL_FAILED'],
      }),
      tokenUsage: {
        input: 0,
        output: 0,
        total: 0,
        byStage: {},
      },
      durationMs: Date.now() - startedAt,
      warning: 'Sufficiency evaluation failed; proceeding with explicit open decisions instead of silently marking discovery complete.',
    };
  }
}

export async function generateStoryAssistantDefaultFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  wiInsightsArtifact?: WorkInstructionInsightArtifact | null;
  config: TenantConfig;
  precomputedDraftFeatures?: Feature[];
  priorStageDurationsMs?: GenerationStageDurationsMs;
  onPass1DraftFeatures?: (draftFeatures: Feature[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  void opts.wiInsightsArtifact;
  const providerOpts = buildProviderOpts(opts.config);
  const stageDurationsMs = { ...(opts.priorStageDurationsMs ?? {}) } as Record<string, number>;
  const stageUsage: Record<string, { input: number; output: number }> = {};
  const roleHint = buildRoleHint(opts.config.domainRoles, opts.requirement, opts.clarifyAnswers);
  let pass1Raw: RawFeature[] = [];
  let pass1Features: Feature[] = opts.precomputedDraftFeatures ?? [];

  const maybeCancelled = async () => Boolean(await opts.shouldCancel?.());

  if (!pass1Features.length) {
    const startedAt = Date.now();
    const pass1Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
      model: getTierModel(opts.config.generatorConfig.decompositionModel, opts.config.tier),
      systemPrompt: buildStoryAssistantDecompositionSystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
        processTaxonomy: opts.config.processTaxonomy,
        processTaxonomyEnabled: opts.config.processTaxonomyEnabled,
      }),
      userMessage: `${buildGenerationContextMessage({
        requirement: opts.requirement,
        clarifyAnswers: opts.clarifyAnswers,
        attachmentText: opts.attachmentText,
        wiContextText: opts.wiContextText,
        roleHint,
      })}\n\nDecompose this requirement into the distinct features needed to deliver it. Leave acceptance_requirements as empty arrays.`,
      maxTokens: opts.config.generatorConfig.maxTokens,
      reasoningEffort: 'medium',
      ...providerOpts,
    });
    stageUsage.decomposition = pass1Result.usage;
    pass1Raw = Array.isArray(pass1Result.data.features) ? pass1Result.data.features : [];
    if (!pass1Raw.length) {
      throw new Error('Feature decomposition returned no features.');
    }
    pass1Features = pass1Raw.map((feature) => normaliseFeature({
      ...feature,
      acceptance_requirements: [],
    }));
    stageDurationsMs.decomposition = Date.now() - startedAt;
    if (opts.onPass1DraftFeatures) {
      await opts.onPass1DraftFeatures(pass1Features);
    }
  } else {
    pass1Raw = pass1Features.map((feature) => featureToRaw(feature));
  }

  if (await maybeCancelled()) {
    throw new GenerationCancelledError();
  }

  const pass2StartedAt = Date.now();
  const pass2Result = await callLlmJsonWithUsage<{ features?: RawFeature[] }>({
    model: getTierModel(opts.config.generatorConfig.arModel, opts.config.tier),
    systemPrompt: buildStoryAssistantArSystemPrompt({
      domainContext: opts.config.domainContext,
      domainRoles: opts.config.domainRoles,
    }),
    userMessage: `${buildGenerationContextMessage({
      requirement: opts.requirement,
      clarifyAnswers: opts.clarifyAnswers,
      attachmentText: opts.attachmentText,
      wiContextText: opts.wiContextText,
      roleHint,
    })}\n\nFeatures to write acceptance requirements for:\n${JSON.stringify({
      features: pass1Raw.map((feature) => ({
        ...feature,
        acceptance_requirements: [],
      })),
    }, null, 2)}\n\nFor each feature, write GIVEN/WHEN/THEN acceptance requirements.`,
    maxTokens: Math.max(opts.config.generatorConfig.maxTokens, 16384),
    reasoningEffort: 'medium',
    ...providerOpts,
  });
  stageUsage.acceptanceRequirements = pass2Result.usage;
  stageDurationsMs.acceptanceRequirements = Date.now() - pass2StartedAt;

  const pass2Raw = Array.isArray(pass2Result.data.features) ? pass2Result.data.features : [];
  const mergedRaw = pass2Raw.length >= pass1Raw.length
    ? mergePass2IntoPass1(pass1Raw, pass2Raw)
    : pass1Raw;
  let features = mergedRaw.map((feature) => normaliseFeature(feature));
  const failedIndexes = findFeaturesMissingCompleteAcceptanceRequirements(features);
  const failedIds = new Set(failedIndexes.map((index) => features[index]?.id).filter(Boolean) as string[]);
  if (failedIds.size > 0) {
    features = annotateFailedAcceptanceRequirementFeatures(features, failedIds) as Feature[];
  }

  stageDurationsMs.total = Object.values(stageDurationsMs).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const tokenUsage = buildTokenUsageSummary(stageUsage);

  return {
    features,
    violations: validateFeatures(features, opts.config),
    similarStories: [],
    sessionId: '',
    tokenUsage,
    generationContext: {
      pipelineMode: 'story_assistant_default',
      projectKey: '*',
      domainRolesUsed: opts.config.domainRoles ?? [],
      stageDurationsMs: {
        decomposition: stageDurationsMs.decomposition,
        acceptanceRequirements: stageDurationsMs.acceptanceRequirements,
        total: stageDurationsMs.total,
      },
      failedFeatureIds: [...failedIds],
      partialSuccess: failedIds.size > 0,
      partialSuccessMessage: failedIds.size > 0
        ? `Acceptance requirements could not be completed for ${failedIds.size} feature${failedIds.size === 1 ? '' : 's'}.`
        : undefined,
      tokenUsage,
    } as any,
  };
}
