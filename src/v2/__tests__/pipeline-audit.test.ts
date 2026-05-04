import assert from 'node:assert/strict';
import test from 'node:test';

import { buildV2AuditResultPatch } from '../../services/v2-pipeline-audit';
import type { V2PipelineCompleteResult, V2PipelineNeedsDiscoveryResult } from '../types';

test('buildV2AuditResultPatch maps V2 discovery questions into the clarify audit shape', () => {
  const result: V2PipelineNeedsDiscoveryResult = {
    status: 'needs_discovery',
    triage: {
      complexity: 3,
      ambiguity: 4,
      workflowDepth: 3,
      capabilityBreadth: 3,
      askClarity: 2,
      actorClarity: 3,
      discoveryLoad: 8,
      discoveryMode: 'deep',
      questionBudget: 4,
      likelyCapabilityCount: 3,
      likelyCapabilityShape: 'broad_workflow',
      crudRisk: 'low',
      mustCoverBehaviors: ['Handle approval routing'],
      unresolvedDecisionThemes: ['Fallback policy'],
      arDepth: 'standard',
      reasons: ['Workflow has unresolved handoffs.'],
      shouldPauseForScopeConfirmation: false,
    },
    scopeHypothesis: {
      capabilities: [{ id: 'cap_1', label: 'Route approvals', rationale: 'Primary workflow', confidence: 'high' }],
      actorSlots: { performer: 'Approver' },
      openQuestions: ['Who owns the fallback?'],
      confidence: 'medium',
    },
    discoveryQuestions: [
      {
        id: 'dq_1',
        categoryKey: 'business_rules',
        question: 'What should happen when no approver responds in time?',
        rationale: 'This changes escalation behavior.',
        suggestions: ['Auto-escalate to backup owner', 'Return to requester for manual handling'],
      },
    ],
    materialityHints: ['Answer only rule-shaping questions.'],
  };

  const patch = buildV2AuditResultPatch({ result });
  assert.equal(patch.completePhase, 'clarify');
  assert.equal(patch.clarify?.questions?.length, 1);
  assert.equal(patch.clarify?.questions?.[0]?.question, 'What should happen when no approver responds in time?');
  assert.equal(patch.clarify?.questions?.[0]?.details, 'This changes escalation behavior.');
});

test('buildV2AuditResultPatch maps V2 completed generation into answers and features', () => {
  const result: V2PipelineCompleteResult = {
    status: 'complete',
    triage: {
      complexity: 2,
      ambiguity: 2,
      workflowDepth: 2,
      capabilityBreadth: 2,
      askClarity: 4,
      actorClarity: 4,
      discoveryLoad: 3,
      discoveryMode: 'light',
      questionBudget: 0,
      likelyCapabilityCount: 2,
      likelyCapabilityShape: 'small_workflow',
      crudRisk: 'low',
      mustCoverBehaviors: ['Notify the requester'],
      unresolvedDecisionThemes: [],
      arDepth: 'standard',
      reasons: ['Requirement is already specific enough.'],
      shouldPauseForScopeConfirmation: false,
    },
    scopeHypothesis: {
      capabilities: [{ id: 'cap_1', label: 'Notify requester', rationale: 'Core workflow', confidence: 'high' }],
      actorSlots: { initiator: 'Requester' },
      openQuestions: [],
      confidence: 'high',
    },
    synthesis: {
      resolvedFacts: ['Requester must be notified after approval.'],
      actorMap: { initiator: 'Requester' },
      businessRules: [],
      workflowSteps: ['Submit request', 'Approve request', 'Notify requester'],
      lifecycleStates: [],
      exceptions: [],
      successMeasures: [],
      mustCoverBehaviors: ['Notify the requester'],
      openDecisions: [],
      arDepth: 'standard',
      featureTarget: 1,
    },
    reasoning: {
      capabilities: [],
      actorSlots: {},
      mustCarryRules: [],
      edgeCases: [],
      openDecisions: [],
    },
    features: [
      {
        id: 'v2_feature_1',
        summary: 'Requester notification',
        description: 'As a requester, I want to receive a status update once the request is approved so that I can continue the next step.',
        acceptanceRequirements: [
          { given: 'an approved request', when: 'the approval completes', then: 'the requester receives a notification' },
          { given: 'a notification failure', when: 'delivery cannot be completed', then: 'the system records the failure for follow-up' },
        ],
        storyPoints: 3,
      },
    ],
    classifiedAnswers: [
      {
        questionId: 'dq_1',
        categoryKey: 'functional_flow',
        question: 'Who should be notified after approval?',
        answer: 'The requester should be notified immediately after approval.',
        materiality: 'structural',
        reason: 'Defines the final workflow step.',
      },
    ],
    discoveryChanges: ['structural: Who should be notified after approval?'],
    quality: {
      crudLike: false,
      capabilityDepthScore: 4,
      actorIssues: [],
      warnings: [],
    },
    coverage: {
      sufficient: true,
      failures: [],
      repaired: false,
    },
    promptUsage: {
      input: 100,
      output: 50,
      byStage: {},
    },
  };

  const patch = buildV2AuditResultPatch({ result });
  assert.equal(patch.completePhase, 'generation');
  assert.equal(patch.generation?.clarifyAnswers?.length, 1);
  assert.equal(patch.generation?.clarifyAnswers?.[0]?.question, 'Who should be notified after approval?');
  assert.equal(patch.generation?.features?.length, 1);
  assert.equal(patch.generation?.features?.[0]?.summary, 'Requester notification');
});
