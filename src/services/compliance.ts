import { createHash, randomUUID } from 'crypto';
import { ClarifyAnswer, ComplianceAuditEvent, PiiMaskingStats, TransparencyReport } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

interface MaskResult {
  text: string;
  stats: PiiMaskingStats;
}

export function mergePiiMaskingStats(...items: Array<PiiMaskingStats | null | undefined>): PiiMaskingStats {
  const totals: Record<string, number> = {};
  let enabled = false;
  let totalRedactions = 0;

  items.filter(Boolean).forEach((item) => {
    enabled = enabled || Boolean(item?.enabled);
    totalRedactions += item?.totalRedactions ?? 0;
    Object.entries(item?.byType ?? {}).forEach(([key, value]) => {
      totals[key] = (totals[key] ?? 0) + value;
    });
  });

  return {
    enabled,
    totalRedactions,
    byType: totals,
  };
}

function withCounter(
  input: string,
  regex: RegExp,
  replacement: string,
  bucket: string,
  counts: Record<string, number>,
): string {
  let localCount = 0;
  const next = input.replace(regex, () => {
    localCount += 1;
    return replacement;
  });
  if (localCount > 0) {
    counts[bucket] = (counts[bucket] ?? 0) + localCount;
  }
  return next;
}

export function maskPiiText(text: string, enabled: boolean): MaskResult {
  const raw = text ?? '';
  if (!enabled || !raw) {
    return {
      text: raw,
      stats: { enabled, totalRedactions: 0, byType: {} },
    };
  }

  const counts: Record<string, number> = {};
  let masked = raw;
  masked = withCounter(masked, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]', 'email', counts);
  masked = withCounter(masked, /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}\b/g, '[REDACTED_PHONE]', 'phone', counts);
  masked = withCounter(masked, /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[REDACTED_IBAN]', 'iban', counts);
  masked = withCounter(masked, /\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]', 'paymentCard', counts);
  masked = withCounter(masked, /\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]', 'ssn', counts);

  const totalRedactions = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    text: masked,
    stats: {
      enabled,
      totalRedactions,
      byType: counts,
    },
  };
}

export function previewPiiMasking(text: string, enabled = true): MaskResult {
  return maskPiiText(text, enabled);
}

export function maskPiiInAnswers(
  answers: ClarifyAnswer[],
  enabled: boolean,
): { answers: ClarifyAnswer[]; stats: PiiMaskingStats } {
  const totals: Record<string, number> = {};
  const next = answers.map((entry) => {
    const q = maskPiiText(entry.question, enabled);
    const a = maskPiiText(entry.answer, enabled);
    const selectedSuggestions = (entry.selectedSuggestions ?? []).map((suggestion) => maskPiiText(suggestion, enabled));
    const customAnswer = typeof entry.customAnswer === 'string'
      ? maskPiiText(entry.customAnswer, enabled)
      : null;
    Object.entries(q.stats.byType).forEach(([k, v]) => { totals[k] = (totals[k] ?? 0) + v; });
    Object.entries(a.stats.byType).forEach(([k, v]) => { totals[k] = (totals[k] ?? 0) + v; });
    selectedSuggestions.forEach((masked) => {
      Object.entries(masked.stats.byType).forEach(([k, v]) => { totals[k] = (totals[k] ?? 0) + v; });
    });
    if (customAnswer) {
      Object.entries(customAnswer.stats.byType).forEach(([k, v]) => { totals[k] = (totals[k] ?? 0) + v; });
    }
    return {
      question: q.text,
      answer: a.text,
      selectedSuggestions: selectedSuggestions.map((masked) => masked.text),
      customAnswer: customAnswer?.text,
      categoryKey: entry.categoryKey,
      intent: entry.intent,
    };
  });
  const totalRedactions = Object.values(totals).reduce((sum, value) => sum + value, 0);
  return { answers: next, stats: { enabled, totalRedactions, byType: totals } };
}

