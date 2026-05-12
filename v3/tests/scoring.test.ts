import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3PipelineResult } from '../src/contracts';
import { scoreV3Result, type V3JsaBenchmark } from '../src/scoring';
import benchmarksFixture from '../fixtures/jsa-benchmarks.json';

const benchmarks = benchmarksFixture as V3JsaBenchmark[];
const servicePlanBenchmark = benchmarks.find((benchmark) => benchmark.id === 'complex-service-plan-jsa')!;
const supportTriageBenchmark = benchmarks.find((benchmark) => benchmark.id === 'support-triage-jsa')!;

const baseResult: V3PipelineResult = {
  requirement: 'Create a single service plan for field service, in-house service, loaners, deinstallations, installations, parts, labor, quotes, and follow-up work orders.',
  capabilityPlan: {
    capabilities: [],
    openQuestions: [],
    assumptions: [],
    complexity: 'complex',
  },
  draft: {
    features: [
      {
        summary: 'Define Multi-Activity Service Plan',
        businessOutcome: 'A structured plan encompassing various service types is established.',
        description: 'As a Service Planner, I need to define a multi-activity service plan so that I can manage complex service work.',
        acceptanceRequirements: [
          {
            given: 'I am creating a new service plan',
            when: 'I specify multiple service activities',
            then: 'A new service plan is created, associating all specified activities under it.',
          },
          {
            given: 'a service activity is being added',
            when: 'the planner enters activity details',
            then: 'the plan captures service type, target location, required parts, quantities, labor role, estimated hours, and dependency status for that activity.',
          },
          {
            given: 'the service plan contains dependent activities',
            when: 'the planner initiates execution',
            then: 'a work order is generated for each eligible activity and blocked until prerequisite activity dependencies are complete.',
          },
        ],
        provenance: 'requirement',
        evidenceRefs: [],
        assumptions: [],
        openQuestions: [],
      },
    ],
    confidence: 'medium',
    blockingQuestions: [],
  },
  contextPack: {
    cards: [],
    estimatedTokens: 0,
    sourceMix: { workInstructionCards: 0, backlogCards: 0 },
  },
  validation: {
    passed: true,
    issues: [],
  },
  diagnostics: {
    compiledCards: 0,
    contextCardsUsed: 0,
    estimatedContextTokens: 0,
    planner: 'test',
    generator: 'test',
  },
};

test('scoreV3Result penalizes thin THEN statements and avoids false status coverage', () => {
  const score = scoreV3Result(baseResult);
  const outcomeSpecificity = score.dimensions.find((dimension) => dimension.id === 'acceptance_specificity');
  const statusCoverage = score.expectedCapabilityCoverage.find((coverage) => coverage.id === 'status');

  assert.ok((outcomeSpecificity?.score ?? 0) > 0);
  assert.ok((outcomeSpecificity?.score ?? 100) < 100);
  assert.equal(statusCoverage, undefined);
});

test('scoreV3Result counts JSA-style features from persona stories instead of row numbers', () => {
  const jsaText = [
    '1',
    'Define a multi-activity service plan',
    '7.2.1',
    '13',
    'As a Service Support Specialist, I need to build a single service plan so that I can manage a complex event.',
    'GIVEN a service case requires off-site repair WHEN a plan is created THEN the plan can contain distinct activities.',
    '2',
    'Generate a consolidated quote',
    '7.1.4',
    '8',
    'As a Billing Specialist, I need to generate a single quote so that the customer receives a complete estimate.',
    'GIVEN a plan contains billable activities WHEN a quote is generated THEN the quote includes line items.',
  ].join('\n');

  const score = scoreV3Result(baseResult, jsaText);

  assert.equal(score.jsaComparison?.featureCount, 2);
  assert.equal(score.jsaComparison?.acceptanceRequirementCount, 2);
});

