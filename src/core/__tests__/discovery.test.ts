import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allowsZeroQuestionDiscovery,
  calibrateDiscoveryProfile,
  expandRawQuestionCandidate,
  finalizeFollowupDiscoveryQuestions,
  finalizeInitialDiscoveryQuestions,
  normalizeDiscoveryProfile,
  validateAndRepairInitialDiscovery,
} from '../discovery';
import {
  buildArSystemPrompt,
  buildArPerFeatureUserMessage,
  buildClarifySystemPrompt,
  buildCoverageCheckSystemPrompt,
  buildCoverageRepairSystemPrompt,
  buildDecompositionSystemPrompt,
  buildEvaluateSystemPrompt,
  buildSizingAssessmentSystemPrompt,
  buildSizingRepairSystemPrompt,
  buildTriageSystemPrompt,
} from '../prompts';
import { DEFAULT_GENERATION_TRIAGE_FALLBACK } from '../story-generator';

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

test('expandRawQuestionCandidate splits numbered grouped prompts into single-focus questions', () => {
  const questions = expandRawQuestionCandidate({
    category: 'Context & Trigger',
    intent: 'trigger_and_inputs',
    question: 'For case creation, 1. what exact event should trigger the flow, 2. what data must already be present, and 3. when should the interaction wait for manual review instead?',
    suggestions: [
      'Start automatically once the interaction reaches a usable handoff point and the core details are present',
      'Start only after identity or enough context has been confirmed by the team',
      'Hold the flow for manual review when the trigger is ambiguous or key context is missing',
      'Apply different trigger rules by channel, but make the exclusion path explicit',
    ],
  });

  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((question) => question.categoryKey),
    ['context_trigger', 'context_trigger', 'context_trigger'],
  );
  assert.deepEqual(
    questions.map((question) => question.question),
    [
      'For case creation what event should trigger the flow?',
      'For case creation what data must already be present?',
      'For case creation when should the interaction wait for manual review instead?',
    ],
  );
  assert.equal(questions[0].intent, 'trigger_and_inputs');
  assert.equal(questions[0].details, undefined);
  assert.ok(questions[1].intent.startsWith('trigger_and_inputs_part_'));
  assert.ok(questions[2].intent.startsWith('trigger_and_inputs_part_'));
  assert.deepEqual(
    questions.map((question) => question.suggestions),
    [
      [
        'Start automatically once the interaction reaches a usable handoff point and the core details are present',
        'Start only after identity or enough context has been confirmed by the team',
        'Hold the flow for manual review when the trigger is ambiguous or key context is missing',
        'Apply different trigger rules by channel, but make the exclusion path explicit',
      ],
      [
        'Start automatically once the interaction reaches a usable handoff point and the core details are present',
        'Start only after identity or enough context has been confirmed by the team',
        'Hold the flow for manual review when the trigger is ambiguous or key context is missing',
        'Apply different trigger rules by channel, but make the exclusion path explicit',
      ],
      [
        'Start automatically once the interaction reaches a usable handoff point and the core details are present',
        'Start only after identity or enough context has been confirmed by the team',
        'Hold the flow for manual review when the trigger is ambiguous or key context is missing',
        'Apply different trigger rules by channel, but make the exclusion path explicit',
      ],
    ],
  );
});

test('finalizeInitialDiscoveryQuestions preserves the llm question set without padding', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingCategoryKeys: ['user_personas', 'edge_cases_exceptions'],
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
  ], profile, {
    requirement: 'Automatically create a support case from calls and messages, while avoiding duplicates and handling missing caller details.',
  });

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
  ], profile, {
    requirement: 'Clarify whether service cases and work orders remain valid when the product passes end of service.',
  });

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

  const questions = finalizeInitialDiscoveryQuestions([], profile, {
    requirement: 'Automatically assign service contract sales opportunities to the appropriate sales rep.',
  });

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

  const repaired = validateAndRepairInitialDiscovery([], profile, {
    requirement: 'As a TSS, I need to manage various input channels and have cases created automatically.',
  });

  assert.equal(repaired.failureReasonCode, 'invalid_empty_questions');
  assert.deepEqual(repaired.questions, []);
});

