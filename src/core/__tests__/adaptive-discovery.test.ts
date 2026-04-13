import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAdaptiveDiscoveryAssessment,
  buildAdaptiveDiscoveryProfile,
  isAdaptiveDiscoveryEnabled,
} from '../adaptive-discovery';
import type { ClarifyQuestion, DiscoveryBlueprint, LivingBrief } from '../../types';
import { DEFAULT_CONFIG } from '../../types';

const baseBlueprint: DiscoveryBlueprint = {
  mode: 'adaptive_v1',
  complexityTier: 'standard',
  persona: 'Hiring manager',
  objective: 'Clarify the role enough to generate a strong brief.',
  candidateTopics: ['Role', 'Workflow', 'Constraints', 'Success metrics'],
  topicDependencies: [
    { topic: 'Workflow', dependsOn: ['Role'] },
    { topic: 'Success metrics', dependsOn: ['Workflow'] },
  ],
  rankedGaps: ['Role', 'Workflow', 'Constraints'],
  stopCriteria: ['Role is clear', 'Workflow is clear', 'Open decisions are minor'],
};

const baseBrief: LivingBrief = {
  persona: 'Hiring manager',
  objective: 'Clarify the role enough to generate a strong brief.',
  constraints: ['Need to hire in 30 days'],
  facts: ['First sales hire'],
  resolvedTopics: ['Role'],
  openTopics: ['Workflow', 'Constraints'],
  confidenceByTopic: {
    user_personas: 0.8,
    functional_flow: 0.4,
  },
  summary: 'This is the first sales hire and the workflow is still unclear.',
  knownUnknowns: ['How handoff works', 'What constraints are fixed'],
};

const askedQuestions: ClarifyQuestion[] = [
  {
    categoryKey: 'user_personas',
    category: 'User Personas',
    intent: 'adaptive_user_personas',
    question: 'Who owns this hire?',
    suggestions: ['Founder', 'Hiring manager', 'Recruiter'],
  },
];

test('adaptive discovery flag reads from developer tools config', () => {
  assert.equal(isAdaptiveDiscoveryEnabled(DEFAULT_CONFIG), false);
  assert.equal(isAdaptiveDiscoveryEnabled({
    ...DEFAULT_CONFIG,
    developerTools: {
      ...DEFAULT_CONFIG.developerTools,
      adaptiveDiscoveryEnabled: true,
    },
  }), true);
});

test('adaptive discovery assessment scales depth from blueprint tier', () => {
  assert.equal(buildAdaptiveDiscoveryAssessment(baseBlueprint).discoveryDepth, 'standard');
  assert.equal(buildAdaptiveDiscoveryAssessment({
    ...baseBlueprint,
    complexityTier: 'complex',
  }).discoveryDepth, 'deep');
});

test('adaptive discovery profile tracks asked coverage and remaining open topics', () => {
  const profile = buildAdaptiveDiscoveryProfile(baseBlueprint, baseBrief, askedQuestions, [
    {
      question: 'Who owns this hire?',
      answer: 'Hiring manager',
      categoryKey: 'user_personas',
      selectedSuggestions: [],
    },
  ]);

  assert.equal(profile.scope, 'moderate');
  assert.equal(profile.complexity, 'medium');
  assert.deepEqual(profile.missingCategoryKeys, ['functional_flow', 'business_rules']);
  assert.equal(profile.actualQuestionsAsked, 1);
  assert.equal(profile.actualAnswersReceived, 1);
  assert.deepEqual(profile.coverageArtifact?.askedCategoryKeys, ['user_personas']);
});
