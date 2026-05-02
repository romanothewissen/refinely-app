import test from 'node:test';
import assert from 'node:assert/strict';

import type { PipelineAuditBundle, PipelineAuditIndexEntry } from '../../types';
import {
  buildPipelineAuditBenchmarkCase,
  buildPipelineAuditBenchmarkSuite,
  buildPipelineAuditIndexEntry,
  buildPipelineAuditShadowRunInput,
  removePipelineAuditIndexEntry,
  summarizePipelineAuditShadowDiff,
  upsertPipelineAuditIndexEntries,
} from '../../services/pipeline-audit-benchmark';

function makeBundle(overrides: Partial<PipelineAuditBundle> = {}): PipelineAuditBundle {
  return {
    schemaVersion: 1,
    sessionId: 'sess-1',
    auditRunId: 'run-1',
    accountId: 'acct-1',
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T12:00:00.000Z',
    completedPhases: ['clarify', 'sufficiency', 'generation'],
    reviewerPrompt: 'Audit the following PipelineAuditBundle.',
    reviewerOutputSchema: '{"ok":true}',
    header: {
      primaryProjectKey: 'OPS',
      projectKeys: ['OPS', 'CS'],
      generatorModels: {
        pipelineProfile: 'balanced',
        requestedPipelineProfile: 'balanced',
        resolvedPipelineProfile: 'quality',
        requestedModelRoute: {
          clarify: 'gemini-3-flash-preview',
          evaluate: 'gemini-3-flash-preview',
        },
        resolvedModelRoute: {
          clarify: 'gemini-3-flash-preview',
          evaluate: 'gemini-3-flash-preview',
          decomposition: 'gemini-3-pro-preview',
          ar: 'gemini-3-pro-preview',
        },
        triageModel: 'gemini-3-flash-preview',
        clarifyModel: 'gemini-3-flash-preview',
        evaluateModel: 'gemini-3-flash-preview',
        decompositionModel: 'gemini-3-pro-preview',
        arModel: 'gemini-3-pro-preview',
      },
      piiMaskingEnabled: true,
    },
    userInputs: {
      requirement: 'Route incoming service emails to the correct case workflow and hold ambiguous messages for manual review before case creation.',
      attachmentText: 'Attachment context',
      clarifyDiscoveryProfile: { scope: 'moderate' },
      clarifySizingContract: { targetFeatureRange: '2-4' },
      clarifyAdvisoryTriage: { complexity: 'medium' },
    },
    llmCalls: [
      {
        seq: 1,
        phase: 'clarify.discovery_assessment',
        model: 'gemini-3-flash-preview',
        provider: 'gemini',
        systemPrompt: 'System',
        userMessage: 'User',
        responseText: '{}',
      },
      {
        seq: 2,
        phase: 'generation.ar',
        model: 'gemini-3-pro-preview',
        provider: 'gemini',
        systemPrompt: 'System',
        userMessage: 'User',
        responseText: '{}',
      },
    ],
    clarify: {
      questions: [
        {
          category: 'Roles & Personas',
          categoryKey: 'user_personas',
          intent: 'Identify the operational owner',
          question: 'Who owns the case after triage?',
          suggestions: ['Service Desk Agent'],
        },
        {
          category: 'Business Rules & Exceptions',
          categoryKey: 'business_rules',
          intent: 'Capture the manual review branch',
          question: 'When should triage stop and send the message for manual review?',
          suggestions: ['If the serial number is missing'],
        },
      ],
      completedAt: '2026-05-01T10:05:00.000Z',
    },
    sufficiency: {
      evaluation: {
        status: 'ready_to_generate',
      },
      completedAt: '2026-05-01T10:06:00.000Z',
    },
    generation: {
      clarifyAnswers: [
        {
          question: 'Who owns the case after triage?',
          answer: 'Service Desk Agent',
          selectedSuggestions: ['Service Desk Agent'],
          categoryKey: 'user_personas',
        },
      ],
      features: [
        {
          id: 'F1',
          summary: 'Triage inbound service emails',
          description: 'As a Service Desk Agent, I need to route inbound service emails so that the correct workflow begins.',
          acceptanceRequirements: [
            {
              given: 'a new inbound service email arrives',
              when: 'the message is classified',
              then: 'the correct case workflow is selected',
            },
            {
              given: 'the message lacks a serial number',
              when: 'triage cannot match it confidently',
              then: 'the message is queued for manual review before case creation',
            },
          ],
        },
        {
          id: 'F2',
          summary: 'Track manual review outcomes',
          description: 'As a Service Desk Agent, I need to record manual review outcomes so that deferred emails can resume processing.',
          acceptanceRequirements: [
            {
              given: 'a message is manually reviewed',
              when: 'the reviewer resolves the ambiguity',
              then: 'the case can continue through the correct workflow',
            },
          ],
        },
      ],
      completedAt: '2026-05-01T10:10:00.000Z',
    },
    ...overrides,
  };
}

