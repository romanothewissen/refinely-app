import {
  ClarifyCategoryKey,
  ClarifyFailureReasonCode,
  ClarifyQuestion,
  DiscoveryCoverageArtifact,
  DiscoveryProfile,
} from '../types';

export const MIN_INITIAL_DISCOVERY_QUESTIONS = 4;
export const MAX_INITIAL_DISCOVERY_QUESTIONS = 20;
export const MIN_FOLLOWUP_DISCOVERY_QUESTIONS = 1;
export const MAX_FOLLOWUP_DISCOVERY_QUESTIONS = 8;
export const MAX_TOTAL_DISCOVERY_QUESTIONS = 20;

export const CLARIFY_CATEGORY_ORDER: ClarifyCategoryKey[] = [
  'context_trigger',
  'user_personas',
  'functional_flow',
  'business_rules',
  'state_lifecycle',
  'success_measurement',
];

export const CLARIFY_CATEGORY_LABELS: Record<ClarifyCategoryKey, string> = {
  context_trigger: 'Context & Trigger',
  user_personas: 'User Personas',
  functional_flow: 'Functional Flow',
  business_rules: 'Business Rules',
  state_lifecycle: 'State & Lifecycle',
  success_measurement: 'Success & Measurement',
};

// Maps legacy or freeform LLM category labels to canonical keys.
const CATEGORY_ALIASES: Record<string, ClarifyCategoryKey> = {
  'context trigger': 'context_trigger',
  'context and trigger': 'context_trigger',
  'trigger context': 'context_trigger',
  'trigger and context': 'context_trigger',
  'objective outcome': 'context_trigger',
  'objective and outcome': 'context_trigger',
  'success criteria': 'context_trigger',
  'actors ownership': 'user_personas',
  'actors and ownership': 'user_personas',
  'roles personas': 'user_personas',
  'roles and personas': 'user_personas',
  'user personas': 'user_personas',
  'personas': 'user_personas',
  // Legacy keys mapped to new equivalents
  'information architecture': 'functional_flow',
  'inputs data': 'functional_flow',
  'inputs and data': 'functional_flow',
  'data': 'functional_flow',
  'functional flow': 'functional_flow',
  'process flow': 'functional_flow',
  'workflow flow': 'functional_flow',
  'step by step': 'functional_flow',
  'business rules': 'business_rules',
  'rules constraints': 'business_rules',
  'rules and constraints': 'business_rules',
  'dependencies boundaries': 'business_rules',
  'dependencies and boundaries': 'business_rules',
  'edge cases exceptions': 'business_rules',
  'edge cases and exceptions': 'business_rules',
  'exceptions failure modes': 'business_rules',
  'exceptions and failure modes': 'business_rules',
  'state lifecycle': 'state_lifecycle',
  'state and lifecycle': 'state_lifecycle',
  'workflow decisions': 'state_lifecycle',
  'workflow and decisions': 'state_lifecycle',
  'success measurement': 'success_measurement',
  'success and measurement': 'success_measurement',
  'success metrics': 'success_measurement',
  'measurement': 'success_measurement',
};

// ─── Text Utilities ────────────────────────────────────────────────────────────

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureQuestionMark(value: string): string {
  const trimmed = cleanText(value).replace(/[?.!]+$/g, '');
  return trimmed ? `${trimmed}?` : '';
}

