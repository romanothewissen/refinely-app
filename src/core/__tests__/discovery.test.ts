import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowsZeroQuestionDiscovery,
  buildDiscoveryCoverageArtifact,
  computeInitialQuestionBudget,
  expandRawQuestionCandidate,
  finalizeFollowupDiscoveryQuestions,
  finalizeInitialDiscoveryQuestions,
  MAX_INITIAL_DISCOVERY_QUESTIONS,
  normalizeDiscoveryProfile,
  validateAndRepairInitialDiscovery,
} from '../discovery';
import {
  buildArSystemPrompt,
  buildArRepairSystemPrompt,
  buildArPerFeatureUserMessage,
  buildAddRequirementsSystemPrompt,
  buildClarifySystemPrompt,
  buildCoverageCheckSystemPrompt,
  buildCoverageRepairSystemPrompt,
  buildDecompositionSystemPrompt,
  buildEvaluateSystemPrompt,
  buildSizingAssessmentSystemPrompt,
  buildSizingRepairSystemPrompt,
  buildStoryAssistantClarifySystemPrompt,
  buildStoryAssistantArSystemPrompt,
  buildStoryAssistantSufficiencySystemPrompt,
  buildTriageSystemPrompt,
} from '../prompts';
import { DEFAULT_GENERATION_TRIAGE_FALLBACK } from '../story-generator';
import { useStoryAssistantDefaultPipeline } from '../../services/pipeline-flags';
import { DEFAULT_CONFIG } from '../../types';

test('normalizeDiscoveryProfile preserves llm-sized discovery counts', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'very_broad',
    complexity: 'very_high',
    ambiguity: 'high',
    missingCategoryKeys: ['business_rules', 'context_trigger'],
    recommendedInitialCount: 50,
    followupCap: 18,
  });

  assert.equal(profile.recommendedInitialCount, 50);
  assert.equal(profile.followupCap, 18);
  assert.deepEqual(profile.missingCategoryKeys, ['context_trigger', 'business_rules']);
});

test('normalizeDiscoveryProfile allows zero-question discovery', () => {
  const profile = normalizeDiscoveryProfile({
    recommendedInitialCount: 0,
    followupCap: 0,
  });

  assert.equal(profile.recommendedInitialCount, 0);
  assert.equal(profile.followupCap, 0);
});

test('computeInitialQuestionBudget respects triage and hard cap', () => {
  const profile = normalizeDiscoveryProfile({ recommendedInitialCount: 30, followupCap: 6 });
  assert.equal(computeInitialQuestionBudget(profile, 10), 10);
  assert.equal(computeInitialQuestionBudget(profile, null), MAX_INITIAL_DISCOVERY_QUESTIONS);
});

test('validateAndRepairInitialDiscovery caps oversized question sets with category spread', () => {
  const many = Array.from({ length: 24 }, (_, i) => ({
    categoryKey: 'context_trigger' as const,
    category: 'Context & Trigger',
    intent: `intent_${i}`,
    question: `Question ${i + 1} for trigger context?`,
    suggestions: [] as string[],
  }));
  const profile = normalizeDiscoveryProfile({
    scope: 'broad',
    complexity: 'high',
    ambiguity: 'high',
    missingCategoryKeys: [],
    recommendedInitialCount: 24,
    followupCap: 6,
  });
  const repaired = validateAndRepairInitialDiscovery(many, profile, 10);
  assert.equal(repaired.questions.length, 10);
  assert.equal(repaired.discoveryProfile.recommendedInitialCount, 24);
  assert.equal(repaired.discoveryProfile.actualQuestionsAsked, 10);
});

test('validateAndRepairInitialDiscovery preserves aspirational plan and stores actual finalized count separately', () => {
  const repaired = validateAndRepairInitialDiscovery(
    [
      {
        categoryKey: 'business_rules',
        category: 'Business Rules',
        intent: 'decision_logic',
        question: 'How should uncertain matches be handled?',
        suggestions: [],
      },
    ],
    {
      scope: 'moderate',
      complexity: 'high',
      ambiguity: 'high',
      missingCategoryKeys: ['business_rules', 'functional_flow'],
      recommendedInitialCount: 6,
      followupCap: 4,
    },
  );

  assert.equal(repaired.discoveryProfile.recommendedInitialCount, 6);
  assert.equal(repaired.discoveryProfile.actualQuestionsAsked, 1);
  assert.deepEqual(repaired.discoveryProfile.missingCategoryKeys, ['business_rules', 'functional_flow']);
});

