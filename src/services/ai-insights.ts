import { AiInsightsBreakdownItem, AiInsightsReport, AiSessionInsight } from '../types';
import { entityGet, entitySet, KEYS } from './cache';

const MAX_INSIGHT_SESSIONS = 250;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values: Array<number | null | undefined>): number {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return 0;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function meanNullable(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (!valid.length) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(1));
}

function sortByUpdatedAt(items: AiSessionInsight[]): AiSessionInsight[] {
  return [...items].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function buildBreakdown(
  sessions: AiSessionInsight[],
  selectKey: (session: AiSessionInsight) => string | undefined,
): AiInsightsBreakdownItem[] {
  const buckets = new Map<
    string,
    {
      count: number;
      features: Array<number | null | undefined>;
      rounds: Array<number | null | undefined>;
      coverage: Array<number | null | undefined>;
    }
  >();

  sessions.forEach((session) => {
    const key = selectKey(session);
    if (!key) return;
    const bucket = buckets.get(key) ?? { count: 0, features: [], rounds: [], coverage: [] };
    bucket.count += 1;
    bucket.features.push(asNumber(session.generatedFeatureCount));
    bucket.rounds.push(asNumber(session.discoveryRounds));
    bucket.coverage.push(asNumber(session.latestCoverageScore));
    buckets.set(key, bucket);
  });

  return Array.from(buckets.entries())
    .map(([key, bucket]) => ({
      key,
      count: bucket.count,
      avgFeatures: mean(bucket.features),
      avgDiscoveryRounds: mean(bucket.rounds),
      avgCoverageScore: meanNullable(bucket.coverage),
    }))
    .sort((left, right) => right.count - left.count);
}

export async function upsertAiSessionInsight(
  partial: Partial<AiSessionInsight> & Pick<AiSessionInsight, 'sessionId'>,
): Promise<void> {
  const now = partial.updatedAt ?? new Date().toISOString();
  const existing = (await entityGet<AiSessionInsight[]>(KEYS.aiSessionInsights)) ?? [];
  const index = existing.findIndex((item) => item.sessionId === partial.sessionId);

  if (index >= 0) {
    existing[index] = {
      ...existing[index],
      ...partial,
      createdAt: existing[index].createdAt ?? partial.createdAt ?? now,
      updatedAt: now,
      projectKey: partial.projectKey ?? existing[index].projectKey ?? '*',
    };
  } else {
    existing.push({
      createdAt: partial.createdAt ?? now,
      updatedAt: now,
      projectKey: partial.projectKey ?? '*',
      ...partial,
    });
  }

  await entitySet(KEYS.aiSessionInsights, sortByUpdatedAt(existing).slice(0, MAX_INSIGHT_SESSIONS));
}

export async function getAiInsightsReport(): Promise<AiInsightsReport> {
  const sessions = sortByUpdatedAt((await entityGet<AiSessionInsight[]>(KEYS.aiSessionInsights)) ?? []);
  const clarifySessions = sessions.filter((session) => {
    return (
      typeof session.initialClarifyQuestionCount === 'number' ||
      typeof session.discoveryRounds === 'number' ||
      typeof session.totalDiscoveryAnswers === 'number'
    );
  });
  const generatedSessions = sessions.filter((session) => typeof session.generatedFeatureCount === 'number');

  return {
    generatedAt: new Date().toISOString(),
    totalSessions: sessions.length,
    clarifySessions: clarifySessions.length,
    generatedSessions: generatedSessions.length,
    avgFeatureCount: mean(generatedSessions.map((session) => session.generatedFeatureCount)),
    avgDiscoveryRounds: mean(clarifySessions.map((session) => session.discoveryRounds)),
    avgQuestionsPerClarifySession: mean(clarifySessions.map((session) => session.totalDiscoveryQuestions ?? session.initialClarifyQuestionCount)),
    avgCoverageScore: meanNullable(clarifySessions.map((session) => session.latestCoverageScore)),
    overTargetFeatureSessions: generatedSessions.filter((session) => {
      return typeof session.plannedFeatureTarget === 'number'
        && typeof session.generatedFeatureCount === 'number'
        && session.generatedFeatureCount > session.plannedFeatureTarget;
    }).length,
    singleFeatureSessions: generatedSessions.filter((session) => session.generatedFeatureCount === 1).length,
    multiRoundSessions: clarifySessions.filter((session) => (session.discoveryRounds ?? 0) > 1).length,
    initiativeSessions: generatedSessions.filter((session) => (session.initiativeGroupCount ?? 0) > 0).length,
    scopeBreakdown: buildBreakdown(sessions, (session) => session.scopeMode),
    reasoningBreakdown: buildBreakdown(sessions, (session) => session.reasoningMode),
    outputBreakdown: buildBreakdown(sessions, (session) => session.outputMode),
    projectBreakdown: Array.from(
      sessions.reduce((map, session) => {
        const key = session.projectKey || '*';
        map.set(key, (map.get(key) ?? 0) + 1);
        return map;
      }, new Map<string, number>()).entries(),
    )
      .map(([key, count]) => ({ key, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6),
    recentSessions: sessions.slice(0, 8).map((session) => ({
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      projectKey: session.projectKey,
      scopeMode: session.scopeMode,
      reasoningMode: session.reasoningMode,
      outputMode: session.outputMode,
      generatedFeatureCount: session.generatedFeatureCount,
      discoveryRounds: session.discoveryRounds,
      latestCoverageScore: session.latestCoverageScore ?? null,
    })),
  };
}
