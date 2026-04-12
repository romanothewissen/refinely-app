import test from 'node:test';
import assert from 'node:assert/strict';

import { isCompleteAcceptanceRequirement } from '../ar-validation';
import { buildSingleFeatureRefineSystemPrompt } from '../prompts';
import {
  AcceptanceRequirementsGenerationError,
  annotateFailedAcceptanceRequirementFeatures,
  assessInitialDiscoveryResponse,
  applyFeatureOutputGuardrails,
  applySmallAskTriageGuardrails,
  assessSizingHeuristics,
  capDiscoveryProfileFloorForSmallAsk,
  deriveSizingGuidance,
  feedbackRequestsStructuralRefinement,
  findFeaturesMissingCompleteAcceptanceRequirements,
  parseQuestionCandidates,
  repairAcceptanceRequirements,
  buildClarifyFailureDiagnostics,
  shouldPauseForDraftReview,
  triageToSizingContract,
  validateStructuralRestructureProposal,
} from '../story-generator';
import { buildBlockedClarifyContext } from '../../queues/clarify';
import {
  formatGenerationFeatureTarget,
  getApprovedDraftStructureNote,
  getCoverageReviewSummary,
  getDiscoveryProfileHeadline,
  getDraftFeatureHeading,
  getDraftFeatureNote,
  getGenerationFeatureTargetLabel,
  getSizingRunContextNote,
  getSourceContextChips,
} from '../../frontend/src/generation-progress-copy';

function makeFeature(summary: string, arCount: number, description?: string) {
  return {
    id: summary.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    summary,
    description: description ?? `As an Operations Manager, I need to ${summary.toLowerCase()} so that the workflow stays aligned.`,
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
      when: 'an Operations Process Owner defines a rule',
      then: '',
    }),
    false,
  );
});