test('buildDiscoveryCoverageArtifact tracks planned and actual discovery coverage separately', () => {
  const artifact = buildDiscoveryCoverageArtifact({
    missingCategoryKeys: ['business_rules', 'functional_flow'],
    plannedQuestionBudget: 12,
    actualQuestionsAsked: 9,
    actualAnswersReceived: 7,
    askedCategoryKeys: ['context_trigger', 'user_personas'],
    openNonBlockingDecisions: ['Choose default priority handling'],
  });

  assert.deepEqual(artifact.mustResolveThemes, ['Functional Flow', 'Business Rules']);
  assert.deepEqual(artifact.coveredThemes, ['Context & Trigger', 'User Personas']);
  assert.deepEqual(artifact.askedCategoryKeys, ['context_trigger', 'user_personas']);
  assert.deepEqual(artifact.askedThemes, ['Context & Trigger', 'User Personas']);
  assert.equal(artifact.plannedQuestionBudget, 12);
  assert.equal(artifact.actualQuestionsAsked, 9);
  assert.equal(artifact.actualAnswersReceived, 7);
  assert.deepEqual(artifact.openNonBlockingDecisions, ['Choose default priority handling']);
});

test('expandRawQuestionCandidate keeps bundled numbered prompts on a single card', () => {
  const sharedSuggestions = [
    'Start automatically once the interaction reaches a usable handoff point and the core details are present',
    'Start only after identity or enough context has been confirmed by the team',
    'Hold the flow for manual review when the trigger is ambiguous or key context is missing',
    'Apply different trigger rules by channel, but make the exclusion path explicit',
  ];
  const questions = expandRawQuestionCandidate({
    category: 'Context & Trigger',
    intent: 'trigger_and_inputs',
    question: 'For case creation, 1. what exact event should trigger the flow, 2. what data must already be present, and 3. when should the interaction wait for manual review instead?',
    suggestions: sharedSuggestions,
  });

  assert.equal(questions.length, 1);
  assert.equal(questions[0].categoryKey, 'context_trigger');
  assert.equal(questions[0].intent, 'trigger_and_inputs');
  assert.equal(
    questions[0].question,
    'For case creation, 1. what event should trigger the flow, 2. what data must already be present, and 3. when should the interaction wait for manual review instead?',
  );
  assert.equal(questions[0].details, undefined);
  assert.deepEqual(questions[0].suggestions, sharedSuggestions);
});

test('finalizeInitialDiscoveryQuestions preserves the llm question set without padding', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingCategoryKeys: ['user_personas', 'business_rules'],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'context_trigger',
      category: 'Context & Trigger',
      intent: 'trigger_event',
      question: 'What exact event should start this automation?',
      suggestions: ['Incoming call', 'First message', 'Manual action', 'Status change'],
    },
  ], profile);

  assert.equal(questions.length, 1);
  assert.equal(questions[0].categoryKey, 'context_trigger');
});

test('expandRawQuestionCandidate preserves provided details alongside a short main question', () => {
  const questions = expandRawQuestionCandidate({
    categoryKey: 'business_rules',
    intent: 'decision_logic',
    question: 'When is the product considered past its end of service date?',
    details: 'Clarify whether this starts on the date itself or only after the date has passed.',
    suggestions: [
      'Treat the product as past end of service on the stated date',
      'Treat it as past end of service only after the stated date has passed',
      'Use a configurable cut-off time on the end of service date',
      'Use the local time zone of the user creating the service case',
    ],
  });

  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, 'When is the product considered past its end of service date?');
  assert.equal(questions[0].details, 'Clarify whether this starts on the date itself or only after the date has passed.');
});

