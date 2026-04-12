import { entityGet, entitySet, KEYS } from '../services/cache';
import { saveTransparencyReport } from '../services/compliance';
import { recordProjectActivity } from '../services/project-activity';
import { startQuickRefine } from '../core/quick-refine';
import type { QuickRefineEvent, QuickRefineSession } from '../types';

async function persistQuickRefineSession(accountId: string, session: QuickRefineSession) {
  await entitySet(KEYS.quickRefineSession(session.sessionId), session);
  await entitySet(KEYS.userIssueSession(accountId, session.issueKey), session.sessionId);
}

export async function handler(event: { body: QuickRefineEvent }) {
  const { sessionId, accountId, context, config, modelOverride } = event.body;
  const existing = await entityGet<QuickRefineSession>(KEYS.quickRefineSession(sessionId));
  if (!existing) return;

  const runningSession: QuickRefineSession = {
    ...existing,
    status: 'running',
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  await persistQuickRefineSession(accountId, runningSession);

  try {
    const result = await startQuickRefine({
      context,
      config,
      modelOverride,
    });

    const nextSession: QuickRefineSession = {
      ...runningSession,
      modelOverride,
      context,
      status: result.route === 'clarify' ? 'needs_clarification' : result.route === 'handoff' ? 'handoff' : 'draft',
      questions: result.route === 'clarify' ? result.questions : undefined,
      draft: result.route === 'rewrite' ? result.draft : undefined,
      handoffReason: result.route === 'handoff' ? result.reason : undefined,
      error: undefined,
      updatedAt: new Date().toISOString(),
    };
    await persistQuickRefineSession(accountId, nextSession);

    if (result.route === 'rewrite' && config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
      await saveTransparencyReport({
        sessionId,
        turnType: 'refine',
        actorAccountId: accountId,
        provider: config.generatorConfig.provider,
        model: modelOverride || config.generatorConfig.refineModel,
        projectKey: context.projectKey,
        requirementExcerpt: context.originalIssue.summary.slice(0, 240),
        decisionSummary: [
          'Quick refine generated a preview rewrite for the current Jira issue.',
        ],
        contextUsage: {
          issueKey: context.issueKey,
          similarStoriesCount: result.draft?.contextMeta?.similarStoriesCount ?? 0,
          wiDocsCount: result.draft?.contextMeta?.wiDocsCount ?? 0,
          linkedWiDocCount: result.draft?.contextMeta?.linkedWiDocCount ?? 0,
          retrievedWiDocCount: result.draft?.contextMeta?.retrievedWiDocCount ?? result.draft?.contextMeta?.wiDocsCount ?? 0,
          retrievedWiChunkCount: result.draft?.contextMeta?.retrievedWiChunkCount ?? 0,
          wiInsightCount: result.draft?.contextMeta?.wiInsightCount ?? 0,
        },
        tokenUsage: result.draft?.tokenUsage,
        piiMasking: { enabled: false, totalRedactions: 0, byType: {} },
      });
    }

    await recordProjectActivity({
      action: 'refine',
      projectKeys: [context.projectKey],
      projectKey: context.projectKey,
      sessionId,
      model: modelOverride || config.generatorConfig.refineModel,
      tokenUsage: result.route === 'rewrite' ? (result.draft?.tokenUsage ?? null) : (result.tokenUsage ?? null),
      metadata: {
        issueKey: context.issueKey,
        quickRefine: true,
        route: result.route,
        async: true,
      },
    });
  } catch (err) {
    const failedSession: QuickRefineSession = {
      ...runningSession,
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
      updatedAt: new Date().toISOString(),
    };
    await persistQuickRefineSession(accountId, failedSession);
  }
}