test('calibrateDiscoveryProfile preserves the llm question count while raising scope metadata from taxonomy breadth', () => {
  const calibrated = calibrateDiscoveryProfile(normalizeDiscoveryProfile({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: [
      'context_trigger',
      'user_personas',
      'information_architecture',
      'business_rules',
      'state_lifecycle',
      'edge_cases_exceptions',
    ],
    recommendedInitialCount: 7,
    followupCap: 4,
  }), {
    requiredCategoryKeys: [
      'context_trigger',
      'user_personas',
      'information_architecture',
      'business_rules',
      'state_lifecycle',
      'edge_cases_exceptions',
    ],
    repairApplied: true,
    repairedQuestionCount: 10,
  });

  assert.equal(calibrated.scope, 'moderate');
  assert.equal(calibrated.complexity, 'medium');
  assert.equal(calibrated.ambiguity, 'medium');
  assert.equal(calibrated.recommendedInitialCount, 10);
});

test('calibrateDiscoveryProfile does not inflate implementation complexity solely from discovery breadth', () => {
  const calibrated = calibrateDiscoveryProfile(normalizeDiscoveryProfile({
    scope: 'narrow',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: [
      'context_trigger',
      'user_personas',
      'information_architecture',
      'business_rules',
      'state_lifecycle',
      'edge_cases_exceptions',
    ],
    recommendedInitialCount: 6,
    followupCap: 4,
  }), {
    requiredCategoryKeys: [
      'context_trigger',
      'user_personas',
      'information_architecture',
      'business_rules',
      'state_lifecycle',
      'edge_cases_exceptions',
    ],
    repairApplied: false,
    repairedQuestionCount: 6,
  });

  assert.equal(calibrated.scope, 'narrow');
  assert.equal(calibrated.complexity, 'medium');
  assert.equal(calibrated.ambiguity, 'medium');
});

test('broad multi-input automation asks still infer unresolved discovery categories without synthesizing questions', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: [],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const repaired = validateAndRepairInitialDiscovery([], profile, {
    requirement: 'As a TSS, I need to be able to manage my various input channels efficiently (phone, whatsapp, text, email) and have cases created from it automatically',
  });

  assert.equal(repaired.failureReasonCode, 'invalid_empty_questions');
  assert.ok(repaired.discoveryProfile.missingCategoryKeys.length >= 5);
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
  ], profile, {
    requirement: 'An FSE must be provided an optimal schedule for service based on criticality and due dates.',
  });

  const target = questions.find((question) => question.question === 'How much can an FSE override the proposed work order sequence?');
  assert.ok(target);
  assert.deepEqual(target.suggestions, [
    'FSEs can fully reorder work orders on their own',
    'FSEs can make limited changes, but urgent work stays locked',
    'FSEs must request schedule changes through a dispatcher or manager',
    'The generated schedule is fixed and cannot be changed by the FSE',
  ]);
});

