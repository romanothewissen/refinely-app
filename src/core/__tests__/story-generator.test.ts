import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleteAcceptanceRequirement } from '../ar-validation';
import { buildSingleFeatureRefineSystemPrompt } from '../prompts';
import {
  AcceptanceRequirementsGenerationError,
  applySmallAskTriageGuardrails,
  assessSizingHeuristics,
  feedbackRequestsStructuralRefinement,
  findFeaturesMissingCompleteAcceptanceRequirements,
  repairAcceptanceRequirements,
} from '../story-generator';

function makeFeature(summary: string, arCount: number, description?: string) {
  return {
    id: summary.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    summary,
    description: description ?? `As a Service Manager, I need to ${summary.toLowerCase()} so that the service process stays compliant.`,
    acceptanceRequirements: Array.from({ length: arCount }, (_, index) => ({
      given: `a relevant business condition ${index + 1} exists`,
      when: 'the rule is evaluated',
      then: `the expected business outcome ${index + 1} occurs`,
    })),
  };
}

test('isCompleteAcceptanceRequirement rejects ARs with a missing then clause', () => {
  assert.equal(
    isCompleteAcceptanceRequirement({
      given: 'a standard procedure needs to be enforced',
      when: 'a Service Process Owner defines a rule',
      then: '',
    }),
    false,
  );
});

test('isCompleteAcceptanceRequirement accepts fully written ARs', () => {
  assert.equal(
    isCompleteAcceptanceRequirement({
      given: 'a standard procedure needs to be enforced',
      when: 'a Service Process Owner defines a rule',
      then: 'the rule is created and used for future work orders.',
    }),
    true,
  );
});

test('repairAcceptanceRequirements stitches fragmented clauses into a complete AR', () => {
  const repaired = repairAcceptanceRequirements([
    { given: 'a manager is viewing a dashboard with a standard layout', when: '', then: '' },
    { given: '', when: 'the manager rearranges, resizes, or hides charts and saves the changes', then: '' },
    { given: '', when: '', then: "the dashboard is displayed with the manager's personalized arrangement." },
  ]);

  assert.deepEqual(repaired, [
    {
      given: 'a manager is viewing a dashboard with a standard layout',
      when: 'the manager rearranges, resizes, or hides charts and saves the changes',
      then: "the dashboard is displayed with the manager's personalized arrangement.",
    },
  ]);
});

test('findFeaturesMissingCompleteAcceptanceRequirements flags features with missing or incomplete ARs', () => {
  const missing = findFeaturesMissingCompleteAcceptanceRequirements([
    {
      acceptanceRequirements: [
        {
          given: 'a contract is expiring',
          when: 'the completion rule is evaluated',
          then: 'the contract remains open if blocking work remains.',
        },
      ],
    },
    {
      acceptanceRequirements: [],
    },
    {
      acceptanceRequirements: [
        {
          given: 'an owner is reviewing the contract',
          when: 'a blocking work order exists',
          then: '',
        },
      ],
    },
  ]);

  assert.deepEqual(missing, [1, 2]);
});

test('AcceptanceRequirementsGenerationError preserves failing draft metadata', () => {
  const error = new AcceptanceRequirementsGenerationError(
    'Acceptance requirements could not be completed for 1 feature.',
    [
      {
        id: 'feature-1',
        summary: 'Keep contract open',
        description: 'As a coordinator, I need to keep the contract open so that downstream processing does not fail.',
        acceptanceRequirements: [],
      },
    ],
    [0],
  );

  assert.equal(error.name, 'AcceptanceRequirementsGenerationError');
  assert.deepEqual(error.failedFeatureIndexes, [0]);
  assert.equal(error.draftFeatures[0]?.id, 'feature-1');
});

test('feedbackRequestsStructuralRefinement keeps stylistic bulk feedback in per-feature mode', () => {
  assert.equal(feedbackRequestsStructuralRefinement('make these features less technical'), false);
  assert.equal(feedbackRequestsStructuralRefinement('add regulatory guardrails across all features'), false);
});

test('feedbackRequestsStructuralRefinement detects explicit backlog restructuring requests', () => {
  assert.equal(feedbackRequestsStructuralRefinement('merge overlapping features and remove duplicate features'), true);
  assert.equal(feedbackRequestsStructuralRefinement('split this into separate service case and work order features'), true);
});

test('buildSingleFeatureRefineSystemPrompt can forbid splitting during bulk refinement', () => {
  const prompt = buildSingleFeatureRefineSystemPrompt({
    domainContext: '',
    processTaxonomy: [],
    processTaxonomyEnabled: false,
    allowStructuralChanges: false,
  });

  assert.match(prompt, /Return EXACTLY ONE feature in the features array/);
  assert.match(prompt, /Do not split this feature into multiple features/);
  assert.match(prompt, /Do not invent new sibling features or move acceptance requirements into other features/);
});

test('assessSizingHeuristics flags oversized split guard-rule backlogs', () => {
  const assessment = assessSizingHeuristics({
    stage: 'final',
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    features: [
      makeFeature('Prevent Service Case creation for products past their end of service date', 7),
      makeFeature('Allow Service Case creation for products without an end of service date', 1),
      makeFeature('Exempt product decommissioning cases from the end of service date restriction', 3),
      makeFeature('Override the end-of-service block for Service Case creation with a reason', 7),
      makeFeature('Prevent Work Order creation for products past their end of service date', 8),
      makeFeature('Override the end-of-service block for Work Order creation with a reason', 4),
      makeFeature('Audit end-of-service creation attempts', 4),
    ],
  });

  assert.equal(assessment.archetype, 'guard_rule');
  assert.equal(assessment.verdict, 'oversized');
  assert.equal(assessment.confidence, 'high');
  assert.equal(assessment.featureCount, 7);
  assert.equal(assessment.acceptanceRequirementCount, 34);
  assert.match(assessment.reasonCodes.join(' '), /feature_count_far_above_preferred_range/);
});

test('assessSizingHeuristics does not falsely compress workflow-area asks', () => {
  const assessment = assessSizingHeuristics({
    stage: 'final',
    requirement: 'As a support coordinator, I need one place to manage incoming customer communications and create or update cases from them.',
    features: [
      makeFeature('Triage incoming communications', 4),
      makeFeature('Decide whether to create a new case or update an existing case', 4),
      makeFeature('Route uncertain matches for manual review', 3),
      makeFeature('Capture required information before case handling continues', 4),
      makeFeature('Handle source-specific exception paths', 4),
    ],
    triage: {
      estimatedFeatures: 5,
      estimatedQuestions: 12,
      shape: 'narrow',
      complexity: 'high',
      arDepth: 'thorough',
    },
  });

  assert.equal(assessment.archetype, 'workflow_area');
  assert.notEqual(assessment.verdict, 'oversized');
});

test('applySmallAskTriageGuardrails narrows precise guard-rule triage estimates', () => {
  const guarded = applySmallAskTriageGuardrails({
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    triage: {
      estimatedFeatures: 5,
      estimatedQuestions: 10,
      shape: 'balanced',
      complexity: 'high',
      arDepth: 'thorough',
    },
  });

  assert.equal(guarded?.estimatedFeatures, 1);
  assert.equal(guarded?.shape, 'minimal');
  assert.equal(guarded?.complexity, 'medium');
  assert.equal(guarded?.arDepth, 'standard');
});