test('finalizeInitialDiscoveryQuestions moves scenario-heavy wording into details without losing domain terms', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingCategoryKeys: ['state_lifecycle'],
    recommendedInitialCount: 1,
    followupCap: 2,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'state_lifecycle',
      category: 'State & Lifecycle',
      intent: 'timing_rule',
      question: 'If a service case or work order is created before the end of service date of the product but the actual service is performed after that date, is this permissible?',
      suggestions: [
        'Yes, as long as the creation date was before the end of service date',
        'No, if the Service Occurred Date is after the end of service date',
        'Allow it only when both dates fall within a grace period',
        'Require an explicit override approval for this scenario',
      ],
    },
  ], profile);

  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, 'Is this permissible?');
  assert.match(questions[0].details ?? '', /service case or work order/i);
  assert.match(questions[0].details ?? '', /end of service date/i);
  assert.match(questions[0].suggestions[1], /Service Occurred Date/);
});

test('finalizeInitialDiscoveryQuestions returns an empty set instead of synthesizing fallback questions', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingCategoryKeys: ['context_trigger', 'business_rules'],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([], profile);

  assert.deepEqual(questions, []);
});

test('validateAndRepairInitialDiscovery rejects an empty model output when discovery is still needed', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: ['context_trigger'],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const repaired = validateAndRepairInitialDiscovery([], profile);

  assert.equal(repaired.failureReasonCode, 'question_array_empty_when_discovery_required');
  assert.deepEqual(repaired.questions, []);
});

test('broad multi-input automation asks with empty questions fail with required reason code', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: [],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const repaired = validateAndRepairInitialDiscovery([], profile);

  assert.equal(repaired.failureReasonCode, 'question_array_empty_when_discovery_required');
  assert.equal(repaired.discoveryProfile.scope, 'moderate');
  assert.equal(repaired.discoveryProfile.ambiguity, 'medium');
  assert.deepEqual(repaired.questions, []);
});

test('validateAndRepairInitialDiscovery allows explicit zero-question discovery only when the profile is fully clear', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'narrow',
    complexity: 'low',
    ambiguity: 'low',
    missingCategoryKeys: [],
    recommendedInitialCount: 0,
    followupCap: 0,
  });

  const repaired = validateAndRepairInitialDiscovery([], profile);

  assert.equal(repaired.failureReasonCode, null);
  assert.deepEqual(repaired.questions, []);
  assert.equal(allowsZeroQuestionDiscovery(repaired.discoveryProfile), true);
});

test('finalizeInitialDiscoveryQuestions preserves coherent model question and suggestion pairs', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'medium',
    missingCategoryKeys: ['business_rules'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'business_rules',
      category: 'Business Rules',
      intent: 'decision_logic',
      question: 'How much can an FSE override the proposed work order sequence?',
      suggestions: [
        'FSEs can fully reorder work orders on their own',
        'FSEs can make limited changes, but urgent work stays locked',
        'FSEs must request schedule changes through a dispatcher or manager',
        'The generated schedule is fixed and cannot be changed by the FSE',
      ],
    },
  ], profile);

  const target = questions.find((question) => question.question === 'How much can an FSE override the proposed work order sequence?');
  assert.ok(target);
  assert.deepEqual(target.suggestions, [
    'FSEs can fully reorder work orders on their own',
    'FSEs can make limited changes, but urgent work stays locked',
    'FSEs must request schedule changes through a dispatcher or manager',
    'The generated schedule is fixed and cannot be changed by the FSE',
  ]);
});

test('finalizeInitialDiscoveryQuestions preserves suggestion list without semantic dedupe', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'medium',
    missingCategoryKeys: ['functional_flow'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'functional_flow',
      category: 'Functional Flow',
      intent: 'outputs_displays',
      question: 'What output, record, or display should this produce or update?',
      suggestions: [
        'Also show a short summary so the owning team can understand the interaction quickly',
        'Also surface a concise summary for the owning team',
        'Also notify the owning team when the record is ready for follow-up',
        'Notify the owning team as soon as the record is ready',
      ],
    },
  ], profile);

  const target = questions.find((question) => question.intent === 'outputs_displays');
  assert.ok(target);
  assert.equal(target.suggestions.length, 4);
  assert.equal(target.suggestions.filter((suggestion) => /summary/i.test(suggestion)).length, 2);
  assert.equal(target.suggestions.filter((suggestion) => /notify/i.test(suggestion)).length, 2);
  assert.ok(target.suggestions.every((suggestion) => suggestion.length <= 95));
});

