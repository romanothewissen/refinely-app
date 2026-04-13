import {
  ClarifyAnswer,
  ClarifyCategoryKey,
  ClarifyContextMeta,
  ClarifyQuestion,
  ContextSourceMeta,
  DiscoveryAssessment,
  DiscoveryBlueprint,
  DiscoveryComplexityTier,
  DiscoveryProfile,
  DiscoverySessionState,
  DiscoverySufficiencyResult,
  LivingBrief,
  TenantConfig,
  TokenUsageSummary,
  TurnDecision,
} from '../types';
import { getTierModel } from '../services/billing';
import { buildDiscoveryCoverageArtifact, labelForCategoryKey } from './discovery';
import { callLlmJsonWithUsage } from './llm';
import {
  buildAdaptiveDiscoveryBlueprintSystemPrompt,
  buildAdaptiveDiscoveryTurnSystemPrompt,
} from './prompts';
import { formatSimilarStoriesText } from './similar-stories';
import { parseStoryAssistantQuestionCandidates } from './story-assistant-default';

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
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function mergeRequirementAndAttachment(requirement: string, attachmentText?: string): string {
  const cleanedRequirement = cleanText(requirement);
  const cleanedAttachment = String(attachmentText ?? '').trim();
  if (!cleanedAttachment) return cleanedRequirement;
  return `Context from attachment:\n\n${cleanedAttachment}\n\nRequirement: ${cleanedRequirement}`;
}

function formatClarifyAnswers(answers: ClarifyAnswer[]): string {
  if (!answers.length) return '(none)';
  return answers
    .map((answer) => `Q: ${cleanText(answer.question)}\nA: ${cleanText(answer.answer) || '(not answered)'}`)
    .join('\n\n');
}

function clampConfidence(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(1, Math.max(0, Number(numeric)));
}

function inferCategoryKeyFromTopic(value: string): ClarifyCategoryKey {
  const normalized = normalizeKey(value);
  if (/\brole|persona|actor|owner|approval|reviewer|stakeholder\b/.test(normalized)) return 'user_personas';
  if (/\bmetric|measure|success|kpi|outcome|visibility\b/.test(normalized)) return 'success_measurement';
  if (/\bstate|status|transition|lifecycle|reopen|retry|change handling\b/.test(normalized)) return 'state_lifecycle';
  if (/\bflow|sequence|dependency|trigger|handoff|workflow|step|routing\b/.test(normalized)) return 'functional_flow';
  if (/\brule|policy|constraint|validation|duplicate|fallback|billing|contract|exception\b/.test(normalized)) return 'business_rules';
  return 'context_trigger';
}

function normalizeTopicDependency(value: unknown): { topic: string; dependsOn: string[] } | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { topic?: unknown; dependsOn?: unknown };
  const topic = cleanText(raw.topic);
  if (!topic) return null;
  return {
    topic,
    dependsOn: uniqueStrings(Array.isArray(raw.dependsOn) ? raw.dependsOn : []).slice(0, 4),
  };
}

function summarizeObjective(requirement: string): string {
  const normalized = cleanText(requirement);
  if (!normalized) return 'Clarify the requirement enough to generate a strong backlog artifact.';
  const sentence = normalized.split(/(?<=[.?!])\s+/)[0] ?? normalized;
  return trimPromptText(sentence, 140);
}

function detectComplexityTier(text: string): DiscoveryComplexityTier {
  const normalized = text.toLowerCase();
  const signals = [
    /\bworkflow|sequence|handoff|dependency|approval\b/.test(normalized),
    /\bexception|fallback|duplicate|invalid|policy\b/.test(normalized),
    /\bstatus|state|lifecycle|change|modify\b/.test(normalized),
    /\bquote|billing|contract|shipment|work order\b/.test(normalized),
  ].filter(Boolean).length;
  if (signals >= 3) return 'complex';
  if (signals >= 2) return 'standard';
  return 'simple';
}

