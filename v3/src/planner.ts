import type { GeminiJsonOptions } from './gemini';
import { callGeminiJson } from './gemini';
import type {
  V3CapabilityPlan,
  V3CapabilitySizingAssessment,
  V3Planner,
  V3SizingCapabilityCandidate,
} from './contracts';
import { toSentenceCase, uniqueTokens } from './text';

export class HeuristicPlanner implements V3Planner {
  name = 'heuristic';

  async plan(input: { requirement: string }): Promise<V3CapabilityPlan> {
    const sizingAssessment = inferSizingAssessment(input.requirement);
    const capabilityLabels = inferCapabilityLabels(input.requirement);
    return {
      capabilities: capabilityLabels.map((label, index) => ({
        id: `cap_${index + 1}`,
        label,
        businessOutcome: inferCapabilityOutcome(label),
        rationale: 'Derived from the plain-English requirement.',
        requirementEvidence: [input.requirement],
        neededEvidence: inferNeededEvidence(label),
        acceptanceFocus: inferAcceptanceFocus(label),
        provenance: 'requirement',
      })),
      openQuestions: [],
      assumptions: [],
      complexity: capabilityLabels.length >= 5 ? 'complex' : capabilityLabels.length >= 3 ? 'moderate' : 'simple',
      sizingAssessment,
    };
  }
}

function inferNeededEvidence(label: string): string[] {
  if (/\b(multi-activity|multiple activities|activity types|scope items?)\b/i.test(label)) {
    return ['supported activity types', 'optional item rules', 'single-plan scope'];
  }
  if (/\b(optional|conditional|applicability|named item)\b/i.test(label)) {
    return ['applicability rules', 'ownership', 'non-applicable exceptions'];
  }
  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(label)) {
    return ['dependency rules', 'blocked-work behavior', 'readiness criteria'];
  }
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(label)) {
    return ['validation rules', 'exception handling', 'blocking vs warning behavior'];
  }
  if (/\b(resource|resources|parts?|labor|location)\b/i.test(label)) {
    return ['resource ownership', 'material and effort rules', 'missing-detail handling'];
  }
  if (/\b(quote|financial|billable|cost|price)\b/i.test(label)) {
    return ['pricing ownership', 'billable item rules', 'quote handoff rules'];
  }
  if (/\b(estimates?|outputs?|artifacts?|packets?|documents?|reports?)\b/i.test(label)) {
    return ['output ownership', 'included item rules', 'output handoff rules'];
  }
  if (/\b(follow[- ]?on|follow[- ]?up|downstream|transactions?|work orders?|shipments?|orders?)\b/i.test(label)) {
    return ['record mappings', 'creation triggers', 'ownership handoffs'];
  }
  if (/\b(status|progress|track|visibility)\b/i.test(label)) {
    return ['status values', 'aggregation rules', 'blocked-work indicators'];
  }
  if (/\b(activity|activities|types)\b/i.test(label)) {
    return ['supported activity types', 'optional activity rules', 'activity ownership'];
  }
  if (/\b(approval|decision|release)\b/i.test(label)) {
    return ['decision owner', 'approval rules', 'missing-decision behavior'];
  }
  if (/\b(modify|change|active|adapt|update)\b/i.test(label)) {
    return ['changeable scope', 'completed-work constraints', 'audit expectations'];
  }
  if (/\b(consolidated|single|plan)\b/i.test(label)) {
    return ['plan owner', 'plan lifecycle', 'plan-to-output relationships'];
  }
  return ['accountable role', 'business rules', 'exception handling'];
}

