import { callLlmJsonWithUsage } from '../core/llm';
import type { AcceptanceRequirement, ClarifyCategoryKey, Feature, TenantConfig } from '../types';
import { buildArWriterSystemPrompt, buildArWriterUserMessage, buildCapabilityReasoningSystemPrompt, buildCapabilityReasoningUserMessage, buildCompactEvidenceSummary, buildDiscoverySystemPrompt, buildDiscoveryUserMessage, buildFeatureFormatterSystemPrompt, buildFeatureFormatterUserMessage, buildScopeHypothesisSystemPrompt, buildScopeHypothesisUserMessage, buildTriageSystemPrompt, buildTriageUserMessage, V2_AR_WRITER_SCHEMA, V2_DISCOVERY_SCHEMA, V2_FEATURE_FORMATTER_SCHEMA, V2_REASONING_SCHEMA, V2_SCOPE_HYPOTHESIS_SCHEMA, V2_TRIAGE_SCHEMA, validateDiscoveryQuestions, validateReasoningArtifact, validateScopeHypothesis, validateTriageScores } from './prompts';
import { assessV2TriageFromScores, type V2RawTriageScores } from './triage';
import type { V2CapabilityReasoningArtifact, V2ClassifiedAnswer, V2DiscoveryAnswer, V2DiscoveryQuestion, V2PipelineInput, V2PipelineResult, V2ScopeHypothesis, V2StageExecutor, V2StageRequest, V2TriageResult } from './types';
import { evaluateV2Quality } from './validators';

interface RawFormattedFeature {
  summary: string;
  description: string;
  suggested_story_points: number;
  process_code?: string;
}

interface RawArWriterResponse {
  acceptanceRequirements: AcceptanceRequirement[];
}

function providerOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    fireworksApiKey: config.generatorConfig.fireworksApiKey,
    fireworksBaseUrl: config.generatorConfig.fireworksBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: config.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
    groqApiKey: config.generatorConfig.groqApiKey,
    groqBaseUrl: config.generatorConfig.groqBaseUrl,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;
}

export function createDefaultV2StageExecutor(config: TenantConfig): V2StageExecutor {
  const provider = providerOpts(config);
  return async function executeStage<T>(request: V2StageRequest<T>) {
    const model =
      request.stage === 'triage'
        ? config.generatorConfig.triageModel
        : request.stage === 'ar_writer'
          ? config.generatorConfig.arModel
          : request.stage === 'scope_hypothesis' || request.stage === 'discover'
            ? config.generatorConfig.clarifyModel
            : config.generatorConfig.decompositionModel;

    const response = await callLlmJsonWithUsage<T>({
      model,
      systemPrompt: request.systemPrompt,
      userMessage: request.userMessage,
      jsonSchema: request.jsonSchema,
      maxTokens: request.maxTokens,
      reasoningEffort: request.reasoningEffort,
      validate: request.validate,
      ...provider,
    });
    return {
      data: response.data,
      usage: response.usage,
    };
  };
}

function inferCategory(question: string): ClarifyCategoryKey {
  const lowered = question.toLowerCase();
  if (/\b(role|who|approv|review|owner)\b/.test(lowered)) return 'user_personas';
  if (/\b(state|resume|reopen|cancel|lifecycle)\b/.test(lowered)) return 'state_lifecycle';
  if (/\b(rule|threshold|validation|exception|override|manual)\b/.test(lowered)) return 'business_rules';
  if (/\b(metric|measure|success|outcome)\b/.test(lowered)) return 'success_measurement';
  if (/\bflow|step|sequence|route|handoff\b/.test(lowered)) return 'functional_flow';
  return 'context_trigger';
}

