/**
 * Shipped AR quality anchor bundle.
 *
 * These exemplars are used as a fallback when the tenant's retrieved backlog
 * pool either fails the hard gate (no substantive structured ARs) or its
 * best items score below the minimum quality floor.
 *
 * Purpose: ensure the AR writer always receives at least one concrete
 * GIVEN/WHEN/THEN example demonstrating:
 *   - compound preconditions
 *   - concrete business nouns in THEN clauses
 *   - branch variants / dependency enforcement
 *   - realistic edge-case ARs beyond the happy path
 *
 * Rules:
 *   - Strictly domain-agnostic and system-agnostic
 *   - No product names, module names, UI references, or org-specific terminology
 *   - Label set so the model uses structure/depth as inspiration, not scope
 */

export interface ArAnchorTriple {
  given: string;
  when: string;
  then: string;
}

export interface ArAnchorExample {
  id: string;
  summary: string;
  triples: ArAnchorTriple[];
}

/**
 * ANCHOR_EXAMPLES is the canonical shipped set.
 * Keep at 4–6 examples covering distinct AR patterns.
 * Each example must have ≥3 triples, all three clauses ≥ 5 words.
 */
export const ANCHOR_EXAMPLES: ArAnchorExample[] = [
  {
    id: 'approval_workflow',
    summary: 'Transition an active request through a phased approval workflow',
    triples: [
      {
        given: 'a request has met all prerequisite conditions for the next stage',
        when: 'the responsible party submits the request for approval',
        then: 'a formal approval record is created and linked to the request',
      },
      {
        given: 'an approval record has been created for a request',
        when: 'the approver records a rejection with a stated reason',
        then: 'the request status changes to requires revision and the reason is captured',
      },
      {
        given: 'a request that was previously rejected has been revised',
        when: 'the responsible party resubmits it for approval',
        then: 'a new approval record is created and the prior rejection is retained in history',
      },
      {
        given: 'a request has not met all prerequisite conditions',
        when: 'the responsible party attempts to submit it for approval',
        then: 'the submission is prevented until the outstanding prerequisites are met',
      },
    ],
  },
  {
    id: 'follow_on_transactions',
    summary: 'Generate follow-on transactions from a finalised plan',
    triples: [
      {
        given: 'a plan has been approved and contains activities requiring parts at multiple locations',
        when: 'execution of the plan is initiated',
        then: 'a separate parts order is created for each distinct fulfilment location',
      },
      {
        given: 'a plan has been approved and contains both covered and billable activities',
        when: 'execution of the plan is initiated',
        then: 'follow-on transactions are created only for the covered activities until the customer authorises the billable portion',
      },
      {
        given: 'a plan has not been approved for execution',
        when: 'an attempt is made to create follow-on transactions from it',
        then: 'no orders or work records are created',
      },
      {
        given: 'an approved plan contains activities that are sequentially dependent',
        when: 'the first activity is initiated',
        then: 'only the transactions for the first activity are created and subsequent activities remain pending',
      },
    ],
  },
  {
    id: 'dependency_ordering',
    summary: 'Enforce dependency ordering across sequenced activities',
    triples: [
      {
        given: 'a workflow contains two sequenced activities where the second depends on completion of the first',
        when: 'the first activity has not yet been marked complete',
        then: 'the second activity cannot be scheduled or initiated',
      },
      {
        given: 'the first activity in a dependent sequence has been recorded as complete',
        when: 'the next activity in the sequence is reviewed',
        then: 'the next activity becomes available for scheduling and initiation',
      },
      {
        given: 'a dependent activity requires a resource that has not yet been fulfilled',
        when: 'an attempt is made to initiate the dependent activity',
        then: 'initiation is blocked until the required resource fulfilment is confirmed',
      },
    ],
  },
  {
    id: 'entitlement_rules',
    summary: 'Apply entitlement rules to determine billable items on a service record',
    triples: [
      {
        given: 'a service record contains activities all of which are covered by an active agreement',
        when: 'an entitlement check is performed on the record',
        then: 'all activities are identified as not billable and no quote is required',
      },
      {
        given: 'a service record contains a mix of covered and uncovered activities',
        when: 'an entitlement check is performed on the record',
        then: 'each activity is individually identified as either covered or billable',
      },
      {
        given: 'a service record has been checked for entitlement and billable items were identified',
        when: "the customer's authorisation for the billable amount is recorded",
        then: 'all activities on the record become eligible for execution',
      },
      {
        given: 'a service record has not yet had an entitlement check performed',
        when: 'an attempt is made to generate a quote from the record',
        then: 'the quote cannot be generated until the entitlement check is complete',
      },
    ],
  },
  {
    id: 'consolidated_status',
    summary: 'Track and report consolidated status across related sub-records',
    triples: [
      {
        given: 'a parent record has multiple associated sub-records in different states',
        when: 'the parent record is reviewed',
        then: 'the current status of each sub-record is visible without navigating to each one individually',
      },
      {
        given: 'all sub-records linked to a parent record have reached a completed state',
        when: 'the parent record status is evaluated',
        then: 'the parent record status reflects that the overall process is complete',
      },
      {
        given: 'one or more sub-records linked to a parent record are delayed or cancelled',
        when: 'the parent record is reviewed',
        then: 'the affected sub-records are identifiable and their individual status is visible on the parent',
      },
    ],
  },
];

/**
 * Format the anchor bundle for injection into the AR pass 2 prompt.
 * Returns the formatted text block ready for use as a fallback exemplar section.
 */
export function formatAnchorBundleText(): string {
  const lines: string[] = [
    '<reference_examples purpose="anchor_acceptance_patterns">',
    'These are reference examples only. Match their specificity and depth without copying their scope.',
    'Study the structure: compound preconditions in GIVEN, concrete business objects in THEN, distinct branch variants.',
  ];
  for (const example of ANCHOR_EXAMPLES) {
    lines.push(`<example id="${example.id}">`);
    lines.push(`<story_summary>${example.summary}</story_summary>`);
    lines.push('<acceptance_requirements>');
    for (const t of example.triples) {
      lines.push(`GIVEN ${t.given}`);
      lines.push(`WHEN ${t.when}`);
      lines.push(`THEN ${t.then}`);
    }
    lines.push('</acceptance_requirements>');
    lines.push('</example>');
  }
  lines.push('</reference_examples>');
  return lines.join('\n').trimEnd();
}
