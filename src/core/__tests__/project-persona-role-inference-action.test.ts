import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG } from '../../types';
import { handleInferProjectPersonaRoles } from '../../resolvers/project-persona-role-inference';

test('handleInferProjectPersonaRoles rejects missing project selection before auth', async () => {
  let ensureAdminCalled = false;

  const result = await handleInferProjectPersonaRoles({}, {}, {
    ensureAdmin: async () => { ensureAdminCalled = true; },
    getConfig: async () => DEFAULT_CONFIG,
    inferProjectPersonaRolesFromBacklog: async () => {
      throw new Error('should not run');
    },
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /select a project/i);
  assert.equal(ensureAdminCalled, false);
});

test('handleInferProjectPersonaRoles enforces admin permission for the project', async () => {
  await assert.rejects(
    handleInferProjectPersonaRoles({ projectKey: 'PROJ' }, { accountId: 'abc' }, {
      ensureAdmin: async () => { throw new Error('Unauthorized'); },
      getConfig: async () => DEFAULT_CONFIG,
      inferProjectPersonaRolesFromBacklog: async () => {
        throw new Error('should not run');
      },
    }),
    /Unauthorized/,
  );
});

test('handleInferProjectPersonaRoles returns the helper payload shape on success', async () => {
  const result = await handleInferProjectPersonaRoles({ projectKey: 'PROJ' }, {}, {
    ensureAdmin: async () => {},
    getConfig: async () => DEFAULT_CONFIG,
    inferProjectPersonaRolesFromBacklog: async (projectKey) => ({
      success: true,
      suggestions: [{
        role: 'Planner',
        activities: 'Reviews inbound work and assigns visits.',
        confidence: 'medium',
        evidenceIssueKeys: ['PROJ-1'],
      }],
      sampledIssueCount: 3,
      sampledIssueKeys: ['PROJ-1', 'PROJ-2', 'PROJ-3'],
      usedCache: true,
      message: `Suggestions for ${projectKey}`,
    }),
  });

  assert.deepEqual(result, {
    success: true,
    suggestions: [{
      role: 'Planner',
      activities: 'Reviews inbound work and assigns visits.',
      confidence: 'medium',
      evidenceIssueKeys: ['PROJ-1'],
    }],
    sampledIssueCount: 3,
    sampledIssueKeys: ['PROJ-1', 'PROJ-2', 'PROJ-3'],
    usedCache: true,
    message: 'Suggestions for PROJ',
  });
});
