import { callLlmJsonWithUsage } from '../core/llm';
import type { ClarifyCategoryKey, Feature, PipelineProfile, TenantConfig } from '../types';
import {
  buildCoverageRepairSystemPrompt,
  buildCoverageRepairUserMessage,
  buildDiscoverySystemPrompt,
  buildDiscoveryUserMessage,
  buildFinalGenerationSystemPrompt,
  buildFinalGenerationUserMessage,
  buildScopeHypothesisSystemPrompt,
  buildScopeHypothesisUserMessage,
  buildSynthesisSystemPrompt,
  buildSynthesisUserMessage,
  buildTriageSystemPrompt,
  buildTriageUserMessage,
  V2_DISCOVERY_SCHEMA,
  V2_FINAL_GENERATION_SCHEMA,
  V2_SCOPE_HYPOTHESIS_SCHEMA,
  V2_SYNTHESIS_SCHEMA,
  V2_TRIAGE_SCHEMA,
  validateDiscoveryQuestions,
  validateFinalGeneration,
  validateScopeHypothesis,
  validateSynthesis,
  validateTriageScores,
} from './prompts';
import { assessV2TriageFromScores, type V2RawTriageScores } from './triage';
import type {
  V2CapabilityReasoningArtifact,
  V2ClassifiedAnswer,
  V2CoverageGateResult,
  V2DiscoveryAnswer,
  V2DiscoveryQuestion,
  V2DiscoverySynthesis,
  V2FinalGenerationResponse,
  V2GeneratedFeature,
  V2GroundedEvidencePack,
  V2PipelineInput,
  V2PipelineResult,
  V2ScopeHypothesis,
  V2StageExecutor,
  V2ProgressReporter,
  V2StageRequest,
  V2TriageResult,
} from './types';
import { evaluateV2Quality } from './validators';
import {
  buildV2GroundedEvidencePack,
  enrichCapabilityReasoning,
  enrichScopeHypothesis,
  renderGroundedEvidencePack,
  validateDiscoveryQuestionsAgainstEvidence,
  validateScopeHypothesisAgainstEvidence,
} from './evidence-pack';
import { buildV2EvidenceBundleFromProjectMemory } from '../services/project-memory';
import { getPipelineAuditWriter } from '../services/pipeline-audit-context';

const GENERIC_ACTOR_PATTERN = /\bas\s+an?\s+(?:user|authorized user|team member|authorized team member)\b/i;
const CRUD_ONLY_PATTERN = /\b(create|edit|update|delete|remove|view|read|list)\b/i;
const WORKFLOW_PATTERN = /\b(workflow|approval|route|routing|handoff|fallback|override|exception|lifecycle|state|dispatch|sequence|coordinate|entitlement|billable)\b/i;

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
    getPipelineAuditWriter()?.setPhase(`v2.${request.stage}`);
    const model =
      request.stage === 'triage'
        ? config.generatorConfig.triageModel
        : request.stage === 'scope_hypothesis' || request.stage === 'discover'
          ? config.generatorConfig.clarifyModel
          : request.stage === 'ar_writer'
            ? config.generatorConfig.arModel
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

function normalizeStableId(
  value: string | undefined,
  prefix: string,
  index: number,
  used: Set<string>,
): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const fallback = `${prefix}_${index + 1}`;
  const withPrefix = normalized
    ? (normalized.startsWith(`${prefix}_`) ? normalized : `${prefix}_${normalized}`)
    : fallback;
  const base = withPrefix.slice(0, 32) || fallback;
  let candidate = base;
  let duplicateIndex = 2;
  while (used.has(candidate)) {
    const suffix = `_${duplicateIndex}`;
    candidate = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    duplicateIndex += 1;
  }
  used.add(candidate);
  return candidate;
}

function normalizeScopeHypothesis(scopeHypothesis: V2ScopeHypothesis): V2ScopeHypothesis {
  const usedCapabilityIds = new Set<string>();
  return {
    ...scopeHypothesis,
    capabilities: scopeHypothesis.capabilities.map((capability, index) => ({
      ...capability,
      id: normalizeStableId(capability.id || capability.label, 'cap', index, usedCapabilityIds),
    })),
  };
}