test('finalizeInitialDiscoveryQuestions collapses overlapping suggestions into distinct alternatives', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'medium',
    missingCategoryKeys: ['information_architecture'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'information_architecture',
      category: 'Information Architecture',
      intent: 'outputs_displays',
      question: 'What output, record, or display should this produce or update?',
      suggestions: [
        'Also show a short summary so the owning team can understand the interaction quickly',
        'Also surface a concise summary for the owning team',
        'Also notify the owning team when the record is ready for follow-up',
        'Notify the owning team as soon as the record is ready',
      ],
    },
  ], profile, {
    requirement: 'Create or update support cases from phone, WhatsApp, text, and email interactions.',
  });

  const target = questions.find((question) => question.intent === 'outputs_displays');
  assert.ok(target);
  assert.ok(target.suggestions.length >= 2 && target.suggestions.length <= 3);
  assert.equal(target.suggestions.filter((suggestion) => /summary/i.test(suggestion)).length, 1);
  assert.equal(target.suggestions.filter((suggestion) => /notify/i.test(suggestion)).length, 1);
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
  ], profile, {
    requirement: 'An FSE must be provided an optimal schedule for service based on the criticality of service and due dates.',
  });

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
    missingCategoryKeys: ['information_architecture'],
    recommendedInitialCount: 4,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      categoryKey: 'information_architecture',
      category: 'Information Architecture',
      intent: 'required_inputs',
      question: 'What minimum information is needed before the case can be created?',
      suggestions: [],
    },
  ], profile, {
    requirement: 'Create a case automatically from a phone or WhatsApp interaction.',
  });

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
      categoryKey: 'edge_cases_exceptions',
      category: 'Edge Cases & Exceptions',
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
    missingCategoryKeys: ['business_rules', 'edge_cases_exceptions', 'state_lifecycle'],
    followupCap: 8,
    initialQuestionCount: 18,
  });

  assert.equal(followups.length, 2);
  assert.ok(
    followups.every((question) => question.question !== 'What should happen if this would create a duplicate case?'),
    'expected already-asked questions to be filtered out',
  );
  assert.ok(
    followups.every((question) => ['business_rules', 'edge_cases_exceptions', 'state_lifecycle'].includes(question.categoryKey)),
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
    fallbackInput: {
      requirement: 'Automatically create support cases from phone and WhatsApp interactions.',
    },
  });

  assert.equal(followups.length, 1);
  assert.match(followups[0].question, /phone|whatsapp|case/i);
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
    fallbackInput: {
      requirement: 'An FSE must be provided an optimal schedule for service based on criticality and due dates.',
    },
  });

  assert.deepEqual(followups, []);
});

test('discovery prompts enforce the fixed taxonomy and short-question contract with domain fidelity', () => {
  const triagePrompt = buildTriageSystemPrompt();
  const clarifyPrompt = buildClarifySystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
    domainRoles: ['TSS', 'Supervisor'],
    domainSignals: ['phone', 'WhatsApp', 'case creation'],
    questionPlan: { min: 4, max: 6, target: 5 },
  });
  const evaluatePrompt = buildEvaluateSystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
    domainRoles: ['TSS', 'Supervisor'],
    domainSignals: ['phone', 'WhatsApp', 'case creation'],
    minQuestions: 1,
    maxQuestions: 4,
  });

  assert.doesNotMatch(clarifyPrompt, /system-agnostic/i);
  assert.match(clarifyPrompt, /context_trigger/);
  assert.match(clarifyPrompt, /user_personas/);
  assert.match(clarifyPrompt, /information_architecture/);
  assert.match(clarifyPrompt, /business_rules/);
  assert.match(clarifyPrompt, /state_lifecycle/);
  assert.match(clarifyPrompt, /edge_cases_exceptions/);
  assert.match(clarifyPrompt, /categoryKey/);
  assert.match(clarifyPrompt, /intent/);
  assert.match(clarifyPrompt, /Prefer one visible question per main business decision/i);
  assert.match(clarifyPrompt, /principal business analyst running a structured discovery session/i);
  assert.match(clarifyPrompt, /visible "question" field must be short and plain-language first/i);
  assert.match(clarifyPrompt, /optional "details" field/i);
  assert.match(clarifyPrompt, /Preserve requirement-native domain wording/i);
  assert.match(clarifyPrompt, /Provide exactly 4 suggestions per question/i);
  assert.match(clarifyPrompt, /If the requirement already names the actor, business object, or workflow in a clear way/i);
  assert.match(clarifyPrompt, /Never write discovery questions in first person/i);
  assert.match(clarifyPrompt, /normalize the question voice into third-person business language/i);
  assert.match(clarifyPrompt, /What should the TSS do when/i);
  assert.match(clarifyPrompt, /Keep the suggestions aligned to the actual question being asked/i);
  assert.match(clarifyPrompt, /Do NOT output free-form category labels like "TRIGGER \/ CONTEXT & INPUTS"/i);
  assert.match(clarifyPrompt, /Known roles in this domain/i);
  assert.match(clarifyPrompt, /Important domain signals from the requirement and supporting evidence/i);
  assert.match(clarifyPrompt, /Reuse these concrete business terms/i);
  assert.match(clarifyPrompt, /company-specific internal terms/i);
  assert.match(clarifyPrompt, /Return however many questions are materially needed/i);
  assert.match(clarifyPrompt, /Simplify syntax, not business meaning/i);
  assert.doesNotMatch(clarifyPrompt, /bundle 2-4 tightly related sub-prompts/i);
  assert.doesNotMatch(clarifyPrompt, /Provide 2-3 suggestions by default/i);

  assert.match(evaluatePrompt, /DELTA questions/i);
  assert.match(evaluatePrompt, /Ask however many follow-up questions are materially needed/i);
  assert.match(evaluatePrompt, /missingCategoryKeys/);
  assert.match(evaluatePrompt, /Prefer one visible follow-up question per remaining business gap/i);
  assert.match(evaluatePrompt, /Provide exactly 4 suggestions per follow-up question/i);
  assert.match(evaluatePrompt, /If the requirement already names the actor, business object, or workflow in a clear way/i);
  assert.match(evaluatePrompt, /medium-length starter answers/i);
  assert.match(evaluatePrompt, /Reuse concrete business nouns/i);
  assert.match(evaluatePrompt, /optional "details" field/i);
  assert.match(evaluatePrompt, /Preserve the domain wording already present/i);
  assert.doesNotMatch(evaluatePrompt, /system-agnostic/i);
  assert.doesNotMatch(evaluatePrompt, /grouped follow-up questions/i);
  assert.doesNotMatch(evaluatePrompt, /Provide 2-3 suggestions per follow-up question by default/i);

  assert.doesNotMatch(triagePrompt, /\bSAP\b/i);
  assert.doesNotMatch(triagePrompt, /\bServiceMax\b/i);
  assert.match(triagePrompt, /Short capability-area asks that name a workflow domain without stating its rules, actors, or decision logic are often HIGH complexity/i);
  assert.match(triagePrompt, /Short but capability-heavy workflow area/i);
  assert.match(triagePrompt, /same guard rule applies to two closely related work item types/i);
});

