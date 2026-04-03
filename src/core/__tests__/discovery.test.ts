import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrateDiscoveryProfile,
  expandRawQuestionCandidate,
  finalizeFollowupDiscoveryQuestions,
  finalizeInitialDiscoveryQuestions,
  MAX_TOTAL_DISCOVERY_QUESTIONS,
  normalizeDiscoveryProfile,
  validateAndRepairInitialDiscovery,
} from '../discovery';
import { buildClarifySystemPrompt, buildEvaluateSystemPrompt } from '../prompts';

test('normalizeDiscoveryProfile clamps counts into the supported range', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'very_broad',
    complexity: 'very_high',
    ambiguity: 'high',
    missingCategoryKeys: ['business_rules', 'context_trigger'],
    recommendedInitialCount: 14,
    followupCap: 11,
  });

  assert.equal(profile.recommendedInitialCount, 12);
  assert.equal(profile.followupCap, 8);
  assert.deepEqual(profile.missingCategoryKeys, ['context_trigger', 'business_rules']);
});

test('normalizeDiscoveryProfile respects the lower discovery floors for clear asks', () => {
  const profile = normalizeDiscoveryProfile({
    recommendedInitialCount: 2,
    followupCap: 0,
  });

  assert.equal(profile.recommendedInitialCount, 4);
  assert.equal(profile.followupCap, 1);
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

test('finalizeInitialDiscoveryQuestions fills required BA taxonomy categories when unresolved', () => {
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

  assert.equal(questions.length, 6);
  assert.ok(
    questions.some((question) => question.categoryKey === 'user_personas'),
    'expected unresolved user personas coverage',
  );
  assert.ok(
    questions.some((question) => question.categoryKey === 'edge_cases_exceptions'),
    'expected unresolved exceptions coverage',
  );
  assert.ok(
    questions.some((question) => question.categoryKey === 'information_architecture'),
    'expected data/input coverage for captured fields',
  );
});

test('validateAndRepairInitialDiscovery repairs an empty model output into a valid initial batch', () => {
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

  assert.equal(repaired.failureReasonCode, null);
  assert.ok(repaired.questions.length >= 4);
  assert.ok(repaired.questions.some((question) => question.categoryKey === 'context_trigger'));
  assert.ok(repaired.questions.some((question) => question.categoryKey === 'user_personas'));
  assert.ok(repaired.questions.some((question) => question.categoryKey === 'business_rules'));
  assert.ok(repaired.questions.some((question) => question.categoryKey === 'state_lifecycle'));
});

test('calibrateDiscoveryProfile raises broad vague discovery floors from taxonomy breadth', () => {
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

  assert.equal(calibrated.scope, 'very_broad');
  assert.equal(calibrated.complexity, 'very_high');
  assert.equal(calibrated.ambiguity, 'high');
  assert.ok(calibrated.recommendedInitialCount >= 8);
});

test('broad multi-input automation asks infer a non-trivial unresolved-category set', () => {
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

  assert.equal(repaired.failureReasonCode, null);
  assert.ok(repaired.discoveryProfile.missingCategoryKeys.length >= 5);
  assert.ok(['broad', 'very_broad'].includes(repaired.discoveryProfile.scope));
  assert.equal(repaired.discoveryProfile.ambiguity, 'high');
  assert.ok(repaired.questions.length >= 6);
});

test('validateAndRepairInitialDiscovery uses contextual fallback questions and suggestions for multichannel case creation', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'moderate',
    complexity: 'medium',
    ambiguity: 'medium',
    missingCategoryKeys: [],
    recommendedInitialCount: 6,
    followupCap: 4,
  });

  const repaired = validateAndRepairInitialDiscovery([], profile, {
    requirement: 'As a TSS, I need to manage phone, WhatsApp, text, and email interactions and have cases created automatically while avoiding duplicates.',
  });

  const renderedQuestions = repaired.questions.map((question) => question.question).join(' | ');
  const renderedSuggestions = repaired.questions.flatMap((question) => question.suggestions).join(' | ');

  assert.match(renderedQuestions, /phone|whatsapp|text|email/i);
  assert.match(renderedQuestions, /case/i);
  assert.match(renderedSuggestions, /phone|whatsapp|text|email|case/i);
  assert.ok(repaired.questions.every((question) => !question.question.includes('1.')));
  assert.ok(repaired.questions.every((question) => question.suggestions.length >= 2 && question.suggestions.length <= 4));
  assert.ok(repaired.questions.some((question) => question.suggestions.some((suggestion) => suggestion.length > 30 && suggestion.length < 96)));
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

  assert.equal(followups.length, MAX_TOTAL_DISCOVERY_QUESTIONS - 18);
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

test('discovery prompts enforce the fixed taxonomy and distinct-answer discovery contract', () => {
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
  assert.match(clarifyPrompt, /plain-language answer options/i);
  assert.match(clarifyPrompt, /Provide 2-3 suggestions by default/i);
  assert.match(clarifyPrompt, /Avoid quotes, parenthetical evidence references/i);
  assert.match(clarifyPrompt, /Ask for a business choice or policy direction/i);
  assert.match(clarifyPrompt, /Keep the suggestions aligned to the actual question being asked/i);
  assert.match(clarifyPrompt, /Do NOT output free-form category labels like "TRIGGER \/ CONTEXT & INPUTS"/i);
  assert.match(clarifyPrompt, /Known roles in this domain/i);
  assert.match(clarifyPrompt, /Important domain signals/i);
  assert.match(clarifyPrompt, /Reuse these concrete business terms/i);
  assert.match(clarifyPrompt, /company-specific internal terms/i);
  assert.doesNotMatch(clarifyPrompt, /one short sentence/i);
  assert.doesNotMatch(clarifyPrompt, /bundle 2-4 tightly related sub-prompts/i);
  assert.doesNotMatch(clarifyPrompt, /Provide exactly 4 suggestions/i);

  assert.match(evaluatePrompt, /DELTA questions/i);
  assert.match(evaluatePrompt, /1-4 follow-up questions/i);
  assert.match(evaluatePrompt, /missingCategoryKeys/);
  assert.match(evaluatePrompt, /Prefer one visible follow-up question per remaining business gap/i);
  assert.match(evaluatePrompt, /Provide 2-3 suggestions per follow-up question by default/i);
  assert.match(evaluatePrompt, /Avoid quotes, parenthetical evidence references/i);
  assert.match(evaluatePrompt, /tightly aligned to the exact follow-up question being asked/i);
  assert.match(evaluatePrompt, /Reuse concrete business nouns/i);
  assert.doesNotMatch(evaluatePrompt, /system-agnostic/i);
  assert.doesNotMatch(evaluatePrompt, /grouped follow-up questions/i);
  assert.doesNotMatch(evaluatePrompt, /Provide exactly 4 suggestions/i);
});
