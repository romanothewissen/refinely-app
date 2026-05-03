import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveBenchmarkSignals } from '../quality-rubric';

test('deriveBenchmarkSignals captures AR depth and quality rates from normalized examples', () => {
  const signals = deriveBenchmarkSignals([
    {
      summary: 'Coordinate service contact selection',
      description: 'As a service specialist, I need to determine the right service contact so that I can coordinate the service event.',
      acceptanceRequirements: [
        'GIVEN a planned service WHEN a work order is created THEN the following logic must be used to suggest the service contact.',
        'GIVEN no matching history exists WHEN the work order is created THEN a contact must be determined manually.',
        'GIVEN the contact was already overridden manually WHEN the plan is saved THEN it must not be automatically replaced.',
        'GIVEN a contact is suggested automatically WHEN the work order is created THEN the derived result must be indicated.',
      ],
    },
    {
      summary: 'Handle urgent exception flow',
      description: 'As a specialist, I need to deviate from the normal workflow so that urgent work can still proceed.',
      acceptanceRequirements: [
        'GIVEN an urgent request WHEN the installed product is unavailable THEN work must still be able to proceed through the exception path.',
      ],
    },
  ]);

  assert.equal(signals.storyCount, 2);
  assert.equal(signals.acceptanceRequirementCount.min, 1);
  assert.equal(signals.acceptanceRequirementCount.max, 4);
  assert.equal(signals.acceptanceRequirementCount.median, 2.5);
  assert.equal(signals.acceptanceRequirementCount.distribution[4], 1);
  assert.ok(signals.rates.manualOverrideHandling > 0);
  assert.ok(signals.rates.negativeConstraints > 0);
  assert.ok(signals.rates.decisionLogic > 0);
});
