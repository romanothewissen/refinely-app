import type { GeminiJsonOptions } from './gemini';
import { callGeminiJson } from './gemini';
import type { V3CapabilityPlan, V3Planner } from './contracts';
import { toSentenceCase, uniqueTokens } from './text';

export class HeuristicPlanner implements V3Planner {
  name = 'heuristic';

  async plan(input: { requirement: string }): Promise<V3CapabilityPlan> {
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
    };
  }
}

function inferNeededEvidence(label: string): string[] {
  if (/\b(multi-activity|multiple service activities)\b/i.test(label)) {
    return ['supported activity chains', 'optional loaner rules', 'single-plan scope'];
  }
  if (/\b(loaner|temporary replacement)\b/i.test(label)) {
    return ['loaner applicability rules', 'temporary equipment ownership', 'non-loaner exceptions'];
  }
  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(label)) {
    return ['dependency rules', 'blocked-work behavior', 'readiness criteria'];
  }
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(label)) {
    return ['validation rules', 'exception handling', 'blocking vs warning behavior'];
  }
  if (/\b(resource|resources|parts?|labor|location)\b/i.test(label)) {
    return ['resource ownership', 'parts and labor rules', 'missing-detail handling'];
  }
  if (/\b(quote|financial|billable|cost|price)\b/i.test(label)) {
    return ['pricing ownership', 'billable item rules', 'quote handoff rules'];
  }
  if (/\b(follow-on|follow up|downstream|transaction|work order|shipment|order)\b/i.test(label)) {
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
  if (/\b(multi-activity|multiple service activities)\b/i.test(label)) {
    return ['loaner and non-loaner activity chains are represented', 'unneeded activity types can be omitted', 'activities stay in one plan'];
  }
  if (/\b(loaner|temporary replacement)\b/i.test(label)) {
    return ['loaner need is captured only when applicable', 'plans can proceed without loaners'];
  }
  if (/\b(sequence|sequencing|dependencies|dependency|prerequisites?|prerequisite)\b/i.test(label)) {
    return ['prerequisites are captured', 'blocked dependent work is visible', 'follow-up work respects sequence'];
  }
  if (/\b(validate|rule|exception|illogical|logical sequence)\b/i.test(label)) {
    return ['invalid combinations are surfaced', 'missing required details block readiness'];
  }
  if (/\b(resource|resources|parts?|labor|location)\b/i.test(label)) {
    return ['parts and labor stay tied to activities', 'missing resource details are visible'];
  }
  if (/\b(quote|financial|billable|cost|price)\b/i.test(label)) {
    return ['billable planned items appear in the quote', 'quote scope traces to planned work'];
  }
  if (/\b(follow-on|follow up|downstream|transaction|work order|shipment|order)\b/i.test(label)) {
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
  if (/\b(multi-activity|multiple service activities)\b/i.test(label)) {
    return 'Complex service events can be modeled as distinct activity chains in one plan.';
  }
  if (/\b(loaner|temporary replacement)\b/i.test(label)) {
    return 'Temporary replacement needs can be reflected without making them mandatory.';
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
  if (/\b(quote|financial|billable|cost|price)\b/i.test(label)) {
    return 'Billable items from the plan can be turned into a customer-facing financial output.';
  }
  if (/\b(follow-on|follow up|downstream|transaction|work order|shipment|order|initiate)\b/i.test(label)) {
    return 'Follow-up records or actions can be derived from eligible planned work.';
  }
  if (/\b(status|progress|track|visibility)\b/i.test(label) && /\bservice plan\b/i.test(label)) {
    return 'Progress can be understood across the overall plan and its related work.';
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
    try {
      return await callGeminiJson<V3CapabilityPlan>({
        ...this.options,
        maxOutputTokens: this.options.maxOutputTokens ?? 4096,
        prompt: buildPlannerPrompt(input.requirement),
      });
    } catch (error) {
      if (!isJsonFailure(error)) throw error;
      console.warn('[v3] Gemini planner returned invalid JSON; falling back to local capability planner.', {
        error: error instanceof Error ? error.message : String(error),
      });
      return new HeuristicPlanner().plan(input);
    }
  }
}

function isJsonFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid json|parseable json|json at position|unterminated string/i.test(message);
}

function inferCapabilityLabels(requirement: string): string[] {
  const normalized = requirement.toLowerCase();
  const labels: string[] = [];
  const serviceScope = /\b(service plan|complex services?|field service|in-house service|deinstallations?|installations?)\b/.test(normalized);
  if (isComplexServicePlanRequirement(normalized)) {
    return [
      'Define a multi-activity service plan',
      'Specify resources and details for each activity',
      'Enforce scheduling dependencies between sequenced activities',
      'Validate logical service activity sequence',
      'Generate a consolidated quote',
      'Initiate follow-on transactions',
      'View consolidated service plan status',
    ];
  }
  const primaryAction = inferPrimaryActionLabel(requirement);
  if (primaryAction && !/\bplan\b/.test(normalized)) labels.push(primaryAction);
  if (/\bplan\b/.test(normalized)) labels.push(serviceScope ? 'Define a consolidated service plan' : 'Define a consolidated plan');
  if (serviceScope && /\b(field service|in-house|loaner|deinstallation|installation|activities)\b/.test(normalized)) {
    labels.push(serviceScope ? 'Plan multiple service activities' : 'Plan multiple activity types');
  }
  if (/\bplan\b/.test(normalized) && /\bloaners?\b/.test(normalized)) labels.push('Capture loaner need in the service plan');
  if (/\b(sequence|dependency|dependencies|before|after|follow-up|follow up|created like)\b/.test(normalized)) {
    labels.push(serviceScope ? 'Manage activity sequencing and dependencies' : 'Manage sequencing and prerequisites');
  }
  if (/\b(approval|approve|review|decision|release)\b/.test(normalized)) labels.push('Apply approval and release decisions');
  if (/\b(validate|prevent|illogical|rule|must|cannot)\b/.test(normalized)) labels.push(serviceScope ? 'Validate service plan rules and exceptions' : 'Validate rules and exceptions');
  if (/\bpart|labor|resource|location\b/.test(normalized)) labels.push('Specify activity resources');
  if (/\bquote|billable|price\b/.test(normalized)) labels.push(serviceScope ? 'Generate a consolidated quote' : 'Generate a financial output');
  if (/\bwork order|shipment|parts order|follow-up|follow up|downstream|created like\b/.test(normalized)) labels.push(serviceScope ? 'Create follow-on transactions' : 'Create follow-on records or actions');
  if (/\b(status|track|visibility|view|progress)\b/.test(normalized) || /\bsingle plan\b/.test(normalized) && /\bfollow(?:-| )?up\b/.test(normalized)) {
    labels.push(serviceScope ? 'Track consolidated service plan status' : 'Track status and progress');
  }
  if (/\b(modify|change|active|adapt|update)\b/.test(normalized)) labels.push(serviceScope ? 'Modify an active service plan' : 'Modify active or future work');
  if (!labels.length) {
    const tokens = uniqueTokens(requirement).slice(0, 6);
    labels.push(tokens.length ? toSentenceCase(tokens.join(' ')) : 'Deliver the requested business outcome');
  }
  return Array.from(new Set(labels)).slice(0, 8);
}

function isComplexServicePlanRequirement(normalizedRequirement: string): boolean {
  return /\bcomplex services?\b/.test(normalizedRequirement)
    && /\bsingle plan\b|\bservice plan\b/.test(normalizedRequirement)
    && /\b(field service|in-house service|loaners?|deinstallations?|installations?|parts?|labor|quote|follow-up|follow up|work orders?|shipments?)\b/.test(normalizedRequirement);
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

function buildPlannerPrompt(requirement: string): string {
  return `You are planning Jira-ready business capabilities from a plain-English requirement.
Use Gemini 2.5 Flash-level concise reasoning. Return JSON only.

Goal:
- Identify the natural feature/capability structure implied by the requirement before seeing project context.
- Do not write acceptance requirements yet.
- Do not invent implementation details.
- Preserve requirement-derived capabilities even if later project context only supports a subset.
- For complex workflow asks, think like a senior business analyst decomposing Jira epics into independently valuable features.
- Name capabilities by the business outcome the user must be able to achieve, not by vague data management.

Return this exact top-level JSON shape:
{
  "capabilities": [{
    "id": "cap_1",
    "label": "business capability label",
    "businessOutcome": "clear business outcome",
    "rationale": "why this is a distinct capability",
    "requirementEvidence": ["short quotes or phrases from the requirement"],
    "neededEvidence": ["workflow rules", "roles", "exceptions", "quote rules"],
    "acceptanceFocus": ["primary behavior", "edge case or rule to cover"],
    "provenance": "requirement"
  }],
  "openQuestions": [],
  "assumptions": [],
  "complexity": "simple | moderate | complex"
}

Rules:
- For broad requirements, split into independently valuable business capabilities.
- Prefer 6-8 capabilities for complex workflow/platform asks.
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
- Create sequencing, validation, status, or downstream capabilities when the requirement implies coordinated dependent work; put unresolved rule details in neededEvidence or openQuestions.
- For complex service-plan requirements, prefer a JSA-like skeleton: multi-activity plan, activity resources/details, scheduling dependencies, logical sequence validation, quote, follow-on transactions, and consolidated status.
- Include active-work modification only when the requirement or workflow lifecycle implies changes after execution starts.
- Put payment authorization gates, return authorization, preventive maintenance due dates, and active-plan modification in neededEvidence/openQuestions unless the requirement explicitly asks for them.
- Use domain-native labels from the requirement, not generic labels like "Manage data".
- Preserve optionality: when a requirement says a plan or record can include a type of work, do not make that type mandatory for every instance.
- acceptanceFocus should describe the capability outcome to assert in Gherkin, such as "required details are reflected", "business decision is captured", or "follow-up work is derived", not only the trigger.
- Use only these provenance values: requirement, assumption.
- Keep every string concise. Max 90 characters per string.
- requirementEvidence, neededEvidence, and acceptanceFocus must each contain at most 3 short strings.
- Do not include acceptance requirements or long explanatory paragraphs in this plan.

Requirement:
${requirement}`;
}
