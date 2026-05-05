import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, type TenantConfig } from '../../types';
import { buildV2EvidenceBundleFromProjectMemory } from '../../services/project-memory';
import { runV2Pipeline, classifyDiscoveryAnswers } from '../pipeline';
import { buildArWriterSystemPrompt, buildCapabilityReasoningSystemPrompt, buildCapabilityReasoningUserMessage, buildDiscoverySystemPrompt, buildDiscoveryUserMessage, buildFeatureFormatterSystemPrompt, buildFinalGenerationSystemPrompt, buildScopeHypothesisSystemPrompt, buildScopeHypothesisUserMessage, buildSynthesisSystemPrompt, buildTriageSystemPrompt, measurePromptSizes, V2_PROMPT_BUDGETS, V2_SCOPE_HYPOTHESIS_SCHEMA, validateTriageScores } from '../prompts';
import { assessV2TriageFromScores } from '../triage';
import type { V2StageExecutor } from '../types';
import { buildV2GroundedEvidencePack, renderGroundedEvidencePack } from '../evidence-pack';
import { validateJsonSchema } from '../../core/json-schema';

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
    ['discovery_synthesis', buildSynthesisSystemPrompt()],
    ['final_generation', buildFinalGenerationSystemPrompt()],
    ['capability_reasoning', buildCapabilityReasoningSystemPrompt()],
    ['feature_formatter', buildFeatureFormatterSystemPrompt()],
    ['ar_writer', buildArWriterSystemPrompt()],
  ] as const;

  prompts.forEach(([stage, prompt]) => {
    const sizes = measurePromptSizes(prompt, '');
    assert.ok(sizes.systemChars <= V2_PROMPT_BUDGETS[stage].maxSystemChars);
  });
});

test('grounded evidence pack prefers specific roles from configured roles and discovery answers', () => {
  const pack = buildV2GroundedEvidencePack({
    requirement: 'Coordinate a service plan through approval and exception handling.',
    domainRoles: ['Service Planner', 'Service Manager'],
    similarStoriesText: 'Coordinate service plans and approval routing for customer work.',
    discoveryAnswers: classifyDiscoveryAnswers([
      {
        questionId: 'q1',
        categoryKey: 'user_personas',
        question: 'Which role owns the plan?',
        answer: 'The Service Planner prepares the plan and the Service Manager approves it.',
      },
    ]),
  });

  assert.equal(pack.roleCandidates[0]?.role, 'Service Manager');
  assert.ok(pack.roleCandidates.some((candidate) => candidate.role === 'Service Planner'));
  assert.ok(pack.businessObjects.some((cue) => /service plan/i.test(cue.text)));
});