test('isCompleteAcceptanceRequirement accepts fully written ARs', () => {
  assert.equal(
    isCompleteAcceptanceRequirement({
      given: 'a standard procedure needs to be enforced',
      when: 'an Operations Process Owner defines a rule',
      then: 'the rule is created and used for future linked records.',
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
          when: 'a blocking linked record exists',
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
  assert.equal(feedbackRequestsStructuralRefinement('split this into separate primary record and linked record features'), true);
});

test('validateStructuralRestructureProposal accepts complete merge coverage', () => {
  const selected = [
    makeFeature('View incoming communications', 2),
    makeFeature('Respond to incoming communications', 1),
  ];

  const validation = validateStructuralRestructureProposal({
    scope: 'selected',
    selectedFeatures: selected,
    proposal: {
      scope: 'selected',
      selectedFeatureIds: selected.map((feature) => feature.id),
      proposedFeatures: [
        {
          id: 'merged-intake',
          summary: 'Manage incoming communications',
          description: 'As an Operations Manager, I need to manage incoming communications so that intake handling stays coordinated.',
          acceptanceRequirements: [
            {
              given: 'incoming communications are waiting to be processed',
              when: 'the operations manager reviews the intake workspace',
              then: 'the communications can be reviewed and actioned from one coordinated feature scope.',
            },
          ],
          sourceFeatureIds: selected.map((feature) => feature.id),
          sourceAcceptanceRequirementRefs: [`${selected[0].id}#0`, `${selected[0].id}#1`, `${selected[1].id}#0`],
          primarySourceFeatureId: selected[0].id,
          rationale: 'Merge overlapping intake and response coverage into one coherent slice.',
        },
      ],
      removedFeatureIds: [],
      removedAcceptanceRequirementRefs: [],
    },
  });

  assert.deepEqual(validation, { valid: true });
});

test('validateStructuralRestructureProposal rejects duplicated AR ownership', () => {
  const selected = [makeFeature('Initiate a case', 2)];
  const duplicatedRef = `${selected[0].id}#0`;

  const validation = validateStructuralRestructureProposal({
    scope: 'selected',
    selectedFeatures: selected,
    proposal: {
      scope: 'selected',
      selectedFeatureIds: selected.map((feature) => feature.id),
      proposedFeatures: [
        {
          id: 'proposal-a',
          summary: 'Create a case',
          description: 'As an Operations Manager, I need to create a record so that intake work can proceed.',
          acceptanceRequirements: [
            {
              given: 'a valid intake exists',
              when: 'the operations manager creates a record',
              then: 'the record is opened.',
            },
          ],
          sourceFeatureIds: [selected[0].id],
          sourceAcceptanceRequirementRefs: [duplicatedRef],
          primarySourceFeatureId: selected[0].id,
        },
        {
          id: 'proposal-b',
          summary: 'Validate record preconditions',
          description: 'As an Operations Manager, I need to validate record preconditions so that invalid records are blocked.',
          acceptanceRequirements: [
            {
              given: 'a record is about to be created',
              when: 'a blocking condition exists',
              then: 'the record creation is stopped.',
            },
          ],
          sourceFeatureIds: [selected[0].id],
          sourceAcceptanceRequirementRefs: [duplicatedRef, `${selected[0].id}#1`],
          primarySourceFeatureId: selected[0].id,
        },
      ],
      removedFeatureIds: [],
      removedAcceptanceRequirementRefs: [],
    },
  });

  assert.equal(validation.valid, false);
  assert.match(validation.reason, /assigned more than once/i);
});

test('validateStructuralRestructureProposal rejects missing source coverage', () => {
  const selected = [
    makeFeature('Link contact records', 1),
    makeFeature('Initiate cases', 1),
  ];

  const validation = validateStructuralRestructureProposal({
    scope: 'selected',
    selectedFeatures: selected,
    proposal: {
      scope: 'selected',
      selectedFeatureIds: selected.map((feature) => feature.id),
      proposedFeatures: [
        {
          id: 'contact-linking-only',
          summary: 'Link incoming communications to contacts',
          description: 'As an Operations Manager, I need to link incoming communications to contacts so that existing context is reused.',
          acceptanceRequirements: [
            {
              given: 'an incoming communication matches a known contact',
              when: 'the operations manager reviews the communication',
              then: 'the communication is linked to that contact.',
            },
          ],
          sourceFeatureIds: [selected[0].id],
          sourceAcceptanceRequirementRefs: [`${selected[0].id}#0`],
          primarySourceFeatureId: selected[0].id,
        },
      ],
      removedFeatureIds: [],
      removedAcceptanceRequirementRefs: [],
    },
  });

  assert.equal(validation.valid, false);
  assert.match(validation.reason, /not accounted for/i);
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
  assert.match(prompt, /As a \[role\], I need \[action\] so that \[benefit\]/);
});

test('assessSizingHeuristics flags oversized split guard-rule backlogs', () => {
  const assessment = assessSizingHeuristics({
    stage: 'final',
    requirement: 'We must ensure no primary or linked records can be created when the eligibility date of the item is reached',
    features: [
      makeFeature('Prevent primary record creation for items past their eligibility date', 7),
      makeFeature('Allow primary record creation for items without an eligibility date', 1),
      makeFeature('Exempt archive records from the eligibility-date restriction', 3),
      makeFeature('Override the eligibility block for primary record creation with a reason', 7),
      makeFeature('Prevent linked record creation for items past their eligibility date', 8),
      makeFeature('Override the eligibility block for linked record creation with a reason', 4),
      makeFeature('Audit blocked creation attempts', 4),
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
      reasoning: 'Short workflow-area ask with unresolved handling paths.',
      confidence: 'medium',
      deliveryForecast: {
        featureTarget: 5,
        shape: 'narrow',
        complexity: 'high',
        arDepth: 'thorough',
      },
      discoveryForecast: {
        scope: 'moderate',
        complexity: 'high',
        ambiguity: 'high',
        recommendedInitialCount: 12,
        followupCap: 6,
      },
    },
  });

  assert.equal(assessment.archetype, 'workflow_area');
  assert.notEqual(assessment.verdict, 'oversized');
});

test('applySmallAskTriageGuardrails leaves successful LLM advisory triage unchanged', () => {
  const triage = {
    reasoning: 'One tightly bounded guard rule.',
    confidence: 'high' as const,
    deliveryForecast: {
      featureTarget: 5,
      shape: 'balanced' as const,
      complexity: 'high' as const,
      arDepth: 'thorough' as const,
    },
    discoveryForecast: {
      scope: 'moderate' as const,
      complexity: 'medium' as const,
      ambiguity: 'high' as const,
      recommendedInitialCount: 10,
      followupCap: 4,
    },
  };
  const guarded = applySmallAskTriageGuardrails({
    requirement: 'We must ensure no primary or linked records can be created when the eligibility date of the item is reached',
    triage,
  });

  assert.deepEqual(guarded, triage);
});


test('parseQuestionCandidates accepts valid discovery questions without suggestions', () => {
  const parsed = parseQuestionCandidates({
    discoveryProfile: {
      scope: 'moderate',
      complexity: 'medium',
      ambiguity: 'high',
      missingCategoryKeys: ['business_rules'],
      recommendedInitialCount: 3,
      followupCap: 2,
    },
    questions: [
      {
        categoryKey: 'business_rules',
        intent: 'decision_logic',
        question: 'Which rule should decide whether an incoming message updates an open case or creates a new one?',
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.suggestions, []);
});

test('parseQuestionCandidates keeps shorter grounded suggestion arrays intact', () => {
  const parsed = parseQuestionCandidates({
    questions: [
      {
        categoryKey: 'edge_cases_exceptions',
        intent: 'conflicts_duplicates',
        question: 'What should happen when the incoming issue looks like a duplicate but the match is not certain enough to trust automatically?',
        suggestions: [
          'Reuse the open case only when the identifier and issue context both match clearly',
          'Send uncertain duplicates for review instead of deciding automatically',
        ],
      },
    ],
  });

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.suggestions, [
    'Reuse the open case only when the identifier and issue context both match clearly',
    'Send uncertain duplicates for review instead of deciding automatically',
  ]);
});

test('assessInitialDiscoveryResponse classifies a missing questions array explicitly', () => {
  const assessed = assessInitialDiscoveryResponse({
    rawData: {
      discoveryProfile: {
        scope: 'moderate',
        complexity: 'medium',
        ambiguity: 'high',
        missingCategoryKeys: ['business_rules'],
        recommendedInitialCount: 6,
        followupCap: 4,
      },
    },
    requirement: 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.',
  });

  assert.equal(assessed.failureReasonCode, 'question_array_missing');
});

test('assessInitialDiscoveryResponse classifies malformed question entries explicitly', () => {
  const assessed = assessInitialDiscoveryResponse({
    rawData: {
      discoveryProfile: {
        scope: 'moderate',
        complexity: 'medium',
        ambiguity: 'high',
        missingCategoryKeys: ['business_rules'],
        recommendedInitialCount: 6,
        followupCap: 4,
      },
      questions: [
        { categoryKey: 'business_rules', intent: 'decision_logic', prompt: 'wrong field name' },
      ],
    },
    requirement: 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.',
  });

  assert.equal(assessed.failureReasonCode, 'question_shape_invalid');
});

test('assessInitialDiscoveryResponse classifies generic discovery questions explicitly', () => {
  const requirement = 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.';
  const assessed = assessInitialDiscoveryResponse({
    rawData: {
      discoveryProfile: {
        scope: 'moderate',
        complexity: 'high',
        ambiguity: 'high',
        missingCategoryKeys: ['business_rules', 'edge_cases_exceptions'],
        recommendedInitialCount: 6,
        followupCap: 4,
      },
      questions: [
        {
          categoryKey: 'context_trigger',
          intent: 'business_outcome',
          question: 'What business problem should this capability solve?',
        },
      ],
    },
    requirement,
  });

  assert.equal(assessed.failureReasonCode, 'question_set_generic');
});

test('assessInitialDiscoveryResponse classifies truncated discovery questions explicitly', () => {
  const assessed = assessInitialDiscoveryResponse({
    rawData: {
      discoveryProfile: {
        scope: 'moderate',
        complexity: 'medium',
        ambiguity: 'high',
        missingCategoryKeys: ['business_rules'],
        recommendedInitialCount: 6,
        followupCap: 4,
      },
      questions: [
        {
          categoryKey: 'business_rules',
          intent: 'decision_logic',
          question: 'Which rule should decide whether an incoming email updates an open case or',
        },
      ],
    },
    requirement: 'As a TSS, I need to manage phone, WhatsApp, text, and email intake and have cases created automatically.',
  });

  assert.equal(assessed.failureReasonCode, 'question_set_truncated');
});

test('buildClarifyFailureDiagnostics returns actionable guidance for generic discovery questions', () => {
  const diagnostics = buildClarifyFailureDiagnostics('question_set_generic', {
    generatedQuestionCount: 2,
  });

  assert.match(diagnostics.technicalSummary, /too generic/i);
  assert.match(diagnostics.userActionHint, /business object, actor, trigger/i);
  assert.equal(diagnostics.generatedQuestionCount, 2);
});

test('buildBlockedClarifyContext preserves actionable discovery diagnostics', () => {
  const context = buildBlockedClarifyContext(
    'SUP',
    'question_array_empty_when_discovery_required',
    buildClarifyFailureDiagnostics('question_array_empty_when_discovery_required'),
  );

  assert.equal(context.failureReasonCode, 'question_array_empty_when_discovery_required');
  assert.match(context.failureDiagnostics?.userActionHint ?? '', /narrowing the ask to one workflow/i);
  assert.match(context.failureDiagnostics?.technicalSummary ?? '', /returned no usable questions/i);
});

test('deriveSizingGuidance preserves explicit manual vs automated workflow splits', () => {
  const guidance = deriveSizingGuidance({
    requirement: 'We must ensure no records can be created after the eligibility deadline, with separate handling for manual creation and automated creation.',
  });

  assert.equal(guidance.minimumPreservedFeatureCount, 2);
  assert.match(guidance.explicitSplitSignals.join(' '), /manual_vs_automated_workflows/);
  assert.deepEqual(guidance.preferredFeatureRange, { min: 2, max: 2 });
});

test('applySmallAskTriageGuardrails keeps explicitly split small asks unchanged when triage succeeds', () => {
  const triage = {
    reasoning: 'Explicit manual and automated paths stay separate.',
    confidence: 'medium' as const,
    deliveryForecast: {
      featureTarget: 5,
      shape: 'balanced' as const,
      complexity: 'high' as const,
      arDepth: 'thorough' as const,
    },
    discoveryForecast: {
      scope: 'moderate' as const,
      complexity: 'high' as const,
      ambiguity: 'high' as const,
      recommendedInitialCount: 10,
      followupCap: 4,
    },
  };
  const guarded = applySmallAskTriageGuardrails({
    requirement: 'We must ensure no records can be created after the eligibility deadline, with separate handling for manual creation and automated creation.',
    triage,
  });

  assert.deepEqual(guarded, triage);
});

test('capDiscoveryProfileFloorForSmallAsk does not override successful advisory triage', () => {
  const triage = {
    reasoning: 'Guard rule with bounded delivery scope.',
    confidence: 'medium' as const,
    deliveryForecast: {
      featureTarget: 7,
      shape: 'broad' as const,
      complexity: 'medium' as const,
      arDepth: 'thorough' as const,
    },
    discoveryForecast: {
      scope: 'moderate' as const,
      complexity: 'medium' as const,
      ambiguity: 'medium' as const,
      recommendedInitialCount: 6,
      followupCap: 4,
    },
  };
  const capped = capDiscoveryProfileFloorForSmallAsk({
    requirement: 'We must ensure no primary or linked records can be created when the eligibility date of the item is reached',
    triage,
  });

  assert.deepEqual(capped, triage);
});

test('capDiscoveryProfileFloorForSmallAsk preserves explicit workflow floors from discovery without mutation', () => {
  const triage = {
    reasoning: 'Separate manual and automated handling paths are explicit.',
    confidence: 'medium' as const,
    deliveryForecast: {
      featureTarget: 7,
      shape: 'broad' as const,
      complexity: 'medium' as const,
      arDepth: 'thorough' as const,
    },
    discoveryForecast: {
      scope: 'moderate' as const,
      complexity: 'medium' as const,
      ambiguity: 'medium' as const,
      recommendedInitialCount: 6,
      followupCap: 4,
    },
  };
  const capped = capDiscoveryProfileFloorForSmallAsk({
    requirement: 'We must ensure no records can be created after the eligibility deadline, with separate handling for manual creation and automated creation.',
    triage,
  });

  assert.deepEqual(capped, triage);
});

test('generation progress copy labels draft output as provisional', () => {
  assert.equal(getGenerationFeatureTargetLabel(), 'Triage estimate');
  assert.equal(formatGenerationFeatureTarget(7), 'Forecast 7');
  assert.equal(getDraftFeatureHeading(), 'Draft features');
  assert.equal(getDraftFeatureNote(), null);
});

test('generation progress copy summarizes coverage and discovery context in plain language', () => {
  assert.equal(getApprovedDraftStructureNote(), 'Using approved feature structure');
  assert.deepEqual(getCoverageReviewSummary({
    sufficient: false,
    missingCoverage: ['Clarify how existing replies attach to open cases.'],
  }), {
    label: 'Coverage check found 1 area to review',
    tone: 'warning',
    details: ['Clarify how existing replies attach to open cases.'],
    heading: 'Gap to review',
  });
  assert.equal(getDiscoveryProfileHeadline({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'high',
    recommendedInitialCount: 6,
    followupCap: 2,
    missingCategoryKeys: [],
  }), 'Moderate scope / High ambiguity');
  assert.deepEqual(
    getSourceContextChips({
      projectCount: 2,
      domainContextApplied: true,
      attachmentIncluded: true,
      linkedWiDocCount: 5,
      retrievedWiDocCount: 3,
      wiInsightCount: 7,
      similarStoriesCount: 1,
    }).map((chip) => chip.label),
    ['2 projects', 'Guidance on', 'Attachment included', '3/5 work instructions retrieved', '7 WI insights', '1 similar story'],
  );
});

test('shouldPauseForDraftReview always returns false (deprecated — pipeline auto-repairs internally)', () => {
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
  }), false);

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
  }), false);
});