function fallbackBlueprint(requirement: string, domainRoles: string[] = []): DiscoveryBlueprint {
  const complexityTier = detectComplexityTier(requirement);
  const candidateTopics = complexityTier === 'simple'
    ? ['Trigger', 'Primary actor', 'Core rule']
    : complexityTier === 'complex'
      ? ['Trigger', 'Actors', 'Workflow', 'Business rules', 'State handling', 'Success signals']
      : ['Trigger', 'Actors', 'Workflow', 'Business rules', 'Success signals'];

  return {
    mode: 'adaptive_v1',
    complexityTier,
    persona: domainRoles[0] ? domainRoles[0] : null,
    objective: summarizeObjective(requirement),
    candidateTopics,
    topicDependencies: [
      { topic: 'Workflow', dependsOn: ['Trigger'] },
      { topic: 'Business rules', dependsOn: ['Workflow'] },
      { topic: 'State handling', dependsOn: ['Workflow'] },
    ],
    rankedGaps: [...candidateTopics],
    stopCriteria: [
      'Primary actor and trigger are clear',
      'Core workflow and rule gaps are covered',
      'Remaining uncertainty can be carried as open decisions',
    ],
    ...(complexityTier === 'complex'
      ? {
          branchHints: ['Promote to deeper sequencing or exception questions only if answers expose divergent paths'],
          riskAreas: ['Workflow dependencies', 'Exception handling', 'Approval or policy gates'],
        }
      : {}),
  };
}

function createInitialLivingBrief(blueprint: DiscoveryBlueprint): LivingBrief {
  return {
    persona: blueprint.persona,
    objective: blueprint.objective,
    constraints: [],
    facts: [],
    resolvedTopics: [],
    openTopics: uniqueStrings(blueprint.rankedGaps).slice(0, blueprint.complexityTier === 'simple' ? 3 : 7),
    confidenceByTopic: {},
    summary: blueprint.objective ?? 'Discovery has started.',
    knownUnknowns: uniqueStrings(blueprint.rankedGaps).slice(0, 5),
  };
}

function normalizeConfidenceByTopic(value: unknown): Partial<Record<ClarifyCategoryKey, number>> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: Partial<Record<ClarifyCategoryKey, number>> = {};
  Object.entries(raw).forEach(([key, entryValue]) => {
    const categoryKey = inferCategoryKeyFromTopic(key);
    result[categoryKey] = clampConfidence(entryValue);
  });
  return result;
}

function normalizeLivingBrief(value: unknown, fallback: LivingBrief): LivingBrief {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  return {
    persona: cleanText(raw.persona) || fallback.persona,
    objective: cleanText(raw.objective) || fallback.objective,
    constraints: uniqueStrings(Array.isArray(raw.constraints) ? raw.constraints : fallback.constraints).slice(0, 6),
    facts: uniqueStrings(Array.isArray(raw.facts) ? raw.facts : fallback.facts).slice(0, 12),
    resolvedTopics: uniqueStrings(Array.isArray(raw.resolvedTopics) ? raw.resolvedTopics : fallback.resolvedTopics).slice(0, 8),
    openTopics: uniqueStrings(Array.isArray(raw.openTopics) ? raw.openTopics : fallback.openTopics).slice(0, 8),
    confidenceByTopic: {
      ...fallback.confidenceByTopic,
      ...normalizeConfidenceByTopic(raw.confidenceByTopic),
    },
    summary: cleanText(raw.summary) || fallback.summary,
    knownUnknowns: uniqueStrings(Array.isArray(raw.knownUnknowns) ? raw.knownUnknowns : fallback.knownUnknowns ?? []).slice(0, 6),
  };
}

function normalizeBlueprint(value: unknown, requirement: string, domainRoles: string[] = []): DiscoveryBlueprint {
  const fallback = fallbackBlueprint(requirement, domainRoles);
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const complexityTier = cleanText(raw.complexityTier);
  return {
    mode: 'adaptive_v1',
    complexityTier: complexityTier === 'simple' || complexityTier === 'standard' || complexityTier === 'complex'
      ? complexityTier
      : fallback.complexityTier,
    persona: cleanText(raw.persona) || fallback.persona,
    objective: cleanText(raw.objective) || fallback.objective,
    candidateTopics: uniqueStrings(Array.isArray(raw.candidateTopics) ? raw.candidateTopics : fallback.candidateTopics).slice(0, 7),
    topicDependencies: (Array.isArray(raw.topicDependencies) ? raw.topicDependencies : fallback.topicDependencies)
      .map(normalizeTopicDependency)
      .filter((entry): entry is { topic: string; dependsOn: string[] } => Boolean(entry))
      .slice(0, 7),
    rankedGaps: uniqueStrings(Array.isArray(raw.rankedGaps) ? raw.rankedGaps : fallback.rankedGaps).slice(0, 7),
    stopCriteria: uniqueStrings(Array.isArray(raw.stopCriteria) ? raw.stopCriteria : fallback.stopCriteria).slice(0, 4),
    branchHints: uniqueStrings(Array.isArray(raw.branchHints) ? raw.branchHints : fallback.branchHints ?? []).slice(0, 4),
    riskAreas: uniqueStrings(Array.isArray(raw.riskAreas) ? raw.riskAreas : fallback.riskAreas ?? []).slice(0, 4),
  };
}

