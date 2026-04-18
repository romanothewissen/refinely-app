import test from 'node:test';
import assert from 'node:assert/strict';

import { findGoldConfigForProject, resolveGoldKeys, type GoldStoryPool } from '../similar-stories';

const samplePool: GoldStoryPool = {
  projectKey: 'OPS',
  builtAt: '2026-04-18T10:00:00.000Z',
  entries: [
    {
      key: 'OPS-101',
      summary: 'Track contract activation readiness',
      score: 97,
      arSample: 'GIVEN a service contract has become active WHEN readiness is reviewed THEN the activation checklist is available.',
      labels: ['gold-example', 'contracts'],
    },
    {
      key: 'OPS-102',
      summary: 'Handle manual review for ambiguous intake',
      score: 95,
      arSample: 'GIVEN an incoming update cannot be matched confidently WHEN intake is reviewed THEN manual triage is required.',
      labels: ['triage'],
    },
  ],
};

test('findGoldConfigForProject prefers the project-specific config over wildcard', () => {
  const config = findGoldConfigForProject('OPS', [
    { projectKey: '*', label: 'default-gold' },
    { projectKey: 'OPS', label: 'ops-gold', issueKeys: ['OPS-101'] },
  ]);

  assert.deepEqual(config, { projectKey: 'OPS', label: 'ops-gold', issueKeys: ['OPS-101'] });
});

test('resolveGoldKeys prefers manual keys, then label matches, then null', () => {
  assert.deepEqual(
    resolveGoldKeys('OPS', [{ projectKey: 'OPS', issueKeys: ['OPS-999', 'OPS-101'], label: 'gold-example' }], samplePool),
    ['OPS-999', 'OPS-101'],
  );

  assert.deepEqual(
    resolveGoldKeys('OPS', [{ projectKey: 'OPS', label: 'gold-example' }], samplePool),
    ['OPS-101'],
  );

  assert.equal(
    resolveGoldKeys('OPS', [{ projectKey: 'OPS', label: 'missing-label' }], samplePool),
    null,
  );
});
