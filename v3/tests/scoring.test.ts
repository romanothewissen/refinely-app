import assert from 'node:assert/strict';
import test from 'node:test';
import type { V3PipelineResult } from '../src/contracts';
import { scoreV3Result, type V3JsaBenchmark } from '../src/scoring';
import benchmarksFixture from '../fixtures/jsa-benchmarks.json';

const benchmarks = benchmarksFixture as V3JsaBenchmark[];
const supportTriageBenchmark = benchmarks.find((benchmark) => benchmark.id === 'support-triage-jsa')!;

const launchPlanBenchmark: V3JsaBenchmark = {
  id: 'launch-plan-generic',
  label: 'Launch plan generic calibration',
  requirementIncludes: ['coordinated launch plan', 'materials', 'effort estimates', 'purchase orders'],
  expectedFeatureRange: { min: 4, max: 7 },
  minimumAverageAcceptanceRequirements: 2,
  requiredTerms: ['plan', 'activities', 'materials', 'effort estimates', 'approval packets', 'purchase orders', 'onboarding tasks'],
  expectedScenarioTerms: ['vendor reviews', 'prototype builds', 'training sessions', 'not ready', 'sequence conflict', 'downstream records'],
  questionOnlyTerms: ['legal review', 'security review', 'active plan changes'],
  prohibitedOverreachTerms: ['vendor approval date', 'access capacity', 'legal review', 'security review'],
  expectedOpenQuestionTerms: ['scope items', 'sequence', 'downstream'],
};

