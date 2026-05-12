import type { V3AcceptanceRequirement, V3PipelineResult } from './contracts';
import { normalizeText } from './text';

export interface V3ScoreDimension {
  id: string;
  label: string;
  score: number;
  note: string;
}

export interface V3JsaBenchmark {
  id: string;
  label: string;
  requirementIncludes?: string[];
  jsaText?: string;
  expectedFeatureRange?: {
    min: number;
    max: number;
  };
  requiredTerms?: string[];
  expectedScenarioTerms?: string[];
  questionOnlyTerms?: string[];
  prohibitedOverreachTerms?: string[];
  minimumAverageAcceptanceRequirements?: number;
  expectedOpenQuestionTerms?: string[];
  notes?: string[];
}

export interface V3JsaComparison {
  featureCount: number;
  acceptanceRequirementCount: number;
  signals: string[];
  alignmentScore: number;
  missingSignals: string[];
  missingRequiredTerms: string[];
  missingScenarioTerms: string[];
  prohibitedTermsFound: string[];
  questionOnlyTermsFound: string[];
  suggestedOpenQuestions: string[];
  vagueAcceptanceRequirementCount: number;
  notes: string[];
  benchmarkId?: string;
  benchmarkLabel?: string;
}

export interface V3QualityScore {
  overall: number;
  dimensions: V3ScoreDimension[];
  expectedCapabilityCoverage: Array<{
    id: string;
    label: string;
    covered: boolean;
    requiredTerms?: string[];
    coveredTerms?: string[];
  }>;
  counts: {
    features: number;
    acceptanceRequirements: number;
    evidenceRefs: number;
    openQuestions: number;
  };
  qualityWarnings: string[];
  jsaComparison?: V3JsaComparison;
}

interface RequirementSignal {
  id: string;
  label: string;
  terms: string[];
}

