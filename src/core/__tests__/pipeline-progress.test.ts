import test from 'node:test';
import assert from 'node:assert/strict';

import { runOrderedConcurrentTasks } from '../story-generator';
import { buildGenerationStartProgressUpdate } from '../../queues/generation';

test('runOrderedConcurrentTasks preserves result order while respecting the concurrency cap', async () => {
  let active = 0;
  let maxActive = 0;
  const progressTicks: string[] = [];

  const results = await runOrderedConcurrentTasks({
    tasks: [120, 40, 80, 10].map((delayMs, index) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      return `result-${index + 1}`;
    }),
    concurrency: 3,
    onProgress: (completed, total) => {
      progressTicks.push(`${completed}/${total}`);
    },
  });

  assert.deepEqual(results, ['result-1', 'result-2', 'result-3', 'result-4']);
  assert.equal(maxActive <= 3, true);
  assert.equal(progressTicks.length, 4);
  assert.equal(progressTicks.at(-1), '4/4');
});

test('buildGenerationStartProgressUpdate seeds reviewed draft features into live generation progress', () => {
  const reviewedDraftFeatures = [
    {
      id: 'feature-1',
      summary: 'Manage incoming customer replies',
      description: 'As a Support Specialist, I need customer replies linked to the right case so that the case history stays complete.',
      acceptanceRequirements: [],
      storyPoints: 3,
    },
  ];

  const update = buildGenerationStartProgressUpdate({
    reviewedDraftFeatures,
    reviewedDraftReview: {
      unresolvedAmbiguities: [],
      featureNotes: [],
      reviewMessage: 'Looks good.',
    },
    reviewedDraftDecision: 'continue',
    advisorySizingContract: {
      shape: 'narrow',
      complexity: 'medium',
      featureTarget: 1,
      arDepth: 'standard',
      arTarget: 3,
      estimatedQuestions: 4,
    },
    sources: {
      projectKey: 'SUP',
      projectCount: 2,
      domainContextApplied: true,
    },
  });

  assert.equal(update.message, 'Continuing with the reviewed draft structure…');
  assert.equal(update.payload.stage, 'acceptance_requirements');
  assert.equal(update.payload.draftFeatureCount, 1);
  assert.deepEqual(update.payload.draftFeatures, [
    {
      id: 'feature-1',
      summary: 'Manage incoming customer replies',
      description: 'As a Support Specialist, I need customer replies linked to the right case so that the case history stays complete.',
      storyPoints: 3,
    },
  ]);
});
