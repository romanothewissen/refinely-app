import type {
  CanvasEditIntent,
  CoverageGap,
  CoverageGapCategory,
  EditRoutingDecision,
  Feature,
} from './types';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'being', 'between', 'both', 'by',
  'can', 'could', 'did', 'do', 'does', 'each', 'for', 'from', 'had', 'has', 'have', 'if', 'in',
  'into', 'is', 'it', 'its', 'may', 'might', 'must', 'no', 'not', 'of', 'on', 'or', 'our', 'so',
  'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'to', 'up', 'upon', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'will', 'with', 'within', 'without',
]);

const GENERIC_PHRASE_TOKENS = new Set([
  'application', 'capability', 'case', 'cases', 'content', 'customer', 'customers', 'data', 'detail',
  'details', 'draft', 'email', 'emails', 'field', 'fields', 'flow', 'form', 'forms', 'general',
  'information', 'inquiry', 'inquiries', 'issue', 'issues', 'item', 'items', 'message', 'messages',
  'process', 'record', 'records', 'request', 'requests', 'requirement', 'requirements', 'rule',
  'rules', 'status', 'support', 'system', 'team', 'workflow',
]);

const IDENTIFIER_HINTS = ['id', 'identifier', 'number', 'reference', 'code', 'key', 'serial', 'token'];
const LINKAGE_HINTS = ['link', 'associate', 'match', 'map', 'attach', 'connect', 'relate', 'lookup'];
const ROUTING_HINTS = ['classify', 'distinguish', 'route', 'routing', 'queue', 'assign', 'triage', 'category', 'type'];
const LIFECYCLE_HINTS = ['existing', 'new', 'active', 'inactive', 'reply', 'follow', 'thread', 'duplicate', 'history', 'reopen'];
const EXCEPTION_HINTS = ['missing', 'invalid', 'ambiguous', 'uncertain', 'unmatched', 'duplicate', 'fallback', 'manual', 'review', 'conflict', 'error'];
const TRIGGER_HINTS = ['arrive', 'arrival', 'receive', 'received', 'receives', 'incoming', 'submit', 'submitted', 'create', 'created', 'update', 'updated'];

function normalizeText(value: string): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function singularize(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('sses')) return value.slice(0, -2);
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 4) return value.slice(0, -1);
  return value;
}

function canonicalToken(value: string): string {
  return singularize(normalizeText(value).replace(/[^a-z0-9]/g, ''));
}