const GENERIC_OUTCOME = /\b(delivers part of the stated business requirement|intended business outcome|measurable business outcome|proper execution|all specified|necessary operational records|relevant details|supports the required business outcome|comprehensive planning|diverse needs|plan'?s details)\b/i;
const OUTCOME_VERB = /\b(can|allows?|captures?|records?|creates?|created|generated?|generates?|produced?|includes?|lists?|prevents?|blocks?|displays?|shows?|routes?|notifies?|reserves?|requires?|marks?|updates?|calculates?|reflects?|derives?|identifies?|surfaces?|pauses?|rejects?|approves?)\b/i;
const DOMAIN_TERM_STOP_WORDS = new Set([
  'able',
  'about',
  'action',
  'actions',
  'after',
  'again',
  'all',
  'also',
  'and',
  'are',
  'before',
  'being',
  'business',
  'can',
  'complex',
  'customer',
  'details',
  'each',
  'etc',
  'eventually',
  'from',
  'include',
  'included',
  'includes',
  'into',
  'like',
  'need',
  'needed',
  'needs',
  'other',
  'single',
  'that',
  'the',
  'then',
  'through',
  'to',
  'various',
  'when',
  'with',
]);

const SIGNAL_DEFINITIONS: Array<{
  id: string;
  label: string;
  phrases: string[];
}> = [
  {
    id: 'lifecycle',
    label: 'Lifecycle or workflow stages',
    phrases: ['create', 'created', 'define', 'plan', 'submit', 'review', 'approve', 'reject', 'finalize', 'generate', 'initiate', 'update', 'modify', 'complete', 'start', 'return'],
  },
  {
    id: 'resources',
    label: 'Resources, effort, or materials',
    phrases: ['resource', 'resources', 'materials', 'parts', 'labor', 'capacity', 'inventory', 'equipment', 'staff', 'location', 'locations', 'hours', 'costs', 'budget'],
  },
  {
    id: 'decisions',
    label: 'Business decisions or rules',
    phrases: ['approve', 'approval', 'decision', 'review', 'validate', 'validation', 'rule', 'rules', 'eligibility', 'entitlement', 'authorization'],
  },
  {
    id: 'exceptions',
    label: 'Exceptions or constraints',
    phrases: ['unless', 'missing', 'unavailable', 'invalid', 'conflict', 'conflicting', 'exception', 'fail', 'fails', 'reject', 'rejected', 'prevent', 'pause'],
  },
  {
    id: 'outputs',
    label: 'Business outputs or artifacts',
    phrases: ['quote', 'estimate', 'invoice', 'report', 'document', 'dashboard', 'summary', 'notification', 'message', 'export'],
  },
  {
    id: 'records_integrations',
    label: 'Records, integrations, or handoffs',
    phrases: ['record', 'records', 'ticket', 'issue', 'case', 'order', 'orders', 'shipment', 'shipments', 'work order', 'return authorization', 'jira', 'crm', 'erp'],
  },
  {
    id: 'status',
    label: 'Status or progress visibility',
    phrases: ['status', 'progress', 'track', 'tracking', 'visibility', 'monitor', 'state'],
  },
  {
    id: 'downstream',
    label: 'Downstream or follow-up actions',
    phrases: ['follow up', 'follow-up', 'downstream', 'follow on', 'follow-on', 'trigger', 'derive', 'derived', 'initiate', 'created like'],
  },
];

export function scoreV3Result(result: V3PipelineResult, jsaText?: string, benchmark?: V3JsaBenchmark): V3QualityScore {
  const featureText = buildFeatureText(result);
  const normalizedFeatureText = normalizeText(featureText);
  const signals = deriveRequirementSignals(result.requirement);
  const coverage = signals.map((signal) => {
    const coveredTerms = signal.terms.filter((term) => textIncludesTerm(normalizedFeatureText, term));
    return {
      id: signal.id,
      label: signal.label,
      covered: signalCovered(signal, coveredTerms),
      requiredTerms: signal.terms,
      coveredTerms,
    };
  });

  const arCount = result.draft.features.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0);
  const acceptanceRequirements = result.draft.features.flatMap((feature) => feature.acceptanceRequirements);
  const evidenceRefs = result.draft.features.reduce(
    (sum, feature) => sum + feature.evidenceRefs.length + feature.acceptanceRequirements.reduce((arSum, ar) => arSum + (ar.evidenceRefs?.length ?? 0), 0),
    0,
  );
  const openQuestions = result.draft.features.reduce((sum, feature) => sum + feature.openQuestions.length, result.draft.blockingQuestions.length);

  const contextOverreachIssues = countIssues(result, 'context_overreach');
  const roleIssues = countIssues(result, 'unsupported_role_in_ar');
  const solutionIssues = countIssues(result, 'solution_language') + countIssues(result, 'technical_language');
  const confidenceIssues = countIssues(result, 'confidence_mismatch');
  const genericOutcomeIssues = countIssues(result, 'generic_outcome');
  const thinRequirementIssues = countIssues(result, 'thin_acceptance_requirement');
  const vagueRequirementIssues = countIssues(result, 'vague_acceptance_requirement');
  const duplicateRequirementIssues = countIssues(result, 'duplicate_acceptance_requirement');
  const duplicateArCount = countDuplicateAcceptanceRequirements(acceptanceRequirements);
  const genericArCount = acceptanceRequirements.filter((ar) => GENERIC_OUTCOME.test(`${ar.given} ${ar.when} ${ar.then}`)).length + genericOutcomeIssues;
  const thinArCount = acceptanceRequirements.filter(isThinAcceptanceRequirement).length + thinRequirementIssues + vagueRequirementIssues;
  const specificOutcomeCount = acceptanceRequirements.filter((ar) => hasSpecificOutcome(ar.then, result.requirement)).length;

  const coverageScore = coverage.length ? Math.round((coverage.filter((item) => item.covered).length / coverage.length) * 100) : 100;
  const featureUsefulnessScore = scoreFeatureUsefulness(result);
  const acceptanceSpecificityScore = arCount ? Math.max(0, Math.round((specificOutcomeCount / arCount) * 100) - genericArCount * 6 - thinArCount * 4) : 0;
  const duplicateThinScore = Math.max(0, 100 - duplicateArCount * 18 - duplicateRequirementIssues * 12 - genericArCount * 8 - thinArCount * 8);
  const hasGroundingContext = result.contextPack.sourceMix.workInstructionCards > 0
    || (result.contextPack.sourceMix.projectContextCards ?? 0) > 0
    || (result.contextPack.sourceMix.documentCards ?? 0) > 0
    || result.contextPack.sourceMix.backlogCards > 0;
  const groundingBase = hasGroundingContext
    ? Math.min(100, Math.round(
      (evidenceRefs / Math.max(arCount, 1)) * 45
      + (result.contextPack.sourceMix.workInstructionCards ? 20 : 0)
      + (result.contextPack.sourceMix.projectContextCards ? 15 : 0)
      + (result.contextPack.sourceMix.documentCards ? 20 : 0)
      + (result.contextPack.sourceMix.backlogCards ? 10 : 0)
      + 10,
    ))
    : 100;
  const groundingScore = contextOverreachIssues
    ? Math.min(groundingBase, 55)
    : solutionIssues || roleIssues
      ? Math.min(groundingBase, 75)
      : groundingBase;
  const openQuestionScore = scoreOpenQuestionDiscipline(result, benchmark);
  const comparison = (jsaText?.trim() || benchmark) ? analyzeJsaText(result, jsaText || benchmark?.jsaText || '', benchmark, coverage) : undefined;
  const benchmarkScore = comparison?.alignmentScore ?? coverageScore;
  const validationScore = result.validation.passed ? 100 : Math.max(40, 100 - result.validation.issues.length * 10);

  const dimensions: V3ScoreDimension[] = [
    { id: 'coverage', label: 'Requirement Signal Coverage', score: coverageScore, note: `${coverage.filter((item) => item.covered).length}/${coverage.length || 0} requirement-derived signal(s) covered.` },
    { id: 'feature_usefulness', label: 'Feature Usefulness', score: featureUsefulnessScore, note: `${result.draft.features.length} feature(s), scored for concrete boundaries and AR depth.` },
    { id: 'acceptance_specificity', label: 'Acceptance Specificity', score: acceptanceSpecificityScore, note: `${specificOutcomeCount}/${arCount} THEN statements name concrete requirement-derived outcomes.` },
    { id: 'duplicate_thin_ar', label: 'Duplicate/Thin AR Discipline', score: duplicateThinScore, note: `${duplicateArCount + duplicateRequirementIssues} duplicate, ${thinArCount} thin, and ${genericArCount} generic AR signal(s).` },
    { id: 'grounding', label: 'Grounding Discipline', score: groundingScore, note: contextOverreachIssues ? `${evidenceRefs} evidence refs, capped for context overreach.` : `${evidenceRefs} evidence refs with ${roleIssues + solutionIssues} role/solution issue(s).` },
    { id: 'open_questions', label: 'Open Question Discipline', score: openQuestionScore, note: openQuestions ? `${openQuestions} open question(s), confidence ${result.draft.confidence}.` : `No open questions, confidence ${result.draft.confidence}.` },
    { id: 'jsa_alignment', label: 'JSA Alignment', score: benchmarkScore, note: comparison ? comparison.notes[0] || 'Compared with JSA benchmark signals.' : 'No JSA benchmark provided; using requirement signal coverage.' },
    { id: 'validation', label: 'Validator', score: validationScore, note: result.validation.passed ? 'No validator issues.' : `${result.validation.issues.length} validator issue(s).` },
  ];

  const qualityWarnings = buildQualityWarnings({
    contextOverreachIssues,
    roleIssues,
    solutionIssues,
    confidenceIssues,
    genericArCount,
    thinArCount,
    vagueRequirementIssues,
    duplicateArCount: duplicateArCount + duplicateRequirementIssues,
    prohibitedTermsFound: comparison?.prohibitedTermsFound ?? [],
    missingRequiredTerms: comparison?.missingRequiredTerms ?? [],
    missingScenarioTerms: comparison?.missingScenarioTerms ?? [],
    questionOnlyTermsFound: comparison?.questionOnlyTermsFound ?? [],
  });
  const uncappedOverall = Math.round(dimensions.reduce((sum, item) => sum + item.score, 0) / dimensions.length);
  const overall = applyQualityCaps(uncappedOverall, {
    validationPassed: result.validation.passed,
    contextOverreachIssues,
    confidenceIssues,
    genericArCount,
    thinArCount,
    duplicateArCount: duplicateArCount + duplicateRequirementIssues,
    prohibitedTermsFound: comparison?.prohibitedTermsFound.length ?? 0,
    questionOnlyTermsFound: comparison?.questionOnlyTermsFound.length ?? 0,
  });

  return {
    overall,
    dimensions,
    expectedCapabilityCoverage: coverage,
    counts: {
      features: result.draft.features.length,
      acceptanceRequirements: arCount,
      evidenceRefs,
      openQuestions,
    },
    qualityWarnings,
    ...(comparison ? { jsaComparison: comparison } : {}),
  };
}

