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

test('buildGenerationStartProgressUpdate produces decomposition stage for fresh generation', () => {
  const update = buildGenerationStartProgressUpdate({
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

  assert.equal(update.message, 'Planning feature structure from gathered context…');
  assert.equal(update.payload.stage, 'decomposition');
});