test('finalizeInitialDiscoveryQuestions keeps aligned scheduling suggestions instead of rewriting them into fallback policy chips', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingCategoryKeys: ['context_trigger'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'context_trigger',
      category: 'Context & Trigger',
      intent: 'trigger_event',
      question: 'Beyond "each time a new Work Order is assigned" (as per Backlog Reference 3), what other events or conditions should trigger the automatic generation or recalculation of an "optimal schedule for service" for an FSE?',
      suggestions: [
        "Changes to a Work Order's 'criticality of service' or 'due dates'",
        "Changes to an FSE's availability, skills, or 'preferred work areas'",
        'A manual request initiated by the FSE, a dispatcher, or a supervisor',
        "At a fixed interval, such as daily, at the start of an FSE's shift, or hourly",
      ],
    },
  ], profile);

  const target = questions.find((question) => question.intent === 'trigger_event');
  assert.ok(target);
  assert.doesNotMatch(target.question, /Backlog Reference/i);
  assert.doesNotMatch(target.question, /["“”'‘’]/);
  assert.deepEqual(target.suggestions, [
    "Changes to a Work Order's 'criticality of service' or 'due dates'",
    "Changes to an FSE's availability, skills, or 'preferred work areas'",
    'A manual request initiated by the FSE, a dispatcher, or a supervisor',
    "At a fixed interval, such as daily, at the start of an FSE's shift, or hourly",
  ]);
});

test('finalizeInitialDiscoveryQuestions does not invent template suggestions for an otherwise valid question with no chips', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'medium',
    missingCategoryKeys: ['functional_flow'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'functional_flow',
      category: 'Functional Flow',
      intent: 'required_inputs',
      question: 'What minimum information is needed before the case can be created?',
      suggestions: [],
    },
  ], profile);

  const target = questions.find((question) => question.question === 'What minimum information is needed before the case can be created?');
  assert.ok(target);
  assert.deepEqual(target.suggestions, []);
});

test('finalizeFollowupDiscoveryQuestions stays delta-only and respects the total question cap', () => {
  const followups = finalizeFollowupDiscoveryQuestions([
    {
      categoryKey: 'business_rules',
      category: 'Business Rules',
      intent: 'decision_logic',
      question: 'What rule should decide whether a new case is created or an existing one is reused?',
      suggestions: ['Always reuse open case', 'Always create new case', 'Reuse by caller only', 'Route for review'],
    },
    {
      categoryKey: 'business_rules',
      category: 'Business Rules',
      intent: 'conflicts_duplicates',
      question: 'What should happen if this would create a duplicate case?',
      suggestions: ['Reuse existing case', 'Create new case', 'Queue for review', 'Block creation'],
    },
    {
      categoryKey: 'state_lifecycle',
      category: 'State & Lifecycle',
      intent: 'transition_triggers',
      question: 'What event should move the case from new to assigned?',
      suggestions: ['Immediate assignment', 'Manual triage', 'Priority rule', 'No transition'],
    },
  ], {
    askedQuestions: ['What should happen if this would create a duplicate case?'],
    missingCategoryKeys: ['business_rules', 'state_lifecycle'],
    followupCap: 8,
    initialQuestionCount: 18,
  });

  assert.equal(followups.length, 2);
  assert.ok(
    followups.every((question) => question.question !== 'What should happen if this would create a duplicate case?'),
    'expected already-asked questions to be filtered out',
  );
  assert.ok(
    followups.every((question) => ['business_rules', 'state_lifecycle'].includes(question.categoryKey)),
  );
});

test('finalizeFollowupDiscoveryQuestions allows a single precise follow-up when only one gap remains', () => {
  const followups = finalizeFollowupDiscoveryQuestions([
    {
      categoryKey: 'business_rules',
      category: 'Business Rules',
      intent: 'decision_logic',
      question: 'What rule decides whether a phone or WhatsApp interaction creates a new case or updates an existing one?',
      suggestions: ['Always create a new case', 'Reuse the open case', 'Review uncertain matches', 'Different rules by channel'],
    },
  ], {
    askedQuestions: [],
    missingCategoryKeys: ['business_rules'],
    followupCap: 1,
    initialQuestionCount: 18,
  });

  assert.equal(followups.length, 1);
  assert.match(followups[0].question, /phone|whatsapp|case/i);
});

