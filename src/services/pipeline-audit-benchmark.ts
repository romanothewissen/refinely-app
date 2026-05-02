import type {
  Feature,
  PipelineAuditBenchmarkCase,
  PipelineAuditBenchmarkSuite,
  PipelineAuditBundle,
  PipelineAuditIndexEntry,
  PipelineAuditPhase,
  PipelineAuditShadowDiffSummary,
  PipelineAuditShadowResultSnapshot,
  PipelineAuditShadowRunInput,
} from '../types';

const REQUIREMENT_PREVIEW_MAX = 180;
export const PIPELINE_AUDIT_INDEX_MAX_ENTRIES = 250;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildRequirementPreview(text?: string, max = REQUIREMENT_PREVIEW_MAX): string | undefined {
  const normalized = normalizeWhitespace(text ?? '');
  if (!normalized) return undefined;
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function countAcceptanceRequirements(features?: Feature[]): number {
  return (features ?? []).reduce((total, feature) => total + (feature.acceptanceRequirements?.length ?? 0), 0);
}

function extractSufficiencyStatus(bundle: PipelineAuditBundle): string | undefined {
  const status = bundle.sufficiency?.evaluation?.status;
  return typeof status === 'string' && status.trim().length > 0 ? status : undefined;
}

function sortedProjectKeys(bundle: PipelineAuditBundle): string[] {
  const keys = [
    ...(bundle.header.projectKeys ?? []),
    ...(bundle.header.primaryProjectKey ? [bundle.header.primaryProjectKey] : []),
  ].filter((key, index, all) => Boolean(key) && all.indexOf(key) === index);
  return keys;
}

function buildProviderCounts(bundle: PipelineAuditBundle): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of bundle.llmCalls) {
    const provider = call.provider ?? 'unknown';
    counts[provider] = (counts[provider] ?? 0) + 1;
  }
  return counts;
}

export function buildPipelineAuditIndexEntry(bundle: PipelineAuditBundle): PipelineAuditIndexEntry {
  return {
    sessionId: bundle.sessionId,
    auditRunId: bundle.auditRunId,
    accountId: bundle.accountId,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    primaryProjectKey: bundle.header.primaryProjectKey,
    projectKeys: sortedProjectKeys(bundle),
    completedPhases: [...bundle.completedPhases],
    pipelineProfile: bundle.header.generatorModels?.pipelineProfile,
    requestedPipelineProfile: bundle.header.generatorModels?.requestedPipelineProfile,
    resolvedPipelineProfile: bundle.header.generatorModels?.resolvedPipelineProfile,
    requestedModelRoute: bundle.header.generatorModels?.requestedModelRoute,
    resolvedModelRoute: bundle.header.generatorModels?.resolvedModelRoute,
    generatorModels: bundle.header.generatorModels,
    llmCallCount: bundle.llmCalls.length,
    clarifyQuestionCount: bundle.clarify?.questions?.length ?? 0,
    clarifyAnswerCount: bundle.generation?.clarifyAnswers?.length ?? 0,
    featureCount: bundle.generation?.features?.length ?? 0,
    acceptanceRequirementCount: countAcceptanceRequirements(bundle.generation?.features),
    requirementPreview: buildRequirementPreview(bundle.userInputs?.requirement),
  };
}

export function upsertPipelineAuditIndexEntries(
  entries: PipelineAuditIndexEntry[],
  nextEntry: PipelineAuditIndexEntry,
  maxEntries = PIPELINE_AUDIT_INDEX_MAX_ENTRIES,
): PipelineAuditIndexEntry[] {
  const deduped = entries.filter((entry) => !(
    entry.sessionId === nextEntry.sessionId
    && entry.auditRunId === nextEntry.auditRunId
  ));
  deduped.push(nextEntry);
  deduped.sort((a, b) => {
    const updatedDelta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return `${b.sessionId}:${b.auditRunId}`.localeCompare(`${a.sessionId}:${a.auditRunId}`);
  });
  return deduped.slice(0, Math.max(1, maxEntries));
}

export function removePipelineAuditIndexEntry(
  entries: PipelineAuditIndexEntry[],
  sessionId: string,
  auditRunId: string,
): PipelineAuditIndexEntry[] {
  return entries.filter((entry) => !(entry.sessionId === sessionId && entry.auditRunId === auditRunId));
}

export function buildPipelineAuditShadowRunInput(bundle: PipelineAuditBundle): PipelineAuditShadowRunInput | null {
  const requirement = bundle.userInputs?.requirement?.trim() ?? '';
  if (!requirement) return null;

  const clarifyAnswers = bundle.generation?.clarifyAnswers ?? [];
  const replayableStages = {
    clarify: true,
    sufficiency: clarifyAnswers.length > 0,
    generation: clarifyAnswers.length > 0,
  };

  return {
    caseId: `${bundle.sessionId}:${bundle.auditRunId}`,
    sessionId: bundle.sessionId,
    auditRunId: bundle.auditRunId,
    projectKey: bundle.header.primaryProjectKey,
    projectKeys: sortedProjectKeys(bundle),
    requirement,
    attachmentText: bundle.userInputs?.attachmentText ?? '',
    clarifyAnswers,
    clarifyDiscoveryProfile: bundle.userInputs?.clarifyDiscoveryProfile,
    clarifySizingContract: bundle.userInputs?.clarifySizingContract,
    clarifyAdvisoryTriage: bundle.userInputs?.clarifyAdvisoryTriage,
    replayableStages,
    recommendedStage: replayableStages.generation ? 'generation' : 'clarify',
    generatorModels: bundle.header.generatorModels,
  };
}

