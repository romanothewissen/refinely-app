import { AsyncLocalStorage } from 'async_hooks';
import type { PipelineAuditLlmCallRecord, PiiMaskingStats, TenantConfig } from '../types';
import { mergePipelineAuditBundle, truncateForAudit, type PipelineAuditMergePatch } from './pipeline-audit-store';

export type PipelineAuditRunMeta = {
  sessionId: string;
  auditRunId: string;
  accountId?: string;
};

class PipelineAuditWriter {
  phase = 'unknown';
  private readonly calls: PipelineAuditLlmCallRecord[] = [];

  constructor(readonly meta: PipelineAuditRunMeta) {}

  setPhase(phase: string): void {
    this.phase = phase;
  }

  appendLlmCall(input: {
    model: string;
    requestedModel?: string;
    resolvedModel?: string;
    provider?: PipelineAuditLlmCallRecord['provider'];
    systemPrompt: string;
    userMessage: string;
    responseText: string;
    durationMs?: number;
    usage?: { input: number; output: number };
    maxTokens?: number;
    effectiveMaxTokens?: number;
    reasoningEffort?: PipelineAuditLlmCallRecord['reasoningEffort'];
    thinkingBudget?: number;
    thinkingLevel?: PipelineAuditLlmCallRecord['thinkingLevel'];
    thoughtTokens?: number;
    structuredOutputMode?: PipelineAuditLlmCallRecord['structuredOutputMode'];
    reasoningControlMode?: PipelineAuditLlmCallRecord['reasoningControlMode'];
    piiMasking?: PiiMaskingStats;
    parseOutcome?: PipelineAuditLlmCallRecord['parseOutcome'];
    geminiFallbacks?: string[];
    jsonFailure?: PipelineAuditLlmCallRecord['jsonFailure'];
  }): void {
    const record: PipelineAuditLlmCallRecord = {
      seq: 0,
      phase: this.phase,
      model: input.model,
      requestedModel: input.requestedModel,
      resolvedModel: input.resolvedModel,
      provider: input.provider,
      durationMs: input.durationMs,
      usage: input.usage,
      maxTokens: input.maxTokens,
      effectiveMaxTokens: input.effectiveMaxTokens,
      reasoningEffort: input.reasoningEffort,
      thinkingBudget: input.thinkingBudget,
      thinkingLevel: input.thinkingLevel,
      thoughtTokens: input.thoughtTokens,
      structuredOutputMode: input.structuredOutputMode,
      reasoningControlMode: input.reasoningControlMode,
      systemPrompt: truncateForAudit(input.systemPrompt, 16000),
      userMessage: truncateForAudit(input.userMessage, 28000),
      responseText: truncateForAudit(input.responseText, 32000),
      parseOutcome: input.parseOutcome ?? 'n/a',
      geminiFallbacks: input.geminiFallbacks?.length ? input.geminiFallbacks : undefined,
      jsonFailure: input.jsonFailure,
      piiMasking: input.piiMasking,
    };
    this.calls.push(record);
  }

  /** Updates parseOutcome on the most recent LLM call (from callLlmJsonWithUsage). */
  annotateLastJsonParse(outcome: 'clean_parse' | 'repaired_parse' | 'parse_failed' | 'parse_failed_after_retry'): void {
    if (this.calls.length === 0) return;
    const row = this.calls[this.calls.length - 1];
    row.parseOutcome = outcome;
  }

  annotateLastJsonFailure(input: NonNullable<PipelineAuditLlmCallRecord['jsonFailure']>): void {
    if (this.calls.length === 0) return;
    const row = this.calls[this.calls.length - 1];
    row.jsonFailure = {
      ...row.jsonFailure,
      ...input,
      responseShape: input.responseShape ?? row.jsonFailure?.responseShape,
    };
  }

  drainLlmCalls(): PipelineAuditLlmCallRecord[] {
    return this.calls.splice(0, this.calls.length);
  }

  async flushMerge(patch: Omit<PipelineAuditMergePatch, 'appendLlmCalls'> & { appendCalls?: PipelineAuditLlmCallRecord[] }): Promise<void> {
    const appendLlmCalls = patch.appendCalls ?? this.drainLlmCalls();
    const rest = { ...patch };
    delete rest.appendCalls;
    if (!appendLlmCalls.length && !rest.completePhase && !rest.clarify && !rest.sufficiency && !rest.generation && !rest.userInputs && !rest.mergeHeader && !rest.discoveryContextClarify && !rest.discoveryContextGeneration) {
      return;
    }
    await mergePipelineAuditBundle(this.meta.sessionId, this.meta.auditRunId, {
      ...rest,
      accountId: rest.accountId ?? this.meta.accountId,
      appendLlmCalls: appendLlmCalls.length ? appendLlmCalls : undefined,
    });
  }
}

const storage = new AsyncLocalStorage<PipelineAuditWriter | null>();

export function getPipelineAuditWriter(): PipelineAuditWriter | null {
  return storage.getStore() ?? null;
}

export async function runWithPipelineAuditContext<T>(
  meta: PipelineAuditRunMeta | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (!meta?.auditRunId || !meta.sessionId) {
    return fn();
  }
  const writer = new PipelineAuditWriter(meta);
  return storage.run(writer, fn);
}

export function isPipelineAuditRequested(
  config: TenantConfig,
  pipelineAudit?: boolean,
  auditRunId?: string,
): boolean {
  return Boolean(
    pipelineAudit
    && typeof auditRunId === 'string'
    && auditRunId.trim().length > 0
    && config.developerTools?.pipelineAuditEnabled,
  );
}
