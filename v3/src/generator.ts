import type {
  V3AcceptanceRequirement,
  V3CapabilityCandidate,
  V3CapabilityPlan,
  V3ContextPack,
  V3EvidenceRef,
  V3GeneratedDraft,
  V3GeneratedFeature,
  V3Generator,
  V3Provenance,
  V3ValidationIssue,
} from './contracts';
import type { GeminiJsonOptions } from './gemini';
import { callGeminiJson } from './gemini';
import { compact, toSentenceCase, uniqueTokens } from './text';
import { validateDraft } from './validator';

function evidenceRef(card: V3ContextPack['cards'][number], reason: string): V3EvidenceRef {
  return {
    cardId: card.id,
    sourceId: card.sourceId,
    reason,
  };
}

interface RoleCandidate {
  role: string;
  source: 'requirement' | 'context';
  relation: 'explicit' | 'responsibility' | 'actor' | 'mention';
  text: string;
  card?: V3ContextPack['cards'][number];
  baseScore: number;
}

interface RoleSelection {
  role: string;
  evidenceRef?: V3EvidenceRef;
}

const ROLE_SUFFIX = '(?:owners?|managers?|specialists?|engineers?|planners?|coordinators?|analysts?|approvers?|requesters?|leads?|agents?|admins?|administrators?|technicians?|teams?|sales|support)';
const ROLE_SUFFIX_REGEX = new RegExp(`\\b((?:[A-Za-z][A-Za-z/&-]*\\s+){0,4}[A-Za-z][A-Za-z/&-]*\\s+${ROLE_SUFFIX})\\b`, 'gi');
const ROLE_ACTION_REGEX = new RegExp(`\\b((?:[A-Za-z][A-Za-z/&-]*\\s+){0,4}[A-Za-z][A-Za-z/&-]*\\s+${ROLE_SUFFIX})\\s+(?:must|will|may|can|should)\\s+(?:create|review|coordinate|manage|submit|approve|reject|route|notify|reserve|host|perform|follow|proceed|maintain|track|assign|complete|resolve|own|support)\\b`, 'gi');
const ROLE_RESPONSIBILITY_REGEX = /\bresponsibilit(?:y|ies)\s+of\s+(?:the\s+)?([A-Za-z][A-Za-z/& -]{2,80}?)(?:\s+or equivalent|[.;,\n]|$)/gi;
const INVALID_ROLE_PHRASE = /\b(all activities|available actions|business outcome|case type|delay reason|follow up action|information on|missing scope|plan action|planned date|planned dates|related work|order type|solution quote|source requirement|work order actions?)\b/i;

function findPrimaryRole(requirement: string, contextPack: V3ContextPack): string {
  return findRoleForCapability(requirement, undefined, contextPack).role;
}

function findRoleForCapability(
  requirement: string,
  capability: V3CapabilityCandidate | undefined,
  contextPack: V3ContextPack,
): RoleSelection {
  const candidates = extractRoleCandidates(requirement, contextPack);
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreRoleCandidate(candidate, requirement, capability),
    }))
    .sort((left, right) => right.score - left.score);

  const bestRanked = ranked[0];
  const best = bestRanked?.candidate;
  if (best && (best.source === 'requirement' || bestRanked.score >= 70)) {
    return {
      role: best.role,
      evidenceRef: best.card ? evidenceRef(best.card, `Grounds persona role "${best.role}" in retrieved ${sourceLabel(best.card)} context`) : undefined,
    };
  }

  return { role: 'Business Stakeholder' };
}

function normalizeRole(value: string): string {
  const cleaned = value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/^.*\b(?:responsibility|responsibilities)\s+of\s+/i, '')
    .replace(/^.*\bcontext\s+for\s+/i, '')
    .replace(/^.*\b(?:by|to|from|for|within|between)\s+(?=[A-Za-z][A-Za-z/&-]*(?:\s+[A-Za-z][A-Za-z/&-]*){0,4}\s+(?:owners?|managers?|specialists?|engineers?|planners?|coordinators?|analysts?|approvers?|requesters?|leads?|agents?|admins?|administrators?|technicians?|teams?|sales|support)\b)/i, '')
    .replace(/^as\s+a[n]?\s+/i, '')
    .replace(/^(?:the|a|an|of|for|by|to|from|and|or)\s+/i, '')
    .replace(/\bor equivalent\b/gi, '')
    .replace(/[.:;,]+$/g, '')
    .replace(/\b(the|a|an)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const singular = cleaned.replace(/\b(owners|planners|managers|analysts|requesters|approvers|leads|specialists|engineers|coordinators|agents|admins|administrators|technicians|teams)\b/g, (match) => {
    const singulars: Record<string, string> = {
      owners: 'owner',
      planners: 'planner',
      managers: 'manager',
      analysts: 'analyst',
      requesters: 'requester',
      approvers: 'approver',
      leads: 'lead',
      specialists: 'specialist',
      engineers: 'engineer',
      coordinators: 'coordinator',
      agents: 'agent',
      admins: 'admin',
      administrators: 'administrator',
      technicians: 'technician',
      teams: 'team',
    };
    return singulars[match] ?? match;
  });
  return singular
    .split(' ')
    .map((part) => toSentenceCase(part))
    .join(' ');
}

