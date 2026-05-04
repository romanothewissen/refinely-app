import type {
  V2ActorGroundingStatus,
  V2CapabilityReasoningArtifact,
  V2ClassifiedAnswer,
  V2DiscoveryQuestion,
  V2GroundedCue,
  V2GroundedEvidencePack,
  V2RoleCandidate,
  V2ScopeHypothesis,
} from './types';

const ROLE_SUFFIXES = [
  'admin',
  'administrator',
  'agent',
  'analyst',
  'approver',
  'assistant',
  'associate',
  'auditor',
  'clerk',
  'consultant',
  'coordinator',
  'dispatcher',
  'engineer',
  'lead',
  'manager',
  'operator',
  'owner',
  'planner',
  'representative',
  'requester',
  'reviewer',
  'scheduler',
  'specialist',
  'supervisor',
  'support',
  'technician',
  'user',
  'worker',
];

const GENERIC_ROLE_KEYS = new Set([
  'user',
  'authorized user',
  'team member',
  'authorized team member',
  'manager',
  'owner',
  'support',
  'worker',
]);

const OBJECT_KEYWORDS = [
  'request',
  'plan',
  'order',
  'case',
  'shipment',
  'schedule',
  'template',
  'ticket',
  'invoice',
  'entitlement',
  'contract',
  'message',
  'asset',
  'document',
  'quote',
  'booking',
  'task',
  'record',
  'activity',
  'approval',
  'exception',
  'override',
  'workflow',
];

