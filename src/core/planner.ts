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
} from '../types';

interface PlannerInput {
  requirement: string;
  attachmentText?: string;
  wiContextText?: string;
  goldExamplesText?: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  reasoningMode?: ReasoningMode;
  outputMode?: OutputMode;
  policy?: Pick<
    AiExecutionPolicy,
    'simpleAskMaxQuestions' | 'deepModeRoundTarget' | 'enterpriseMaxQuestionsPerRound'
  >;
}

export function buildPlannerDecision(input: PlannerInput): PlannerDecision {
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
  const hasBroadScopeSignals = /(and|also|plus|across|multiple|several|workflow|end[- ]to[- ]end|dashboard|reporting|notification|approval|integration|sync|assignment|prioritization|exception|rollout|migration|program|portfolio|operating model)/i
    .test(requirement);
  const hasEnterpriseSignals = /(enterprise|compliance|audit|governance|permission matrix|cross[- ]functional|cross[- ]team|multiple teams|multiple departments|multiple business units|regional|global rollout)/i
    .test(requirement);
  const hasIntakeWorkflowSignals = /(email|inbox|mailbox|shared tech support inbox|shared inbox|support inbox|case creation|create cases?|ticket creation|triage|routing|auto(?:matic|mated)?|determine if|product issue|general inquiry|classif(?:y|ication)|categori[sz](?:e|ation))/i
    .test(requirement);

  const roleMentions = (requirement.match(/\b(admin|manager|planner|dispatcher|technician|fse|field service engineer|agent|user|customer|analyst|qa|developer|operator|finance|legal|sales|support|tss|tech support|technical support)\b/ig) ?? []).length;
  const exceptionMentions = (requirement.match(/\b(error|fail|exception|edge|invalid|conflict|fallback|retry|permission|duplicate|rollback|escalat)\w*\b/ig) ?? []).length;
  const integrationMentions = (requirement.match(/\b(integration|sync|import|export|api|feed|data source|vendor|jira|sap|salesforce|erp|crm|billing|email|inbox|mailbox|outlook|gmail)\b/ig) ?? []).length;
  const classificationMentions = (requirement.match(/\b(classif(?:y|ication)|categori[sz](?:e|ation)|triage|routing|route|determine|product issue|general inquiry)\b/ig) ?? []).length;

  const ambiguityScore =
    (reqWords <= 20 ? 1 : 0) +
    (reqSentences <= 1 ? 1 : 0) +
    (hasAmbiguousTokens ? 1 : 0) +
    (!hasRichContext ? 1 : 0) +
    (roleMentions === 0 ? 1 : 0) +
    (exceptionMentions === 0 ? 1 : 0) -
    (hasConstraints ? 1 : 0) +
    (hasIntakeWorkflowSignals && answers.length === 0 ? 1 : 0);

  const clarity: ClarifyQuestionPlan['clarity'] =
    ambiguityScore <= 1 ? 'clear' : ambiguityScore >= 4 ? 'vague' : 'medium';

  const breadthScore =
    (hasBroadScopeSignals ? 1 : 0) +
    (hasEnterpriseSignals ? 1 : 0) +
    (reqWords >= 55 ? 1 : 0) +
    (reqSentences >= 3 ? 1 : 0) +
    (roleMentions >= 2 ? 1 : 0) +
    (integrationMentions >= 1 ? 1 : 0) +
    (hasIntakeWorkflowSignals ? 1 : 0) +
    (classificationMentions >= 1 ? 1 : 0) +
    (answers.length >= 4 ? 1 : 0);

  const complexityScore =
    (hasConstraints ? 1 : 0) +
    (exceptionMentions >= 2 ? 1 : 0) +
    (roleMentions >= 2 ? 1 : 0) +
    (integrationMentions >= 1 ? 1 : 0) +
    (hasIntakeWorkflowSignals ? 1 : 0) +
    (classificationMentions >= 1 ? 1 : 0) +
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
  if (integrationMentions >= 1) rationale.push('Integrations or external data dependencies are implied.');
  if (hasIntakeWorkflowSignals) rationale.push('Request involves intake automation or case-routing logic that usually needs business-rule discovery.');
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
      roleMentions,
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
    if (reasoningMode === 'deep' || clarity === 'vague' || complexityScore >= 3) return 'standard';
    return 'light';
  }

  if (scopeMode === 'initiative') {
    return reasoningMode === 'deep' || clarity !== 'clear' ? 'deep' : 'standard';
  }

  if (reasoningMode === 'deep' || clarity === 'vague' || complexityScore >= 3) return 'deep';
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
