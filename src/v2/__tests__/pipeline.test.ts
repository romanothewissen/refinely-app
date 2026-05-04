import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, type TenantConfig } from '../../types';
import { runV2Pipeline, classifyDiscoveryAnswers } from '../pipeline';
import { buildArWriterSystemPrompt, buildCapabilityReasoningSystemPrompt, buildDiscoverySystemPrompt, buildFeatureFormatterSystemPrompt, buildScopeHypothesisSystemPrompt, buildTriageSystemPrompt, measurePromptSizes, V2_PROMPT_BUDGETS, validateTriageScores } from '../prompts';
import { assessV2TriageFromScores } from '../triage';
import type { V2StageExecutor } from '../types';

const baseConfig: TenantConfig = {
  ...DEFAULT_CONFIG,
  generatorConfig: {
    ...DEFAULT_CONFIG.generatorConfig,
    provider: 'anthropic',
    modelStrategy: 'simple',
    bucketClasses: { discovery: 'flash', generation: 'pro', refinement: 'flash' },
    modelStrategyVersion: 'test',
    pipelineProfile: 'balanced',
    decompositionModel: 'claude-sonnet-4-20250514',
    arModel: 'claude-sonnet-4-20250514',
    clarifyModel: 'claude-sonnet-4-20250514',
    refineModel: 'claude-sonnet-4-20250514',
    evaluateModel: 'claude-sonnet-4-20250514',
    triageModel: 'claude-sonnet-4-20250514',
    themeModel: 'claude-sonnet-4-20250514',
    maxTokens: 8192,
  },
  branding: { appTitle: 'Refinely', logoUrl: null, primaryColor: '#000', secondaryColor: '#fff' },
  similarityConfig: { threshold: 0.5, useLlmRerank: false },
  wiConfig: { enabled: false, topKChunks: 3, maxChars: 2000 },
  arMappings: [],
};

test('triage load mapping scales discovery depth and budget by score bands', () => {
  const heavy = assessV2TriageFromScores(
    { capability_breadth: 5, ask_clarity: 1, actor_clarity: 1 },
    'Coordinate approval routing, fallback handling, dispatch sequencing, and manual override rules for a multi-step urgent service workflow.',
  );
  const light = assessV2TriageFromScores(
    { capability_breadth: 1, ask_clarity: 5, actor_clarity: 5 },
    'Allow a manager to rename a saved template.',
  );

  assert.equal(heavy.discoveryLoad, 15);
  assert.equal(heavy.discoveryMode, 'very_deep');
  assert.equal(heavy.questionBudget, 15);
  assert.equal(light.discoveryLoad, 3);
  assert.equal(light.discoveryMode, 'light');
  assert.equal(light.questionBudget, 2);
  assert.ok(heavy.questionBudget > light.questionBudget);
});

test('classifyDiscoveryAnswers keeps only material answers for generation', () => {
  const answers = classifyDiscoveryAnswers([
    { questionId: 'q1', categoryKey: 'business_rules', question: 'What happens on manual override?', answer: 'A manual override must prevent automatic recalculation.' },
    { questionId: 'q2', categoryKey: 'success_measurement', question: 'Is there a KPI?', answer: 'Yes' },
  ]);

  assert.equal(answers[0]?.materiality, 'rule_bearing');
  assert.equal(answers[1]?.materiality, 'trivial');
});

test('v2 prompt budgets stay materially smaller than the current dense prompt style', () => {
  const prompts = [
    ['triage', buildTriageSystemPrompt()],
    ['scope_hypothesis', buildScopeHypothesisSystemPrompt()],
    ['discover', buildDiscoverySystemPrompt()],
    ['capability_reasoning', buildCapabilityReasoningSystemPrompt()],
    ['feature_formatter', buildFeatureFormatterSystemPrompt()],
    ['ar_writer', buildArWriterSystemPrompt()],
  ] as const;

  prompts.forEach(([stage, prompt]) => {
    const sizes = measurePromptSizes(prompt, '');
    assert.ok(sizes.systemChars <= V2_PROMPT_BUDGETS[stage].maxSystemChars);
  });
});

test('runV2Pipeline returns scope confirmation before generation when no scope hypothesis is confirmed', async () => {
  const calls: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    calls.push(request.stage);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 3, ask_clarity: 3, actor_clarity: 3 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    assert.equal(request.stage, 'scope_hypothesis');
    return {
      data: {
        capabilities: [
          { id: 'cap_1', label: 'Coordinate service plan', rationale: 'Primary workflow capability.', confidence: 'high' },
          { id: 'cap_2', label: 'Handle approval and fallback', rationale: 'Approval and exception logic changes scope.', confidence: 'medium' },
        ],
        actorSlots: { initiator: 'planner', approver: 'manager' },
        openQuestions: ['Can work proceed after rejection?'],
        confidence: 'medium',
      } as any,
      usage: { input: 100, output: 60 },
    };
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Support creating and updating a coordinated service plan with approval and fallback handling.',
      config: baseConfig,
      domainContext: 'Teams coordinate approval, scheduling, and exception handling.',
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_scope_confirmation');
  assert.equal(result.scopeHypothesis.capabilities.length, 2);
  assert.equal(result.recommendedNextStep, 'run_discovery');
  assert.deepEqual(calls, ['triage', 'scope_hypothesis']);
});

