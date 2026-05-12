import type {
  V3AcceptanceRequirement,
  V3CapabilityPlan,
  V3ContextPack,
  V3GeneratedDraft,
  V3RetrievedContextCard,
  V3ValidationIssue,
} from './contracts';
import { normalizeText } from './text';

const TECHNICAL_LANGUAGE = /\b(api|endpoint|database|table|frontend|backend|microservice|json|schema|cron|lambda|queue)\b/i;
const SOLUTION_LANGUAGE = /\b(the system|system shall|system must|ui|user interface|screen|button|checkbox|dropdown|input field|form field|database|table|api|endpoint|json|schema|stored|stores|pre-?populated|activity line item|plan line)\b/i;
const GENERIC_OUTCOME = /\b(delivers part of the stated business requirement|intended business outcome|measurable business outcome|proper execution|all specified|necessary operational records|relevant details|supports the required business outcome|clearly stated business need exists)\b/i;
const VAGUE_THEN = /\b(?:is|are|can be|remains?|remain)\s+(?:represented|visible|traceable|reflected|captured|derived|identified)\b/i;
const CONCRETE_BUSINESS_FACTS = [
  'activity',
  'activities',
  'approval',
  'billable',
  'blocked',
  'complete',
  'completed',
  'conflict',
  'customer site',
  'de-installation',
  'deinstallation',
  'dependency',
  'dependencies',
  'decision',
  'distinct line items',
  'equipment shipment',
  'exception',
  'field service',
  'follow-on',
  'in-house',
  'installation',
  'labor',
  'line item',
  'loaner',
  'location',
  'not started',
  'off-site',
  'order release',
  'part',
  'parts',
  'parts order',
  'prerequisite',
  'quote',
  're-installation',
  'repair',
  'request',
  'resource',
  'rule',
  'rules',
  'scope',
  'service facility',
  'sequence',
  'shipment',
  'status',
  'temporary replacement',
  'unavailable equipment',
  'work order',
];
const ROLE_TERMS = [
  'service planner',
  'service planners',
  'dispatch manager',
  'dispatch managers',
  'service manager',
  'service managers',
  'billing specialist',
  'billing specialists',
  'service support specialist',
  'service support specialists',
  'release manager',
  'release managers',
  'business analyst',
  'business analysts',
  'qa lead',
  'qa leads',
  'requester',
  'requesters',
  'approver',
  'approvers',
  'planner',
  'planners',
  'manager',
  'managers',
  'analyst',
  'analysts',
  'specialist',
  'specialists',
  'technician',
  'technicians',
  'business user',
  'business users',
  'user',
  'users',
];