function normalizeAdaptiveQuestion(question: ClarifyQuestion | null): ClarifyQuestion | null {
  if (!question) return null;
  const normalizedQuestion = ensureQuestionMark(cleanText(question.question));
  if (!normalizedQuestion) return null;
  const words = normalizedQuestion.split(/\s+/).filter(Boolean);
  const trimmedQuestion = words.length > 18
    ? ensureQuestionMark(words.slice(0, 18).join(' '))
    : normalizedQuestion;
  return {
    ...question,
    question: trimPromptText(trimmedQuestion, 140),
    suggestions: uniqueStrings(question.suggestions ?? []).slice(0, 4),
  };
}

function buildFallbackNextQuestion(brief: LivingBrief, askedQuestions: ClarifyQuestion[]): ClarifyQuestion | null {
  const alreadyAsked = new Set(askedQuestions.map((question) => normalizeKey(question.question)));
  const topic = brief.openTopics.find((candidate) => {
    const prompt = normalizeKey(candidate);
    return prompt && !alreadyAsked.has(prompt);
  }) ?? brief.knownUnknowns?.[0];
  if (!topic) return null;

  const categoryKey = inferCategoryKeyFromTopic(topic);
  const questionText = categoryKey === 'user_personas'
    ? `Who owns ${cleanText(topic).toLowerCase()}?`
    : categoryKey === 'functional_flow'
      ? `What workflow should ${cleanText(topic).toLowerCase()} follow?`
      : categoryKey === 'business_rules'
        ? `Which rule should govern ${cleanText(topic).toLowerCase()}?`
        : categoryKey === 'state_lifecycle'
          ? `How should ${cleanText(topic).toLowerCase()} change over time?`
          : categoryKey === 'success_measurement'
            ? `How will ${cleanText(topic).toLowerCase()} be measured?`
            : `What should happen for ${cleanText(topic).toLowerCase()}?`;

  return {
    categoryKey,
    category: labelForCategoryKey(categoryKey),
    intent: `adaptive_${categoryKey}`,
    question: ensureQuestionMark(questionText),
    suggestions: [],
  };
}

export function buildAdaptiveDiscoveryAssessment(blueprint: DiscoveryBlueprint): DiscoveryAssessment {
  const depth = blueprint.complexityTier === 'complex'
    ? 'deep'
    : blueprint.complexityTier === 'standard'
      ? 'standard'
      : 'light';
  const dimension = blueprint.complexityTier === 'complex'
    ? 'high'
    : blueprint.complexityTier === 'standard'
      ? 'medium'
      : 'low';
  const range = blueprint.complexityTier === 'complex'
    ? { min: 4, max: 6 }
    : blueprint.complexityTier === 'standard'
      ? { min: 2, max: 4 }
      : { min: 1, max: 2 };

  return {
    discoveryDepth: depth,
    reasoningLevel: depth,
    workflowComplexity: dimension,
    actorComplexity: dimension,
    ruleDensity: dimension,
    exceptionDensity: blueprint.complexityTier === 'complex' ? 'high' : blueprint.complexityTier === 'standard' ? 'medium' : 'low',
    lifecycleComplexity: blueprint.complexityTier === 'complex' ? 'high' : blueprint.complexityTier === 'standard' ? 'medium' : 'low',
    ambiguityLevel: blueprint.complexityTier === 'simple' ? 'low' : blueprint.complexityTier === 'standard' ? 'medium' : 'high',
    coverageObligations: uniqueStrings(blueprint.candidateTopics),
    recommendedQuestionRange: range,
    rationale: `Adaptive discovery blueprint selected the ${blueprint.complexityTier} tier.`,
  };
}

