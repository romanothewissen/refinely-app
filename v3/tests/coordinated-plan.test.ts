import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3ProjectDocument } from '../src/contracts';
import { HeuristicPlanner } from '../src/planner';
import { runV3Pipeline } from '../src/pipeline';

const coordinatedPlanRequirement = 'Create a coordinated launch plan that can include research tasks, vendor reviews, prototype builds, training sessions, materials, effort estimates, approval packets, and follow-up purchase orders or onboarding tasks. The plan should coordinate the activities, resources, dependencies, output packets, and downstream handoffs from one place.';
const unrelatedDomainTerms = /insurance claim|restaurant booking|warehouse slotting|crop rotation|lab sample/i;

test('coordinated plan sizing stays domain-agnostic and non-rigid', async () => {
  const plan = await new HeuristicPlanner().plan({
    requirement: coordinatedPlanRequirement,
  });
  const labels = plan.capabilities.map((capability) => capability.label).join('\n');
  const sizingCandidateText = plan.sizingAssessment?.candidateCapabilities
    .map((candidate) => `${candidate.label} ${candidate.splitRationale} ${candidate.mergeRisk}`)
    .join('\n') ?? '';

  assert.equal(plan.complexity, 'complex');
  assert.ok(plan.sizingAssessment);
  assert.ok(plan.sizingAssessment.recommendedFeatureRange.min <= plan.capabilities.length);
  assert.ok(plan.sizingAssessment.recommendedFeatureRange.max >= plan.capabilities.length);
  assert.match(labels, /coordinated plan/i);
  assert.match(labels, /activity|scope/i);
  assert.match(labels, /resources|effort/i);
  assert.match(labels, /approval|decision/i);
  assert.match(labels, /output|estimate/i);
  assert.match(labels, /downstream|handoff|records/i);
  assert.match(sizingCandidateText, /Assess vendor reviews as a distinct capability/i);
  assert.doesNotMatch(`${labels}\n${sizingCandidateText}`, unrelatedDomainTerms);
});

test('coordinated plan generation uses source terms without importing domain examples', async () => {
  const result = await runV3Pipeline({
    requirement: coordinatedPlanRequirement,
    workInstructions: [],
    backlogExamples: [],
  });
  const acceptanceText = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');
  const openQuestionText = result.draft.blockingQuestions.join('\n');

  assert.equal(result.validation.passed, true);
  assert.ok(result.draft.features.every((feature) => /^As a .+?, I need to .+ so that .+\.$/.test(feature.description)));
  assert.ok(result.draft.features.every((feature) => feature.acceptanceRequirements.length >= 1));
  assert.ok(result.draft.features.reduce((sum, feature) => sum + feature.acceptanceRequirements.length, 0) / result.draft.features.length >= 2);
  assert.match(acceptanceText, /research tasks|vendor reviews|prototype builds|training sessions/i);
  assert.match(acceptanceText, /materials|effort estimates/i);
  assert.match(acceptanceText, /purchase orders|onboarding tasks|downstream records|handoffs/i);
  assert.match(acceptanceText, /not ready|sequence|dependency|prerequisite/i);
  assert.doesNotMatch(acceptanceText, unrelatedDomainTerms);
  assert.match(openQuestionText, /separate capabilities/i);
  assert.match(openQuestionText, /sequence, dependency, and readiness rules/i);
});

test('document context remains adjacent unless it directly supports the generic ask', async () => {
  const documents: V3ProjectDocument[] = [
    {
      id: 'launch-governance',
      sourceId: 'DOC-LAUNCH',
      title: 'Launch governance',
      text: 'After a launch plan is approved, purchase order creation steps can begin. Approval packet review is handled by Finance Analysts. Completed training attendance records are checked before onboarding tasks are closed.',
      kind: 'workflow_step',
    },
    {
      id: 'vendor-checklist',
      sourceId: 'DOC-VENDOR',
      title: 'Vendor review checklist',
      text: 'Vendor reviews may require legal review, security review, and a final sourcing decision before procurement handoff.',
      kind: 'business_rule',
    },
  ];

  const result = await runV3Pipeline({
    requirement: coordinatedPlanRequirement,
    workInstructions: [],
    backlogExamples: [],
    documents,
    maxContextCards: 8,
  });
  const acceptanceText = result.draft.features
    .flatMap((feature) => feature.acceptanceRequirements)
    .map((ar) => `${ar.given} ${ar.when} ${ar.then}`)
    .join('\n');
  const openQuestionText = result.draft.blockingQuestions.join('\n');

  assert.equal(result.validation.passed, true);
  assert.equal(result.validation.issues.some((issue) => issue.code === 'context_overreach'), false);
  assert.doesNotMatch(acceptanceText, unrelatedDomainTerms);
  assert.doesNotMatch(acceptanceText, /legal review|security review|sourcing decision/i);
  assert.match(openQuestionText, /retrieved document workflow details/i);
  assert.ok(result.draft.features.length <= 8);
  assert.equal(new Set(result.draft.blockingQuestions).size, result.draft.blockingQuestions.length);
});

test('context roles can guide personas without domain-specific defaults', async () => {
  const documents: V3ProjectDocument[] = [
    {
      id: 'program-context',
      title: 'Launch planning ownership',
      text: 'Launch planning activities are the responsibility of the Program Coordinator. Program Coordinators coordinate tasks, dependencies, and onboarding handoffs.',
      kind: 'business_rule',
    },
    {
      id: 'finance-context',
      title: 'Launch financial ownership',
      text: 'Approval packet and estimate review is the responsibility of Finance Analysts before downstream purchase orders are released.',
      kind: 'role',
    },
  ];

  const result = await runV3Pipeline({
    requirement: coordinatedPlanRequirement,
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
  assert.match(descriptions, /As a Program Coordinator/i);
  assert.match(descriptions, /As a Finance Analyst/i);
  assert.doesNotMatch(descriptions, /As a As /i);
  assert.notEqual(new Set(arCounts).size, 1);
  assert.ok(arCounts.some((count) => count >= 3));
  assert.ok(arCounts.some((count) => count === 2));
  assert.doesNotMatch(acceptanceText, unrelatedDomainTerms);
  assert.doesNotMatch(acceptanceText, /business capability from the source requirement|primary behavior/i);
});
