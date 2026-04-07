import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_ROLE_INFERENCE_CORPUS_CHARS,
  MAX_ROLE_INFERENCE_DOCS,
  normalizeRoleInferenceSuggestions,
  sampleBacklogDocsForRoleInference,
  selectRoleInferenceShardIds,
} from '../persona-role-inference';

function makeDoc(index: number, suffix = '') {
  return {
    key: `PROJ-${index}`,
    summary: `Summary ${index} ${suffix}`.trim(),
    description: `Description for backlog item ${index} ${suffix}`.trim(),
    acceptanceCriteria: `Acceptance criteria ${index} ${suffix}`.trim(),
    updated: `2026-04-${String((index % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
  };
}

test('selectRoleInferenceShardIds prefers top themes before falling back to even spacing', () => {
  const shardIds = selectRoleInferenceShardIds({
    manifest: {
      projectKey: 'PROJ',
      issueCount: 90,
      shards: [
        { shardId: '0001' },
        { shardId: '0002' },
        { shardId: '0003' },
        { shardId: '0004' },
        { shardId: '0005' },
        { shardId: '0006' },
      ],
    },
    themeIndex: {
      themes: [
        {
          label: 'Dispatch',
          docCount: 22,
          shardIds: ['0003', '0004'],
          sampleIssueKeys: ['PROJ-3'],
          keywords: ['dispatch'],
          signatureTerms: ['schedule'],
        },
        {
          label: 'Mobile workflow',
          docCount: 18,
          shardIds: ['0005', '0001'],
          sampleIssueKeys: ['PROJ-5'],
          keywords: ['mobile'],
          signatureTerms: ['field'],
        },
      ],
    },
    maxShards: 4,
  });

  assert.deepEqual(shardIds, ['0003', '0005', '0004', '0001']);
});

test('sampleBacklogDocsForRoleInference uses theme samples for diversity before fallback docs', () => {
  const docs = {
    '0001': [makeDoc(1, 'field engineer route'), makeDoc(2, 'field engineer schedule')],
    '0002': [makeDoc(3, 'planner dispatch board'), makeDoc(4, 'planner assignment queue')],
  };

  const sample = sampleBacklogDocsForRoleInference({
    themeIndex: {
      themes: [
        {
          label: 'Field engineer workflow',
          docCount: 12,
          shardIds: ['0001'],
          sampleIssueKeys: ['PROJ-1'],
          keywords: ['engineer'],
          signatureTerms: ['route'],
        },
        {
          label: 'Planning workflow',
          docCount: 9,
          shardIds: ['0002'],
          sampleIssueKeys: ['PROJ-3'],
          keywords: ['planner'],
          signatureTerms: ['dispatch'],
        },
      ],
    },
    shardDocs: docs,
  });

  assert.equal(sample.docs[0]?.key, 'PROJ-1');
  assert.equal(sample.docs[1]?.key, 'PROJ-3');
  assert.ok(sample.docs.some((doc) => doc.key === 'PROJ-2'));
  assert.ok(sample.docs.some((doc) => doc.key === 'PROJ-4'));
});

test('sampleBacklogDocsForRoleInference respects corpus and document caps', () => {
  const longText = 'x'.repeat(3000);
  const sample = sampleBacklogDocsForRoleInference({
    legacy: {
      docs: Array.from({ length: 20 }, (_, index) => ({
        ...makeDoc(index + 1),
        description: `${longText} ${index}`,
        acceptanceCriteria: `${longText} ${index}`,
      })),
    },
  });

  assert.ok(sample.docs.length <= MAX_ROLE_INFERENCE_DOCS);
  assert.ok(sample.corpus.length <= MAX_ROLE_INFERENCE_CORPUS_CHARS);
  assert.ok(sample.docs.length >= 1);
});

test('sampleBacklogDocsForRoleInference falls back cleanly to evenly spaced legacy docs', () => {
  const sample = sampleBacklogDocsForRoleInference({
    legacy: {
      docs: Array.from({ length: 10 }, (_, index) => makeDoc(index + 1)),
    },
  }, { maxDocs: 4 });

  assert.deepEqual(sample.docs.map((doc) => doc.key), ['PROJ-10', 'PROJ-7', 'PROJ-4', 'PROJ-1']);
});

test('normalizeRoleInferenceSuggestions removes generic junk and merges duplicate roles', () => {
  const suggestions = normalizeRoleInferenceSuggestions([
    {
      role: ' Field Service Engineer ',
      activities: 'Reviews assigned visits and confirms job completion.',
      confidence: 'medium',
      evidenceIssueKeys: ['PROJ-1', 'PROJ-2'],
    },
    {
      role: 'field service engineer',
      activities: 'Reviews assigned visits, updates status from mobile, and confirms completion with notes.',
      confidence: 'high',
      evidenceIssueKeys: ['PROJ-2', 'PROJ-3', 'PROJ-4'],
    },
    {
      role: 'User',
      activities: 'Does things.',
      confidence: 'high',
      evidenceIssueKeys: ['PROJ-1'],
    },
    {
      role: '',
      activities: 'Missing role',
      confidence: 'low',
      evidenceIssueKeys: ['PROJ-1'],
    },
  ], ['PROJ-1', 'PROJ-2', 'PROJ-3']);

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].role, 'Field Service Engineer');
  assert.equal(suggestions[0].confidence, 'high');
  assert.match(suggestions[0].activities, /mobile/i);
  assert.deepEqual(suggestions[0].evidenceIssueKeys, ['PROJ-1', 'PROJ-2', 'PROJ-3']);
});