export function buildAdaptiveDiscoveryProfile(
  blueprint: DiscoveryBlueprint,
  brief: LivingBrief,
  askedQuestions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
): DiscoveryProfile {
  const missingCategoryKeys = uniqueStrings((brief.openTopics.length ? brief.openTopics : brief.knownUnknowns ?? []).map(inferCategoryKeyFromTopic))
    .map((item) => item as ClarifyCategoryKey);
  const askedCategoryKeys = uniqueStrings(askedQuestions.map((question) => question.categoryKey))
    .map((item) => item as ClarifyCategoryKey);
  const recommendedInitialCount = blueprint.complexityTier === 'complex'
    ? 4
    : blueprint.complexityTier === 'standard'
      ? 3
      : 2;
  const followupCap = blueprint.complexityTier === 'complex'
    ? 3
    : blueprint.complexityTier === 'standard'
      ? 2
      : 1;

  return {
    scope: blueprint.complexityTier === 'complex'
      ? 'broad'
      : blueprint.complexityTier === 'standard'
        ? 'moderate'
        : 'narrow',
    complexity: blueprint.complexityTier === 'complex'
      ? 'high'
      : blueprint.complexityTier === 'standard'
        ? 'medium'
        : 'low',
    ambiguity: brief.openTopics.length > 2 ? 'high' : brief.openTopics.length > 0 ? 'medium' : 'low',
    missingCategoryKeys,
    recommendedInitialCount,
    followupCap,
    plannedQuestionBudget: recommendedInitialCount + followupCap,
    actualQuestionsAsked: askedQuestions.length,
    actualAnswersReceived: answers.length,
    softQuestionBudget: recommendedInitialCount,
    hardQuestionCap: recommendedInitialCount + followupCap,
    coverageArtifact: buildDiscoveryCoverageArtifact({
      missingCategoryKeys,
      plannedQuestionBudget: recommendedInitialCount + followupCap,
      actualQuestionsAsked: askedQuestions.length,
      actualAnswersReceived: answers.length,
      askedCategoryKeys,
      openNonBlockingDecisions: brief.knownUnknowns ?? [],
    }),
  };
}

function buildAdaptiveClarifyContext(input: {
  sourceMeta: ContextSourceMeta;
  state: DiscoverySessionState;
  tokenUsage: TokenUsageSummary;
  finalSufficiency: DiscoverySufficiencyResult;
  fallbackToLegacy?: boolean;
  fallbackReason?: string;
}): ClarifyContextMeta {
  const assessment = buildAdaptiveDiscoveryAssessment(input.state.blueprint);
  const profile = buildAdaptiveDiscoveryProfile(
    input.state.blueprint,
    input.state.livingBrief,
    input.state.askedQuestions,
    input.state.answers,
  );

  return {
    ...input.sourceMeta,
    discoveryMode: 'adaptive_v1',
    discoveryStatus: input.finalSufficiency.evaluated && input.finalSufficiency.sufficient
      ? 'ready_for_generation'
      : 'needs_clarification',
    discoveryBlueprint: input.state.blueprint,
    livingBrief: input.state.livingBrief,
    askedQuestions: input.state.askedQuestions,
    discoveryProfile: profile,
    discoveryAssessment: assessment,
    discoveryDepth: assessment.discoveryDepth,
    reasoningLevel: assessment.reasoningLevel,
    coverageObligations: assessment.coverageObligations,
    recommendedQuestionRange: assessment.recommendedQuestionRange,
    assessmentRationale: assessment.rationale,
    roundsCompleted: input.state.answers.length,
    initialQuestionCount: Math.min(1, input.state.askedQuestions.length),
    followupQuestionCount: Math.max(0, input.state.askedQuestions.length - 1),
    totalQuestionCount: input.state.askedQuestions.length,
    followupTriggered: input.state.askedQuestions.length > 1,
    totalDiscoveryDurationMs: (input.state.plannerDurationMs ?? 0) + (input.state.lastTurnDurationMs ?? 0),
    finalSufficiency: input.finalSufficiency,
    adaptiveDiscovery: {
      enabled: true,
      turnIndex: input.state.turnIndex,
      plannerDurationMs: input.state.plannerDurationMs,
      lastTurnDurationMs: input.state.lastTurnDurationMs,
      fallbackToLegacy: input.fallbackToLegacy,
      fallbackReason: input.fallbackReason,
    },
    tokenUsage: input.tokenUsage,
  };
}

