import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

test('parseStoryAssistantQuestionCandidates preserves simple story assistant questions with exact suggestion count', () => {
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
