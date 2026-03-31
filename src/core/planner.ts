import {
  AiExecutionPolicy,
  ArPlan,
  ClarificationMode,
  ClarifyAnswer,
  ClarifyQuestionPlan,
  FeaturePlan,
  OutputMode,
  PlannerDecision,
  ReasoningMode,
  ScopeMode,
  TenantConfig,
} from '../types';
import { callLlmJsonWithUsage } from './llm';
import { getTierModel } from '../services/billing';

interface PlannerInput {
  requirement: string;
  attachmentText?: string;
  wiContextText?: string;
  goldExamplesText?: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
  config?: TenantConfig;
  policy?: Pick<
    AiExecutionPolicy,
    'simpleAskMaxQuestions' | 'deepModeRoundTarget' | 'enterpriseMaxQuestionsPerRound'
  >;
}

interface PlannerAssessmentResult {
  clarity: 'clear' | 'medium' | 'vague';
  complexity: 'low' | 'medium' | 'high';
  scopeMode: ScopeMode;
  clarificationMode: ClarificationMode;
  confidence: number;
  reasons: string[];
}

const SCOPE_ORDER: ScopeMode[] = ['atomic', 'focused', 'standard', 'initiative'];
const CLARITY_ORDER: Array<ClarifyQuestionPlan['clarity']> = ['clear', 'medium', 'vague'];
const COMPLEXITY_ORDER: Array<FeaturePlan['complexity']> = ['low', 'medium', 'high'];
const CLARIFICATION_ORDER: ClarificationMode[] = ['none', 'light', 'standard', 'deep'];

function buildPlannerAssessmentPrompt(): string {
  return `You are a universal planning engine for turning a product request into the right discovery and backlog strategy.

Assess the request based on structural signals only:
- ambiguity
- branching decisions
- external dependencies
- number of interacting steps
- number of possible outcomes
- missing business rules
- scope breadth

Do not rely on domain-specific role names, industry jargon, or organization-specific terminology as a shortcut for complexity.

Return strict JSON only in this shape:
{
  "clarity": "clear | medium | vague",
  "complexity": "low | medium | high",
  "scopeMode": "atomic | focused | standard | initiative",
  "clarificationMode": "none | light | standard | deep",
  "confidence": 0.0,
  "reasons": ["short reason", "short reason"]
}`;
}

function getPlannerProviderOpts(config: TenantConfig) {
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

function buildPlannerAssessmentUserMessage(input: PlannerInput): string {
  const contextNotes = [
    `Reasoning mode preference: ${input.reasoningMode ?? 'fast'}`,
    `Output mode preference: ${input.outputMode ?? 'auto'}`,
    `Attachment provided: ${Boolean(input.attachmentText?.trim())}`,
    `Work-instruction context available: ${Boolean(input.wiContextText?.trim())}`,
    `Reference examples available: ${Boolean(input.goldExamplesText?.trim())}`,
    `Similar stories available: ${Boolean(input.similarStoriesText?.trim())}`,
    `Existing clarification answers: ${input.clarifyAnswers?.length ?? 0}`,
  ];

  const sections = [
    `REQUEST:\n${(input.requirement ?? '').trim()}`,
    `CONTEXT SNAPSHOT:\n${contextNotes.join('\n')}`,
  ];

  if (input.clarifyAnswers?.length) {
    sections.push(
      `EXISTING ANSWERS:\n${input.clarifyAnswers
        .slice(0, 6)
        .map((answer) => `Q: ${answer.question}\nA: ${answer.answer}`)
        .join('\n\n')}`,
    );
  }

  return sections.join('\n\n---\n\n');
}

function toAmbiguityScore(clarity: ClarifyQuestionPlan['clarity']): number {
  if (clarity === 'clear') return 1;
  if (clarity === 'medium') return 3;
  return 5;
}

function clampConfidence(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, 0.25), 0.99);
}