function extractRoleCandidates(requirement: string, contextPack: V3ContextPack): RoleCandidate[] {
  const candidates: RoleCandidate[] = [];
  const add = (candidate: Omit<RoleCandidate, 'role'> & { rawRole: string }) => {
    const role = normalizeRole(candidate.rawRole);
    if (!isUsableRole(role)) return;
    candidates.push({
      role,
      source: candidate.source,
      relation: candidate.relation,
      text: candidate.text,
      card: candidate.card,
      baseScore: candidate.baseScore,
    });
  };

  const asActor = requirement.match(/\bas a[n]?\s+([^,.\n]+),\s*i need\b/i)?.[1];
  if (asActor) {
    add({
      rawRole: asActor,
      source: 'requirement',
      relation: 'explicit',
      text: requirement,
      baseScore: 120,
    });
  }

  const allowActor = requirement.match(/\ballow\s+([^,.]+?)\s+to\s+/i)?.[1];
  if (allowActor) {
    add({
      rawRole: allowActor,
      source: 'requirement',
      relation: 'explicit',
      text: requirement,
      baseScore: 115,
    });
  }

  for (const card of contextPack.cards) {
    const text = `${card.title}. ${card.text}`;
    for (const match of text.matchAll(ROLE_RESPONSIBILITY_REGEX)) {
      add({
        rawRole: match[1] ?? '',
        source: 'context',
        relation: 'responsibility',
        text: contextWindow(text, match[1] ?? ''),
        card,
        baseScore: 58 + card.score * 20,
      });
    }
    for (const match of text.matchAll(ROLE_ACTION_REGEX)) {
      add({
        rawRole: match[1] ?? '',
        source: 'context',
        relation: 'actor',
        text: contextWindow(text, match[1] ?? ''),
        card,
        baseScore: 46 + card.score * 18,
      });
    }
    for (const match of text.matchAll(ROLE_SUFFIX_REGEX)) {
      add({
        rawRole: match[1] ?? '',
        source: 'context',
        relation: 'mention',
        text: contextWindow(text, match[1] ?? ''),
        card,
        baseScore: (card.kind === 'role' ? 42 : 32) + card.score * 14,
      });
    }
  }

  const bestByRole = new Map<string, RoleCandidate>();
  for (const candidate of candidates) {
    const existing = bestByRole.get(candidate.role);
    if (!existing || candidate.baseScore > existing.baseScore) bestByRole.set(candidate.role, candidate);
  }
  return Array.from(bestByRole.values());
}

function isUsableRole(role: string): boolean {
  if (!role || role.length < 4 || role.length > 70) return false;
  if (INVALID_ROLE_PHRASE.test(role)) return false;
  const normalized = role.toLowerCase();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length > 5) return false;
  if (/^(business|customer|equipment|plan|quote|record|request|system|workflow|work)$/i.test(normalized)) return false;
  return new RegExp(`\\b${ROLE_SUFFIX}\\b`, 'i').test(normalized);
}

function contextWindow(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return compact(text, 260);
  return compact(text.slice(Math.max(0, index - 140), index + needle.length + 180), 320);
}

function scoreRoleCandidate(
  candidate: RoleCandidate,
  requirement: string,
  capability: V3CapabilityCandidate | undefined,
): number {
  if (candidate.source === 'requirement') return candidate.baseScore;

  const capabilityTerms = significantTerms(`${capability?.label ?? ''} ${capability?.businessOutcome ?? ''}`);
  const candidateTerms = significantTerms(`${candidate.role} ${candidate.text} ${candidate.card?.title ?? ''}`);
  const sharedCapabilityTerms = Array.from(capabilityTerms).filter((term) => candidateTerms.has(term)).length;
  const requirementTerms = significantTerms(requirement);
  const sharedRequirementTerms = Array.from(requirementTerms).filter((term) => candidateTerms.has(term)).length;

  let score = candidate.baseScore + sharedCapabilityTerms * 10 + Math.min(sharedRequirementTerms, 5) * 2;
  if (candidate.relation === 'responsibility') score += 18;
  if (candidate.relation === 'actor') score += 10;
  if (candidate.card?.kind === 'role') score += 8;
  if (candidate.card && ['project_context', 'document'].includes(candidate.card.sourceKind)) score += 4;
  if (candidate.role.split(/\s+/).length === 1) score -= 12;
  if (/\b(business stakeholder|user|planner|manager|analyst)\b/i.test(candidate.role)) score -= 6;

  const capabilityText = `${capability?.label ?? ''} ${capability?.businessOutcome ?? ''}`;
  const candidateText = `${candidate.role} ${candidate.text} ${candidate.card?.title ?? ''}`;
  const financialCapability = /\b(quote|financial|billable|price|pricing|cost|estimate|approval packet|outputs?)\b/i.test(capabilityText);
  const financialCandidate = /\b(quote|financial|finance|billable|price|pricing|cost|estimate|approval packet|packet)\b/i.test(candidateText);
  if (financialCapability && financialCandidate) score += 38;
  if (!financialCapability && financialCandidate) score -= 22;

  const operationalCapability = /\b(plan|activity|activities|tasks?|steps?|sequence|sequencing|dependenc|resource|parts?|labor|status|follow-on|follow up|downstream|records?|orders?|handoffs?)\b/i.test(capabilityText);
  const operationalCandidate = /\b(activity|activities|tasks?|steps?|planning|coordinate|logistics|operations?|support|specialist)\b/i.test(candidateText);
  if (operationalCapability && operationalCandidate) score += 16;
  return score;
}

function decapitalize(value: string): string {
  return value ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function storyActionForCapability(capability: V3CapabilityCandidate, requirement: string): string {
  const label = capability.label || summarizeCapability(requirement);
  const cleaned = label
    .replace(/\s+/g, ' ')
    .trim();
  return decapitalize(cleaned).replace(/\.$/, '');
}

function storyDescription(role: string, capability: V3CapabilityCandidate, requirement: string): string {
  const action = storyActionForCapability(capability, requirement);
  const outcome = decapitalize((capability.businessOutcome || 'the intended business outcome can be delivered consistently').replace(/\.$/, ''));
  return compact(`As a ${role}, I need to ${action} so that ${outcome}.`, 280);
}

function extractAction(requirement: string): string {
  const afterActor = requirement.match(/\ballow\s+.+?\s+to\s+(.+)/i)?.[1] ?? requirement;
  return afterActor
    .replace(/\b(while|so that)\b.*$/i, '')
    .replace(/\.$/, '')
    .trim()
    .toLowerCase();
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part : toSentenceCase(part))
    .join(' ');
}

function thirdPersonAction(action: string): string {
  return action.replace(/^([a-z]+)/i, (verb) => {
    const lower = verb.toLowerCase();
    if (lower.endsWith('s')) return verb;
    if (lower.endsWith('y')) return `${verb.slice(0, -1)}ies`;
    if (lower.endsWith('ch') || lower.endsWith('sh') || lower.endsWith('x')) return `${verb}es`;
    return `${verb}s`;
  });
}

function pluralizeRole(role: string): string {
  const parts = role.split(' ');
  const last = parts[parts.length - 1] ?? role;
  if (/s$/i.test(last)) return role;
  parts[parts.length - 1] = `${last}s`;
  return parts.join(' ');
}

function summarizeCapability(requirement: string): string {
  const action = extractAction(requirement);
  if (action.length >= 8) return titleCase(action).slice(0, 90);
  const tokens = uniqueTokens(requirement)
    .filter((token) => !['business', 'requirement'].includes(token))
    .slice(0, 7);
  if (!tokens.length) return 'Manage Business Outcome';
  return titleCase(tokens.join(' '));
}

