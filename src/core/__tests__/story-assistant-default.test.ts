import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractActorSets,
  extractRoles,
  parseStoryAssistantQuestionCandidates,
  splitClearlyNumberedStoryAssistantQuestion,
} from '../story-assistant-default';

test('splitClearlyNumberedStoryAssistantQuestion splits clearly numbered grouped prompts', () => {
  const questions = splitClearlyNumberedStoryAssistantQuestion(
    'For case creation, 1. what exact event should trigger the flow, 2. what data must already be present, and 3. when should the interaction wait for manual review instead?',
  );

  assert.deepEqual(questions, [
    'For case creation, what exact event should trigger the flow,',
    'For case creation, what data must already be present, and',
    'For case creation, when should the interaction wait for manual review instead?',
  ]);
});

test('parseStoryAssistantQuestionCandidates preserves simple story assistant questions with grounded suggestions', () => {
  const questions = parseStoryAssistantQuestionCandidates([
    {
      category: 'Roles & Personas',
      question: 'Who is responsible for creating the consolidated plan?',
      suggestions: ['Coordinator', 'Manager', 'Dispatcher'],
    },
  ]);

  assert.equal(questions.length, 1);
  assert.equal(questions[0]?.categoryKey, 'user_personas');
  assert.equal(questions[0]?.question, 'Who is responsible for creating the consolidated plan?');
  assert.deepEqual(questions[0]?.suggestions, ['Coordinator', 'Manager', 'Dispatcher']);
});

test('parseStoryAssistantQuestionCandidates keeps up to four grounded suggestions', () => {
  const questions = parseStoryAssistantQuestionCandidates([
    {
      category: 'Functional Flow',
      question: 'What details must be captured for each planned activity?',
      suggestions: [
        'Planned location and service type',
        'Required parts and labor estimate',
        'Sequence dependencies on earlier activities',
        'Any customer-facing commitments to honor',
        'This extra suggestion should be dropped',
      ],
    },
  ]);

  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0]?.suggestions, [
    'Planned location and service type',
    'Required parts and labor estimate',
    'Sequence dependencies on earlier activities',
    'Any customer-facing commitments to honor',
  ]);
});

test('extractRoles prefers structured clarify answers and ignores negative placeholders', () => {
  const roles = extractRoles('', [
    {
      question: 'Who approves the completed plan?',
      answer: 'Chosen answer:\n- Nobody',
      selectedSuggestions: [],
      customAnswer: 'Nobody',
      categoryKey: 'user_personas',
    },
    {
      question: 'Who receives the quote?',
      answer: 'Chosen answer:\n- Service Sales and Billing Team',
      selectedSuggestions: ['Service Sales and Billing Team'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(roles, ['Service Sales and Billing Team']);
});

test('extractActorSets preserves multiple eligible actors while filtering non-role phrases', () => {
  const actorSets = extractActorSets('', [
    {
      question: 'Which roles can perform this activity?',
      answer: 'Technical Support Specialist, PM Specialist',
      selectedSuggestions: [],
      customAnswer: 'Technical Support Specialist, PM Specialist',
      categoryKey: 'user_personas',
    },
    {
      question: 'Who approves the outcome?',
      answer: 'Service Manager',
      selectedSuggestions: ['Service Manager'],
      categoryKey: 'user_personas',
    },
    {
      question: 'Who can view progress?',
      answer: 'Only if billable',
      selectedSuggestions: ['Only if billable'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(actorSets.eligibleActors, ['Technical Support Specialist', 'PM Specialist']);
  assert.deepEqual(actorSets.approverActors, ['Service Manager']);
  assert.equal(actorSets.viewerActors, undefined);
});

test('parseStoryAssistantQuestionCandidates splits numbered prompts into separate cards without rewriting the meaning', () => {
  const questions = parseStoryAssistantQuestionCandidates([
    {
      category: 'Functional Flow',
      question: 'For service planning, 1. what activities belong in one plan, 2. what details must be captured for each activity?',
      suggestions: ['Single workflow', 'Per activity detail', 'Depends on service type'],
    },
  ]);

  assert.equal(questions.length, 2);
  assert.equal(questions[0]?.categoryKey, 'functional_flow');
  assert.equal(questions[1]?.categoryKey, 'functional_flow');
  assert.match(questions[0]?.question ?? '', /what activities belong in one plan/i);
  assert.match(questions[1]?.question ?? '', /what details must be captured for each activity/i);
  assert.deepEqual(questions[0]?.suggestions, ['Single workflow', 'Per activity detail', 'Depends on service type']);
});
