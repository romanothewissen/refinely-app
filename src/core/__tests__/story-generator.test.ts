import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleteAcceptanceRequirement } from '../ar-validation';
import { buildSingleFeatureRefineSystemPrompt } from '../prompts';
import {
  AcceptanceRequirementsGenerationError,
  annotateFailedAcceptanceRequirementFeatures,
  applyFeatureOutputGuardrails,
  applySmallAskTriageGuardrails,
  assessSizingHeuristics,
  capDiscoveryProfileFloorForSmallAsk,
  collectDiscoveryGroundingTerms,
  deriveSizingGuidance,
  feedbackRequestsStructuralRefinement,
  findFeaturesMissingCompleteAcceptanceRequirements,
  followupQuestionsLookWeak,
  initialQuestionsLookWeak,
  repairAcceptanceRequirements,
  shouldPauseForDraftReview,
  triageToSizingContract,
} from '../story-generator';
import {
  formatGenerationFeatureTarget,
  getDraftFeatureHeading,
  getDraftFeatureNote,
  getGenerationFeatureTargetLabel,
  getSizingRunContextNote,
} from '../../frontend/src/generation-progress-copy';

function makeFeature(summary: string, arCount: number, description?: string) {
  return {
    id: summary.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    summary,
    description: description ?? `As a Service Manager, I need to ${summary.toLowerCase()} so that the service process stays compliant.`,
    acceptanceRequirements: Array.from({ length: arCount }, (_, index) => ({
      given: `a relevant business condition ${index + 1} exists`,
      when: 'the rule is evaluated',
      then: `the expected business outcome ${index + 1} occurs`,
    })),
  };
}

test('isCompleteAcceptanceRequirement rejects ARs with a missing then clause', () => {
  assert.equal(
    isCompleteAcceptanceRequirement({
      given: 'a standard procedure needs to be enforced',
      when: 'a Service Process Owner defines a rule',
      then: '',
    }),
    false,
  );
});

test('isCompleteAcceptanceRequirement accepts fully written ARs', () => {
  assert.equal(
    isCompleteAcceptanceRequirement({
      given: 'a standard procedure needs to be enforced',
      when: 'a Service Process Owner defines a rule',
      then: 'the rule is created and used for future work orders.',
    }),
    true,
  );
});

test('repairAcceptanceRequirements stitches fragmented clauses into a complete AR', () => {
  const repaired = repairAcceptanceRequirements([
    { given: 'a manager is viewing a dashboard with a standard layout', when: '', then: '' },
    { given: '', when: 'the manager rearranges, resizes, or hides charts and saves the changes', then: '' },
    { given: '', when: '', then: "the dashboard is displayed with the manager's personalized arrangement." },
  ]);

  assert.deepEqual(repaired, [
    {
      given: 'a manager is viewing a dashboard with a standard layout',
      when: 'the manager rearranges, resizes, or hides charts and saves the changes',
      then: "the dashboard is displayed with the manager's personalized arrangement.",
    },
  ]);
});

test('findFeaturesMissingCompleteAcceptanceRequirements flags features with missing or incomplete ARs', () => {
  const missing = findFeaturesMissingCompleteAcceptanceRequirements([
    {
      acceptanceRequirements: [
        {
          given: 'a contract is expiring',
          when: 'the completion rule is evaluated',
          then: 'the contract remains open if blocking work remains.',
        },
      ],
    },
    {
      acceptanceRequirements: [],
    },
    {
      acceptanceRequirements: [
        {
          given: 'an owner is reviewing the contract',
          when: 'a blocking work order exists',
          then: '',
        },
      ],
    },
  ]);

  assert.deepEqual(missing, [1, 2]);
});

test('AcceptanceRequirementsGenerationError preserves failing draft metadata', () => {
  const error = new AcceptanceRequirementsGenerationError(
    'Acceptance requirements could not be completed for 1 feature.',
    [
      {
        id: 'feature-1',
        summary: 'Keep contract open',
        description: 'As a coordinator, I need to keep the contract open so that downstream processing does not fail.',
        acceptanceRequirements: [],
      },
    ],
    [0],
  );

  assert.equal(error.name, 'AcceptanceRequirementsGenerationError');
  assert.deepEqual(error.failedFeatureIndexes, [0]);
  assert.equal(error.draftFeatures[0]?.id, 'feature-1');
});