function buildBlueprintUserMessage(input: {
  requirement: string;
  attachmentText?: string;
  wiEvidenceText?: string;
  similarStoriesText?: string;
}): string {
  const parts = [`Requirement: ${trimPromptText(mergeRequirementAndAttachment(input.requirement, input.attachmentText), 7000)}`];
  if (input.wiEvidenceText?.trim()) {
    parts.push(`Operational evidence from Work Instructions:\n${trimPromptText(input.wiEvidenceText, 2600)}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references:\n${trimPromptText(input.similarStoriesText, 2200)}`);
  }
  return parts.join('\n\n');
}

function buildTurnUserMessage(input: {
  requirement: string;
  attachmentText?: string;
  blueprint: DiscoveryBlueprint;
  livingBrief: LivingBrief;
  askedQuestions: ClarifyQuestion[];
  latestAnswers: ClarifyAnswer[];
  wiEvidenceText?: string;
  similarStoriesText?: string;
}): string {
  const parts = [
    `Requirement: ${trimPromptText(mergeRequirementAndAttachment(input.requirement, input.attachmentText), 5000)}`,
    `Blueprint:\n${JSON.stringify(input.blueprint, null, 2)}`,
    `Living brief:\n${JSON.stringify(input.livingBrief, null, 2)}`,
    `Asked questions so far:\n${JSON.stringify(input.askedQuestions.map((question) => ({
      categoryKey: question.categoryKey,
      intent: question.intent,
      question: question.question,
    })), null, 2)}`,
    `Latest answers:\n${formatClarifyAnswers(input.latestAnswers)}`,
  ];

  if (input.wiEvidenceText?.trim()) {
    parts.push(`Operational evidence:\n${trimPromptText(input.wiEvidenceText, 1800)}`);
  }
  if (input.similarStoriesText?.trim()) {
    parts.push(`Relevant backlog references:\n${trimPromptText(input.similarStoriesText, 1200)}`);
  }

  return parts.join('\n\n');
}

function mergeUsage(
  base?: TokenUsageSummary | null,
  next?: TokenUsageSummary | null,
): TokenUsageSummary {
  if (!base && !next) {
    return { input: 0, output: 0, total: 0, byStage: {} };
  }
  if (!base) return next!;
  if (!next) return base;

  const byStage: Record<string, { input: number; output: number; total: number }> = {
    ...(base.byStage ?? {}),
  };
  Object.entries(next.byStage ?? {}).forEach(([stage, usage]) => {
    const existing = byStage[stage];
    byStage[stage] = {
      input: (existing?.input ?? 0) + usage.input,
      output: (existing?.output ?? 0) + usage.output,
      total: (existing?.total ?? 0) + usage.total,
    };
  });

  return {
    input: base.input + next.input,
    output: base.output + next.output,
    total: base.total + next.total,
    byStage,
  };
}

export function isAdaptiveDiscoveryEnabled(config: TenantConfig): boolean {
  return Boolean(config.developerTools?.adaptiveDiscoveryEnabled);
}

export function formatAdaptiveDiscoveryBacklogEvidence(similarStories: Array<{ key: string; summary: string }> = []): string {
  if (!similarStories.length) return '';
  return trimPromptText(formatSimilarStoriesText(similarStories as any, 3), 3200);
}