test('runV2Pipeline uses questionBudget directly when requesting discovery', async () => {
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 3, actor_clarity: 3 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discover') {
      assert.match(request.userMessage, /Generate up to 9 high-value discovery questions/i);
      return {
        data: {
          questions: [
            { id: 'q1', categoryKey: 'functional_flow', question: 'What sequence controls routing?', rationale: 'Flow boundary.', suggestions: ['A', 'B'] },
          ],
        } as any,
        usage: { input: 50, output: 50 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Route incoming service requests with approval gates and fallback handling.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Route requests', rationale: 'Core capability.', confidence: 'high' }],
        actorSlots: { initiator: 'planner' },
        openQuestions: ['What happens on exception?'],
        confidence: 'medium',
      },
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_discovery');
  assert.equal(result.triage.questionBudget, 9);
});

test('runV2Pipeline performs full generation with per-feature AR writing once scope is confirmed', async () => {
  const calls: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    calls.push(request.stage);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 4, actor_clarity: 4 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'capability_reasoning') {
      return {
        data: {
          capabilities: [
            {
              capabilityId: 'cap_1',
              label: 'Coordinate service planning',
              boundary: 'Manage the end-to-end plan lifecycle including approval, override, and urgent exception routing.',
              ownerRole: 'planner',
              mustCarryRules: ['Rejected plans return to draft.', 'Manual override must be explicit.'],
              edgeCases: ['Urgent work may bypass the normal sequence.', 'Approval rejection must not silently proceed.'],
            },
          ],
          actorSlots: { initiator: 'planner', approver: 'manager' },
          mustCarryRules: ['Rejected plans return to draft.', 'Manual override must be explicit.'],
          edgeCases: ['Urgent work may bypass the normal sequence.', 'Approval rejection must not silently proceed.'],
          openDecisions: [],
        } as any,
        usage: { input: 120, output: 90 },
      };
    }
    if (request.stage === 'feature_formatter') {
      return {
        data: {
          features: [
            {
              summary: 'Coordinate service planning',
              description: 'As a planner, I need to coordinate a service plan through approval and exception handling so that the work can proceed correctly.',
              suggested_story_points: 8,
            },
          ],
        } as any,
        usage: { input: 80, output: 70 },
      };
    }
    if (request.stage === 'ar_writer') {
      return {
        data: {
          acceptanceRequirements: [
            {
              given: 'a service plan requires approval',
              when: 'the approver rejects the plan',
              then: 'the plan returns to draft and cannot proceed automatically',
            },
            {
              given: 'an urgent service need exists',
              when: 'the normal sequence cannot be followed',
              then: 'the planner can route the work through the approved exception path',
            },
          ],
        } as any,
        usage: { input: 90, output: 110 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Support coordinated service planning with approval, manual override, and urgent exception handling.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [
          { id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core workflow.', confidence: 'high' },
        ],
        actorSlots: { initiator: 'planner', approver: 'manager' },
        openQuestions: [],
        confidence: 'high',
      },
      discoveryAnswers: [
        {
          questionId: 'q1',
          categoryKey: 'business_rules',
          question: 'What happens if approval is rejected?',
          answer: 'The plan returns to draft and the user may manually override to restart the approval path.',
        },
      ],
      domainContext: 'Workflow coordination with approval, scheduling, and exception handling.',
    },
    executeStage,
  );

  assert.equal(result.status, 'complete');
  assert.deepEqual(calls, ['triage', 'capability_reasoning', 'feature_formatter', 'ar_writer']);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0]?.acceptanceRequirements.length, 2);
  assert.equal(result.quality.crudLike, false);
});

test('validateTriageScores rejects invalid triage outputs', () => {
  assert.equal(validateTriageScores({ capability_breadth: 2, ask_clarity: 3, actor_clarity: 4 }), null);
  assert.match(
    validateTriageScores({ capability_breadth: 9, ask_clarity: 3, actor_clarity: 4 }) ?? '',
    /triage output must provide 1-5 integer scores/i,
  );
});

test('runV2Pipeline fails fast when triage stage fails', async () => {
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') throw new Error('timeout');
    throw new Error('unexpected downstream call');
  };
  await assert.rejects(
    async () => runV2Pipeline(
      {
        requirement: 'Route work items with complex fallback logic.',
        config: baseConfig,
      },
      executeStage,
    ),
    /V2 triage failed: timeout/i,
  );
});