function hasExplicitActor(requirement: string): boolean {
  return /\ballow\s+.+?\s+to\s+/i.test(requirement) || /\bas a[n]?\s+.+?,\s*i need\b/i.test(requirement);
}

function hasPlanScope(requirement: string, capability: V3CapabilityCandidate): boolean {
  return /\b(plan|planning|program|schedule|roadmap|coordinated work|activity|activities|tasks?|steps?)\b/i.test(`${requirement} ${capability.label} ${capability.businessOutcome}`);
}

function sourceScopeItems(requirement: string): string[] {
  const listText = requirement.match(/\b(?:include|includes|including|with|across)\s+(.+?)(?:\.|\bso that\b|\bwhile\b|$)/i)?.[1] ?? '';
  const items = listText
    .replace(/\ball through\b.*$/i, '')
    .split(/,|\band\b|\bor\b|\//i)
    .map((item) => item
      .replace(/\b(all|the|a|an|that|can|could|may|needed|required|various|multiple|single|one)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase())
    .filter((item) => item.length >= 4 && item.length <= 42 && !/^(etc|through|from|plan|plans)$/.test(item));
  return Array.from(new Set(items)).slice(0, 8);
}

function formatScopeItems(items: string[], fallback: string): string {
  const clean = items.filter(Boolean).slice(0, 5);
  if (!clean.length) return fallback;
  if (clean.length === 1) return clean[0] ?? fallback;
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

const CONTEXT_STOP_TERMS = new Set([
  'able',
  'activity',
  'activities',
  'apply',
  'before',
  'business',
  'can',
  'customer',
  'details',
  'event',
  'existing',
  'include',
  'includes',
  'must',
  'need',
  'needed',
  'needs',
  'plan',
  'plans',
  'request',
  'requests',
  'should',
  'that',
  'through',
  'when',
  'which',
  'with',
  'work',
  'workflow',
]);

function significantTerms(text: string): Set<string> {
  return new Set(text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !CONTEXT_STOP_TERMS.has(token)));
}

function buildCapabilityAcceptanceRequirements(requirement: string, capability: V3CapabilityCandidate, featureIndex: number): V3AcceptanceRequirement[] {
  const labelText = capability.label.toLowerCase();
  const capabilityText = `${capability.label} ${capability.businessOutcome}`;
  const scopeItems = sourceScopeItems(requirement);
  const scopeList = formatScopeItems(scopeItems, 'the named activities, resources, outputs, and handoffs');
  const primaryScopeItem = scopeItems[0] ?? 'a named scope item';
  const isMultiActivityPlan = /\b(multi-activity|multiple activities|activity types|scope types|scope items|named activity)\b/i.test(capabilityText);
  const isPlanDefinition = /\b(define|coordinated plan|consolidated plan|single plan|plan)\b/i.test(labelText)
    && !isMultiActivityPlan
    && !/\b(status|quote|follow-on|transaction|sequence|sequenc|dependenc|resource)\b/i.test(labelText);
  const isActivityTypeCapability = /\b(multiple activities|activity types|scope types|named activity|named scope)\b/i.test(labelText)
    && !isPlanDefinition
    && !/\b(status|quote|follow-on|transaction|sequence|sequenc|dependenc|resource)\b/i.test(labelText);
  const ars: V3AcceptanceRequirement[] = [];
  const push = (given: string, when: string, then: string) => {
    ars.push({
      id: `ar_${featureIndex + 1}_${ars.length + 1}`,
      given,
      when,
      then,
      provenance: 'requirement',
      evidenceRefs: [],
    });
  };

  if (hasPlanScope(requirement, capability) && isMultiActivityPlan) {
    push(
      `a coordinated plan may include ${scopeList}`,
      'the plan scope is defined',
      `each applicable named item is represented as distinct planned scope within the same plan.`,
    );
    push(
      `${primaryScopeItem} is not applicable for a specific business case`,
      'the plan is reviewed for applicable scope',
      `the plan can omit inapplicable named items without blocking the remaining planned scope.`,
    );
    push(
      'multiple activities or scope items belong to the same business outcome',
      'activity or scope details are planned',
      'the related work, resources, outputs, and follow-up actions remain tied to one coordinated plan.',
    );
  }

  if (isPlanDefinition) {
    push(
      `a business outcome requires coordinated planning across ${scopeList}`,
      'the plan is defined',
      'the applicable scope, resources, outputs, and follow-up needs are captured in one planning context.',
    );
    push(
      'planned work must support later business outputs or handoffs',
      'activities, resources, outputs, or follow-up work need to be coordinated',
      'the plan acts as the business source for planned work and downstream decisions.',
    );
    push(
      'a plan contains optional or conditional scope',
      'the applicable items are reviewed',
      'inapplicable items can remain out of scope while applicable work stays coordinated.',
    );
  }

  if (isActivityTypeCapability) {
    push(
      `the requirement names ${scopeList}`,
      'activity or scope types are added to the plan',
      'each applicable type is represented as planned work within the same coordinated scope.',
    );
    push(
      'a named activity or scope type is optional for a specific case',
      'that type is not needed for the business outcome',
      'the plan can omit the unnecessary type without blocking the remaining planned work.',
    );
    push(
      'a plan includes different work types for the same business outcome',
      'the planned scope is reviewed',
      'the applicable work types can be distinguished while remaining part of the same plan.',
    );
  }

  if (/\b(resources?|parts?|labor|location|materials?|effort|capacity|staff|equipment|activity-specific details)\b/i.test(labelText)) {
    push(
      'planned activities or scope items have different resource needs',
      'activity or scope details are planned',
      'each item carries the resources, effort, ownership, and location details needed for downstream use.',
    );
    push(
      'resource needs differ across named scope items',
      'resources or effort are assigned',
      'resource details remain tied to the activity or scope item that requires them.',
    );
    push(
      'a planned activity is missing resource detail',
      'output preparation or follow-up action readiness is reviewed',
      'missing resources, effort, ownership, or location details are visible before dependent outputs proceed.',
    );
  }

  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(labelText) && !/\b(validate|illogical|logical activity sequence)\b/i.test(labelText)) {
    if (hasPlanScope(requirement, capability)) {
      push(
        'a plan contains dependent activities, resources, or handoffs',
        'a prerequisite is incomplete',
        'the dependent activity is treated as not ready for follow-up work.',
      );
      push(
        'multiple planned items must happen in a specific order',
        'the sequence is planned',
        'the plan shows the required order before dependent outputs or handoffs proceed.',
      );
      push(
        'a planned sequence conflicts with a business rule',
        'readiness for downstream work is reviewed',
        'the sequence conflict is visible before outputs or follow-up actions proceed.',
      );
    } else {
      push(
        'related work has a required order or prerequisite',
        'one step must happen before another step can proceed',
        'the required sequence or prerequisite is visible before the work continues.',
      );
      push(
        'dependent work is being reviewed for readiness',
        'a prerequisite is not yet satisfied',
        'the blocked follow-up work is visible before it proceeds.',
      );
      push(
        'downstream work depends on a prior business step',
        'the prior step is incomplete or not ready',
        'the dependent work is identified as blocked before follow-up actions proceed.',
      );
    }
  }

  if (/\b(approval|decision|release)\b/i.test(labelText) && !/\bpackets?\b/i.test(labelText)) {
    push(
      'a request requires a business decision before it can proceed',
      'approval or release readiness is evaluated',
      compact(buildDecisionThen(requirement), 220),
    );
    push(
      'a decision-controlled request is not ready to proceed',
      'required approval or release information is missing',
      'the missing decision is visible before the request advances.',
    );
  }

  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(labelText)) {
    if (hasPlanScope(requirement, capability)) {
      push(
        'a coordinated plan is reviewed before downstream work begins',
        'a required rule, prerequisite, or sequence is missing or conflicting',
        'the conflict is visible before the affected output or follow-up action proceeds.',
      );
      push(
        'a named scope item has applicability rules',
        'the item is included without satisfying those rules',
        'the invalid or inapplicable scope is identified before dependent planning continues.',
      );
    } else {
      push(
        'proposed work is subject to business rules or exceptions',
        'a missing, invalid, or conflicting condition is identified',
        'the rule or exception is visible before the work proceeds.',
      );
      push(
        'proposed work is reviewed before it proceeds',
        'required business information is missing',
        'the missing information is visible before downstream work is started.',
      );
    }
  }

  if (/\b(quote|financial|billable|cost|price|estimate|outputs?|packets?|artifacts?|reports?|documents?)\b/i.test(labelText)) {
    push(
      'a coordinated plan contains items that affect a requested output',
      'the output is prepared from the plan',
      'the output covers the applicable planned scope and preserves the context of the items that drive it.',
    );
    push(
      'a requested output is prepared from planned work',
      'the plan includes items that should and should not affect the output',
      'the output reflects the applicable scope while other planned work remains in the plan.',
    );
  }

  if (/\b(follow[- ]?on|follow[- ]?up|downstream|work orders?|shipments?|orders?)\b/i.test(labelText)) {
    push(
      'a ready plan contains items eligible for downstream action',
      'follow-up actions are created from the plan',
      'downstream records or handoffs are created from eligible planned items and remain tied to the source plan.',
    );
    push(
      'a plan includes resource or delivery needs',
      'follow-up actions are created from planned resources',
      'records, orders, tasks, or handoffs are derived from the planned item and its resource needs.',
    );
    push(
      'a planned activity or resource need is unresolved',
      'follow-up action creation is reviewed',
      'unresolved items do not create downstream records or handoffs until the missing plan details are resolved.',
    );
  }

  if (/\b(status|progress|track|visibility)\b/i.test(labelText)) {
    if (hasPlanScope(requirement, capability)) {
      push(
        'a coordinated plan has been initiated',
        'the plan status is reviewed',
        'the current status of each associated planned item is visible using the applicable business states.',
      );
      push(
        'some but not all planned items are complete',
        'overall plan progress is reviewed',
        'the overall status shows that the coordinated outcome is still in progress.',
      );
      push(
        'all planned items required for the coordinated outcome are complete',
        'overall plan progress is reviewed',
        'the overall status shows that the coordinated outcome is complete.',
      );
    } else {
      push(
        'work or a request moves through business statuses',
        'progress or approval status changes',
        compact(buildStatusThen(requirement), 220),
      );
      push(
        'related work has progress or readiness blockers',
        'status is reviewed by stakeholders',
        'the current status distinguishes completed, blocked, and still-pending work.',
      );
    }
  }

  if (/\b(modify|change|active|adapt|update)\b/i.test(labelText)) {
    push(
      'a coordinated plan is already in progress',
      'future planned work needs to change',
      'the plan reflects changes to future items without changing completed work.',
    );
    push(
      'part of a plan has already been completed',
      'remaining planned work changes before execution',
      'only future or incomplete planned work is changed while completed history remains stable.',
    );
  }

  if (!ars.length) {
    const focus = firstConcreteFocus(capability);
    const outcome = decapitalize(capability.businessOutcome || `${capability.label} produces a concrete business result.`);
    push(
      compact(`${decapitalize(capability.label)} is in scope for the requirement`, 180),
      compact(focus, 180),
      compact(`${outcome} Any unresolved rule, owner, or exception is identified before dependent work proceeds.`, 220),
    );
  }

  return ensureMinimumAcceptanceRequirements({
    requirement,
    capability,
    featureIndex,
    ars,
    targetCount: targetAcceptanceRequirementCount(requirement, capability),
  });
}