export async function planAdaptiveDiscovery(input: {
  requirement: string;
  attachmentText?: string;
  wiEvidenceText?: string;
  similarStoriesText?: string;
  config: TenantConfig;
}): Promise<{ blueprint: DiscoveryBlueprint; tokenUsage: TokenUsageSummary; promptAssemblyMs: number }> {
  const promptAssemblyStartedAt = Date.now();
  const userMessage = buildBlueprintUserMessage(input);
  const promptAssemblyMs = Date.now() - promptAssemblyStartedAt;
  const providerOpts = {
    provider: input.config.generatorConfig.provider,
    geminiApiKey: input.config.generatorConfig.geminiApiKey,
    geminiBaseUrl: input.config.generatorConfig.geminiBaseUrl,
    openaiApiKey: input.config.generatorConfig.openaiApiKey,
    openaiBaseUrl: input.config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: input.config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: input.config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: input.config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: input.config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(input.config.compliance?.enabled && input.config.compliance?.piiMaskingEnabled),
  } as const;

  try {
    const result = await callLlmJsonWithUsage<unknown>({
      model: getTierModel(input.config.generatorConfig.evaluateModel, input.config.tier),
      systemPrompt: buildAdaptiveDiscoveryBlueprintSystemPrompt({
        domainContext: input.config.domainContext,
        domainRoles: input.config.domainRoles,
      }),
      userMessage,
      maxTokens: 1200,
      reasoningEffort: 'low',
      ...providerOpts,
    });
    return {
      blueprint: normalizeBlueprint(result.data, input.requirement, input.config.domainRoles),
      tokenUsage: {
        input: result.usage.input,
        output: result.usage.output,
        total: result.usage.input + result.usage.output,
        byStage: {
          planner: {
            input: result.usage.input,
            output: result.usage.output,
            total: result.usage.input + result.usage.output,
          },
        },
      },
      promptAssemblyMs,
    };
  } catch {
    return {
      blueprint: fallbackBlueprint(input.requirement, input.config.domainRoles),
      tokenUsage: { input: 0, output: 0, total: 0, byStage: {} },
      promptAssemblyMs,
    };
  }
}

export async function advanceAdaptiveDiscovery(input: {
  requirement: string;
  attachmentText?: string;
  state: DiscoverySessionState;
  latestAnswers: ClarifyAnswer[];
  config: TenantConfig;
}): Promise<{ decision: TurnDecision; tokenUsage: TokenUsageSummary; promptAssemblyMs: number }> {
  const providerOpts = {
    provider: input.config.generatorConfig.provider,
    geminiApiKey: input.config.generatorConfig.geminiApiKey,
    geminiBaseUrl: input.config.generatorConfig.geminiBaseUrl,
    openaiApiKey: input.config.generatorConfig.openaiApiKey,
    openaiBaseUrl: input.config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: input.config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: input.config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: input.config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: input.config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(input.config.compliance?.enabled && input.config.compliance?.piiMaskingEnabled),
  } as const;

  const attemptMessages = [
    buildTurnUserMessage({
      requirement: input.requirement,
      attachmentText: input.attachmentText,
      blueprint: input.state.blueprint,
      livingBrief: input.state.livingBrief,
      askedQuestions: input.state.askedQuestions,
      latestAnswers: input.latestAnswers,
      wiEvidenceText: input.state.wiEvidenceText,
      similarStoriesText: input.state.similarStoriesText,
    }),
    buildTurnUserMessage({
      requirement: input.requirement,
      attachmentText: input.attachmentText,
      blueprint: input.state.blueprint,
      livingBrief: {
        ...input.state.livingBrief,
        facts: input.state.livingBrief.facts.slice(-6),
        openTopics: input.state.livingBrief.openTopics.slice(0, 4),
        knownUnknowns: input.state.livingBrief.knownUnknowns?.slice(0, 3),
      },
      askedQuestions: input.state.askedQuestions.slice(-4),
      latestAnswers: input.latestAnswers,
      wiEvidenceText: trimPromptText(input.state.wiEvidenceText ?? '', 1000),
      similarStoriesText: trimPromptText(input.state.similarStoriesText ?? '', 800),
    }),
  ];

  let promptAssemblyMs = 0;
  let aggregateUsage: TokenUsageSummary | null = null;

  for (const [attemptIndex, userMessage] of attemptMessages.entries()) {
    const promptAssemblyStartedAt = Date.now();
    promptAssemblyMs += Date.now() - promptAssemblyStartedAt;
    try {
      const result = await callLlmJsonWithUsage<unknown>({
        model: getTierModel(input.config.generatorConfig.evaluateModel, input.config.tier),
        systemPrompt: buildAdaptiveDiscoveryTurnSystemPrompt({
          domainContext: input.config.domainContext,
          domainRoles: input.config.domainRoles,
        }),
        userMessage,
        maxTokens: 1200,
        reasoningEffort: 'low',
        ...providerOpts,
      });
      aggregateUsage = mergeUsage(aggregateUsage, {
        input: result.usage.input,
        output: result.usage.output,
        total: result.usage.input + result.usage.output,
        byStage: {
          [`adaptiveTurn${attemptIndex + 1}`]: {
            input: result.usage.input,
            output: result.usage.output,
            total: result.usage.input + result.usage.output,
          },
        },
      });

      const payload = (result.data && typeof result.data === 'object') ? result.data as Record<string, unknown> : {};
      const updatedBrief = normalizeLivingBrief(payload.updatedBrief, input.state.livingBrief);
      const normalizedQuestion = normalizeAdaptiveQuestion(
        parseStoryAssistantQuestionCandidates(payload.nextQuestion ? { questions: [payload.nextQuestion] } : payload).slice(0, 1)[0] ?? null,
      );
      const promotedComplexityTier = cleanText(payload.promotedComplexityTier);
      const isSufficient = payload.isSufficient === true || (!normalizedQuestion && updatedBrief.openTopics.length === 0);
      const decision: TurnDecision = {
        isSufficient,
        nextQuestion: isSufficient ? null : (normalizedQuestion ?? buildFallbackNextQuestion(updatedBrief, input.state.askedQuestions)),
        updatedBrief,
        ...(promotedComplexityTier === 'simple' || promotedComplexityTier === 'standard' || promotedComplexityTier === 'complex'
          ? { promotedComplexityTier }
          : {}),
        ...(payload.shouldFallback === true ? { shouldFallback: true, fallbackReason: cleanText(payload.fallbackReason) || 'Adaptive discovery requested fallback.' } : {}),
      };

      if (decision.isSufficient || decision.nextQuestion || decision.shouldFallback) {
        return {
          decision,
          tokenUsage: aggregateUsage ?? { input: 0, output: 0, total: 0, byStage: {} },
          promptAssemblyMs,
        };
      }
    } catch {
      // Allow one tighter retry before falling back.
    }
  }

  const fallbackDecision: TurnDecision = {
    isSufficient: input.state.livingBrief.openTopics.length === 0,
    nextQuestion: buildFallbackNextQuestion(input.state.livingBrief, input.state.askedQuestions),
    updatedBrief: input.state.livingBrief,
    shouldFallback: input.state.livingBrief.openTopics.length > 0 && !buildFallbackNextQuestion(input.state.livingBrief, input.state.askedQuestions),
    fallbackReason: input.state.livingBrief.openTopics.length > 0
      ? 'Adaptive discovery could not compute a reliable next question.'
      : undefined,
  };

  return {
    decision: fallbackDecision,
    tokenUsage: aggregateUsage ?? { input: 0, output: 0, total: 0, byStage: {} },
    promptAssemblyMs,
  };
}