function buildFeatureText(result: V3PipelineResult): string {
  return result.draft.features.map((feature) => [
    feature.summary,
    feature.businessOutcome,
    feature.description,
    ...feature.openQuestions,
    ...feature.acceptanceRequirements.flatMap((ar) => [ar.given, ar.when, ar.then]),
  ].join(' ')).join('\n');
}

function buildAcceptanceRequirementText(result: V3PipelineResult): string {
  return result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');
}

function buildOpenQuestionText(result: V3PipelineResult): string {
  return [
    ...result.draft.blockingQuestions,
    ...result.draft.features.flatMap((feature) => feature.openQuestions),
    ...result.capabilityPlan.openQuestions,
  ].join('\n');
}

function deriveRequirementSignals(requirement: string): RequirementSignal[] {
  const signals: RequirementSignal[] = [];
  const actorTerms = extractActors(requirement);
  if (actorTerms.length) signals.push({ id: 'actors', label: 'Actors or accountable roles', terms: actorTerms });

  const businessObjectTerms = extractDomainTerms(requirement).slice(0, 10);
  if (businessObjectTerms.length) signals.push({ id: 'business_objects', label: 'Core business objects', terms: businessObjectTerms });

  for (const definition of SIGNAL_DEFINITIONS) {
    const terms = definition.phrases.filter((phrase) => hasRequirementPhrase(requirement, phrase));
    if (terms.length) {
      signals.push({
        id: definition.id,
        label: definition.label,
        terms: Array.from(new Set(terms.map((term) => term.replace(/-/g, ' ')))),
      });
    }
  }

  return dedupeSignals(signals);
}

