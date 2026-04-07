import { ClarifyCategoryKey, ClarifyFailureReasonCode, ClarifyQuestion, DiscoveryProfile } from '../types';

export const MIN_INITIAL_DISCOVERY_QUESTIONS = 4;
export const MAX_INITIAL_DISCOVERY_QUESTIONS = 15;
export const MIN_FOLLOWUP_DISCOVERY_QUESTIONS = 1;
export const MAX_FOLLOWUP_DISCOVERY_QUESTIONS = 8;
export const MAX_TOTAL_DISCOVERY_QUESTIONS = 20;

export const CLARIFY_CATEGORY_ORDER: ClarifyCategoryKey[] = [
  'context_trigger',
  'user_personas',
  'information_architecture',
  'business_rules',
  'state_lifecycle',
  'edge_cases_exceptions',
];

export const CLARIFY_CATEGORY_LABELS: Record<ClarifyCategoryKey, string> = {
  context_trigger: 'Context & Trigger',
  user_personas: 'User Personas',
  information_architecture: 'Information Architecture',
  business_rules: 'Business Rules',
  state_lifecycle: 'State & Lifecycle',
  edge_cases_exceptions: 'Edge Cases & Exceptions',
};

type DiscoveryTemplate = {
  categoryKey: ClarifyCategoryKey;
  intent: string;
  question: string;
  suggestions: string[];
};

type DiscoveryFallbackInput = {
  requirement?: string;
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
  domainSignals?: string[];
  domainRoles?: string[];
};

type DiscoverySignalContext = {
  actor: string;
  businessObject: string;
  businessObjectPlural: string;
  decisionFactor: string;
  identifier: string;
  interactionLabel: string;
  interactionPlural: string;
  channelList: string;
  channels: string[];
  outcome: string;
};

const DOMAIN_SIGNAL_STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'among', 'and', 'any', 'are', 'around', 'because',
  'been', 'before', 'being', 'between', 'both', 'business', 'but', 'capability', 'can', 'could',
  'does', 'each', 'from', 'have', 'into', 'must', 'need', 'needs', 'only', 'other', 'over',
  'process', 'request', 'requests', 'requirement', 'requirements', 'same', 'should', 'software',
  'system', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'under', 'using', 'when', 'where', 'which', 'while', 'with', 'would',
]);

const SUGGESTION_STOPWORDS = new Set([
  'a', 'an', 'and', 'also', 'as', 'at', 'be', 'by', 'for', 'from', 'if', 'in', 'into', 'is',
  'it', 'its', 'of', 'on', 'or', 'so', 'that', 'the', 'their', 'then', 'this', 'to', 'when',
  'while', 'with',
]);

const CHANNEL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'WhatsApp', pattern: /\bwhats?app\b/i },
  { label: 'Phone', pattern: /\b(phone|call|voice)\b/i },
  { label: 'Text', pattern: /\b(text|sms)\b/i },
  { label: 'Email', pattern: /\bemail|e-mail\b/i },
  { label: 'Chat', pattern: /\bchat\b/i },
];

const BUSINESS_OBJECT_CANDIDATES: Array<{ singular: string; plural: string; pattern: RegExp }> = [
  { singular: 'case', plural: 'cases', pattern: /\bcases?\b/i },
  { singular: 'ticket', plural: 'tickets', pattern: /\btickets?\b/i },
  { singular: 'request', plural: 'requests', pattern: /\brequests?\b/i },
  { singular: 'work order', plural: 'work orders', pattern: /\bwork orders?\b/i },
  { singular: 'incident', plural: 'incidents', pattern: /\bincidents?\b/i },
  { singular: 'task', plural: 'tasks', pattern: /\btasks?\b/i },
  { singular: 'conversation', plural: 'conversations', pattern: /\bconversations?\b/i },
  { singular: 'record', plural: 'records', pattern: /\brecords?\b/i },
];

const DISCOVERY_TEMPLATES: DiscoveryTemplate[] = [
  {
    categoryKey: 'context_trigger',
    intent: 'business_outcome',
    question: 'What business problem or outcome should this capability directly address?',
    suggestions: ['Resolve a support need', 'Reduce manual handling', 'Improve response speed', 'Increase visibility'],
  },
  {
    categoryKey: 'context_trigger',
    intent: 'trigger_event',
    question: 'What exact event or condition should trigger this behavior to begin?',
    suggestions: ['User action', 'Incoming communication', 'Status change', 'Scheduled condition'],
  },
  {
    categoryKey: 'context_trigger',
    intent: 'success_signal',
    question: 'What should count as a successful result once this has happened?',
    suggestions: ['Case created correctly', 'Right party notified', 'Record updated', 'Request resolved'],
  },
  {
    categoryKey: 'user_personas',
    intent: 'primary_actor',
    question: 'Who is the primary actor that should initiate or own this capability?',
    suggestions: ['Support agent', 'Operations user', 'Supervisor', 'External contact'],
  },
  {
    categoryKey: 'user_personas',
    intent: 'downstream_actors',
    question: 'Who else is affected by the result or needs visibility into what happened?',
    suggestions: ['Internal team', 'Approver', 'Requester', 'No other actor'],
  },
  {
    categoryKey: 'user_personas',
    intent: 'permissions_scope',
    question: 'Whose permissions, ownership, or access level differ from the default flow?',
    suggestions: ['Admins only differ', 'Managers approve', 'Assigned owner differs', 'No special permissions'],
  },
  {
    categoryKey: 'information_architecture',
    intent: 'required_inputs',
    question: 'What minimum information must be captured or available for this to work correctly?',
    suggestions: ['Identifier only', 'Identifier plus short reason', 'Identifier plus summary', 'Full interaction details'],
  },
  {
    categoryKey: 'information_architecture',
    intent: 'outputs_displays',
    question: 'What output, record, or display should this produce or update?',
    suggestions: ['Only create or update the record', 'Also show a short summary', 'Also notify the owning team', 'Also update a follow-up queue or record'],
  },
  {
    categoryKey: 'information_architecture',
    intent: 'entity_linkage',
    question: 'What identifier or linkage is needed to connect this to the right person, case, or conversation?',
    suggestions: ['Phone number', 'Message thread', 'Customer identifier', 'Case reference'],
  },
  {
    categoryKey: 'business_rules',
    intent: 'core_constraints',
    question: 'What rule or constraint must always be enforced for this behavior to be considered correct?',
    suggestions: ['Eligibility rule', 'Priority rule', 'Approval rule', 'Validation rule'],
  },
  {
    categoryKey: 'business_rules',
    intent: 'timing_dependencies',
    question: 'What timing, sequencing, or dependency rule affects when this can happen?',
    suggestions: ['Immediate only', 'After another step', 'Within a time window', 'Depends on status'],
  },
  {
    categoryKey: 'business_rules',
    intent: 'decision_logic',
    question: 'What decision logic, threshold, or policy should change the outcome here?',
    suggestions: ['Always create a new item', 'Reuse the existing item when it matches', 'Send uncertain cases for review', 'Apply different rules by channel or context'],
  },
  {
    categoryKey: 'state_lifecycle',
    intent: 'lifecycle_states',
    question: 'What statuses or lifecycle states should this move through from start to finish?',
    suggestions: ['Open to closed', 'New to assigned', 'Draft to approved', 'Single state only'],
  },
  {
    categoryKey: 'state_lifecycle',
    intent: 'transition_triggers',
    question: 'What action or event should move this from one state to the next?',
    suggestions: ['Manual action', 'Automatic transition', 'Approval event', 'External update'],
  },
  {
    categoryKey: 'state_lifecycle',
    intent: 'reopen_retry',
    question: 'What should happen if this needs to be retried, reopened, or reversed later?',
    suggestions: ['Reopen existing item', 'Create a new item', 'Allow retry only', 'No reversal allowed'],
  },
  {
    categoryKey: 'edge_cases_exceptions',
    intent: 'missing_data_fallback',
    question: 'What should happen if required information is missing or incomplete at the moment this runs?',
    suggestions: ['Block and notify', 'Create partial record', 'Queue for review', 'Use fallback'],
  },
  {
    categoryKey: 'edge_cases_exceptions',
    intent: 'conflicts_duplicates',
    question: 'What should happen if this conflicts with an existing item or would create a duplicate?',
    suggestions: ['Reuse the existing item', 'Create a new separate item', 'Send the match for review', 'Block the duplicate path'],
  },
  {
    categoryKey: 'edge_cases_exceptions',
    intent: 'offline_failure_behavior',
    question: 'What should happen if a system, channel, or integration is unavailable when this tries to run?',
    suggestions: ['Retry later', 'Queue for recovery', 'Fall back manually', 'Fail and alert'],
  },
];