function inferAcceptanceFocus(label: string): string[] {
  if (/\b(multi-activity|multiple activities|activity types|scope items?)\b/i.test(label)) {
    return ['applicable activity types are represented', 'unneeded types can be omitted', 'activities stay in one plan'];
  }
  if (/\b(optional|conditional|applicability|named item)\b/i.test(label)) {
    return ['optional need is captured only when applicable', 'plans can proceed without inapplicable items'];
  }
  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(label)) {
    return ['prerequisites are captured', 'blocked dependent work is visible', 'follow-up work respects sequence'];
  }
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(label)) {
    return ['invalid combinations are surfaced', 'missing required details block readiness'];
  }
  if (/\b(resource|resources|parts?|labor|location)\b/i.test(label)) {
    return ['resources and effort stay tied to activities', 'missing resource details are visible'];
  }
  if (/\b(quote|financial|billable|cost|price)\b/i.test(label)) {
    return ['billable planned items appear in the quote', 'quote scope traces to planned work'];
  }
  if (/\b(estimates?|outputs?|artifacts?|packets?|documents?|reports?)\b/i.test(label)) {
    return ['planned items appear in the output', 'output scope traces to planned work'];
  }
  if (/\b(follow[- ]?on|follow[- ]?up|downstream|transactions?|work orders?|shipments?|orders?)\b/i.test(label)) {
    return ['eligible follow-on records are derived', 'created work traces to planned activities'];
  }
  if (/\b(status|progress|track|visibility)\b/i.test(label)) {
    return ['overall status reflects related work', 'blocked or delayed work is visible'];
  }
  if (/\b(activity|activities|types)\b/i.test(label)) {
    return ['requested activity types are represented', 'unneeded activity types can be omitted'];
  }
  if (/\b(approval|decision|release)\b/i.test(label)) {
    return ['required decisions are captured', 'missing decisions prevent readiness'];
  }
  if (/\b(modify|change|active|adapt|update)\b/i.test(label)) {
    return ['future work can change', 'completed work remains stable'];
  }
  if (/\b(consolidated|single|plan)\b/i.test(label)) {
    return ['related work shares one planning scope', 'outputs and follow-up work trace to the plan'];
  }
  return ['concrete business outcome is asserted', 'exceptions are identified'];
}

function inferCapabilityOutcome(label: string): string {
  if (/\b(multi-activity|multiple activities|activity types|scope items?)\b/i.test(label)) {
    return 'Coordinated work can be modeled as distinct activity or scope types in one plan.';
  }
  if (/\b(optional|conditional|applicability|named item)\b/i.test(label)) {
    return 'Optional or conditional needs can be reflected without making them mandatory.';
  }
  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(label)) {
    return 'Dependent work can be ordered so prerequisites are visible before execution.';
  }
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(label)) {
    return 'Invalid combinations or missing prerequisites are surfaced before work proceeds.';
  }
  if (/\b(resource|resources|parts?|labor|location)\b/i.test(label)) {
    return 'Each unit of planned work carries the materials, effort, and resource needs required to complete it.';
  }
  if (/\b(quote|financial|billable|cost|price|estimates?)\b/i.test(label)) {
    return 'Billable or estimated items from the plan can be turned into a financial output.';
  }
  if (/\b(outputs?|artifacts?|packets?|documents?|reports?)\b/i.test(label)) {
    return 'Requested outputs can be prepared from the planned scope.';
  }
  if (/\b(follow[- ]?on|follow[- ]?up|downstream|transactions?|work orders?|shipments?|orders?|initiate)\b/i.test(label)) {
    return 'Follow-up records or actions can be derived from eligible planned work.';
  }
  if (/\b(status|progress|track|visibility)\b/i.test(label)) {
    return 'Current status and progress can be understood across the related work.';
  }
  if (/\b(submit|capture|request)\b/i.test(label) && !/\b(status|approval|decision)\b/i.test(label)) {
    return `${label} can be captured with the business facts needed to proceed.`;
  }
  if (/\b(activity|activities|types)\b/i.test(label)) {
    return 'Each requested activity or work type can be represented in the plan.';
  }
  if (/\b(approval|decision|release)\b/i.test(label)) {
    return 'Required business decisions are visible before the work or request proceeds.';
  }
  if (/\b(modify|change|active|adapt|update)\b/i.test(label)) {
    return 'Future work can be adjusted while completed work remains stable.';
  }
  if (/\b(consolidated|single|plan)\b/i.test(label) && !/\b(status|quote)\b/i.test(label)) {
    return 'Related work can be planned as one coordinated business scope.';
  }
  return 'The requested business outcome is represented as a distinct feature.';
}

export class GeminiFlashPlanner implements V3Planner {
  name = 'gemini-flash-planner';

  constructor(private readonly options: GeminiJsonOptions) {}