function firstConcreteFocus(capability: V3CapabilityCandidate): string {
  return capability.acceptanceFocus.find((focus) => !/\b(primary behavior|exceptions|downstream outcome)\b/i.test(focus))
    ?? `the ${decapitalize(capability.label)} outcome is reviewed`;
}

function targetAcceptanceRequirementCount(requirement: string, capability: V3CapabilityCandidate): number {
  const capabilityText = `${capability.label} ${capability.businessOutcome}`.toLowerCase();
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(capabilityText)) {
    return 2;
  }
  if (/\b(quote|financial|billable|outputs?|packets?|artifacts?|reports?|documents?)\b/i.test(capabilityText)) {
    return 2;
  }
  if (/\b(follow[- ]?on|follow[- ]?up|downstream|transactions?|work orders?|shipments?|orders?|sequence|sequencing|dependencies|dependency|resources?|parts?|labor|consolidated|single plan|activity types|multiple activities)\b/i.test(capabilityText)) {
    return 3;
  }
  if (/\b(status|progress|optional|conditional|approval|decision|validate|rule|exception|modify|change|active|update)\b/i.test(capabilityText)) {
    return 2;
  }
  return /\b(and|,|while|with|before|after)\b/i.test(requirement) ? 2 : 1;
}

function ensureMinimumAcceptanceRequirements(input: {
  requirement: string;
  capability: V3CapabilityCandidate;
  featureIndex: number;
  ars: V3AcceptanceRequirement[];
  targetCount: number;
}): V3AcceptanceRequirement[] {
  const next = [...input.ars];
  const pushFallback = (given: string, when: string, then: string) => {
    next.push({
      id: `ar_${input.featureIndex + 1}_${next.length + 1}`,
      given,
      when,
      then,
      provenance: 'requirement',
      evidenceRefs: [],
    });
  };

  if (!next.length) {
    pushFallback(
      compact(`${decapitalize(input.capability.label)} is in scope for the requirement`, 180),
      compact(firstConcreteFocus(input.capability), 180),
      compact(decapitalize(input.capability.businessOutcome || `${input.capability.label} produces a concrete business result.`), 220),
    );
  }

  while (next.length < input.targetCount) {
    if (next.length === 1) {
      pushFallback(
        compact(`${decapitalize(input.capability.label)} has prerequisite information or dependent work`, 180),
        'readiness is reviewed before related work proceeds',
        compact(`${decapitalize(input.capability.businessOutcome)} Missing scope, rules, ownership, or dependencies are visible before dependent work proceeds.`, 220),
      );
    } else {
      pushFallback(
        compact(`${decapitalize(input.capability.label)} is part of a larger coordinated workflow`, 180),
        'related outputs or handoffs are reviewed',
        compact(`${decapitalize(input.capability.label)} remains traceable to the planned business outcome and any related follow-up work.`, 220),
      );
    }
  }

  return next.slice(0, 4);
}