function simplifyQuestionCopy(value: string): string {
  return cleanText(value)
    .replace(/["""''']/g, '')
    .replace(/\((?:as\s+per|per|see|from)\s+[^)]*(?:reference|references|doc|docs|story|stories|evidence|backlog|wi)[^)]*\)/gi, '')
    .replace(/\((?:backlog|reference|references|doc|docs|story|stories|wi)[^)]*\)/gi, '')
    .replace(/\bwhat exact\b/gi, 'what')
    .replace(/\bwhat other events or conditions should\b/gi, 'which policy should')
    .replace(/\bin order to\b/gi, 'to')
    .replace(/\bwith regard to\b/gi, 'for')
    .replace(/\bfor the purpose of determining\b/gi, 'to determine')
    .replace(/\s+([,?.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceCaseQuestion(value: string): string {
  const normalized = ensureQuestionMark(simplifyQuestionCopy(value));
  if (!normalized) return '';
  return normalized.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function normalizeDetailsText(value: string): string {
  const cleaned = cleanText(value)
    .replace(/["""''']/g, '')
    .replace(/\s+([,?.!])/g, '$1')
    .trim();
  if (!cleaned) return '';
  return cleaned.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function isLikelyCompleteQuestion(value: string): boolean {
  const normalized = cleanText(value);
  if (!normalized) return false;
  if (/['"`]\?$/.test(normalized)) return false;
  return !/\b(a|an|the|and|or|but|into|onto|than|then|my|your|his|her|our|their|its)\?$/i.test(normalized);
}

function toSnakeCase(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
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

function uniqueCategoryKeys(values: ClarifyCategoryKey[]): ClarifyCategoryKey[] {
  return CLARIFY_CATEGORY_ORDER.filter((key) => values.includes(key));
}

// ─── Category Resolution ──────────────────────────────────────────────────────

export function labelForCategoryKey(categoryKey: ClarifyCategoryKey): string {
  return CLARIFY_CATEGORY_LABELS[categoryKey];
}

export function normalizeCategoryKey(value: unknown): ClarifyCategoryKey | null {
  const raw = cleanText(String(value ?? ''));
  if (!raw) return null;
  if ((CLARIFY_CATEGORY_ORDER as string[]).includes(raw)) return raw as ClarifyCategoryKey;
  const cleaned = normalizeKey(String(value ?? ''));
  if (!cleaned) return null;
  if (CATEGORY_ALIASES[cleaned]) return CATEGORY_ALIASES[cleaned];
  if ((CLARIFY_CATEGORY_ORDER as string[]).includes(cleaned)) return cleaned as ClarifyCategoryKey;
  return null;
}

export function inferCategoryKeyFromQuestion(question: string): ClarifyCategoryKey {
  const normalized = cleanText(question).toLowerCase();
  if (/\b(status|state|lifecycle|transition|stage|reopen|retry|reverse|progression|move through)\b/.test(normalized)) {
    return 'state_lifecycle';
  }
  if (/\b(success|measure|metric|test|tester|verify|outcome|improvement|visibility|track end-to-end|kpi|confirm.*working)\b/.test(normalized)) {
    return 'success_measurement';
  }
  if (/\b(step|sequence|order|flow|depend|precondition|branch|parallel|serial|before.*complete|when.*complete|activity.*order)\b/.test(normalized)) {
    return 'functional_flow';
  }
  if (/\b(rule|constraint|priority|validation|approval|threshold|policy|timing|rank|score|missing|duplicate|conflict|offline|unavailable|error|fail|fallback|exception|invalid)\b/.test(normalized)) {
    return 'business_rules';
  }
  if (/\b(who|actor|owner|permission|access|role|team|persona|visibility)\b/.test(normalized)) {
    return 'user_personas';
  }
  return 'context_trigger';
}

// ─── Question Intent ──────────────────────────────────────────────────────────

export function normalizeQuestionIntent(value: unknown, categoryKey: ClarifyCategoryKey): string {
  const provided = toSnakeCase(String(value ?? ''));
  if (provided) return provided;
  return `clarify_${categoryKey}`;
}

// ─── Question Normalization ───────────────────────────────────────────────────

export function splitGroupedQuestion(question: string): string[] {
  const normalized = ensureQuestionMark(question);
  if (!normalized) return [];
  // The discovery prompt now forbids bundled questions, so splitting numbered
  // patterns mostly creates weak fragments that inflate the question count.
  // Return the question as-is and let any remaining bundles be handled as one card.
  return [normalized];
}

function normalizeQuestionText(question: string): string {
  const raw = cleanText(question);
  if (/[A-Za-z0-9]['"`'']$/.test(raw)) return '';
  const normalized = sentenceCaseQuestion(question);
  return isLikelyCompleteQuestion(normalized) ? normalized : '';
}

function splitQuestionIntoPrimaryAndDetails(question: string): { question: string; details?: string } {
  const normalized = normalizeQuestionText(question);
  if (!normalized) return { question: '' };
  const ifPattern = normalized.match(/^If\s+(.+?),\s*(is|are|should|can|could|would|will)\s+(.+)\?$/i);
  if (ifPattern) {
    return {
      question: sentenceCaseQuestion(`${ifPattern[2]} ${ifPattern[3]}?`),
      details: normalizeDetailsText(`Scenario: ${ifPattern[1]}.`),
    };
  }
  const whenPattern = normalized.match(/^When\s+(.+?),\s*(what|which|who|how|where|why)\s+(.+)\?$/i);
  if (whenPattern) {
    return {
      question: sentenceCaseQuestion(`${whenPattern[2]} ${whenPattern[3]}?`),
      details: normalizeDetailsText(`Context: ${whenPattern[1]}.`),
    };
  }
  const doesMeanPattern = normalized.match(/^Does\s+(.+?)\s+mean\s+(.+)\?$/i);
  if (doesMeanPattern) {
    return {
      question: sentenceCaseQuestion(`How should ${doesMeanPattern[1]} be interpreted?`),
      details: normalizeDetailsText(`Clarify whether it means ${doesMeanPattern[2]}.`),
    };
  }
  const delimiterMatch = normalized.match(/^(.{40,120}?)\s+(but|while|unless|except when|except if|especially when)\s+(.+)\?$/i);
  if (delimiterMatch) {
    return {
      question: sentenceCaseQuestion(delimiterMatch[1]),
      details: normalizeDetailsText(`${delimiterMatch[2].replace(/^[a-z]/, (letter) => letter.toUpperCase())} ${delimiterMatch[3]}.`),
    };
  }
  const shortEnough = normalized.length <= 200 && normalized.split(/\s+/).length <= 30;
  if (shortEnough) return { question: normalized };
  return { question: normalized };
}

function normalizeQuestionDetails(details?: string): string | undefined {
  const normalized = normalizeDetailsText(details ?? '');
  return normalized || undefined;
}

function normalizeQuestions(questions: ClarifyQuestion[], alreadyAsked: Set<string>): ClarifyQuestion[] {
  const seen = new Set(alreadyAsked);
  const result: ClarifyQuestion[] = [];
  questions.forEach((question) => {
    const normalizedCopy = splitQuestionIntoPrimaryAndDetails(question.question);
    const normalizedQuestion = normalizedCopy.question;
    if (!normalizedQuestion) return;
    const normalizedDetails = normalizeQuestionDetails(question.details ?? normalizedCopy.details);
    const key = normalizeKey(`${normalizedQuestion} ${normalizedDetails ?? ''}`);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({
      categoryKey: question.categoryKey,
      category: labelForCategoryKey(question.categoryKey),
      intent: normalizeQuestionIntent(question.intent, question.categoryKey),
      question: normalizedQuestion,
      details: normalizedDetails,
      suggestions: uniqueStrings(question.suggestions).slice(0, 4),
    });
  });
  return result;
}

function questionComparator(left: ClarifyQuestion, right: ClarifyQuestion): number {
  const leftIndex = CLARIFY_CATEGORY_ORDER.indexOf(left.categoryKey);
  const rightIndex = CLARIFY_CATEGORY_ORDER.indexOf(right.categoryKey);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  if (left.question.length !== right.question.length) return right.question.length - left.question.length;
  return left.question.localeCompare(right.question);
}

/** Budget for the first discovery screen: clarify model's own count governs; triage is a minimum floor, not a ceiling. */
export function computeInitialQuestionBudget(
  profile: DiscoveryProfile,
  triageRecommendedInitial?: number | null,
): number {
  const cap = MAX_INITIAL_DISCOVERY_QUESTIONS;
  const fromTriage = typeof triageRecommendedInitial === 'number' && triageRecommendedInitial > 0
    ? Math.round(triageRecommendedInitial)
    : 0;
  const fromProfile = Math.round(profile.recommendedInitialCount || 0);
  // Clarify model's self-reported count governs; triage is a minimum floor only.
  const budget = fromProfile > 0 ? fromProfile : (fromTriage > 0 ? fromTriage : cap);
  return Math.min(cap, Math.max(fromTriage, budget));
}

/**
 * When the model emits more questions than the budget, keep breadth across taxonomy first (round-robin by category),
 * then fill remaining slots in category order so discovery does not feel like 25+ sequential cards.
 */
export function selectDiverseInitialQuestions(questions: ClarifyQuestion[], budget: number): ClarifyQuestion[] {
  if (questions.length <= budget || budget <= 0) return questions.slice(0, Math.max(0, budget));

  const sorted = [...questions].sort(questionComparator);
  const byCat = new Map<ClarifyCategoryKey, ClarifyQuestion[]>();
  for (const q of sorted) {
    const list = byCat.get(q.categoryKey) ?? [];
    list.push(q);
    byCat.set(q.categoryKey, list);
  }

  const picked: ClarifyQuestion[] = [];
  const pickedKeys = new Set<string>();
  let round = 0;
  let madeProgress = true;
  while (picked.length < budget && madeProgress) {
    madeProgress = false;
    for (const cat of CLARIFY_CATEGORY_ORDER) {
      if (picked.length >= budget) break;
      const bucket = byCat.get(cat);
      const next = bucket?.[round];
      if (!next) continue;
      const key = normalizeKey(`${next.question} ${next.details ?? ''}`);
      if (pickedKeys.has(key)) continue;
      pickedKeys.add(key);
      picked.push(next);
      madeProgress = true;
    }
    round += 1;
  }

  if (picked.length < budget) {
    for (const q of sorted) {
      if (picked.length >= budget) break;
      const key = normalizeKey(`${q.question} ${q.details ?? ''}`);
      if (pickedKeys.has(key)) continue;
      pickedKeys.add(key);
      picked.push(q);
    }
  }

  return picked.sort(questionComparator);
}

// ─── Discovery Profile Parsing ────────────────────────────────────────────────

export function normalizeDiscoveryProfile(
  candidate?: Partial<DiscoveryProfile> | null,
  fallbackQuestionCount = 8,
): DiscoveryProfile {
  const scope = cleanText(candidate?.scope ?? '').toLowerCase();
  const complexity = cleanText(candidate?.complexity ?? '').toLowerCase();
  const ambiguity = cleanText(candidate?.ambiguity ?? '').toLowerCase();
  const recommendedInitialCount = Math.max(
    0,
    Number.isFinite(candidate?.recommendedInitialCount)
      ? Number(candidate?.recommendedInitialCount)
      : fallbackQuestionCount,
  );
  const plannedQuestionBudget = Math.max(
    0,
    Number.isFinite(candidate?.plannedQuestionBudget)
      ? Number(candidate?.plannedQuestionBudget)
      : recommendedInitialCount,
  );
  const followupCap = Math.max(
    0,
    Math.round(Number.isFinite(candidate?.followupCap) ? Number(candidate?.followupCap) : 4),
  );
  const softQuestionBudget = Math.max(
    0,
    Math.round(Number.isFinite(candidate?.softQuestionBudget) ? Number(candidate?.softQuestionBudget) : plannedQuestionBudget),
  );
  const hardQuestionCap = Math.max(
    softQuestionBudget,
    Math.round(Number.isFinite(candidate?.hardQuestionCap) ? Number(candidate?.hardQuestionCap) : Math.max(softQuestionBudget, plannedQuestionBudget + followupCap)),
  );
  const rawMissing = Array.isArray((candidate as { missingCategoryKeys?: unknown[] } | null | undefined)?.missingCategoryKeys)
    ? ((candidate as { missingCategoryKeys?: unknown[] }).missingCategoryKeys ?? [])
    : [];
  const missingCategoryKeys = uniqueCategoryKeys(
    rawMissing
      .map((value) => normalizeCategoryKey(value))
      .filter((value): value is ClarifyCategoryKey => Boolean(value)),
  );
  const actualQuestionsAsked = Math.max(
    0,
    Math.round(Number.isFinite(candidate?.actualQuestionsAsked) ? Number(candidate?.actualQuestionsAsked) : 0),
  );
  const actualAnswersReceived = Number.isFinite(candidate?.actualAnswersReceived)
    ? Math.max(0, Math.round(Number(candidate?.actualAnswersReceived)))
    : undefined;
  const coverageArtifact = (candidate?.coverageArtifact as DiscoveryCoverageArtifact | undefined) ?? buildDiscoveryCoverageArtifact({
    missingCategoryKeys,
    plannedQuestionBudget,
    actualQuestionsAsked,
    actualAnswersReceived,
  });
  return {
    scope: scope === 'narrow' || scope === 'moderate' || scope === 'broad' || scope === 'very_broad' ? scope : 'narrow',
    complexity: complexity === 'low' || complexity === 'medium' || complexity === 'high' || complexity === 'very_high' ? complexity : 'low',
    ambiguity: ambiguity === 'low' || ambiguity === 'medium' || ambiguity === 'high' ? ambiguity : 'medium',
    missingCategoryKeys,
    recommendedInitialCount: Math.round(recommendedInitialCount),
    followupCap,
    plannedQuestionBudget,
    actualQuestionsAsked,
    ...(actualAnswersReceived != null ? { actualAnswersReceived } : {}),
    softQuestionBudget,
    hardQuestionCap,
    coverageArtifact,
  };
}

export function buildDiscoveryCoverageArtifact(input: {
  missingCategoryKeys: ClarifyCategoryKey[];
  plannedQuestionBudget: number;
  actualQuestionsAsked: number;
  actualAnswersReceived?: number;
  askedCategoryKeys?: ClarifyCategoryKey[];
  openNonBlockingDecisions?: string[];
}): DiscoveryCoverageArtifact {
  const mustResolveThemes = uniqueCategoryKeys(input.missingCategoryKeys).map((key) => labelForCategoryKey(key));
  const askedCategoryKeys = uniqueCategoryKeys(input.askedCategoryKeys ?? []);
  const coveredThemes = (askedCategoryKeys.length
    ? askedCategoryKeys
    : CLARIFY_CATEGORY_ORDER.filter((key) => !input.missingCategoryKeys.includes(key)))
    .map((key) => labelForCategoryKey(key));
  const openNonBlockingDecisions = uniqueStrings(input.openNonBlockingDecisions ?? []);
  return {
    mustResolveThemes,
    optionalThemes: [],
    coveredThemes,
    ...(askedCategoryKeys.length
      ? {
          askedCategoryKeys,
          askedThemes: askedCategoryKeys.map((key) => labelForCategoryKey(key)),
        }
      : {}),
    openBlockingThemes: mustResolveThemes,
    openNonBlockingDecisions,
    plannedQuestionBudget: Math.max(0, Math.round(input.plannedQuestionBudget)),
    actualQuestionsAsked: Math.max(0, Math.round(input.actualQuestionsAsked)),
    ...(input.actualAnswersReceived != null
      ? { actualAnswersReceived: Math.max(0, Math.round(input.actualAnswersReceived)) }
      : {}),
  };
}

// ─── Discovery Validation & Finalization ──────────────────────────────────────

export function validateAndRepairInitialDiscovery(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
  triageRecommendedInitial?: number | null,
): {
  questions: ClarifyQuestion[];
  discoveryProfile: DiscoveryProfile;
  repairApplied: boolean;
  failureReasonCode: ClarifyFailureReasonCode | null;
} {
  const explicitZeroQuestionDiscovery =
    questions.length === 0
    && profile.recommendedInitialCount === 0
    && profile.ambiguity === 'low'
    && profile.missingCategoryKeys.length === 0;

  if (explicitZeroQuestionDiscovery) {
    return { questions: [], discoveryProfile: profile, repairApplied: false, failureReasonCode: null };
  }

  if (!questions.length) {
    return {
      questions: [],
      discoveryProfile: profile,
      repairApplied: false,
      failureReasonCode: 'question_array_empty_when_discovery_required',
    };
  }

  let finalizedQuestions = finalizeInitialDiscoveryQuestions(questions, profile);
  const budget = computeInitialQuestionBudget(profile, triageRecommendedInitial);
  const beforeCap = finalizedQuestions.length;
  if (finalizedQuestions.length > budget) {
    finalizedQuestions = selectDiverseInitialQuestions(finalizedQuestions, budget);
  }
  const repairApplied = questions.length !== finalizedQuestions.length || beforeCap !== finalizedQuestions.length;
  const failureReasonCode = finalizedQuestions.length === 0
    ? 'question_array_empty_when_discovery_required'
    : null;

  return {
    questions: finalizedQuestions,
    discoveryProfile: {
      ...profile,
      actualQuestionsAsked: finalizedQuestions.length,
      coverageArtifact: buildDiscoveryCoverageArtifact({
        missingCategoryKeys: profile.missingCategoryKeys,
        plannedQuestionBudget: profile.plannedQuestionBudget ?? profile.recommendedInitialCount,
        actualQuestionsAsked: finalizedQuestions.length,
        actualAnswersReceived: profile.actualAnswersReceived,
        askedCategoryKeys: finalizedQuestions.map((question) => question.categoryKey),
      }),
    },
    repairApplied,
    failureReasonCode,
  };
}

export function expandRawQuestionCandidate(raw: {
  categoryKey?: unknown;
  category?: unknown;
  intent?: unknown;
  question?: unknown;
  details?: unknown;
  suggestions?: unknown[];
}): ClarifyQuestion[] {
  const rawQuestion = cleanText(raw.question);
  if (!rawQuestion) return [];
  const categoryKey =
    normalizeCategoryKey(raw.categoryKey)
    ?? normalizeCategoryKey(raw.category)
    ?? inferCategoryKeyFromQuestion(rawQuestion);
  const baseSuggestions = Array.isArray(raw.suggestions)
    ? uniqueStrings(raw.suggestions).slice(0, 4)
    : [];
  const splitQuestions = splitGroupedQuestion(rawQuestion);
  const normalizedDetails = normalizeQuestionDetails(cleanText(raw.details));
  return splitQuestions
    .map((question, index): ClarifyQuestion | null => {
      const normalizedCopy = splitQuestionIntoPrimaryAndDetails(question);
      const normalizedQuestion = normalizedCopy.question;
      if (!normalizedQuestion) return null;
      const details = index === 0 ? (normalizedDetails ?? normalizedCopy.details) : normalizedCopy.details;
      return {
        categoryKey,
        category: labelForCategoryKey(categoryKey),
        intent: index === 0
          ? normalizeQuestionIntent(raw.intent, categoryKey)
          : `${normalizeQuestionIntent(raw.intent, categoryKey)}_part_${index + 1}`,
        question: normalizedQuestion,
        ...(details ? { details } : {}),
        suggestions: baseSuggestions,
      };
    })
    .filter((question): question is ClarifyQuestion => Boolean(question));
}

export function finalizeInitialDiscoveryQuestions(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
): ClarifyQuestion[] {
  void profile;
  return normalizeQuestions(questions, new Set<string>()).sort(questionComparator);
}

export function allowsZeroQuestionDiscovery(profile: DiscoveryProfile): boolean {
  return profile.recommendedInitialCount === 0
    && profile.ambiguity === 'low'
    && profile.missingCategoryKeys.length === 0;
}

export function finalizeFollowupDiscoveryQuestions(
  questions: ClarifyQuestion[],
  opts: {
    askedQuestions: string[];
    askedCategoryKeys?: ClarifyCategoryKey[];
    missingCategoryKeys: ClarifyCategoryKey[];
    followupCap: number;
    initialQuestionCount: number;
  },
): ClarifyQuestion[] {
  const maxFollowup = Math.max(0, Math.round(opts.followupCap));
  if (maxFollowup <= 0) return [];
  const alreadyAskedCategories = new Set<string>((opts.askedCategoryKeys ?? []).filter(Boolean));
  const asked = new Set(opts.askedQuestions.map(normalizeKey).filter(Boolean));
  const deduped = normalizeQuestions(questions, asked)
    .filter((q) => !alreadyAskedCategories.has(q.categoryKey))
    .sort(questionComparator);
  const result: ClarifyQuestion[] = [];
  const preferredCategories = uniqueCategoryKeys(opts.missingCategoryKeys).filter((key) => !alreadyAskedCategories.has(key));
  const addedQuestions = new Set<string>();
  preferredCategories.forEach((categoryKey) => {
    if (result.length >= maxFollowup) return;
    const existing = deduped.find((question) => question.categoryKey === categoryKey && !addedQuestions.has(normalizeKey(question.question)));
    if (!existing) return;
    addedQuestions.add(normalizeKey(existing.question));
    result.push(existing);
  });
  deduped.forEach((question) => {
    if (result.length >= maxFollowup) return;
    const key = normalizeKey(question.question);
    if (addedQuestions.has(key)) return;
    addedQuestions.add(key);
    result.push(question);
  });
  return result.slice(0, maxFollowup).sort(questionComparator);
}