test('grounded evidence prompt blocks carry concrete cues and stay inside user budgets', () => {
  const pack = buildV2GroundedEvidencePack({
    requirement: 'Coordinate service plan approval, manual override, and status updates.',
    domainRoles: ['Service Planner'],
    wiContextText: 'A manual override must be explicit and rejected plans return to draft.',
    similarStoriesText: 'Service plan approval routing tracks draft and approved states.',
  });
  const scopeEvidence = renderGroundedEvidencePack(pack, 'scope_hypothesis');
  const discoveryEvidence = renderGroundedEvidencePack(pack, 'discover');
  const reasoningEvidence = renderGroundedEvidencePack(pack, 'capability_reasoning');

  const scopeMessage = buildScopeHypothesisUserMessage({
    requirement: 'Coordinate service plan approval, manual override, and status updates.',
    triage: assessV2TriageFromScores(
      { capability_breadth: 3, ask_clarity: 3, actor_clarity: 2 },
      'Coordinate service plan approval, manual override, and status updates.',
    ),
    groundedEvidenceText: scopeEvidence,
  });
  const discoveryMessage = buildDiscoveryUserMessage({
    requirement: 'Coordinate service plan approval, manual override, and status updates.',
    triage: assessV2TriageFromScores(
      { capability_breadth: 3, ask_clarity: 3, actor_clarity: 2 },
      'Coordinate service plan approval, manual override, and status updates.',
    ),
    scopeHypothesis: {
      capabilities: [{ id: 'cap_1', label: 'Coordinate service plan approval', rationale: 'Approval workflow.', confidence: 'high' }],
      actorSlots: {},
      openQuestions: ['Who approves the service plan?'],
      confidence: 'medium',
    },
    groundedEvidenceText: discoveryEvidence,
  });
  const reasoningMessage = buildCapabilityReasoningUserMessage({
    requirement: 'Coordinate service plan approval, manual override, and status updates.',
    scopeHypothesis: {
      capabilities: [{ id: 'cap_1', label: 'Coordinate service plan approval', rationale: 'Approval workflow.', confidence: 'high' }],
      actorSlots: {},
      openQuestions: ['Who approves the service plan?'],
      confidence: 'medium',
    },
    classifiedAnswers: [],
    groundedEvidenceText: reasoningEvidence,
  });

  assert.match(scopeMessage, /Grounded evidence:/i);
  assert.match(discoveryMessage, /Business objects:/i);
  assert.match(reasoningMessage, /Work instruction cues:/i);
  assert.ok(measurePromptSizes('', scopeMessage).userChars <= V2_PROMPT_BUDGETS.scope_hypothesis.maxUserChars);
  assert.ok(measurePromptSizes('', discoveryMessage).userChars <= V2_PROMPT_BUDGETS.discover.maxUserChars);
  assert.ok(measurePromptSizes('', reasoningMessage).userChars <= V2_PROMPT_BUDGETS.capability_reasoning.maxUserChars);
});

test('compiled project memory converts structured slices into compact runtime evidence', () => {
  const bundle = buildV2EvidenceBundleFromProjectMemory({
    domainContext: 'Service teams coordinate field work.',
    memoryHeader: {
      roles: ['Service Planner', 'Dispatch Manager'],
      businessObjects: ['service plan', 'dispatch schedule'],
      workflowCues: ['approval routing', 'exception handling'],
      arStyleHint: 'Use concrete business objects in THEN clauses.',
      freshness: 'fresh',
      builtAt: '2026-05-04T00:00:00.000Z',
    },
    memorySelection: {
      roles: ['Service Planner'],
      objects: ['service plan'],
      workflow_patterns: ['Prepare service plan', 'Submit for approval'],
      business_rules: ['Manual override must be explicit.'],
      exception_patterns: ['Urgent work uses the approved exception route.'],
      retrieval_hints: ['service plan', 'exception route'],
      compact_exemplars: [
        { key: 'ABC-1', summary: 'Coordinate service planning', pattern: 'GIVEN a rejected service plan...' },
      ],
      wi_memory: {
        resolvedFacts: ['Service plans return to draft after rejection.'],
        workflowSteps: ['Prepare plan', 'Submit plan'],
        businessRules: ['Rejected plans cannot proceed automatically.'],
        exceptions: ['Urgent work uses the approved exception route.'],
        mustCoverBehaviors: ['Rejected plans return to draft'],
      },
    },
  });

  assert.match(bundle.domainContext ?? '', /approval routing/i);
  assert.deepEqual(bundle.domainRoles, ['Service Planner', 'Dispatch Manager']);
  assert.match(bundle.similarStoriesText ?? '', /Coordinate service planning/i);
  assert.match(bundle.wiContextText ?? '', /Rejected plans cannot proceed automatically/i);
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

test('runV2Pipeline defers preview actor slots when actor grounding is weak', async () => {
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 2, ask_clarity: 4, actor_clarity: 1 } as any,
        usage: { input: 10, output: 10 },
      };
    }
    assert.equal(request.stage, 'scope_hypothesis');
    return {
      data: {
        capabilities: [
          { id: 'cap_1', label: 'Update saved template', rationale: 'Core update flow.', confidence: 'medium' },
        ],
        actorSlots: { initiator: 'user' },
        openQuestions: ['Who approves the update?'],
        confidence: 'medium',
      } as any,
      usage: { input: 40, output: 30 },
    };
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Allow editing a saved template and track status changes.',
      config: baseConfig,
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_scope_confirmation');
  assert.deepEqual(result.scopeHypothesis.actorSlots, {});
  assert.equal(result.scopeHypothesis.actorGroundingStatus, 'weak');
});