test('scoreV3Result penalizes requirement overreach even when coverage and shape look strong', () => {
  const result: V3PipelineResult = {
    ...baseResult,
    draft: {
      features: makeScoringFeatures([
        'the service plan reflects activity type, parts, labor, sequence, dependency, quote, work order, shipment, and status.',
        'the loaner request captures customer eligibility, equipment availability, expected ship date, and planned return date.',
      ], [
        'all details are available.',
        'the system stores the planner selection.',
      ]),
      confidence: 'high',
      blockingQuestions: [],
    },
    contextPack: {
      cards: [
        {
          id: 'WI-LOANER-001:wi:2',
          sourceId: 'WI-LOANER-001',
          sourceKind: 'work_instruction',
          kind: 'business_rule',
          title: 'Loaner Request Handling',
          text: 'The request must include customer eligibility, equipment availability, expected ship date, and planned return date before manager review.',
          keywords: ['loaner', 'eligibility'],
          weight: 1.35,
          score: 1,
        },
      ],
      estimatedTokens: 60,
      sourceMix: { workInstructionCards: 1, backlogCards: 0 },
    },
    validation: {
      passed: false,
      issues: [
        { code: 'unsupported_role_in_ar', path: '$.features[0].acceptanceRequirements[0]', message: 'Role overreach.' },
        { code: 'unsupported_role_in_ar', path: '$.features[0].acceptanceRequirements[1]', message: 'Role overreach.' },
        { code: 'solution_language', path: '$.features[0].acceptanceRequirements[2]', message: 'Solution language.' },
        { code: 'solution_language', path: '$.features[1].acceptanceRequirements[2]', message: 'Solution language.' },
        { code: 'context_overreach', path: '$.features[0].acceptanceRequirements[1]', message: 'Context overreach.' },
        { code: 'context_overreach', path: '$.features[1].acceptanceRequirements[1]', message: 'Context overreach.' },
        { code: 'confidence_mismatch', path: '$.confidence', message: 'Confidence mismatch.' },
      ],
    },
  };

  const score = scoreV3Result(result, undefined, servicePlanBenchmark);
  const grounding = score.dimensions.find((dimension) => dimension.id === 'grounding');

  assert.ok(score.overall <= 62);
  assert.equal(grounding?.score, 55);
  assert.ok(score.jsaComparison?.prohibitedTermsFound.includes('customer eligibility'));
  assert.ok(score.qualityWarnings.some((warning) => /context overreach/i.test(warning)));
});

test('scoreV3Result rewards capability-focused loaner scope over workflow expansion', () => {
  const focused: V3PipelineResult = {
    ...baseResult,
    draft: {
      features: makeScoringFeatures([
        'the need for a loaner is captured as part of the service plan.',
        'the service plan reflects activity type, parts, labor, sequence, dependency, quote, work order, shipment, and status.',
      ], [
        'billable parts and labor are reflected in a consolidated service quote.',
      ], ['Should loaner request workflow details be handled separately?']),
      confidence: 'medium',
      blockingQuestions: [],
    },
    validation: {
      passed: true,
      issues: [],
    },
  };
  const overreaching: V3PipelineResult = {
    ...focused,
    draft: {
      ...focused.draft,
      confidence: 'high',
    },
    validation: {
      passed: false,
      issues: [
        { code: 'context_overreach', path: '$.features[0].acceptanceRequirements[0]', message: 'Context overreach.' },
        { code: 'confidence_mismatch', path: '$.confidence', message: 'Confidence mismatch.' },
      ],
    },
  };

  assert.ok(scoreV3Result(focused).overall > scoreV3Result(overreaching).overall);
});

test('scoreV3Result exposes JSA scenario gaps and question-only overreach', () => {
  const broad = scoreV3Result(baseResult, undefined, servicePlanBenchmark);
  const scenarioRich: V3PipelineResult = {
    ...baseResult,
    draft: {
      features: makeScoringFeatures([
        'the plan can contain distinct activities for de-installation, loaner installation, in-house repair, loaner de-installation, and repaired equipment installation.',
        'the plan can contain de-installation, off-site repair, and re-installation without requiring loaner-related activities.',
        'the service location for the on-site activity can be the customer site and the location for the off-site activity can be a service facility.',
        'the quote includes all billable labor and parts from all activities in the plan as distinct line items.',
        'the required work orders, parts orders, and shipments are derived from eligible planned items.',
        'the current status of each activity is visible using Not Started, In Progress, and Completed states.',
      ], [
        'sequence conflicts are visible before downstream work begins.',
      ], [
        'Should payment authorization be required before execution?',
        'Should return authorization be created for equipment sent to a service facility?',
        'Should preventive maintenance due dates apply to this service plan?',
      ]),
      confidence: 'medium',
      blockingQuestions: ['Should active multi-activity service plan changes be in scope?'],
    },
    validation: {
      passed: true,
      issues: [],
    },
  };
  const rich = scoreV3Result(scenarioRich, undefined, servicePlanBenchmark);

  assert.ok((broad.jsaComparison?.missingScenarioTerms.length ?? 0) > (rich.jsaComparison?.missingScenarioTerms.length ?? 0));
  assert.equal(rich.jsaComparison?.questionOnlyTermsFound.length, 0);
  assert.ok((rich.jsaComparison?.suggestedOpenQuestions.length ?? 0) < (broad.jsaComparison?.suggestedOpenQuestions.length ?? 0));
});