function buildDecisionThen(requirement: string): string {
  if (/\bbudget owner approval\b/i.test(requirement) && /\border release\b/i.test(requirement)) {
    return 'budget owner approval is required before order release.';
  }
  if (/\bapproval\b/i.test(requirement)) return 'the required approval decision is visible before the work proceeds.';
  if (/\brelease\b/i.test(requirement)) return 'release readiness is visible before the work proceeds.';
  return 'the required business decision is visible before the work proceeds.';
}

function buildStatusThen(requirement: string): string {
  if (/\bapproval status\b/i.test(requirement)) return 'the current approval status is visible for the request.';
  if (/\bstatus\b/i.test(requirement)) return 'the current business status is visible for the work or request.';
  return 'current progress is visible for the work or request.';
}

function buildContextOpenQuestions(requirement: string, contextPack: V3ContextPack): string[] {
  const requirementTerms = significantTerms(requirement);
  const questions: string[] = [];
  const planScope = /\b(plan|planning|program|schedule|roadmap|activities?|tasks?|steps?)\b/i.test(requirement);
  const quoteScope = /\b(quote|estimate|invoice|price|pricing|cost|billable)\b/i.test(requirement);
  const followUpScope = /\b(follow[- ]?up|downstream|record|records|orders?|shipments?|work orders?|created like|derive|derived)\b/i.test(requirement);

  if (planScope) {
    questions.push('Which named scope items should become separate capabilities, and which should remain item types within one coordinated plan?');
    questions.push('Which sequence, dependency, and readiness rules should prevent outputs or follow-up actions from proceeding?');
  }

  if (quoteScope) {
    questions.push('Which pricing, coverage, discount, tax, and approval rules should determine quote scope from the plan?');
  }
  if (followUpScope) {
    questions.push('Which downstream record mappings, creation triggers, and ownership handoffs should create orders, tasks, records, or other follow-up items?');
  }

  const adjacentContextCards = contextPack.cards.filter((card) => {
    if (!['work_instruction', 'document'].includes(card.sourceKind)) return false;
    const cardTerms = significantTerms(`${card.title} ${card.text}`);
    const sharedTerms = Array.from(cardTerms).filter((term) => requirementTerms.has(term));
    const unsupportedTerms = Array.from(cardTerms).filter((term) => !requirementTerms.has(term));
    return sharedTerms.length > 0 && unsupportedTerms.length >= 3;
  });
  const documentTitles = Array.from(new Set(adjacentContextCards
    .filter((card) => card.sourceKind === 'document')
    .map((card) => card.title)))
    .slice(0, 3);
  if (documentTitles.length) {
    questions.push(`Which retrieved document workflow details should apply directly to this requirement, and which remain adjacent context? (${documentTitles.join('; ')})`);
  }

  return Array.from(new Set(questions)).slice(0, 9);
}

function buildFeatureEvidenceRefs(requirement: string, contextPack: V3ContextPack): V3EvidenceRef[] {
  const compatibleCards = contextPack.cards.filter((card) => isContextCardCompatible(requirement, card));
  return selectEvidenceCards(compatibleCards.length ? compatibleCards : contextPack.cards, 4)
    .map((card) => evidenceRef(
      card,
      isContextCardDirect(requirement, card)
        ? `Grounds output in directly matching ${sourceLabel(card)}`
        : `Provides adjacent ${sourceLabel(card)}; narrower workflow details remain open questions`,
    ));
}

function isContextCardCompatible(requirement: string, card: V3ContextPack['cards'][number]): boolean {
  return isContextCardDirect(requirement, card);
}

function isContextCardDirect(requirement: string, card: V3ContextPack['cards'][number]): boolean {
  if (card.kind === 'status' && /\b(status|statuses|progress|state|states)\b/i.test(requirement)) return true;
  const requirementTerms = significantTerms(requirement);
  const cardTerms = significantTerms(`${card.title} ${card.text}`);
  return Array.from(cardTerms).filter((term) => requirementTerms.has(term)).length >= 1;
}

function selectEvidenceCards(cards: V3ContextPack['cards'], maxCards: number): V3ContextPack['cards'] {
  const selected: V3ContextPack['cards'] = [];
  const add = (card: V3ContextPack['cards'][number] | undefined) => {
    if (!card || selected.some((existing) => existing.id === card.id) || selected.length >= maxCards) return;
    selected.push(card);
  };

  add(cards.find((card) => card.sourceKind === 'work_instruction'));
  add(cards.find((card) => card.sourceKind === 'project_context'));
  add(cards.find((card) => card.sourceKind === 'document'));
  add(cards.find((card) => card.sourceKind === 'backlog_example'));
  for (const card of cards) add(card);

  return selected;
}