test('generation progress copy no longer surfaces automatic consolidation notes', () => {
  assert.equal(getSizingRunContextNote(null), null);
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
    null,
  );
});

test('triageToSizingContract preserves the committed LLM sizing contract', () => {
  assert.deepEqual(triageToSizingContract({
    reasoning: 'Moderately broad workflow with material ambiguity.',
    confidence: 'high',
    deliveryForecast: {
      featureTarget: 4,
      featureMin: 3,
      featureMax: 6,
      shape: 'balanced',
      complexity: 'high',
      arDepth: 'thorough',
      arTarget: 5,
    },
    discoveryForecast: {
      scope: 'moderate',
      complexity: 'high',
      ambiguity: 'high',
      recommendedInitialCount: 9,
      followupCap: 4,
    },
  }), {
    shape: 'balanced',
    complexity: 'high',
    featureTarget: 4,
    arDepth: 'thorough',
    arTarget: 5,
    estimatedQuestions: 9,
  });
});

test('applyFeatureOutputGuardrails preserves a valid but detailed feature description', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Prevent creation after the eligibility deadline',
    description: 'As an Operations Coordinator, I need to be prevented from creating primary or linked records when the related item has reached its designated eligibility deadline so that unsupported requests are blocked and users receive clear feedback about the policy.',
    acceptanceRequirements: [
      {
        given: 'a related item has an eligibility date that has already passed',
        when: 'an Operations Coordinator attempts to create a primary or linked record for that item, with an explanatory error message shown for example to clarify the exact date and the policy reason',
        then: 'the creation is prevented and the system explains why the request is blocked and what should happen next',
      },
    ],
  });

  assert.equal(
    guarded.description,
    'As an Operations Coordinator, I need to be prevented from creating primary or linked records when the related item has reached its designated eligibility deadline so that unsupported requests are blocked and users receive clear feedback about the policy.',
  );
  assert.equal(
    guarded.acceptanceRequirements[0].when,
    'an Operations Coordinator attempts to create a primary or linked record for that item, with an explanatory error message shown for example to clarify the exact date and the policy reason',
  );
});