export function classifyDiscoveryAnswers(answers: V2DiscoveryAnswer[]): V2ClassifiedAnswer[] {
  return answers.map((answer) => {
    const normalized = answer.answer.trim();
    const lowered = normalized.toLowerCase();
    if (!normalized || normalized.length < 8 || /^(yes|no|n\/a|none|unknown|tbd)$/i.test(lowered)) {
      return { ...answer, materiality: 'trivial', reason: 'The answer is too short or generic to change capability reasoning.' };
    }
    if (answer.categoryKey === 'user_personas' || /\b(role|approv|owner|manager|specialist|engineer)\b/.test(lowered)) {
      return { ...answer, materiality: 'actor_bearing', reason: 'The answer materially affects actor accountability.' };
    }
    if (answer.categoryKey === 'business_rules' || /\bmust|must not|cannot|override|manual|rule|threshold|entitle|billable\b/.test(lowered)) {
      return { ...answer, materiality: 'rule_bearing', reason: 'The answer contains governing business logic.' };
    }
    if (answer.categoryKey === 'success_measurement' || /\bmetric|measure|success|sla|kpi|target\b/.test(lowered)) {
      return { ...answer, materiality: 'measurement_bearing', reason: 'The answer changes the success criteria or output framing.' };
    }
    if (answer.categoryKey === 'functional_flow' || answer.categoryKey === 'state_lifecycle') {
      return { ...answer, materiality: 'structural', reason: 'The answer affects workflow shape, lifecycle, or capability boundaries.' };
    }
    return { ...answer, materiality: 'trivial', reason: 'The answer is not specific enough to change the generated feature set.' };
  });
}

function mapFormattedFeatures(rawFeatures: RawFormattedFeature[]): Feature[] {
  return rawFeatures.map((feature, index) => ({
    id: `v2_feature_${index + 1}`,
    summary: feature.summary.trim(),
    description: feature.description.trim(),
    acceptanceRequirements: [],
    storyPoints: feature.suggested_story_points,
    ...(feature.process_code ? { processCode: feature.process_code } : {}),
  }));
}

function buildDiscoveryChanges(answers: V2ClassifiedAnswer[]): string[] {
  return answers
    .filter((answer) => answer.materiality !== 'trivial')
    .slice(0, 8)
    .map((answer) => `${answer.materiality.replace(/_/g, ' ')}: ${answer.question}`);
}

