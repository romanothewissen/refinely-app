import assert from 'node:assert/strict';
import test from 'node:test';
import { __testV3PreviewAdapter } from '../../services/v3-preview';

test('v3 preview adapter maps Jira project facts, docs, and backlog examples into V3 inputs', () => {
  const projectContext = __testV3PreviewAdapter.buildJiraProjectContext({
    projectKeys: ['PROC'],
    jiraData: {
      projects: [{ id: '100', key: 'PROC', name: 'Procurement', projectTypeKey: 'business' }],
      issueTypes: [{ id: '1', name: 'Request', description: 'Procurement request' }],
      statuses: [{ id: '10', name: 'Approved', statusCategory: { name: 'Done' } }],
    },
    domainContext: 'Budget owner approval is required before order release.',
    personaRoles: [{ role: 'Requester', activities: 'Submits procurement requests' }] as any,
  });

  assert.ok(projectContext.some((card) => card.kind === 'status' && /Approved/.test(card.text)));
  assert.ok(projectContext.some((card) => card.kind === 'role' && /Requester/.test(card.text)));
  assert.ok(projectContext.some((card) => card.kind === 'project_convention' && /Budget owner/.test(card.text)));

  const documents = __testV3PreviewAdapter.mapDocumentChunks([{
    docId: 'DOC-PROC',
    filename: 'procurement.md',
    revision: '1',
    chunkIndex: 0,
    text: 'Requests above the threshold must capture budget owner approval before order release.',
    tokenCount: 12,
    facets: [{ kind: 'rule', value: 'budget owner approval' }],
  }], 'PROC');

  assert.equal(documents[0]?.sourceId, 'DOC-PROC');
  assert.equal(documents[0]?.kind, 'business_rule');

  const backlogExamples = __testV3PreviewAdapter.mapSimilarStories([{
    key: 'PROC-12',
    summary: 'Approve procurement request',
    description: 'Approval pattern',
    acceptanceCriteria: 'GIVEN a procurement request WHEN budget approval is recorded THEN the order can be released',
  }]);

  assert.equal(backlogExamples[0]?.key, 'PROC-12');
  assert.match(backlogExamples[0]?.acceptanceRequirements[0]?.then ?? '', /order can be released/i);
});