test('applyFeatureOutputGuardrails is idempotent — a second pass does not duplicate the "so that" clause', () => {
  const raw = {
    id: 'feature-1',
    summary: 'Automatic Record Classification',
    description: 'As an Operations Specialist, I need incoming requests to be automatically converted into records and classified by type so that I can focus on resolution instead of manual creation and initial categorization.',
    acceptanceRequirements: [
      {
        given: 'an inbound request arrives through an approved intake source and clearly indicates a category',
        when: 'the request is processed',
        then: 'a new record is automatically created and classified',
      },
    ],
  };

  const firstPass = applyFeatureOutputGuardrails(raw);
  const secondPass = applyFeatureOutputGuardrails(firstPass);

  // Exactly one "so that" in both passes
  const firstSoThatCount = (firstPass.description.match(/\bso that\b/gi) || []).length;
  const secondSoThatCount = (secondPass.description.match(/\bso that\b/gi) || []).length;
  assert.equal(firstSoThatCount, 1, `first pass description has ${firstSoThatCount} "so that" clauses: ${firstPass.description}`);
  assert.equal(secondSoThatCount, 1, `second pass description has ${secondSoThatCount} "so that" clauses: ${secondPass.description}`);
  assert.doesNotMatch(firstPass.description, /so that the requested outcome is achieved/);
  assert.deepEqual(secondPass.acceptanceRequirements, firstPass.acceptanceRequirements);
  assert.equal(secondPass.description, firstPass.description);
});

test('applyFeatureOutputGuardrails leaves AR clause wording intact', () => {
  const guarded = applyFeatureOutputGuardrails({
    id: 'feature-1',
    summary: 'Automatic Record Creation from Approved Intake Sources',
    description: 'As an Operations Specialist, I need to receive automatically created records so that I do not have to create them manually.',
    acceptanceRequirements: [
      {
        given: 'an intake source is designated for automatic record creation, and an incoming request clearly indicates a category',
        when: 'the system processes the request',
        then: 'a new record is automatically created and classified',
      },
    ],
  });

  const given = guarded.acceptanceRequirements[0].given;
  assert.ok(
    given.includes('clearly indicates a category'),
    `GIVEN clause was truncated mid-sentence: "${given}"`,
  );
  assert.equal(
    guarded.acceptanceRequirements[0].when,
    'the system processes the request',
  );
});