const CONTEXT_SENSITIVE_TERMS: Array<{ term: string; allowedBy: string[] }> = [
  { term: 'customer eligibility', allowedBy: ['customer eligibility', 'eligibility', 'eligible'] },
  { term: 'equipment availability', allowedBy: ['equipment availability', 'availability', 'available equipment', 'unavailable equipment', 'unavailable'] },
  { term: 'expected ship date', allowedBy: ['expected ship date', 'ship date', 'shipment', 'shipping', 'ship'] },
  { term: 'planned return date', allowedBy: ['planned return date', 'return date', 'return'] },
  { term: 'manager review', allowedBy: ['manager review', 'manager approval', 'approval', 'approve', 'manager'] },
  { term: 'not eligible', allowedBy: ['not eligible', 'eligibility', 'eligible'] },
  { term: 'equipment is unavailable', allowedBy: ['equipment unavailable', 'unavailable equipment', 'unavailable', 'availability'] },
  { term: 'rejected', allowedBy: ['reject', 'rejection', 'rejected'] },
  { term: 'clear reason', allowedBy: ['clear reason', 'reason'] },
  { term: 'returned to the planner', allowedBy: ['returned to the planner', 'planner correction', 'correction'] },
  { term: 'Dispatch Manager', allowedBy: ['dispatch manager'] },
  { term: 'reserve the equipment', allowedBy: ['reserve', 'reservation', 'reserved'] },
  { term: 'before shipment', allowedBy: ['shipment', 'shipping', 'ship'] },
  { term: 'returned loaners', allowedBy: ['returned loaner', 'returned loaners', 'return'] },
  { term: 'inspected', allowedBy: ['inspection', 'inspected', 'inspect'] },
  { term: 'entitlement', allowedBy: ['entitlement'] },
  { term: 'safety impact', allowedBy: ['safety impact', 'safety'] },
  { term: 'automatic approval', allowedBy: ['automatic approval'] },
  { term: 'approval timestamp', allowedBy: ['approval timestamp', 'timestamp'] },
  { term: 'approving manager', allowedBy: ['approving manager', 'manager approval', 'approval'] },
  { term: 'authorization', allowedBy: ['authorization', 'authorisation'] },
];
const GENERIC_CONTEXT_WORDS = new Set([
  'the',
  'and',
  'for',
  'from',
  'with',
  'when',
  'then',
  'that',
  'this',
  'they',
  'their',
  'must',
  'shall',
  'should',
  'before',
  'after',
  'unless',
  'under',
  'into',
  'request',
  'requests',
  'workflow',
  'service',
  'services',
  'work',
  'plan',
  'plans',
  'activity',
  'activities',
  'customer',
  'customers',
  'equipment',
]);
const BROAD_CONTEXT_TOKENS = new Set([
  'case',
  'need',
  'needs',
  'needed',
  'include',
  'includes',
  'included',
  'required',
  'requires',
  'handled',
  'handling',
  'available',
  'another',
]);

