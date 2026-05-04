import type {
  PipelineAuditBundle,
  PipelineAuditIndexEntry,
  PipelineAuditLlmCallRecord,
  PipelineAuditPhase,
  PiiMaskingStats,
} from '../types';
import { entityDelete, entityGet, entitySet, KEYS } from './cache';
import { buildPipelineAuditReviewerPack } from '../core/pipeline-audit-prompts';
import {
  buildPipelineAuditIndexEntry,
  removePipelineAuditIndexEntry,
  upsertPipelineAuditIndexEntries,
  PIPELINE_AUDIT_INDEX_MAX_ENTRIES,
} from './pipeline-audit-benchmark';

const SYSTEM_PROMPT_MAX = 16000;
const USER_MESSAGE_MAX = 28000;
const RESPONSE_TEXT_MAX = 32000;
const REQUIREMENT_TEXT_MAX = 8000;
const ATTACHMENT_TEXT_MAX = 16000;
const PIPELINE_AUDIT_STORAGE_MAX_ENTRIES = Math.min(40, PIPELINE_AUDIT_INDEX_MAX_ENTRIES);

export function truncateForAudit(text: string, max = RESPONSE_TEXT_MAX): string {
  const raw = text ?? '';
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}\n\n…[truncated ${raw.length - max} chars]`;
}

function maxSeq(calls: PipelineAuditLlmCallRecord[]): number {
  return calls.reduce((m, c) => Math.max(m, c.seq), 0);
}

function renumberCalls(calls: PipelineAuditLlmCallRecord[], startSeq: number): PipelineAuditLlmCallRecord[] {
  return calls.map((c, i) => ({ ...c, seq: startSeq + i + 1 }));
}

function compactAuditCalls(calls: PipelineAuditLlmCallRecord[]): PipelineAuditLlmCallRecord[] {
  return calls.map((call) => ({
    ...call,
    systemPrompt: truncateForAudit(call.systemPrompt, SYSTEM_PROMPT_MAX),
    userMessage: truncateForAudit(call.userMessage, USER_MESSAGE_MAX),
    responseText: truncateForAudit(call.responseText, RESPONSE_TEXT_MAX),
  }));
}

function compactUserInputs(bundle: PipelineAuditBundle['userInputs'] | undefined): PipelineAuditBundle['userInputs'] | undefined {
  if (!bundle) return bundle;
  return {
    ...bundle,
    requirement: bundle.requirement ? truncateForAudit(bundle.requirement, REQUIREMENT_TEXT_MAX) : bundle.requirement,
    attachmentText: bundle.attachmentText ? truncateForAudit(bundle.attachmentText, ATTACHMENT_TEXT_MAX) : bundle.attachmentText,
  };
}

export async function loadPipelineAuditBundle(
  sessionId: string,
  auditRunId: string,
): Promise<PipelineAuditBundle | null> {
  const key = KEYS.pipelineAudit(sessionId, auditRunId);
  const b = await entityGet<PipelineAuditBundle>(key);
  return b ?? null;
}

export async function listPipelineAuditIndexEntries(): Promise<PipelineAuditIndexEntry[]> {
  const rows = await entityGet<PipelineAuditIndexEntry[]>(KEYS.pipelineAuditIndex);
  return Array.isArray(rows) ? rows : [];
}

async function writePipelineAuditIndexEntries(entries: PipelineAuditIndexEntry[]): Promise<void> {
  await entitySet(KEYS.pipelineAuditIndex, entries);
}

export type PipelineAuditMergePatch = {
  accountId?: string;
  appendLlmCalls?: PipelineAuditLlmCallRecord[];
  mergeHeader?: Partial<PipelineAuditBundle['header']>;
  userInputs?: Partial<NonNullable<PipelineAuditBundle['userInputs']>>;
  discoveryContextClarify?: Partial<NonNullable<PipelineAuditBundle['discoveryContext']>['clarify']>;
  discoveryContextGeneration?: Partial<NonNullable<PipelineAuditBundle['discoveryContext']>['generation']>;
  clarify?: Partial<NonNullable<PipelineAuditBundle['clarify']>>;
  sufficiency?: Partial<NonNullable<PipelineAuditBundle['sufficiency']>>;
  generation?: Partial<NonNullable<PipelineAuditBundle['generation']>>;
  completePhase?: PipelineAuditPhase;
  clientPolling?: Partial<NonNullable<PipelineAuditBundle['clientPolling']>>;
};

export async function mergePipelineAuditBundle(
  sessionId: string,
  auditRunId: string,
  patch: PipelineAuditMergePatch,
): Promise<void> {
  const key = KEYS.pipelineAudit(sessionId, auditRunId);
  const existing = (await entityGet<PipelineAuditBundle>(key)) ?? null;
  const now = new Date().toISOString();
  const reviewerPack = buildPipelineAuditReviewerPack();

  const base: PipelineAuditBundle = existing ?? {
    schemaVersion: 1,
    sessionId,
    auditRunId,
    accountId: patch.accountId,
    createdAt: now,
    updatedAt: now,
    completedPhases: [],
    reviewerPrompt: reviewerPack.userMessageTemplate,
    reviewerOutputSchema: reviewerPack.outputSchemaJson,
    header: { ...patch.mergeHeader },
    llmCalls: [],
  };

  const nextHeader: PipelineAuditBundle['header'] = {
    ...base.header,
    ...patch.mergeHeader,
    generatorModels: {
      ...base.header.generatorModels,
      ...patch.mergeHeader?.generatorModels,
    },
  };

  const mergedPii = mergePiiStats(base.header.piiMaskingStats, patch.mergeHeader?.piiMaskingStats);
  if (mergedPii) nextHeader.piiMaskingStats = mergedPii;

  const startSeq = maxSeq(base.llmCalls);
  const appended = patch.appendLlmCalls?.length
    ? compactAuditCalls(renumberCalls(patch.appendLlmCalls, startSeq))
    : [];

  const completedPhases = [...(base.completedPhases ?? [])];
  if (patch.completePhase && !completedPhases.includes(patch.completePhase)) {
    completedPhases.push(patch.completePhase);
  }

  const nextDiscovery =
    base.discoveryContext || patch.discoveryContextClarify || patch.discoveryContextGeneration
      ? {
          clarify: {
            ...base.discoveryContext?.clarify,
            ...patch.discoveryContextClarify,
          },
          generation: {
            ...base.discoveryContext?.generation,
            ...patch.discoveryContextGeneration,
          },
        }
      : base.discoveryContext;

  const nextClientPolling = patch.clientPolling
    ? { ...base.clientPolling, ...patch.clientPolling }
    : base.clientPolling;

  const next: PipelineAuditBundle = {
    ...base,
    accountId: patch.accountId ?? base.accountId,
    updatedAt: now,
    reviewerPrompt: reviewerPack.userMessageTemplate,
    reviewerOutputSchema: reviewerPack.outputSchemaJson,
    header: nextHeader,
    completedPhases,
    clientPolling: nextClientPolling,
    userInputs: compactUserInputs({
      ...base.userInputs,
      ...patch.userInputs,
    }),
    discoveryContext: nextDiscovery,
    llmCalls: [...base.llmCalls, ...appended],
    clarify: {
      ...base.clarify,
      ...patch.clarify,
    },
    sufficiency: {
      ...base.sufficiency,
      ...patch.sufficiency,
    },
    generation: {
      ...base.generation,
      ...patch.generation,
    },
  };

  await entitySet(key, next);
  const indexEntries = await listPipelineAuditIndexEntries();
  const sortedEntries = upsertPipelineAuditIndexEntries(
    indexEntries,
    buildPipelineAuditIndexEntry(next),
    Math.max(indexEntries.length + 1, PIPELINE_AUDIT_STORAGE_MAX_ENTRIES),
  );
  const keptEntries = sortedEntries.slice(0, PIPELINE_AUDIT_STORAGE_MAX_ENTRIES);
  const prunedEntries = sortedEntries.slice(PIPELINE_AUDIT_STORAGE_MAX_ENTRIES);
  await writePipelineAuditIndexEntries(keptEntries);
  if (prunedEntries.length) {
    await Promise.all(
      prunedEntries.map((entry) => entityDelete(KEYS.pipelineAudit(entry.sessionId, entry.auditRunId))),
    );
  }
}

function mergePiiStats(
  a?: PiiMaskingStats,
  b?: PiiMaskingStats,
): PiiMaskingStats | undefined {
  if (!a && !b) return undefined;
  const enabled = Boolean(a?.enabled || b?.enabled);
  const byType: Record<string, number> = { ...a?.byType };
  for (const [k, v] of Object.entries(b?.byType ?? {})) {
    byType[k] = (byType[k] ?? 0) + v;
  }
  return {
    enabled,
    totalRedactions: (a?.totalRedactions ?? 0) + (b?.totalRedactions ?? 0),
    byType,
  };
}

export async function deletePipelineAuditBundle(sessionId: string, auditRunId: string): Promise<void> {
  await entityDelete(KEYS.pipelineAudit(sessionId, auditRunId));
  const indexEntries = await listPipelineAuditIndexEntries();
  await writePipelineAuditIndexEntries(removePipelineAuditIndexEntry(indexEntries, sessionId, auditRunId));
}