export function buildPipelineAuditBenchmarkCase(bundle: PipelineAuditBundle): PipelineAuditBenchmarkCase | null {
  const shadowRunInput = buildPipelineAuditShadowRunInput(bundle);
  if (!shadowRunInput) return null;

  return {
    caseId: shadowRunInput.caseId,
    sessionId: bundle.sessionId,
    auditRunId: bundle.auditRunId,
    createdAt: bundle.createdAt,
    updatedAt: bundle.updatedAt,
    primaryProjectKey: bundle.header.primaryProjectKey,
    projectKeys: sortedProjectKeys(bundle),
    baseline: {
      completedPhases: [...bundle.completedPhases],
      llmCallCount: bundle.llmCalls.length,
      clarifyQuestionCount: bundle.clarify?.questions?.length ?? 0,
      clarifyAnswerCount: bundle.generation?.clarifyAnswers?.length ?? 0,
      featureCount: bundle.generation?.features?.length ?? 0,
      acceptanceRequirementCount: countAcceptanceRequirements(bundle.generation?.features),
      sufficiencyStatus: extractSufficiencyStatus(bundle),
    },
    inputs: {
      requirement: shadowRunInput.requirement,
      attachmentText: shadowRunInput.attachmentText,
      clarifyAnswers: shadowRunInput.clarifyAnswers,
      clarifyDiscoveryProfile: shadowRunInput.clarifyDiscoveryProfile,
      clarifySizingContract: shadowRunInput.clarifySizingContract,
      clarifyAdvisoryTriage: shadowRunInput.clarifyAdvisoryTriage,
    },
    shadowRunInput,
    reviewerPrompt: bundle.reviewerPrompt,
    reviewerOutputSchema: bundle.reviewerOutputSchema,
  };
}

export function buildPipelineAuditBenchmarkSuite(
  bundles: PipelineAuditBundle[],
): PipelineAuditBenchmarkSuite {
  const cases: PipelineAuditBenchmarkCase[] = [];
  const phaseCoverage: Record<PipelineAuditPhase, number> = {
    clarify: 0,
    sufficiency: 0,
    generation: 0,
  };
  const providerCounts: Record<string, number> = {};
  let skippedMissingRequirementCount = 0;
  let totalLlmCalls = 0;
  let totalFeatures = 0;
  let totalAcceptanceRequirements = 0;
  let replayableClarifyCount = 0;
  let replayableGenerationCount = 0;

  for (const bundle of bundles) {
    const benchmarkCase = buildPipelineAuditBenchmarkCase(bundle);
    if (!benchmarkCase) {
      skippedMissingRequirementCount += 1;
      continue;
    }
    cases.push(benchmarkCase);
    totalLlmCalls += benchmarkCase.baseline.llmCallCount;
    totalFeatures += benchmarkCase.baseline.featureCount;
    totalAcceptanceRequirements += benchmarkCase.baseline.acceptanceRequirementCount;
    if (benchmarkCase.shadowRunInput.replayableStages.clarify) replayableClarifyCount += 1;
    if (benchmarkCase.shadowRunInput.replayableStages.generation) replayableGenerationCount += 1;
    for (const phase of benchmarkCase.baseline.completedPhases) {
      phaseCoverage[phase] += 1;
    }
    for (const [provider, count] of Object.entries(buildProviderCounts(bundle))) {
      providerCounts[provider] = (providerCounts[provider] ?? 0) + count;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    caseCount: cases.length,
    skippedMissingRequirementCount,
    summary: {
      totalLlmCalls,
      totalFeatures,
      totalAcceptanceRequirements,
      replayableClarifyCount,
      replayableGenerationCount,
      phaseCoverage,
      providerCounts,
    },
    cases,
  };
}

export function summarizePipelineAuditShadowDiff(
  baseline: PipelineAuditBundle,
  candidate: PipelineAuditShadowResultSnapshot,
): PipelineAuditShadowDiffSummary {
  const baselineSufficiencyStatus = extractSufficiencyStatus(baseline);
  const candidateStatusRaw = candidate.sufficiencyEvaluation?.status;
  const candidateSufficiencyStatus =
    typeof candidateStatusRaw === 'string' && candidateStatusRaw.trim().length > 0
      ? candidateStatusRaw
      : undefined;

  return {
    baselineSufficiencyStatus,
    candidateSufficiencyStatus,
    sufficiencyStatusChanged: baselineSufficiencyStatus !== candidateSufficiencyStatus,
    clarifyQuestionCountDelta:
      (candidate.clarifyQuestions?.length ?? 0) - (baseline.clarify?.questions?.length ?? 0),
    featureCountDelta:
      (candidate.features?.length ?? 0) - (baseline.generation?.features?.length ?? 0),
    acceptanceRequirementCountDelta:
      countAcceptanceRequirements(candidate.features) - countAcceptanceRequirements(baseline.generation?.features),
    llmCallCountDelta: (candidate.llmCallCount ?? 0) - baseline.llmCalls.length,
  };
}