function extractActors(requirement: string): string[] {
  const actors = new Set<string>();
  const asAMatch = requirement.match(/\bas a[n]?\s+([^,.\n]+),\s*i need\b/i);
  if (asAMatch?.[1]) actors.add(asAMatch[1].trim());
  const allowMatch = requirement.match(/\ballow\s+([^,.]+?)\s+to\s+/i);
  if (allowMatch?.[1]) actors.add(allowMatch[1].trim());
  return Array.from(actors);
}

function extractDomainTerms(requirement: string): string[] {
  const normalized = normalizeText(requirement);
  const tokens = normalized
    .split(' ')
    .filter((token) => token.length >= 4 && !DOMAIN_TERM_STOP_WORDS.has(token));
  const ordered = new Set<string>();

  for (let index = 0; index < tokens.length; index += 1) {
    ordered.add(tokens[index]);
    if (tokens[index + 1] && !DOMAIN_TERM_STOP_WORDS.has(tokens[index + 1])) {
      const phrase = `${tokens[index]} ${tokens[index + 1]}`;
      if (phrase.length <= 32) ordered.add(phrase);
    }
  }

  return Array.from(ordered).filter((term) => !/^(able|eventually)$/.test(term));
}

function hasRequirementPhrase(requirement: string, phrase: string): boolean {
  return normalizeText(requirement).includes(normalizeText(phrase));
}

function dedupeSignals(signals: RequirementSignal[]): RequirementSignal[] {
  const byId = new Map<string, RequirementSignal>();
  for (const signal of signals) {
    const existing = byId.get(signal.id);
    if (!existing) {
      byId.set(signal.id, { ...signal, terms: Array.from(new Set(signal.terms)) });
      continue;
    }
    existing.terms = Array.from(new Set([...existing.terms, ...signal.terms]));
  }
  return Array.from(byId.values());
}