test('annotateFailedAcceptanceRequirementFeatures marks only failed features for retry', () => {
  const features = [
    makeFeature('Keep complete feature', 2),
    makeFeature('Retry incomplete feature', 0),
  ] as Array<{
    id: string;
    summary: string;
    description: string;
    acceptanceRequirements: Array<{ given: string; when: string; then: string }>;
    arGenerationStatus?: 'failed' | 'retrying';
    arGenerationError?: string;
  }>;

  const annotated = annotateFailedAcceptanceRequirementFeatures(features, new Set([features[1].id])) as typeof features;

  assert.equal(annotated[0].arGenerationStatus, undefined);
  assert.equal(annotated[0].arGenerationError, undefined);
  assert.equal(annotated[1].arGenerationStatus, 'failed');
  assert.match(annotated[1].arGenerationError ?? '', /retry this feature/i);
});

test('annotateFailedAcceptanceRequirementFeatures clears stale retry flags from recovered features', () => {
  const feature = {
    ...makeFeature('Recovered feature', 2),
    arGenerationStatus: 'retrying' as const,
    arGenerationError: 'Old retry error',
  };

  const annotated = annotateFailedAcceptanceRequirementFeatures(feature, new Set()) as typeof feature;

  assert.equal(annotated.arGenerationStatus, undefined);
  assert.equal(annotated.arGenerationError, undefined);
});

test('feedbackRequestsStructuralRefinement keeps stylistic bulk feedback in per-feature mode', () => {
  assert.equal(feedbackRequestsStructuralRefinement('make these features less technical'), false);
  assert.equal(feedbackRequestsStructuralRefinement('add regulatory guardrails across all features'), false);
});

test('feedbackRequestsStructuralRefinement detects explicit backlog restructuring requests', () => {
  assert.equal(feedbackRequestsStructuralRefinement('merge overlapping features and remove duplicate features'), true);
  assert.equal(feedbackRequestsStructuralRefinement('split this into separate service case and work order features'), true);
});

test('buildSingleFeatureRefineSystemPrompt can forbid splitting during bulk refinement', () => {
  const prompt = buildSingleFeatureRefineSystemPrompt({
    domainContext: '',
    processTaxonomy: [],
    processTaxonomyEnabled: false,
    allowStructuralChanges: false,
  });

  assert.match(prompt, /Return EXACTLY ONE feature in the features array/);
  assert.match(prompt, /Do not split this feature into multiple features/);
  assert.match(prompt, /Do not invent new sibling features or move acceptance requirements into other features/);
});

test('assessSizingHeuristics flags oversized split guard-rule backlogs', () => {
  const assessment = assessSizingHeuristics({
    stage: 'final',
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    features: [
      makeFeature('Prevent Service Case creation for products past their end of service date', 7),
      makeFeature('Allow Service Case creation for products without an end of service date', 1),
      makeFeature('Exempt product decommissioning cases from the end of service date restriction', 3),
      makeFeature('Override the end-of-service block for Service Case creation with a reason', 7),
      makeFeature('Prevent Work Order creation for products past their end of service date', 8),
      makeFeature('Override the end-of-service block for Work Order creation with a reason', 4),
      makeFeature('Audit end-of-service creation attempts', 4),
    ],
  });

  assert.equal(assessment.archetype, 'guard_rule');
  assert.equal(assessment.verdict, 'oversized');
  assert.equal(assessment.confidence, 'high');
  assert.equal(assessment.featureCount, 7);
  assert.equal(assessment.acceptanceRequirementCount, 34);
  assert.match(assessment.reasonCodes.join(' '), /feature_count_far_above_preferred_range/);
});

test('assessSizingHeuristics does not falsely compress workflow-area asks', () => {
  const assessment = assessSizingHeuristics({
    stage: 'final',
    requirement: 'As a support coordinator, I need one place to manage incoming customer communications and create or update cases from them.',
    features: [
      makeFeature('Triage incoming communications', 4),
      makeFeature('Decide whether to create a new case or update an existing case', 4),
      makeFeature('Route uncertain matches for manual review', 3),
      makeFeature('Capture required information before case handling continues', 4),
      makeFeature('Handle source-specific exception paths', 4),
    ],
    triage: {
      estimatedFeatures: 5,
      estimatedQuestions: 12,
      shape: 'narrow',
      complexity: 'high',
      arDepth: 'thorough',
    },
  });

  assert.equal(assessment.archetype, 'workflow_area');
  assert.notEqual(assessment.verdict, 'oversized');
});