function wordList(value: string): string[] {
  return normalizeText(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(canonicalToken)
    .filter((token) => token.length > 1);
}

function tokenize(value: string): Set<string> {
  return new Set(wordList(value).filter((token) => token.length > 2));
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function buildGapId(category: CoverageGapCategory, label: string): string {
  return `${category}:${normalizeText(label).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

export function getCanvasIntentLabel(intent: CanvasEditIntent): string {
  if (intent === 'add_requirements') return 'Add missing requirements';
  if (intent === 'add_feature') return 'Add a feature';
  if (intent === 'reorganize') return 'Reorganize features';
  return 'Light refine';
}

export function getPendingChangeLabel(intent?: CanvasEditIntent): string {
  if (intent === 'add_requirements') return 'Requirements added';
  if (intent === 'add_feature') return 'Feature added';
  if (intent === 'reorganize') return 'Reorganized';
  return 'Refined';
}

export function routeCanvasEditInstruction(instruction: string): EditRoutingDecision {
  const text = normalizeText(instruction);
  if (!text) {
    return {
      intent: 'light_refine',
      confidence: 'low',
      reason: 'No change instruction yet.',
    };
  }

  const reorganizePatterns = [
    /\bmerge\b/,
    /\bsplit\b/,
    /\bcombine\b/,
    /\bconsolidat(?:e|ion)\b/,
    /\bdeduplicat(?:e|ion)\b/,
    /\boverlap\b/,
    /\breorgani[sz]e\b/,
    /\brestructure\b/,
    /\bmove\b.{0,40}\bacceptance requirement\b/,
    /\bmove\b.{0,20}\bar\b/,
    /\bremove\b.{0,20}\bfeature\b/,
    /\bdelete\b.{0,20}\bfeature\b/,
  ];
  if (containsAny(text, reorganizePatterns)) {
    return {
      intent: 'reorganize',
      confidence: 'high',
      reason: 'This instruction changes feature boundaries or ownership.',
    };
  }

  const addFeaturePatterns = [
    /\badd\b.{0,20}\bfeature\b/,
    /\bnew feature\b/,
    /\bmissing feature\b/,
    /\bcreate\b.{0,20}\bfeature\b/,
    /\bseparate feature\b/,
    /\bown feature\b/,
    /\bnew capability\b/,
  ];
  if (containsAny(text, addFeaturePatterns)) {
    return {
      intent: 'add_feature',
      confidence: 'high',
      reason: 'This instruction asks for new capability coverage rather than a wording change.',
    };
  }

  const addRequirementsPatterns = [
    /\badd\b.{0,30}\bacceptance requirement/,
    /\badd\b.{0,20}\bar\b/,
    /\bmissing requirement\b/,
    /\bmissing acceptance\b/,
    /\bmissing ar\b/,
    /\bstrengthen\b.{0,25}\bacceptance\b/,
    /\bcover\b.{0,25}\bmissing\b/,
  ];
  if (containsAny(text, addRequirementsPatterns)) {
    return {
      intent: 'add_requirements',
      confidence: 'high',
      reason: 'This instruction expands testable coverage inside the existing structure.',
    };
  }

  const refinePatterns = [
    /\breword\b/,
    /\brewrite\b/,
    /\btighten\b/,
    /\bclarif(?:y|ication)\b/,
    /\bsimplif(?:y|ication)\b/,
    /\bless technical\b/,
    /\bmore business\b/,
    /\bclean up\b/,
    /\bimprove wording\b/,
  ];
  if (containsAny(text, refinePatterns)) {
    return {
      intent: 'light_refine',
      confidence: 'high',
      reason: 'This instruction reads like a wording, clarity, or tone adjustment.',
    };
  }

  const addSignals = containsAny(text, [/\badd\b/, /\binclude\b/, /\bcapture\b/, /\blink\b/]);
  const requirementSignals = containsAny(text, [/\brequirement\b/, /\bar\b/, /\bacceptance\b/]);
  if (addSignals && requirementSignals) {
    return {
      intent: 'add_requirements',
      confidence: 'medium',
      reason: 'This looks like additional coverage, but it may be either a new feature or stronger requirements.',
      followupQuestion: 'Should this be added as extra acceptance coverage on an existing feature, or as its own feature?',
      followupWhy: 'The instruction adds behavior but does not make the feature boundary explicit.',
      followupUnlocks: 'This decides whether the app should extend an existing feature or append a new one.',
    };
  }

  if (addSignals) {
    return {
      intent: 'add_feature',
      confidence: 'medium',
      reason: 'This sounds like missing capability coverage rather than a simple wording change.',
    };
  }

  return {
    intent: 'light_refine',
    confidence: 'medium',
    reason: 'Defaulting to the lightest safe change until a stronger structural signal appears.',
  };
}

function buildFeatureCorpus(features: Feature[]): string {
  return features.map((feature) => [
    feature.summary,
    feature.description,
    ...(feature.acceptanceRequirements || []).flatMap((ar) => [ar.given, ar.when, ar.then]),
  ].join(' ')).join(' ');
}

function pushUniqueGap(target: CoverageGap[], gap: CoverageGap) {
  if (target.some((item) => item.id === gap.id)) return;
  target.push(gap);
}

function featureWithMostOverlap(features: Feature[], terms: string[]): string | undefined {
  let bestId: string | undefined;
  let bestScore = 0;
  features.forEach((feature) => {
    const tokens = tokenize([
      feature.summary,
      feature.description,
      ...(feature.acceptanceRequirements || []).flatMap((ar) => [ar.given, ar.when, ar.then]),
    ].join(' '));
    const score = terms.reduce((sum, term) => sum + (tokens.has(term) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestId = feature.id;
    }
  });
  return bestId;
}

function matchingTokenCount(tokens: Set<string>, hints: string[]): number {
  let matches = 0;
  tokens.forEach((token) => {
    if (hints.some((hint) => token === hint || token.startsWith(hint) || hint.startsWith(token))) {
      matches += 1;
    }
  });
  return matches;
}

function cleanPhrase(value: string): string {
  const words = wordList(value)
    .filter((token) => !STOP_WORDS.has(token))
    .map((token) => token === 'ids' ? 'id' : token);
  return words.join(' ').trim();
}

function isSpecificPhrase(value: string): boolean {
  const tokens = wordList(value).filter((token) => !STOP_WORDS.has(token));
  if (!tokens.length) return false;
  const informative = tokens.filter((token) => !GENERIC_PHRASE_TOKENS.has(token));
  return informative.length > 0;
}

function extractPatternPhrases(
  text: string,
  pattern: RegExp,
  mapMatch?: (...groups: string[]) => string,
): string[] {
  const results: string[] = [];
  const normalized = normalizeText(text);
  for (const match of normalized.matchAll(pattern)) {
    const groups = match.slice(1).filter((value): value is string => Boolean(value));
    const raw = mapMatch ? mapMatch(...groups) : groups.join(' ');
    const phrase = cleanPhrase(raw);
    if (phrase && isSpecificPhrase(phrase)) {
      results.push(phrase);
    }
  }
  return Array.from(new Set(results));
}

function extractRolePhrases(text: string): string[] {
  return extractPatternPhrases(
    text,
    /\bas an?\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,4})\b/g,
  );
}

function extractIdentifierPhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\b([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\s+(id|identifier|number|reference|code|key|token)\b/g,
      (subject, qualifier) => `${subject} ${qualifier}`,
    ),
    ...extractPatternPhrases(
      text,
      /\b(serial\s+number|reference\s+number|account\s+number|tracking\s+number|registration\s+number)\b/g,
    ),
    ...extractPatternPhrases(
      text,
      /\b(?:capture|collect|extract|identify|record|store|populate)\s+(?:the\s+|an?\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\b/g,
    ).filter((phrase) => wordList(phrase).some((token) => IDENTIFIER_HINTS.includes(token))),
  ]));
}

function extractLinkagePhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\b(?:link|associate|match|map|attach|connect|relate)\s+(?:the\s+|an?\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\s+(?:to|with)\s+(?:the\s+|an?\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\b/g,
      (left, right) => `${left} ${right}`,
    ),
    ...extractPatternPhrases(
      text,
      /\b(?:link|associate|match|map|attach|connect|relate)\s+(?:the\s+|an?\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\b/g,
    ),
  ]));
}

function extractRoutingPhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\bbetween\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\s+and\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\b/g,
      (left, right) => `${left} | ${right}`,
    ),
    ...extractPatternPhrases(
      text,
      /\b(?:classify|distinguish|route|assign|triage|send)\s+(?:the\s+|an?\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,3})\b/g,
    ),
    ...extractPatternPhrases(
      text,
      /\b(?:as|into)\s+(?:a\s+|an\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\s+or\s+(?:a\s+|an\s+)?([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/g,
      (left, right) => `${left} | ${right}`,
    ),
  ]));
}

function extractLifecyclePhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\b(existing|new|active|inactive)\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/g,
      (state, subject) => `${state} ${subject}`,
    ),
    ...extractPatternPhrases(
      text,
      /\b(follow up|follow-up|reply|thread|duplicate|reopen|history)\b/g,
    ),
  ]));
}

function extractExceptionPhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\b(missing|invalid|ambiguous|uncertain|unmatched|duplicate|conflicting)\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\b/g,
      (qualifier, subject) => `${qualifier} ${subject}`,
    ),
    ...extractPatternPhrases(
      text,
      /\b(manual review|no match|not found|fallback)\b/g,
    ),
  ]));
}

function extractTriggerPhrases(text: string): string[] {
  return Array.from(new Set([
    ...extractPatternPhrases(
      text,
      /\b(?:when|if|after|upon)\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,4})\b/g,
    ),
    ...extractPatternPhrases(
      text,
      /\b(?:so that|so)\s+([a-z0-9]+(?:\s+[a-z0-9]+){0,4})\b/g,
    ),
  ]));
}

function phraseCoverageScore(phrase: string, corpusText: string, corpusTokens: Set<string>): number {
  if (!phrase) return 0;
  const normalizedPhrase = normalizeText(phrase);
  if (normalizeText(corpusText).includes(normalizedPhrase)) return 1;

  const tokens = wordList(phrase).filter((token) => !STOP_WORDS.has(token));
  const informative = tokens.filter((token) => !GENERIC_PHRASE_TOKENS.has(token) && !IDENTIFIER_HINTS.includes(token));
  const basis = informative.length ? informative : tokens.filter((token) => !GENERIC_PHRASE_TOKENS.has(token));
  if (!basis.length) return 0;
  const hits = basis.reduce((count, token) => count + (corpusTokens.has(token) ? 1 : 0), 0);
  return hits / basis.length;
}

function findMissingPhrases(phrases: string[], corpusText: string, corpusTokens: Set<string>): string[] {
  return Array.from(new Set(
    phrases.filter((phrase) => phraseCoverageScore(phrase, corpusText, corpusTokens) < 0.75),
  ));
}

function formatGapLabel(baseLabel: string, phrases: string[]): string {
  if (!phrases.length) return baseLabel;
  return `${baseLabel}: ${phrases.slice(0, 2).join(', ')}`;
}

function formatMissingPhraseList(phrases: string[]): string {
  if (!phrases.length) return 'the missing detail';
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases[0]}, ${phrases[1]}, and ${phrases.length - 2} more`;
}

function confidenceFromSignals(missingCount: number, requirementSignalScore: number, canvasSignalScore: number): 'low' | 'medium' | 'high' {
  if (missingCount >= 2 || (missingCount >= 1 && canvasSignalScore === 0) || requirementSignalScore - canvasSignalScore >= 3) {
    return 'high';
  }
  if (missingCount >= 1 || requirementSignalScore > canvasSignalScore) {
    return 'medium';
  }
  return 'low';
}

function buildRequirementLinkageGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const requirementTokens = tokenize(requirement);
  const linkagePhrases = Array.from(new Set([
    ...extractIdentifierPhrases(requirement),
    ...extractLinkagePhrases(requirement),
  ]));
  const missingPhrases = findMissingPhrases(linkagePhrases, featureCorpus, featureTokens);
  const requirementSignalScore = matchingTokenCount(requirementTokens, [...IDENTIFIER_HINTS, ...LINKAGE_HINTS]);
  const canvasSignalScore = matchingTokenCount(featureTokens, [...IDENTIFIER_HINTS, ...LINKAGE_HINTS]);
  if (!missingPhrases.length && requirementSignalScore <= canvasSignalScore) return null;

  const label = formatGapLabel('Required information and linkage', missingPhrases);
  const targetTerms = missingPhrases.length ? wordList(missingPhrases.join(' ')) : ['link', 'identifier', 'reference'];
  const targetFeatureId = featureWithMostOverlap(features, targetTerms);
  const suggestedAction = targetFeatureId ? 'add_to_feature' : 'add_feature';
  const suggestedIntent = targetFeatureId ? 'add_requirements' : 'add_feature';

  return {
    id: buildGapId('required_information_linkage', label),
    category: 'required_information_linkage',
    label,
    confidence: confidenceFromSignals(missingPhrases.length, requirementSignalScore, canvasSignalScore),
    suggestedAction,
    why: missingPhrases.length
      ? `The requirement calls out ${formatMissingPhraseList(missingPhrases)}, but that information or linkage is not clearly represented in the current draft.`
      : 'The requirement implies key identifiers or record linkage, but the current draft covers that area more weakly than the request does.',
    question: missingPhrases.length
      ? `Should ${formatMissingPhraseList(missingPhrases)} be captured on an existing feature, or modeled as its own feature?`
      : 'Which identifier or linked record needs explicit coverage here?',
    targetFeatureId,
    suggestedIntent,
  };
}

function buildRoutingGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const requirementTokens = tokenize(requirement);
  const routingPhrases = extractRoutingPhrases(requirement);
  const missingPhrases = findMissingPhrases(routingPhrases, featureCorpus, featureTokens);
  const requirementSignalScore = matchingTokenCount(requirementTokens, ROUTING_HINTS);
  const canvasSignalScore = matchingTokenCount(featureTokens, ROUTING_HINTS);
  if (!missingPhrases.length && requirementSignalScore <= canvasSignalScore) return null;

  return {
    id: buildGapId('rules_routing', formatGapLabel('Rules and routing', missingPhrases)),
    category: 'rules_routing',
    label: formatGapLabel('Rules and routing', missingPhrases),
    confidence: confidenceFromSignals(missingPhrases.length, requirementSignalScore, canvasSignalScore),
    suggestedAction: 'add_to_feature',
    why: missingPhrases.length
      ? `The requirement names decision logic around ${formatMissingPhraseList(missingPhrases)}, but the canvas does not clearly explain those rules yet.`
      : 'The requirement contains classification or routing behavior that is less explicit in the current draft than it should be.',
    question: 'What should happen when the routing or classification decision is unclear?',
    targetFeatureId: featureWithMostOverlap(features, wordList(missingPhrases.join(' ') || 'route classify queue')),
    suggestedIntent: 'add_requirements',
  };
}

function buildLifecycleGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const requirementTokens = tokenize(requirement);
  const lifecyclePhrases = extractLifecyclePhrases(requirement);
  const missingPhrases = findMissingPhrases(lifecyclePhrases, featureCorpus, featureTokens);
  const requirementSignalScore = matchingTokenCount(requirementTokens, LIFECYCLE_HINTS) + matchingTokenCount(requirementTokens, TRIGGER_HINTS);
  const canvasSignalScore = matchingTokenCount(featureTokens, LIFECYCLE_HINTS);
  if (!missingPhrases.length && requirementSignalScore <= canvasSignalScore) return null;

  return {
    id: buildGapId('lifecycle_matching', formatGapLabel('Lifecycle and matching behavior', missingPhrases)),
    category: 'lifecycle_matching',
    label: formatGapLabel('Lifecycle and matching behavior', missingPhrases),
    confidence: confidenceFromSignals(missingPhrases.length, requirementSignalScore, canvasSignalScore),
    suggestedAction: 'add_to_feature',
    why: missingPhrases.length
      ? `The request implies state or matching behavior for ${formatMissingPhraseList(missingPhrases)}, and that lifecycle handling is not obvious in the current canvas.`
      : 'The requirement suggests matching, state, or follow-up behavior that is under-specified in the current draft.',
    question: 'Should follow-up items create something new, match an existing item, or be flagged for review?',
    targetFeatureId: featureWithMostOverlap(features, wordList(missingPhrases.join(' ') || 'existing new duplicate reply')),
    suggestedIntent: 'add_requirements',
  };
}

function buildExceptionGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const requirementTokens = tokenize(requirement);
  const exceptionPhrases = extractExceptionPhrases(requirement);
  const missingPhrases = findMissingPhrases(exceptionPhrases, featureCorpus, featureTokens);
  const requirementSignalScore = matchingTokenCount(requirementTokens, EXCEPTION_HINTS);
  const canvasSignalScore = matchingTokenCount(featureTokens, EXCEPTION_HINTS);
  if (!missingPhrases.length && requirementSignalScore === 0 && canvasSignalScore > 0) return null;
  if (!missingPhrases.length && requirementSignalScore <= canvasSignalScore && canvasSignalScore > 0) return null;

  return {
    id: buildGapId('exceptions_duplicates', formatGapLabel('Exceptions and duplicates', missingPhrases)),
    category: 'exceptions_duplicates',
    label: formatGapLabel('Exceptions and duplicates', missingPhrases),
    confidence: confidenceFromSignals(missingPhrases.length, requirementSignalScore || 1, canvasSignalScore),
    suggestedAction: missingPhrases.length ? 'add_to_feature' : 'ask_followup',
    why: missingPhrases.length
      ? `The current draft does not clearly cover edge handling for ${formatMissingPhraseList(missingPhrases)}.`
      : 'The current draft still has limited visible fallback coverage, so there may be a missing rule for ambiguity, missing data, or duplicates.',
    question: 'What should happen when required information is missing, invalid, ambiguous, or would create a duplicate?',
    targetFeatureId: featureWithMostOverlap(features, wordList(missingPhrases.join(' ') || 'missing invalid duplicate')),
    suggestedIntent: 'add_requirements',
  };
}

function buildRoleGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const rolePhrases = extractRolePhrases(requirement);
  const missingPhrases = findMissingPhrases(rolePhrases, featureCorpus, featureTokens);
  if (!missingPhrases.length) return null;

  return {
    id: buildGapId('roles_ownership', formatGapLabel('Roles and ownership', missingPhrases)),
    category: 'roles_ownership',
    label: formatGapLabel('Roles and ownership', missingPhrases),
    confidence: 'medium',
    suggestedAction: 'add_to_feature',
    why: `The request names ${formatMissingPhraseList(missingPhrases)} as the actor or owner, but that role is not easy to trace in the current draft.`,
    question: 'Who owns this step when the normal automated path does not apply?',
    targetFeatureId: featureWithMostOverlap(features, wordList(missingPhrases.join(' '))),
    suggestedIntent: 'add_requirements',
  };
}

function buildTriggerGap(features: Feature[], requirement: string, featureCorpus: string, featureTokens: Set<string>): CoverageGap | null {
  const requirementTokens = tokenize(requirement);
  const triggerPhrases = extractTriggerPhrases(requirement);
  const missingPhrases = findMissingPhrases(triggerPhrases, featureCorpus, featureTokens);
  const requirementSignalScore = matchingTokenCount(requirementTokens, TRIGGER_HINTS);
  const canvasSignalScore = matchingTokenCount(featureTokens, TRIGGER_HINTS);
  if (!missingPhrases.length && requirementSignalScore <= canvasSignalScore) return null;

  return {
    id: buildGapId('trigger_outcome', formatGapLabel('Trigger and outcome', missingPhrases)),
    category: 'trigger_outcome',
    label: formatGapLabel('Trigger and outcome', missingPhrases),
    confidence: confidenceFromSignals(missingPhrases.length, requirementSignalScore || 1, canvasSignalScore),
    suggestedAction: 'add_to_feature',
    why: missingPhrases.length
      ? `The request points to trigger or outcome wording around ${formatMissingPhraseList(missingPhrases)}, but the draft does not make that flow explicit yet.`
      : 'The current draft may still be light on the exact trigger or outcome path described in the requirement.',
    question: 'What exact event should trigger this behavior, and what outcome should follow?',
    targetFeatureId: featureWithMostOverlap(features, wordList(missingPhrases.join(' ') || 'incoming create update')),
    suggestedIntent: 'add_requirements',
  };
}