test('runV2Pipeline normalizes overlong scope capability ids before returning them to the UI', async () => {
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 3, ask_clarity: 3, actor_clarity: 3 } as any,
        usage: { input: 10, output: 10 },
      };
    }
    assert.equal(request.stage, 'scope_hypothesis');
    return {
      data: {
        capabilities: [
          {
            id: 'capability_identifier_that_is_far_too_long_for_the_schema_to_accept_cleanly',
            label: 'Coordinate service planning',
            rationale: 'Primary workflow capability.',
            confidence: 'high',
          },
          {
            label: 'Handle approval fallback',
            rationale: 'Fallback logic changes scope.',
            confidence: 'medium',
          },
        ],
        actorSlots: {},
        openQuestions: [],
        confidence: 'medium',
      } as any,
      usage: { input: 40, output: 20 },
    };
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service planning with approval fallback handling.',
      config: baseConfig,
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_scope_confirmation');
  assert.ok(result.scopeHypothesis.capabilities.every((capability) => capability.id.length <= 32));
  assert.ok(result.scopeHypothesis.capabilities.every((capability) => capability.id.startsWith('cap_')));
});

test('v2 scope hypothesis schema allows long or omitted model ids so the pipeline can normalize them later', () => {
  const validationError = validateJsonSchema(
    {
      capabilities: [
        {
          id: 'capability_identifier_that_is_far_too_long_for_the_schema_to_accept_cleanly',
          label: 'Coordinate service planning',
          rationale: 'Primary workflow capability.',
          confidence: 'high',
        },
        {
          label: 'Handle approval fallback',
          rationale: 'Fallback logic changes scope.',
          confidence: 'medium',
        },
      ],
      actorSlots: {},
      openQuestions: [],
      confidence: 'medium',
    },
    V2_SCOPE_HYPOTHESIS_SCHEMA,
  );

  assert.equal(validationError, null);
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
            { id: 'q1', categoryKey: 'functional_flow', question: 'What sequence controls service request routing after approval gates?', rationale: 'Flow boundary.', suggestions: ['A', 'B'] },
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

test('runV2Pipeline uses compiled project memory for discovery prompts without raw retrieval text', async () => {
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 3, actor_clarity: 2 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discover') {
      assert.match(request.userMessage, /Service Planner/i);
      assert.match(request.userMessage, /service plan/i);
      assert.match(request.userMessage, /approved exception route/i);
      return {
        data: {
          questions: [
            { id: 'q1', categoryKey: 'business_rules', question: 'What approvals govern the service plan exception route?', rationale: 'Rule boundary.', suggestions: ['Planner approval', 'Manager approval'] },
          ],
        } as any,
        usage: { input: 50, output: 50 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service planning with exception handling.',
      config: baseConfig,
      memoryHeader: {
        roles: ['Service Planner'],
        businessObjects: ['service plan'],
        workflowCues: ['approval routing'],
        arStyleHint: 'Use business-facing GIVEN/WHEN/THEN clauses.',
        freshness: 'fresh',
        builtAt: '2026-05-04T00:00:00.000Z',
      },
      memorySelection: {
        roles: ['Service Planner'],
        objects: ['service plan'],
        workflow_patterns: ['Prepare service plan', 'Submit for approval'],
        business_rules: ['Manual override must be explicit.'],
        exception_patterns: ['Urgent work uses the approved exception route.'],
        retrieval_hints: ['service plan', 'approved exception route'],
      },
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core capability.', confidence: 'high' }],
        actorSlots: {},
        openQuestions: ['Who approves the exception route?'],
        confidence: 'medium',
      },
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_discovery');
});

test('runV2Pipeline performs full generation with synthesis and batch final generation once scope is confirmed', async () => {
  const calls: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    calls.push(request.stage);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 4, actor_clarity: 4 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discovery_synthesis') {
      return {
        data: {
          resolvedFacts: ['Service planning requires approval and exception handling.'],
          actorMap: { initiator: 'planner', approver: 'manager' },
          businessRules: ['Rejected plans return to draft.', 'Manual override must be explicit.'],
          workflowSteps: ['Prepare service plan', 'Submit for approval', 'Handle rejection or urgent exception'],
          lifecycleStates: ['draft', 'approved', 'rejected'],
          exceptions: ['Urgent work may bypass the normal sequence through an approved exception path.'],
          successMeasures: ['Plans do not proceed automatically after rejection.'],
          mustCoverBehaviors: [
            'Rejected plans return to draft',
            'Manual override restarts approval path',
            'Urgent exceptions use an approved route',
          ],
          openDecisions: [],
          arDepth: 'deep',
          featureTarget: 1,
        } as any,
        usage: { input: 120, output: 90 },
      };
    }
    if (request.stage === 'final_generation') {
      return {
        data: {
          features: [
            {
              summary: 'Coordinate service planning',
              description: 'As a planner, I need to coordinate a service plan through approval and exception handling so that the work can proceed correctly.',
              suggested_story_points: 8,
              acceptanceRequirements: [
                {
                  given: 'a service plan requires approval',
                  when: 'the manager rejects the plan',
                  then: 'the plan returns to draft and cannot proceed automatically',
                },
                {
                  given: 'a rejected service plan is in draft',
                  when: 'the planner applies a manual override',
                  then: 'the service plan restarts the approval path explicitly',
                },
                {
                  given: 'an urgent service need exists',
                  when: 'the normal sequence cannot be followed',
                  then: 'the planner routes the work through the approved exception path',
                },
              ],
            },
          ],
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
            { mustCoverBehavior: 'Manual override restarts approval path', featureSummary: 'Coordinate service planning' },
            { mustCoverBehavior: 'Urgent exceptions use an approved route', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 80, output: 70 },
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
  assert.deepEqual(calls, ['triage', 'discovery_synthesis', 'final_generation']);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0]?.acceptanceRequirements.length, 3);
  assert.equal(result.synthesis.featureTarget, 1);
  assert.equal(result.coverage.sufficient, true);
  assert.equal(result.quality.crudLike, false);
});

test('runV2Pipeline repairs final generation when must-cover behavior is missing', async () => {
  const calls: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    calls.push(request.stage);
    if (request.stage === 'triage') {
      return {
        data: {
          complexity: 4,
          ambiguity: 3,
          workflow_depth: 4,
          actor_clarity: 4,
          must_cover_behaviors: ['Rejected plans return to draft', 'Urgent exceptions use an approved route'],
          unresolved_decision_themes: [],
          recommended_discovery_count: 0,
          ar_depth: 'deep',
        } as any,
        usage: { input: 10, output: 10 },
      };
    }
    if (request.stage === 'discovery_synthesis') {
      return {
        data: {
          resolvedFacts: ['Service plans move through approval.'],
          actorMap: { initiator: 'planner', approver: 'manager' },
          businessRules: ['Rejected plans return to draft.'],
          workflowSteps: ['Submit plan', 'Review plan', 'Route urgent exception'],
          lifecycleStates: ['draft', 'rejected'],
          exceptions: ['Urgent exceptions use an approved route.'],
          successMeasures: [],
          mustCoverBehaviors: ['Rejected plans return to draft', 'Urgent exceptions use an approved route'],
          openDecisions: [],
          arDepth: 'deep',
          featureTarget: 1,
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    const generated = {
      features: [
        {
          summary: 'Coordinate service planning',
          description: 'As a planner, I need to coordinate a service plan through approval handling so that rejected plans are controlled.',
          suggested_story_points: 8,
          acceptanceRequirements: [
            { given: 'a service plan is under review', when: 'the manager rejects the plan', then: 'the service plan returns to draft' },
            { given: 'a rejected service plan is in draft', when: 'the planner revises it', then: 'the approval path can restart' },
            { given: 'a service plan has review history', when: 'the planner opens it', then: 'the rejection reason remains visible' },
          ],
        },
      ],
    };
    if (request.stage === 'final_generation') {
      return {
        data: {
          ...generated,
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 30, output: 30 },
      };
    }
    if (request.stage === 'coverage_repair') {
      return {
        data: {
          ...generated,
          features: [
            {
              ...generated.features[0],
              description: 'As a planner, I need to coordinate a service plan through approval and urgent exception handling so that rejected and urgent work follows the right route.',
              acceptanceRequirements: [
                ...generated.features[0].acceptanceRequirements,
                { given: 'an urgent service need exists', when: 'the normal approval sequence cannot be followed', then: 'the planner uses the approved exception route' },
              ],
            },
          ],
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
            { mustCoverBehavior: 'Urgent exceptions use an approved route', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 40, output: 40 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service plan approval and urgent exception routing.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core workflow.', confidence: 'high' }],
        actorSlots: { initiator: 'planner', approver: 'manager' },
        openQuestions: [],
        confidence: 'high',
      },
      discoveryAnswers: [
        {
          questionId: 'q1',
          categoryKey: 'functional_flow',
          question: 'How are urgent exceptions routed?',
          answer: 'Urgent exceptions must use an approved exception route.',
        },
      ],
    },
    executeStage,
  );

  assert.equal(result.status, 'complete');
  assert.ok(calls.includes('coverage_repair'));
  assert.equal(result.coverage.repaired, true);
  assert.equal(result.coverage.sufficient, true);
});

test('runV2Pipeline makes stage reasoning profile-aware', async () => {
  const qualityConfig: TenantConfig = {
    ...baseConfig,
    generatorConfig: {
      ...baseConfig.generatorConfig,
      pipelineProfile: 'quality',
    },
  };
  const efforts = new Map<string, string>();
  const executeStage: V2StageExecutor = async (request) => {
    efforts.set(request.stage, request.reasoningEffort);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 4, actor_clarity: 4 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discovery_synthesis') {
      return {
        data: {
          resolvedFacts: ['Service planning requires approval and exception handling.'],
          actorMap: { initiator: 'planner', approver: 'manager' },
          businessRules: ['Rejected plans return to draft.'],
          workflowSteps: ['Prepare service plan', 'Submit for approval'],
          lifecycleStates: ['draft', 'approved'],
          exceptions: ['Urgent work uses the approved exception route.'],
          successMeasures: [],
          mustCoverBehaviors: ['Rejected plans return to draft'],
          openDecisions: [],
          arDepth: 'deep',
          featureTarget: 1,
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    if (request.stage === 'final_generation') {
      return {
        data: {
          features: [
            {
              summary: 'Coordinate service planning',
              description: 'As a planner, I need to coordinate a service plan through approval handling so that the work can proceed correctly.',
              suggested_story_points: 8,
              acceptanceRequirements: [
                { given: 'a service plan is drafted', when: 'the planner submits it', then: 'the plan enters approval review' },
                { given: 'a plan is rejected', when: 'the manager records the rejection', then: 'the plan returns to draft' },
                { given: 'a rejected plan is back in draft', when: 'the planner reopens the plan', then: 'the rejection reason remains visible before resubmission' },
              ],
            },
          ],
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service planning with approval handling.',
      config: qualityConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core workflow.', confidence: 'high' }],
        actorSlots: { initiator: 'planner', approver: 'manager' },
        openQuestions: [],
        confidence: 'high',
      },
      discoveryAnswers: [
        {
          questionId: 'q1',
          categoryKey: 'business_rules',
          question: 'What happens when the plan is rejected?',
          answer: 'Rejected plans return to draft.',
        },
      ],
    },
    executeStage,
  );

  assert.equal(result.status, 'complete');
  assert.equal(efforts.get('triage'), 'low');
  assert.equal(efforts.get('discovery_synthesis'), 'medium');
  assert.equal(efforts.get('final_generation'), 'high');
});

test('runV2Pipeline raises discovery reasoning on balanced profile', async () => {
  const efforts = new Map<string, string>();
  const executeStage: V2StageExecutor = async (request) => {
    efforts.set(request.stage, request.reasoningEffort);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 3, actor_clarity: 3 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discover') {
      return {
        data: {
          questions: [
            {
              id: 'dq_1',
              categoryKey: 'business_rules',
              question: 'How are approvals handled?',
              rationale: 'Approval logic changes capability boundaries.',
              suggestions: ['Single approver', 'Multi-step approval'],
            },
          ],
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service planning with approvals and downstream work creation.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core workflow.', confidence: 'high' }],
        actorSlots: { initiator: 'planner' },
        openQuestions: ['How are approvals handled?'],
        confidence: 'medium',
      },
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_discovery');
  assert.equal(efforts.get('triage'), 'low');
  assert.equal(efforts.get('discover'), 'medium');
});

test('runV2Pipeline retries discovery when the first question set is too generic', async () => {
  const calls: string[] = [];
  let discoverAttempts = 0;
  const executeStage: V2StageExecutor = async (request) => {
    calls.push(request.stage);
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 3, actor_clarity: 2 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discover') {
      discoverAttempts += 1;
      return {
        data: {
          questions: [
            discoverAttempts === 1
              ? {
                  id: 'dq_1',
                  categoryKey: 'business_rules',
                  question: 'What other details are needed?',
                  rationale: 'Clarifies missing information.',
                  suggestions: ['Workflow', 'Rules'],
                }
              : {
                  id: 'dq_1',
                  categoryKey: 'business_rules',
                  question: 'Who approves the service plan before manual override or status changes proceed?',
                  rationale: 'Approval accountability changes workflow boundaries.',
                  suggestions: ['Planner approves', 'Manager approves'],
                },
          ],
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service plan approval, manual override, and status updates.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service plan approval', rationale: 'Approval workflow.', confidence: 'high' }],
        actorSlots: {},
        openQuestions: ['Who approves the service plan?'],
        confidence: 'medium',
      },
    },
    executeStage,
  );

  assert.equal(result.status, 'needs_discovery');
  assert.equal(discoverAttempts, 2);
  assert.match(result.discoveryQuestions[0]?.question ?? '', /service plan/i);
  assert.deepEqual(calls, ['triage', 'discover', 'discover']);
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

test('runV2Pipeline reports preview progress stages in order', async () => {
  const progressStages: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 2, ask_clarity: 4, actor_clarity: 4 } as any,
        usage: { input: 10, output: 10 },
      };
    }
    assert.equal(request.stage, 'scope_hypothesis');
    return {
      data: {
        capabilities: [{ id: 'cap_1', label: 'Review service plan', rationale: 'Core preview capability.', confidence: 'high' }],
        actorSlots: { initiator: 'planner' },
        openQuestions: [],
        confidence: 'high',
      } as any,
      usage: { input: 30, output: 30 },
    };
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Preview a service plan review flow.',
      config: baseConfig,
      previewOnly: true,
    },
    executeStage,
    async (update) => {
      progressStages.push(update.stage);
    },
  );

  assert.equal(result.status, 'preview_ready');
  assert.deepEqual(progressStages, ['triage', 'scope_hypothesis']);
});

test('runV2Pipeline reports discovery progress before returning next questions', async () => {
  const progressStages: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 3, actor_clarity: 3 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    assert.equal(request.stage, 'discover');
    return {
      data: {
        questions: [
          { id: 'q1', categoryKey: 'functional_flow', question: 'What exception path exists?', rationale: 'Needed for backlog shape.', suggestions: ['Urgent route'] },
        ],
      } as any,
      usage: { input: 40, output: 40 },
    };
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Route service planning through approval and exception handling.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Route service planning', rationale: 'Core workflow.', confidence: 'high' }],
        actorSlots: { initiator: 'planner' },
        openQuestions: ['What exception path exists?'],
        confidence: 'medium',
      },
    },
    executeStage,
    async (update) => {
      progressStages.push(update.stage);
    },
  );

  assert.equal(result.status, 'needs_discovery');
  assert.deepEqual(progressStages, ['triage', 'discover']);
});

test('runV2Pipeline reports full generation progress through coverage repair and persistence', async () => {
  const progressStages: string[] = [];
  const executeStage: V2StageExecutor = async (request) => {
    if (request.stage === 'triage') {
      return {
        data: { capability_breadth: 4, ask_clarity: 4, actor_clarity: 4 } as any,
        usage: { input: 20, output: 10 },
      };
    }
    if (request.stage === 'discovery_synthesis') {
      return {
        data: {
          resolvedFacts: ['Rejected plans return to draft.'],
          actorMap: { initiator: 'planner', approver: 'manager' },
          businessRules: ['Rejected plans return to draft.'],
          workflowSteps: ['Submit plan', 'Review plan', 'Route urgent exception'],
          lifecycleStates: ['draft', 'rejected'],
          exceptions: ['Urgent exceptions use an approved route.'],
          successMeasures: [],
          mustCoverBehaviors: ['Rejected plans return to draft', 'Urgent exceptions use an approved route'],
          openDecisions: [],
          arDepth: 'deep',
          featureTarget: 1,
        } as any,
        usage: { input: 20, output: 20 },
      };
    }
    if (request.stage === 'final_generation') {
      return {
        data: {
          features: [
            {
              summary: 'Coordinate service planning',
              description: 'As a planner, I need to coordinate service planning through approval handling.',
              suggested_story_points: 8,
              acceptanceRequirements: [
                { given: 'a plan is under review', when: 'it is rejected', then: 'it returns to draft' },
                { given: 'a plan is in draft', when: 'it is revised', then: 'it can be resubmitted' },
                { given: 'a plan has history', when: 'it is reopened', then: 'prior review notes stay visible' },
              ],
            },
          ],
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 30, output: 30 },
      };
    }
    if (request.stage === 'coverage_repair') {
      return {
        data: {
          features: [
            {
              summary: 'Coordinate service planning',
              description: 'As a planner, I need to coordinate service planning through approval and urgent exception handling.',
              suggested_story_points: 8,
              acceptanceRequirements: [
                { given: 'a plan is under review', when: 'it is rejected', then: 'it returns to draft' },
                { given: 'a plan is in draft', when: 'it is revised', then: 'it can be resubmitted' },
                { given: 'an urgent request exists', when: 'normal approval cannot be followed', then: 'the approved exception route is used' },
              ],
            },
          ],
          coverageMap: [
            { mustCoverBehavior: 'Rejected plans return to draft', featureSummary: 'Coordinate service planning' },
            { mustCoverBehavior: 'Urgent exceptions use an approved route', featureSummary: 'Coordinate service planning' },
          ],
        } as any,
        usage: { input: 30, output: 30 },
      };
    }
    throw new Error(`Unexpected stage ${request.stage}`);
  };

  const result = await runV2Pipeline(
    {
      requirement: 'Coordinate service plan approval and urgent exception routing.',
      config: baseConfig,
      confirmedScopeHypothesis: {
        capabilities: [{ id: 'cap_1', label: 'Coordinate service planning', rationale: 'Core workflow.', confidence: 'high' }],
        actorSlots: { initiator: 'planner', approver: 'manager' },
        openQuestions: [],
        confidence: 'high',
      },
      discoveryAnswers: [
        {
          questionId: 'q1',
          categoryKey: 'functional_flow',
          question: 'How are urgent exceptions routed?',
          answer: 'Urgent exceptions must use an approved exception route.',
        },
      ],
    },
    executeStage,
    async (update) => {
      progressStages.push(update.stage);
    },
  );

  assert.equal(result.status, 'complete');
  assert.deepEqual(
    [...new Set(progressStages)],
    ['triage', 'discovery_synthesis', 'final_generation', 'coverage_repair', 'persisting'],
  );
});