test('buildArSystemPrompt explicitly pushes concrete business clauses over vague placeholders', () => {
  const prompt = buildArSystemPrompt({
    domainContext: 'Keep output business-facing.',
    arPlan: {
      min: 2,
      max: 5,
      target: 3,
      depth: 'standard',
    },
  });

  assert.match(prompt, /avoid vague placeholders such as "is processed"/i);
  assert.match(prompt, /preserve them in business language/i);
  assert.match(prompt, /concise is good only when the business condition, trigger, and outcome remain concrete/i);
});

test('buildArRepairSystemPrompt keeps AR repair scoped and meaning-preserving', () => {
  const prompt = buildArRepairSystemPrompt({
    domainContext: 'Stay product agnostic.',
  });

  assert.match(prompt, /Preserve the feature summary, description, suggested_story_points, and process_code unless a trivial typo fix is unavoidable/i);
  assert.match(prompt, /expand weak AR wording into concrete business conditions, triggers, and outcomes/i);
  assert.match(prompt, /Do not invent domain-specific logic, product-specific categories, or internal implementation mechanisms/i);
});

test('buildArPerFeatureUserMessage includes AR obligations and repair focus when provided', () => {
  const message = buildArPerFeatureUserMessage({
    requirement: 'Create cases automatically from inbound support emails.',
    feature: {
      summary: 'Automatically create new cases from incoming emails',
      description: 'As a Technical Support Specialist, I need new cases created from qualifying inbound emails so that intake work is not manual.',
    },
    arObligations: {
      confirmedOutcomes: ['Classify each created case as either a product issue or a general inquiry.'],
      confirmedExclusions: ['Do not create a case from unwanted automated email.'],
      confirmedDataObligations: ['Carry the inbound message content into the created case.'],
      unresolvedDecisions: ['If classification remains ambiguous, do not invent a new category.'],
    },
    currentAcceptanceRequirements: [
      'GIVEN an inbound email qualifies WHEN it is received THEN a case is created',
    ],
    repairReasons: [
      'Avoid vague wording like "is processed".',
    ],
  });

  assert.match(message, /AR OBLIGATIONS:/);
  assert.match(message, /CURRENT ACCEPTANCE REQUIREMENTS:/);
  assert.match(message, /REPAIR FOCUS:/);
});

test('finalizeFollowupDiscoveryQuestions drops obviously truncated follow-up questions', () => {
  const followups = finalizeFollowupDiscoveryQuestions([
    {
      categoryKey: 'user_personas',
      category: 'User Personas',
      intent: 'permissions_scope',
      question: "When a Field Service Manager or Dispatcher overrides an FSE'",
      suggestions: ['Managers can override', 'Dispatch can override', 'Only admins can override', 'No override path'],
    },
  ], {
    askedQuestions: [],
    missingCategoryKeys: ['user_personas'],
    followupCap: 1,
    initialQuestionCount: 8,
  });

  assert.deepEqual(followups, []);
});

test('finalizeFollowupDiscoveryQuestions does not invent a generic fallback question when follow-up candidates are empty', () => {
  const followups = finalizeFollowupDiscoveryQuestions([], {
    askedQuestions: [],
    missingCategoryKeys: ['business_rules'],
    followupCap: 1,
    initialQuestionCount: 6,
  });

  assert.deepEqual(followups, []);
});

