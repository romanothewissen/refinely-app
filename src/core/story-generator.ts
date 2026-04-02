/**
 * Two-pass feature generation pipeline.
 *
 * Pass 1: Decompose requirement into features (summary, description, process_code, story_points)
 * Pass 2: Write GIVEN/WHEN/THEN acceptance requirements for each feature
 *
 * Both passes use Forge LLMs (Claude) — no external API calls.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Feature,
  ClarifyQuestion,
  ClarifyAnswer,
  TenantConfig,
  GenerationResult,
  ValidationViolation,
  TokenUsageSummary,
} from '../types';
import { callLlm, callLlmJson, callLlmJsonWithUsage } from './llm';
import { getTierModel } from '../services/billing';
import {
  buildDecompositionSystemPrompt,
  buildArSystemPrompt,
  buildClarifySystemPrompt,
  buildEvaluateSystemPrompt,
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

interface RequirementAssessment {
  questionPlan: ClarifyQuestionPlan;
  featurePlan: FeaturePlan;
  arPlan: ArPlan;
  ambiguityScore: number;
  ambiguityReasons: string[];
}

interface ClarifyAmbiguityAssessment {
  level: 'clear' | 'medium' | 'vague';
  score: number;
  reasons: string[];
  questionPlan: { min: number; max: number; target: number };
  generatedQuestions: number;
}

export class GenerationCancelledError extends Error {
  constructor() {
    super('Generation cancelled');
    this.name = 'GenerationCancelledError';
  }
}

const GENERIC_ROLE_WORDS = new Set([
  'user',
  'person',
  'individual',
  'professional',
  'worker',
  'staff',
  'member',
  'associate',
  'resource',
  'agent',
  'operator',
  'representative',
  'specialist',
  'technician',
  'engineer',
]);

function assessRequirement(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  goldExamplesText?: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): RequirementAssessment {
  const requirement = input.requirement?.trim() ?? '';
  const attachment = input.attachmentText?.trim() ?? '';
  const wi = input.wiContextText?.trim() ?? '';
  const gold = input.goldExamplesText?.trim() ?? '';
  const similar = input.similarStoriesText?.trim() ?? '';
  const answers = input.clarifyAnswers ?? [];

  const reqWords = requirement ? requirement.split(/\s+/).length : 0;
  const reqSentences = requirement
    ? requirement.split(/[.!?]\s+/).map(s => s.trim()).filter(Boolean).length
    : 0;
  const hasRichContext = attachment.length > 250 || wi.length > 250 || gold.length > 250 || similar.length > 250 || answers.length >= 4;
  const hasConstraints = /(must|should|cannot|can't|only|except|unless|sla|kpi|compliance|permission|role|workflow|edge case|error|fallback|validation|audit|security)/i
    .test(requirement);
  const hasAmbiguousTokens = /(something|somehow|etc|and so on|kind of|maybe|improve|optimi[sz]e|optimal|better|faster|enhance|fix this|update this|handle this|do it)/i
    .test(requirement);
  const hasBroadScopeSignals = /(and|also|plus|across|multiple|several|workflow|end[- ]to[- ]end|dashboard|reporting|notification|approval|integration|sync|assignment|prioritization|exception)/i
    .test(requirement);
  const roleMentions = (requirement.match(/\b(admin|manager|planner|dispatcher|technician|fse|field service engineer|agent|user|customer|analyst|qa|developer|operator)\b/ig) ?? []).length;
  const exceptionMentions = (requirement.match(/\b(error|fail|exception|edge|invalid|conflict|fallback|retry|permission|duplicate)\b/ig) ?? []).length;

  const ambiguityPenalty =
    (reqWords <= 25 ? 1 : 0) +
    (reqSentences <= 1 ? 1 : 0) +
    (hasAmbiguousTokens ? 1 : 0) +
    (hasBroadScopeSignals ? 1 : 0) +
    (roleMentions === 0 ? 1 : 0) +
    (exceptionMentions === 0 ? 1 : 0);

  const clarityScore =
    (reqWords >= 45 ? 1 : 0) +
    (reqSentences >= 3 ? 1 : 0) +
    (hasRichContext ? 1 : 0) +
    (hasConstraints ? 1 : 0) -
    (ambiguityPenalty >= 3 ? 1 : 0);

  const complexityScore =
    (hasConstraints ? 1 : 0) +
    (exceptionMentions >= 2 ? 1 : 0) +
    (answers.length >= 5 ? 1 : 0) +
    (roleMentions >= 2 ? 1 : 0) +
    (hasBroadScopeSignals ? 1 : 0);

  const shapeScore =
    (hasBroadScopeSignals ? 1 : 0) +
    (reqWords >= 60 ? 1 : 0) +
    (reqSentences >= 4 ? 1 : 0) +
    (answers.length >= 5 ? 1 : 0);

  const questionPlan: ClarifyQuestionPlan =
    clarityScore >= 4
      ? { min: 4, max: 6, target: 5, clarity: 'clear' }
      : clarityScore <= 1
        ? { min: 10, max: 14, target: 12, clarity: 'vague' }
        : { min: 6, max: 9, target: 7, clarity: 'medium' };

  const featurePlan: FeaturePlan =
    shapeScore >= 3
      ? {
          min: complexityScore >= 4 ? 5 : 4,
          max: complexityScore >= 4 ? 8 : 6,
          target: complexityScore >= 4 ? 6 : 5,
          shape: 'broad',
          complexity: complexityScore >= 4 ? 'high' : 'medium',
        }
      : shapeScore <= 1
        ? {
            min: 1,
            max: complexityScore >= 3 ? 4 : 3,
            target: complexityScore >= 3 ? 3 : 2,
            shape: 'narrow',
            complexity: complexityScore >= 3 ? 'medium' : 'low',
          }
        : {
            min: 2,
            max: complexityScore >= 4 ? 6 : 5,
            target: complexityScore >= 4 ? 5 : 4,
            shape: 'balanced',
            complexity: complexityScore >= 4 ? 'high' : 'medium',
          };

  const arPlan: ArPlan =
    featurePlan.complexity === 'high'
      ? { min: 4, max: 6, target: 5, depth: 'thorough' }
      : featurePlan.complexity === 'low'
        ? { min: 2, max: 3, target: 2, depth: 'lean' }
      : { min: 3, max: 5, target: 4, depth: 'standard' };

  const ambiguityReasons: string[] = [];
  if (reqWords <= 25) ambiguityReasons.push('Requirement is short and likely underspecified.');
  if (reqSentences <= 1) ambiguityReasons.push('Requirement is expressed as a single sentence without decomposition clues.');
  if (!hasRichContext) ambiguityReasons.push('No attachment, work-instruction context, or prior Q&A was available.');
  if (hasBroadScopeSignals) ambiguityReasons.push('Request implies multiple dimensions (priority, due dates, skills, or dependencies).');
  if (roleMentions === 0) ambiguityReasons.push('Primary role is not explicit.');
  if (exceptionMentions === 0) ambiguityReasons.push('Edge cases and failure handling are not defined.');
  if (!hasConstraints) ambiguityReasons.push('Business constraints are still implicit.');

  return {
    questionPlan,
    featurePlan,
    arPlan,
    ambiguityScore: Math.max(0, ambiguityPenalty - (hasConstraints ? 1 : 0)),
    ambiguityReasons,
  };
}

function inferClarifyAssessment(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  goldExamplesText?: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): { questionPlan: ClarifyQuestionPlan; ambiguityScore: number; ambiguityReasons: string[] } {
  const assessed = assessRequirement(input);
  return {
    questionPlan: assessed.questionPlan,
    ambiguityScore: assessed.ambiguityScore,
    ambiguityReasons: assessed.ambiguityReasons,
  };
}

function normaliseQuestionKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
        ? (x as any).suggestions.map((s: unknown) => String(s ?? '').trim()).filter(Boolean).slice(0, 4)
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
      suggestions: ['Dispatcher', 'Team lead', 'Field service engineer (FSE)', 'No one; fully automatic'],
    },
    {
      category: 'Functional Flow',
      question: 'How should criticality and due date be weighted when they conflict for two jobs?',
      suggestions: ['Criticality always wins', 'Due date always wins', 'Configurable weighted score', 'Tie-break by travel time'],
    },
    {
      category: 'Business Rules & Exceptions',
      question: 'What should happen when the optimal slot violates skill, parts, or availability constraints?',
      suggestions: ['Skip and pick next best', 'Escalate for manual assignment', 'Allow temporary override', 'Flag as unschedulable'],
    },
    {
      category: 'Trigger & Context',
      question: 'When should schedules be generated or recalculated?',
      suggestions: ['Nightly batch', 'On each new request', 'On demand by dispatcher', 'On request update events'],
    },
    {
      category: 'Success & Measurement',
      question: 'What defines an optimal schedule outcome for this process?',
      suggestions: ['Max SLA compliance', 'Highest critical jobs completed first', 'Balanced utilization', 'Minimum overdue work'],
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

// ─── Main Generation ──────────────────────────────────────────────────────────

export async function generateFeatures(opts: {
  requirement: string;
  clarifyAnswers: ClarifyAnswer[];
  attachmentText: string;
  goldExamplesText: string;
  similarStoriesText: string;
  wiContextText: string;
  config: TenantConfig;
  onPass1Complete?: (featureCount: number) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}): Promise<GenerationResult> {
  const { requirement, clarifyAnswers, attachmentText, goldExamplesText, similarStoriesText, wiContextText, config, onPass1Complete, shouldCancel } = opts;
  const { generatorConfig } = config;
  const assessment = assessRequirement({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
  });
  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();
  const providerOpts = {
    provider: generatorConfig.provider,
    geminiApiKey: generatorConfig.geminiApiKey,
    geminiBaseUrl: generatorConfig.geminiBaseUrl,
    openaiApiKey: generatorConfig.openaiApiKey,
    openaiBaseUrl: generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
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
    featurePlan: assessment.featurePlan,
  });

  const pass1Result = await callLlmJsonWithUsage<{ features: RawFeature[] }>({
    model: getTierModel(generatorConfig.decompositionModel, config.tier),
    systemPrompt: pass1System,
    userMessage,
    maxTokens: generatorConfig.maxTokens,
    ...providerOpts,
  });

  const pass1Features = pass1Result.data.features ?? [];

  // Notify caller so it can emit a progress event before the slow pass 2 LLM call
  if (onPass1Complete) await onPass1Complete(pass1Features.length);
  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  // ── Pass 2: Acceptance Requirements ──
  const pass2System = buildArSystemPrompt({
    domainContext: config.domainContext,
    arPlan: assessment.arPlan,
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
  if (await maybeCancelled(shouldCancel)) throw new GenerationCancelledError();

  // Merge: use pass2 ARs; fall back to pass1 if pass2 missing or empty
  const rawFeatures = pass2Result.data.features?.length
    ? mergeFeatures(pass1Features, pass2Result.data.features)
    : pass1Features;

  const features = rawFeatures.map(normaliseFeature);
  const violations = validateFeatures(features, config);

  const tokenUsage: TokenUsageSummary = {
    input: pass1Result.usage.input + pass2Result.usage.input,
    output: pass1Result.usage.output + pass2Result.usage.output,
    total: pass1Result.usage.input + pass1Result.usage.output + pass2Result.usage.input + pass2Result.usage.output,
    byStage: {
      decomposition: toStageUsage(pass1Result.usage),
      acceptanceRequirements: toStageUsage(pass2Result.usage),
    },
  };

  return {
    features,
    violations,
    similarStories: [],   // filled in by the caller after this returns
    sessionId: uuidv4(),
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
}): Promise<{ questions: ClarifyQuestion[]; tokenUsage: TokenUsageSummary; ambiguityAssessment: ClarifyAmbiguityAssessment }> {
  const { requirement, attachmentText, wiContextText, goldExamplesText, similarStoriesText, config } = opts;

  const contextParts: string[] = [`REQUIREMENT: ${requirement}`];
  if (attachmentText) contextParts.push(`ATTACHMENT: ${attachmentText.slice(0, 4000)}`);
  if (wiContextText) contextParts.push(`WORK INSTRUCTIONS EXCERPT: ${wiContextText.slice(0, 4000)}`);
  if (goldExamplesText) contextParts.push(`DEPLOYED GOLD EXAMPLES:\n${goldExamplesText.slice(0, 5000)}`);
  if (similarStoriesText) contextParts.push(`RELATED DEPLOYED BACKLOG ITEMS:\n${similarStoriesText.slice(0, 5000)}`);
  const assessment = inferClarifyAssessment({ requirement, attachmentText, wiContextText, goldExamplesText, similarStoriesText });
  const questionPlan = assessment.questionPlan;

  const system = buildClarifySystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    questionPlan,
  });

  const raw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
    model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
    systemPrompt: system,
    userMessage: contextParts.join('\n\n'),
    ...buildLlmProviderOpts(config),
  });

  let totalInputTokens = raw.usage.input;
  let totalOutputTokens = raw.usage.output;
  let filteredQuestions = dedupeQuestions(parseQuestionCandidates(raw.data)).slice(0, questionPlan.max);

  if (filteredQuestions.length < questionPlan.min) {
    const needed = questionPlan.min - filteredQuestions.length;
    const topUpUserMessage = [
      contextParts.join('\n\n'),
      `ALREADY GENERATED QUESTIONS (do not repeat):\n${filteredQuestions.map((q, idx) => `${idx + 1}. ${q.question}`).join('\n') || '(none)'}`,
      `Generate exactly ${needed} additional clarifying questions that are non-overlapping with the existing list.`,
      'Return JSON array only in this shape: [{"category":"...","question":"...","suggestions":["...","...","...","..."]}]',
    ].join('\n\n---\n\n');

    const topUpRaw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
      model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
      systemPrompt: system,
      userMessage: topUpUserMessage,
      ...buildLlmProviderOpts(config),
    });
    totalInputTokens += topUpRaw.usage.input;
    totalOutputTokens += topUpRaw.usage.output;

    filteredQuestions = dedupeQuestions([
      ...filteredQuestions,
      ...parseQuestionCandidates(topUpRaw.data),
    ]).slice(0, questionPlan.max);
  }

  if (filteredQuestions.length < questionPlan.min) {
    const needed = questionPlan.min - filteredQuestions.length;
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
      score: assessment.ambiguityScore,
      reasons: assessment.ambiguityReasons.slice(0, 4),
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
}): Promise<{ sufficient: boolean; questions?: ClarifyQuestion[] }> {
  const qaText = opts.answers
    .map(a => `Q: ${a.question}\nA: ${a.answer}`)
    .join('\n\n');

  const userMessage = `REQUIREMENT: ${opts.requirement}\n\nQ&A:\n${qaText}`;

  const result = await callLlmJson<{ sufficient: boolean; questions?: ClarifyQuestion[] }>({
    model: getTierModel(opts.config.generatorConfig.evaluateModel, opts.config.tier),
    systemPrompt: buildEvaluateSystemPrompt(),
    userMessage,
    ...buildLlmProviderOpts(opts.config),
  });

  return result;
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
    ...buildLlmProviderOpts(config),
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
    ...buildLlmProviderOpts(config),
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
    feature: harmonizeFeatureRoleLanguage(stableResult),
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
    ...buildLlmProviderOpts(opts.config),
  });

  return result;
}

// ─── Session Title ────────────────────────────────────────────────────────────

export async function generateSessionTitle(requirement: string, config: TenantConfig): Promise<string> {
  const res = await callLlm({
    model: config.generatorConfig.themeModel,
    systemPrompt: 'Generate a concise, prescriptive 5-7 word title for this business requirement. Make it action-oriented, outcome-focused, and easy to scan in a backlog. Avoid generic words like feature, flow, process, solution, or system. Output the title only, no quotes.',
    userMessage: requirement,
    maxTokens: 32,
    ...buildLlmProviderOpts(config),
  });
  return formatSessionTitle(res.text, requirement);
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
    ...buildLlmProviderOpts(opts.config),
  });

  return res.text;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normaliseFeature(raw: RawFeature): Feature {
  return harmonizeFeatureRoleLanguage({
    id: uuidv4(),
    summary: raw.summary ?? 'Untitled feature',
    description: raw.description ?? '',
    acceptanceRequirements: normaliseArs(getRawAcceptanceArray(raw)),
    storyPoints: raw.suggested_story_points,
    processCode: raw.process_code,
  });
}

function buildLlmProviderOpts(config: TenantConfig) {
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

function extractRoleFromDescription(description: string): string | null {
  const match = description.match(/^As an?\s+(.+?),\s*I need to\s+/i);
  return match?.[1]?.trim() || null;
}

function tokenizeRole(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function roleOverlapScore(left: string, right: string): number {
  const leftTokens = new Set(tokenizeRole(left));
  const rightTokens = new Set(tokenizeRole(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function shouldAlignRolePhrase(candidateRole: string, featureRole: string): boolean {
  const candidate = candidateRole.trim();
  const target = featureRole.trim();
  if (!candidate || !target) return false;

  const normalizedCandidate = candidate.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (normalizedCandidate === normalizedTarget) return false;
  if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) return true;

  const candidateTokens = tokenizeRole(candidate);
  const targetTokens = tokenizeRole(target);
  const overlap = roleOverlapScore(candidate, target);
  const candidateIsGeneric = candidateTokens.every(token => GENERIC_ROLE_WORDS.has(token) || targetTokens.includes(token));

  return overlap >= 0.34 || (candidateIsGeneric && overlap >= 0.2);
}

function articleForRole(role: string): 'a' | 'an' {
  return /^[aeiou]/i.test(role.trim()) ? 'an' : 'a';
}

function alignRoleInClause(clause: string, featureRole: string): string {
  if (!clause || !featureRole) return clause;

  return clause.replace(/\b(a|an|the)\s+([A-Za-z][A-Za-z\s/-]{1,60}?)(?=\s+(?:has|have|is|are|was|were|needs|need|can|cannot|must|should|views|receives|creates|updates|submits|opens|reviews|approves|rejects|selects|starts|attempts|works|manages|uses|belongs)\b)/i, (match, article, rolePhrase) => {
    if (!shouldAlignRolePhrase(rolePhrase, featureRole)) return match;
    const nextArticle = String(article).toLowerCase() === 'the' ? 'the' : articleForRole(featureRole);
    return `${nextArticle} ${featureRole}`;
  });
}

function harmonizeFeatureRoleLanguage(feature: Feature): Feature {
  const featureRole = extractRoleFromDescription(feature.description);
  if (!featureRole) return feature;

  return {
    ...feature,
    acceptanceRequirements: (feature.acceptanceRequirements || []).map(ar => ({
      ...ar,
      given: alignRoleInClause(ar.given, featureRole),
      when: alignRoleInClause(ar.when, featureRole),
      then: alignRoleInClause(ar.then, featureRole),
    })),
  };
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

async function maybeCancelled(shouldCancel?: () => Promise<boolean> | boolean): Promise<boolean> {
  if (!shouldCancel) return false;
  return Boolean(await shouldCancel());
}

function formatSessionTitle(rawTitle: string, fallbackRequirement: string): string {
  const cleaned = String(rawTitle ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—:;,.]+\s*$/g, '')
    .trim();

  if (!cleaned) {
    return fallbackRequirement.slice(0, 80).trim();
  }

  const words = cleaned.split(' ').filter(Boolean);
  const capped = words.length > 7 ? words.slice(0, 7).join(' ') : cleaned;
  return capped.length > 80 ? capped.slice(0, 80).trimEnd() : capped;
}