export async function runV2Pipeline(
  input: V2PipelineInput,
  executeStage: V2StageExecutor = createDefaultV2StageExecutor(input.config),
): Promise<V2PipelineResult> {
  const evidenceSummary = buildCompactEvidenceSummary(input);
  const promptUsage: {
    input: number;
    output: number;
    byStage: Partial<Record<V2StageRequest<unknown>['stage'], { input: number; output: number }>>;
  } = {
    input: 0,
    output: 0,
    byStage: {},
  };
  let triage: V2TriageResult;
  if (input.triageOverride) {
    triage = input.triageOverride;
  } else {
    try {
      const triageResponse = await executeStage<V2RawTriageScores>({
        stage: 'triage',
        model: input.config.generatorConfig.triageModel,
        systemPrompt: buildTriageSystemPrompt(),
        userMessage: buildTriageUserMessage({
          requirement: input.requirement,
          attachmentText: input.attachmentText,
        }),
        jsonSchema: V2_TRIAGE_SCHEMA,
        maxTokens: 220,
        reasoningEffort: 'low',
        validate: validateTriageScores,
      });
      triage = assessV2TriageFromScores(
        triageResponse.data,
        input.requirement,
        input.attachmentText ?? '',
      );
      promptUsage.input += triageResponse.usage.input;
      promptUsage.output += triageResponse.usage.output;
      promptUsage.byStage.triage = triageResponse.usage;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error ?? 'Unknown triage error');
      throw new Error(`V2 triage failed: ${reason}`);
    }
  }

  let scopeHypothesis = input.confirmedScopeHypothesis;
  if (!scopeHypothesis) {
    const scopeResponse = await executeStage<V2ScopeHypothesis>({
      stage: 'scope_hypothesis',
      model: input.config.generatorConfig.clarifyModel,
      systemPrompt: buildScopeHypothesisSystemPrompt(),
      userMessage: buildScopeHypothesisUserMessage({
        requirement: input.requirement,
        attachmentText: input.attachmentText,
        triage,
        domainContext: input.domainContext,
      }),
      jsonSchema: V2_SCOPE_HYPOTHESIS_SCHEMA,
      maxTokens: 1400,
      reasoningEffort: 'low',
      validate: validateScopeHypothesis,
    });
    scopeHypothesis = scopeResponse.data;
    promptUsage.input += scopeResponse.usage.input;
    promptUsage.output += scopeResponse.usage.output;
    promptUsage.byStage.scope_hypothesis = scopeResponse.usage;
  }

  if (input.previewOnly) {
    return {
      status: 'preview_ready',
      triage,
      scopeHypothesis,
      recommendedNextStep: 'run_discovery',
    };
  }

  if (!input.confirmedScopeHypothesis) {
    return {
      status: 'needs_scope_confirmation',
      triage,
      scopeHypothesis,
      recommendedNextStep: 'run_discovery',
    };
  }

  const classifiedAnswers = classifyDiscoveryAnswers(input.discoveryAnswers ?? []);
  const hasMaterialAnswers = classifiedAnswers.some((answer) => answer.materiality !== 'trivial');

  if (!hasMaterialAnswers) {
    const discovery = await executeStage<{ questions: V2DiscoveryQuestion[] }>({
      stage: 'discover',
      model: input.config.generatorConfig.clarifyModel,
      systemPrompt: buildDiscoverySystemPrompt(),
      userMessage: buildDiscoveryUserMessage({
        requirement: input.requirement,
        triage,
        scopeHypothesis,
        domainContext: input.domainContext,
      }),
      jsonSchema: V2_DISCOVERY_SCHEMA,
      maxTokens: 1600,
      reasoningEffort: 'low',
      validate: validateDiscoveryQuestions,
    });
    promptUsage.input += discovery.usage.input;
    promptUsage.output += discovery.usage.output;
    promptUsage.byStage.discover = discovery.usage;
    return {
      status: 'needs_discovery',
      triage,
      scopeHypothesis,
      discoveryQuestions: discovery.data.questions.slice(0, triage.questionBudget).map((question, index) => ({
        ...question,
        id: question.id || `dq_${index + 1}`,
        categoryKey: question.categoryKey || inferCategory(question.question),
      })),
      materialityHints: [
        'Answer only the questions that change capability boundaries, actor accountability, rules, or lifecycle handling.',
        'Short or trivial answers will be filtered out of generation.',
      ],
    };
  }

  const reasoning = await executeStage<V2CapabilityReasoningArtifact>({
    stage: 'capability_reasoning',
    model: input.config.generatorConfig.decompositionModel,
    systemPrompt: buildCapabilityReasoningSystemPrompt(),
    userMessage: buildCapabilityReasoningUserMessage({
      requirement: input.requirement,
      scopeHypothesis,
      classifiedAnswers,
      evidenceSummary,
    }),
    jsonSchema: V2_REASONING_SCHEMA,
    maxTokens: 2200,
    reasoningEffort: 'medium',
    validate: validateReasoningArtifact,
  });
  promptUsage.input += reasoning.usage.input;
  promptUsage.output += reasoning.usage.output;
  promptUsage.byStage.capability_reasoning = reasoning.usage;

  const formatted = await executeStage<{ features: RawFormattedFeature[] }>({
    stage: 'feature_formatter',
    model: input.config.generatorConfig.decompositionModel,
    systemPrompt: buildFeatureFormatterSystemPrompt(),
    userMessage: buildFeatureFormatterUserMessage({
      reasoning: reasoning.data,
      processTaxonomyEnabled: input.config.processTaxonomyEnabled,
      processCodes: input.config.processTaxonomy,
    }),
    jsonSchema: V2_FEATURE_FORMATTER_SCHEMA,
    maxTokens: 1800,
    reasoningEffort: 'low',
  });
  promptUsage.input += formatted.usage.input;
  promptUsage.output += formatted.usage.output;
  promptUsage.byStage.feature_formatter = formatted.usage;

  const features = mapFormattedFeatures(formatted.data.features);
  for (const feature of features) {
    const arResponse = await executeStage<RawArWriterResponse>({
      stage: 'ar_writer',
      model: input.config.generatorConfig.arModel,
      systemPrompt: buildArWriterSystemPrompt(),
      userMessage: buildArWriterUserMessage({
        feature: { summary: feature.summary, description: feature.description },
        capabilityReasoning: reasoning.data,
      }),
      jsonSchema: V2_AR_WRITER_SCHEMA,
      maxTokens: 2200,
      reasoningEffort: 'medium',
    });
    feature.acceptanceRequirements = arResponse.data.acceptanceRequirements;
    promptUsage.input += arResponse.usage.input;
    promptUsage.output += arResponse.usage.output;
    promptUsage.byStage.ar_writer = {
      input: (promptUsage.byStage.ar_writer?.input ?? 0) + arResponse.usage.input,
      output: (promptUsage.byStage.ar_writer?.output ?? 0) + arResponse.usage.output,
    };
  }

  return {
    status: 'complete',
    triage,
    scopeHypothesis,
    reasoning: reasoning.data,
    features,
    classifiedAnswers,
    discoveryChanges: buildDiscoveryChanges(classifiedAnswers),
    quality: evaluateV2Quality(features),
    promptUsage,
  };
}
