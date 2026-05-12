import assert from 'node:assert/strict';
import test from 'node:test';
import { compileContext } from '../src/context/compiler';
import { retrieveContextPack } from '../src/context/retrieval';
import type { V3BacklogExample, V3WorkInstruction } from '../src/contracts';
import { runV3Pipeline } from '../src/pipeline';

const workInstructions: V3WorkInstruction[] = [
  {
    id: 'WI-1',
    title: 'Loaner Request Handling',
    text: 'Service Planners may submit loaner requests when temporary equipment is needed. The request must include customer eligibility and planned return date before manager review. If equipment is unavailable, the request must be rejected with a clear reason.',
  },
];

const backlogExamples: V3BacklogExample[] = [
  {
    key: 'LOAN-1',
    summary: 'Manage loaner equipment reservation',
    description: 'As a Dispatch Manager, I need approved loaner requests to reserve equipment so that inventory is not double-booked.',
    acceptanceRequirements: [
      {
        given: 'a loaner request has been approved',
        when: 'available equipment is selected',
        then: 'the equipment is reserved for that customer',
      },
    ],
  },
];

test('compileContext turns work instructions and backlog into compact grounding cards', () => {
  const cards = compileContext({ workInstructions, backlogExamples });
  assert.ok(cards.some((card) => card.sourceKind === 'work_instruction' && card.kind === 'business_rule'));
  assert.ok(cards.some((card) => card.sourceKind === 'backlog_example' && card.kind === 'similar_story'));
  assert.ok(cards.every((card) => card.keywords.length > 0));
});

test('retrieveContextPack keeps a mixed work-instruction and backlog context pack', () => {
  const cards = compileContext({ workInstructions, backlogExamples });
  const pack = retrieveContextPack({
    requirement: 'Allow service planners to submit loaner requests for manager review.',
    cards,
  });

  assert.ok(pack.sourceMix.workInstructionCards >= 1);
  assert.ok(pack.sourceMix.backlogCards >= 1);
  assert.ok(pack.estimatedTokens < 900);
});

test('project context and document chunks compile and retrieve as first-class grounding', () => {
  const cards = compileContext({
    workInstructions: [],
    backlogExamples: [],
    projectContext: [
      {
        id: 'jira-statuses-proc',
        title: 'Jira workflow statuses',
        projectKey: 'PROC',
        kind: 'status',
        text: 'Intake, Needs Review, Approved, Released, Done',
      },
    ],
    documents: [
      {
        id: 'policy-approval-1',
        sourceId: 'DOC-PROC',
        title: 'Procurement Policy',
        section: 'Approvals',
        text: 'Procurement requests above the threshold must capture budget owner approval before order release.',
      },
      {
        id: 'travel-policy-1',
        sourceId: 'DOC-TRAVEL',
        title: 'Travel Policy',
        text: 'Travel requests must include destination and preferred hotel details.',
      },
    ],
  });

  const pack = retrieveContextPack({
    requirement: 'Allow requesters to submit procurement requests that require budget owner approval before order release and status tracking.',
    cards,
    maxCards: 2,
  });

  assert.ok(pack.sourceMix.projectContextCards && pack.sourceMix.projectContextCards >= 1);
  assert.ok(pack.sourceMix.documentCards && pack.sourceMix.documentCards >= 1);
  assert.ok(pack.cards.some((card) => card.sourceKind === 'document' && card.sourceId === 'DOC-PROC'));
  assert.ok(!pack.cards.some((card) => card.sourceKind === 'document' && card.sourceId === 'DOC-TRAVEL'));
});

test('runV3Pipeline produces grounded business features with Gherkin acceptance requirements', async () => {
  const result = await runV3Pipeline({
    requirement: 'Allow service planners to submit loaner requests for manager review while handling unavailable equipment.',
    workInstructions,
    backlogExamples,
  });

  assert.equal(result.validation.passed, true);
  assert.ok(result.draft.features.length >= 1);
  const feature = result.draft.features[0];
  assert.ok(feature);
  assert.match(feature.description, /^As a /);
  assert.ok(feature.evidenceRefs.some((ref) => ref.sourceId === 'WI-1'));
  assert.ok(feature.evidenceRefs.some((ref) => ref.sourceId === 'LOAN-1'));
  const acceptanceRequirements = result.draft.features.flatMap((item) => item.acceptanceRequirements);
  assert.ok(acceptanceRequirements.length >= 2);
  assert.ok(acceptanceRequirements.every((ar) => ar.given && ar.when && ar.then));
});

test('runV3Pipeline uses project and document context without requiring service-domain fixtures', async () => {
  const result = await runV3Pipeline({
    requirement: 'Allow requesters to submit procurement requests that require budget owner approval before order release and show approval status.',
    workInstructions: [],
    backlogExamples: [],
    projectContext: [
      {
        id: 'jira-statuses-proc',
        title: 'Jira workflow statuses',
        projectKey: 'PROC',
        kind: 'status',
        text: 'Intake, Needs Review, Approved, Released, Done',
      },
    ],
    documents: [
      {
        id: 'policy-approval-1',
        sourceId: 'DOC-PROC',
        title: 'Procurement Policy',
        section: 'Approvals',
        text: 'Procurement requests above the threshold must capture budget owner approval before order release.',
      },
    ],
  });

  assert.equal(result.validation.passed, true);
  const refs = result.draft.features.flatMap((feature) => [
    ...feature.evidenceRefs,
    ...feature.acceptanceRequirements.flatMap((ar) => ar.evidenceRefs ?? []),
  ]);
  assert.ok(refs.some((ref) => ref.sourceId.includes('jira-statuses-proc')));
  assert.ok(refs.some((ref) => ref.sourceId === 'DOC-PROC'));
});
