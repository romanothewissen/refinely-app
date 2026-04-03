import { ClarifyCategoryKey, ClarifyFailureReasonCode, ClarifyQuestion, DiscoveryProfile } from '../types';

export const MIN_INITIAL_DISCOVERY_QUESTIONS = 4;
export const MAX_INITIAL_DISCOVERY_QUESTIONS = 12;
export const MIN_FOLLOWUP_DISCOVERY_QUESTIONS = 1;
export const MAX_FOLLOWUP_DISCOVERY_QUESTIONS = 8;
export const MAX_TOTAL_DISCOVERY_QUESTIONS = 20;
export const MAX_ATOMIC_QUESTION_WORDS = 36;

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
    suggestions: ['Identifiers only', 'Context plus reason', 'Full request details', 'Still undefined'],
  },
  {
    categoryKey: 'information_architecture',
    intent: 'outputs_displays',
    question: 'What output, record, or display should this produce or update?',
    suggestions: ['Create a record', 'Update existing record', 'Show a summary', 'Send a notification'],
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
    suggestions: ['Keyword based', 'Priority based', 'Role based', 'Threshold based'],
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
    suggestions: ['Update existing item', 'Create a new item', 'Ask for review', 'Ignore duplicate'],
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

function questionWordCount(value: string): number {
  return cleanText(value).split(/\s+/).filter(Boolean).length;
}

function ensureQuestionMark(value: string): string {
  const trimmed = cleanText(value).replace(/[?.!]+$/g, '');
  return trimmed ? `${trimmed}?` : '';
}

function sentenceCaseQuestion(value: string): string {
  const normalized = ensureQuestionMark(value);
  if (!normalized) return '';
  return normalized.replace(/^[a-z]/, (letter) => letter.toUpperCase());
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
  if (!input) return template;

  const ctx = buildDiscoveryContext(input);
  const businessObjectPhrase = withArticle(ctx.businessObject);
  const channelScope = ctx.channelList ? ` across ${ctx.channelList}` : '';

  switch (template.intent) {
    case 'business_outcome':
      return {
        ...template,
        question: `What business outcome should automatic ${ctx.businessObject} handling${channelScope} directly improve?`,
        suggestions: uniqueStrings([
          `Reduce manual handling${channelScope}`,
          `Create ${ctx.businessObjectPlural} faster`,
          `Improve first-touch visibility`,
          `Avoid duplicate ${ctx.businessObjectPlural}`,
        ]).slice(0, 4),
      };
    case 'trigger_event':
      return {
        ...template,
        question: ctx.channels.length
          ? `Which ${ctx.channelList} channels should trigger ${ctx.businessObject} creation automatically?`
          : `What exact event in the ${ctx.interactionLabel} should trigger ${businessObjectPhrase} creation?`,
        suggestions: uniqueStrings([
          ctx.channels.length >= 2 ? `All listed channels` : `When the ${ctx.interactionLabel} ends`,
          ctx.channels.length >= 2 ? `${ctx.channels.slice(0, 2).join(' and ')} only` : `Only after identity is confirmed`,
          `Only when enough detail exists to open the ${ctx.businessObject}`,
          'After manual review',
        ]).slice(0, 4),
      };
    case 'success_signal':
      return {
        ...template,
        question: `What should count as a successful ${ctx.businessObject} outcome once the ${ctx.interactionLabel} is handled?`,
        suggestions: uniqueStrings([
          `The right ${ctx.businessObject} is created`,
          'Ownership is clear immediately',
          'Required context is copied once',
          `No duplicate ${ctx.businessObjectPlural} are created`,
        ]).slice(0, 4),
      };
    case 'primary_actor':
      return {
        ...template,
        question: `Who should initiate or own ${ctx.businessObject} handling from the ${ctx.interactionLabel}?`,
        suggestions: uniqueStrings([
          ctx.actor,
          'A shared operations queue',
          'A supervisor or manager',
          'Manual triage ownership',
        ]).slice(0, 4),
      };
    case 'downstream_actors':
      return {
        ...template,
        question: `Who else needs visibility when ${businessObjectPhrase} is created from the ${ctx.interactionLabel}?`,
        suggestions: uniqueStrings([
          'Related internal teams',
          'A supervisor or approver',
          'The original requester',
          'No extra visibility needed',
        ]).slice(0, 4),
      };
    case 'permissions_scope':
      return {
        ...template,
        question: `Which users should be allowed to override the default ${ctx.businessObject} handling flow?`,
        suggestions: uniqueStrings([
          'Only admins can override',
          `${ctx.actor} can override`,
          'Managers approve exceptions',
          'No special permissions',
        ]).slice(0, 4),
      };
    case 'required_inputs':
      return {
        ...template,
        question: `What details from the ${ctx.interactionLabel}${channelScope} must be copied onto the ${ctx.businessObject}?`,
        suggestions: uniqueStrings([
          `${ctx.identifier} plus the reason`,
          'Conversation summary plus next action',
          ctx.channels.includes('Email') ? 'Sender plus email subject' : 'Source details plus summary',
          'Full interaction content',
        ]).slice(0, 4),
      };
    case 'outputs_displays':
      return {
        ...template,
        question: `Besides the ${ctx.businessObject}, what output or downstream record should this flow update?`,
        suggestions: uniqueStrings([
          `Create the ${ctx.businessObject} only`,
          `Update an existing ${ctx.businessObject}`,
          'Notify the owning team',
          'Show a summary for follow-up',
        ]).slice(0, 4),
      };
    case 'entity_linkage':
      return {
        ...template,
        question: `What identifier should link the ${ctx.businessObject} to the right customer, contact, or prior conversation?`,
        suggestions: uniqueStrings([
          ctx.identifier,
          ctx.channels.length >= 2 ? 'Conversation or email thread' : 'Existing open case reference',
          'Customer or account identifier',
          `A related ${ctx.businessObject} reference`,
        ]).slice(0, 4),
      };
    case 'core_constraints':
      return {
        ...template,
        question: `What rule must always be enforced before ${businessObjectPhrase} is created from the ${ctx.interactionLabel}?`,
        suggestions: uniqueStrings([
          'Only when mandatory data is present',
          ctx.channels.length ? `Only for eligible ${ctx.channelList} channels` : 'Only for eligible requests',
          `Never create duplicate ${ctx.businessObjectPlural}`,
          'Require manual review for exceptions',
        ]).slice(0, 4),
      };
    case 'timing_dependencies':
      return {
        ...template,
        question: `What timing or sequencing rule affects when the ${ctx.businessObject} can be created?`,
        suggestions: uniqueStrings([
          'Immediately when received',
          'Only after triage',
          'Only within supported hours',
          'After another step completes',
        ]).slice(0, 4),
      };
    case 'decision_logic':
      return {
        ...template,
        question: `What rule decides whether the ${ctx.interactionLabel} creates a new ${ctx.businessObject} or updates an existing one?`,
        suggestions: uniqueStrings([
          `Always create a new ${ctx.businessObject}`,
          `Reuse an existing open ${ctx.businessObject}`,
          'Route uncertain matches for review',
          `Apply different rules by ${ctx.decisionFactor}`,
        ]).slice(0, 4),
      };
    case 'lifecycle_states':
      return {
        ...template,
        question: `What statuses should the ${ctx.businessObject} move through after it is created?`,
        suggestions: uniqueStrings([
          'New to assigned to resolved',
          'New to triage to resolved',
          'Single open state only',
          'New to pending to closed',
        ]).slice(0, 4),
      };
    case 'transition_triggers':
      return {
        ...template,
        question: `What event should move the ${ctx.businessObject} out of its initial status?`,
        suggestions: uniqueStrings([
          'Manual triage',
          'Automatic routing',
          'Owner acceptance',
          ctx.channels.length ? `An update from ${ctx.channelList}` : `A new ${ctx.interactionLabel}`,
        ]).slice(0, 4),
      };
    case 'reopen_retry':
      return {
        ...template,
        question: `What should happen if the same ${ctx.interactionLabel} needs to reopen or update a closed ${ctx.businessObject}?`,
        suggestions: uniqueStrings([
          `Reopen the existing ${ctx.businessObject}`,
          `Create a linked ${ctx.businessObject}`,
          'Allow retry without reopening',
          'No reopen path is needed',
        ]).slice(0, 4),
      };
    case 'missing_data_fallback':
      return {
        ...template,
        question: `What should happen when the ${ctx.interactionLabel} does not contain enough detail to create the ${ctx.businessObject}?`,
        suggestions: uniqueStrings([
          'Queue for manual review',
          `Create a partial ${ctx.businessObject}`,
          'Hold until missing details are added',
          `Notify ${ctx.actor}`,
        ]).slice(0, 4),
      };
    case 'conflicts_duplicates':
      return {
        ...template,
        question: `What should happen when ${ctx.interactionPlural} would create duplicate ${ctx.businessObjectPlural}?`,
        suggestions: uniqueStrings([
          `Reuse the open ${ctx.businessObject}`,
          `Update the existing ${ctx.businessObject}`,
          'Route duplicates for review',
          `Allow duplicate ${ctx.businessObjectPlural} only for approved cases`,
        ]).slice(0, 4),
      };
    case 'offline_failure_behavior':
      return {
        ...template,
        question: `What should happen if the source channel or integration is unavailable during ${ctx.businessObject} creation?`,
        suggestions: uniqueStrings([
          'Retry when the channel returns',
          'Queue for recovery',
          'Switch to manual handling',
          'Fail and alert the team',
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
  if (fallbackQuestion) {
    const inferred = toSnakeCase(fallbackQuestion.split('?')[0]);
    if (inferred) return inferred;
  }
  const template = categoryTemplates(categoryKey)[0];
  return template?.intent ?? `clarify_${categoryKey}`;
}

function fallbackSuggestionsForIntent(
  categoryKey: ClarifyCategoryKey,
  intent: string,
  input?: DiscoveryFallbackInput,
): string[] {
  const template = categoryTemplates(categoryKey).find((candidate) => candidate.intent === intent)
    ?? categoryTemplates(categoryKey)[0];
  if (!template) return [];

  const contextual = contextualizeDiscoveryTemplate(template, input).suggestions;
  return uniqueStrings([...contextual, ...template.suggestions]).slice(0, 4);
}

function looksCompoundQuestion(question: string): boolean {
  const normalized = cleanText(question).toLowerCase();
  if (!normalized) return false;
  if (questionWordCount(normalized) > MAX_ATOMIC_QUESTION_WORDS && /\b(and|also|plus|along with)\b/.test(normalized)) return true;
  if ((normalized.match(/\b(and|as well as)\s+(what|which|who|when|where|why|how|whether)\b/g) ?? []).length > 0) return true;
  if ((normalized.match(/\bwhat\b|\bwhich\b|\bwho\b|\bwhen\b|\bwhere\b|\bwhy\b|\bhow\b|\bwhether\b/g) ?? []).length > 1) return true;
  if (normalized.includes(';')) return true;
  return false;
}

function splitCompoundQuestion(question: string): string[] {
  const compact = ensureQuestionMark(question);
  if (!compact) return [];

  const interrogativePattern = /\b(what|which|who|when|where|why|how|whether)\b/i;
  const firstInterrogativeIndex = compact.search(interrogativePattern);
  if (firstInterrogativeIndex < 0) return [compact];

  const prefix = compact.slice(0, firstInterrogativeIndex);
  const splitter = compact.match(/^(.*?)(?:,\s*|\s+)and\s+(what|which|who|when|where|why|how|whether)\b(.*)$/i);
  if (splitter) {
    const first = ensureQuestionMark(splitter[1]);
    const second = ensureQuestionMark(`${prefix}${splitter[2]}${splitter[3]}`);
    return [first, second].filter(Boolean);
  }

  return [compact];
}

function normalizeQuestionText(question: string): string {
  return sentenceCaseQuestion(question);
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
      suggestions: uniqueStrings([
        ...providedSuggestions,
        ...fallbackSuggestionsForIntent(question.categoryKey, normalizedIntent, input),
      ]).slice(0, 4),
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
      suggestions: uniqueStrings(contextualTemplate.suggestions).slice(0, 4),
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
    scope = raiseScope(scope, 'broad');
    complexity = raiseComplexity(complexity, 'high');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
    recommendedInitialCount = Math.max(recommendedInitialCount, 6);
  }

  if (breadth >= 6 || repairedQuestionCount >= 9) {
    scope = raiseScope(scope, 'very_broad');
    complexity = raiseComplexity(complexity, 'very_high');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
    recommendedInitialCount = Math.max(recommendedInitialCount, 8);
  }

  if (repairApplied) {
    scope = raiseScope(scope, breadth >= 5 ? 'very_broad' : 'broad');
    complexity = raiseComplexity(complexity, breadth >= 5 ? 'very_high' : 'high');
    ambiguity = raiseAmbiguity(ambiguity, 'high');
    recommendedInitialCount = Math.max(
      recommendedInitialCount,
      Math.min(MAX_INITIAL_DISCOVERY_QUESTIONS, Math.max(6, breadth + 1)),
    );
  }

  return {
    ...profile,
    scope,
    complexity,
    ambiguity,
    missingCategoryKeys: requiredCategoryKeys,
    recommendedInitialCount: clampCount(
      recommendedInitialCount,
      MIN_INITIAL_DISCOVERY_QUESTIONS,
      MAX_INITIAL_DISCOVERY_QUESTIONS,
    ),
  };
}

export function normalizeDiscoveryProfile(
  candidate?: Partial<DiscoveryProfile> | null,
  fallbackQuestionCount = 8,
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
    recommendedInitialCount,
    followupCap: clampCount(
      Number.isFinite(candidate?.followupCap) ? Number(candidate?.followupCap) : 4,
      MIN_FOLLOWUP_DISCOVERY_QUESTIONS,
      MAX_FOLLOWUP_DISCOVERY_QUESTIONS,
    ),
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
  if (!questions.length) {
    return {
      valid: false,
      requiredCategoryKeys,
      failureReasonCode: 'invalid_empty_questions',
    };
  }

  if (questions.length < MIN_INITIAL_DISCOVERY_QUESTIONS) {
    return {
      valid: false,
      requiredCategoryKeys,
      failureReasonCode: 'invalid_underpowered_questions',
    };
  }

  const presentCategoryKeys = new Set(questions.map((question) => question.categoryKey));
  const missingCoverage = requiredCategoryKeys.filter((categoryKey) => !presentCategoryKeys.has(categoryKey));
  if (missingCoverage.length > 0) {
    return {
      valid: false,
      requiredCategoryKeys,
      failureReasonCode: 'invalid_underpowered_questions',
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
    {
      ...calibratedProfile,
      recommendedInitialCount: Math.max(
        calibratedProfile.recommendedInitialCount,
        Math.min(MAX_INITIAL_DISCOVERY_QUESTIONS, Math.max(6, finalizedValidation.requiredCategoryKeys.length + 1)),
      ),
    },
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
  const splitQuestions = splitCompoundQuestion(rawQuestion);
  const variants = splitQuestions.length > 1 ? splitQuestions : [rawQuestion];

  return variants
    .map((variant, index) => {
      const normalizedQuestion = normalizeQuestionText(variant);
      if (!normalizedQuestion) return null;
      if (looksCompoundQuestion(normalizedQuestion)) return null;
      const normalizedIntent = index === 0
        ? normalizeQuestionIntent(raw.intent, categoryKey, normalizedQuestion)
        : `${normalizeQuestionIntent(raw.intent, categoryKey, normalizedQuestion)}_part_${index + 1}`;
      const question: ClarifyQuestion = {
        categoryKey,
        category: labelForCategoryKey(categoryKey),
        intent: normalizedIntent,
        question: normalizedQuestion,
        suggestions: baseSuggestions.length ? baseSuggestions : [],
      };
      return question;
    })
    .filter((question): question is ClarifyQuestion => Boolean(question));
}

export function finalizeInitialDiscoveryQuestions(
  questions: ClarifyQuestion[],
  profile: DiscoveryProfile,
  input?: DiscoveryFallbackInput,
): ClarifyQuestion[] {
  const targetCount = clampCount(
    profile.recommendedInitialCount,
    MIN_INITIAL_DISCOVERY_QUESTIONS,
    MAX_INITIAL_DISCOVERY_QUESTIONS,
  );
  const preferredCategories = categoryCoverageKeys(profile, input);
  const deduped = normalizeQuestions(questions, new Set<string>(), input).sort(questionComparator);
  const result: ClarifyQuestion[] = [];
  const addedQuestions = new Set<string>();

  preferredCategories.forEach((categoryKey) => {
    const existing = deduped.find((question) => question.categoryKey === categoryKey && !addedQuestions.has(normalizeKey(question.question)));
    if (!existing) return;
    addedQuestions.add(normalizeKey(existing.question));
    result.push(existing);
  });

  deduped.forEach((question) => {
    if (result.length >= targetCount) return;
    const key = normalizeKey(question.question);
    if (addedQuestions.has(key)) return;
    addedQuestions.add(key);
    result.push(question);
  });

  if (result.length < targetCount) {
    const coveredCategoryKeys = new Set(result.map((question) => question.categoryKey));
    const uncoveredPreferredCategories = preferredCategories.filter((categoryKey) => !coveredCategoryKeys.has(categoryKey));
    const filler = buildFallbackQuestions(
      uncoveredPreferredCategories.length ? uncoveredPreferredCategories : preferredCategories,
      addedQuestions,
      targetCount - result.length,
      input,
    );
    result.push(...filler);
  }

  return result.slice(0, targetCount).sort(questionComparator);
}

export function finalizeFollowupDiscoveryQuestions(
  questions: ClarifyQuestion[],
  opts: {
    askedQuestions: string[];
    missingCategoryKeys: ClarifyCategoryKey[];
    followupCap: number;
    initialQuestionCount: number;
    fallbackInput?: DiscoveryFallbackInput;
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
  const deduped = normalizeQuestions(questions, asked, opts.fallbackInput).sort(questionComparator);
  const result: ClarifyQuestion[] = [];
  const preferredCategories = uniqueCategoryKeys(opts.missingCategoryKeys);
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

  if (result.length < Math.min(MIN_FOLLOWUP_DISCOVERY_QUESTIONS, maxFollowup)) {
    const minimumFollowups = Math.min(MIN_FOLLOWUP_DISCOVERY_QUESTIONS, maxFollowup);
    const filler = buildFallbackQuestions(
      preferredCategories.length ? preferredCategories : CLARIFY_CATEGORY_ORDER,
      new Set([...asked, ...result.map((question) => normalizeKey(question.question))]),
      minimumFollowups - result.length,
      opts.fallbackInput,
    );
    result.push(...filler);
  }

  return result.slice(0, maxFollowup).sort(questionComparator);
}