test('applySmallAskTriageGuardrails narrows precise guard-rule triage estimates', () => {
  const guarded = applySmallAskTriageGuardrails({
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    triage: {
      estimatedFeatures: 5,
      estimatedQuestions: 10,
      shape: 'balanced',
      complexity: 'high',
      arDepth: 'thorough',
    },
  });

  assert.equal(guarded?.estimatedFeatures, 1);
  assert.equal(guarded?.shape, 'minimal');
  assert.equal(guarded?.complexity, 'medium');
  assert.equal(guarded?.arDepth, 'standard');
});

test('initialQuestionsLookWeak accepts a mixed but grounded initial discovery set', () => {
  const requirement = 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.';
  const groundingTerms = collectDiscoveryGroundingTerms([requirement]);
  const questions = [
    {
      categoryKey: 'context_trigger' as const,
      category: 'Context & Trigger',
      intent: 'business_outcome',
      question: 'What should automatic case handling across Phone, WhatsApp, Text, and Email improve first?',
      suggestions: [],
    },
    {
      categoryKey: 'context_trigger' as const,
      category: 'Context & Trigger',
      intent: 'trigger_event',
      question: 'Which trigger policy should start case creation across Phone, WhatsApp, Text, and Email?',
      suggestions: [],
    },
    {
      categoryKey: 'business_rules' as const,
      category: 'Business Rules',
      intent: 'decision_logic',
      question: 'How should the flow choose between a new case and an existing one?',
      suggestions: [],
    },
    {
      categoryKey: 'edge_cases_exceptions' as const,
      category: 'Edge Cases & Exceptions',
      intent: 'conflicts_duplicates',
      question: 'What should happen when the incoming interaction appears to match an existing case and could create a duplicate?',
      suggestions: [],
    },
  ];

  assert.equal(initialQuestionsLookWeak(questions, groundingTerms), false);
});

test('followupQuestionsLookWeak still rejects a broad initial-style follow-up question', () => {
  const requirement = 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.';
  const groundingTerms = collectDiscoveryGroundingTerms([requirement]);
  const questions = [
    {
      categoryKey: 'business_rules' as const,
      category: 'Business Rules',
      intent: 'decision_logic',
      question: 'How should the flow choose between a new case and an existing one?',
      suggestions: [],
    },
  ];

  assert.equal(followupQuestionsLookWeak(questions, groundingTerms), true);
});

test('deriveSizingGuidance preserves explicit manual vs automated workflow splits', () => {
  const guidance = deriveSizingGuidance({
    requirement: 'We must ensure no service cases can be created after end of service, with separate handling for manual creation and automated creation.',
  });

  assert.equal(guidance.minimumPreservedFeatureCount, 2);
  assert.match(guidance.explicitSplitSignals.join(' '), /manual_vs_automated_workflows/);
  assert.deepEqual(guidance.preferredFeatureRange, { min: 2, max: 2 });
});

test('applySmallAskTriageGuardrails keeps explicitly split small asks above one feature', () => {
  const guarded = applySmallAskTriageGuardrails({
    requirement: 'We must ensure no service cases can be created after end of service, with separate handling for manual creation and automated creation.',
    triage: {
      estimatedFeatures: 5,
      estimatedQuestions: 10,
      shape: 'balanced',
      complexity: 'high',
      arDepth: 'thorough',
    },
  });

  assert.equal(guarded?.estimatedFeatures, 2);
  assert.equal(guarded?.shape, 'narrow');
});

test('capDiscoveryProfileFloorForSmallAsk prevents broad floor inflation for focused guard rules', () => {
  const capped = capDiscoveryProfileFloorForSmallAsk({
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    triage: {
      estimatedFeatures: 7,
      estimatedQuestions: 6,
      shape: 'broad',
      complexity: 'medium',
      arDepth: 'thorough',
    },
  });

  assert.equal(capped?.estimatedFeatures, 1);
  assert.equal(capped?.shape, 'minimal');
  assert.equal(capped?.complexity, 'medium');
});

test('capDiscoveryProfileFloorForSmallAsk preserves explicit workflow floors from discovery', () => {
  const capped = capDiscoveryProfileFloorForSmallAsk({
    requirement: 'We must ensure no service cases can be created after end of service, with separate handling for manual creation and automated creation.',
    triage: {
      estimatedFeatures: 7,
      estimatedQuestions: 6,
      shape: 'broad',
      complexity: 'medium',
      arDepth: 'thorough',
    },
  });

  assert.equal(capped?.estimatedFeatures, 2);
  assert.equal(capped?.shape, 'narrow');
});