function signalCovered(signal: RequirementSignal, coveredTerms: string[]): boolean {
  if (!signal.terms.length) return true;
  if (signal.id === 'business_objects') return coveredTerms.length >= Math.min(3, signal.terms.length);
  return coveredTerms.length >= Math.max(1, Math.ceil(signal.terms.length * 0.4));
}

function scoreFeatureUsefulness(result: V3PipelineResult): number {
  if (!result.draft.features.length) return 0;
  const minimumArs = 1;
  const useful = result.draft.features.filter((feature) => {
    if (GENERIC_OUTCOME.test(feature.businessOutcome) || GENERIC_OUTCOME.test(feature.summary)) return false;
    if (feature.summary.trim().length < 8 || feature.businessOutcome.trim().length < 16) return false;
    if (feature.acceptanceRequirements.length < minimumArs) return false;
    return feature.acceptanceRequirements.some((ar) => hasSpecificOutcome(ar.then, result.requirement));
  }).length;
  return Math.round((useful / result.draft.features.length) * 100);
}

function scoreOpenQuestionDiscipline(result: V3PipelineResult, benchmark?: V3JsaBenchmark): number {
  const openQuestionText = normalizeText([
    ...result.draft.blockingQuestions,
    ...result.draft.features.flatMap((feature) => feature.openQuestions),
  ].join(' '));
  const openQuestionCount = result.draft.blockingQuestions.length
    + result.draft.features.reduce((sum, feature) => sum + feature.openQuestions.length, 0);

  if (result.draft.confidence === 'high' && openQuestionCount > 0) return 45;
  if (benchmark?.expectedOpenQuestionTerms?.length) {
    const covered = benchmark.expectedOpenQuestionTerms.filter((term) => openQuestionText.includes(normalizeText(term))).length;
    return Math.max(45, Math.round((covered / benchmark.expectedOpenQuestionTerms.length) * 100));
  }
  if (openQuestionCount > 5) return 70;
  return result.draft.confidence === 'high' ? 100 : 85;
}