test('discovery prompts enforce the fixed taxonomy and short-question contract with domain fidelity', () => {
  const triagePrompt = buildTriageSystemPrompt();
  const clarifyPrompt = buildClarifySystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
    domainRoles: ['TSS', 'Supervisor'],
  });
  const evaluatePrompt = buildEvaluateSystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
    domainRoles: ['TSS', 'Supervisor'],
    minQuestions: 1,
    maxQuestions: 4,
  });

  assert.doesNotMatch(clarifyPrompt, /system-agnostic/i);
  assert.match(clarifyPrompt, /context_trigger/);
  assert.match(clarifyPrompt, /user_personas/);
  assert.match(clarifyPrompt, /functional_flow/);
  assert.match(clarifyPrompt, /business_rules/);
  assert.match(clarifyPrompt, /state_lifecycle/);
  assert.match(clarifyPrompt, /success_measurement/);
  assert.match(clarifyPrompt, /categoryKey/);
  assert.match(clarifyPrompt, /intent/);
  assert.match(clarifyPrompt, /Prefer one visible question per main business decision/i);
  assert.match(clarifyPrompt, /principal business analyst running a structured discovery session/i);
  assert.match(clarifyPrompt, /The question field should be short and plain-language/i);
  assert.match(clarifyPrompt, /optional details field/i);
  assert.match(clarifyPrompt, /Do not genericize domain-rich wording into vague terms/i);
  assert.match(clarifyPrompt, /Include up to 3 short, grounded answer suggestions per question/i);
  assert.match(clarifyPrompt, /Reuse concrete nouns from the requirement when they make the question sharper/i);
  assert.match(clarifyPrompt, /Never write questions in first person/i);
  assert.match(clarifyPrompt, /INITIAL ROUND SIZE/i);
  assert.match(clarifyPrompt, /suggestions should be included for most questions/i);
  assert.match(clarifyPrompt, /Do NOT output free-form category labels like "TRIGGER \/ CONTEXT & INPUTS"/i);
  assert.match(clarifyPrompt, /Known roles in this domain/i);
  assert.match(clarifyPrompt, /Return JSON in this shape/i);
  assert.match(clarifyPrompt, /recommendedInitialCount/i);
  assert.doesNotMatch(clarifyPrompt, /profileReasoning/i);
  assert.doesNotMatch(clarifyPrompt, /must equal the number of questions you return/i);
  assert.doesNotMatch(clarifyPrompt, /bundle 2-4 tightly related sub-prompts/i);
  assert.doesNotMatch(clarifyPrompt, /Provide exactly 4 suggestions per question/i);

  assert.match(evaluatePrompt, /DELTA questions/i);
  assert.match(evaluatePrompt, /Ask however many follow-up questions are materially needed/i);
  assert.match(evaluatePrompt, /missingCategoryKeys/);
  assert.match(evaluatePrompt, /Prefer one visible follow-up question per remaining business gap/i);
  assert.match(evaluatePrompt, /Follow-up suggestions are optional/i);
  assert.match(evaluatePrompt, /provide 1-3 short grounded options/i);
  assert.match(evaluatePrompt, /If the requirement already names the actor, business object, or workflow in a clear way/i);
  assert.match(evaluatePrompt, /Reuse concrete business nouns/i);
  assert.match(evaluatePrompt, /optional "details" field/i);
  assert.match(evaluatePrompt, /Preserve the domain wording already present/i);
  assert.doesNotMatch(evaluatePrompt, /system-agnostic/i);
  assert.doesNotMatch(evaluatePrompt, /grouped follow-up questions/i);
  assert.doesNotMatch(evaluatePrompt, /Provide exactly 4 suggestions per follow-up question/i);

  assert.doesNotMatch(triagePrompt, /\bSAP\b/i);
  assert.doesNotMatch(triagePrompt, /\bServiceMax\b/i);
  assert.match(triagePrompt, /Short capability-area asks that name a workflow domain without stating its rules, actors, or decision logic are often HIGH complexity/i);
  assert.match(triagePrompt, /Short but capability-heavy workflow area/i);
  assert.match(triagePrompt, /same guard rule applies to two closely related work item types/i);
  assert.doesNotMatch(triagePrompt, /timesheets|payroll|support tickets|order status|billing details|customer onboarding/i);
});

test('decomposition prompt treats features as independently valuable and keeps support behavior inside the parent feature', () => {
  const prompt = buildDecompositionSystemPrompt({
    domainContext: 'Use context only to understand the business space.',
    domainRoles: ['Manager'],
    processTaxonomy: [],
    processTaxonomyEnabled: false,
  });

  assert.match(prompt, /independent business value/i);
  assert.match(prompt, /similar stories, work instructions, or domain context/i);
  assert.match(prompt, /work instructions or operational guidance/i);
  assert.match(prompt, /Surface independently valuable business capabilities without inventing micro-features/i);
  assert.match(prompt, /do not hide meaningful workflow branches inside one oversized feature/i);
  assert.doesNotMatch(prompt, /Output exactly/i);
});