test('generation progress copy labels draft output as provisional', () => {
  assert.equal(getGenerationFeatureTargetLabel(), 'Triage estimate');
  assert.equal(formatGenerationFeatureTarget(7), 'Forecast 7');
  assert.equal(getDraftFeatureHeading(), 'Features');
  assert.equal(getDraftFeatureNote(), null);
});

test('shouldPauseForDraftReview pauses when pass-1 draft materially exceeds the triage forecast', () => {
  assert.equal(shouldPauseForDraftReview({
    draftFeatureCount: 7,
    triageFeatureTarget: 4,
    sizingAssessment: {
      stage: 'decomposition',
      archetype: 'workflow_area',
      verdict: 'ok',
      confidence: 'medium',
      preferredFeatureRange: { min: 3, max: 6 },
      preferredArDepth: 'standard',
      minimumPreservedFeatureCount: 3,
      explicitSplitSignals: [],
      featureCount: 7,
      acceptanceRequirementCount: 0,
      averageAcceptanceRequirementsPerFeature: 0,
      reasonCodes: [],
      reasons: [],
    },
  }), true);
});

test('shouldPauseForDraftReview does not pause for normal pass-1 variance', () => {
  assert.equal(shouldPauseForDraftReview({
    draftFeatureCount: 5,
    triageFeatureTarget: 4,
    sizingAssessment: {
      stage: 'decomposition',
      archetype: 'workflow_area',
      verdict: 'ok',
      confidence: 'medium',
      preferredFeatureRange: { min: 3, max: 6 },
      preferredArDepth: 'standard',
      minimumPreservedFeatureCount: 3,
      explicitSplitSignals: [],
      featureCount: 5,
      acceptanceRequirementCount: 0,
      averageAcceptanceRequirementsPerFeature: 0,
      reasonCodes: [],
      reasons: [],
    },
  }), false);
});

test('shouldPauseForDraftReview pauses when sizing assessment confidently marks the draft oversized', () => {
  assert.equal(shouldPauseForDraftReview({
    draftFeatureCount: 6,
    triageFeatureTarget: 6,
    sizingAssessment: {
      stage: 'decomposition',
      archetype: 'guard_rule',
      verdict: 'oversized',
      confidence: 'high',
      preferredFeatureRange: { min: 2, max: 4 },
      preferredArDepth: 'standard',
      minimumPreservedFeatureCount: 2,
      explicitSplitSignals: [],
      featureCount: 6,
      acceptanceRequirementCount: 0,
      averageAcceptanceRequirementsPerFeature: 0,
      reasonCodes: ['too_many_features'],
      reasons: [{ code: 'too_many_features', detail: 'The draft contains more features than the preferred sizing range.' }],
    },
  }), true);
});

test('generation progress copy surfaces consolidation notes after generation', () => {
  assert.equal(
    getSizingRunContextNote({
      archetype: 'guard_rule',
      verdict: 'ok',
      confidence: 'high',
      preferredFeatureRange: { min: 1, max: 2 },
      preferredArDepth: 'standard',
      minimumPreservedFeatureCount: 1,
      explicitSplitSignals: [],
      reasonCodes: [],
      reasons: [],
      repairApplied: true,
      preRepairFeatureCount: 7,
      decomposition: {
        stage: 'decomposition',
        archetype: 'guard_rule',
        verdict: 'oversized',
        confidence: 'high',
        preferredFeatureRange: { min: 1, max: 2 },
        preferredArDepth: 'standard',
        minimumPreservedFeatureCount: 1,
        explicitSplitSignals: [],
        featureCount: 7,
        acceptanceRequirementCount: 0,
        averageAcceptanceRequirementsPerFeature: 0,
        reasonCodes: [],
        reasons: [],
      },
      final: {
        stage: 'final',
        archetype: 'guard_rule',
        verdict: 'ok',
        confidence: 'high',
        preferredFeatureRange: { min: 1, max: 2 },
        preferredArDepth: 'standard',
        minimumPreservedFeatureCount: 1,
        explicitSplitSignals: [],
        featureCount: 2,
        acceptanceRequirementCount: 8,
        averageAcceptanceRequirementsPerFeature: 4,
        reasonCodes: [],
        reasons: [],
      },
    }),
    'Draft consolidated from 7 to 2 features before final output.',
  );
});

