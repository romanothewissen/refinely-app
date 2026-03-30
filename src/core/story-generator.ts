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
}

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
  const hasAmbiguousTokens = /(something|somehow|etc|and so on|kind of|maybe|improve|optimi[sz]e|better|faster|enhance|fix this|update this|handle this|do it)/i
    .test(requirement);
  const hasBroadScopeSignals = /(and|also|plus|across|multiple|several|workflow|end[- ]to[- ]end|dashboard|reporting|notification|approval|integration|sync|assignment|prioritization|exception)/i
    .test(requirement);
  const roleMentions = (requirement.match(/\b(admin|manager|planner|dispatcher|technician|agent|user|customer|analyst|qa|developer|operator)\b/ig) ?? []).length;
  const exceptionMentions = (requirement.match(/\b(error|fail|exception|edge|invalid|conflict|fallback|retry|permission|duplicate)\b/ig) ?? []).length;

  const clarityScore =
    (reqWords >= 45 ? 1 : 0) +
    (reqSentences >= 3 ? 1 : 0) +
    (hasRichContext ? 1 : 0) +
    (hasConstraints ? 1 : 0) -
    (hasAmbiguousTokens ? 1 : 0);

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

  return {
    questionPlan,
    featurePlan,
    arPlan,
  };
}

function inferClarifyQuestionPlan(input: {
  requirement: string;
  attachmentText: string;
  wiContextText: string;
  goldExamplesText?: string;
  similarStoriesText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): ClarifyQuestionPlan {
  return assessRequirement(input).questionPlan;
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
}): Promise<GenerationResult> {
  const { requirement, clarifyAnswers, attachmentText, goldExamplesText, similarStoriesText, wiContextText, config, onPass1Complete } = opts;
  const { generatorConfig } = config;
  const assessment = assessRequirement({
    requirement,
    clarifyAnswers,
    attachmentText,
    wiContextText,
    goldExamplesText,
    similarStoriesText,
  });
  const providerOpts = {
    provider: generatorConfig.provider,
    geminiApiKey: generatorConfig.geminiApiKey,
    geminiBaseUrl: generatorConfig.geminiBaseUrl,
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
}): Promise<{ questions: ClarifyQuestion[]; tokenUsage: TokenUsageSummary }> {
  const { requirement, attachmentText, wiContextText, goldExamplesText, similarStoriesText, config } = opts;

  const contextParts: string[] = [`REQUIREMENT: ${requirement}`];
  if (attachmentText) contextParts.push(`ATTACHMENT: ${attachmentText.slice(0, 4000)}`);
  if (wiContextText) contextParts.push(`WORK INSTRUCTIONS EXCERPT: ${wiContextText.slice(0, 4000)}`);
  if (goldExamplesText) contextParts.push(`DEPLOYED GOLD EXAMPLES:\n${goldExamplesText.slice(0, 5000)}`);
  if (similarStoriesText) contextParts.push(`RELATED DEPLOYED BACKLOG ITEMS:\n${similarStoriesText.slice(0, 5000)}`);
  const questionPlan = inferClarifyQuestionPlan({ requirement, attachmentText, wiContextText, goldExamplesText, similarStoriesText });

  const system = buildClarifySystemPrompt({
    domainContext: config.domainContext,
    domainRoles: config.domainRoles,
    questionPlan,
  });

  const raw = await callLlmJsonWithUsage<ClarifyQuestion[]>({
    model: getTierModel(config.generatorConfig.clarifyModel, config.tier),
    systemPrompt: system,
    userMessage: contextParts.join('\n\n'),
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
  });

  // Validate: must be array OR object with a questions array
  let questions: any[] = [];
  if (Array.isArray(raw.data)) {
    questions = raw.data;
  } else if (raw.data && typeof raw.data === 'object' && Array.isArray((raw.data as any).questions)) {
    questions = (raw.data as any).questions;
  } else if (raw.data && typeof raw.data === 'object' && Array.isArray((raw.data as any).features)) {
     // fallback for models confusing decomposition with clarify
     questions = (raw.data as any).features;
  }

  const filteredQuestions = questions
    .filter(x => typeof x === 'object' && x !== null && 'question' in x)
    .slice(0, questionPlan.max);

  return {
    questions: filteredQuestions,
    tokenUsage: {
      input: raw.usage.input,
      output: raw.usage.output,
      total: raw.usage.input + raw.usage.output,
      byStage: { clarify: toStageUsage(raw.usage) },
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
    provider: opts.config.generatorConfig.provider,
    geminiApiKey: opts.config.generatorConfig.geminiApiKey,
    geminiBaseUrl: opts.config.generatorConfig.geminiBaseUrl,
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
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
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
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
  });

  const refined = result.data.features?.[0];
  return {
    feature: refined ? normaliseFeature(refined) : feature,
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
    provider: opts.config.generatorConfig.provider,
    geminiApiKey: opts.config.generatorConfig.geminiApiKey,
    geminiBaseUrl: opts.config.generatorConfig.geminiBaseUrl,
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
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
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
    provider: opts.config.generatorConfig.provider,
    geminiApiKey: opts.config.generatorConfig.geminiApiKey,
    geminiBaseUrl: opts.config.generatorConfig.geminiBaseUrl,
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
