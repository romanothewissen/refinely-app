import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildV2CompletionEvent,
  buildV2ProgressEvent,
  MAX_V2_PROGRESS_DRAFT_FEATURES,
  shapeV2ProgressDraftFeatures,
} from '../progress';

test('shapeV2ProgressDraftFeatures caps entries and trims summaries', () => {
  const features = Array.from({ length: MAX_V2_PROGRESS_DRAFT_FEATURES + 2 }, (_, index) => ({
    id: `feature_${index + 1}`,
    summary: `Feature ${index + 1} ${'x'.repeat(180)}`,
  }));

  const shaped = shapeV2ProgressDraftFeatures(features);

  assert.equal(shaped.length, MAX_V2_PROGRESS_DRAFT_FEATURES);
  assert.ok(shaped.every((feature) => feature.summary.length <= 140));
});

test('buildV2ProgressEvent keeps only compact draft summaries', () => {
  const event = buildV2ProgressEvent('session_123', {
    stage: 'final_generation',
    message: 'Drafting backlog features with detailed acceptance requirements attached to each item.',
    draftFeatures: [
      {
        id: 'feature_1',
        summary: 'Coordinate service planning with a very long summary that should be compacted before it reaches KVS storage because the progress payload should stay deliberately small for ephemeral polling state.',
      },
    ],
    featureCounts: { drafted: 12 },
  });

  assert.equal(event.type, 'progress');
  assert.equal(event.draftFeatures?.length, 1);
  assert.ok((event.draftFeatures?.[0]?.summary.length ?? 0) <= 140);
  assert.deepEqual(event.featureCounts, { drafted: 12 });
  assert.doesNotMatch(JSON.stringify(event), /acceptanceRequirements|description|promptUsage/);
});

test('buildV2CompletionEvent stores only the compact completion marker', () => {
  const event = buildV2CompletionEvent('session_456', 'complete');

  assert.deepEqual(Object.keys(event).sort(), ['resultStatus', 'sessionId', 'type', 'updatedAt']);
  assert.equal(event.resultStatus, 'complete');
  assert.doesNotMatch(JSON.stringify(event), /features|scopeHypothesis|promptUsage/);
});
