import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadProjectMemoryRuntimeContext,
  ProjectMemoryRuntimeUnavailableError,
} from '../../services/project-memory-runtime';

test('loadProjectMemoryRuntimeContext returns empty memory only when no project is selected', async () => {
  const result = await loadProjectMemoryRuntimeContext({
    projectKeys: [],
    memoryStage: 'discover',
  });

  assert.deepEqual(result.memoryHeader, {
    roles: [],
    businessObjects: [],
    workflowCues: [],
    arStyleHint: '',
    freshness: 'missing',
    builtAt: null,
  });
  assert.equal(result.memoryStatus, 'missing');
  assert.equal(result.memorySelection, null);
  assert.equal(result.memoryArtifactVersion, undefined);
});

test('loadProjectMemoryRuntimeContext fails clearly when project memory loading fails for a selected project', async () => {
  const warnings: Array<{ message: string; detail: string }> = [];
  await assert.rejects(
    () => loadProjectMemoryRuntimeContext({
      projectKeys: ['OPS'],
      memoryStage: 'discover',
      loadHeader: async () => {
        throw new Error('missing SQL table');
      },
      loadSelection: async () => ({
        artifactVersion: 'artifact-1',
        roles: ['dispatcher'],
      }),
      queueRefresh: async () => undefined,
      logWarning: (message, detail) => {
        warnings.push({ message, detail });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProjectMemoryRuntimeUnavailableError);
      assert.match(String((error as Error).message), /refresh project memory in settings/i);
      assert.match(String((error as Error).message), /missing SQL table/i);
      return true;
    },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]?.message ?? '', /required for this run/i);
  assert.match(warnings[0]?.detail ?? '', /missing SQL table/i);
});

test('loadProjectMemoryRuntimeContext queues a background refresh without blocking the run result', async () => {
  let queueAttempted = false;
  const result = await loadProjectMemoryRuntimeContext({
    projectKeys: ['OPS'],
    memoryStage: 'discover',
    loadHeader: async () => ({
      header: {
        roles: ['dispatcher'],
        businessObjects: ['shipment request'],
        workflowCues: ['approval routing'],
        arStyleHint: 'Use concrete workflow checkpoints.',
        freshness: 'stale',
        builtAt: '2026-05-04T09:00:00.000Z',
      },
      status: 'stale',
      artifactVersion: 'artifact-2',
      details: [],
    }),
    loadSelection: async () => ({
      artifactVersion: 'artifact-2',
      roles: ['dispatcher'],
    }),
    queueRefresh: async () => {
      queueAttempted = true;
    },
  });

  assert.equal(queueAttempted, true);
  assert.equal(result.memoryStatus, 'stale');
  assert.equal(result.memoryArtifactVersion, 'artifact-2');
  assert.deepEqual(result.memorySelection, {
    artifactVersion: 'artifact-2',
    roles: ['dispatcher'],
  });
});
