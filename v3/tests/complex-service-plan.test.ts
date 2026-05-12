import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3BacklogExample, V3ProjectDocument, V3WorkInstruction } from '../src/contracts';
import { HeuristicPlanner } from '../src/planner';
import { runV3Pipeline } from '../src/pipeline';
import backlogExamplesFixture from '../fixtures/backlog-examples.json';
import workInstructionsFixture from '../fixtures/work-instructions.json';

const complexServicePlanRequirement = 'We need to be able to facilitate complex services that include field service activities, in-house service, loaners, deinstallations and installations, all through a single plan. The plan is to plan the activities, the parts, the labor, and to be able to eventually quote from that plan and then from the plan all the follow-up actions are created like parts orders/shipments, work orders etc.';
const workInstructions = workInstructionsFixture as V3WorkInstruction[];
const backlogExamples = backlogExamplesFixture as V3BacklogExample[];

test('complex service planning requirements preserve the core business capability shape', async () => {
  const plan = await new HeuristicPlanner().plan({
    requirement: complexServicePlanRequirement,
  });
  const labels = plan.capabilities.map((capability) => capability.label).join('\n');

  assert.equal(plan.complexity, 'complex');
  assert.ok(plan.capabilities.length >= 6);
  assert.match(labels, /multi-activity service plan/i);
  assert.match(labels, /resources/i);
  assert.match(labels, /dependencies/i);
  assert.match(labels, /logical.*sequence|sequence.*validation/i);
  assert.match(labels, /quote/i);
  assert.match(labels, /follow-on transactions/i);
  assert.match(labels, /status/i);
});

test('complex service planning captures loaner need without importing loaner request workflow details', async () => {
  const result = await runV3Pipeline({
    requirement: complexServicePlanRequirement,
    workInstructions,
    backlogExamples,
  });
  const acceptanceText = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');
  const openQuestionText = result.draft.features.flatMap((feature) => feature.openQuestions).join('\n');

  assert.equal(result.validation.passed, true);
  assert.ok(result.draft.features.every((feature) => /^As a .+?, I need to .+ so that .+\.$/.test(feature.description)));
  assert.ok(result.draft.features.every((feature) => feature.acceptanceRequirements.length >= 1));
  assert.ok(result.draft.features.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0) / result.draft.features.length >= 2);
  assert.match(acceptanceText, /de-installation, loaner installation, in-house repair, loaner de-installation, and repaired equipment installation/i);
  assert.match(acceptanceText, /de-installation, off-site repair, and re-installation without requiring loaner/i);
  assert.doesNotMatch(acceptanceText, /customer eligibility|equipment availability|expected ship date|planned return date|Dispatch Manager|reserve the equipment|rejected/i);
  assert.match(openQuestionText, /Loaner Request Handling/i);
  assert.match(openQuestionText, /existing workflow/i);
});

test('complex service planning emits JSA-like concrete scenarios without unsupported scope', async () => {
  const result = await runV3Pipeline({
    requirement: complexServicePlanRequirement,
    workInstructions,
    backlogExamples,
  });
  const acceptanceText = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');
  const openQuestionText = [
    ...result.draft.blockingQuestions,
    ...result.draft.features.flatMap((feature) => feature.openQuestions),
  ].join('\n');

  assert.equal(result.validation.passed, true);
  assert.match(acceptanceText, /customer site and .*service facility/i);
  assert.match(acceptanceText, /repair parts .*service facility.*loaner equipment .*customer/i);
  assert.match(acceptanceText, /not available for scheduling or execution/i);
  assert.match(acceptanceText, /illogical sequence|sequence conflict/i);
  assert.match(acceptanceText, /distinct line items/i);
  assert.match(acceptanceText, /work orders?.*parts orders?.*shipments/i);
  assert.match(acceptanceText, /Not Started, In Progress, Completed/i);
  assert.doesNotMatch(acceptanceText, /payment authorization|return authorization|preventive maintenance|active multi-activity service plan/i);
  assert.match(openQuestionText, /payment authorization/i);
  assert.match(openQuestionText, /return authorization/i);
  assert.match(openQuestionText, /preventive maintenance/i);
  assert.match(openQuestionText, /active multi-activity service plan/i);
});

test('complex service planning uses project roles and varies acceptance depth dynamically', async () => {
  const documents: V3ProjectDocument[] = [
    {
      id: 'install-context',
      title: 'Installation planning guide',
      text: 'All activities in this section are the responsibility of the Service Support Specialist or equivalent. It is a best practice to host a planning meeting between reps from the Division, CETS Service Support, Non-FSEs as applicable, and the field service manager for complex installations.',
      kind: 'business_rule',
    },
    {
      id: 'quote-context',
      title: 'Plan and quote ownership',
      text: 'Initial Quote creation from GSMS plan is the responsibility of case owners. Service Sales will follow up by review of a Quote creation dashboard or receiving a GSMS task to proceed with the created quote.',
      kind: 'role',
    },
  ];

  const result = await runV3Pipeline({
    requirement: complexServicePlanRequirement,
    workInstructions: [],
    backlogExamples: [],
    documents,
    maxContextCards: 8,
  });

  const descriptions = result.draft.features.map((feature) => feature.description).join('\n');
  const arCounts = result.draft.features.map((feature) => feature.acceptanceRequirements.length);
  const acceptanceText = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');

  assert.equal(result.validation.passed, true);
  assert.match(descriptions, /As a Service Support Specialist/i);
  assert.match(descriptions, /As a Case Owner|As a Service Sales/i);
  assert.notEqual(new Set(arCounts).size, 1);
  assert.ok(arCounts.some((count) => count >= 3));
  assert.ok(arCounts.some((count) => count === 2));
  assert.doesNotMatch(acceptanceText, /business capability from the source requirement|primary behavior/i);
});