test('triageToSizingContract preserves the committed LLM sizing contract', () => {
  assert.deepEqual(triageToSizingContract({
    estimatedFeatures: 4,
    estimatedQuestions: 9,
    shape: 'balanced',
    complexity: 'high',
    arDepth: 'thorough',
  }), {
    shape: 'balanced',
    complexity: 'high',
    featureTarget: 4,
    arDepth: 'thorough',
    estimatedQuestions: 9,
  });
});

test('applyFeatureOutputGuardrails falls back to authorized user when the role is not evidence-backed', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Prevent creation after end of service',
    description: 'As a Field Service Engineer, I need to be prevented from creating service cases or work orders when the primary installed product has reached its designated end of service date so that unsupported requests are blocked and users receive clear feedback about the policy.',
    acceptanceRequirements: [
      {
        given: 'a primary installed product has an end of service date that has already passed',
        when: 'a Field Service Engineer attempts to create a service case or work order for that product, with an explanatory error message shown for example to clarify the exact date and the policy reason',
        then: 'the creation is prevented and the system explains why the request is blocked and what should happen next',
      },
    ],
  }, {
    requirement: 'We must ensure no service cases and work orders can be created when the end of service date of the product is reached',
    domainRoles: ['Field Service Engineer', 'Technical Support Specialist'],
  });

  assert.match(guarded.description, /^As an authorized user, I need to /);
  assert.notEqual(
    guarded.description,
    'As a Field Service Engineer, I need to be prevented from creating service cases or work orders when the primary installed product has reached its designated end of service date so that unsupported requests are blocked and users receive clear feedback about the policy.',
  );
  assert.equal(guarded.acceptanceRequirements[0].when.includes('for example'), false);
});

test('applyFeatureOutputGuardrails promotes a generic feature role to a dominant evidence-backed AR role', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Block unsupported record creation',
    description: 'As an authorized user, I need to create supported records so that unsupported products are not processed.',
    acceptanceRequirements: [
      {
        given: 'a product has passed its end of service date',
        when: 'a Technical Support Specialist attempts to create the record',
        then: 'the record is not created',
      },
      {
        given: 'a product has passed its end of service date',
        when: 'a Technical Support Specialist attempts to create the record with a linked work order',
        then: 'the linked work order is not created',
      },
    ],
  }, {
    requirement: 'As a Technical Support Specialist, I need to prevent creation of service records for unsupported products.',
    domainRoles: ['Technical Support Specialist', 'Supervisor'],
  });

  assert.match(guarded.description, /^As a Technical Support Specialist, I need to /);
  assert.match(guarded.acceptanceRequirements[0].when, /^a Technical Support Specialist attempts to create the record$/i);
});

test('applyFeatureOutputGuardrails reduces repeated WHEN role labels after the first explicit mention', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Block unsupported record creation',
    description: 'As an authorized user, I need to create supported records so that unsupported products are not processed.',
    acceptanceRequirements: [
      {
        given: 'a product has passed its end of service date',
        when: 'a Technical Support Specialist attempts to create the record',
        then: 'the record is not created',
      },
      {
        given: 'a product has passed its end of service date',
        when: 'the Technical Support Specialist attempts to create the linked work order',
        then: 'the linked work order is not created',
      },
    ],
  }, {
    requirement: 'As a Technical Support Specialist, I need to prevent creation of service records for unsupported products.',
    domainRoles: ['Technical Support Specialist'],
  });

  assert.match(guarded.acceptanceRequirements[0].when, /^a Technical Support Specialist attempts to create the record$/i);
  assert.match(guarded.acceptanceRequirements[1].when, /^they attempts? to create the linked work order$/i);
  assert.doesNotMatch(guarded.acceptanceRequirements[1].when, /Technical Support Specialist/i);
});

test('applyFeatureOutputGuardrails does not promote a generic feature role when multiple AR roles are present', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Coordinate unsupported record handling',
    description: 'As an authorized user, I need to handle unsupported records so that the right follow-up occurs.',
    acceptanceRequirements: [
      {
        given: 'a product has passed its end of service date',
        when: 'a Technical Support Specialist attempts to create the record',
        then: 'the record is blocked',
      },
      {
        given: 'the block requires approval',
        when: 'a Supervisor reviews the request',
        then: 'the request is routed for a decision',
      },
    ],
  }, {
    requirement: 'Unsupported record handling must block creation and route exceptions for review when needed.',
    domainRoles: ['Technical Support Specialist', 'Supervisor'],
  });

  assert.match(guarded.description, /^As an authorized user, I need to /);
});