function mergeEvidenceRefs(...groups: V3EvidenceRef[][]): V3EvidenceRef[] {
  const refs: V3EvidenceRef[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const ref of group) {
      const key = `${ref.cardId}:${ref.sourceId}`;
      if (seen.has(key)) continue;
      refs.push(ref);
      seen.add(key);
    }
  }
  return refs;
}

function sourceLabel(card: V3ContextPack['cards'][number]): string {
  return card.sourceKind.replace('_', ' ');
}

function provenanceForCard(card: V3ContextPack['cards'][number]): V3Provenance {
  if (card.sourceKind === 'work_instruction') return 'work_instruction';
  if (card.sourceKind === 'project_context') return 'project_context';
  if (card.sourceKind === 'document') return 'document';
  if (card.sourceKind === 'backlog_example') return 'backlog_pattern';
  return 'requirement';
}

function buildAcceptanceRequirements(requirement: string, role: string, contextPack: V3ContextPack): V3AcceptanceRequirement[] {
  const action = extractAction(requirement);
  const ruleCards = contextPack.cards.filter((card) => card.kind === 'business_rule' || card.kind === 'workflow_step' || card.kind === 'constraint' || card.kind === 'decision' || card.kind === 'definition' || card.kind === 'status');
  const exceptionCards = contextPack.cards.filter((card) => card.kind === 'exception');
  const backlogCard = contextPack.cards.find((card) => card.sourceKind === 'backlog_example');
  const ars: V3AcceptanceRequirement[] = [];

  const primaryRule = ruleCards[0] ?? contextPack.cards.find((card) => card.sourceKind === 'work_instruction');
  if (primaryRule) {
    const supportedRuleTerms = describeSupportedContextTerms(requirement, primaryRule.text);
    ars.push({
      id: 'ar_1',
      given: compact(`the request is being handled with relevant ${sourceLabel(primaryRule)} context for ${primaryRule.title}`, 180),
      when: compact(hasExplicitActor(requirement) ? `the ${role.toLowerCase()} ${thirdPersonAction(action)}` : action, 180),
      then: compact(`${supportedRuleTerms} are reflected without adding unrelated procedure details from the retrieved context.`, 220),
      provenance: provenanceForCard(primaryRule),
      evidenceRefs: [evidenceRef(primaryRule, `Grounds the primary business rule in retrieved ${sourceLabel(primaryRule)} context`)],
    });
  }

  const primaryException = exceptionCards[0];
  if (primaryException) {
    const supportedExceptionTerms = describeSupportedContextTerms(requirement, primaryException.text);
    ars.push({
      id: 'ar_2',
      given: compact(`the request reaches an exception or ineligible condition`, 180),
      when: compact(`the workflow reaches a requirement-supported exception condition`, 180),
      then: compact(`${supportedExceptionTerms} are visible before the workflow continues.`, 220),
      provenance: provenanceForCard(primaryException),
      evidenceRefs: [evidenceRef(primaryException, `Carries forward exception handling from retrieved ${sourceLabel(primaryException)} context`)],
    });
  }

  if (backlogCard) {
    ars.push({
      id: `ar_${ars.length + 1}`,
      given: compact(`a comparable project story used the ${backlogCard.title} pattern`, 180),
      when: compact(`the generated feature is prepared for Jira refinement`, 180),
      then: compact(`the acceptance criteria stay business-facing and consistent with ${backlogCard.sourceId}`, 220),
      provenance: 'backlog_pattern',
      evidenceRefs: [evidenceRef(backlogCard, 'Uses backlog history as a style and scope pattern')],
    });
  }

  if (!ars.length) {
    ars.push({
      id: 'ar_1',
      given: 'a business stakeholder has a clearly stated requirement',
      when: compact(requirement, 180),
      then: 'the resulting Jira story describes a measurable business outcome',
      provenance: 'requirement',
      evidenceRefs: [],
    });
  }

  return ars.slice(0, 4);
}

function describeSupportedContextTerms(requirement: string, contextText: string): string {
  const requirementTerms = significantTerms(requirement);
  const matchingTerms = Array.from(significantTerms(contextText))
    .filter((term) => requirementTerms.has(term))
    .slice(0, 5);
  return matchingTerms.length ? `${formatList(matchingTerms)} condition${matchingTerms.length === 1 ? '' : 's'}` : 'requirement-supported condition';
}

function formatList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export class HeuristicGenerator implements V3Generator {
  name = 'heuristic';

  async generate(input: {
    requirement: string;
    capabilityPlan: V3CapabilityPlan;
    contextPack: V3ContextPack;
  }): Promise<V3GeneratedDraft> {
    const role = findPrimaryRole(input.requirement, input.contextPack);
    const action = extractAction(input.requirement);
    const contextOpenQuestions = buildContextOpenQuestions(input.requirement, input.contextPack);
    const evidenceRefs = buildFeatureEvidenceRefs(input.requirement, input.contextPack);
    const explicitActor = hasExplicitActor(input.requirement);
    const features: V3GeneratedFeature[] = input.capabilityPlan.capabilities.map((capability, index) => {
      const roleSelection = findRoleForCapability(input.requirement, capability, input.contextPack);
      const featureRole = roleSelection.role;
      const roleEvidenceRefs = roleSelection.evidenceRef ? [roleSelection.evidenceRef] : [];
      return {
        id: `feature_${index + 1}`,
        summary: capability.label || summarizeCapability(input.requirement),
        businessOutcome: compact(capability.businessOutcome || `${explicitActor ? pluralizeRole(featureRole) : 'The business'} can ${action}.`, 240),
        description: storyDescription(featureRole, capability, input.requirement),
        acceptanceRequirements: buildCapabilityAcceptanceRequirements(input.requirement, capability, index),
        provenance: capability.provenance,
        evidenceRefs: mergeEvidenceRefs(index === 0 ? evidenceRefs : [], roleEvidenceRefs),
        assumptions: hasGroundingContext(input.contextPack)
          ? []
          : ['No matching grounding context was retrieved for this requirement.'],
        openQuestions: [],
      };
    });

    if (features.length === 1 && features[0].acceptanceRequirements.length < 2 && input.contextPack.cards.length) {
      const contextRequirements = buildAcceptanceRequirements(input.requirement, role, input.contextPack);
      const seen = new Set(features[0].acceptanceRequirements.map((ar) => `${ar.given} ${ar.when} ${ar.then}`.toLowerCase()));
      for (const ar of contextRequirements) {
        const key = `${ar.given} ${ar.when} ${ar.then}`.toLowerCase();
        if (seen.has(key)) continue;
        features[0].acceptanceRequirements.push(ar);
        seen.add(key);
        if (features[0].acceptanceRequirements.length >= 4) break;
      }
    }

    if (!features.length) {
      const acceptanceRequirements = buildAcceptanceRequirements(input.requirement, role, input.contextPack);
      features.push({
        id: 'feature_1',
        summary: summarizeCapability(input.requirement),
        businessOutcome: compact(`${explicitActor ? pluralizeRole(role) : 'The business'} can ${action}.`, 240),
        description: compact(`As a ${role}, I need to ${action} so that the business can deliver the intended outcome consistently.`, 260),
        acceptanceRequirements,
        provenance: 'requirement',
        evidenceRefs,
        assumptions: [],
        openQuestions: [],
      });
    }

    const blockingQuestions = contextOpenQuestions;

    return {
      features,
      confidence: blockingQuestions.length ? 'medium' : hasGroundingContext(input.contextPack) && input.contextPack.sourceMix.backlogCards ? 'high' : 'medium',
      blockingQuestions,
    };
  }
}