test('buildPipelineAuditIndexEntry captures benchmark-relevant metadata', () => {
  const entry = buildPipelineAuditIndexEntry(makeBundle());

  assert.equal(entry.sessionId, 'sess-1');
  assert.equal(entry.auditRunId, 'run-1');
  assert.deepEqual(entry.projectKeys, ['OPS', 'CS']);
  assert.equal(entry.llmCallCount, 2);
  assert.equal(entry.clarifyQuestionCount, 2);
  assert.equal(entry.clarifyAnswerCount, 1);
  assert.equal(entry.featureCount, 2);
  assert.equal(entry.acceptanceRequirementCount, 3);
  assert.match(entry.requirementPreview ?? '', /Route incoming service emails/);
});

test('pipeline audit index helpers dedupe, sort, and remove entries', () => {
  const older: PipelineAuditIndexEntry = {
    sessionId: 'sess-older',
    auditRunId: 'run-older',
    createdAt: '2026-04-30T10:00:00.000Z',
    updatedAt: '2026-04-30T10:00:00.000Z',
    completedPhases: ['clarify'],
    llmCallCount: 1,
    clarifyQuestionCount: 1,
    clarifyAnswerCount: 0,
    featureCount: 0,
    acceptanceRequirementCount: 0,
  };
  const newer = buildPipelineAuditIndexEntry(makeBundle());

  const deduped = upsertPipelineAuditIndexEntries([older, newer], {
    ...newer,
    updatedAt: '2026-05-01T13:00:00.000Z',
    featureCount: 3,
  });

  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.sessionId, 'sess-1');
  assert.equal(deduped[0]?.featureCount, 3);

  const removed = removePipelineAuditIndexEntry(deduped, 'sess-1', 'run-1');
  assert.deepEqual(removed, [older]);
});

test('buildPipelineAuditShadowRunInput reconstructs replay-ready inputs', () => {
  const shadow = buildPipelineAuditShadowRunInput(makeBundle());

  assert.ok(shadow);
  assert.equal(shadow?.caseId, 'sess-1:run-1');
  assert.equal(shadow?.recommendedStage, 'generation');
  assert.equal(shadow?.replayableStages.clarify, true);
  assert.equal(shadow?.replayableStages.sufficiency, true);
  assert.equal(shadow?.replayableStages.generation, true);
  assert.equal(shadow?.clarifyAnswers.length, 1);
});

test('buildPipelineAuditBenchmarkCase exposes baseline metrics and shadow inputs', () => {
  const benchmarkCase = buildPipelineAuditBenchmarkCase(makeBundle());

  assert.ok(benchmarkCase);
  assert.equal(benchmarkCase?.baseline.featureCount, 2);
  assert.equal(benchmarkCase?.baseline.acceptanceRequirementCount, 3);
  assert.equal(benchmarkCase?.baseline.sufficiencyStatus, 'ready_to_generate');
  assert.equal(benchmarkCase?.shadowRunInput.requirement.startsWith('Route incoming service emails'), true);
});

test('buildPipelineAuditBenchmarkSuite aggregates cases and skips bundles without a requirement', () => {
  const suite = buildPipelineAuditBenchmarkSuite([
    makeBundle(),
    makeBundle({
      sessionId: 'sess-2',
      auditRunId: 'run-2',
      userInputs: {
        requirement: '  ',
      },
    }),
  ]);

  assert.equal(suite.caseCount, 1);
  assert.equal(suite.skippedMissingRequirementCount, 1);
  assert.equal(suite.summary.totalLlmCalls, 2);
  assert.equal(suite.summary.totalFeatures, 2);
  assert.equal(suite.summary.totalAcceptanceRequirements, 3);
  assert.equal(suite.summary.replayableClarifyCount, 1);
  assert.equal(suite.summary.replayableGenerationCount, 1);
  assert.equal(suite.summary.phaseCoverage.generation, 1);
  assert.equal(suite.summary.providerCounts.gemini, 2);
});

test('summarizePipelineAuditShadowDiff reports deltas against the historical baseline', () => {
  const diff = summarizePipelineAuditShadowDiff(makeBundle(), {
    sufficiencyEvaluation: { status: 'ask_followup' },
    clarifyQuestions: [{ category: 'Functional Flow', categoryKey: 'functional_flow', intent: 'Capture the next workflow step', question: 'What happens next?', suggestions: [] }],
    features: [
      {
        id: 'F1',
        summary: 'Triage inbound service emails',
        description: 'Same feature',
        acceptanceRequirements: [
          { given: 'a message arrives', when: 'it is matched', then: 'the workflow starts' },
        ],
      },
    ],
    llmCallCount: 4,
  });

  assert.equal(diff.baselineSufficiencyStatus, 'ready_to_generate');
  assert.equal(diff.candidateSufficiencyStatus, 'ask_followup');
  assert.equal(diff.sufficiencyStatusChanged, true);
  assert.equal(diff.clarifyQuestionCountDelta, -1);
  assert.equal(diff.featureCountDelta, -1);
  assert.equal(diff.acceptanceRequirementCountDelta, -2);
  assert.equal(diff.llmCallCountDelta, 2);
});