  async plan(input: { requirement: string }): Promise<V3CapabilityPlan> {
    let sizingAssessment = inferSizingAssessment(input.requirement);

    try {
      sizingAssessment = normalizeSizingAssessment(await callGeminiJson<V3CapabilitySizingAssessment>({
        ...this.options,
        maxOutputTokens: Math.min(this.options.maxOutputTokens ?? 2048, 3072),
        prompt: buildSizingPrompt(input.requirement),
      }), input.requirement);
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      console.warn('[v3] Gemini sizing pass returned invalid JSON; using local sizing assessment.', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const plan = await callGeminiJson<V3CapabilityPlan>({
        ...this.options,
        maxOutputTokens: this.options.maxOutputTokens ?? 4096,
        prompt: buildPlannerPrompt(input.requirement, sizingAssessment),
      });
      return normalizeCapabilityPlan(plan, sizingAssessment);
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      console.warn('[v3] Gemini planner returned invalid JSON; falling back to local capability planner.', {
        error: error instanceof Error ? error.message : String(error),
      });
      const fallback = await new HeuristicPlanner().plan(input);
      return {
        ...fallback,
        sizingAssessment,
      };
    }
  }
}

function isJsonFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid json|parseable json|json at position|unterminated string/i.test(message);
}

function normalizeCapabilityPlan(plan: V3CapabilityPlan, sizingAssessment: V3CapabilitySizingAssessment): V3CapabilityPlan {
  return {
    ...plan,
    capabilities: plan.capabilities.map((capability, index) => ({
      ...capability,
      id: capability.id || `cap_${index + 1}`,
      provenance: capability.provenance || 'requirement',
    })),
    openQuestions: plan.openQuestions ?? [],
    assumptions: plan.assumptions ?? [],
    complexity: plan.complexity || sizingAssessment.complexity,
    sizingAssessment,
  };
}

function normalizeSizingAssessment(
  assessment: Partial<V3CapabilitySizingAssessment>,
  requirement: string,
): V3CapabilitySizingAssessment {
  const fallback = inferSizingAssessment(requirement);
  const complexity = oneOf(assessment.complexity, ['simple', 'moderate', 'complex'] as const, fallback.complexity);
  const rangeFallback = fallback.recommendedFeatureRange;
  const rawMin = Number(assessment.recommendedFeatureRange?.min ?? rangeFallback.min);
  const rawMax = Number(assessment.recommendedFeatureRange?.max ?? rangeFallback.max);
  const min = clampNumber(Number.isFinite(rawMin) ? rawMin : rangeFallback.min, 1, 10);
  const max = clampNumber(Math.max(min, Number.isFinite(rawMax) ? rawMax : rangeFallback.max), min, 12);
  const candidates = (Array.isArray(assessment.candidateCapabilities) ? assessment.candidateCapabilities : fallback.candidateCapabilities)
    .map(normalizeSizingCandidate)
    .filter((candidate): candidate is V3SizingCapabilityCandidate => Boolean(candidate))
    .slice(0, 10);

  return {
    clarity: oneOf(assessment.clarity, ['clear', 'mixed', 'vague'] as const, fallback.clarity),
    complexity,
    ambiguityLevel: oneOf(assessment.ambiguityLevel, ['low', 'medium', 'high'] as const, fallback.ambiguityLevel),
    recommendedFeatureRange: { min, max },
    decompositionStyle: oneOf(
      assessment.decompositionStyle,
      ['single_capability', 'grouped_capabilities', 'workflow_slices', 'mixed'] as const,
      fallback.decompositionStyle,
    ),
    candidateCapabilities: candidates.length ? candidates : fallback.candidateCapabilities,
    capabilitiesLikelyMissingIfOmitted: normalizeStringList(assessment.capabilitiesLikelyMissingIfOmitted, fallback.capabilitiesLikelyMissingIfOmitted, 8),
    openQuestions: normalizeStringList(assessment.openQuestions, fallback.openQuestions, 8),
    reasoningSummary: String(assessment.reasoningSummary || fallback.reasoningSummary).slice(0, 360),
  };
}

function normalizeSizingCandidate(candidate: Partial<V3SizingCapabilityCandidate>): V3SizingCapabilityCandidate | undefined {
  const label = String(candidate.label || '').trim();
  if (!label) return undefined;
  return {
    label: label.slice(0, 120),
    splitRationale: String(candidate.splitRationale || 'Potentially distinct business outcome.').trim().slice(0, 260),
    mergeRisk: String(candidate.mergeRisk || 'Could be merged if it is only a detail of another capability.').trim().slice(0, 260),
    confidence: oneOf(candidate.confidence, ['low', 'medium', 'high'] as const, 'medium'),
    requirementEvidence: normalizeStringList(candidate.requirementEvidence, [], 3),
  };
}

