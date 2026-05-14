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

const accessContextPack: V3ContextPack = {
  cards: [
    {
      id: 'WI-ACCESS-001:wi:2',
      sourceId: 'WI-ACCESS-001',
      sourceKind: 'work_instruction',
      kind: 'business_rule',
      title: 'Vendor Access Handling',
      text: 'The request must include vendor approval, access capacity, expected start date, and planned end date before manager review.',
      keywords: ['vendor', 'approval', 'capacity'],
      weight: 1.35,
      score: 1,
    },
    {
      id: 'WI-ACCESS-001:wi:4',
      sourceId: 'WI-ACCESS-001',
      sourceKind: 'work_instruction',
      kind: 'business_rule',
      title: 'Vendor Access Handling',
      text: 'Approved vendor access requests must notify the Access Manager and reserve the access capacity before activation.',
      keywords: ['vendor', 'access', 'reserve'],
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
        summary: 'Define coordinated plan',
        businessOutcome: 'Complex work can be planned in one place.',
        description: 'Complex work can be planned without prescribing implementation details.',
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
    requirement: 'Create a coordinated launch plan for complex launch activities.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex launch is being planned',
      when: 'the Release Manager adds activities',
      then: 'the activities are reflected in the coordinated plan.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'unsupported_role_in_ar'));
});

test('validateDraft flags system and solution-shaped acceptance requirements', () => {
  const issues = validateDraft({
    requirement: 'Create a coordinated launch plan for complex launch activities.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex launch is being planned',
      when: 'vendor access is required',
      then: 'the system stores the access selection in a checkbox field.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'solution_language'));
});

test('validateDraft flags work-instruction details promoted beyond the requirement', () => {
  const issues = validateDraft({
    requirement: 'Create a coordinated launch plan that can include vendor access for complex launch activities.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a launch plan includes a vendor access need',
      when: 'external partner participation is required',
      then: 'the access request captures vendor approval, access capacity, expected start date, and planned end date.',
    }),
    contextPack: accessContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'context_overreach'));
});

test('validateDraft allows work-instruction details when the requirement explicitly asks for them', () => {
  const issues = validateDraft({
    requirement: 'Allow vendor access request approval with vendor approval, access capacity, and reservation.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a vendor access request is ready for approval',
      when: 'vendor approval and access capacity are assessed',
      then: 'the vendor access request captures vendor approval and the need to reserve capacity after approval.',
    }),
    contextPack: accessContextPack,
  });

  assert.equal(issues.some((issue) => issue.code === 'context_overreach'), false);
});

test('validateDraft flags high confidence while open questions remain', () => {
  const draft = draftWithAr({
    given: 'a launch activity requires external partner access',
    when: 'vendor participation is required during the launch',
    then: 'the need for vendor access is captured as part of the coordinated plan.',
  }, 'high');
  draft.features[0]?.openQuestions.push('Should vendor access approval rules apply?');

  const issues = validateDraft({
    requirement: 'Create a coordinated launch plan that can include vendor access for complex launch activities.',
    capabilityPlan,
    draft,
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'confidence_mismatch'));
});

test('validateDraft flags vague acceptance requirements that lack concrete business facts', () => {
  const issues = validateDraft({
    requirement: 'Create a coordinated launch plan with materials, effort estimates, approval packets, and follow-up purchase orders.',
    capabilityPlan,
    draft: draftWithAr({
      given: 'a complex launch is being planned',
      when: 'related outputs and handoffs are reviewed',
      then: 'the follow-up work remains traceable to the planned business outcome and any related follow-up work.',
    }),
    contextPack: emptyContextPack,
  });

  assert.ok(issues.some((issue) => issue.code === 'vague_acceptance_requirement'));
});