test('scoreV3Result applies the benchmark rubric to a non-service domain', () => {
  const result: V3PipelineResult = {
    ...baseResult,
    requirement: 'Classify support requests by priority, route them to the right team, and show triage status.',
    draft: {
      features: [
        {
          summary: 'Classify support requests by priority',
          businessOutcome: 'Support requests receive a priority classification before routing.',
          description: 'As a Support Coordinator, I need support requests classified by priority so that urgent work is recognized quickly.',
          acceptanceRequirements: [
            {
              given: 'a support request is received',
              when: 'its business impact is assessed',
              then: 'the support request records a priority classification.',
            },
            {
              given: 'a support request lacks priority information',
              when: 'triage is attempted',
              then: 'the missing priority condition is visible before routing continues.',
            },
          ],
          provenance: 'requirement',
          evidenceRefs: [],
          assumptions: [],
          openQuestions: [],
        },
        {
          summary: 'Route support requests to the responsible team',
          businessOutcome: 'Support requests reach the team responsible for the request topic and priority.',
          description: 'As a Support Coordinator, I need requests routed to a responsible team so that work reaches the group that can resolve it.',
          acceptanceRequirements: [
            {
              given: 'a support request has priority and topic information',
              when: 'routing occurs',
              then: 'the responsible team is identified for the support request.',
            },
            {
              given: 'no responsible team can be identified',
              when: 'routing occurs',
              then: 'the routing exception is visible for triage follow-up.',
            },
          ],
          provenance: 'requirement',
          evidenceRefs: [],
          assumptions: [],
          openQuestions: [],
        },
        {
          summary: 'Show triage status',
          businessOutcome: 'Triage status reflects whether support requests are pending, routed, or blocked.',
          description: 'As a Support Coordinator, I need triage status visibility so that pending and routed work can be monitored.',
          acceptanceRequirements: [
            {
              given: 'a support request has been triaged',
              when: 'priority or routing changes',
              then: 'the triage status reflects the current priority, team, and routing state.',
            },
            {
              given: 'a support request is blocked during triage',
              when: 'the status is reviewed',
              then: 'the blocked status identifies the unresolved triage condition.',
            },
          ],
          provenance: 'requirement',
          evidenceRefs: [],
          assumptions: [],
          openQuestions: ['Which priority levels and routing rules should apply?'],
        },
      ],
      confidence: 'medium',
      blockingQuestions: ['Which priority levels and routing rules should apply?'],
    },
    validation: {
      passed: true,
      issues: [],
    },
  };

  const score = scoreV3Result(result, undefined, supportTriageBenchmark);

  assert.ok(score.overall >= 80);
  assert.equal(score.jsaComparison?.prohibitedTermsFound.length, 0);
  assert.ok(score.expectedCapabilityCoverage.some((coverage) => coverage.id === 'status' && coverage.covered));
});

function makeScoringFeatures(specificThens: string[], otherThens: string[], openQuestions: string[] = []): V3PipelineResult['draft']['features'] {
  const thens = [...specificThens, ...otherThens];
  return Array.from({ length: 6 }, (_, featureIndex) => ({
    id: `feature_${featureIndex + 1}`,
    summary: 'Single multi activity service plan with field service in house loaner deinstallation installation parts labor quote work order shipment status sequence dependency validation',
    businessOutcome: 'Complex service work can be planned, quoted, initiated, and tracked in one place.',
    description: 'Complex service work can be planned without prescribing implementation details.',
    acceptanceRequirements: Array.from({ length: 3 }, (_, arIndex) => ({
      id: `ar_${featureIndex + 1}_${arIndex + 1}`,
      given: 'faulty customer equipment is being serviced',
      when: arIndex === 0 ? 'temporary replacement equipment is required during the service event' : 'the service event is prepared',
      then: thens[(featureIndex + arIndex) % thens.length] ?? thens[0] ?? 'the service need is captured.',
      provenance: 'requirement' as const,
      evidenceRefs: [{ cardId: 'WI-LOANER-001:wi:2', sourceId: 'WI-LOANER-001', reason: 'Related work instruction context' }],
    })),
    provenance: 'requirement' as const,
    evidenceRefs: [{ cardId: 'WI-LOANER-001:wi:2', sourceId: 'WI-LOANER-001', reason: 'Related work instruction context' }],
    assumptions: [],
    openQuestions: featureIndex === 0 ? openQuestions : [],
  }));
}
