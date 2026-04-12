import type {
  ClarifyAnswer,
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
import { formatWorkInstructionInsightsForPrompt } from './wi-insights';
import {
  annotateFailedAcceptanceRequirementFeatures,
  assessRequirement,
  findFeaturesMissingCompleteAcceptanceRequirements,
  GenerationCancelledError,
  normaliseFeature,
  parseQuestionCandidates,
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

interface StoryAssistantDiscoveryResult {
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

interface StoryAssistantSufficiencyResult {
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

function formatClarifyAnswers(answers: ClarifyAnswer[]): string {
  if (!answers.length) return '';
  return answers
    .map((answer, index) => {
      const category = answer.categoryKey ? ` [${answer.categoryKey}]` : '';
      return `${index + 1}.${category} Q: ${answer.question}\nA: ${answer.answer}`;
    })
    .join('\n\n');
}

function trimPromptText(text: string, maxChars: number): string {
  const normalized = String(text ?? '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars).trimEnd()}\n...[truncated for speed]`;
}

function simpleQuestionPlan(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  clarifyAnswers: ClarifyAnswer[];
}) {
  const assessment = assessRequirement({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    wiContextText: input.wiContextText,
    clarifyAnswers: input.clarifyAnswers,
  });

  const complexity = assessment.deliveryForecast.complexity;
  const ambiguity = assessment.discoveryForecast.ambiguity;
  const questionPlan =
    complexity === 'very_high'
      ? { min: 10, max: 14, target: 12 }
      : complexity === 'high' || ambiguity === 'high'
        ? { min: 8, max: 12, target: 10 }
        : complexity === 'medium' || ambiguity === 'medium'
          ? { min: 6, max: 9, target: 7 }
          : { min: 4, max: 6, target: 5 };

  const discoveryProfile: DiscoveryProfile = {
    scope: assessment.discoveryForecast.scope,
    complexity: assessment.discoveryForecast.complexity,
    ambiguity: assessment.discoveryForecast.ambiguity,
    missingCategoryKeys: [],
    recommendedInitialCount: questionPlan.target,
    followupCap: 2,
    plannedQuestionBudget: questionPlan.target + 2,
    actualQuestionsAsked: 0,
    softQuestionBudget: questionPlan.target,
    hardQuestionCap: questionPlan.max + 2,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys: [],
      plannedQuestionBudget: questionPlan.target + 2,
      actualQuestionsAsked: 0,
      actualAnswersReceived: input.clarifyAnswers.length,
    }),
  };

  const ambiguityAssessment = {
    level: ambiguity === 'high' ? 'vague' as const : ambiguity === 'low' ? 'clear' as const : 'medium' as const,
    score:
      complexity === 'very_high' ? 9
      : complexity === 'high' ? 8
      : complexity === 'medium' ? 5
      : 3,
    reasons: assessment.reasoning
      ? assessment.reasoning.split('. ').map((reason) => reason.trim()).filter(Boolean).slice(0, 4)
      : ['Discovery is focusing on unresolved business ambiguity.'],
    questionPlan,
    generatedQuestions: 0,
  };

  return { assessment, questionPlan, discoveryProfile, ambiguityAssessment };
}

function buildClarifyUserMessage(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  wiInsightsText: string;
}) {
  const parts = [`REQUIREMENT:\n${trimPromptText(input.requirement, 5000)}`];

  if (input.attachmentText.trim()) {
    parts.push(`ATTACHMENT CONTEXT:\n${trimPromptText(input.attachmentText, 12000)}`);
  }
  if (input.wiInsightsText.trim()) {
    parts.push(`WORK INSTRUCTION INSIGHTS:\n${trimPromptText(input.wiInsightsText, 5000)}`);
  }
  if (input.wiContextText.trim()) {
    parts.push(`WORK INSTRUCTIONS / OPERATIONAL GUIDANCE:\n${trimPromptText(input.wiContextText, 12000)}`);
  }

  return parts.join('\n\n---\n\n');
}

function buildSufficiencyUserMessage(input: {
  requirement: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | Pick<ClarifyQuestion, 'categoryKey' | 'intent' | 'question'>>;
  attachmentText?: string;
  wiContextText?: string;
}) {
  const askedQuestions = (input.askedQuestions ?? input.answers.map((answer) => ({
    categoryKey: answer.categoryKey,
    intent: answer.intent,
    question: answer.question,
  })))
    .map((question, index) => {
      if (typeof question === 'string') return `${index + 1}. ${question}`;
      const parts = [question.categoryKey, question.intent].filter(Boolean).join(' | ');
      return `${index + 1}. ${parts ? `[${parts}] ` : ''}${question.question}`;
    })
    .join('\n');

  const parts = [
    `REQUIREMENT:\n${trimPromptText(input.requirement, 5000)}`,
    askedQuestions ? `DISCOVERY QUESTIONS ALREADY ASKED:\n${askedQuestions}` : '',
    input.answers.length ? `DISCOVERY ANSWERS:\n${formatClarifyAnswers(input.answers)}` : '',
    input.attachmentText?.trim()
      ? `ATTACHMENT CONTEXT:\n${trimPromptText(input.attachmentText, 6000)}`
      : '',
    input.wiContextText?.trim()
      ? `WORK INSTRUCTIONS / OPERATIONAL GUIDANCE:\n${trimPromptText(input.wiContextText, 6000)}`
      : '',
  ].filter(Boolean);

  return parts.join('\n\n---\n\n');
}

function buildGenerationContextMessage(input: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  wiContextText: string;
  wiInsightsText: string;
}) {
  const parts = [`REQUIREMENT:\n${trimPromptText(input.requirement, 5000)}`];

  if (input.clarifyAnswers.length) {
    parts.push(`STAKEHOLDER CLARIFICATIONS:\n${formatClarifyAnswers(input.clarifyAnswers)}`);
  }
  if (input.attachmentText.trim()) {
    parts.push(`ATTACHMENT CONTEXT:\n${trimPromptText(input.attachmentText, 12000)}`);
  }
  if (input.wiInsightsText.trim()) {
    parts.push(`WORK INSTRUCTION INSIGHTS:\n${trimPromptText(input.wiInsightsText, 5000)}`);
  }
  if (input.wiContextText.trim()) {
    parts.push(`WORK INSTRUCTIONS / OPERATIONAL GUIDANCE:\n${trimPromptText(input.wiContextText, 12000)}`);
  }

  return parts.join('\n\n---\n\n');
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
}): Promise<StoryAssistantDiscoveryResult> {
  const planning = simpleQuestionPlan({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiContextText: opts.wiContextText,
    clarifyAnswers: [],
  });
  const wiInsightsText = formatWorkInstructionInsightsForPrompt(opts.wiInsightsArtifact as any, 8).trim();
  const systemPrompt = buildStoryAssistantClarifySystemPrompt({
    domainContext: opts.config.domainContext,
    domainRoles: opts.config.domainRoles,
    questionPlan: planning.questionPlan,
  });
  const userMessage = buildClarifyUserMessage({
    requirement: opts.requirement,
    attachmentText: opts.attachmentText,
    wiContextText: opts.wiContextText,
    wiInsightsText,
  });
  const providerOpts = buildProviderOpts(opts.config);
  const usageByStage: Record<string, { input: number; output: number }> = {};
  let questions: ClarifyQuestion[] = [];

  for (const attempt of [1, 2]) {
    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(opts.config.generatorConfig.clarifyModel, opts.config.tier),
      systemPrompt,
      userMessage: attempt === 1
        ? userMessage
        : `${userMessage}\n\nIMPORTANT: The first response returned too few useful questions. Re-run discovery and return at least ${planning.questionPlan.min} materially distinct questions when that many ambiguities remain.`,
      maxTokens: 4096,
      reasoningEffort: 'low',
      ...providerOpts,
    });
    usageByStage[attempt === 1 ? 'clarify' : 'clarifyRetry'] = result.usage;
    questions = parseQuestionCandidates(result.data);
    if (questions.length >= planning.questionPlan.min || attempt === 2) break;
  }

  const limitedQuestions = questions.slice(0, planning.questionPlan.max);
  const discoveryProfile: DiscoveryProfile = {
    ...planning.discoveryProfile,
    actualQuestionsAsked: limitedQuestions.length,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys: [],
      plannedQuestionBudget: planning.discoveryProfile.plannedQuestionBudget ?? (planning.questionPlan.target + 2),
      actualQuestionsAsked: limitedQuestions.length,
      actualAnswersReceived: 0,
    }),
  };

  return {
    questions: limitedQuestions,
    tokenUsage: buildTokenUsageSummary(usageByStage),
    discoveryProfile,
    ambiguityAssessment: {
      ...planning.ambiguityAssessment,
      generatedQuestions: limitedQuestions.length,
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
  const startedAt = Date.now();
  const providerOpts = buildProviderOpts(opts.config);
  try {
    const result = await callLlmJsonWithUsage<Record<string, unknown>>({
      model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
      systemPrompt: buildStoryAssistantSufficiencySystemPrompt({
        domainContext: opts.config.domainContext,
        domainRoles: opts.config.domainRoles,
      }),
      userMessage: buildSufficiencyUserMessage({
        requirement: opts.requirement,
        answers: opts.answers,
        askedQuestions: opts.askedQuestions,
        attachmentText: opts.attachmentText,
        wiContextText: opts.wiContextText,
      }),
      maxTokens: 1200,
      reasoningEffort: 'low',
      ...providerOpts,
    });

    const sufficient = Boolean(result.data.sufficient);
    const questions = parseQuestionCandidates(result.data).slice(0, 2);
    const reasonCodes = Array.isArray(result.data.reasonCodes)
      ? result.data.reasonCodes.map((value) => String(value ?? '').trim()).filter(Boolean)
      : [];
    const missingCategoryKeys = questions
      .map((question) => question.categoryKey)
      .filter((value, index, values) => values.indexOf(value) === index);
    const status =
      sufficient ? 'ready_to_generate'
      : questions.length > 0 ? 'ask_followup'
      : 'ready_with_open_decisions';

    return {
      sufficient,
      status,
      ...(status === 'ask_followup' ? { questions } : {}),
      missingCategoryKeys,
      reasonCodes,
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys,
        plannedQuestionBudget: (opts.askedQuestions?.length ?? opts.answers.length) + 2,
        actualQuestionsAsked: opts.askedQuestions?.length ?? opts.answers.length,
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
        plannedQuestionBudget: (opts.askedQuestions?.length ?? opts.answers.length) + 2,
        actualQuestionsAsked: opts.askedQuestions?.length ?? opts.answers.length,
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
  const providerOpts = buildProviderOpts(opts.config);
  const stageDurationsMs = { ...(opts.priorStageDurationsMs ?? {}) } as Record<string, number>;
  const wiInsightsText = formatWorkInstructionInsightsForPrompt(opts.wiInsightsArtifact as any, 8).trim();
  const stageUsage: Record<string, { input: number; output: number }> = {};
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
        wiInsightsText,
      })}\n\n---\n\nDecompose this requirement into the distinct features needed to deliver it. Leave acceptance_requirements as empty arrays.`,
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
      wiInsightsText,
    })}\n\n---\n\nFEATURES TO WRITE ACCEPTANCE REQUIREMENTS FOR:\n${JSON.stringify({
      features: pass1Raw.map((feature) => ({
        ...feature,
        acceptance_requirements: [],
      })),
    }, null, 2)}`,
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