function normalizeStringList(value: unknown, fallback: string[], maxItems: number): string[] {
  const source = Array.isArray(value) ? value : fallback;
  return Array.from(new Set(source
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)))
    .slice(0, maxItems);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function inferSizingAssessment(requirement: string): V3CapabilitySizingAssessment {
  const normalized = requirement.toLowerCase();
  const wordCount = requirement.split(/\s+/).filter(Boolean).length;
  const signalCount = [
    /\bplan\b/.test(normalized),
    /\b(activities?|tasks?|steps?|work types?|scope items?)\b/.test(normalized),
    /\b(optional|conditional|when applicable|if needed|can include)\b/.test(normalized),
    /\b(parts?|labor|resources?|materials?|effort|capacity|equipment|people|staff)\b/.test(normalized),
    /\b(sequence|dependency|before|after|readiness|ready)\b/.test(normalized),
    /\b(approval|approve|decision|review|release)\b/.test(normalized),
    /\bquote|billable|price|financial\b/.test(normalized),
    /\b(outputs?|artifacts?|packets?|documents?|reports?|estimates?)\b/.test(normalized),
    /\b(follow[- ]?up|orders?|shipments?|tickets?|tasks?|records?|downstream)\b/.test(normalized),
    /\b(status|progress|track|visibility)\b/.test(normalized),
  ].filter(Boolean).length;
  const complexity: V3CapabilitySizingAssessment['complexity'] = signalCount >= 5 || /\bcomplex\b/.test(normalized)
    ? 'complex'
    : signalCount >= 3
      ? 'moderate'
      : 'simple';
  const clarity: V3CapabilitySizingAssessment['clarity'] = wordCount < 8
    ? 'vague'
    : /\b(etc|eventually|various|some|maybe|possibly|and so on)\b/i.test(requirement)
      ? 'mixed'
      : 'clear';
  const ambiguityLevel: V3CapabilitySizingAssessment['ambiguityLevel'] = clarity === 'vague'
    ? 'high'
    : clarity === 'mixed' || /\bcomplex\b/.test(normalized)
      ? 'medium'
      : 'low';
  const recommendedFeatureRange = complexity === 'complex'
    ? { min: 4, max: ambiguityLevel === 'high' ? 8 : 7 }
    : complexity === 'moderate'
      ? { min: 2, max: 4 }
      : { min: 1, max: 2 };
  const candidateCapabilities: V3SizingCapabilityCandidate[] = [];
  const namedScopeItems = extractNamedScopeItems(requirement);
  const addCandidate = (
    label: string,
    splitRationale: string,
    mergeRisk: string,
    confidence: V3SizingCapabilityCandidate['confidence'],
    requirementEvidence: string[],
  ) => {
    if (candidateCapabilities.some((candidate) => candidate.label.toLowerCase() === label.toLowerCase())) return;
    candidateCapabilities.push({ label, splitRationale, mergeRisk, confidence, requirementEvidence });
  };

  if (/\b(plan|single plan|coordinated plan|program|roadmap|schedule)\b/.test(normalized)) {
    addCandidate(
      'Define the coordinated plan',
      'The plan is the central business object that ties the work together.',
      'Could absorb smaller planning details if they do not have distinct rules or lifecycle.',
      'high',
      ['plan', 'single plan'].filter((term) => normalized.includes(term)),
    );
  }
  if (/\b(activities?|tasks?|steps?|work types?|scope items?)\b/.test(normalized) || namedScopeItems.length >= 2) {
    addCandidate(
      'Represent named activity or scope types',
      'The ask names multiple kinds of work or scope that may need distinct representation.',
      'Could merge into plan definition if these are only types within the same business outcome.',
      'high',
      namedScopeItems.slice(0, 3),
    );
  }

  for (const item of namedScopeItems.filter((value) => !/\b(activity|activities|task|tasks|part|parts|labor|quote|orders?|shipments?)\b/i.test(value)).slice(0, 3)) {
    addCandidate(
      `Assess ${item} as a distinct capability`,
      `${item} is named alongside other scope items and may have separate rules, lifecycle, or ownership.`,
      `Could merge if ${item} is only an optional type or scenario within a broader capability.`,
      'medium',
      [item],
    );
  }

  if (/\b(parts?|labor|resources?|materials?)\b/.test(normalized)) {
    addCandidate(
      'Plan activity-specific resources',
      'Materials, effort, capacity, locations, or owners affect planning quality and downstream outputs.',
      'Could merge with activity planning if resource rules are simple.',
      'high',
      ['parts', 'labor'].filter((term) => normalized.includes(term)),
    );
  }
  if (/\b(sequence|dependency|before|after|readiness|ready|follow[- ]?up)\b/.test(normalized)) {
    addCandidate(
      'Coordinate sequencing and readiness',
      'Follow-up work depends on planned activities being ordered and ready.',
      'Could merge with plan definition if no blocking rules exist.',
      'medium',
      ['follow-up', 'follow up', 'created'].filter((term) => normalized.includes(term)),
    );
  }
  if (/\bquote|billable|price|financial\b/.test(normalized)) {
    addCandidate(
      'Prepare financial output from planned work',
      'Quote creation is a distinct business output from the planning activity.',
      'Could merge if quote scope is only a later reporting view.',
      'high',
      ['quote'],
    );
  }
  if (/\b(outputs?|artifacts?|packets?|documents?|reports?|estimates?)\b/.test(normalized)) {
    addCandidate(
      'Prepare requested outputs from planned work',
      'The ask names outputs or artifacts that may need their own preparation rules.',
      'Could merge if outputs are only a view of the plan and have no separate acceptance surface.',
      'medium',
      ['output', 'artifact', 'packet', 'document', 'report', 'estimate'].filter((term) => normalized.includes(term)),
    );
  }
  if (/\b(shipments?|orders?|tickets?|records?|handoffs?|tasks?|downstream|follow[- ]?up)\b/.test(normalized)) {
    addCandidate(
      'Create downstream records and handoffs',
      'Downstream records or handoffs are separate artifacts with mapping and creation rules.',
      'Could merge if the ask only needs traceability and not creation behavior.',
      'high',
      ['orders', 'shipments', 'tickets', 'records', 'handoffs', 'tasks'].filter((term) => normalized.includes(term)),
    );
  }
  if (/\b(status|progress|track|visibility)\b/.test(normalized)) {
    addCandidate(
      'Track plan and activity status',
      'Status has a distinct visibility outcome when progress tracking is requested.',
      'Should stay out if the requirement does not ask for status or progress visibility.',
      'medium',
      ['status', 'progress', 'track'].filter((term) => normalized.includes(term)),
    );
  }

  const decompositionStyle: V3CapabilitySizingAssessment['decompositionStyle'] = complexity === 'complex'
    ? 'workflow_slices'
    : complexity === 'moderate'
      ? 'grouped_capabilities'
      : 'single_capability';
  const capabilitiesLikelyMissingIfOmitted = candidateCapabilities
    .filter((candidate) => candidate.confidence === 'high' || (candidate.confidence === 'medium' && /assess|sequence/i.test(candidate.label)))
    .map((candidate) => candidate.label)
    .slice(0, 8);

  return {
    clarity,
    complexity,
    ambiguityLevel,
    recommendedFeatureRange,
    decompositionStyle,
    candidateCapabilities,
    capabilitiesLikelyMissingIfOmitted,
    openQuestions: ambiguityLevel === 'low'
      ? []
      : ['Which candidate capabilities are distinct business outcomes versus details within another capability?'],
    reasoningSummary: 'Local sizing uses requirement signals as guidance; final feature count is not treated as a quota.',
  };
}

