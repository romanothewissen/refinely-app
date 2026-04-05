import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleteAcceptanceRequirement } from '../ar-validation';
import { repairAcceptanceRequirements } from '../story-generator';

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