export function validateDraft(input: {
  requirement: string;
  capabilityPlan: V3CapabilityPlan;
  draft: V3GeneratedDraft;
  contextPack: V3ContextPack;
}): V3ValidationIssue[] {
  const issues: V3ValidationIssue[] = [];
  const knownCardIds = new Set(input.contextPack.cards.map((card) => card.id));
  const cardById = new Map(input.contextPack.cards.map((card) => [card.id, card]));

  if (!input.draft.features.length) {
    issues.push({
      code: 'missing_feature',
      path: '$.features',
      message: 'At least one feature is required.',
    });
  }

  input.draft.features.forEach((feature, featureIndex) => {
    const featurePath = `$.features[${featureIndex}]`;
    if (!feature.businessOutcome.trim()) {
      issues.push({
        code: 'missing_business_outcome',
        path: `${featurePath}.businessOutcome`,
        message: 'Feature must state a business outcome.',
      });
    }
    if (TECHNICAL_LANGUAGE.test(`${feature.summary} ${feature.description} ${feature.businessOutcome}`)) {
      issues.push({
        code: 'technical_language',
        path: featurePath,
        message: 'Feature should describe business behavior rather than implementation details.',
      });
    }
    const featureNeedsEvidence = feature.provenance && !['requirement', 'assumption'].includes(feature.provenance);
    if ((featureNeedsEvidence && !feature.evidenceRefs.length) || feature.evidenceRefs.some((ref) => !knownCardIds.has(ref.cardId))) {
      issues.push({
        code: 'missing_evidence',
        path: `${featurePath}.evidenceRefs`,
        message: 'Feature must cite retrieved context evidence when it claims context-derived provenance.',
      });
    }

    const seenAcceptanceRequirements = new Set<string>();
    feature.acceptanceRequirements.forEach((ar, arIndex) => {
      const arPath = `${featurePath}.acceptanceRequirements[${arIndex}]`;
      const arText = `${ar.given} ${ar.when} ${ar.then}`;
      if (!ar.given.trim() || !ar.when.trim() || !ar.then.trim()) {
        issues.push({
          code: 'invalid_gherkin',
          path: arPath,
          message: 'Acceptance requirement must include non-empty given, when, and then fields.',
        });
      }
      if (TECHNICAL_LANGUAGE.test(arText)) {
        issues.push({
          code: 'technical_language',
          path: arPath,
          message: 'Acceptance requirement should stay business-facing.',
        });
      }
      const refs = ar.evidenceRefs ?? [];
      const contextCardsForAr = refs.length
        ? refs.map((ref) => cardById.get(ref.cardId)).filter(isCard)
        : input.contextPack.cards;
      const unsupportedRoles = findUnsupportedRoles(input.requirement, ar, contextCardsForAr);
      if (unsupportedRoles.length) {
        issues.push({
          code: 'unsupported_role_in_ar',
          path: arPath,
          message: `Acceptance requirement names role(s) not present in the source requirement: ${unsupportedRoles.join(', ')}.`,
        });
      }
      if (SOLUTION_LANGUAGE.test(arText)) {
        issues.push({
          code: 'solution_language',
          path: arPath,
          message: 'Acceptance requirement should describe the business capability, not system/UI/data-model behavior.',
        });
      }
      if (isThinAcceptanceRequirement(ar)) {
        issues.push({
          code: 'thin_acceptance_requirement',
          path: arPath,
          message: 'Acceptance requirement is too generic or thin to guide implementation.',
        });
      }
      if (isVagueAcceptanceRequirement(ar)) {
        issues.push({
          code: 'vague_acceptance_requirement',
          path: arPath,
          message: 'Acceptance requirement uses vague outcome language without enough concrete business facts.',
        });
      }
      if (GENERIC_OUTCOME.test(arText) || GENERIC_OUTCOME.test(feature.businessOutcome)) {
        issues.push({
          code: 'generic_outcome',
          path: arPath,
          message: 'Acceptance requirement should name the concrete business fact or outcome, not a generic delivery statement.',
        });
      }
      const duplicateKey = normalizeAcceptanceRequirement(ar);
      if (seenAcceptanceRequirements.has(duplicateKey)) {
        issues.push({
          code: 'duplicate_acceptance_requirement',
          path: arPath,
          message: 'Acceptance requirement duplicates another requirement in the same feature.',
        });
      }
      seenAcceptanceRequirements.add(duplicateKey);
      const arNeedsEvidence = ar.provenance && !['requirement', 'assumption'].includes(ar.provenance);
      if ((arNeedsEvidence && !refs.length) || refs.some((ref) => !knownCardIds.has(ref.cardId))) {
        issues.push({
          code: 'missing_evidence',
          path: `${arPath}.evidenceRefs`,
          message: 'Acceptance requirement must cite retrieved context evidence when it claims context-derived provenance.',
        });
      }
      const overreachTerms = findContextOverreach(input.requirement, ar, contextCardsForAr);
      if (overreachTerms.length) {
        issues.push({
          code: 'context_overreach',
          path: arPath,
          message: `Acceptance requirement promotes context-specific detail not present in the source requirement: ${overreachTerms.slice(0, 4).join(', ')}.`,
        });
      }
    });
  });

  const allRefs = input.draft.features.flatMap((feature) => [
    ...feature.evidenceRefs,
    ...feature.acceptanceRequirements.flatMap((ar) => ar.evidenceRefs ?? []),
  ]);
  const referencedCards = input.contextPack.cards.filter((card) => allRefs.some((ref) => ref.cardId === card.id));
  if (input.contextPack.sourceMix.workInstructionCards > 0 && !referencedCards.some((card) => card.sourceKind === 'work_instruction')) {
    issues.push({
      code: 'missing_work_instruction_grounding',
      path: '$.features',
      message: 'Output should cite at least one retrieved work instruction card.',
    });
  }
  if ((input.contextPack.sourceMix.projectContextCards ?? 0) > 0 && !referencedCards.some((card) => card.sourceKind === 'project_context')) {
    issues.push({
      code: 'missing_project_context_grounding',
      path: '$.features',
      message: 'Output should cite at least one retrieved project context card when using project grounding.',
    });
  }
  if ((input.contextPack.sourceMix.documentCards ?? 0) > 0 && !referencedCards.some((card) => card.sourceKind === 'document')) {
    issues.push({
      code: 'missing_document_grounding',
      path: '$.features',
      message: 'Output should cite at least one retrieved document card when using uploaded project documents.',
    });
  }
  if (
    input.contextPack.sourceMix.backlogCards > 0
    && input.contextPack.sourceMix.workInstructionCards === 0
    && !referencedCards.some((card) => card.sourceKind === 'backlog_example')
  ) {
    issues.push({
      code: 'missing_backlog_grounding',
      path: '$.features',
      message: 'Output should cite a retrieved backlog example when backlog is the only available grounding context.',
    });
  }

  const openQuestionCount = input.draft.blockingQuestions.length
    + input.draft.features.reduce((sum, feature) => sum + feature.openQuestions.length, 0)
    + input.capabilityPlan.openQuestions.length;
  const hasSeriousIssue = issues.some((issue) => [
    'unsupported_role_in_ar',
    'solution_language',
    'context_overreach',
    'generic_outcome',
    'thin_acceptance_requirement',
    'vague_acceptance_requirement',
    'duplicate_acceptance_requirement',
    'missing_feature',
    'invalid_gherkin',
  ].includes(issue.code));
  if (input.draft.confidence === 'high' && (openQuestionCount > 0 || input.capabilityPlan.assumptions.length > 0 || hasSeriousIssue)) {
    issues.push({
      code: 'confidence_mismatch',
      path: '$.confidence',
      message: 'High confidence is not appropriate while scope, assumption, or validation discipline issues remain.',
    });
  }

  return issues;
}