const WORKFLOW_PATTERN = /\b(workflow|route|routing|handoff|sequence|dispatch|schedule|approval|coordinate|process|trigger|step|flow)\b/i;
const RULE_PATTERN = /\b(must|must not|cannot|can't|only|unless|except|override|validation|threshold|rule|prevent|required)\b/i;
const LIFECYCLE_PATTERN = /\b(status|state|lifecycle|draft|approved|rejected|returned|return|reopen|reopened|resume|resumed|cancel|cancelled|complete|completed|progress)\b/i;
const GENERIC_CAPABILITY_PATTERN = /\b(manage|handle|support|process)\s+(workflow|process|requests?|items?|tasks?|operations?)\b/i;

const STAGE_RENDER_BUDGETS = {
  scope_hypothesis: 1400,
  discover: 2200,
  discovery_synthesis: 3000,
  final_generation: 3600,
  coverage_repair: 2600,
  capability_reasoning: 3000,
} as const;

type SourceName =
  | 'requirement'
  | 'attachment'
  | 'domain_role'
  | 'domain_context'
  | 'user_persona_answer'
  | 'answer'
  | 'backlog'
  | 'wi';

interface RoleAccumulator {
  role: string;
  score: number;
  evidenceKeys: Set<string>;
  sources: Set<SourceName>;
}

function normalize(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function trimText(value: string, maxChars: number): string {
  const normalized = normalize(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 12)).trimEnd()} ...[trimmed]`;
}

function slugify(value: string): string {
  return normalize(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function titleCase(value: string): string {
  return normalize(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      if (part === part.toUpperCase() && part.length <= 5) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(' ');
}

function tokenize(value: string): string[] {
  return normalize(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function tokenizeKey(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
}

function uniqueByKey<T>(items: T[], keyFn: (item: T) => string, maxItems?: number): T[] {
  const output: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
    if (maxItems && output.length >= maxItems) break;
  }
  return output;
}

function toCue(prefix: string, text: string, maxChars: number): V2GroundedCue | null {
  const trimmed = trimText(text, maxChars);
  if (!trimmed) return null;
  const slug = slugify(trimmed);
  if (!slug) return null;
  return { key: `${prefix}:${slug}`, text: trimmed };
}

function splitIntoSegments(text: string): string[] {
  return normalize(text)
    .split(/[\n\r]+|(?<=[.!?])\s+/)
    .map((segment) => normalize(segment))
    .filter((segment) => segment.length >= 12);
}

function extractObjectPhrases(text: string): string[] {
  const matches: string[] = [];
  const normalized = normalize(text);
  const pattern = new RegExp(`\\b([a-z0-9]+(?:\\s+[a-z0-9]+){0,2}\\s+(?:${OBJECT_KEYWORDS.join('|')})s?)\\b`, 'gi');
  for (const match of normalized.matchAll(pattern)) {
    const phrase = normalize(match[1] ?? '');
    if (!phrase) continue;
    matches.push(phrase);
  }
  return matches;
}

function looksLikeRole(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return false;
  const lowered = normalized.toLowerCase();
  if (GENERIC_ROLE_KEYS.has(lowered)) return true;
  const parts = lowered.split(' ');
  return parts.some((part) => ROLE_SUFFIXES.includes(part));
}

function normalizeRole(value: string): string {
  const normalized = normalize(value)
    .replace(/^(and|or|the)\s+/i, '')
    .replace(/[.:;,/-]+$/g, '');
  if (!normalized) return '';
  if (normalized === normalized.toUpperCase()) return normalized;
  return titleCase(normalized);
}

function extractRolePhrases(text: string): string[] {
  const normalized = normalize(text);
  if (!normalized) return [];
  const lowered = normalized.toLowerCase();
  const matches: string[] = [];
  const pattern = new RegExp(`\\b([a-z0-9]+(?:\\s+[a-z0-9]+){0,2}\\s+(?:${ROLE_SUFFIXES.join('|')}))\\b`, 'gi');
  for (const match of normalized.matchAll(pattern)) {
    const phrase = normalizeRole(match[1] ?? '');
    if (phrase) matches.push(phrase);
  }
  if (/^as an? /i.test(normalized)) {
    const parts = normalized.replace(/^as an?\s+/i, '').split(/\bi need\b/i);
    const candidate = normalizeRole(parts[0] ?? '');
    if (candidate && looksLikeRole(candidate)) matches.push(candidate);
  }
  if (/\bapprover\b/.test(lowered)) matches.push('Approver');
  if (/\breviewer\b/.test(lowered)) matches.push('Reviewer');
  return uniqueByKey(matches, (value) => value.toLowerCase(), 8);
}

function collectSentenceCues(
  texts: Array<{ prefix: string; text: string }>,
  pattern: RegExp,
  maxItems: number,
  maxChars: number,
): V2GroundedCue[] {
  const cues: V2GroundedCue[] = [];
  for (const entry of texts) {
    for (const segment of splitIntoSegments(entry.text)) {
      if (!pattern.test(segment)) continue;
      const cue = toCue(entry.prefix, segment, maxChars);
      if (cue) cues.push(cue);
      if (cues.length >= maxItems * 2) break;
    }
  }
  return uniqueByKey(cues, (cue) => cue.key, maxItems);
}

function collectObjectCues(
  texts: Array<{ prefix: string; text: string }>,
  maxItems: number,
): V2GroundedCue[] {
  const cues: V2GroundedCue[] = [];
  for (const entry of texts) {
    for (const phrase of extractObjectPhrases(entry.text)) {
      const cue = toCue('object', phrase, 96);
      if (cue) cues.push(cue);
      if (cues.length >= maxItems * 3) break;
    }
  }
  return uniqueByKey(cues, (cue) => cue.key, maxItems);
}

function roleWeight(source: SourceName): number {
  switch (source) {
    case 'user_persona_answer':
      return 5;
    case 'requirement':
      return 4;
    case 'domain_role':
      return 3;
    case 'answer':
      return 3;
    case 'wi':
    case 'backlog':
      return 2;
    case 'domain_context':
      return 1;
    case 'attachment':
      return 2;
    default:
      return 1;
  }
}

function accumulateRole(
  candidates: Map<string, RoleAccumulator>,
  role: string,
  source: SourceName,
  evidenceKey: string,
): void {
  const normalized = normalizeRole(role);
  if (!normalized || !looksLikeRole(normalized)) return;
  const key = normalized.toLowerCase();
  const existing = candidates.get(key) ?? {
    role: normalized,
    score: 0,
    evidenceKeys: new Set<string>(),
    sources: new Set<SourceName>(),
  };
  existing.role = existing.role.length >= normalized.length ? existing.role : normalized;
  existing.sources.add(source);
  existing.evidenceKeys.add(evidenceKey);
  existing.score += roleWeight(source);
  if (GENERIC_ROLE_KEYS.has(key)) existing.score -= 2;
  candidates.set(key, existing);
}

function buildRoleCandidates(input: {
  requirement: string;
  attachmentText?: string;
  domainContext?: string;
  domainRoles?: string[];
  similarStoriesText?: string;
  wiContextText?: string;
  discoveryAnswers?: V2ClassifiedAnswer[];
}): V2RoleCandidate[] {
  const candidates = new Map<string, RoleAccumulator>();
  extractRolePhrases(input.requirement).forEach((role) => accumulateRole(candidates, role, 'requirement', `role:${slugify(role)}`));
  extractRolePhrases(input.attachmentText ?? '').forEach((role) => accumulateRole(candidates, role, 'attachment', `role:${slugify(role)}`));
  extractRolePhrases(input.domainContext ?? '').forEach((role) => accumulateRole(candidates, role, 'domain_context', `role:${slugify(role)}`));
  extractRolePhrases(input.similarStoriesText ?? '').forEach((role) => accumulateRole(candidates, role, 'backlog', `role:${slugify(role)}`));
  extractRolePhrases(input.wiContextText ?? '').forEach((role) => accumulateRole(candidates, role, 'wi', `role:${slugify(role)}`));
  (input.domainRoles ?? []).forEach((role) => accumulateRole(candidates, role, 'domain_role', `role:${slugify(role)}`));
  (input.discoveryAnswers ?? []).forEach((answer) => {
    const source: SourceName = answer.categoryKey === 'user_personas' ? 'user_persona_answer' : 'answer';
    extractRolePhrases(answer.answer).forEach((role) => accumulateRole(candidates, role, source, `role:${slugify(role)}`));
  });

  return [...candidates.values()]
    .map((candidate) => {
      const confidence: V2ActorGroundingStatus =
        candidate.score >= 7 || (candidate.score >= 5 && candidate.sources.size >= 2)
          ? 'strong'
          : candidate.score >= 3
            ? 'supported'
            : 'weak';
      return {
        role: candidate.role,
        confidence,
        evidenceKeys: [...candidate.evidenceKeys].slice(0, 4),
      };
    })
    .filter((candidate) => candidate.confidence !== 'weak')
    .sort((left, right) => {
      const rank = (value: V2ActorGroundingStatus) => value === 'strong' ? 3 : value === 'supported' ? 2 : 1;
      return rank(right.confidence) - rank(left.confidence) || left.role.localeCompare(right.role);
    })
    .slice(0, 3);
}

function renderCueList(title: string, items: string[]): string {
  if (!items.length) return '';
  return `${title}:\n- ${items.join('\n- ')}`;
}

function cueDisplayText(cue: V2GroundedCue): string {
  return cue.text;
}

export function buildV2GroundedEvidencePack(input: {
  requirement: string;
  attachmentText?: string;
  domainContext?: string;
  domainRoles?: string[];
  similarStoriesText?: string;
  wiContextText?: string;
  discoveryAnswers?: V2ClassifiedAnswer[];
}): V2GroundedEvidencePack {
  const texts = {
    requirement: normalize(input.requirement),
    attachment: normalize(input.attachmentText ?? ''),
    domainContext: normalize(input.domainContext ?? ''),
    backlog: normalize(input.similarStoriesText ?? ''),
    wi: normalize(input.wiContextText ?? ''),
    answers: normalize((input.discoveryAnswers ?? []).map((answer) => answer.answer).join('\n')),
  };

  const objectSources = [
    { prefix: 'object', text: texts.requirement },
    { prefix: 'object', text: texts.attachment },
    { prefix: 'object', text: texts.answers },
    { prefix: 'object', text: texts.wi },
    { prefix: 'object', text: texts.backlog },
    { prefix: 'object', text: texts.domainContext },
  ];
  const contextualSources = [
    { prefix: 'workflow', text: texts.requirement },
    { prefix: 'workflow', text: texts.answers },
    { prefix: 'workflow', text: texts.wi },
    { prefix: 'workflow', text: texts.backlog },
    { prefix: 'workflow', text: texts.domainContext },
  ];
  const lifecycleSources = [
    { prefix: 'lifecycle', text: texts.requirement },
    { prefix: 'lifecycle', text: texts.answers },
    { prefix: 'lifecycle', text: texts.wi },
    { prefix: 'lifecycle', text: texts.backlog },
    { prefix: 'lifecycle', text: texts.domainContext },
  ];
  const backlogCues = collectSentenceCues([{ prefix: 'backlog', text: texts.backlog }], WORKFLOW_PATTERN, 5, 180);
  const wiCues = collectSentenceCues([{ prefix: 'wi', text: texts.wi }], RULE_PATTERN, 5, 180);

  return {
    roleCandidates: buildRoleCandidates(input),
    businessObjects: collectObjectCues(objectSources, 6),
    workflowSignals: collectSentenceCues(contextualSources, WORKFLOW_PATTERN, 6, 180),
    businessRules: collectSentenceCues(contextualSources, RULE_PATTERN, 6, 180),
    lifecycleSignals: collectSentenceCues(lifecycleSources, LIFECYCLE_PATTERN, 6, 180),
    backlogCues,
    wiCues,
  };
}

export function renderGroundedEvidencePack(
  evidencePack: V2GroundedEvidencePack,
  stage: keyof typeof STAGE_RENDER_BUDGETS,
): string {
  const roleLines = evidencePack.roleCandidates.map((candidate) => `${candidate.role} (${candidate.confidence})`);
  const sections = [
    renderCueList('Role candidates', roleLines),
    renderCueList('Business objects', evidencePack.businessObjects.map(cueDisplayText)),
    renderCueList('Workflow signals', evidencePack.workflowSignals.map(cueDisplayText)),
    renderCueList('Business rules', evidencePack.businessRules.map(cueDisplayText)),
    renderCueList('Lifecycle signals', evidencePack.lifecycleSignals.map(cueDisplayText)),
    stage === 'capability_reasoning' || stage === 'discovery_synthesis' || stage === 'final_generation' || stage === 'coverage_repair'
      ? renderCueList('Backlog cues', evidencePack.backlogCues.map(cueDisplayText))
      : '',
    stage === 'capability_reasoning' || stage === 'discovery_synthesis' || stage === 'final_generation' || stage === 'coverage_repair'
      ? renderCueList('Work instruction cues', evidencePack.wiCues.map(cueDisplayText))
      : '',
  ].filter(Boolean);
  if (!sections.length) return '';
  return trimText(`Grounded evidence:\n${sections.join('\n\n')}`, STAGE_RENDER_BUDGETS[stage]);
}

function packTerms(evidencePack: V2GroundedEvidencePack): string[] {
  const rawTerms = [
    ...evidencePack.roleCandidates.map((candidate) => candidate.role),
    ...evidencePack.businessObjects.map((cue) => cue.text),
    ...evidencePack.workflowSignals.map((cue) => cue.text),
    ...evidencePack.businessRules.map((cue) => cue.text),
    ...evidencePack.lifecycleSignals.map((cue) => cue.text),
    ...evidencePack.backlogCues.map((cue) => cue.text),
    ...evidencePack.wiCues.map((cue) => cue.text),
  ];
  const phrases = rawTerms
    .map((term) => normalize(term).toLowerCase())
    .filter((term) => term.length >= 4);
  const tokens = rawTerms.flatMap((term) => tokenize(term));
  return uniqueByKey([...phrases, ...tokens], (value) => value, 60);
}

function textMatchesPack(text: string, evidencePack: V2GroundedEvidencePack): boolean {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) return false;
  const terms = packTerms(evidencePack);
  return terms.some((term) => term.length >= 4 && normalized.includes(term));
}

function isWeakOwnerRole(ownerRole: string, evidencePack: V2GroundedEvidencePack): boolean {
  const normalized = normalize(ownerRole).toLowerCase();
  if (!normalized) return true;
  if (GENERIC_ROLE_KEYS.has(normalized)) return true;
  if (!evidencePack.roleCandidates.length) return false;
  return !evidencePack.roleCandidates.some((candidate) => {
    const roleTokens = tokenize(candidate.role);
    return roleTokens.some((token) => normalized.includes(token));
  });
}

function capabilityEvidenceKeys(text: string, evidencePack: V2GroundedEvidencePack): string[] {
  const normalized = normalize(text).toLowerCase();
  if (!normalized) return [];
  const candidates: Array<{ key: string; text: string }> = [
    ...evidencePack.roleCandidates.flatMap((candidate) => candidate.evidenceKeys.map((key) => ({ key, text: candidate.role }))),
    ...evidencePack.businessObjects,
    ...evidencePack.workflowSignals,
    ...evidencePack.businessRules,
    ...evidencePack.lifecycleSignals,
    ...evidencePack.backlogCues,
    ...evidencePack.wiCues,
  ];
  const matched = candidates.filter((candidate) => {
    const candidateText = candidate.text.toLowerCase();
    if (candidateText && normalized.includes(candidateText)) return true;
    const candidateTokens = tokenize(candidate.text);
    return candidateTokens.filter((token) => normalized.includes(token)).length >= Math.min(2, candidateTokens.length);
  });
  return uniqueByKey(matched, (candidate) => candidate.key, 4).map((candidate) => candidate.key);
}

export function deriveActorGroundingStatus(
  evidencePack: V2GroundedEvidencePack,
  classifiedAnswers: V2ClassifiedAnswer[] = [],
): V2ActorGroundingStatus {
  if (evidencePack.roleCandidates.some((candidate) => candidate.confidence === 'strong')) return 'strong';
  if (classifiedAnswers.some((answer) => answer.materiality === 'actor_bearing')) return 'supported';
  if (evidencePack.roleCandidates.length) return 'supported';
  return 'weak';
}

export function enrichScopeHypothesis(
  scopeHypothesis: V2ScopeHypothesis,
  evidencePack: V2GroundedEvidencePack,
  options?: {
    classifiedAnswers?: V2ClassifiedAnswer[];
    preserveActorSlots?: boolean;
  },
): V2ScopeHypothesis {
  const actorGroundingStatus = deriveActorGroundingStatus(evidencePack, options?.classifiedAnswers);
  return {
    ...scopeHypothesis,
    capabilities: scopeHypothesis.capabilities.map((capability) => ({
      ...capability,
      evidenceKeys: capabilityEvidenceKeys(`${capability.label} ${capability.rationale}`, evidencePack),
    })),
    actorGroundingStatus,
    actorSlots:
      options?.preserveActorSlots || actorGroundingStatus === 'strong' || (options?.classifiedAnswers?.length ?? 0) > 0
        ? scopeHypothesis.actorSlots
        : {},
  };
}

export function enrichCapabilityReasoning(
  reasoning: V2CapabilityReasoningArtifact,
  evidencePack: V2GroundedEvidencePack,
): V2CapabilityReasoningArtifact {
  return {
    ...reasoning,
    capabilities: reasoning.capabilities.map((capability) => ({
      ...capability,
      evidenceKeys: capabilityEvidenceKeys(
        [
          capability.label,
          capability.boundary,
          capability.ownerRole,
          ...capability.mustCarryRules,
          ...capability.edgeCases,
        ].join(' '),
        evidencePack,
      ),
    })),
  };
}

export function validateDiscoveryQuestionsAgainstEvidence(
  questions: V2DiscoveryQuestion[],
  evidencePack: V2GroundedEvidencePack,
): string | null {
  const invalid = questions.find((question) => !textMatchesPack(question.question, evidencePack));
  if (!invalid) return null;
  return `Discovery question "${invalid.question}" is too generic; it must reference grounded actors, objects, rules, or lifecycle cues.`;
}

export function validateScopeHypothesisAgainstEvidence(
  scopeHypothesis: V2ScopeHypothesis,
  evidencePack: V2GroundedEvidencePack,
): string | null {
  const invalidCapability = scopeHypothesis.capabilities.find((capability) => {
    if (GENERIC_CAPABILITY_PATTERN.test(capability.label)) return true;
    return !textMatchesPack(`${capability.label} ${capability.rationale}`, evidencePack);
  });
  if (invalidCapability) {
    return `Capability "${invalidCapability.label}" is too generic or not grounded in the requirement evidence.`;
  }
  return null;
}

export function validateReasoningAgainstEvidence(
  reasoning: V2CapabilityReasoningArtifact,
  evidencePack: V2GroundedEvidencePack,
): string | null {
  const invalidOwner = reasoning.capabilities.find((capability) => isWeakOwnerRole(capability.ownerRole, evidencePack));
  if (invalidOwner) {
    return `Capability "${invalidOwner.label}" uses an owner role that is not grounded in the current evidence.`;
  }
  const ungroundedCapability = reasoning.capabilities.find((capability) => !textMatchesPack(`${capability.label} ${capability.boundary}`, evidencePack));
  if (ungroundedCapability) {
    return `Capability "${ungroundedCapability.label}" is not grounded in the current evidence pack.`;
  }
  return null;
}