function analyzeJsaText(
  result: V3PipelineResult,
  text: string,
  benchmark: V3JsaBenchmark | undefined,
  coverage: V3QualityScore['expectedCapabilityCoverage'],
): V3JsaComparison {
  const normalizedJsa = normalizeText(text);
  const featureText = normalizeText(buildAcceptanceRequirementText(result));
  const openQuestionText = normalizeText(buildOpenQuestionText(result));
  const personaStoryCount = (text.match(/\bAs a[n]?\s+[^,\n]+,\s+I need\b/gi) ?? []).length;
  const tabularFeatureCount = (text.match(/^\s*\d+\s*\n[^\n]+\n\d+(?:\.\d+)+\n\d+\nAs a/gi) ?? []).length;
  const featureCount = personaStoryCount || tabularFeatureCount;
  const acceptanceRequirementCount = (text.match(/\bGIVEN\b/gi) ?? []).length;
  const signals = coverage
    .filter((item) => item.requiredTerms?.some((term) => textIncludesTerm(normalizedJsa, term)))
    .map((item) => item.label);
  const missingSignals = coverage.filter((item) => !item.covered).map((item) => item.label);
  const requiredTerms = benchmark?.requiredTerms ?? coverage.flatMap((item) => item.requiredTerms ?? []);
  const missingRequiredTerms = Array.from(new Set(requiredTerms.filter((term) => !textIncludesTerm(featureText, term))));
  const scenarioTerms = benchmark?.expectedScenarioTerms ?? [];
  const missingScenarioTerms = Array.from(new Set(scenarioTerms.filter((term) => !textIncludesTerm(featureText, term))));
  const prohibitedTermsFound = Array.from(new Set((benchmark?.prohibitedOverreachTerms ?? []).filter((term) => textIncludesTerm(featureText, term))));
  const questionOnlyTerms = benchmark?.questionOnlyTerms ?? [];
  const questionOnlyTermsFound = Array.from(new Set(questionOnlyTerms.filter((term) => textIncludesTerm(featureText, term))));
  const questionOnlyTermsMissingFromQuestions = Array.from(new Set(questionOnlyTerms.filter((term) =>
    !textIncludesTerm(openQuestionText, term)
    && !textIncludesTerm(featureText, term))));
  const suggestedOpenQuestions = questionOnlyTermsMissingFromQuestions.map((term) => suggestedQuestionForTerm(term));
  const vagueAcceptanceRequirementCount = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .filter(isVagueAcceptanceRequirement)
    .length + countIssues(result, 'vague_acceptance_requirement');
  const notes: string[] = [];

  const featureRangeScore = benchmark?.expectedFeatureRange
    ? scoreFeatureRange(result.draft.features.length, benchmark.expectedFeatureRange.min, benchmark.expectedFeatureRange.max)
    : 100;
  const averageArs = result.draft.features.length ? result.draft.features.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0) / result.draft.features.length : 0;
  const arDepthScore = benchmark?.minimumAverageAcceptanceRequirements
    ? Math.min(100, Math.round((averageArs / benchmark.minimumAverageAcceptanceRequirements) * 100))
    : 100;
  const requiredTermScore = requiredTerms.length ? Math.round(((requiredTerms.length - missingRequiredTerms.length) / requiredTerms.length) * 100) : 100;
  const scenarioScore = scenarioTerms.length ? Math.round(((scenarioTerms.length - missingScenarioTerms.length) / scenarioTerms.length) * 100) : 100;
  const questionOnlyScore = questionOnlyTerms.length
    ? Math.round(((questionOnlyTerms.length - questionOnlyTermsFound.length - questionOnlyTermsMissingFromQuestions.length) / questionOnlyTerms.length) * 100)
    : 100;
  const signalScore = coverage.length ? Math.round((coverage.filter((item) => item.covered).length / coverage.length) * 100) : 100;
  const overreachPenalty = prohibitedTermsFound.length ? Math.min(55, prohibitedTermsFound.length * 18) : 0;
  const vaguePenalty = Math.min(25, vagueAcceptanceRequirementCount * 5);
  const alignmentScore = Math.max(0, Math.round((featureRangeScore + arDepthScore + requiredTermScore + signalScore + scenarioScore + Math.max(0, questionOnlyScore)) / 6) - overreachPenalty - vaguePenalty);

  notes.push(benchmark
    ? `${benchmark.label}: ${requiredTerms.length - missingRequiredTerms.length}/${requiredTerms.length} required term(s), ${scenarioTerms.length - missingScenarioTerms.length}/${scenarioTerms.length || 0} scenario term(s), ${questionOnlyTermsFound.length} question-only overreach term(s).`
    : `${signals.length} JSA signal(s) detected from pasted output.`);
  if (featureCount) notes.push(`Pasted JSA has ${featureCount} feature signal(s) and ${acceptanceRequirementCount} GIVEN clause(s).`);
  if (missingRequiredTerms.length) notes.push(`Missing terms: ${missingRequiredTerms.slice(0, 5).join(', ')}.`);
  if (missingScenarioTerms.length) notes.push(`Missing scenario terms: ${missingScenarioTerms.slice(0, 5).join(', ')}.`);
  if (prohibitedTermsFound.length) notes.push(`Overreach terms found: ${prohibitedTermsFound.slice(0, 5).join(', ')}.`);
  if (questionOnlyTermsFound.length) notes.push(`Question-only terms used as requirements: ${questionOnlyTermsFound.slice(0, 5).join(', ')}.`);
  if (suggestedOpenQuestions.length) notes.push(`Suggested open questions: ${suggestedOpenQuestions.slice(0, 3).join(' | ')}.`);

  return {
    featureCount,
    acceptanceRequirementCount,
    signals,
    alignmentScore,
    missingSignals,
    missingRequiredTerms,
    missingScenarioTerms,
    prohibitedTermsFound,
    questionOnlyTermsFound,
    suggestedOpenQuestions,
    vagueAcceptanceRequirementCount,
    notes,
    benchmarkId: benchmark?.id,
    benchmarkLabel: benchmark?.label,
  };
}