function isThinAcceptanceRequirement(ar: V3AcceptanceRequirement): boolean {
  const words = normalizeText(`${ar.given} ${ar.when} ${ar.then}`).split(' ').filter(Boolean);
  if (words.length < 14) return true;
  if (normalizeText(ar.then).split(' ').filter(Boolean).length < 6) return true;
  return GENERIC_OUTCOME.test(`${ar.given} ${ar.when} ${ar.then}`);
}

function isVagueAcceptanceRequirement(ar: V3AcceptanceRequirement): boolean {
  const normalizedThen = normalizeText(ar.then);
  if (!VAGUE_THEN.test(ar.then)) return false;
  const concreteHits = CONCRETE_BUSINESS_FACTS.filter((term) => hasPhrase(normalizedThen, normalizeText(term))).length;
  return /\btraceable\b/i.test(ar.then) ? concreteHits < 2 : concreteHits < 1;
}

function normalizeAcceptanceRequirement(ar: V3AcceptanceRequirement): string {
  return normalizeText(`${ar.given} ${ar.when} ${ar.then}`)
    .replace(/\bar \d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findUnsupportedRoles(
  requirement: string,
  ar: V3AcceptanceRequirement,
  cards: V3RetrievedContextCard[] = [],
): string[] {
  const requirementText = normalizeText(requirement);
  const contextText = normalizeText(cards.map((card) => `${card.title} ${card.text}`).join(' '));
  const arText = normalizeText(`${ar.given} ${ar.when} ${ar.then}`);
  return Array.from(new Set(ROLE_TERMS.filter((role) => {
    const normalizedRole = normalizeText(role);
    return hasPhrase(arText, normalizedRole)
      && !roleSupportedByRequirement(requirementText, normalizedRole)
      && !roleSupportedByRequirement(contextText, normalizedRole);
  })));
}

function roleSupportedByRequirement(requirementText: string, role: string): boolean {
  if (hasPhrase(requirementText, role)) return true;
  const variants = new Set<string>([role]);
  if (role.endsWith('s')) variants.add(role.slice(0, -1));
  if (!role.endsWith('s')) variants.add(`${role}s`);
  variants.add(role.replace(/\bplanner\b/g, 'planners'));
  variants.add(role.replace(/\bmanager\b/g, 'managers'));
  variants.add(role.replace(/\banalyst\b/g, 'analysts'));
  variants.add(role.replace(/\brequester\b/g, 'requesters'));
  variants.add(role.replace(/\bapprover\b/g, 'approvers'));
  return Array.from(variants).some((variant) => hasPhrase(requirementText, normalizeText(variant)));
}

function findContextOverreach(
  requirement: string,
  ar: V3AcceptanceRequirement,
  cards: V3RetrievedContextCard[],
): string[] {
  const requirementText = normalizeText(requirement);
  const arText = normalizeText(`${ar.given} ${ar.when} ${ar.then}`);
  const terms = new Set<string>();

  for (const card of cards.filter(isOverreachSensitiveCard)) {
    const cardText = normalizeText(card.text);
    for (const item of CONTEXT_SENSITIVE_TERMS) {
      const term = normalizeText(item.term);
      if (!hasPhrase(cardText, term) || !hasPhrase(arText, term)) continue;
      if (item.allowedBy.some((phrase) => hasPhrase(requirementText, normalizeText(phrase)))) continue;
      terms.add(item.term);
    }
    for (const term of extractContextDetailTerms(card.text)) {
      if (!hasPhrase(arText, term)) continue;
      if (isTermSupportedByRequirement(requirementText, term)) continue;
      terms.add(term);
    }
  }

  return Array.from(terms);
}

function isOverreachSensitiveCard(card: V3RetrievedContextCard): boolean {
  return card.sourceKind === 'work_instruction'
    || card.sourceKind === 'document'
    || (card.sourceKind === 'project_context' && ['business_rule', 'constraint', 'decision', 'exception'].includes(card.kind));
}

function extractContextDetailTerms(text: string): string[] {
  const tokens = normalizeText(text)
    .split(' ')
    .filter((token) => token.length >= 4 && !GENERIC_CONTEXT_WORDS.has(token));
  const terms = new Set<string>();

  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phraseTokens = tokens.slice(index, index + size);
      if (!phraseTokens.some((token) => isSpecificContextToken(token))) continue;
      terms.add(phraseTokens.join(' '));
    }
  }

  return Array.from(terms);
}