export async function initializeAdaptiveDiscoverySession(input: {
  sessionId: string;
  requirement: string;
  attachmentText?: string;
  wiEvidenceText?: string;
  similarStoriesText?: string;
  sourceMeta: ContextSourceMeta;
  config: TenantConfig;
}): Promise<{
  state: DiscoverySessionState;
  nextQuestion: ClarifyQuestion | null;
  clarifyContext: ClarifyContextMeta;
  tokenUsage: TokenUsageSummary;
  promptAssemblyMs: number;
}> {
  const plannedAt = Date.now();
  const planned = await planAdaptiveDiscovery({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    wiEvidenceText: input.wiEvidenceText,
    similarStoriesText: input.similarStoriesText,
    config: input.config,
  });
  const blueprint = planned.blueprint;
  const initialState: DiscoverySessionState = {
    sessionId: input.sessionId,
    mode: 'adaptive_v1',
    blueprint,
    livingBrief: createInitialLivingBrief(blueprint),
    askedQuestions: [],
    answers: [],
    turnIndex: 0,
    sourceMeta: input.sourceMeta,
    wiEvidenceText: input.wiEvidenceText,
    similarStoriesText: input.similarStoriesText,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    plannerDurationMs: Date.now() - plannedAt,
    fallbackCount: 0,
  };

  const advanced = await advanceAdaptiveDiscovery({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    state: initialState,
    latestAnswers: [],
    config: input.config,
  });

  const nextState: DiscoverySessionState = {
    ...initialState,
    livingBrief: advanced.decision.updatedBrief,
    askedQuestions: advanced.decision.nextQuestion ? [advanced.decision.nextQuestion] : [],
    updatedAt: new Date().toISOString(),
    lastTurnDurationMs: advanced.promptAssemblyMs,
  };

  const finalSufficiency: DiscoverySufficiencyResult = {
    evaluated: advanced.decision.isSufficient,
    sufficient: advanced.decision.isSufficient,
    status: advanced.decision.isSufficient ? 'ready_to_generate' : 'ask_followup',
    roundEvaluated: 0,
    missingCategoryKeys: buildAdaptiveDiscoveryProfile(blueprint, nextState.livingBrief, nextState.askedQuestions, []).missingCategoryKeys,
    reasonCodes: advanced.decision.isSufficient ? [] : ['ADAPTIVE_DISCOVERY_INCOMPLETE'],
  };

  return {
    state: nextState,
    nextQuestion: advanced.decision.nextQuestion,
    clarifyContext: buildAdaptiveClarifyContext({
      sourceMeta: input.sourceMeta,
      state: nextState,
      tokenUsage: mergeUsage(planned.tokenUsage, advanced.tokenUsage),
      finalSufficiency,
      fallbackToLegacy: advanced.decision.shouldFallback,
      fallbackReason: advanced.decision.fallbackReason,
    }),
    tokenUsage: mergeUsage(planned.tokenUsage, advanced.tokenUsage),
    promptAssemblyMs: planned.promptAssemblyMs + advanced.promptAssemblyMs,
  };
}