test('story assistant clarify prompt asks every genuinely ambiguous question without small-screen budgeting language', () => {
  const prompt = buildStoryAssistantClarifySystemPrompt({
    domainContext: '',
    domainRoles: [],
    questionPlan: { min: 8, max: 12, target: 10 },
  });

  assert.match(prompt, /Ask as many questions as needed/i);
  assert.match(prompt, /For each area, ask every question that is genuinely ambiguous/i);
  assert.match(prompt, /Roles & Personas/i);
  assert.match(prompt, /Trigger & Context/i);
  assert.match(prompt, /Business Rules & Exceptions/i);
  assert.match(prompt, /provide 3 or 4 grounded suggestions/i);
  assert.match(prompt, /specific enough to help the user answer/i);
  assert.match(prompt, /Return ONLY a JSON array/i);
  assert.doesNotMatch(prompt, /intentionally small/i);
  assert.doesNotMatch(prompt, /first screen/i);
  assert.doesNotMatch(prompt, /QUESTION VOLUME GUIDANCE/i);
});

test('story assistant sufficiency prompt limits follow-up discovery to one small delta round', () => {
  const prompt = buildStoryAssistantSufficiencySystemPrompt({
    domainContext: '',
    domainRoles: [],
  });

  assert.match(prompt, /Ask exactly 1 or 2 follow-up questions/i);
  assert.match(prompt, /Each follow-up question must include 2 to 4 grounded suggestions/i);
  assert.match(prompt, /If the current answers are sufficient, return \{"sufficient": true\}/i);
  assert.match(prompt, /Return ONLY valid JSON/i);
});

test('story assistant ar prompt avoids mechanical role repetition and use-case filler', () => {
  const prompt = buildStoryAssistantArSystemPrompt({
    domainContext: '',
    domainRoles: [],
  });

  assert.match(prompt, /Avoid repeating the same role label in every AR/i);
  assert.match(prompt, /Keep broad use-case narration and business-benefit phrasing out of ARs/i);
});

test('story assistant default pipeline flag is enabled unless legacy mode is explicitly forced', () => {
  assert.equal(useStoryAssistantDefaultPipeline(DEFAULT_CONFIG), true);
  assert.equal(useStoryAssistantDefaultPipeline({
    ...DEFAULT_CONFIG,
    pipelineFlags: {
      storyAssistantDefaultPipeline: true,
      legacyLlmLedPipeline: true,
      advancedGroundingEnabled: false,
    },
  }), false);
  assert.equal(useStoryAssistantDefaultPipeline({
    ...DEFAULT_CONFIG,
    pipelineFlags: {
      storyAssistantDefaultPipeline: false,
      legacyLlmLedPipeline: false,
      advancedGroundingEnabled: false,
    },
  }), false);
});