function normalizeDiscoveryQuestionsForReturn(
  questions: V2DiscoveryQuestion[],
  questionBudget: number,
): V2DiscoveryQuestion[] {
  return questions.slice(0, questionBudget).map((question, index) => ({
    ...question,
    id: question.id || `dq_${index + 1}`,
    categoryKey: question.categoryKey || inferCategory(question.question),
  }));
}

export function classifyDiscoveryAnswers(answers: V2DiscoveryAnswer[]): V2ClassifiedAnswer[] {
  return answers.map((answer) => {
    const normalized = answer.answer.trim();
    const lowered = normalized.toLowerCase();
    if (!normalized || normalized.length < 8 || /^(yes|no|n\/a|none|unknown|tbd)$/i.test(lowered)) {
      return { ...answer, materiality: 'trivial', reason: 'The answer is too short or generic to change capability reasoning.' };
    }
    if (answer.categoryKey === 'user_personas' || /\b(role|approv|owner|manager|specialist|engineer|planner|analyst)\b/.test(lowered)) {
      return { ...answer, materiality: 'actor_bearing', reason: 'The answer materially affects actor accountability.' };
    }
    if (answer.categoryKey === 'business_rules' || /\bmust|must not|cannot|override|manual|rule|threshold|entitle|billable|fallback\b/.test(lowered)) {
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

function addUsage(
  promptUsage: {
    input: number;
    output: number;
    byStage: Partial<Record<V2StageRequest<unknown>['stage'], { input: number; output: number }>>;
  },
  stage: V2StageRequest<unknown>['stage'],
  usage: { input: number; output: number },
) {
  promptUsage.input += usage.input;
  promptUsage.output += usage.output;
  promptUsage.byStage[stage] = {
    input: (promptUsage.byStage[stage]?.input ?? 0) + usage.input,
    output: (promptUsage.byStage[stage]?.output ?? 0) + usage.output,
  };
}

function currentPipelineProfile(config: TenantConfig): PipelineProfile {
  return config.generatorConfig.pipelineProfile === 'fast' || config.generatorConfig.pipelineProfile === 'quality'
    ? config.generatorConfig.pipelineProfile
    : 'balanced';
}

function stageReasoningEffort(
  config: TenantConfig,
  profile: PipelineProfile,
  model: string,
  stage: 'triage' | 'scope_hypothesis' | 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair',
): 'low' | 'medium' | 'high' {
  const isGeminiThree = config.generatorConfig.provider === 'gemini' && /^gemini-3(?:[._-]|$)/i.test(model.trim());
  if (isGeminiThree) {
    if (stage === 'triage') {
      if (profile === 'fast') return 'low';
      if (profile === 'quality') return 'high';
      return 'medium';
    }
    if (stage === 'scope_hypothesis' || stage === 'discover' || stage === 'discovery_synthesis') {
      if (profile === 'fast') return 'low';
      return 'high';
    }
    if (stage === 'final_generation') return profile === 'quality' ? 'high' : 'medium';
    if (stage === 'coverage_repair') return profile === 'quality' ? 'medium' : 'low';
    return 'medium';
  }
  if (stage === 'triage') return 'low';
  if (stage === 'scope_hypothesis' || stage === 'discover') {
    if (profile === 'fast') return 'low';
    if (profile === 'quality') return 'high';
    return 'medium';
  }
  if (profile === 'fast') return 'low';
  if (stage === 'coverage_repair') return profile === 'quality' ? 'medium' : 'low';
  if (stage === 'final_generation') return profile === 'quality' ? 'high' : 'medium';
  return 'medium';
}

function buildPipelineEvidenceBundle(input: V2PipelineInput) {
  const memoryBundle = buildV2EvidenceBundleFromProjectMemory({
    domainContext: input.domainContext,
    memoryHeader: input.memoryHeader,
    memorySelection: input.memorySelection,
  });
  return {
    domainContext: memoryBundle.domainContext || input.domainContext,
    domainRoles: memoryBundle.domainRoles?.length ? memoryBundle.domainRoles : input.domainRoles,
    similarStoriesText: memoryBundle.similarStoriesText || input.similarStoriesText,
    wiContextText: memoryBundle.wiContextText || input.wiContextText,
  };
}

function mapGeneratedFeatures(rawFeatures: V2GeneratedFeature[]): Feature[] {
  return rawFeatures.map((feature, index) => ({
    id: `v2_feature_${index + 1}`,
    summary: feature.summary.trim(),
    description: feature.description.trim(),
    acceptanceRequirements: feature.acceptanceRequirements ?? [],
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

function normalizeForMatch(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeForMatch(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !['with', 'from', 'that', 'this', 'when', 'then', 'must', 'need', 'user'].includes(token));
}

function textHasMeaningfulOverlap(needle: string, haystack: string): boolean {
  const needleTokens = tokens(needle);
  if (!needleTokens.length) return false;
  const normalizedHaystack = normalizeForMatch(haystack);
  const matches = needleTokens.filter((token) => normalizedHaystack.includes(token)).length;
  return matches >= Math.min(2, needleTokens.length);
}

function featureText(feature: Feature): string {
  return [
    feature.summary,
    feature.description,
    ...feature.acceptanceRequirements.flatMap((ar) => [ar.given, ar.when, ar.then]),
  ].join(' ');
}

function assessCoverage(
  generated: V2FinalGenerationResponse,
  synthesis: V2DiscoverySynthesis,
  evidencePack: V2GroundedEvidencePack,
): V2CoverageGateResult {
  const features = mapGeneratedFeatures(generated.features);
  const allFeatureText = features.map(featureText).join('\n');
  const openDecisionTitles = new Set(synthesis.openDecisions.map((decision) => normalizeForMatch(decision.title)));
  const featureSummaries = new Set(features.map((feature) => normalizeForMatch(feature.summary)));
  const failures: string[] = [];

  for (const behavior of synthesis.mustCoverBehaviors) {
    const mapping = generated.coverageMap.find((entry) => normalizeForMatch(entry.mustCoverBehavior) === normalizeForMatch(behavior));
    const mappedFeature = mapping?.featureSummary ? featureSummaries.has(normalizeForMatch(mapping.featureSummary)) : false;
    const mappedOpen = mapping?.openDecisionTitle ? openDecisionTitles.has(normalizeForMatch(mapping.openDecisionTitle)) : false;
    const textCovered = textHasMeaningfulOverlap(behavior, allFeatureText);
    if (!mappedFeature && !mappedOpen && !textCovered) {
      failures.push(`Must-cover behavior is not represented: ${behavior}`);
    }
  }

  const groundedSpecificRole = evidencePack.roleCandidates.some((candidate) => candidate.confidence === 'strong' || candidate.confidence === 'supported');
  if (groundedSpecificRole) {
    const weakActor = features.find((feature) => GENERIC_ACTOR_PATTERN.test(feature.description));
    if (weakActor) {
      failures.push(`Feature "${weakActor.summary}" uses a generic actor despite grounded role evidence.`);
    }
  }

  for (const feature of features) {
    if (feature.acceptanceRequirements.length < 2) {
      failures.push(`Feature "${feature.summary}" has fewer than two acceptance requirements.`);
    }
    if (synthesis.arDepth === 'deep' && feature.acceptanceRequirements.length < 3) {
      failures.push(`Feature "${feature.summary}" is too light for deep AR coverage.`);
    }
  }

  const workflowNeeded = synthesis.workflowSteps.length || synthesis.exceptions.length || synthesis.lifecycleStates.length || synthesis.businessRules.length;
  const crudOnly = features.some((feature) => {
    const text = `${feature.summary} ${feature.description}`;
    return CRUD_ONLY_PATTERN.test(text) && workflowNeeded && !WORKFLOW_PATTERN.test(text);
  });
  if (crudOnly) {
    failures.push('At least one feature still looks like a CRUD fragment even though workflow/rule coverage is required.');
  }

  return {
    sufficient: failures.length === 0,
    failures,
    repaired: false,
  };
}

function buildReasoningArtifactFromSynthesis(
  synthesis: V2DiscoverySynthesis,
  features: Feature[],
): V2CapabilityReasoningArtifact {
  const globalRules = [...synthesis.businessRules, ...synthesis.workflowSteps].filter(Boolean).slice(0, 10);
  const globalEdges = [...synthesis.exceptions, ...synthesis.lifecycleStates].filter(Boolean).slice(0, 10);
  return {
    capabilities: features.map((feature, index) => ({
      capabilityId: `cap_${index + 1}`,
      label: feature.summary,
      boundary: feature.description,
      ownerRole: synthesis.actorMap.performer
        ?? synthesis.actorMap.initiator
        ?? feature.description.match(/^As an? ([^,]+),/i)?.[1]
        ?? 'authorized user',
      mustCarryRules: globalRules.length ? globalRules.slice(0, 6) : synthesis.mustCoverBehaviors.slice(0, 6),
      edgeCases: globalEdges.length ? globalEdges.slice(0, 4) : ['No material exception was resolved during discovery.'],
    })),
    actorSlots: synthesis.actorMap,
    mustCarryRules: globalRules.length ? globalRules : synthesis.mustCoverBehaviors.slice(0, 10),
    edgeCases: globalEdges.length ? globalEdges : [],
    openDecisions: synthesis.openDecisions,
  };
}

function normalizeSynthesis(
  synthesis: V2DiscoverySynthesis,
  triage: V2TriageResult,
  scopeHypothesis: V2ScopeHypothesis,
): V2DiscoverySynthesis {
  const mustCover = synthesis.mustCoverBehaviors?.length
    ? synthesis.mustCoverBehaviors
    : triage.mustCoverBehaviors;
  return {
    ...synthesis,
    actorMap: Object.keys(synthesis.actorMap ?? {}).length ? synthesis.actorMap : scopeHypothesis.actorSlots,
    mustCoverBehaviors: mustCover.slice(0, 12),
    arDepth: synthesis.arDepth ?? triage.arDepth,
    featureTarget: Math.max(1, Math.min(6, synthesis.featureTarget || scopeHypothesis.capabilities.length || triage.likelyCapabilityCount)),
  };
}

function normalizeTriageOverride(
  triage: V2TriageResult,
  requirement: string,
  attachmentText = '',
): V2TriageResult {
  const numeric = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const fallback = assessV2TriageFromScores({
    capability_breadth: numeric(triage.capabilityBreadth, 3),
    ask_clarity: numeric(triage.askClarity, 3),
    actor_clarity: numeric(triage.actorClarity, 3),
  }, requirement, attachmentText);
  return {
    ...fallback,
    ...triage,
    complexity: triage.complexity ?? fallback.complexity,
    ambiguity: triage.ambiguity ?? fallback.ambiguity,
    workflowDepth: triage.workflowDepth ?? fallback.workflowDepth,
    mustCoverBehaviors: triage.mustCoverBehaviors?.length ? triage.mustCoverBehaviors : fallback.mustCoverBehaviors,
    unresolvedDecisionThemes: triage.unresolvedDecisionThemes?.length ? triage.unresolvedDecisionThemes : fallback.unresolvedDecisionThemes,
    arDepth: triage.arDepth ?? fallback.arDepth,
  };
}

function shouldAskDiscovery(triage: V2TriageResult, scopeHypothesis: V2ScopeHypothesis, classifiedAnswers: V2ClassifiedAnswer[]): boolean {
  if (classifiedAnswers.some((answer) => answer.materiality !== 'trivial')) return false;
  if (triage.questionBudget <= 0) return false;
  if (triage.discoveryMode === 'light' && scopeHypothesis.confidence === 'high' && !scopeHypothesis.openQuestions.length) return false;
  return true;
}

async function buildTriage(
  input: V2PipelineInput,
  executeStage: V2StageExecutor,
  promptUsage: {
    input: number;
    output: number;
    byStage: Partial<Record<V2StageRequest<unknown>['stage'], { input: number; output: number }>>;
  },
): Promise<V2TriageResult> {
  const profile = currentPipelineProfile(input.config);
  if (input.triageOverride) {
    return normalizeTriageOverride(input.triageOverride, input.requirement, input.attachmentText);
  }

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
      maxTokens: 900,
      reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.triageModel, 'triage'),
      validate: validateTriageScores,
    });
    addUsage(promptUsage, 'triage', triageResponse.usage);
    return assessV2TriageFromScores(
      triageResponse.data,
      input.requirement,
      input.attachmentText ?? '',
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'Unknown triage error');
    throw new Error(`V2 triage failed: ${reason}`);
  }
}

export async function runV2Pipeline(
  input: V2PipelineInput,
  executeStage: V2StageExecutor = createDefaultV2StageExecutor(input.config),
  onProgress?: V2ProgressReporter,
): Promise<V2PipelineResult> {
  const pipelineEvidenceBundle = buildPipelineEvidenceBundle(input);
  const profile = currentPipelineProfile(input.config);
  const baseEvidencePack = input.evidencePack ?? buildV2GroundedEvidencePack({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    domainContext: pipelineEvidenceBundle.domainContext,
    domainRoles: pipelineEvidenceBundle.domainRoles,
    similarStoriesText: pipelineEvidenceBundle.similarStoriesText,
    wiContextText: pipelineEvidenceBundle.wiContextText,
  });
  const promptUsage: {
    input: number;
    output: number;
    byStage: Partial<Record<V2StageRequest<unknown>['stage'], { input: number; output: number }>>;
  } = {
    input: 0,
    output: 0,
    byStage: {},
  };

  const reportProgress = async (
    stage: 'triage' | 'scope_hypothesis' | 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair' | 'persisting',
    message: string,
    extras?: Parameters<NonNullable<V2ProgressReporter>>[0],
  ) => {
    if (!onProgress) return;
    await onProgress({
      stage,
      message,
      ...(extras?.draftFeatures?.length ? { draftFeatures: extras.draftFeatures } : {}),
      ...(extras?.featureCounts ? { featureCounts: extras.featureCounts } : {}),
    });
  };

  await reportProgress('triage', 'Scoring scope complexity and discovery load…');
  const triage = await buildTriage(input, executeStage, promptUsage);
  const scopeGroundedEvidenceText = renderGroundedEvidencePack(baseEvidencePack, 'scope_hypothesis');
  const discoveryGroundedEvidenceText = renderGroundedEvidencePack(baseEvidencePack, 'discover');

  let scopeHypothesis = input.confirmedScopeHypothesis;
  if (!scopeHypothesis) {
    const executeScopeRound = async (repairNote?: string) => executeStage<V2ScopeHypothesis>({
      stage: 'scope_hypothesis',
      model: input.config.generatorConfig.clarifyModel,
      systemPrompt: buildScopeHypothesisSystemPrompt(),
      userMessage: buildScopeHypothesisUserMessage({
        requirement: input.requirement,
        attachmentText: input.attachmentText,
        triage,
        groundedEvidenceText: scopeGroundedEvidenceText,
        repairNote,
      }),
      jsonSchema: V2_SCOPE_HYPOTHESIS_SCHEMA,
      maxTokens: 1400,
      reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.clarifyModel, 'scope_hypothesis'),
      validate: validateScopeHypothesis,
    });

    await reportProgress('scope_hypothesis', 'Shaping the initial scope hypothesis…');
    let scopeResponse = await executeScopeRound();
    addUsage(promptUsage, 'scope_hypothesis', scopeResponse.usage);

    let groundedScopeError = validateScopeHypothesisAgainstEvidence(scopeResponse.data as V2ScopeHypothesis, baseEvidencePack);
    if (groundedScopeError) {
      await reportProgress('scope_hypothesis', 'Tightening scope labels against grounded evidence…');
      scopeResponse = await executeScopeRound(groundedScopeError);
      addUsage(promptUsage, 'scope_hypothesis', scopeResponse.usage);
      groundedScopeError = validateScopeHypothesisAgainstEvidence(scopeResponse.data as V2ScopeHypothesis, baseEvidencePack);
    }

    const normalizedScopeHypothesis = normalizeScopeHypothesis(scopeResponse.data);
    scopeHypothesis = enrichScopeHypothesis(
      groundedScopeError
        ? { ...normalizedScopeHypothesis, confidence: 'low' }
        : normalizedScopeHypothesis,
      baseEvidencePack,
    );

    if (groundedScopeError) {
      console.warn('[v2] Scope hypothesis grounding failed after retry; continuing with best-effort draft.', {
        error: groundedScopeError,
        requirementPreview: input.requirement.slice(0, 160),
        capabilityLabels: normalizedScopeHypothesis.capabilities.map((capability) => capability.label),
      });
    }
  } else {
    scopeHypothesis = enrichScopeHypothesis(normalizeScopeHypothesis(scopeHypothesis), baseEvidencePack, { preserveActorSlots: true });
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
  if (!scopeHypothesis) {
    throw new Error('V2 pipeline cannot continue without a confirmed scope hypothesis.');
  }
  const confirmedScopeHypothesis = scopeHypothesis;

  const classifiedAnswers = classifyDiscoveryAnswers(input.discoveryAnswers ?? []);
  if (shouldAskDiscovery(triage, confirmedScopeHypothesis, classifiedAnswers)) {
    const executeDiscoveryRound = async (repairNote?: string) => executeStage<{ questions: V2DiscoveryQuestion[] }>({
      stage: 'discover',
      model: input.config.generatorConfig.clarifyModel,
      systemPrompt: buildDiscoverySystemPrompt(),
      userMessage: buildDiscoveryUserMessage({
        requirement: input.requirement,
        triage,
        scopeHypothesis: confirmedScopeHypothesis,
        groundedEvidenceText: discoveryGroundedEvidenceText,
        repairNote,
      }),
      jsonSchema: V2_DISCOVERY_SCHEMA,
      maxTokens: 1600,
      reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.clarifyModel, 'discover'),
      validate: validateDiscoveryQuestions,
    });

    await reportProgress('discover', 'Preparing the next discovery questions…');
    let discovery = await executeDiscoveryRound();
    addUsage(promptUsage, 'discover', discovery.usage);
    let groundedDiscoveryError = validateDiscoveryQuestionsAgainstEvidence(discovery.data.questions, baseEvidencePack);
    if (groundedDiscoveryError) {
      await reportProgress('discover', 'Tightening discovery questions against grounded evidence…');
      discovery = await executeDiscoveryRound(groundedDiscoveryError);
      addUsage(promptUsage, 'discover', discovery.usage);
      groundedDiscoveryError = validateDiscoveryQuestionsAgainstEvidence(discovery.data.questions, baseEvidencePack);
      if (groundedDiscoveryError) {
        throw new Error(`V2 discovery failed quality gate: ${groundedDiscoveryError}`);
      }
    }

    return {
      status: 'needs_discovery',
      triage,
      scopeHypothesis: confirmedScopeHypothesis,
      discoveryQuestions: normalizeDiscoveryQuestionsForReturn(discovery.data.questions, triage.questionBudget),
      materialityHints: [
        'Answer only the questions that change capability boundaries, actor accountability, rules, lifecycle handling, exceptions, or success measures.',
        'Short or trivial answers will be filtered out of generation.',
      ],
    };
  }

  const synthesisEvidencePack = input.evidencePack ?? buildV2GroundedEvidencePack({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    domainContext: pipelineEvidenceBundle.domainContext,
    domainRoles: pipelineEvidenceBundle.domainRoles,
    similarStoriesText: pipelineEvidenceBundle.similarStoriesText,
    wiContextText: pipelineEvidenceBundle.wiContextText,
    discoveryAnswers: classifiedAnswers,
  });
  const synthesisEvidenceText = renderGroundedEvidencePack(synthesisEvidencePack, 'discovery_synthesis');

  await reportProgress('discovery_synthesis', 'Synthesizing answers into backlog structure…');
  const synthesisResponse = await executeStage<V2DiscoverySynthesis>({
    stage: 'discovery_synthesis',
    model: input.config.generatorConfig.decompositionModel,
    systemPrompt: buildSynthesisSystemPrompt(),
    userMessage: buildSynthesisUserMessage({
      requirement: input.requirement,
      triage,
      scopeHypothesis: confirmedScopeHypothesis,
      classifiedAnswers,
      groundedEvidenceText: synthesisEvidenceText,
    }),
    jsonSchema: V2_SYNTHESIS_SCHEMA,
    maxTokens: 2200,
    reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.decompositionModel, 'discovery_synthesis'),
    validate: validateSynthesis,
  });
  addUsage(promptUsage, 'discovery_synthesis', synthesisResponse.usage);
  const synthesis = normalizeSynthesis(synthesisResponse.data, triage, confirmedScopeHypothesis);

  const finalEvidenceText = renderGroundedEvidencePack(synthesisEvidencePack, 'final_generation');
  await reportProgress('final_generation', 'Drafting capability-first backlog features…');
  const finalResponse = await executeStage<V2FinalGenerationResponse>({
    stage: 'final_generation',
    model: input.config.generatorConfig.decompositionModel,
    systemPrompt: buildFinalGenerationSystemPrompt(),
    userMessage: buildFinalGenerationUserMessage({
      requirement: input.requirement,
      synthesis,
      groundedEvidenceText: finalEvidenceText,
      processTaxonomyEnabled: input.config.processTaxonomyEnabled,
      processCodes: input.config.processTaxonomy,
    }),
    jsonSchema: V2_FINAL_GENERATION_SCHEMA,
    maxTokens: 4200,
    reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.decompositionModel, 'final_generation'),
    validate: validateFinalGeneration,
  });
  addUsage(promptUsage, 'final_generation', finalResponse.usage);

  let generated = finalResponse.data;
  await reportProgress('final_generation', `Drafted ${generated.features.length} feature${generated.features.length === 1 ? '' : 's'} for review…`, {
    stage: 'final_generation',
    message: '',
    draftFeatures: generated.features.map((feature, index) => ({
      id: `draft_${index + 1}`,
      summary: feature.summary,
    })),
    featureCounts: { drafted: generated.features.length },
  });
  let coverage = assessCoverage(generated, synthesis, synthesisEvidencePack);
  if (!coverage.sufficient) {
    await reportProgress('coverage_repair', 'Repairing coverage gaps before finalizing…');
    const repairResponse = await executeStage<V2FinalGenerationResponse>({
      stage: 'coverage_repair',
      model: input.config.generatorConfig.decompositionModel,
      systemPrompt: buildCoverageRepairSystemPrompt(),
      userMessage: buildCoverageRepairUserMessage({
        requirement: input.requirement,
        synthesis,
        generated,
        failures: coverage.failures,
        groundedEvidenceText: renderGroundedEvidencePack(synthesisEvidencePack, 'coverage_repair'),
      }),
      jsonSchema: V2_FINAL_GENERATION_SCHEMA,
      maxTokens: 4200,
      reasoningEffort: stageReasoningEffort(input.config, profile, input.config.generatorConfig.decompositionModel, 'coverage_repair'),
      validate: validateFinalGeneration,
    });
    addUsage(promptUsage, 'coverage_repair', repairResponse.usage);
    generated = repairResponse.data;
    coverage = {
      ...assessCoverage(generated, synthesis, synthesisEvidencePack),
      repaired: true,
    };
  }

  const features = mapGeneratedFeatures(generated.features);
  const reasoning = enrichCapabilityReasoning(
    buildReasoningArtifactFromSynthesis(synthesis, features),
    synthesisEvidencePack,
  );
  const finalScopeHypothesis = enrichScopeHypothesis(
    {
      ...confirmedScopeHypothesis,
      actorSlots: Object.keys(synthesis.actorMap ?? {}).length
        ? synthesis.actorMap
        : confirmedScopeHypothesis.actorSlots,
    },
    synthesisEvidencePack,
    { classifiedAnswers, preserveActorSlots: true },
  );

  await reportProgress('persisting', 'Writing the final backlog draft…');

  return {
    status: 'complete',
    triage,
    scopeHypothesis: finalScopeHypothesis,
    synthesis,
    reasoning,
    features,
    classifiedAnswers,
    discoveryChanges: buildDiscoveryChanges(classifiedAnswers),
    quality: evaluateV2Quality(features),
    coverage,
    promptUsage,
  };
}