function isSpecificContextToken(token: string): boolean {
  return !BROAD_CONTEXT_TOKENS.has(token);
}

function isTermSupportedByRequirement(requirementText: string, term: string): boolean {
  if (hasPhrase(requirementText, term)) return true;
  return term
    .split(' ')
    .filter(isSpecificContextToken)
    .some((token) => isTokenSupportedByRequirement(requirementText, token));
}

function isTokenSupportedByRequirement(requirementText: string, token: string): boolean {
  if (hasPhrase(requirementText, token)) return true;
  const related: Record<string, string[]> = {
    approve: ['approval', 'approved'],
    approved: ['approval', 'approve'],
    approval: ['approve', 'approved'],
    eligible: ['eligibility'],
    eligibility: ['eligible'],
    availability: ['available', 'unavailable'],
    unavailable: ['availability', 'available'],
    reserve: ['reserved', 'reservation'],
    reserved: ['reserve', 'reservation'],
    reservation: ['reserve', 'reserved'],
    ship: ['shipping', 'shipment'],
    shipment: ['ship', 'shipping'],
    returned: ['return'],
    authorization: ['authorize', 'authorisation'],
    authorisation: ['authorize', 'authorization'],
  };
  return (related[token] ?? []).some((relatedToken) => hasPhrase(requirementText, relatedToken));
}

function hasPhrase(text: string, phrase: string): boolean {
  return new RegExp(`(^| )${escapeRegExp(phrase)}( |$)`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCard(card: V3RetrievedContextCard | undefined): card is V3RetrievedContextCard {
  return Boolean(card);
}
