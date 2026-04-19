import { getConfig } from '../services/tenant-config';
import { refreshBacklogCachesForProjects, getGoldStoryPool, DomainPatterns } from '../core/similar-stories';
import { entitySet, objectWrite, KEYS } from '../services/cache';
import { callLlmJson } from '../core/llm';
import { getTierModel } from '../services/billing';

interface BacklogCacheRefreshEvent {
  projectKey?: string;
  requestedAt?: string;
  requestedBy?: string;
  manual?: boolean;
}

async function setRefreshStatus(
  projectKey: string,
  status: 'queued' | 'running' | 'completed' | 'error',
  details: Record<string, unknown> = {},
) {
  await entitySet(KEYS.backlogRefreshStatus(projectKey), {
    projectKey,
    status,
    updatedAt: new Date().toISOString(),
    ...details,
  });
}

async function extractDomainPatterns(projectKey: string, config: ReturnType<typeof getConfig> extends Promise<infer T> ? T : never): Promise<void> {
  const pool = await getGoldStoryPool(projectKey);
  if (!pool?.entries?.length) return;

  const sampleText = pool.entries
    .slice(0, 8)
    .map((e) => `Story: ${e.summary}\n${e.arSample}`)
    .join('\n\n---\n\n')
    .slice(0, 6000);

  const model = getTierModel(config.generatorConfig.themeModel, config.tier);

  try {
    const patterns = await callLlmJson<DomainPatterns>({
      model,
      provider: config.generatorConfig.provider,
      anthropicApiKey: config.generatorConfig.anthropicApiKey,
      geminiApiKey: config.generatorConfig.geminiApiKey,
      openaiApiKey: config.generatorConfig.openaiApiKey,
      azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
      ollamaApiKey: config.generatorConfig.ollamaApiKey,
      ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
      groqApiKey: config.generatorConfig.groqApiKey,
      groqBaseUrl: config.generatorConfig.groqBaseUrl,
      modelCatalogs: config.generatorConfig.modelCatalogs,
      maxTokens: 512,
      reasoningEffort: 'none',
      systemPrompt: 'Extract domain vocabulary from the provided backlog stories. Return compact JSON only.',
      userMessage: `Analyze these backlog stories and extract the domain vocabulary used.

${sampleText}

Return JSON with exactly these fields:
{
  "roles": ["up to 5 specific role names used in these stories, e.g. 'Service Support Specialist'"],
  "coreTerminology": ["up to 8 key business objects/concepts, e.g. 'service plan', 'work order'"],
  "arStyle": "one sentence describing the AR writing style, e.g. 'compound GIVEN preconditions with concrete business objects in THEN clauses'"
}`,
    });

    if (patterns?.roles || patterns?.coreTerminology) {
      const normalized: DomainPatterns = {
        roles: (patterns.roles ?? []).filter((r: unknown) => typeof r === 'string').slice(0, 5),
        coreTerminology: (patterns.coreTerminology ?? []).filter((t: unknown) => typeof t === 'string').slice(0, 8),
        arStyle: typeof patterns.arStyle === 'string' ? patterns.arStyle.slice(0, 200) : '',
      };
      await objectWrite(KEYS.domainPatterns(projectKey), normalized);
    }
  } catch (err) {
    console.warn('[backlog-cache-refresh] domain pattern extraction failed (non-fatal):', err);
  }
}

export async function handler(event?: { body?: BacklogCacheRefreshEvent }) {
  try {
    const config = await getConfig();
    const manualProjectKey = event?.body?.projectKey;

    if (!manualProjectKey || manualProjectKey === '*') {
      console.log('[backlog-cache-refresh] ignored refresh without explicit authorized project key');
      return;
    }

    await setRefreshStatus(manualProjectKey, 'running', {
      requestedAt: event?.body?.requestedAt,
      requestedBy: event?.body?.requestedBy,
      manual: true,
      startedAt: new Date().toISOString(),
    });
    const refreshed = await refreshBacklogCachesForProjects([manualProjectKey], config);
    const result = refreshed.find(item => item.projectKey === manualProjectKey);

    // Extract domain vocabulary from gold stories (best-effort, non-blocking)
    await extractDomainPatterns(manualProjectKey, config);

    await setRefreshStatus(manualProjectKey, 'completed', {
      requestedAt: event?.body?.requestedAt,
      requestedBy: event?.body?.requestedBy,
      manual: true,
      completedAt: new Date().toISOString(),
      issueCount: result?.issueCount ?? 0,
      shardCount: result?.shardCount ?? 0,
      themeCount: result?.themeCount ?? 0,
      builtAt: result?.builtAt,
      themeBuiltAt: result?.themeBuiltAt,
    });
    console.log('[backlog-cache-refresh] refreshed manual cache:', `${manualProjectKey}:${result?.issueCount ?? 0}`);
  } catch (err) {
    const manualProjectKey = event?.body?.projectKey;
    if (manualProjectKey && manualProjectKey !== '*') {
      await setRefreshStatus(manualProjectKey, 'error', {
        requestedAt: event?.body?.requestedAt,
        requestedBy: event?.body?.requestedBy,
        manual: true,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    console.error('[backlog-cache-refresh] failed:', err);
    throw err;
  }
}
