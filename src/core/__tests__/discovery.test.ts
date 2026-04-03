import test from 'node:test';
import assert from 'node:assert/strict';

import {
  finalizeFollowupDiscoveryQuestions,
  finalizeInitialDiscoveryQuestions,
  normalizeDiscoveryProfile,
} from '../discovery';
import { buildClarifySystemPrompt, buildEvaluateSystemPrompt } from '../prompts';

test('normalizeDiscoveryProfile clamps counts into the supported range', () => {
  const profile = normalizeDiscoveryProfile({
    scope: 'very_broad',
    complexity: 'very_high',
    ambiguity: 'high',
    missingDimensions: ['Rules & Constraints', 'Success Criteria'],
    recommendedInitialCount: 14,
    followupCap: 9,
  });

  assert.equal(profile.recommendedInitialCount, 10);
  assert.equal(profile.followupCap, 5);
  assert.deepEqual(profile.missingDimensions, ['Rules & Constraints', 'Success Criteria']);
});

test('finalizeInitialDiscoveryQuestions fills sparse model output up to the requested first-round floor', () => {
  const profile = normalizeDiscoveryProfile({
    ambiguity: 'high',
    missingDimensions: ['Rules & Constraints', 'Exceptions & Failure Modes', 'Success Criteria'],
    recommendedInitialCount: 5,
    followupCap: 4,
  });

  const questions = finalizeInitialDiscoveryQuestions([
    {
      category: 'Objective & Outcome',
      question: 'What concrete outcome should this request achieve once it is delivered?',
      suggestions: ['Business result', 'Time savings', 'Quality gain', 'Better visibility'],
    },
  ], profile);

  assert.equal(questions.length, 5);
  assert.equal(new Set(questions.map((question) => question.question)).size, 5);
  assert.ok(
    questions.some((question) => /rules|constraint/i.test(question.question)),
    'expected fallback coverage for business rules',
  );
});

test('finalizeFollowupDiscoveryQuestions returns only delta questions and respects the total budget', () => {
  const followups = finalizeFollowupDiscoveryQuestions([
    {
      category: 'Objective & Outcome',
      question: 'What concrete outcome should this request achieve once it is delivered?',
      suggestions: ['Business result', 'Time savings', 'Quality gain', 'Better visibility'],
    },
    {
      category: 'Rules & Constraints',
      question: 'Which business rules or limits must always be enforced for this to be considered correct?',
      suggestions: ['Priority rules', 'Approval rules', 'Eligibility rules', 'Still undefined'],
    },
    {
      category: 'Exceptions & Failure Modes',
      question: 'What failures or edge cases should be handled explicitly instead of following the normal path?',
      suggestions: ['Missing data', 'Conflict state', 'Validation issue', 'Fallback required'],
    },
  ], {
    askedQuestions: ['What concrete outcome should this request achieve once it is delivered?'],
    missingDimensions: ['Rules & Constraints', 'Exceptions & Failure Modes'],
    followupCap: 5,
    initialQuestionCount: 13,
  });

  assert.equal(followups.length, 2);
  assert.ok(
    followups.every((question) => question.question !== 'What concrete outcome should this request achieve once it is delivered?'),
    'expected already-asked questions to be filtered out',
  );
});

test('discovery prompts stay generic and encode the new structured contracts', () => {
  const clarifyPrompt = buildClarifySystemPrompt({
    domainContext: 'Internal systems, teams, and roles may exist here but should not be injected into discovery.',
  });
  const evaluatePrompt = buildEvaluateSystemPrompt({ minQuestions: 2, maxQuestions: 5 });

  assert.match(clarifyPrompt, /system-agnostic/i);
  assert.match(clarifyPrompt, /"discoveryProfile"/);
  assert.match(clarifyPrompt, /recommendedInitialCount/);
  assert.doesNotMatch(clarifyPrompt, /Known roles in this domain/i);

  assert.match(evaluatePrompt, /DELTA questions/i);
  assert.match(evaluatePrompt, /2-5 follow-up questions/i);
  assert.match(evaluatePrompt, /reasonCodes/);
});