export async function continueAdaptiveDiscoverySession(input: {
  requirement: string;
  attachmentText?: string;
  state: DiscoverySessionState;
  latestAnswers: ClarifyAnswer[];
  config: TenantConfig;
}): Promise<{
  state: DiscoverySessionState;
  nextQuestion: ClarifyQuestion | null;
  clarifyContext: ClarifyContextMeta;
  tokenUsage: TokenUsageSummary;
  decision: TurnDecision;
}> {
  const turnStartedAt = Date.now();
  const mergedAnswers = [...input.state.answers, ...input.latestAnswers];
  const workingState: DiscoverySessionState = {
    ...input.state,
    answers: mergedAnswers,
    updatedAt: new Date().toISOString(),
  };

  const advanced = await advanceAdaptiveDiscovery({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    state: workingState,
    latestAnswers: input.latestAnswers,
    config: input.config,
  });

  let blueprint = workingState.blueprint;
  if (advanced.decision.promotedComplexityTier && advanced.decision.promotedComplexityTier !== workingState.blueprint.complexityTier) {
    blueprint = {
      ...workingState.blueprint,
      complexityTier: advanced.decision.promotedComplexityTier,
    };
  }

  const nextAskedQuestions = advanced.decision.nextQuestion
    ? [...workingState.askedQuestions, advanced.decision.nextQuestion]
    : workingState.askedQuestions;

  const nextState: DiscoverySessionState = {
    ...workingState,
    blueprint,
    livingBrief: advanced.decision.updatedBrief,
    askedQuestions: nextAskedQuestions,
    turnIndex: workingState.turnIndex + input.latestAnswers.length,
    updatedAt: new Date().toISOString(),
    lastTurnDurationMs: Date.now() - turnStartedAt,
    fallbackCount: workingState.fallbackCount + (advanced.decision.shouldFallback ? 1 : 0),
  };

  const nextProfile = buildAdaptiveDiscoveryProfile(blueprint, nextState.livingBrief, nextState.askedQuestions, nextState.answers);
  const finalSufficiency: DiscoverySufficiencyResult = {
    evaluated: true,
    sufficient: advanced.decision.isSufficient,
    status: advanced.decision.isSufficient
      ? 'ready_to_generate'
      : advanced.decision.nextQuestion
        ? 'ask_followup'
        : 'ready_with_open_decisions',
    roundEvaluated: nextState.turnIndex,
    missingCategoryKeys: nextProfile.missingCategoryKeys,
    reasonCodes: advanced.decision.isSufficient ? [] : ['ADAPTIVE_DISCOVERY_INCOMPLETE'],
  };

  return {
    state: nextState,
    nextQuestion: advanced.decision.nextQuestion,
    clarifyContext: buildAdaptiveClarifyContext({
      sourceMeta: input.state.sourceMeta,
      state: nextState,
      tokenUsage: advanced.tokenUsage,
      finalSufficiency,
      fallbackToLegacy: advanced.decision.shouldFallback,
      fallbackReason: advanced.decision.fallbackReason,
    }),
    tokenUsage: advanced.tokenUsage,
    decision: advanced.decision,
  };
}
