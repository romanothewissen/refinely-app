import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandRawQuestionCandidate,
  finalizeFollowupDiscoveryQuestions,
  finalizeInitialDiscoveryQuestions,
  MAX_TOTAL_DISCOVERY_QUESTIONS,
  normalizeDiscoveryProfile,
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

test('expandRawQuestionCandidate splits compound questions into atomic fixed-category questions', () => {
  const questions = expandRawQuestionCandidate({
    category: 'Context & Trigger',
    intent: 'trigger_and_inputs',
    question: 'What exact event should trigger case creation and what data should be captured?',
    suggestions: ['Call completed', 'New message', 'Caller identified', 'Case reason captured'],
  });

  assert.equal(questions.length, 2);
  assert.deepEqual(
    questions.map((question) => question.categoryKey),
    ['context_trigger', 'context_trigger'],
  );
  assert.deepEqual(
    questions.map((question) => question.question),
    [
      'What exact event should trigger case creation?',
      'What data should be captured?',
    ],
  );
  assert.ok(questions.every((question) => question.intent.startsWith('trigger_and_inputs')));
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

test('discovery prompts enforce the fixed taxonomy and atomic question contract', () => {
  const clarifyPrompt = buildClarifySystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
  });
  const evaluatePrompt = buildEvaluateSystemPrompt({ minQuestions: 2, maxQuestions: 8 });

  assert.match(clarifyPrompt, /system-agnostic/i);
  assert.match(clarifyPrompt, /context_trigger/);
  assert.match(clarifyPrompt, /user_personas/);
  assert.match(clarifyPrompt, /information_architecture/);
  assert.match(clarifyPrompt, /business_rules/);
  assert.match(clarifyPrompt, /state_lifecycle/);
  assert.match(clarifyPrompt, /edge_cases_exceptions/);
  assert.match(clarifyPrompt, /categoryKey/);
  assert.match(clarifyPrompt, /intent/);
  assert.match(clarifyPrompt, /Do NOT write compound questions/i);
  assert.match(clarifyPrompt, /Do NOT output free-form category labels like "TRIGGER \/ CONTEXT & INPUTS"/i);
  assert.doesNotMatch(clarifyPrompt, /Known roles in this domain/i);

  assert.match(evaluatePrompt, /DELTA questions/i);
  assert.match(evaluatePrompt, /2-8 follow-up questions/i);
  assert.match(evaluatePrompt, /missingCategoryKeys/);
  assert.match(evaluatePrompt, /Do NOT write compound questions/i);
});
