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
    provider?: PipelineAuditLlmCallRecord['provider'];
    systemPrompt: string;
    userMessage: string;
    responseText: string;
    durationMs?: number;
    usage?: { input: number; output: number };
    piiMasking?: PiiMaskingStats;
    parseOutcome?: PipelineAuditLlmCallRecord['parseOutcome'];
  }): void {
    const record: PipelineAuditLlmCallRecord = {
      seq: 0,
      phase: this.phase,
      model: input.model,
      provider: input.provider,
      durationMs: input.durationMs,
      usage: input.usage,
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      responseText: truncateForAudit(input.responseText),
      parseOutcome: input.parseOutcome ?? 'n/a',
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
