import { randomUUID } from 'crypto';
import { ProjectActivityAction, ProjectActivityEvent, ProjectActivitySummaryRow, TokenUsageSummary } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

function normalizeProjectKeys(projectKeys?: string[], projectKey?: string): string[] {
  const combined = [...(projectKeys ?? []), projectKey ?? '']
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '*');
  const unique = [...new Set(combined)];
  return unique.slice(0, 2);
}

export async function recordProjectActivity(input: {
  action: ProjectActivityAction;
  projectKeys?: string[];
  projectKey?: string;
  sessionId?: string;
  model?: string;
  tokenUsage?: TokenUsageSummary | { total?: number; input?: number; output?: number } | null;
  metadata?: Record<string, unknown>;
}): Promise<ProjectActivityEvent> {
  const existing = await entityGet<ProjectActivityEvent[]>(KEYS.projectActivity) ?? [];
  const normalizedProjectKeys = normalizeProjectKeys(input.projectKeys, input.projectKey);
  const event: ProjectActivityEvent = {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    projectKeys: normalizedProjectKeys,
    projectKey: normalizedProjectKeys[0] ?? '*',
    action: input.action,
    sessionId: input.sessionId,
    model: input.model,
    tokenUsage: input.tokenUsage ? {
      input: Number(input.tokenUsage.input ?? 0),
      output: Number(input.tokenUsage.output ?? 0),
      total: Number(input.tokenUsage.total ?? 0),
    } : undefined,
    metadata: input.metadata,
  };
  await entitySet(KEYS.projectActivity, [...existing, event].slice(-5000));
  return event;
}

export async function listProjectActivity(limit = 250): Promise<ProjectActivityEvent[]> {
  const existing = await entityGet<ProjectActivityEvent[]>(KEYS.projectActivity) ?? [];
  return [...existing].reverse().slice(0, Math.max(1, Math.min(limit, 1000)));
}

export async function getProjectActivitySummary(limit = 1000): Promise<ProjectActivitySummaryRow[]> {
  const events = await listProjectActivity(limit);
  const rows = new Map<string, ProjectActivitySummaryRow>();

  events.forEach((event) => {
    const scopedKeys = event.projectKeys.length ? event.projectKeys : ['Workspace-wide'];
    scopedKeys.forEach((projectKey) => {
      const existing = rows.get(projectKey) ?? {
        projectKey,
        count: 0,
        tokenUsage: 0,
        latestAt: undefined,
        actionCounts: {},
      };
      existing.count += 1;
      existing.tokenUsage += event.tokenUsage?.total ?? 0;
      existing.actionCounts[event.action] = (existing.actionCounts[event.action] ?? 0) + 1;
      if (!existing.latestAt || event.timestamp > existing.latestAt) {
        existing.latestAt = event.timestamp;
      }
      rows.set(projectKey, existing);
    });
  });

  return [...rows.values()].sort((left, right) => {
    if (right.count !== left.count) return right.count - left.count;
    return (right.latestAt ?? '').localeCompare(left.latestAt ?? '');
  });
}