const baseResult: V3PipelineResult = {
  requirement: 'Create a coordinated launch plan with research tasks, vendor reviews, prototype builds, materials, effort estimates, approval packets, and follow-up purchase orders.',
  capabilityPlan: {
    capabilities: [],
    openQuestions: [],
    assumptions: [],
    complexity: 'complex',
  },
  draft: {
    features: [
      {
        summary: 'Define coordinated launch plan',
        businessOutcome: 'A coordinated plan tracks launch work and downstream handoffs.',
        description: 'As a Program Coordinator, I need to define a coordinated launch plan so that launch work can be planned in one place.',
        acceptanceRequirements: [
          {
            given: 'a launch plan is being created',
            when: 'named activities are specified',
            then: 'the plan captures the relevant details.',
          },
          {
            given: 'a launch activity is being added',
            when: 'resource details are planned',
            then: 'the plan captures materials, effort estimates, owner, and dependency status for that activity.',
          },
          {
            given: 'the launch plan contains dependent activities',
            when: 'downstream handoffs are prepared',
            then: 'purchase orders or onboarding tasks are created for eligible activities and blocked until prerequisites are complete.',
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
    'Define coordinated launch plan',
    '7.2.1',
    '13',
    'As a Program Coordinator, I need to build a launch plan so that I can manage a complex launch.',
    'GIVEN a launch needs vendor review WHEN a plan is created THEN the plan can contain distinct activities.',
    '2',
    'Prepare approval packet',
    '7.1.4',
    '8',
    'As a Finance Analyst, I need to prepare an approval packet so that reviewers receive the required estimate.',
    'GIVEN a plan contains estimated effort WHEN an approval packet is prepared THEN the packet includes the estimate context.',
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
        'the launch plan reflects activity type, materials, effort estimate, sequence, dependency, approval packet, purchase order, handoff, and status.',
        'the vendor access request captures vendor approval date, access capacity, legal review, and security review.',
      ], [
        'all details are available.',
        'the system stores the coordinator selection.',
      ]),
      confidence: 'high',
      blockingQuestions: [],
    },
    contextPack: {
      cards: [
        {
          id: 'WI-ACCESS-001:wi:2',
          sourceId: 'WI-ACCESS-001',
          sourceKind: 'work_instruction',
          kind: 'business_rule',
          title: 'Vendor Access Handling',
          text: 'The request must include vendor approval date, access capacity, legal review, and security review before manager review.',
          keywords: ['vendor', 'approval'],
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
        { code: 'solution_language', path: '$.features[0].acceptanceRequirements[2]', message: 'Solution language.' },
        { code: 'context_overreach', path: '$.features[0].acceptanceRequirements[1]', message: 'Context overreach.' },
        { code: 'confidence_mismatch', path: '$.confidence', message: 'Confidence mismatch.' },
      ],
    },
  };

  const score = scoreV3Result(result, undefined, launchPlanBenchmark);
  const grounding = score.dimensions.find((dimension) => dimension.id === 'grounding');

  assert.ok(score.overall <= 70);
  assert.equal(grounding?.score, 55);
  assert.ok(score.jsaComparison?.prohibitedTermsFound.includes('vendor approval date'));
  assert.ok(score.qualityWarnings.some((warning) => /context overreach/i.test(warning)));
});

test('scoreV3Result rewards candidate-scope questions over workflow expansion', () => {
  const focused: V3PipelineResult = {
    ...baseResult,
    draft: {
      features: makeScoringFeatures([
        'vendor reviews are represented as applicable planned scope without making them mandatory for every launch plan.',
        'the launch plan reflects activity type, materials, effort estimate, sequence, dependency, approval packet, purchase order, handoff, and status.',
      ], [
        'billable or financial-impacting items are reflected in the approval packet.',
      ], ['Should vendor review workflow details be handled as a separate capability?']),
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

test('scoreV3Result exposes benchmark scenario gaps and question-only overreach', () => {
  const broad = scoreV3Result(baseResult, undefined, launchPlanBenchmark);
  const scenarioRich: V3PipelineResult = {
    ...baseResult,
    draft: {
      features: makeScoringFeatures([
        'the plan can contain vendor reviews, prototype builds, and training sessions as distinct planned scope.',
        'the dependent activity is treated as not ready when prerequisite materials or approvals are incomplete.',
        'the sequence conflict is visible before downstream records or handoffs proceed.',
        'purchase orders and onboarding tasks are derived from eligible planned items.',
      ], [
        'approval packet details remain traceable to planned materials and effort estimates.',
      ], [
        'Should legal review apply to vendor reviews?',
        'Should security review apply to vendor access?',
      ]),
      confidence: 'medium',
      blockingQuestions: ['Should active plan changes be in scope?'],
    },
    validation: {
      passed: true,
      issues: [],
    },
  };
  const rich = scoreV3Result(scenarioRich, undefined, launchPlanBenchmark);

  assert.ok((broad.jsaComparison?.missingScenarioTerms.length ?? 0) > (rich.jsaComparison?.missingScenarioTerms.length ?? 0));
  assert.equal(rich.jsaComparison?.questionOnlyTermsFound.length, 0);
  assert.ok((rich.jsaComparison?.suggestedOpenQuestions.length ?? 0) < (broad.jsaComparison?.suggestedOpenQuestions.length ?? 0));
});

test('scoreV3Result applies the benchmark rubric to a support triage domain', () => {
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
    summary: 'Coordinated launch plan with activities resources estimates approval packets purchase orders handoffs status sequence dependency validation',
    businessOutcome: 'Complex launch work can be planned, reviewed, initiated, and tracked in one place.',
    description: 'Complex launch work can be planned without prescribing implementation details.',
    acceptanceRequirements: Array.from({ length: 3 }, (_, arIndex) => ({
      id: `ar_${featureIndex + 1}_${arIndex + 1}`,
      given: 'a launch activity is being planned',
      when: arIndex === 0 ? 'vendor review scope is considered' : 'the launch plan is prepared',
      then: thens[(featureIndex + arIndex) % thens.length] ?? thens[0] ?? 'the launch need is captured.',
      provenance: 'requirement' as const,
      evidenceRefs: [{ cardId: 'WI-ACCESS-001:wi:2', sourceId: 'WI-ACCESS-001', reason: 'Related work instruction context' }],
    })),
    provenance: 'requirement' as const,
    evidenceRefs: [{ cardId: 'WI-ACCESS-001:wi:2', sourceId: 'WI-ACCESS-001', reason: 'Related work instruction context' }],
    assumptions: [],
    openQuestions: featureIndex === 0 ? openQuestions : [],
  }));
}