test('ar prompt uses range guidance without exact-count pressure', () => {
  const prompt = buildArSystemPrompt({
    domainContext: 'Use context only to reason about business behavior.',
    arPlan: {
      min: 1,
      max: 5,
      target: 3,
      depth: 'standard',
    },
  });

  assert.match(prompt, /Let the feature's actual behavioral surface determine how many acceptance requirements are needed/i);
  assert.match(prompt, /Do not target a fixed count for its own sake/i);
  assert.match(prompt, /Prefer fewer ARs when one concise set fully covers the feature/i);
  assert.match(prompt, /work-instruction guidance/i);
  assert.match(prompt, /state transitions, preconditions, exception behavior, and downstream impacts/i);
  assert.doesNotMatch(prompt, /\(target 3\)/i);
  assert.doesNotMatch(prompt, /roughly 1-5 acceptance requirements/i);
});

test('sizing prompts calibrate consolidation around independently valuable scope', () => {
  const assessmentPrompt = buildSizingAssessmentSystemPrompt();
  const repairPrompt = buildSizingRepairSystemPrompt({
    domainContext: 'Use context only to reason about business scope.',
    processTaxonomy: [],
    processTaxonomyEnabled: false,
  });

  assert.match(assessmentPrompt, /If the same guard rule applies to two closely related work item types, that does NOT automatically require separate features/i);
  assert.match(assessmentPrompt, /Supporting visibility, audit, notification, policy-definition, reason capture, and override behavior usually belong inside the parent feature/i);
  assert.match(repairPrompt, /Prefer a well-scoped set of strong, independently valuable features/i);
  assert.match(repairPrompt, /Merge sibling features when they express the same core rule/i);
  assert.match(repairPrompt, /Preserve workflow splits only when they are explicitly supported by the requirement or clarifying answers/i);
  assert.match(repairPrompt, /Do not use domain expectations, generic best practices, or organizational heuristics as a reason to create or preserve separate features/i);
});

test('generation fallback is operational only when triage is unavailable', () => {
  assert.deepEqual(DEFAULT_GENERATION_TRIAGE_FALLBACK.deliveryForecast, {
    shape: 'minimal',
    complexity: 'low',
    featureTarget: 1,
    featureMin: 1,
    featureMax: 1,
    arDepth: 'standard',
    arTarget: 0,
  });
  assert.deepEqual(DEFAULT_GENERATION_TRIAGE_FALLBACK.discoveryForecast, {
    scope: 'narrow',
    complexity: 'low',
    ambiguity: 'medium',
    recommendedInitialCount: 0,
    followupCap: 0,
  });
  assert.equal(DEFAULT_GENERATION_TRIAGE_FALLBACK.telemetry?.fallbackUsed, true);
});

test('decomposition prompt preserves workflow-defining scope when clarifying context is thin', () => {
  const prompt = buildDecompositionSystemPrompt({
    domainContext: 'Use context only to understand the business space.',
    domainRoles: ['TSS'],
    processTaxonomy: [],
    processTaxonomyEnabled: false,
    clarifyAnswerCount: 0,
  });

  assert.match(prompt, /Clarifying context is still THIN or incomplete/i);
  assert.match(prompt, /Do not silently compress away workflow-defining ambiguity/i);
  assert.match(prompt, /multi-step workflows, decision logic, actor-specific handling paths, state transitions, or exception behavior/i);
  assert.match(prompt, /work instructions are present in the user message/i);
});

test('per-feature AR prompt includes work instructions and clarifying context', () => {
  const message = buildArPerFeatureUserMessage({
    requirement: 'As a TSS, I need a single way to manage incoming communication channels and create cases from it',
    clarifyAnswers: [
      {
        question: 'How should the system decide whether to create a new case or link to an existing one?',
        answer: 'Use the customer identifier and open-case match first, and send uncertain matches for manual review.',
        selectedSuggestions: ['Use the customer identifier first'],
        categoryKey: 'business_rules',
        intent: 'decision_logic',
      },
    ],
    wiContextText: 'If a serial number is missing, the communication must be queued for manual review before case creation. Case type is determined by communication intent and customer segment.',
    similarStoriesText: 'A related backlog item linked incoming customer messages to an existing service request.',
    feature: {
      summary: 'Triage incoming communications',
      description: 'As a Technical Support Specialist, I need to triage incoming communications so that customer cases are handled correctly.',
    },
  });

  assert.match(message, /WORK INSTRUCTIONS \/ OPERATIONAL GUIDANCE/i);
  assert.match(message, /\[business_rules \| decision_logic\]/i);
  assert.match(message, /Selected signals: Use the customer identifier first/i);
  assert.match(message, /serial number is missing/i);
  assert.match(message, /manual review/i);
  assert.match(message, /RELATED BACKLOG CONTEXT/i);
});

test('coverage prompts require WI-backed workflow branches to be checked and repaired', () => {
  const checkPrompt = buildCoverageCheckSystemPrompt({
    domainContext: 'Use context only for business scope.',
  });
  const repairPrompt = buildCoverageRepairSystemPrompt({
    domainContext: 'Use context only for business scope.',
    processTaxonomyEnabled: false,
  });

  assert.match(checkPrompt, /work-instruction or operational guidance/i);
  assert.match(checkPrompt, /Treat work instructions as higher-authority operational guidance/i);
  assert.match(checkPrompt, /required data inputs and outputs/i);
  assert.match(checkPrompt, /exception handling and fallback paths/i);
  assert.match(repairPrompt, /Prefer enriching the existing feature description and acceptance requirements/i);
  assert.match(repairPrompt, /Treat clarified answers and work instructions in the user message as obligations to cover/i);
});

test('add requirements prompt keeps canvas changes append-only and feature-local', () => {
  const prompt = buildAddRequirementsSystemPrompt({
    domainContext: 'Use context only for business scope.',
    processTaxonomy: [],
    processTaxonomyEnabled: false,
  });

  assert.match(prompt, /Return EXACTLY ONE feature in the features array/i);
  assert.match(prompt, /Do not create a new feature/i);
  assert.match(prompt, /Keep every existing acceptance requirement in the same relative order/i);
  assert.match(prompt, /Append only the additional acceptance requirements needed/i);
});