function hasGroundingContext(contextPack: V3ContextPack): boolean {
  return contextPack.sourceMix.workInstructionCards > 0
    || (contextPack.sourceMix.projectContextCards ?? 0) > 0
    || (contextPack.sourceMix.documentCards ?? 0) > 0;
}

export class GeminiJsonGenerator implements V3Generator {
  name = 'gemini-flash-generator';

  constructor(private readonly options: GeminiJsonOptions) {}

  async generate(input: {
    requirement: string;
    capabilityPlan: V3CapabilityPlan;
    contextPack: V3ContextPack;
  }): Promise<V3GeneratedDraft> {
    const draft = await callGeminiJson<V3GeneratedDraft>({
      ...this.options,
      maxOutputTokens: this.options.maxOutputTokens ?? 12288,
      prompt: buildGeminiPrompt(input.requirement, input.capabilityPlan, input.contextPack),
    });
    const normalized = normalizeDraftEvidence(draft, input.requirement, input.contextPack);
    const issues = validateDraft({
      requirement: input.requirement,
      capabilityPlan: input.capabilityPlan,
      draft: normalized,
      contextPack: input.contextPack,
    });

    if (!hasRepairableValidationIssues(issues)) return normalized;

    const repairedDraft = await callGeminiJson<V3GeneratedDraft>({
      ...this.options,
      maxOutputTokens: this.options.maxOutputTokens ?? 12288,
      prompt: `${buildGeminiPrompt(input.requirement, input.capabilityPlan, input.contextPack)}

RETRY INSTRUCTION / REPAIR INSTRUCTION:
The previous draft failed quality checks. Rewrite the same JSON shape and fix these issues:
${issues.map((issue) => `- ${issue.code} at ${issue.path}: ${issue.message}`).join('\n')}

Repair rules:
- Remove duplicated or generic acceptance requirements.
- Rewrite thin THEN statements so they name a concrete business fact, decision, output, exception, or record from the requirement.
- Move adjacent context details into openQuestions unless the source requirement explicitly asks for them.
- Lower confidence to "medium" when open questions remain.`,
    });
    const repaired = normalizeDraftEvidence(repairedDraft, input.requirement, input.contextPack);
    const repairedIssues = validateDraft({
      requirement: input.requirement,
      capabilityPlan: input.capabilityPlan,
      draft: repaired,
      contextPack: input.contextPack,
    });

    return demoteUnresolvedValidationIssues(repaired, repairedIssues);
  }
}

function hasRepairableValidationIssues(issues: V3ValidationIssue[]): boolean {
  return issues.some((issue) => [
    'unsupported_role_in_ar',
    'solution_language',
    'context_overreach',
    'generic_outcome',
    'thin_acceptance_requirement',
    'vague_acceptance_requirement',
    'duplicate_acceptance_requirement',
    'confidence_mismatch',
  ].includes(issue.code));
}

function demoteUnresolvedValidationIssues(draft: V3GeneratedDraft, issues: V3ValidationIssue[]): V3GeneratedDraft {
  if (!issues.length) return draft;

  const questions = Array.from(new Set(issues
    .filter((issue) => ['context_overreach', 'unsupported_role_in_ar', 'solution_language', 'generic_outcome', 'thin_acceptance_requirement', 'vague_acceptance_requirement'].includes(issue.code))
    .map((issue) => {
      if (issue.code === 'context_overreach') return 'Which retrieved workflow details apply to this requirement, and which belong to an adjacent existing process?';
      if (issue.code === 'unsupported_role_in_ar') return 'Which actor role should own this capability?';
      if (issue.code === 'solution_language') return 'Which business outcome should replace implementation-specific wording?';
      return 'Which concrete business fact, decision, output, or exception should this acceptance requirement assert?';
    })));

  return {
    ...draft,
    confidence: draft.confidence === 'high' ? 'medium' : draft.confidence,
    blockingQuestions: Array.from(new Set([...draft.blockingQuestions, ...questions])),
  };
}

function normalizeDraftEvidence(draft: V3GeneratedDraft, requirement: string, contextPack: V3ContextPack): V3GeneratedDraft {
  const cardById = new Map(contextPack.cards.map((card) => [card.id, card]));
  const compatibleCards = contextPack.cards.filter((card) => isContextCardCompatible(requirement, card));
  const fallbackEvidenceRefs = selectEvidenceCards(compatibleCards.length ? compatibleCards : contextPack.cards, 4)
    .map((card) => evidenceRef(card, `Provides retrieved ${sourceLabel(card)} for grounding and open questions`));

  const features = draft.features.map((feature, featureIndex) => {
    const arRefs = feature.acceptanceRequirements.flatMap((ar) => ar.evidenceRefs ?? []);
    return {
      ...feature,
      provenance: feature.provenance ?? 'requirement',
      evidenceRefs: feature.evidenceRefs.length
        ? feature.evidenceRefs
        : arRefs.length
          ? arRefs.slice(0, 4)
          : featureIndex === 0
            ? fallbackEvidenceRefs
            : [],
      acceptanceRequirements: feature.acceptanceRequirements.map((ar) => ({
        ...ar,
        provenance: ar.provenance ?? inferProvenance(ar.evidenceRefs ?? [], cardById),
      })),
    };
  });
  const hasOpenQuestions = draft.blockingQuestions.length > 0
    || features.some((feature) => feature.openQuestions.length > 0);

  return {
    ...draft,
    confidence: draft.confidence === 'high' && hasOpenQuestions ? 'medium' : draft.confidence,
    features,
  };
}

