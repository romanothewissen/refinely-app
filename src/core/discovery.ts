import { ClarifyQuestion, DiscoveryProfile } from '../types';

export const MIN_INITIAL_DISCOVERY_QUESTIONS = 5;
export const MAX_INITIAL_DISCOVERY_QUESTIONS = 10;
export const MIN_FOLLOWUP_DISCOVERY_QUESTIONS = 2;
export const MAX_FOLLOWUP_DISCOVERY_QUESTIONS = 5;
export const MAX_TOTAL_DISCOVERY_QUESTIONS = 15;

type FallbackTemplate = {
  dimension: string;
  category: string;
  question: string;
  suggestions: string[];
};

const GENERIC_DISCOVERY_TEMPLATES: FallbackTemplate[] = [
  {
    dimension: 'Objective & Outcome',
    category: 'Objective & Outcome',
    question: 'What concrete outcome should this request achieve beyond the high-level improvement or change that has been described so far?',
    suggestions: ['Clear business result', 'Faster completion', 'Higher quality', 'Better visibility'],
  },
  {
    dimension: 'Actors & Ownership',
    category: 'Actors & Ownership',
    question: 'Which people, teams, or user groups need to initiate this, own decisions within it, or be directly affected by the outcome?',
    suggestions: ['Single actor group', 'Multiple actor groups', 'Shared ownership', 'Still unclear'],
  },
  {
    dimension: 'Trigger & Context',
    category: 'Trigger & Context',
    question: 'What event, condition, or business context should cause this to happen, and when should it apply versus stay inactive?',
    suggestions: ['Manual trigger', 'Automatic trigger', 'Scheduled trigger', 'Context dependent'],
  },
  {
    dimension: 'Inputs & Data',
    category: 'Inputs & Data',
    question: 'What information, signals, or inputs must be available for this to work correctly, and which of them are essential versus optional?',
    suggestions: ['Single required input', 'Several required inputs', 'Optional supporting inputs', 'Still being defined'],
  },
  {
    dimension: 'Workflow & Decisions',
    category: 'Workflow & Decisions',
    question: 'What are the main steps or decision points this should follow from start to finish once the request is in motion?',
    suggestions: ['Straight-through flow', 'Several decision points', 'Manual review step', 'Branching workflow'],
  },
  {
    dimension: 'Rules & Constraints',
    category: 'Rules & Constraints',
    question: 'Which business rules, limits, priorities, or constraints must always be enforced so the behavior is considered correct?',
    suggestions: ['Priority rules', 'Eligibility rules', 'Approval constraints', 'None defined yet'],
  },
  {
    dimension: 'Exceptions & Failure Modes',
    category: 'Exceptions & Failure Modes',
    question: 'What edge cases, conflicts, invalid states, or failures should be handled explicitly instead of following the normal path?',
    suggestions: ['Validation failures', 'Conflicting inputs', 'Missing data', 'Fallback path needed'],
  },
  {
    dimension: 'Dependencies & Boundaries',
    category: 'Dependencies & Boundaries',
    question: 'What dependencies, handoffs, or scope boundaries need to be respected so this request stays complete without expanding beyond intent?',
    suggestions: ['Depends on another process', 'Needs upstream input', 'Needs downstream handoff', 'Scope boundary unclear'],
  },
  {
    dimension: 'Success Criteria',
    category: 'Success Criteria',
    question: 'How should success be judged once this is delivered, and what would tell us that the result is acceptable in practice?',
    suggestions: ['Business KPI', 'Adoption signal', 'Quality threshold', 'Operational outcome'],
  },
];

