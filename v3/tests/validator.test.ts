import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3CapabilityPlan, V3ContextPack, V3GeneratedDraft } from '../src/contracts';
import { validateDraft } from '../src/validator';

const capabilityPlan: V3CapabilityPlan = {
  capabilities: [],
  openQuestions: [],
  assumptions: [],
  complexity: 'simple',
};

const emptyContextPack: V3ContextPack = {
  cards: [],
  estimatedTokens: 0,
  sourceMix: { workInstructionCards: 0, backlogCards: 0 },
};

const loanerContextPack: V3ContextPack = {
  cards: [
    {
      id: 'WI-LOANER-001:wi:2',
      sourceId: 'WI-LOANER-001',
      sourceKind: 'work_instruction',
      kind: 'business_rule',
      title: 'Loaner Request Handling',
      text: 'The request must include customer eligibility, equipment availability, expected ship date, and planned return date before manager review.',
      keywords: ['loaner', 'eligibility', 'availability'],
      weight: 1.35,
      score: 1,
    },
    {
      id: 'WI-LOANER-001:wi:4',
      sourceId: 'WI-LOANER-001',
      sourceKind: 'work_instruction',
      kind: 'business_rule',
      title: 'Loaner Request Handling',
      text: 'Approved urgent loaner requests must notify the Dispatch Manager and reserve the equipment before shipment.',
      keywords: ['loaner', 'dispatch', 'reserve'],
      weight: 1.35,
      score: 1,
    },
  ],
  estimatedTokens: 80,
  sourceMix: { workInstructionCards: 2, backlogCards: 0 },
};

function draftWithAr(ar: { given: string; when: string; then: string }, confidence: V3GeneratedDraft['confidence'] = 'medium'): V3GeneratedDraft {
  return {
    features: [
      {
        id: 'feature_1',
        summary: 'Define service plan',
        businessOutcome: 'Complex service work can be planned in one place.',
        description: 'Complex service work can be planned without prescribing implementation details.',
        acceptanceRequirements: [
          {
            id: 'ar_1',
            ...ar,
            provenance: 'requirement',
            evidenceRefs: [],
          },
        ],
        provenance: 'requirement',
        evidenceRefs: [],
        assumptions: [],
        openQuestions: [],
      },
    ],
    confidence,
    blockingQuestions: [],
  };
}

test('validateDraft flags unsupported roles in acceptance requirements', () => {
  const issues = validateDraft({
    requirement: 'Create a single service plan for complex service events.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex service event is being planned',
      when: 'the Service Planner adds activities',
      then: 'the activities are reflected in the service plan.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'unsupported_role_in_ar'));
});

test('validateDraft flags system and solution-shaped acceptance requirements', () => {
  const issues = validateDraft({
    requirement: 'Create a single service plan for complex service events.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex service event is being planned',
      when: 'temporary replacement equipment is required',
      then: 'the system stores the loaner selection in a checkbox field.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'solution_language'));
});

test('validateDraft flags work-instruction details promoted beyond the requirement', () => {
  const issues = validateDraft({
    requirement: 'Create a single service plan that can include loaners for complex service events.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a service plan includes a loaner need',
      when: 'temporary replacement equipment is required',
      then: 'the loaner request captures customer eligibility, equipment availability, expected ship date, and planned return date.',
    }),
    contextPack: loanerContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'context_overreach'));
});

test('validateDraft allows work-instruction details when the requirement explicitly asks for them', () => {
  const issues = validateDraft({
    requirement: 'Allow loaner request approval with customer eligibility, equipment availability, and reservation.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a loaner request is ready for approval',
      when: 'customer eligibility and equipment availability are assessed',
      then: 'the loaner request captures customer eligibility and the need to reserve the equipment after approval.',
    }),
    contextPack: loanerContextPack,
  });

  assert.equal(issues.some((issue) => issue.code === 'context_overreach'), false);
});

test('validateDraft flags high confidence while open questions remain', () => {
  const draft = draftWithAr({
    given: 'faulty customer equipment is being serviced',
    when: 'temporary replacement equipment is required during the service event',
    then: 'the need for a loaner is captured as part of the service plan.',
  }, 'high');
  draft.features[0]?.openQuestions.push('Should loaner request approval rules apply?');

  const issues = validateDraft({
    requirement: 'Create a single service plan that can include loaners for complex service events.',
    capabilityPlan,
    draft,
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'confidence_mismatch'));
});

test('validateDraft flags vague acceptance requirements that lack concrete business facts', () => {
  const issues = validateDraft({
    requirement: 'Create a single service plan for complex service events with parts, labor, quotes, and follow-up work orders.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex service event is being planned',
      when: 'related outputs and handoffs are reviewed',
      then: 'the follow-up work remains traceable to the planned business outcome and any related follow-up work.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'vague_acceptance_requirement'));
});