function hashEvent(input: Omit<ComplianceAuditEvent, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function appendComplianceAuditEvent(input: {
  actorAccountId?: string;
  category: ComplianceAuditEvent['category'];
  action: string;
  details: Record<string, unknown>;
  enabled: boolean;
}): Promise<ComplianceAuditEvent | null> {
  if (!input.enabled) return null;
  const existing = await entityGet<ComplianceAuditEvent[]>(KEYS.complianceAuditTrail) ?? [];
  const prevHash = existing.length ? existing[existing.length - 1].hash : 'GENESIS';
  const eventBase: Omit<ComplianceAuditEvent, 'hash'> = {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    actorAccountId: input.actorAccountId,
    category: input.category,
    action: input.action,
    details: input.details,
    prevHash,
  };
  const nextEvent: ComplianceAuditEvent = {
    ...eventBase,
    hash: hashEvent(eventBase),
  };
  const next = [...existing, nextEvent].slice(-5000);
  await entitySet(KEYS.complianceAuditTrail, next);
  return nextEvent;
}

export async function listComplianceAuditEvents(limit = 100): Promise<ComplianceAuditEvent[]> {
  const existing = await entityGet<ComplianceAuditEvent[]>(KEYS.complianceAuditTrail) ?? [];
  return [...existing].reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
}

export async function saveTransparencyReport(report: Omit<TransparencyReport, 'reportId' | 'createdAt'>): Promise<TransparencyReport> {
  const existing = await entityGet<TransparencyReport[]>(KEYS.transparencyReports) ?? [];
  const nextReport: TransparencyReport = {
    ...report,
    reportId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const next = [...existing, nextReport].slice(-5000);
  await entitySet(KEYS.transparencyReports, next);
  return nextReport;
}

export async function listTransparencyReports(filters?: {
  sessionId?: string;
  turnType?: TransparencyReport['turnType'];
  projectKey?: string;
  limit?: number;
}): Promise<TransparencyReport[]> {
  const existing = await entityGet<TransparencyReport[]>(KEYS.transparencyReports) ?? [];
  const filtered = existing.filter((item) => {
    if (filters?.sessionId && item.sessionId !== filters.sessionId) return false;
    if (filters?.turnType && item.turnType !== filters.turnType) return false;
    if (filters?.projectKey && item.projectKey !== filters.projectKey) return false;
    return true;
  });
  return [...filtered].reverse().slice(0, Math.max(1, Math.min(filters?.limit ?? 100, 1000)));
}

export interface ComplianceSummary {
  totalByTurnType: Record<string, number>;
  totalTokens: number;
  piiRedactionsByType: Record<string, number>;
  modelUsage: Record<string, number>;
  projectBreakdown: Array<{ projectKey: string; count: number; tokenUsage: number; latestAt?: string }>;
}

export async function getComplianceSummary(): Promise<ComplianceSummary> {
  const reports = await entityGet<TransparencyReport[]>(KEYS.transparencyReports) ?? [];

  const totalByTurnType: Record<string, number> = {};
  const piiRedactionsByType: Record<string, number> = {};
  const modelUsage: Record<string, number> = {};
  const projectMap: Record<string, { count: number; tokenUsage: number; latestAt?: string }> = {};
  let totalTokens = 0;

  for (const r of reports) {
    totalByTurnType[r.turnType] = (totalByTurnType[r.turnType] ?? 0) + 1;
    if (r.tokenUsage?.total) totalTokens += r.tokenUsage.total;
    if (r.piiMasking?.byType) {
      for (const [k, v] of Object.entries(r.piiMasking.byType)) {
        piiRedactionsByType[k] = (piiRedactionsByType[k] ?? 0) + v;
      }
    }
    if (r.model) modelUsage[r.model] = (modelUsage[r.model] ?? 0) + 1;
    const pk = r.projectKey || 'Workspace';
    const existing = projectMap[pk] ?? { count: 0, tokenUsage: 0 };
    const tokens = r.tokenUsage?.total ?? 0;
    const isLater = !existing.latestAt || r.createdAt > existing.latestAt;
    projectMap[pk] = {
      count: existing.count + 1,
      tokenUsage: existing.tokenUsage + tokens,
      latestAt: isLater ? r.createdAt : existing.latestAt,
    };
  }

  const projectBreakdown = Object.entries(projectMap)
    .map(([projectKey, data]) => ({ projectKey, ...data }))
    .sort((a, b) => b.count - a.count);

  return { totalByTurnType, totalTokens, piiRedactionsByType, modelUsage, projectBreakdown };
}