function inferProvenance(refs: V3EvidenceRef[], cardById: Map<string, V3ContextPack['cards'][number]>): V3Provenance {
  const firstCard = refs.map((ref) => cardById.get(ref.cardId)).find(Boolean);
  return firstCard ? provenanceForCard(firstCard) : 'requirement';
}

function buildGeminiPrompt(requirement: string, capabilityPlan: V3CapabilityPlan, contextPack: V3ContextPack): string {
  const context = contextPack.cards.map((card) => [
    `- cardId: ${card.id}`,
    `  sourceKind: ${card.sourceKind}`,
    `  sourceId: ${card.sourceId}`,
    `  kind: ${card.kind}`,
    `  text: ${card.text}`,
  ].join('\n')).join('\n');

  const plan = capabilityPlan.capabilities.map((capability) => [
    `- ${capability.id}: ${capability.label}`,
    `  outcome: ${capability.businessOutcome}`,
    `  requirementEvidence: ${capability.requirementEvidence.join(' | ')}`,
    `  acceptanceFocus: ${capability.acceptanceFocus.join(' | ')}`,
  ].join('\n')).join('\n');

  return `You generate Jira-ready business features and Gherkin acceptance requirements from a capability plan.
Return JSON only with this exact top-level shape:
{
  "features": [{
    "id": "feature_1",
    "summary": "short business capability",
    "businessOutcome": "measurable business outcome",
    "description": "business feature description; persona format only when the source requirement explicitly names the actor",
    "acceptanceRequirements": [{
      "id": "ar_1",
      "given": "...",
      "when": "...",
      "then": "...",
      "provenance": "requirement | work_instruction | project_context | document | backlog_pattern | golden_example | assumption",
      "evidenceRefs": [{ "cardId": "...", "sourceId": "...", "reason": "..." }]
    }],
    "provenance": "requirement | work_instruction | project_context | document | backlog_pattern | golden_example | assumption",
    "evidenceRefs": [{ "cardId": "...", "sourceId": "...", "reason": "..." }],
    "assumptions": [],
    "openQuestions": []
  }],
  "confidence": "low | medium | high",
  "blockingQuestions": []
}

Rules:
- Preserve the capability plan. It is the required backlog skeleton.
- Generate one feature per planned capability unless two capabilities clearly belong together.
- For complex workflows, prefer 2-4 acceptance requirements per feature.
- For "define/create/detail a plan" capabilities, prefer 3-5 acceptance requirements because the plan contents are the core business value.
- Cover primary flow, business rules, exceptions, status outcomes, and downstream outcomes when present in the capability plan.
- Use true business outcomes, not implementation tasks.
- Avoid superficial outcomes like "comprehensive planning"; state the concrete operational outcome.
- Prefer concrete business scenarios over abstract category statements. Use the domain terms named in the requirement or directly supported by context; do not import example-specific workflow details from unrelated domains.
- Write the THEN as the required business capability or observable result. Do not hide the required capability in WHEN.
- Acceptance requirements must be actor-neutral unless the source requirement explicitly names the actor as part of the capability.
- Do not put roles like planner, manager, specialist, technician, requester, approver, or user in GIVEN/WHEN/THEN unless that exact role appears in the source requirement or a cited project context card directly defines the project role.
- WHEN should name the business condition or trigger, not a UI/system operation.
- THEN should name the business capability, business fact, or observable business result.
- Avoid system and solution language such as "the system", "screen", "field", "checkbox", "dropdown", "stored", "pre-populated", "the user selects", or "a workflow item is created".
- Good THEN examples:
  - "the plan reflects the required work types, sequence, target location, materials, effort, and dependency needs"
  - "the generated output includes the billable and non-billable items needed for business review"
  - "required follow-up records or actions are derived from the eligible planned work"
  - "blocked, missing, or conflicting conditions are visible before execution continues"
- Bad pattern:
  - GIVEN a plan is being defined WHEN activities are specified THEN all activities are associated with the plan
  This is too thin because the outcome does not state the concrete business fact or decision.
- If the requirement names activities, resources, labor, materials, financial outputs, downstream records, status, or exceptions, include acceptance requirements whose THEN states those requirement-derived business facts explicitly.
- Preserve optionality: when the requirement says a plan can include a type of work or support, do not make that type mandatory for every plan.
- Do not let tangential context override or replace requirement-derived capabilities.
- Requirement-derived acceptance requirements remain broad and capability-level.
- Use work instruction cards only when they directly support a behavior or exception explicitly present in the source requirement.
- Use project context cards to ground project-native terminology, roles, statuses, issue types, and conventions, but do not turn every project fact into a requirement.
- Use document cards when they directly support a definition, rule, constraint, workflow step, exception, or example relevant to the source requirement.
- If work instruction, project, or document context is related but narrower than the source requirement, put its procedure-specific details in openQuestions rather than acceptanceRequirements.
- Do not promote adjacent workflow details from context into acceptance requirements unless the same concept appears in the source requirement.
- Plausible but unsupported benchmark-style details must become openQuestions, not acceptance requirements. Do not add gates, lifecycle rules, status values, ownership rules, or change-locking details unless the requirement or cited context supports them.
- Use backlog cards for style/scope patterns, not as proof of new behavior.
- Evidence refs are required when provenance is work_instruction, project_context, document, backlog_pattern, or golden_example.
- Requirement-derived features can use provenance "requirement" without evidenceRefs if no relevant card supports them.
- In evidenceRefs, cardId must exactly match a provided cardId and sourceId must exactly match the provided sourceId. Do not prefix sourceId with sourceKind.
- Do not invent resolved facts. Put unresolved material gaps in openQuestions.
- Acceptance requirements must be GIVEN/WHEN/THEN fields, but do not include the words GIVEN, WHEN, THEN inside the field values.

Requirement:
${requirement}

Capability plan:
${plan}

Grounding context:
${context}`;
}