function normaliseAssessment(
  raw: unknown,
  fallback: PlannerDecision,
): PlannerAssessmentResult {
  const data = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
  const clarity = data.clarity === 'clear' || data.clarity === 'medium' || data.clarity === 'vague'
    ? data.clarity
    : fallback.questionPlan.clarity;
  const complexity = data.complexity === 'low' || data.complexity === 'medium' || data.complexity === 'high'
    ? data.complexity
    : fallback.featurePlan.complexity;
  const scopeMode = data.scopeMode === 'atomic' || data.scopeMode === 'focused' || data.scopeMode === 'standard' || data.scopeMode === 'initiative'
    ? data.scopeMode
    : fallback.scopeMode;
  const clarificationMode = data.clarificationMode === 'none' || data.clarificationMode === 'light' || data.clarificationMode === 'standard' || data.clarificationMode === 'deep'
    ? data.clarificationMode
    : fallback.clarificationMode;
  const reasons = Array.isArray(data.reasons)
    ? data.reasons.map((reason) => String(reason ?? '').trim()).filter(Boolean).slice(0, 5)
    : fallback.rationale.slice(0, 5);

  return {
    clarity,
    complexity,
    scopeMode,
    clarificationMode,
    confidence: clampConfidence(data.confidence, fallback.confidence),
    reasons,
  };
}

export async function buildPlannerDecision(input: PlannerInput): Promise<PlannerDecision> {
  const heuristicDecision = buildHeuristicPlannerDecision(input);
  const config = input.config;
  const reasoningMode = input.reasoningMode ?? heuristicDecision.reasoningMode;
  if (!config || !input.requirement?.trim()) {
    return heuristicDecision;
  }

  if (reasoningMode === 'fast') {
    return heuristicDecision;
  }

  try {
    const assessment = normaliseAssessment(
      (
        await callLlmJsonWithUsage<PlannerAssessmentResult>({
          model: getTierModel(config.generatorConfig.evaluateModel, config.tier),
          systemPrompt: buildPlannerAssessmentPrompt(),
          userMessage: buildPlannerAssessmentUserMessage(input),
          maxTokens: 1200,
          ...getPlannerProviderOpts(config),
        })
      ).data,
      heuristicDecision,
    );
    const conservativeClarity = CLARITY_ORDER[
      Math.max(
        CLARITY_ORDER.indexOf(heuristicDecision.questionPlan.clarity),
        CLARITY_ORDER.indexOf(assessment.clarity),
      )
    ];
    const conservativeComplexity = COMPLEXITY_ORDER[
      Math.max(
        COMPLEXITY_ORDER.indexOf(heuristicDecision.featurePlan.complexity),
        COMPLEXITY_ORDER.indexOf(assessment.complexity),
      )
    ];
    const conservativeClarificationMode = CLARIFICATION_ORDER[
      Math.max(
        CLARIFICATION_ORDER.indexOf(heuristicDecision.clarificationMode),
        CLARIFICATION_ORDER.indexOf(assessment.clarificationMode),
      )
    ];
    const conservativeScopeMode = SCOPE_ORDER[
      Math.max(
        SCOPE_ORDER.indexOf(heuristicDecision.scopeMode),
        SCOPE_ORDER.indexOf(assessment.scopeMode),
      )
    ];

    const resolvedScopeMode =
      (input.outputMode ?? heuristicDecision.outputMode) === 'single'
        ? 'atomic'
        : (input.outputMode ?? heuristicDecision.outputMode) === 'full_breakdown' && conservativeScopeMode === 'atomic'
          ? 'focused'
          : conservativeScopeMode;

    const featurePlan = buildFeaturePlan(
      resolvedScopeMode,
      conservativeComplexity,
      input.outputMode ?? heuristicDecision.outputMode,
      reasoningMode,
    );
    const questionPlan = buildQuestionPlan(
      conservativeClarificationMode,
      conservativeClarity,
      input.policy,
    );
    const rationale = Array.from(new Set([
      ...heuristicDecision.rationale,
      ...assessment.reasons,
    ])).slice(0, 5);
    if (resolvedScopeMode !== conservativeScopeMode) {
      rationale.push(
        (input.outputMode ?? heuristicDecision.outputMode) === 'single'
          ? 'Output override keeps the result to a single-feature scope.'
          : 'Output override broadens the result beyond an atomic scope.',
      );
    }

    return {
      reasoningMode,
      outputMode: input.outputMode ?? heuristicDecision.outputMode,
      scopeMode: resolvedScopeMode,
      clarificationMode: conservativeClarificationMode,
      questionPlan,
      featurePlan,
      arPlan: buildArPlan(resolvedScopeMode, conservativeComplexity),
      useHierarchy: resolvedScopeMode === 'initiative',
      confidence: Math.min(assessment.confidence, heuristicDecision.confidence),
      ambiguityScore: Math.max(heuristicDecision.ambiguityScore, toAmbiguityScore(conservativeClarity)),
      ambiguityReasons: Array.from(new Set([
        ...heuristicDecision.ambiguityReasons,
        ...assessment.reasons,
      ])).slice(0, 5),
      rationale: rationale.slice(0, 5),
    };
  } catch (error) {
    console.warn('[planner] Falling back to heuristic planner decision:', error);
    return heuristicDecision;
  }
}

