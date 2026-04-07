import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleteAcceptanceRequirement } from '../ar-validation';
import {
  AcceptanceRequirementsGenerationError,
  findFeaturesMissingCompleteAcceptanceRequirements,
  repairAcceptanceRequirements,
} from '../story-generator';

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