export function detectCoverageGaps(input: {
  requirement: string;
  features: Feature[];
  existingMissingCoverage?: string[];
}): CoverageGap[] {
  const requirement = normalizeText(input.requirement);
  if (!requirement || input.features.length === 0) return [];

  const featureCorpus = buildFeatureCorpus(input.features);
  const featureTokens = tokenize(featureCorpus);
  const gaps: CoverageGap[] = [];
  [
    buildRequirementLinkageGap(input.features, requirement, featureCorpus, featureTokens),
    buildRoutingGap(input.features, requirement, featureCorpus, featureTokens),
    buildLifecycleGap(input.features, requirement, featureCorpus, featureTokens),
    buildExceptionGap(input.features, requirement, featureCorpus, featureTokens),
    buildRoleGap(input.features, requirement, featureCorpus, featureTokens),
    buildTriggerGap(input.features, requirement, featureCorpus, featureTokens),
  ].filter((gap): gap is CoverageGap => Boolean(gap)).forEach((gap) => {
    pushUniqueGap(gaps, gap);
  });

  (input.existingMissingCoverage ?? []).forEach((finding) => {
    const normalized = normalizeText(finding);
    if (!normalized) return;
    const category: CoverageGapCategory = normalized.includes('duplicate') || normalized.includes('exception')
      ? 'exceptions_duplicates'
      : normalized.includes('route') || normalized.includes('class')
        ? 'rules_routing'
        : normalized.includes('link') || normalized.includes('field') || normalized.includes('data')
          ? 'required_information_linkage'
          : normalized.includes('state') || normalized.includes('associate')
            ? 'lifecycle_matching'
            : 'trigger_outcome';
    pushUniqueGap(gaps, {
      id: buildGapId(category, finding),
      category,
      label: finding,
      confidence: 'medium',
      suggestedAction: category === 'required_information_linkage' ? 'add_feature' : 'add_to_feature',
      why: 'This gap was surfaced during coverage review and still looks unresolved in the current canvas.',
      suggestedIntent: category === 'required_information_linkage' ? 'add_feature' : 'add_requirements',
    });
  });

  const priority = { high: 3, medium: 2, low: 1 } as const;
  return gaps
    .sort((left, right) => {
      const confidenceDelta = priority[right.confidence] - priority[left.confidence];
      if (confidenceDelta !== 0) return confidenceDelta;
      return right.label.length - left.label.length;
    })
    .slice(0, 4);
}