test('decomposition prompt treats feature counts as hints and keeps support behavior inside the parent feature', () => {
  const prompt = buildDecompositionSystemPrompt({
    domainContext: 'Use context only to understand the business space.',
    domainRoles: ['Manager'],
    processTaxonomy: [],
    processTaxonomyEnabled: false,
    featurePlan: {
      min: 1,
      max: 4,
      target: 2,
      shape: 'narrow',
      complexity: 'medium',
    },
  });

  assert.match(prompt, /planning hint/i);
  assert.match(prompt, /reasoning context, not as a quota or upper bound/i);
  assert.match(prompt, /independent business value/i);
  assert.match(prompt, /similar stories, work instructions, or domain context/i);
  assert.match(prompt, /work instructions or operational guidance/i);
  assert.match(prompt, /notification, status definition, audit trail, exception diagnosis, or visibility aid/i);
  assert.match(prompt, /Surface independently valuable feature slices without inventing micro-features/i);
  assert.match(prompt, /do not hide meaningful workflow branches inside one oversized feature/i);
  assert.doesNotMatch(prompt, /Output exactly/i);
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
  assert.deepEqual(DEFAULT_GENERATION_TRIAGE_FALLBACK.featurePlan, {
    min: 1,
    max: 1,
    target: 1,
    shape: 'minimal',
    complexity: 'low',
  });
  assert.deepEqual(DEFAULT_GENERATION_TRIAGE_FALLBACK.arPlan, {
    min: 0,
    max: 0,
    target: 0,
    depth: 'standard',
  });
  assert.deepEqual(DEFAULT_GENERATION_TRIAGE_FALLBACK.questionPlan, {
    min: 0,
    max: 0,
    target: 0,
    clarity: 'medium',
  });
});

test('decomposition prompt preserves workflow-defining scope when clarifying context is thin', () => {
  const prompt = buildDecompositionSystemPrompt({
    domainContext: 'Use context only to understand the business space.',
    domainRoles: ['TSS'],
    processTaxonomy: [],
    processTaxonomyEnabled: false,
    clarifyAnswerCount: 0,
    featurePlan: {
      min: 1,
      max: 4,
      target: 2,
      shape: 'narrow',
      complexity: 'high',
    },
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