function buildHeuristicPlannerDecision(input: PlannerInput): PlannerDecision {
  const requirement = input.requirement?.trim() ?? '';
  const attachment = input.attachmentText?.trim() ?? '';
  const wi = input.wiContextText?.trim() ?? '';
  const gold = input.goldExamplesText?.trim() ?? '';
  const similar = input.similarStoriesText?.trim() ?? '';
  const answers = input.clarifyAnswers ?? [];
  const reasoningMode = input.reasoningMode ?? 'fast';
  const outputMode = input.outputMode ?? 'auto';
  const policy = input.policy;

  const reqWords = requirement ? requirement.split(/\s+/).length : 0;
  const reqSentences = requirement
    ? requirement.split(/[.!?]\s+/).map((s) => s.trim()).filter(Boolean).length
    : 0;

  const hasRichContext =
    attachment.length > 250 ||
    wi.length > 250 ||
    gold.length > 250 ||
    similar.length > 250 ||
    answers.length >= 3;

  const hasConstraints = /(must|should|cannot|can't|only|except|unless|sla|kpi|compliance|permission|role|workflow|edge case|error|fallback|validation|audit|security|approval|policy|governance)/i
    .test(requirement);
  const hasAmbiguousTokens = /(something|somehow|etc|and so on|kind of|maybe|improve|optimi[sz]e|optimal|better|faster|enhance|fix this|update this|handle this|do it)/i
    .test(requirement);
  const hasBroadScopeSignals = /(and|also|plus|across|multiple|several|various|different|complex|including|workflow|end[- ]to[- ]end|dashboard|reporting|notification|approval|integration|sync|assignment|prioritization|exception|rollout|migration|program|portfolio|operating model)/i
    .test(requirement);
  const hasEnterpriseSignals = /(enterprise|compliance|audit|governance|permission matrix|cross[- ]functional|cross[- ]team|multiple teams|multiple departments|multiple business units|regional|global rollout)/i
    .test(requirement);
  const hasAutomationSignal = /\b(auto(?:matic|mated|matically)?|trigger(?:ed)?|upon|when)\b/i
    .test(requirement);
  const hasSourceSignal = /\b(from|via|received|submitted|captured|generated from|created from|incoming)\b/i
    .test(requirement);
  const hasDecisionSignal = /\b(if|whether|based on|determine|identify|distinguish|decide)\b/i
    .test(requirement);
  const hasAlternativeOutcomeSignal = /\bor\b/i.test(requirement);
  const listSeparatorCount = (requirement.match(/,/g) ?? []).length;
  const hasEnumerationSignal = /\b(including|such as|for example|e\.g\.)\b/i.test(requirement);
  const hasComplexityLanguageSignal = /\b(complex|various|different|multi[- ]step|multi[- ]scenario)\b/i.test(requirement);
  const hasMultiScenarioSignal =
    hasEnumerationSignal ||
    listSeparatorCount >= 2 ||
    /\betc\b/i.test(requirement);
  const actorMentions =
    (requirement.match(/\bas\s+a[n]?\s+[a-z0-9][a-z0-9\s/-]{0,40}/ig) ?? []).length +
    (requirement.match(/\b(?:used by|visible to|assigned to|owned by)\s+[a-z0-9][a-z0-9\s/-]{0,40}/ig) ?? []).length;
  const exceptionMentions = (requirement.match(/\b(error|fail|exception|edge|invalid|conflict|fallback|retry|permission|duplicate|rollback|escalat)\w*\b/ig) ?? []).length;
  const integrationMentions = (requirement.match(/\b(integration|sync|import|export|api|feed|data source|vendor|webhook|endpoint|queue|channel)\b/ig) ?? []).length;
  const workflowVerbMentions = (requirement.match(/\b(create|update|route|assign|determine|identify|validate|notify|sync|extract|parse|match|link|classif(?:y|ication)|categori[sz](?:e|ation))\b/ig) ?? []).length;

  const ambiguityScore =
    (reqWords <= 20 ? 1 : 0) +
    (reqSentences <= 1 ? 1 : 0) +
    (hasAmbiguousTokens ? 1 : 0) +
    (!hasRichContext ? 1 : 0) +
    (actorMentions === 0 ? 1 : 0) +
    (exceptionMentions === 0 ? 1 : 0) -
    (hasConstraints ? 1 : 0) +
    (hasAutomationSignal && hasDecisionSignal && answers.length === 0 ? 1 : 0) +
    (hasMultiScenarioSignal && exceptionMentions === 0 ? 1 : 0);

  const clarity: ClarifyQuestionPlan['clarity'] =
    ambiguityScore <= 1 ? 'clear' : ambiguityScore >= 4 ? 'vague' : 'medium';

  const breadthScore =
    (hasBroadScopeSignals ? 1 : 0) +
    (hasEnterpriseSignals ? 1 : 0) +
    (reqWords >= 55 ? 1 : 0) +
    (reqSentences >= 3 ? 1 : 0) +
    (actorMentions >= 2 ? 1 : 0) +
    (integrationMentions >= 1 ? 1 : 0) +
    (hasAutomationSignal && hasSourceSignal ? 1 : 0) +
    (hasDecisionSignal && hasAlternativeOutcomeSignal ? 1 : 0) +
    (hasMultiScenarioSignal ? 1 : 0) +
    (hasComplexityLanguageSignal ? 1 : 0) +
    (workflowVerbMentions >= 2 ? 1 : 0) +
    (answers.length >= 4 ? 1 : 0);

  const complexityScore =
    (hasConstraints ? 1 : 0) +
    (exceptionMentions >= 2 ? 1 : 0) +
    (actorMentions >= 2 ? 1 : 0) +
    (integrationMentions >= 1 ? 1 : 0) +
    (hasAutomationSignal && hasSourceSignal ? 1 : 0) +
    (hasDecisionSignal && hasAlternativeOutcomeSignal ? 1 : 0) +
    (hasMultiScenarioSignal ? 1 : 0) +
    (hasComplexityLanguageSignal ? 1 : 0) +
    (workflowVerbMentions >= 2 ? 1 : 0) +
    (hasEnterpriseSignals ? 1 : 0) +
    (answers.length >= 4 ? 1 : 0);

  let scopeMode: ScopeMode;
  if (outputMode === 'single') {
    scopeMode = 'atomic';
  } else if (
    reqWords <= 24 &&
    reqSentences <= 2 &&
    !hasBroadScopeSignals &&
    !hasEnterpriseSignals &&
    integrationMentions === 0 &&
    complexityScore <= 1 &&
    !hasAmbiguousTokens
  ) {
    scopeMode = 'atomic';
  } else if (hasEnterpriseSignals || breadthScore >= 5) {
    scopeMode = 'initiative';
  } else if (breadthScore >= 3) {
    scopeMode = 'standard';
  } else {
    scopeMode = 'focused';
  }

  if (outputMode === 'full_breakdown') {
    if (scopeMode === 'atomic') scopeMode = 'focused';
    else if (scopeMode === 'focused' && (breadthScore >= 2 || complexityScore >= 2)) scopeMode = 'standard';
  }

  const complexity: FeaturePlan['complexity'] =
    complexityScore >= 4 ? 'high' : complexityScore >= 2 ? 'medium' : 'low';

  const featurePlan = buildFeaturePlan(scopeMode, complexity, outputMode, reasoningMode);
  const clarificationMode = pickClarificationMode(scopeMode, clarity, reasoningMode, complexityScore);
  const questionPlan = buildQuestionPlan(clarificationMode, clarity, policy);
  const arPlan = buildArPlan(scopeMode, complexity);

  const rationale: string[] = [];
  if (scopeMode === 'atomic') rationale.push('Request appears narrow enough for a single well-scoped feature.');
  if (scopeMode === 'initiative') rationale.push('Request appears broad enough to require an initiative-style breakdown.');
  if (hasBroadScopeSignals) rationale.push('Requirement contains broad scope signals spanning multiple capabilities.');
  if (hasEnterpriseSignals) rationale.push('Requirement contains enterprise delivery or governance signals.');
  if (hasMultiScenarioSignal) rationale.push('Requirement includes multiple scenarios or activity variants that increase discovery needs.');
  if (hasComplexityLanguageSignal) rationale.push('Requirement explicitly indicates complexity and likely hidden business rules.');
  if (integrationMentions >= 1) rationale.push('Integrations or external data dependencies are implied.');
  if (hasAutomationSignal && hasDecisionSignal) rationale.push('Request includes automation plus branching decisions, which usually needs business-rule discovery.');
  if (!hasRichContext) rationale.push('Available context is still thin, so discovery should stay adaptive.');
  if (answers.length >= 3) rationale.push('Prior clarifying answers already provide meaningful planning context.');
  if (outputMode === 'single') rationale.push('User requested a single-feature output.');
  if (outputMode === 'full_breakdown') rationale.push('User requested a fuller decomposition of the requirement.');
  if (reasoningMode === 'deep') rationale.push('Deep reasoning mode allows more discovery before generation.');

  const confidence = Math.max(
    0.45,
    Math.min(
      0.95,
      0.72 +
        (hasRichContext ? 0.08 : 0) +
        (answers.length >= 3 ? 0.05 : 0) -
        Math.max(ambiguityScore, 0) * 0.05,
    ),
  );

  return {
    reasoningMode,
    outputMode,
    scopeMode,
    clarificationMode,
    questionPlan,
    featurePlan,
    arPlan,
    useHierarchy: scopeMode === 'initiative',
    confidence,
    ambiguityScore: Math.max(0, ambiguityScore),
    ambiguityReasons: buildAmbiguityReasons({
      reqWords,
      reqSentences,
      hasRichContext,
      hasBroadScopeSignals,
      roleMentions: actorMentions,
      exceptionMentions,
      hasConstraints,
      hasAmbiguousTokens,
    }),
    rationale: rationale.slice(0, 5),
  };
}

function buildFeaturePlan(
  scopeMode: ScopeMode,
  complexity: FeaturePlan['complexity'],
  outputMode: OutputMode,
  reasoningMode: ReasoningMode,
): FeaturePlan {
  if (scopeMode === 'atomic') {
    return { min: 1, max: 1, target: 1, shape: 'narrow', complexity };
  }

  if (scopeMode === 'focused') {
    return {
      min: 2,
      max: 4,
      target: outputMode === 'full_breakdown' || reasoningMode === 'deep' ? 4 : 3,
      shape: 'narrow',
      complexity,
    };
  }

  if (scopeMode === 'initiative') {
    return {
      min: 7,
      max: 10,
      target: reasoningMode === 'deep' ? 9 : 8,
      shape: 'broad',
      complexity: 'high',
    };
  }

  return {
    min: 4,
    max: 7,
    target: reasoningMode === 'deep' || outputMode === 'full_breakdown' ? 6 : 5,
    shape: 'balanced',
    complexity,
  };
}

function pickClarificationMode(
  scopeMode: ScopeMode,
  clarity: ClarifyQuestionPlan['clarity'],
  reasoningMode: ReasoningMode,
  complexityScore: number,
): ClarificationMode {
  if (scopeMode === 'atomic' && clarity === 'clear' && reasoningMode === 'fast') {
    return 'none';
  }

  if (scopeMode === 'atomic') {
    return reasoningMode === 'deep' || clarity !== 'clear' ? 'light' : 'none';
  }

  if (scopeMode === 'focused') {
    if (reasoningMode === 'deep' || clarity === 'vague' || complexityScore >= 2) return 'standard';
    return 'light';
  }

  if (scopeMode === 'initiative') {
    return reasoningMode === 'deep' || clarity !== 'clear' ? 'deep' : 'standard';
  }

  if (reasoningMode === 'deep' || clarity === 'vague' || complexityScore >= 2) return 'deep';
  return 'standard';
}

function buildQuestionPlan(
  clarificationMode: ClarificationMode,
  clarity: ClarifyQuestionPlan['clarity'],
  policy?: Pick<
    AiExecutionPolicy,
    'simpleAskMaxQuestions' | 'deepModeRoundTarget' | 'enterpriseMaxQuestionsPerRound'
  >,
): ClarifyQuestionPlan {
  const lightMax = clamp(policy?.simpleAskMaxQuestions ?? 2, 1, 4);
  const standardMax = clamp(
    Math.max(lightMax + 2, policy?.deepModeRoundTarget ?? 5),
    3,
    8,
  );
  const deepMax = clamp(
    Math.max(standardMax, policy?.enterpriseMaxQuestionsPerRound ?? 7),
    4,
    12,
  );

  if (clarificationMode === 'none') return { min: 0, max: 0, target: 0, clarity };
  if (clarificationMode === 'light') {
    return {
      min: clarity === 'clear' ? 0 : 1,
      max: lightMax,
      target: clarity === 'clear' ? Math.min(1, lightMax) : Math.min(Math.max(2, lightMax), lightMax),
      clarity,
    };
  }
  if (clarificationMode === 'standard') {
    return {
      min: Math.min(2, standardMax),
      max: standardMax,
      target: clarity === 'clear' ? Math.min(3, standardMax) : Math.min(4, standardMax),
      clarity,
    };
  }
  return {
    min: Math.min(4, deepMax),
    max: deepMax,
    target: clarity === 'vague'
      ? deepMax
      : Math.min(Math.max(5, policy?.deepModeRoundTarget ?? 5), deepMax),
    clarity,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function buildArPlan(
  scopeMode: ScopeMode,
  complexity: FeaturePlan['complexity'],
): ArPlan {
  if (scopeMode === 'atomic' && complexity === 'low') {
    return { min: 2, max: 3, target: 2, depth: 'lean' };
  }

  if (scopeMode === 'initiative' || complexity === 'high') {
    return { min: 4, max: 6, target: 5, depth: 'thorough' };
  }

  return { min: 3, max: 5, target: 4, depth: 'standard' };
}

function buildAmbiguityReasons(input: {
  reqWords: number;
  reqSentences: number;
  hasRichContext: boolean;
  hasBroadScopeSignals: boolean;
  roleMentions: number;
  exceptionMentions: number;
  hasConstraints: boolean;
  hasAmbiguousTokens: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.reqWords <= 20) reasons.push('Requirement is short and likely underspecified.');
  if (input.reqSentences <= 1) reasons.push('Requirement is expressed as a single sentence without decomposition clues.');
  if (!input.hasRichContext) reasons.push('No attachment, work-instruction context, or prior Q&A was available.');
  if (input.hasBroadScopeSignals) reasons.push('Request implies multiple dimensions that may require decomposition.');
  if (input.roleMentions === 0) reasons.push('Primary role is not explicit.');
  if (input.exceptionMentions === 0) reasons.push('Edge cases and failure handling are not defined.');
  if (!input.hasConstraints) reasons.push('Business constraints are still implicit.');
  if (input.hasAmbiguousTokens) reasons.push('Requirement uses broad wording that benefits from clarification.');
  return reasons.slice(0, 5);
}