function extractNamedScopeItems(requirement: string): string[] {
  const scopeMatch = requirement.match(/\b(?:include|includes|including|with|across)\s+(.+?)(?:\.|\bso that\b|\bwhile\b|$)/i)?.[1] ?? '';
  if (!scopeMatch) return [];
  return Array.from(new Set(scopeMatch
    .replace(/\ball through\b.*$/i, '')
    .replace(/\bfrom\b.*$/i, '')
    .split(/,|\band\b|\bor\b|\//i)
    .map((item) => item
      .replace(/\b(all|the|a|an|that|can|could|may|needed|required|various|multiple|single|one)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase())
    .filter((item) => item.length >= 4 && item.length <= 42 && !/^(etc|through|from|plan|plans)$/.test(item))))
    .slice(0, 8);
}

function inferCapabilityLabels(requirement: string): string[] {
  const normalized = requirement.toLowerCase();
  const labels: string[] = [];
  const planScope = /\b(plan|planning|program|schedule|roadmap)\b/.test(normalized);
  const activityScope = /\b(activities?|tasks?|steps?|work types?|scope items?)\b/.test(normalized);
  const primaryAction = inferPrimaryActionLabel(requirement);
  if (primaryAction && !/\bplan\b/.test(normalized)) labels.push(primaryAction);
  if (planScope) labels.push('Define a coordinated plan');
  if (activityScope || extractNamedScopeItems(requirement).length >= 2) labels.push('Represent named activity and scope types');
  if (/\b(sequence|dependency|dependencies|before|after|follow-up|follow up|created like)\b/.test(normalized)) {
    labels.push('Coordinate sequencing and readiness');
  }
  if (/\b(approval|approve|review|decision|release)\b/.test(normalized)) labels.push('Apply approval and release decisions');
  if (/\b(validate|prevent|invalid|conflict|rule|must|cannot)\b/.test(normalized)) labels.push('Validate rules and exceptions');
  if (/\bpart|labor|resource|location|material|effort|capacity|staff|equipment\b/.test(normalized)) labels.push('Specify resources and effort');
  if (/\bquote|billable|price|financial|estimate|invoice|report|output|artifact|packet|document\b/.test(normalized)) {
    labels.push(inferOutputCapabilityLabel(requirement));
  }
  if (/\bshipment|order|ticket|record|handoff|follow-up|follow up|downstream|created like\b/.test(normalized)) labels.push('Create downstream records and handoffs');
  if (/\b(status|track|visibility|view|progress)\b/.test(normalized)) labels.push('Track status and progress');
  if (/\b(modify|change|active|adapt|update)\b/.test(normalized)) labels.push('Modify active or future work');
  if (!labels.length) {
    const tokens = uniqueTokens(requirement).slice(0, 6);
    labels.push(tokens.length ? toSentenceCase(tokens.join(' ')) : 'Deliver the requested business outcome');
  }
  return Array.from(new Set(labels)).slice(0, 8);
}

function inferPrimaryActionLabel(requirement: string): string | undefined {
  const action = requirement.match(/\ballow\s+.+?\s+to\s+(.+?)(?:\s+so that|\s+while|\s+and\s+show|\s+and\s+track|\.|$)/i)?.[1]
    ?? requirement.match(/\bas a[n]?\s+.+?,\s*i need\s+to\s+(.+?)(?:\s+so that|\s+while|\.|$)/i)?.[1];
  if (!action) return undefined;
  const cleaned = action
    .replace(/\b(that require|requiring|with|before|after)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 5) return undefined;
  return toSentenceCase(cleaned);
}

function inferOutputCapabilityLabel(requirement: string): string {
  const normalized = requirement.toLowerCase();
  const artifactTerms = [
    ...(normalized.match(/\b[a-z]+ packets?\b/g) ?? []),
    ...(normalized.match(/\b[a-z]+ reports?\b/g) ?? []),
    ...(normalized.match(/\b[a-z]+ documents?\b/g) ?? []),
    ...(normalized.match(/\b[a-z]+ artifacts?\b/g) ?? []),
    ...(normalized.match(/\bquotes?\b/g) ?? []),
    ...(normalized.match(/\binvoices?\b/g) ?? []),
  ];
  const estimateTerms = normalized.match(/\b[a-z]+ estimates?\b/g) ?? [];
  const outputTerms = Array.from(new Set((artifactTerms.length ? artifactTerms : estimateTerms)
    .map((term) => term.trim())
    .filter(Boolean)))
    .slice(0, 2);

  if (!outputTerms.length) return 'Prepare requested outputs from planned work';
  return `Prepare ${formatShortList(outputTerms)} from planned work`;
}

function formatShortList(items: string[]): string {
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function buildSizingPrompt(requirement: string): string {
  return `You are doing a lightweight sizing pass before Jira capability planning.
Return JSON only. Do not write features or acceptance requirements yet.

Goal:
- Decide how the ask should be decomposed based on clarity, complexity, ambiguity, and split/merge tradeoffs.
- Recommend a feature count range, not a target quota.
- Surface candidate capabilities that may be missed if the planner merges too aggressively.
- Give split and merge rationale. Do not hardcode domain rules; use the source requirement.

Return this exact JSON shape:
{
  "clarity": "clear | mixed | vague",
  "complexity": "simple | moderate | complex",
  "ambiguityLevel": "low | medium | high",
  "recommendedFeatureRange": { "min": 1, "max": 4 },
  "decompositionStyle": "single_capability | grouped_capabilities | workflow_slices | mixed",
  "candidateCapabilities": [{
    "label": "possible capability",
    "splitRationale": "why this might deserve its own feature",
    "mergeRisk": "why it might instead belong inside another feature",
    "confidence": "low | medium | high",
    "requirementEvidence": ["short phrase from the requirement"]
  }],
  "capabilitiesLikelyMissingIfOmitted": ["candidate label"],
  "openQuestions": ["question that affects decomposition"],
  "reasoningSummary": "short sizing rationale"
}

Split a capability when it has a distinct business outcome, actor/owner, lifecycle/state, rule or exception set, downstream artifact, or acceptance surface.
Merge it when it is only a detail, scenario variant, or optional type inside another capability.
If a named requirement item could be either a separate capability or a scenario, explain both sides.
Keep the range honest: broad complex asks may be 4-7, but clear cohesive asks may still be 2-4.

Requirement:
${requirement}`;
}

function buildPlannerPrompt(requirement: string, sizingAssessment: V3CapabilitySizingAssessment): string {
  const sizing = JSON.stringify(sizingAssessment, null, 2);
  return `You are planning Jira-ready business capabilities from a plain-English requirement.
Use Gemini 2.5 Flash-level concise reasoning. Return JSON only.

Goal:
- Identify the natural feature/capability structure implied by the requirement before seeing project context.
- Do not write acceptance requirements yet.
- Do not invent implementation details.
- Preserve requirement-derived capabilities even if later project context only supports a subset.
- For complex workflow asks, think like a senior business analyst decomposing Jira epics into independently valuable features.
- Name capabilities by the business outcome the user must be able to achieve, not by vague data management.
- Use the sizing assessment as guidance, not a quota.

Return this exact top-level JSON shape:
{
  "capabilities": [{
    "id": "cap_1",
    "label": "business capability label",
    "businessOutcome": "clear business outcome",
    "rationale": "why this is a distinct capability",
    "requirementEvidence": ["short quotes or phrases from the requirement"],
    "neededEvidence": ["workflow rules", "roles", "exceptions", "output rules"],
    "acceptanceFocus": ["primary behavior", "edge case or rule to cover"],
    "provenance": "requirement"
  }],
  "openQuestions": [],
  "assumptions": [],
  "complexity": "simple | moderate | complex"
}

Rules:
- For broad requirements, split into independently valuable business capabilities.
- Do not rigidly hit the recommended range. Choose the final shape based on the split/merge rationale.
- If a candidate capability is likely missing if omitted, either include it or explain the merge decision in another capability rationale.
- Business outcomes must be concrete. Avoid vague phrases like "comprehensive planning", "diverse needs", "necessary resources", or "structured plan" unless followed by the operational result.
- Apply reusable discovery lenses when the requirement supports them:
  1. actors and accountable roles
  2. core business objects or records
  3. lifecycle stages, sequencing, and prerequisites
  4. resources, effort, materials, locations, or capacity
  5. decisions, approvals, rules, and constraints
  6. exceptions, invalid combinations, and missing prerequisites
  7. business outputs such as quotes, reports, notifications, or documents
  8. integrations, handoffs, downstream records, or follow-up actions
  9. status, progress, and audit visibility
  10. change handling for active or future work
- Create sequencing, validation, status, or downstream capabilities only when the requirement and sizing assessment support them; put unresolved rule details in neededEvidence or openQuestions.
- Do not split a capability just because a noun appears. Split only when it has a distinct business outcome, lifecycle, rule set, owner, downstream artifact, or acceptance surface.
- Include active-work modification only when the requirement or workflow lifecycle implies changes after execution starts.
- Put unsupported domain-specific gates, lifecycle rules, and change-locking details in neededEvidence/openQuestions unless the requirement explicitly asks for them.
- Use domain-native labels from the requirement, not generic labels like "Manage data".
- Preserve optionality: when a requirement says a plan or record can include a type of work, do not make that type mandatory for every instance.
- acceptanceFocus should describe the capability outcome to assert in Gherkin, such as "required details are reflected", "business decision is captured", or "follow-up work is derived", not only the trigger.
- Use only these provenance values: requirement, assumption.
- Keep every string concise. Max 90 characters per string.
- requirementEvidence, neededEvidence, and acceptanceFocus must each contain at most 3 short strings.
- Do not include acceptance requirements or long explanatory paragraphs in this plan.

Sizing assessment:
${sizing}

Requirement:
${requirement}`;
}