function clampCount(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

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

function normalizeDimension(value: string): string {
  const normalized = normalizeKey(value);
  const template = GENERIC_DISCOVERY_TEMPLATES.find((candidate) => {
    const candidateKey = normalizeKey(candidate.dimension);
    return normalized === candidateKey || normalized.includes(candidateKey) || candidateKey.includes(normalized);
  });
  return template?.dimension ?? cleanText(value);
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

function dedupeQuestions(
  questions: ClarifyQuestion[],
  alreadyAsked: Set<string>,
): ClarifyQuestion[] {
  const seen = new Set(alreadyAsked);
  const result: ClarifyQuestion[] = [];

  questions.forEach((question) => {
    const cleanedQuestion = cleanText(question.question);
    if (!cleanedQuestion) return;
    const key = normalizeKey(cleanedQuestion);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({
      category: cleanText(question.category) || 'Discovery',
      question: cleanedQuestion,
      suggestions: uniqueStrings(question.suggestions).slice(0, 4),
    });
  });

  return result;
}

function fallbackTemplatesForDimensions(missingDimensions: string[]): FallbackTemplate[] {
  const normalizedDimensions = missingDimensions.map(normalizeDimension).filter(Boolean);
  const preferred = normalizedDimensions
    .map((dimension) => GENERIC_DISCOVERY_TEMPLATES.find((template) => template.dimension === dimension))
    .filter((template): template is FallbackTemplate => Boolean(template));

  const remaining = GENERIC_DISCOVERY_TEMPLATES.filter(
    (template) => !preferred.some((picked) => picked.dimension === template.dimension),
  );

  return [...preferred, ...remaining];
}

function fallbackQuestions(
  missingDimensions: string[],
  alreadyAsked: Set<string>,
  needed: number,
): ClarifyQuestion[] {
  if (needed <= 0) return [];

  const questions: ClarifyQuestion[] = [];
  for (const template of fallbackTemplatesForDimensions(missingDimensions)) {
    const key = normalizeKey(template.question);
    if (!key || alreadyAsked.has(key)) continue;
    alreadyAsked.add(key);
    questions.push({
      category: template.category,
      question: template.question,
      suggestions: [...template.suggestions],
    });
    if (questions.length >= needed) break;
  }

  return questions;
}

export function normalizeDiscoveryProfile(
  candidate?: Partial<DiscoveryProfile> | null,
  fallbackQuestionCount = 7,
): DiscoveryProfile {
  const scope = cleanText(candidate?.scope).toLowerCase();
  const complexity = cleanText(candidate?.complexity).toLowerCase();
  const ambiguity = cleanText(candidate?.ambiguity).toLowerCase();
  const recommendedInitialCount = clampCount(
    Number.isFinite(candidate?.recommendedInitialCount)
      ? Number(candidate?.recommendedInitialCount)
      : fallbackQuestionCount,
    MIN_INITIAL_DISCOVERY_QUESTIONS,
    MAX_INITIAL_DISCOVERY_QUESTIONS,
  );

  return {
    scope: scope === 'narrow' || scope === 'moderate' || scope === 'broad' || scope === 'very_broad'
      ? scope
      : 'moderate',
    complexity: complexity === 'low' || complexity === 'medium' || complexity === 'high' || complexity === 'very_high'
      ? complexity
      : 'medium',
    ambiguity: ambiguity === 'low' || ambiguity === 'medium' || ambiguity === 'high'
      ? ambiguity
      : 'medium',
    missingDimensions: uniqueStrings((candidate?.missingDimensions ?? []).map(normalizeDimension)),
    recommendedInitialCount,
    followupCap: clampCount(
      Number.isFinite(candidate?.followupCap) ? Number(candidate?.followupCap) : 3,
      MIN_FOLLOWUP_DISCOVERY_QUESTIONS,
      MAX_FOLLOWUP_DISCOVERY_QUESTIONS,
    ),
  };
}

export function finalizeInitialDiscoveryQuestions(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
): ClarifyQuestion[] {
  const targetCount = clampCount(
    profile.recommendedInitialCount,
    MIN_INITIAL_DISCOVERY_QUESTIONS,
    MAX_INITIAL_DISCOVERY_QUESTIONS,
  );
  const deduped = dedupeQuestions(questions, new Set<string>());

  if (deduped.length >= targetCount) {
    return deduped.slice(0, targetCount);
  }

  const asked = new Set(deduped.map((question) => normalizeKey(question.question)));
  return [
    ...deduped,
    ...fallbackQuestions(profile.missingDimensions, asked, targetCount - deduped.length),
  ].slice(0, targetCount);
}

export function finalizeFollowupDiscoveryQuestions(
  questions: ClarifyQuestion[],
  opts: {
    askedQuestions: string[];
    missingDimensions: string[];
    followupCap: number;
    initialQuestionCount: number;
  },
): ClarifyQuestion[] {
  const remainingBudget = Math.max(0, MAX_TOTAL_DISCOVERY_QUESTIONS - opts.initialQuestionCount);
  if (remainingBudget <= 0) return [];

  const maxFollowup = Math.min(
    remainingBudget,
    clampCount(opts.followupCap, MIN_FOLLOWUP_DISCOVERY_QUESTIONS, MAX_FOLLOWUP_DISCOVERY_QUESTIONS),
  );
  if (maxFollowup <= 0) return [];

  const asked = new Set(opts.askedQuestions.map(normalizeKey).filter(Boolean));
  const deduped = dedupeQuestions(questions, asked);
  const limited = deduped.slice(0, maxFollowup);

  if (limited.length >= Math.min(MIN_FOLLOWUP_DISCOVERY_QUESTIONS, maxFollowup)) {
    return limited;
  }

  return [
    ...limited,
    ...fallbackQuestions(
      opts.missingDimensions,
      new Set([...asked, ...limited.map((question) => normalizeKey(question.question))]),
      maxFollowup - limited.length,
    ),
  ].slice(0, maxFollowup);
}
