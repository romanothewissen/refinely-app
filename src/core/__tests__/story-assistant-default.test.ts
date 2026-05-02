import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClarifyUserMessage,
  buildGenerationContextMessage,
  buildSufficiencyUserMessage,
  buildHeuristicDiscoveryAssessment,
  evaluateClarifyQuestionSetQuality,
  extractActorSets,
  extractRoles,
  parseStoryAssistantQuestionCandidates,
  parseDiscoveryAssessment,
  STORY_ASSISTANT_CLARIFY_RESPONSE_SCHEMA,
  STORY_ASSISTANT_DISCOVERY_ASSESSMENT_SCHEMA,
  STORY_ASSISTANT_FEATURE_COLLECTION_SCHEMA,
  STORY_ASSISTANT_SUFFICIENCY_RESPONSE_SCHEMA,
  splitClearlyNumberedStoryAssistantQuestion,
} from '../story-assistant-default';
import { formatGoldStoryExemplars } from '../similar-stories';
import { validateJsonSchema } from '../json-schema';

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

test('parseStoryAssistantQuestionCandidates keeps exactly three grounded suggestions for discovery', () => {
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

test('parseStoryAssistantQuestionCandidates drops truncated suggestions', () => {
  const questions = parseStoryAssistantQuestionCandidates([
    {
      category: 'Success & Measurement',
      question: 'How will users track progress across the full workflow?',
      suggestions: [
        'A shared progress view',
        'Status updates from',
        'Milestone notifications',
      ],
    },
  ]);

  assert.equal(questions.length, 1);
  assert.deepEqual(questions[0]?.suggestions, [
    'A shared progress view',
    'Status updates from',
    'Milestone notifications',
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

test('extractRoles splits multi-role answers joined with "or" and rejects approval-state phrases', () => {
  const roles = extractRoles('', [
    {
      question: 'Which roles can perform this activity?',
      answer: 'TSS, SSS or PM Specialist',
      selectedSuggestions: [],
      customAnswer: 'TSS, SSS or PM Specialist',
      categoryKey: 'user_personas',
    },
    {
      question: 'Who approves this?',
      answer: 'No formal approval is typically needed',
      selectedSuggestions: ['No formal approval is typically needed'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(roles, ['TSS', 'SSS', 'PM Specialist']);
});

test('extractRoles strips aggregate prefixes and action-phrased pseudo roles', () => {
  const roles = extractRoles('', [
    {
      question: 'Who can initiate actions from the plan?',
      answer: 'The case owners - TSS, SSS, PM Specialist',
      selectedSuggestions: [],
      customAnswer: 'The case owners - TSS, SSS, PM Specialist',
      categoryKey: 'user_personas',
    },
    {
      question: 'Who owns this flow?',
      answer: 'Case owners to initiate actions from the plan',
      selectedSuggestions: ['Case owners to initiate actions from the plan'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(roles, ['TSS', 'SSS', 'PM Specialist']);
});

test('extractActorSets resolves referential actor phrases back to canonical roles', () => {
  const actorSets = extractActorSets('', [
    {
      question: 'Who creates the plan?',
      answer: 'Service Support Specialist',
      selectedSuggestions: ['Service Support Specialist'],
      categoryKey: 'user_personas',
    },
    {
      question: 'Who can modify an active plan?',
      answer: 'The same person who created the plan',
      selectedSuggestions: ['The same person who created the plan'],
      categoryKey: 'user_personas',
    },
    {
      question: 'Who can view the case status?',
      answer: 'The case owner',
      selectedSuggestions: ['The case owner'],
      customAnswer: 'Customer Success Manager',
      categoryKey: 'user_personas',
    },
    {
      question: 'Who is the case owner?',
      answer: 'Customer Success Manager',
      selectedSuggestions: ['Customer Success Manager'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(actorSets.eligibleActors, ['Service Support Specialist', 'Customer Success Manager']);
  assert.deepEqual(actorSets.viewerActors, ['Customer Success Manager']);
  assert.deepEqual(actorSets.mentionedActors, ['Service Support Specialist', 'Customer Success Manager']);
});

test('extractActorSets rejects sentence-like role clauses from free-text answers', () => {
  const actorSets = extractActorSets('', [
    {
      question: 'Who performs this work?',
      answer: 'The Field Service Engineer documents the persistent issues and then escalates to support',
      selectedSuggestions: [],
      categoryKey: 'user_personas',
    },
    {
      question: 'Who ultimately owns the activity?',
      answer: 'Service Coordinator',
      selectedSuggestions: ['Service Coordinator'],
      categoryKey: 'user_personas',
    },
  ]);

  assert.deepEqual(actorSets.eligibleActors, ['Service Coordinator']);
});

test('parseStoryAssistantQuestionCandidates splits numbered prompts into separate cards without rewriting the meaning', () => {
  const questions = parseStoryAssistantQuestionCandidates([
    {
      category: 'Functional Flow',
      question: 'Plan setup: 1. what activities belong in one plan, 2. what details must be captured for each activity?',
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

test('story assistant user messages keep final task and constraints at the end', () => {
  const clarifyMessage = buildClarifyUserMessage({
    requirement: 'Create a coordinated service plan.',
    attachmentText: 'Attachment details.',
    wiEvidenceText: 'WI rule 1',
    similarStoriesText: 'Story reference',
  });
  assert.match(clarifyMessage, /Based on the information above, ask only the discovery questions needed/i);
  assert.match(clarifyMessage, /Final constraints: do not re-ask evidence/i);
  assert.ok(clarifyMessage.indexOf('Story reference') < clarifyMessage.indexOf('Based on the information above'));

  const sufficiencyMessage = buildSufficiencyUserMessage({
    requirement: 'Create a coordinated service plan.',
    answers: [{ question: 'Who approves the plan?', answer: 'Service Manager', selectedSuggestions: [] }],
    wiEvidenceText: 'WI rule 1',
    similarStoriesText: 'Story reference',
  });
  assert.match(sufficiencyMessage, /Based on the information above, decide whether discovery is sufficient/i);
  assert.match(sufficiencyMessage, /Final constraints: ask only delta follow-up questions/i);

  const generationMessage = buildGenerationContextMessage({
    requirement: 'Create a coordinated service plan.',
    clarifyAnswers: [{ question: 'Who approves the plan?', answer: 'Service Manager', selectedSuggestions: [] }],
    attachmentText: '',
    wiEvidenceText: 'WI rule 1',
    roleHint: 'ROLE CONSTRAINT: Service Manager',
    actorSets: {},
    similarStoriesText: 'Story reference',
    arPatternLibraryText: '<reference_examples>Example</reference_examples>',
  });
  assert.ok(generationMessage.indexOf('Story reference') < generationMessage.indexOf('<reference_examples>Example</reference_examples>'));
});

test('gold story exemplars are wrapped in XML-style delimiters', () => {
  const text = formatGoldStoryExemplars({
    projectKey: 'ABC',
    builtAt: '2026-05-02T00:00:00.000Z',
    entries: [
      { key: 'ABC-1', summary: 'Coordinated plan creation', score: 10, arSample: 'GIVEN a request exists WHEN planning starts THEN a coordinated plan is created' },
    ],
  });

  assert.match(text, /<reference_examples purpose="gold_acceptance_requirements">/);
  assert.match(text, /<example id="ABC-1">/);
  assert.match(text, /<story_summary>Coordinated plan creation<\/story_summary>/);
  assert.match(text, /<acceptance_requirements>/);
});

test('story assistant schemas validate representative stage payloads', () => {
  assert.equal(validateJsonSchema({
    discoveryDepth: 'standard',
    reasoningLevel: 'standard',
    workflowComplexity: 'medium',
    actorComplexity: 'low',
    ruleDensity: 'medium',
    exceptionDensity: 'low',
    lifecycleComplexity: 'medium',
    ambiguityLevel: 'medium',
    coverageObligations: ['sequencing'],
    recommendedQuestionRange: { min: 6, max: 10 },
    rationale: 'Moderate workflow ambiguity.',
  }, STORY_ASSISTANT_DISCOVERY_ASSESSMENT_SCHEMA), null);

  assert.equal(validateJsonSchema({
    ambiguity: { level: 'medium', score: 6, rationale: 'Some workflow gaps remain.' },
    questions: [
      {
        categoryKey: 'functional_flow',
        category: 'Functional Flow',
        intent: 'workflow_order',
        question: 'What sequence must the activities follow once the plan begins?',
        suggestions: ['Strict prerequisite order', 'Order can be overridden', 'Only some steps depend on order'],
      },
    ],
  }, STORY_ASSISTANT_CLARIFY_RESPONSE_SCHEMA), null);

  assert.equal(validateJsonSchema({
    sufficient: false,
    questions: [
      {
        question: 'Which role approves the plan before execution starts?',
        suggestions: ['Service Manager', 'Operations Lead', 'No approval is required'],
      },
    ],
    reasonCodes: ['MISSING_APPROVER'],
  }, STORY_ASSISTANT_SUFFICIENCY_RESPONSE_SCHEMA), null);

  assert.equal(validateJsonSchema({
    features: [
      {
        summary: 'Coordinate service plan',
        description: 'As a planner, I need to coordinate the service plan so that execution can be managed end to end.',
        acceptance_requirements: [
          'GIVEN a service request is ready WHEN planning begins THEN a coordinated plan is prepared for execution',
        ],
        suggested_story_points: 5,
      },
    ],
  }, STORY_ASSISTANT_FEATURE_COLLECTION_SCHEMA), null);
});

test('heuristic discovery assessment marks short but workflow-heavy asks as deep', () => {
  const assessment = buildHeuristicDiscoveryAssessment({
    requirement: 'Facilitate service through a single plan.',
    attachmentText: '',
    wiEvidenceText: 'Sequence de-installation, loaner delivery, repair, return shipment, re-installation, status tracking, and quote/payment authorization gates.',
    similarStoriesText: 'Examples reference multiple teams, downstream work order creation, shipments, dependencies, and active-plan changes.',
  });

  assert.equal(assessment.discoveryDepth, 'deep');
  assert.equal(assessment.reasoningLevel, 'deep');
  assert.match(assessment.coverageObligations.join(','), /sequencing/);
  assert.match(assessment.coverageObligations.join(','), /downstream_initiation/);
});

test('heuristic discovery assessment keeps long but focused asks light', () => {
  const assessment = buildHeuristicDiscoveryAssessment({
    requirement: 'Allow a manager to rename a saved service template after reviewing a long explanatory paragraph that repeats the same focused ask in several different ways for business stakeholders.',
    attachmentText: '',
    wiEvidenceText: '',
    similarStoriesText: '',
  });

  assert.equal(assessment.discoveryDepth, 'light');
  assert.equal(assessment.reasoningLevel, 'light');
});

test('parseDiscoveryAssessment preserves wide LLM-led discovery ranges', () => {
  const parsed = parseDiscoveryAssessment({
    discoveryDepth: 'deep',
    reasoningLevel: 'deep',
    workflowComplexity: 'high',
    actorComplexity: 'high',
    ruleDensity: 'high',
    exceptionDensity: 'medium',
    lifecycleComplexity: 'high',
    ambiguityLevel: 'high',
    coverageObligations: ['sequencing', 'status_visibility'],
    recommendedQuestionRange: { min: 12, max: 25 },
    rationale: 'Very complex workflow ambiguity.',
  });

  assert.ok(parsed);
  assert.deepEqual(parsed?.recommendedQuestionRange, { min: 12, max: 18 });
});

test('clarify quality evaluator flags missing deep-workflow obligation coverage', () => {
  const quality = evaluateClarifyQuestionSetQuality([
    {
      categoryKey: 'user_personas',
      category: 'Roles & Personas',
      intent: 'owner',
      question: 'Who owns the plan?',
      suggestions: ['Service coordinator', 'Case owner', 'Dispatch lead'],
    },
    {
      categoryKey: 'context_trigger',
      category: 'Trigger & Context',
      intent: 'trigger',
      question: 'When should a single plan be created?',
      suggestions: ['At diagnosis', 'After first visit', 'When activities are combined'],
    },
  ], {
    discoveryDepth: 'deep',
    reasoningLevel: 'deep',
    workflowComplexity: 'high',
    actorComplexity: 'medium',
    ruleDensity: 'high',
    exceptionDensity: 'medium',
    lifecycleComplexity: 'high',
    ambiguityLevel: 'high',
    coverageObligations: ['sequencing', 'quote_and_billing', 'status_visibility'],
    recommendedQuestionRange: { min: 12, max: 18 },
    rationale: 'Complex multi-step workflow.',
  });

  assert.ok(quality.score < 70);
  assert.match(quality.reasons.join(' '), /missing discovery obligation coverage/i);
});

test('clarify quality evaluator penalizes generic admin questions when key ambiguity remains', () => {
  const quality = evaluateClarifyQuestionSetQuality([
    {
      categoryKey: 'user_personas',
      category: 'Roles & Personas',
      intent: 'owner',
      question: 'Who is responsible for the workflow?',
      suggestions: ['Coordinator', 'Manager', 'Ops lead'],
    },
    {
      categoryKey: 'user_personas',
      category: 'Roles & Personas',
      intent: 'approval',
      question: 'Who approves the workflow?',
      suggestions: ['Manager', 'Operations lead', 'No approval needed'],
    },
    {
      categoryKey: 'context_trigger',
      category: 'Trigger & Context',
      intent: 'trigger',
      question: 'When should the workflow begin?',
      suggestions: ['After intake', 'After review', 'When criteria are met'],
    },
  ], {
    discoveryDepth: 'standard',
    reasoningLevel: 'standard',
    workflowComplexity: 'high',
    actorComplexity: 'medium',
    ruleDensity: 'high',
    exceptionDensity: 'medium',
    lifecycleComplexity: 'high',
    ambiguityLevel: 'high',
    coverageObligations: ['sequencing', 'status_visibility'],
    recommendedQuestionRange: { min: 6, max: 8 },
    rationale: 'Workflow ambiguity remains.',
  });

  assert.ok(quality.score < 90);
  assert.match(quality.reasons.join(' '), /generic discovery coverage|fewer questions/i);
});