const CATEGORY_ALIASES: Record<string, ClarifyCategoryKey> = {
  'context trigger': 'context_trigger',
  'context and trigger': 'context_trigger',
  'trigger context': 'context_trigger',
  'trigger and context': 'context_trigger',
  'objective outcome': 'context_trigger',
  'objective and outcome': 'context_trigger',
  'success criteria': 'context_trigger',
  'success and measurement': 'context_trigger',
  'actors ownership': 'user_personas',
  'actors and ownership': 'user_personas',
  'roles personas': 'user_personas',
  'roles and personas': 'user_personas',
  'user personas': 'user_personas',
  'personas': 'user_personas',
  'information architecture': 'information_architecture',
  'inputs data': 'information_architecture',
  'inputs and data': 'information_architecture',
  'data': 'information_architecture',
  'business rules': 'business_rules',
  'rules constraints': 'business_rules',
  'rules and constraints': 'business_rules',
  'dependencies boundaries': 'business_rules',
  'dependencies and boundaries': 'business_rules',
  'state lifecycle': 'state_lifecycle',
  'state and lifecycle': 'state_lifecycle',
  'workflow decisions': 'state_lifecycle',
  'workflow and decisions': 'state_lifecycle',
  'edge cases exceptions': 'edge_cases_exceptions',
  'edge cases and exceptions': 'edge_cases_exceptions',
  'exceptions failure modes': 'edge_cases_exceptions',
  'exceptions and failure modes': 'edge_cases_exceptions',
};

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

function ensureQuestionMark(value: string): string {
  const trimmed = cleanText(value).replace(/[?.!]+$/g, '');
  return trimmed ? `${trimmed}?` : '';
}