function scoreFeatureRange(actual: number, min: number, max: number): number {
  if (actual >= min && actual <= max) return 100;
  if (actual < min) return Math.max(0, Math.round((actual / min) * 100));
  return Math.max(0, Math.round((max / actual) * 100));
}

function countIssues(result: V3PipelineResult, code: string): number {
  return result.validation.issues.filter((issue) => issue.code === code).length;
}

function countDuplicateAcceptanceRequirements(ars: V3AcceptanceRequirement[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const ar of ars) {
    const key = normalizeText(`${ar.given} ${ar.when} ${ar.then}`);
    if (seen.has(key)) duplicates += 1;
    seen.add(key);
  }
  return duplicates;
}

function isThinAcceptanceRequirement(ar: V3AcceptanceRequirement): boolean {
  const words = normalizeText(`${ar.given} ${ar.when} ${ar.then}`).split(' ').filter(Boolean);
  if (words.length < 14) return true;
  if (normalizeText(ar.then).split(' ').filter(Boolean).length < 6) return true;
  return GENERIC_OUTCOME.test(`${ar.given} ${ar.when} ${ar.then}`);
}

function isVagueAcceptanceRequirement(ar: V3AcceptanceRequirement): boolean {
  const normalizedThen = normalizeText(ar.then);
  if (!/\b(?:is|are|can be|remains?|remain)\s+(?:represented|visible|traceable|reflected|captured|derived|identified)\b/i.test(ar.then)) return false;
  const concreteTerms = [
    'activity',
    'approval',
    'billable',
    'blocked',
    'customer site',
    'de-installation',
    'dependency',
    'dependencies',
    'decision',
    'distinct line items',
    'equipment shipment',
    'exception',
    'in-house',
    'installation',
    'labor',
    'loaner',
    'location',
    'off-site',
    'order release',
    'parts',
    'quote',
    'repair',
    'request',
    'rule',
    'rules',
    'scope',
    'service facility',
    'shipment',
    'status',
    'temporary replacement',
    'unavailable equipment',
    'work order',
  ].filter((term) => normalizedThen.includes(normalizeText(term))).length;
  return /\btraceable\b/i.test(ar.then) ? concreteTerms < 2 : concreteTerms < 1;
}

function suggestedQuestionForTerm(term: string): string {
  if (/payment authorization/i.test(term)) return 'Should customer payment authorization be required before billable service execution or shipments proceed?';
  if (/return authorization/i.test(term)) return 'Should return authorization be created when customer equipment is sent to a service facility?';
  if (/preventive maintenance/i.test(term)) return 'Should preventive maintenance due dates be captured in this service plan scope?';
  if (/active/i.test(term)) return 'Should active multi-activity service plan changes be in scope after execution starts?';
  if (/completed activity/i.test(term)) return 'Which completed activity details must remain locked after execution?';
  if (/cancel/i.test(term)) return 'Should cancellation behavior apply to future service work from this requirement?';
  return `Should ${term} apply to this requirement?`;
}

function hasSpecificOutcome(then: string, requirement: string): boolean {
  if (GENERIC_OUTCOME.test(then)) return false;

  const normalizedThen = normalizeText(then);
  const requirementTerms = extractDomainTerms(requirement);
  const requirementHits = requirementTerms.filter((term) => textIncludesTerm(normalizedThen, term)).length;
  const concreteBusinessTerms = [
    'activity',
    'amount',
    'artifact',
    'authorization',
    'billable',
    'blocked',
    'condition',
    'customer site',
    'date',
    'de-installation',
    'decision',
    'document',
    'equipment shipment',
    'exception',
    'handoff',
    'installation',
    'item',
    'labor',
    'line item',
    'loaner',
    'location',
    'output',
    'part',
    'quote',
    'quantity',
    'record',
    'repair',
    'request',
    'resource',
    'role',
    'rule',
    'service facility',
    'shipment',
    'status',
    'task',
    'work order',
    'workflow',
  ].filter((term) => normalizedThen.includes(term)).length;

  return OUTCOME_VERB.test(then) && (requirementHits >= 2 || concreteBusinessTerms >= 2);
}

function textIncludesTerm(normalizedText: string, term: string): boolean {
  return termVariants(term).some((variant) => normalizedText.includes(variant));
}

function termVariants(term: string): string[] {
  const normalized = normalizeText(term);
  const variants = new Set<string>([normalized]);
  const parts = normalized.split(' ');
  const last = parts[parts.length - 1];
  if (normalized.startsWith('single ')) variants.add(normalized.replace(/^single /, 'one '));
  if (normalized.startsWith('one ')) variants.add(normalized.replace(/^one /, 'single '));
  if (normalized === 'single plan' || normalized === 'one plan') {
    variants.add('one service plan');
    variants.add('single service plan');
    variants.add('same service plan');
    variants.add('consolidated plan');
    variants.add('consolidated service plan');
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    variants.add('cancel');
    variants.add('cancellation');
    variants.add('cancellation behavior');
  }
  if (last) {
    if (last.endsWith('ies')) variants.add([...parts.slice(0, -1), `${last.slice(0, -3)}y`].join(' '));
    if (last.endsWith('s')) variants.add([...parts.slice(0, -1), last.slice(0, -1)].join(' '));
    if (!last.endsWith('s')) variants.add([...parts.slice(0, -1), `${last}s`].join(' '));
  }
  return Array.from(variants).filter(Boolean);
}

function buildQualityWarnings(input: {
  contextOverreachIssues: number;
  roleIssues: number;
  solutionIssues: number;
  confidenceIssues: number;
  genericArCount: number;
  thinArCount: number;
  vagueRequirementIssues: number;
  duplicateArCount: number;
  prohibitedTermsFound: string[];
  missingRequiredTerms: string[];
  missingScenarioTerms: string[];
  questionOnlyTermsFound: string[];
}): string[] {
  const warnings: string[] = [];
  if (input.prohibitedTermsFound.length) warnings.push(`Promoted adjacent context terms: ${input.prohibitedTermsFound.slice(0, 5).join(', ')}.`);
  if (input.questionOnlyTermsFound.length) warnings.push(`Question-only terms used as requirements: ${input.questionOnlyTermsFound.slice(0, 5).join(', ')}.`);
  if (input.missingRequiredTerms.length) warnings.push(`Missing benchmark terms: ${input.missingRequiredTerms.slice(0, 5).join(', ')}.`);
  if (input.missingScenarioTerms.length) warnings.push(`Missing JSA scenario terms: ${input.missingScenarioTerms.slice(0, 5).join(', ')}.`);
  if (input.contextOverreachIssues) warnings.push(`${input.contextOverreachIssues} context overreach issue(s).`);
  if (input.roleIssues) warnings.push(`${input.roleIssues} unsupported role issue(s).`);
  if (input.solutionIssues) warnings.push(`${input.solutionIssues} solution-language issue(s).`);
  if (input.confidenceIssues) warnings.push(`${input.confidenceIssues} confidence mismatch issue(s).`);
  if (input.duplicateArCount) warnings.push(`${input.duplicateArCount} duplicate acceptance requirement signal(s).`);
  if (input.thinArCount || input.genericArCount || input.vagueRequirementIssues) warnings.push(`${input.thinArCount} thin/vague and ${input.genericArCount} generic acceptance requirement signal(s).`);
  return warnings;
}

function applyQualityCaps(overall: number, input: {
  validationPassed: boolean;
  contextOverreachIssues: number;
  confidenceIssues: number;
  genericArCount: number;
  thinArCount: number;
  duplicateArCount: number;
  prohibitedTermsFound: number;
  questionOnlyTermsFound: number;
}): number {
  let capped = overall;
  if (!input.validationPassed) capped = Math.min(capped, 82);
  if (input.contextOverreachIssues) capped = Math.min(capped, 68);
  if (input.prohibitedTermsFound) capped = Math.min(capped, 62);
  if (input.questionOnlyTermsFound) capped = Math.min(capped, 70);
  if (input.confidenceIssues) capped = Math.min(capped, 76);
  if (input.duplicateArCount) capped = Math.min(capped, input.duplicateArCount > 2 ? 68 : 78);
  if (input.genericArCount >= 3 || input.thinArCount >= 4) capped = Math.min(capped, 70);
  return capped;
}