function simplifyQuestionCopy(value: string): string {
  return cleanText(value)
    .replace(/["“”'‘’]/g, '')
    .replace(/\((?:as\s+per|per|see|from)\s+[^)]*(?:reference|references|doc|docs|story|stories|evidence|backlog|wi)[^)]*\)/gi, '')
    .replace(/\((?:backlog|reference|references|doc|docs|story|stories|wi)[^)]*\)/gi, '')
    .replace(/\bwhat exact\b/gi, 'what')
    .replace(/\bwhat other events or conditions should\b/gi, 'which policy should')
    .replace(/\bso the team knows this flow is solving the right problem\b/gi, 'first')
    .replace(/\bthat is already present in the supporting evidence\b/gi, 'already in the evidence')
    .replace(/\s+([,?.!])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function sentenceCaseQuestion(value: string): string {
  const normalized = ensureQuestionMark(simplifyQuestionCopy(value));
  if (!normalized) return '';
  return normalized.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function isLikelyCompleteQuestion(value: string): boolean {
  const normalized = cleanText(value);
  if (!normalized) return false;

  if (/['"`]\?$/.test(normalized)) {
    return false;
  }

  return !/\b(a|an|the|and|or|but|to|for|of|with|from|in|on|at|by|as|into|onto|than|then|that|this|these|those|my|your|his|her|our|their|its)\?$/i.test(normalized);
}

function toSnakeCase(value: string): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function articleFor(word: string): 'a' | 'an' {
  return /^[aeiou]/i.test(word.trim()) ? 'an' : 'a';
}

function withArticle(word: string): string {
  return `${articleFor(word)} ${word}`;
}

function formatChoiceList(values: string[], conjunction = 'or'): string {
  const unique = uniqueStrings(values);
  if (!unique.length) return '';
  if (unique.length === 1) return unique[0];
  if (unique.length === 2) return `${unique[0]} ${conjunction} ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')}, ${conjunction} ${unique[unique.length - 1]}`;
}

function combinedContextParts(input: DiscoveryFallbackInput): string[] {
  return [
    input.requirement,
    input.attachmentText,
    input.wiContextText,
    input.similarStoriesText,
    ...(input.domainSignals ?? []),
    ...(input.domainRoles ?? []),
  ].filter(Boolean) as string[];
}

function combinedContextText(input: DiscoveryFallbackInput): string {
  return [
    ...combinedContextParts(input),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

export function extractDiscoverySignals(parts: string[]): string[] {
  const counts = new Map<string, number>();

  for (const part of parts) {
    const matches = part.match(/\b[A-Za-z][A-Za-z0-9/-]{2,}\b/g) ?? [];
    for (const raw of matches) {
      const normalized = raw.trim();
      const lower = normalized.toLowerCase();
      if (DOMAIN_SIGNAL_STOPWORDS.has(lower)) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => {
      const frequencyDelta = right[1] - left[1];
      return frequencyDelta !== 0 ? frequencyDelta : right[0].length - left[0].length;
    })
    .map(([signal]) => signal)
    .slice(0, 14);
}

function extractCanonicalChannels(text: string): string[] {
  const channels: string[] = [];
  CHANNEL_PATTERNS.forEach(({ label, pattern }) => {
    if (pattern.test(text)) channels.push(label);
  });
  return channels;
}

function pickPrimaryActor(text: string, roles: string[], signals: string[]): string {
  const explicit = text.match(/\bAs\s+an?\s+([^,.\n]{2,80})/i)?.[1]?.trim();
  if (explicit) return explicit;

  const roleCandidates = uniqueStrings([
    ...roles,
    ...signals.filter((signal) => /\b(agent|manager|owner|reviewer|approver|supervisor|dispatcher|planner|operator|coordinator|admin|tss|customer|caller|sender|requester|assignee)\b/i.test(signal)),
  ]);

  return roleCandidates[0] ?? 'the primary user';
}

function pickBusinessObject(text: string, signals: string[]): { singular: string; plural: string } {
  const matched = BUSINESS_OBJECT_CANDIDATES.find((candidate) => candidate.pattern.test(text));
  if (matched) {
    return { singular: matched.singular, plural: matched.plural };
  }

  const signalObject = signals.find((signal) => /\b(case|ticket|request|incident|task|conversation|record|work order)\b/i.test(signal));
  if (signalObject) {
    const normalized = signalObject.toLowerCase();
    const matchedSignal = BUSINESS_OBJECT_CANDIDATES.find((candidate) => normalized.includes(candidate.singular));
    if (matchedSignal) {
      return { singular: matchedSignal.singular, plural: matchedSignal.plural };
    }
  }

  return { singular: 'record', plural: 'records' };
}

function pickInteractionLabels(text: string, channels: string[]): { singular: string; plural: string } {
  if (channels.length) {
    return {
      singular: 'incoming interaction',
      plural: `incoming interactions across ${formatChoiceList(channels)}`,
    };
  }

  if (/\bcalls?\b/i.test(text)) return { singular: 'call', plural: 'calls' };
  if (/\bmessages?\b/i.test(text)) return { singular: 'message', plural: 'messages' };
  if (/\bemails?\b/i.test(text)) return { singular: 'email', plural: 'emails' };
  if (/\bconversations?\b/i.test(text)) return { singular: 'conversation', plural: 'conversations' };
  return { singular: 'incoming request', plural: 'incoming requests' };
}

function pickIdentifierSignal(text: string, businessObject: string): string {
  const patterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'phone number or caller identity', pattern: /\b(phone number|caller id|caller identity|caller details)\b/i },
    { label: 'message or email thread', pattern: /\b(message thread|email thread|conversation thread|thread)\b/i },
    { label: 'customer identifier', pattern: /\b(customer id|customer identifier|account id|account number|customer number)\b/i },
    { label: `${businessObject} reference`, pattern: /\b(case reference|ticket number|request id|reference)\b/i },
    { label: 'contact identifier', pattern: /\b(contact|sender|recipient)\b/i },
  ];
  return patterns.find((entry) => entry.pattern.test(text))?.label ?? 'customer identifier';
}

function pickDecisionFactor(text: string, channels: string[]): string {
  const patterns: Array<{ label: string; pattern: RegExp }> = [
    { label: 'caller identity', pattern: /\b(caller identity|caller details|identified caller)\b/i },
    { label: 'duplicate detection', pattern: /\bduplicate|conflict|existing open\b/i },
    { label: 'channel type', pattern: /\bchannel|phone|whats?app|text|sms|email|chat\b/i },
    { label: 'priority or SLA', pattern: /\bpriority|sla|deadline|due date|urgency\b/i },
    { label: 'ownership or permissions', pattern: /\bowner|ownership|permission|access|role|approv/i },
  ];
  if (channels.length >= 2) return 'channel type';
  return patterns.find((entry) => entry.pattern.test(text))?.label ?? 'business context';
}

function pickOutcome(text: string, businessObjectPlural: string): string {
  if (/\bduplicate|duplicates\b/i.test(text)) {
    return `avoid duplicate ${businessObjectPlural}`;
  }
  if (/\bautomatic|automatically|automation\b/i.test(text)) {
    return `create ${businessObjectPlural} consistently`;
  }
  if (/\bvisibility|visible|overview\b/i.test(text)) {
    return `improve visibility into ${businessObjectPlural}`;
  }
  return `handle ${businessObjectPlural} correctly`;
}

function buildDiscoveryContext(input?: DiscoveryFallbackInput): DiscoverySignalContext {
  const parts = input ? combinedContextParts(input) : [];
  const rawText = parts.join('\n');
  const signals = uniqueStrings([
    ...(input?.domainSignals ?? []),
    ...extractDiscoverySignals(parts),
  ]);
  const channels = extractCanonicalChannels(rawText);
  const { singular: businessObject, plural: businessObjectPlural } = pickBusinessObject(rawText, signals);
  const { singular: interactionLabel, plural: interactionPlural } = pickInteractionLabels(rawText, channels);

  return {
    actor: pickPrimaryActor(rawText, input?.domainRoles ?? [], signals),
    businessObject,
    businessObjectPlural,
    decisionFactor: pickDecisionFactor(rawText, channels),
    identifier: pickIdentifierSignal(rawText, businessObject),
    interactionLabel,
    interactionPlural,
    channelList: formatChoiceList(channels),
    channels,
    outcome: pickOutcome(rawText, businessObjectPlural),
  };
}

function uniqueCategoryKeys(values: ClarifyCategoryKey[]): ClarifyCategoryKey[] {
  return CLARIFY_CATEGORY_ORDER.filter((key) => values.includes(key));
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

function normalizeSuggestionComparisonKey(value: string): string {
  return normalizeKey(value)
    .split(' ')
    .filter((token) => token && !SUGGESTION_STOPWORDS.has(token))
    .join(' ');
}

function simplifySuggestionCopy(value: string): string {
  return cleanText(value)
    .replace(/\bmaterially\b/gi, 'really')
    .replace(/\bsubsequent\b/gi, 'later')
    .replace(/\butili[sz]e\b/gi, 'use')
    .replace(/\bprior to\b/gi, 'before')
    .replace(/\bdownstream\b/gi, 'follow-up')
    .replace(/\bthere is enough detail to\b/gi, 'there is enough detail to')
    .replace(/\bas soon as\b/gi, 'when')
    .replace(/\bdo not\b/gi, "don't")
    .replace(/\bwhenever\b/gi, 'when')
    .replace(/\bthe owning team\b/gi, 'the team')
    .replace(/\bthe interaction\b/gi, 'the request')
    .replace(/\bthe automatic path\b/gi, 'automation')
    .replace(/\bmanual triage\b/gi, 'manual review')
    .replace(/\bfor follow-up\b/gi, 'for next steps')
    .replace(/\bstraight away\b/gi, 'right away')
    .replace(/\bno extra\b/gi, 'no additional')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/g, '')
    .trim();
}

function overlapRatio(left: string, right: string): number {
  const leftTokens = new Set(normalizeSuggestionComparisonKey(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeSuggestionComparisonKey(right).split(' ').filter(Boolean));
  if (!leftTokens.size || !rightTokens.size) return 0;

  let shared = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) shared += 1;
  });

  const denominator = Math.max(leftTokens.size, rightTokens.size);
  return denominator > 0 ? shared / denominator : 0;
}

function inferSuggestionArchetype(intent: string, value: string): string | null {
  const normalized = normalizeKey(value);
  const prefix = `${intent}:`;

  if (/\b(no extra|no special|single active|only create|case only|create or update the case only)\b/.test(normalized)) return `${prefix}minimal_only`;
  if (/\b(summary|short summary)\b/.test(normalized)) return `${prefix}summary`;
  if (/\b(notify|notification|visible|visibility)\b/.test(normalized)) return `${prefix}notify_visibility`;
  if (/\b(manual|review|triage)\b/.test(normalized)) return `${prefix}manual_review`;
  if (/\b(existing|reuse|reopen|update the existing)\b/.test(normalized)) return `${prefix}existing_item`;
  if (/\b(new|linked new|fresh item)\b/.test(normalized)) return `${prefix}new_item`;
  if (/\b(admin|manager|supervisor|approv)\b/.test(normalized)) return `${prefix}approval`;
  if (/\b(full|full email body|full interaction)\b/.test(normalized)) return `${prefix}full_detail`;
  if (/\b(minimum|minimum usable|core summary|identifier|short summary)\b/.test(normalized)) return `${prefix}minimum_detail`;
  if (/\b(retry|recovery|queue)\b/.test(normalized)) return `${prefix}retry_queue`;
  if (/\b(alert|fail)\b/.test(normalized)) return `${prefix}fail_alert`;
  if (/\b(all listed|every listed|all eligible)\b/.test(normalized)) return `${prefix}broad_path`;
  if (/\bonly after|only allow|only when|while the others stay manual\b/.test(normalized)) return `${prefix}restricted_path`;
  if (/\b(simple new assigned and resolved|single active state|new pending and closed)\b/.test(normalized)) return `${prefix}lifecycle_path`;

  return null;
}

function normalizeSuggestionChoices(
  categoryKey: ClarifyCategoryKey,
  intent: string,
  suggestions: string[],
  input?: DiscoveryFallbackInput,
  opts: { allowTemplateFallback?: boolean } = {},
): string[] {
  const normalizedProvidedSuggestions = uniqueStrings(suggestions.map(simplifySuggestionCopy));
  const template = categoryTemplates(categoryKey).find((candidate) => candidate.intent === intent)
    ?? categoryTemplates(categoryKey)[0];
  const candidates = normalizedProvidedSuggestions.length
    ? normalizedProvidedSuggestions
    : opts.allowTemplateFallback
      ? uniqueStrings(
          (template
            ? uniqueStrings([
                ...contextualizeDiscoveryTemplate(template, input).suggestions,
                ...template.suggestions,
              ])
            : []
          ).map(simplifySuggestionCopy),
        )
      : [];

  const result: string[] = [];
  const archetypes = new Set<string>();

  for (const candidate of candidates) {
    const normalizedCandidate = simplifySuggestionCopy(candidate);
    if (!normalizedCandidate) continue;

    const archetype = inferSuggestionArchetype(intent, normalizedCandidate);
    if (archetype && archetypes.has(archetype)) continue;
    if (result.some((existing) => {
      const left = normalizeSuggestionComparisonKey(existing);
      const right = normalizeSuggestionComparisonKey(normalizedCandidate);
      return left === right || left.includes(right) || right.includes(left) || overlapRatio(existing, normalizedCandidate) >= 0.72;
    })) continue;

    result.push(normalizedCandidate);
    if (archetype) archetypes.add(archetype);
    if (result.length >= 4) break;
  }

  return result;
}

function categoryTemplates(categoryKey: ClarifyCategoryKey): DiscoveryTemplate[] {
  return DISCOVERY_TEMPLATES.filter((template) => template.categoryKey === categoryKey);
}

export function labelForCategoryKey(categoryKey: ClarifyCategoryKey): string {
  return CLARIFY_CATEGORY_LABELS[categoryKey];
}

function contextualizeDiscoveryTemplate(
  template: DiscoveryTemplate,
  input?: DiscoveryFallbackInput,
): DiscoveryTemplate {
  const ctx = buildDiscoveryContext(input);
  const businessObjectPhrase = withArticle(ctx.businessObject);
  const channelScope = ctx.channelList ? ` across ${ctx.channelList}` : '';

  switch (template.intent) {
    case 'business_outcome':
      return {
        ...template,
        question: `What should automatic ${ctx.businessObject} handling${channelScope} improve first?`,
        suggestions: uniqueStrings([
          `Reduce manual work${channelScope} while still creating the right ${ctx.businessObject}`,
          `Make ${ctx.businessObject} ownership clear as soon as the request is captured`,
          `Prevent duplicate ${ctx.businessObjectPlural} without losing key context`,
          `Improve visibility so the next team can act without rechecking the request`,
        ]).slice(0, 4),
      };
    case 'trigger_event':
      return {
        ...template,
        question: ctx.channels.length
          ? `Which trigger policy should start ${ctx.businessObject} creation across ${ctx.channelList}?`
          : `When should ${businessObjectPhrase} be created automatically?`,
        suggestions: uniqueStrings([
          ctx.channels.length >= 2
            ? 'Start automatically for every listed channel once the request is usable'
            : `Start as soon as the ${ctx.interactionLabel} is usable`,
          'Start only after the key context has been confirmed',
          'Send unclear requests to manual review instead of starting automatically',
          ctx.channels.length >= 2
            ? `Start automatically for selected channels only, and keep the rest manual`
            : `Wait for a quick review when the trigger is still uncertain`,
        ]).slice(0, 4),
      };
    case 'success_signal':
      return {
        ...template,
        question: `What should count as a successful ${ctx.businessObject} outcome?`,
        suggestions: uniqueStrings([
          `The right ${ctx.businessObject} is created or updated and ownership is clear`,
          'The next team has enough context without reopening the original request',
          `No duplicate ${ctx.businessObjectPlural} are created and the record stays accurate`,
          'The flow succeeds but still flags cases that need a person to review them',
        ]).slice(0, 4),
      };
    case 'primary_actor':
      return {
        ...template,
        question: `Who should own ${ctx.businessObject} handling when the ${ctx.interactionLabel} first enters this flow?`,
        suggestions: uniqueStrings([
          `${ctx.actor} should own the default path, with exceptions routed to a supervisor when they cannot act`,
          'A shared operations queue should own intake first, then assign the work once the interaction is understood',
          'A supervisor or manager should decide ownership whenever the normal assignee is unclear',
          'Manual triage should own the first pass before responsibility moves to the final working team',
        ]).slice(0, 4),
      };
    case 'downstream_actors':
      return {
        ...template,
        question: `Who else needs visibility or notification after ${businessObjectPhrase} is created from the ${ctx.interactionLabel}?`,
        suggestions: uniqueStrings([
          'Related internal teams should see the outcome, but only the owning team should act by default',
          'A supervisor or approver should only be brought in when the flow hits an exception or conflict',
          'The original requester or contact should receive visibility when the outcome affects their next step',
          'No extra visibility is needed beyond the owning team unless the case is escalated',
        ]).slice(0, 4),
      };
    case 'permissions_scope':
      return {
        ...template,
        question: `Who should be allowed to override the default ${ctx.businessObject} handling path when an exception appears?`,
        suggestions: uniqueStrings([
          'Only admins or supervisors should be able to override the default path and the reason should remain visible afterward',
          `${ctx.actor} can make routine overrides, but higher-risk exceptions should still go to a manager`,
          'Managers should approve overrides whenever the decision changes ownership, priority, or duplicate handling',
          'No special override path is needed because the standard flow should cover normal cases',
        ]).slice(0, 4),
      };
    case 'required_inputs':
      return {
        ...template,
        question: `What is the minimum information needed before the ${ctx.businessObject} can be created or updated?`,
        suggestions: uniqueStrings([
          `Require ${ctx.identifier} only before creating the ${ctx.businessObject}`,
          `Require ${ctx.identifier} plus the reason for contact`,
          ctx.channels.includes('Email')
            ? 'For email, require the sender, subject, and a short summary'
            : `Require ${ctx.identifier}, the reason, and a short summary`,
          `Require the full request details before creating the ${ctx.businessObject}`,
        ]).slice(0, 4),
      };
    case 'outputs_displays':
      return {
        ...template,
        question: `What else should this flow produce besides the ${ctx.businessObject} itself?`,
        suggestions: uniqueStrings([
          `Only create or update the ${ctx.businessObject}`,
          'Also show a short summary for the team',
          'Also notify the team when the record is ready',
          'Also update the follow-up queue the team already uses',
        ]).slice(0, 4),
      };
    case 'entity_linkage':
      return {
        ...template,
        question: `Which identifier should the flow trust first when linking the ${ctx.businessObject} to the right customer, contact, or prior conversation?`,
        suggestions: uniqueStrings([
          `${ctx.identifier} should be the primary match, with manual review if it points to more than one plausible record`,
          ctx.channels.length >= 2
            ? 'Use the conversation or email thread first, then fall back to the customer identifier when the thread is unclear'
            : `Use the existing open ${ctx.businessObject} reference first, then fall back to the customer identifier`,
          'Use the customer or account identifier as the main linkage unless a stronger case-level reference already exists',
          `Use a related ${ctx.businessObject} reference when it exists, and queue uncertain matches for human review`,
        ]).slice(0, 4),
      };
    case 'core_constraints':
      return {
        ...template,
        question: `What business rule must always be enforced before ${businessObjectPhrase} is created or updated from the ${ctx.interactionLabel}?`,
        suggestions: uniqueStrings([
          'Only proceed when the mandatory context is present; otherwise stop the automatic path and route for review',
          ctx.channels.length
            ? `Only allow the automatic path for eligible ${ctx.channelList} channels and keep the others manual`
            : 'Only allow the default path for eligible requests that meet the business criteria',
          `Never create duplicate ${ctx.businessObjectPlural} when an open one already fits the interaction`,
          'Allow exceptions only when a supervisor or designated approver explicitly accepts the risk',
        ]).slice(0, 4),
      };
    case 'timing_dependencies':
      return {
        ...template,
        question: `What timing or sequencing rule affects when the ${ctx.businessObject} should be created, rather than waiting for another step?`,
        suggestions: uniqueStrings([
          'Create it immediately once the interaction is usable, without waiting for extra downstream activity',
          'Create it only after triage confirms the interaction belongs in this workflow',
          'Create it within the supported time window, but hold it outside that window until the team can act',
          'Wait until a prior check or confirmation completes because the timing changes the correct outcome',
        ]).slice(0, 4),
      };
    case 'decision_logic':
      return {
        ...template,
        question: `How should the flow choose between a new ${ctx.businessObject} and an existing one?`,
        suggestions: uniqueStrings([
          `Always create a new ${ctx.businessObject} because each interaction should stand on its own`,
          `Reuse the existing open ${ctx.businessObject} when the identifier and context clearly match`,
          'Send uncertain matches for review instead of deciding automatically',
          `Use ${ctx.decisionFactor} as the tie-breaker when both paths look possible`,
        ]).slice(0, 4),
      };
    case 'lifecycle_states':
      return {
        ...template,
        question: `What lifecycle states should the ${ctx.businessObject} move through after it is created so ownership and progress stay clear?`,
        suggestions: uniqueStrings([
          'Use a simple new, assigned, and resolved lifecycle with clear ownership at each step',
          'Start in triage, then move to assigned and resolved once the owning team accepts the work',
          'Keep a single active state because extra lifecycle detail would not change how the team works',
          'Use new, pending, and closed so waiting work remains visible before final resolution',
        ]).slice(0, 4),
      };
    case 'transition_triggers':
      return {
        ...template,
        question: `What event should move the ${ctx.businessObject} out of its initial state and into the next working stage?`,
        suggestions: uniqueStrings([
          'Manual triage should move it forward because the next step depends on a human judgment call',
          'Automatic routing should move it forward once the business rules identify the correct owner',
          'Owner acceptance should be the trigger so teams are not assigned work they have not yet taken on',
          ctx.channels.length
            ? `A new update from ${ctx.channelList} should move it forward when that update changes the business context`
            : `A new ${ctx.interactionLabel} update should move it forward when it materially changes the next action`,
        ]).slice(0, 4),
      };
    case 'reopen_retry':
      return {
        ...template,
        question: `When should a later ${ctx.interactionLabel} reopen a closed ${ctx.businessObject} instead of creating a linked new one?`,
        suggestions: uniqueStrings([
          `Reopen the existing ${ctx.businessObject} when the new interaction is clearly part of the same unresolved issue`,
          `Create a linked new ${ctx.businessObject} when the prior one is closed for a reason that should stay intact`,
          'Allow the flow to retry certain steps without reopening the full record if the business issue has not changed',
          'No reopen path is needed because any later contact should be treated as a fresh item',
        ]).slice(0, 4),
      };
    case 'missing_data_fallback':
      return {
        ...template,
        question: `What should happen when the ${ctx.interactionLabel} does not contain enough detail to create or update the ${ctx.businessObject} confidently?`,
        suggestions: uniqueStrings([
          'Queue it for manual review so someone can decide the next step without losing the interaction',
          `Create a partial ${ctx.businessObject} so the work stays visible, then let the owning team complete the missing detail`,
          'Hold the automatic path until the missing details are added, while keeping the pending item visible to the team',
          `Notify ${ctx.actor} or the owning queue that more information is needed before the case can move forward`,
        ]).slice(0, 4),
      };
    case 'conflicts_duplicates':
      return {
        ...template,
        question: `What should happen when the ${ctx.interactionLabel} appears to match an existing ${ctx.businessObject} and could create a duplicate?`,
        suggestions: uniqueStrings([
          `Reuse the open ${ctx.businessObject} when the interaction clearly belongs to the same unresolved issue`,
          `Create a new ${ctx.businessObject} when each interaction should stay separate even if the match looks close`,
          'Send the possible duplicate for review whenever the match is plausible but not certain',
          `Block duplicate ${ctx.businessObjectPlural} unless an approved business reason justifies keeping them separate`,
        ]).slice(0, 4),
      };
    case 'offline_failure_behavior':
      return {
        ...template,
        question: `What should the business expect if the source channel or integration is unavailable during ${ctx.businessObject} creation?`,
        suggestions: uniqueStrings([
          'Retry automatically for a short period, then surface the item for manual recovery if the outage continues',
          'Queue the work for recovery so the interaction is not lost while the channel is unavailable',
          'Switch to manual handling once the outage crosses the point where the SLA or customer experience is at risk',
          'Fail visibly and alert the team when the business needs someone to intervene straight away',
        ]).slice(0, 4),
      };
    default:
      return template;
  }
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
  if (/\b(missing|duplicate|conflict|offline|unavailable|error|fail|fallback|exception|invalid)\b/.test(normalized)) {
    return 'edge_cases_exceptions';
  }
  if (/\b(rule|constraint|priority|validation|approval|threshold|policy|dependency|sequence|timing|rank|score)\b/.test(normalized)) {
    return 'business_rules';
  }
  if (/\b(input|output|field|data|capture|extract|display|record|identifier|link|associate|update)\b/.test(normalized)) {
    return 'information_architecture';
  }
  if (/\b(who|actor|owner|permission|access|role|team|persona|visibility)\b/.test(normalized)) {
    return 'user_personas';
  }
  return 'context_trigger';
}

export function normalizeQuestionIntent(value: unknown, categoryKey: ClarifyCategoryKey, fallbackQuestion?: string): string {
  const provided = toSnakeCase(String(value ?? ''));
  if (provided) return provided;
  void fallbackQuestion;
  const template = categoryTemplates(categoryKey)[0];
  return template?.intent ?? `clarify_${categoryKey}`;
}

function splitGroupedQuestion(question: string): string[] {
  const normalized = ensureQuestionMark(question);
  if (!normalized) return [];

  const numberedMatches = [...normalized.matchAll(/(?:^|[\s,;])(\d+)\.\s*([^?]+?)(?=(?:[\s,;]+(?:and\s+)?\d+\.\s)|\?$)/g)];
  if (numberedMatches.length >= 2) {
    const prefix = cleanText(normalized.slice(0, numberedMatches[0].index ?? 0).replace(/[:;,]\s*$/g, ''));
    return numberedMatches
      .map((match) => {
        const fragment = cleanText(match[2]).replace(/^(and|or)\s+/i, '');
        if (!fragment) return '';
        const combined = prefix ? `${prefix} ${fragment}` : fragment;
        return ensureQuestionMark(combined);
      })
      .filter(Boolean);
  }

  return [normalized];
}

function normalizeQuestionText(question: string): string {
  const raw = cleanText(question);
  if (/[A-Za-z0-9]['"`‘’]$/.test(raw)) return '';
  const normalized = sentenceCaseQuestion(question);
  return isLikelyCompleteQuestion(normalized) ? normalized : '';
}

function normalizeQuestions(
  questions: ClarifyQuestion[],
  alreadyAsked: Set<string>,
  input?: DiscoveryFallbackInput,
): ClarifyQuestion[] {
  const seen = new Set(alreadyAsked);
  const result: ClarifyQuestion[] = [];

  questions.forEach((question) => {
    const normalizedQuestion = normalizeQuestionText(question.question);
    if (!normalizedQuestion) return;
    const key = normalizeKey(normalizedQuestion);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const normalizedIntent = normalizeQuestionIntent(question.intent, question.categoryKey, normalizedQuestion);
    const providedSuggestions = uniqueStrings(question.suggestions).slice(0, 4);
    result.push({
      categoryKey: question.categoryKey,
      category: labelForCategoryKey(question.categoryKey),
      intent: normalizedIntent,
      question: normalizedQuestion,
      suggestions: normalizeSuggestionChoices(question.categoryKey, normalizedIntent, providedSuggestions, input),
    });
  });

  return result;
}

function questionComparator(left: ClarifyQuestion, right: ClarifyQuestion): number {
  const leftIndex = CLARIFY_CATEGORY_ORDER.indexOf(left.categoryKey);
  const rightIndex = CLARIFY_CATEGORY_ORDER.indexOf(right.categoryKey);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.question.localeCompare(right.question);
}

function buildFallbackQuestions(
  categoryKeys: ClarifyCategoryKey[],
  alreadyAsked: Set<string>,
  needed: number,
  input?: DiscoveryFallbackInput,
): ClarifyQuestion[] {
  if (needed <= 0) return [];

  const orderedKeys = uniqueCategoryKeys(categoryKeys);
  const primaryTemplates = [
    ...orderedKeys.map((categoryKey) => categoryTemplates(categoryKey)[0]).filter(Boolean),
    ...CLARIFY_CATEGORY_ORDER
      .filter((categoryKey) => !orderedKeys.includes(categoryKey))
      .map((categoryKey) => categoryTemplates(categoryKey)[0])
      .filter(Boolean),
  ];
  const secondaryTemplates = [
    ...orderedKeys.flatMap((categoryKey) => categoryTemplates(categoryKey).slice(1)),
    ...CLARIFY_CATEGORY_ORDER
      .filter((categoryKey) => !orderedKeys.includes(categoryKey))
      .flatMap((categoryKey) => categoryTemplates(categoryKey).slice(1)),
  ];
  const templates = [...primaryTemplates, ...secondaryTemplates];

  const questions: ClarifyQuestion[] = [];
  for (const template of templates) {
    const contextualTemplate = contextualizeDiscoveryTemplate(template, input);
    const normalizedQuestion = normalizeQuestionText(contextualTemplate.question);
    const key = normalizeKey(normalizedQuestion);
    if (!key || alreadyAsked.has(key)) continue;
    alreadyAsked.add(key);
    questions.push({
      categoryKey: contextualTemplate.categoryKey,
      category: labelForCategoryKey(contextualTemplate.categoryKey),
      intent: contextualTemplate.intent,
      question: normalizedQuestion,
      suggestions: normalizeSuggestionChoices(
        contextualTemplate.categoryKey,
        contextualTemplate.intent,
        contextualTemplate.suggestions,
        input,
        { allowTemplateFallback: true },
      ),
    });
    if (questions.length >= needed) break;
  }

  return questions;
}

function inferRequiredCategoryKeys(input: {
  requirement?: string;
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
}): ClarifyCategoryKey[] {
  const text = combinedContextText(input);
  const required = new Set<ClarifyCategoryKey>();

  const hasActor = /\b(user|users|actor|agent|manager|owner|approver|reviewer|team|customer|caller|sender|recipient|operator|requester|assignee|contact)\b/.test(text);
  const hasPermission = /\b(permission|permissions|access|role|roles|owner|ownership|approve|approval|visibility|who can|who may)\b/.test(text);
  if (!hasActor || !hasPermission) required.add('user_personas');

  const hasTrigger = /\b(trigger|when|after|before|upon|once|if|incoming|arrival|creation|submission|request|call|message|event)\b/.test(text);
  const hasOutcome = /\b(outcome|goal|success|result|measure|kpi|solve|resolve|improve|ensure|so that)\b/.test(text);
  if (!hasTrigger || !hasOutcome) required.add('context_trigger');

  if (/\b(capture|captured|extract|populate|field|fields|data|input|output|record|display|show|identifier|id|associate|link|details|metadata|channel|channels|message content|call duration)\b/.test(text)) {
    required.add('information_architecture');
  }

  const hasMultiVariantScope =
    /\b(various|multiple|different|several|many|across|multi(?:ple)?|omni(?:channel)?|all channels)\b/.test(text)
    || (text.match(/,/g)?.length ?? 0) >= 3;
  if (hasMultiVariantScope) {
    required.add('information_architecture');
  }

  if (/\b(rule|rules|constraint|constraints|priority|validation|timing|dependency|dependencies|calculation|approval|policy|threshold|rank|score|sla|deadline|only|unless|must)\b/.test(text)) {
    required.add('business_rules');
  }

  const hasAutomation = /\b(automatic|automatically|automation|auto[-\s]?create|auto[-\s]?assign|auto[-\s]?route)\b/.test(text);
  if (hasAutomation) {
    required.add('business_rules');
  }

  if (/\b(status|statuses|state|states|lifecycle|transition|transitions|stage|stages|draft|approved|open|closed|reopen|retry|complete|completion|cancel|queue)\b/.test(text)) {
    required.add('state_lifecycle');
  }

  const hasEntityLifecycle = /\b(create|created|open|opened|update|updated|assign|assigned|route|routed|close|closed|manage|managed|track|tracked|case|cases|ticket|tickets|request|requests|record|records|conversation|conversations)\b/.test(text);
  if (hasAutomation && hasEntityLifecycle) {
    required.add('state_lifecycle');
  }

  if (/\b(automatic|automation|integration|offline|missing|incomplete|conflict|duplicate|fallback|error|failure|exception|exceptions|invalid|unavailable|retry)\b/.test(text)) {
    required.add('edge_cases_exceptions');
  }

  return uniqueCategoryKeys([...required]);
}

function categoryCoverageKeys(profile: DiscoveryProfile, input?: {
  requirement?: string;
  attachmentText?: string;
  wiContextText?: string;
  similarStoriesText?: string;
}): ClarifyCategoryKey[] {
  const inferred = input ? inferRequiredCategoryKeys(input) : [];
  return uniqueCategoryKeys([...profile.missingCategoryKeys, ...inferred]);
}

function raiseScope(
  current: DiscoveryProfile['scope'],
  minimum: DiscoveryProfile['scope'],
): DiscoveryProfile['scope'] {
  const rank: DiscoveryProfile['scope'][] = ['narrow', 'moderate', 'broad', 'very_broad'];
  return rank[Math.max(rank.indexOf(current), rank.indexOf(minimum))] ?? current;
}

function raiseComplexity(
  current: DiscoveryProfile['complexity'],
  minimum: DiscoveryProfile['complexity'],
): DiscoveryProfile['complexity'] {
  const rank: DiscoveryProfile['complexity'][] = ['low', 'medium', 'high', 'very_high'];
  return rank[Math.max(rank.indexOf(current), rank.indexOf(minimum))] ?? current;
}

function raiseAmbiguity(
  current: DiscoveryProfile['ambiguity'],
  minimum: DiscoveryProfile['ambiguity'],
): DiscoveryProfile['ambiguity'] {
  const rank: DiscoveryProfile['ambiguity'][] = ['low', 'medium', 'high'];
  return rank[Math.max(rank.indexOf(current), rank.indexOf(minimum))] ?? current;
}

export function calibrateDiscoveryProfile(
  profile: DiscoveryProfile,
  opts: {
    requiredCategoryKeys?: ClarifyCategoryKey[];
    repairApplied?: boolean;
    repairedQuestionCount?: number;
  } = {},
): DiscoveryProfile {
  const requiredCategoryKeys = uniqueCategoryKeys(opts.requiredCategoryKeys ?? profile.missingCategoryKeys);
  const breadth = requiredCategoryKeys.length;
  const repairedQuestionCount = Math.max(0, opts.repairedQuestionCount ?? profile.recommendedInitialCount);
  const repairApplied = Boolean(opts.repairApplied);

  let scope = profile.scope;
  let complexity = profile.complexity;
  let ambiguity = profile.ambiguity;
  let recommendedInitialCount = profile.recommendedInitialCount;

  if (breadth >= 4) {
    scope = raiseScope(scope, 'moderate');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
  }

  if (breadth >= 6) {
    scope = raiseScope(scope, 'broad');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
  }

  if (repairApplied) {
    scope = raiseScope(scope, breadth >= 5 ? 'broad' : 'moderate');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
  }

  if (repairedQuestionCount > 0) {
    recommendedInitialCount = repairedQuestionCount;
  }

  return {
    ...profile,
    scope,
    complexity,
    ambiguity,
    missingCategoryKeys: requiredCategoryKeys,
    recommendedInitialCount: Math.max(0, Math.round(recommendedInitialCount)),
  };
}

export function normalizeDiscoveryProfile(
  candidate?: Partial<DiscoveryProfile> | null,
  fallbackQuestionCount = 8,
): DiscoveryProfile {
  const scope = cleanText(candidate?.scope).toLowerCase();
  const complexity = cleanText(candidate?.complexity).toLowerCase();
  const ambiguity = cleanText(candidate?.ambiguity).toLowerCase();
  const recommendedInitialCount = Math.max(
    0,
    Number.isFinite(candidate?.recommendedInitialCount)
      ? Number(candidate?.recommendedInitialCount)
      : fallbackQuestionCount,
  );
  const rawMissing = Array.isArray((candidate as { missingCategoryKeys?: unknown[] } | null | undefined)?.missingCategoryKeys)
    ? ((candidate as { missingCategoryKeys?: unknown[] }).missingCategoryKeys ?? [])
    : [];

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
    missingCategoryKeys: uniqueCategoryKeys(
      rawMissing
        .map((value) => normalizeCategoryKey(value))
        .filter((value): value is ClarifyCategoryKey => Boolean(value)),
    ),
    recommendedInitialCount: Math.round(recommendedInitialCount),
    followupCap: Math.max(0, Math.round(Number.isFinite(candidate?.followupCap) ? Number(candidate?.followupCap) : 4)),
  };
}

type InitialDiscoveryValidation = {
  valid: boolean;
  requiredCategoryKeys: ClarifyCategoryKey[];
  failureReasonCode: ClarifyFailureReasonCode | null;
};

function validateInitialDiscoveryQuestions(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
  input?: DiscoveryFallbackInput,
): InitialDiscoveryValidation {
  const requiredCategoryKeys = categoryCoverageKeys(profile, input);
  if (!questions.length && profile.recommendedInitialCount > 0) {
    return {
      valid: false,
      requiredCategoryKeys,
      failureReasonCode: 'invalid_empty_questions',
    };
  }

  return {
    valid: true,
    requiredCategoryKeys,
    failureReasonCode: null,
  };
}

export function validateAndRepairInitialDiscovery(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
  input?: DiscoveryFallbackInput,
): {
  questions: ClarifyQuestion[];
  discoveryProfile: DiscoveryProfile;
  repairApplied: boolean;
  failureReasonCode: ClarifyFailureReasonCode | null;
} {
  const initialValidation = validateInitialDiscoveryQuestions(questions, profile, input);
  const calibratedProfile = calibrateDiscoveryProfile(profile, {
    requiredCategoryKeys: initialValidation.requiredCategoryKeys,
    repairApplied: false,
    repairedQuestionCount: questions.length,
  });
  const finalizedQuestions = finalizeInitialDiscoveryQuestions(questions, calibratedProfile, input);
  const finalizedValidation = validateInitialDiscoveryQuestions(finalizedQuestions, calibratedProfile, input);
  const initialRepairApplied =
    !initialValidation.valid
    || questions.length !== finalizedQuestions.length;

  if (finalizedValidation.valid) {
    return {
      questions: finalizedQuestions,
      discoveryProfile: calibrateDiscoveryProfile(
        {
          ...calibratedProfile,
          recommendedInitialCount: finalizedQuestions.length,
        },
        {
          requiredCategoryKeys: finalizedValidation.requiredCategoryKeys,
          repairApplied: initialRepairApplied,
          repairedQuestionCount: finalizedQuestions.length,
        },
      ),
      repairApplied: initialRepairApplied,
      failureReasonCode: null,
    };
  }

  const repairedProfile = calibrateDiscoveryProfile(
    calibratedProfile,
    {
      requiredCategoryKeys: finalizedValidation.requiredCategoryKeys,
      repairApplied: true,
      repairedQuestionCount: finalizedQuestions.length,
    },
  );
  const repairedQuestions = finalizeInitialDiscoveryQuestions([], repairedProfile, input);
  const repairedValidation = validateInitialDiscoveryQuestions(repairedQuestions, repairedProfile, input);

  return {
    questions: repairedValidation.valid ? repairedQuestions : [],
    discoveryProfile: {
      ...repairedProfile,
      recommendedInitialCount: repairedQuestions.length || repairedProfile.recommendedInitialCount,
    },
    repairApplied: true,
    failureReasonCode: repairedValidation.failureReasonCode,
  };
}

export function expandRawQuestionCandidate(raw: {
  categoryKey?: unknown;
  category?: unknown;
  intent?: unknown;
  question?: unknown;
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

  return splitQuestions
    .map((question, index) => {
      const normalizedQuestion = normalizeQuestionText(question);
      if (!normalizedQuestion) return null;
      return {
        categoryKey,
        category: labelForCategoryKey(categoryKey),
        intent: index === 0
          ? normalizeQuestionIntent(raw.intent, categoryKey, normalizedQuestion)
          : `${normalizeQuestionIntent(raw.intent, categoryKey, normalizedQuestion)}_part_${index + 1}`,
        question: normalizedQuestion,
        suggestions: baseSuggestions.length ? baseSuggestions : [],
      };
    })
    .filter((question): question is ClarifyQuestion => Boolean(question));
}

export function finalizeInitialDiscoveryQuestions(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
  input?: DiscoveryFallbackInput,
): ClarifyQuestion[] {
  const deduped = normalizeQuestions(questions, new Set<string>(), input).sort(questionComparator);
  if (deduped.length > 0) return deduped;
  if (profile.recommendedInitialCount <= 0) return [];

  return buildFallbackQuestions(
    categoryCoverageKeys(profile, input),
    new Set<string>(),
    Math.max(1, Math.round(profile.recommendedInitialCount)),
    input,
  ).sort(questionComparator);
}

export function finalizeFollowupDiscoveryQuestions(
  questions: ClarifyQuestion[],
  opts: {
    askedQuestions: string[];
    askedCategoryKeys?: ClarifyCategoryKey[];
    missingCategoryKeys: ClarifyCategoryKey[];
    followupCap: number;
    initialQuestionCount: number;
    fallbackInput?: DiscoveryFallbackInput;
  },
): ClarifyQuestion[] {
  const maxFollowup = Math.max(0, Math.round(opts.followupCap));
  if (maxFollowup <= 0) return [];

  // Categories already covered by the initial question round — do not re-ask them.
  const alreadyAskedCategories = new Set<string>(
    (opts.askedCategoryKeys ?? []).filter(Boolean),
  );

  const asked = new Set(opts.askedQuestions.map(normalizeKey).filter(Boolean));
  const deduped = normalizeQuestions(questions, asked, opts.fallbackInput)
    // Also filter out follow-ups targeting a category that was already asked about.
    .filter((q) => !alreadyAskedCategories.has(q.categoryKey))
    .sort(questionComparator);
  const result: ClarifyQuestion[] = [];
  // Only prefer categories that were not already asked in the initial round.
  const preferredCategories = uniqueCategoryKeys(opts.missingCategoryKeys)
    .filter((key) => !alreadyAskedCategories.has(key));
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
