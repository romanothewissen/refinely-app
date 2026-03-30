// @ts-nocheck — @forge/resolver types payload as `never`; runtime types verified manually
/**
 * Forge Resolver — handles all invoke() calls from the React Custom UI.
 *
 * Each function here is a handler for a specific action called from the frontend.
 * Auth is automatic via Forge's platform (cloudId + accountId in context).
 */

const Resolver = require('@forge/resolver').default;
import { Queue } from '@forge/events';
import { asUser, route } from '@forge/api';
import { getConfig, saveConfig, patchConfig } from '../services/tenant-config';
import { checkGenerationAllowed, checkFeatureAllowed, getLimits, getUsage, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, objectWrite, KEYS } from '../services/cache';
import { REDACTED } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolver: any = new Resolver();
import {
  evaluateSufficiency,
  refineFeatures,
  refineSingleFeature,
  checkRefineFeedbackSufficiency,
  askQuestion,
} from '../core/story-generator';
import { createFeatureIssue, createIssueLink, getIssueLinkTypes, searchUsers } from '../core/jira-creator';
import { discoverAll, discoverStatuses, discoverIssueTypes } from '../core/jira-discovery';
import { ingestPdf, listDocs, removeDoc } from '../core/wi-ingestion';
import { refreshGoldCache, getCacheInfo } from '../core/gold-standard';
import { retrieveWiContext } from '../core/wi-ingestion';
import { findSimilarStories } from '../core/similar-stories';
import { buildAskSystemPrompt } from '../core/prompts';
import { callLlm } from '../core/llm';
import { ClarifyAnswer, Feature, GenerationEvent, ClarifyEvent } from '../types';

// ─── Security Helpers ────────────────────────────────────────────────────────

async function checkAdmin(context: any) {
  const accountId = (context as { accountId?: string })?.accountId;
  if (!accountId) return false;
  try {
    const res = await asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.permissions?.ADMINISTER?.havePermission === true;
  } catch (e) {
    return false;
  }
}

async function checkProjectAdmin(context: any, projectKey?: string) {
  const accountId = (context as { accountId?: string })?.accountId;
  if (!accountId) return false;
  // Global admin can always edit everything
  if (await checkAdmin(context)) return true;
  if (!projectKey || projectKey === '*') return false;
  try {
    const res = await asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER_PROJECTS&projectKey=${projectKey}`);
    if (!res.ok) return false;
    const data = await res.json();
    return data.permissions?.ADMINISTER_PROJECTS?.havePermission === true;
  } catch (e) {
    return false;
  }
}

async function ensureAdmin(context: any, projectKey?: string) {
  if (!(await checkProjectAdmin(context, projectKey))) {
    throw new Error('Unauthorized: You do not have permission to manage this configuration.');
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

resolver.define('checkIsAdmin', async ({ context, payload }) => {
  return { 
    success: true, 
    isAdmin: await checkAdmin(context),
    isProjectAdmin: await checkProjectAdmin(context, payload?.projectKey)
  };
});

resolver.define('getConfig', async ({ context }) => {
  const config = await getConfig();
  const isAdmin = await checkAdmin(context);
  
  if (config.generatorConfig) {
    const gc = config.generatorConfig;
    // Scrub keys for the frontend
    if (gc.geminiApiKey) gc.geminiApiKey = REDACTED;
    if (gc.openaiApiKey) gc.openaiApiKey = REDACTED;
  }
  
  return { ...config, isAdmin };
});

resolver.define('saveConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  
  // Key preservation logic
  const existingConfig = await getConfig();
  const egc = existingConfig.generatorConfig || {};
  const ngc = payload.generatorConfig || {};
  
  if (ngc.geminiApiKey === REDACTED) ngc.geminiApiKey = egc.geminiApiKey;
  if (ngc.openaiApiKey === REDACTED) ngc.openaiApiKey = egc.openaiApiKey;
  
  await saveConfig(payload);
  return { success: true };
});

resolver.define('patchConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  return patchConfig(payload);
});

resolver.define('testLlmConnection', async ({ payload, context }) => {
  await ensureAdmin(context);
  try {
    const cfg = await getConfig();
    const gc = cfg.generatorConfig || {};
    
    const isGemini = payload.provider === 'gemini';
    const isOpenAI = payload.provider === 'openai';
    
    const res = await callLlm({
      provider: payload.provider,
      model: payload.model || 'test',
      geminiApiKey: isGemini ? (payload.geminiApiKey === REDACTED ? gc.geminiApiKey : (payload.geminiApiKey?.trim() || gc.geminiApiKey)) : undefined,
      geminiBaseUrl: isGemini ? (payload.geminiBaseUrl?.trim() || gc.geminiBaseUrl) : undefined,
      openaiApiKey: isOpenAI ? (payload.openaiApiKey === REDACTED ? gc.openaiApiKey : (payload.openaiApiKey?.trim() || gc.openaiApiKey)) : undefined,
      openaiBaseUrl: isOpenAI ? (payload.openaiBaseUrl?.trim() || gc.openaiBaseUrl) : undefined,
      systemPrompt: 'Respond with OK',
      userMessage: 'Test connection',
      noFallback: true,
    });
    return { success: true, reply: res.text };
  } catch (err) {
    const message = String((err as { message?: unknown })?.message ?? err ?? 'Unknown error');
    return { success: false, error: message };
  }
});

// ─── Generation (queue dispatch) ─────────────────────────────────────────────

resolver.define('startGeneration', async ({ payload, context }) => {
  const config = await getConfig();

  const check = await checkGenerationAllowed(config, context);
  if (!check.allowed) {
    return { success: false, error: check.reason };
  }

  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';

  const event: GenerationEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: payload.requirement,
    clarifyAnswers: payload.clarifyAnswers ?? [],
    attachmentText: payload.attachmentText ?? '',
    config,
    license: context?.license,
    goldExamples: '',   // fetched inside queue consumer
    wiContext: '',      // fetched inside queue consumer
    projectKey: payload.projectKey || '*',
  };

  // Overwrite any stale 'complete' from a previous run with a fresh 'progress' marker
  await entitySet(KEYS.generationProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    message: 'Queuing generation…',
    updatedAt: Date.now(),
  });

  const generationQueue = new Queue({ key: 'generation-queue' });
  await generationQueue.push({ body: event });
  return { success: true, sessionId: payload.sessionId };
});

// ─── Generation progress (polling) ───────────────────────────────────────────

resolver.define('getProgress', async ({ payload }: { payload: { sessionId: string } }) => {
  const progress = await entityGet(KEYS.generationProgress(payload.sessionId));
  return { success: true, progress };
});

// ─── Clarify ──────────────────────────────────────────────────────────────────

resolver.define('startClarify', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const clarifyQueue = new Queue({ key: 'clarify-queue' });
    const event: ClarifyEvent = {
      sessionId: payload.sessionId,
      requirement: payload.requirement,
      attachmentText: payload.attachmentText ?? '',
      config,
      license: context?.license,
      projectKey: payload.projectKey || '*',
    };
    // Overwrite any stale result with a 'pending' marker so the polling hook waits
    await entitySet(KEYS.clarifyProgress(payload.sessionId), { type: 'pending', updatedAt: Date.now() });
    await clarifyQueue.push({ body: event });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

resolver.define('getClarifyResult', async ({ payload }) => {
  const result = await entityGet(KEYS.clarifyProgress(payload.sessionId));
  return { success: true, result };
});

resolver.define('evaluateSufficiency', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  return evaluateSufficiency({
    requirement: payload.requirement,
    answers: payload.answers as ClarifyAnswer[],
    config,
  });
});

// ─── Refine ───────────────────────────────────────────────────────────────────

resolver.define('refineFeatures', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const features = await refineFeatures({
      requirement: payload.requirement,
      features: payload.features as Feature[],
      feedback: payload.feedback,
      config,
    });

    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await updateLatestTurnFeatures(payload.sessionId, accountId, features, 'refine', payload.feedback);

    return { success: true, features };
  } catch (err: any) {
    console.error('refineFeatures failed:', err);
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

resolver.define('refineSingleFeature', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  const feature = await refineSingleFeature({
    feature: payload.feature as Feature,
    feedback: payload.feedback,
    config,
  });
  return { success: true, feature };
});

resolver.define('checkRefineFeedback', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  return checkRefineFeedbackSufficiency({
    feature: payload.feature as Feature,
    feedback: payload.feedback,
    config,
  });
});

// ─── Ask / Chat ───────────────────────────────────────────────────────────────

resolver.define('ask', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };

  const [wiContext, similarItems] = await Promise.all([
    config.wiConfig.enabled ? retrieveWiContext(payload.message, 4, 20000, '*') : Promise.resolve({ text: '', docs: [] }),
    findSimilarStories(payload.message, config),
  ]);

  const systemPrompt = buildAskSystemPrompt({
    domainContext: config.domainContext,
    wiContext: wiContext.text,
    similarItems: similarItems.map(s => `${s.key}: ${s.summary}`).join('\n'),
  });

  const reply = await askQuestion({
    message: payload.message,
    history: payload.history ?? [],
    systemPrompt,
    config,
  });

  return { success: true, reply, similarItems };
});

// ─── Jira ─────────────────────────────────────────────────────────────────────

resolver.define('createIssue', async ({ payload, context }) => {
  try {
    const reporterAccountId =
      (payload.reporterAccountId as string | undefined) ?? (context as { accountId?: string })?.accountId;
    if (!reporterAccountId) {
      return { success: false, error: 'Could not resolve the current user for issue creation.' };
    }
    const config = await getConfig();
    const arMapping = config.arMappings?.find(m => m.projectKey === payload.projectKey) 
      || config.arMappings?.find(m => m.projectKey === '*') 
      || { mode: 'consolidated', consolidatedFieldId: 'description', iterativeFieldIds: [] };

    const result = await createFeatureIssue({
      feature: payload.feature as Feature,
      projectKey: payload.projectKey as string,
      issueType: payload.issueType as string,
      reporterAccountId,
      assigneeAccountId: payload.assigneeAccountId as string | undefined,
      arMapping: arMapping as any,
    });

    let linkedTo: string | null = null;
    let linkError: string | null = null;
    if (payload.originIssueKey) {
      try {
        const linkType = (arMapping as any).issueLinkType || config.issueLinkType || 'Relates to';
        
        await createIssueLink({
          inwardIssueKey: payload.originIssueKey as string,
          outwardIssueKey: result.issueKey,
          linkType: linkType,
        });
        linkedTo = payload.originIssueKey as string;
      } catch (linkErr: any) {
        linkError = linkErr instanceof Error ? linkErr.message : String(linkErr);
        console.error('createIssueLink failed:', linkError);
        
        // Secondary attempt: maybe the link type name in Jira is slightly different?
        if (linkError?.includes('400') || linkError?.includes('404')) {
           try {
             const alternative = ((config.issueLinkType ?? 'Relates to') === 'Relates to') ? 'Relates' : 'Relates to';
             await createIssueLink({
               inwardIssueKey: payload.originIssueKey as string,
               outwardIssueKey: result.issueKey,
               linkType: alternative,
             });
             linkedTo = payload.originIssueKey as string;
             linkError = null; // Cleared on successfully linked
           } catch { /* ignore fallback failure */ }
        }
      }
    }

    if (payload.sessionId && payload.featureId) {
      try {
        const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
        const convKey = KEYS.userConversations(accountId, payload.sessionId);
        const existing = await entityGet<{ turns: Array<Record<string, any>> }>(convKey);
        if (existing?.turns?.length) {
          const lastTurn = existing.turns[existing.turns.length - 1];
          if (Array.isArray(lastTurn.features)) {
            lastTurn.features = lastTurn.features.map((feature: Record<string, any>) => {
              if (feature?.id !== payload.featureId) return feature;
              return {
                ...feature,
                jiraIssueKey: result.issueKey,
                jiraIssueUrl: result.issueUrl,
              };
            });
            await entitySet(convKey, existing);
          }
        }
      } catch (persistErr) {
        console.warn('[createIssue] Failed to persist Jira issue key on generated feature:', persistErr);
      }
    }

    return { success: true, ...result, linkedTo, linkError };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

resolver.define('searchUsers', async ({ payload }) => {
  const users = await searchUsers(payload.query);
  return { success: true, users };
});

// ─── Jira Discovery ───────────────────────────────────────────────────────────

resolver.define('discoverJira', async ({ payload }) => {
  try {
    const data = await discoverAll(payload?.projectKey);
    return { success: true, ...data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: message,
      projects: [],
      fields: [],
      issueTypes: [],
      statuses: [],
    };
  }
});

resolver.define('discoverLinkTypes', async () => {
  try {
    const linkTypes = await getIssueLinkTypes();
    return { success: true, linkTypes };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err), linkTypes: [] };
  }
});

resolver.define('discoverIssueTypes', async ({ payload }) => {
  const issueTypes = await discoverIssueTypes(payload.projectKey);
  return { success: true, issueTypes };
});

resolver.define('discoverStatuses', async ({ payload }) => {
  const statuses = await discoverStatuses(payload.projectKey);
  return { success: true, statuses };
});


// ─── Work Instructions ────────────────────────────────────────────────────────

resolver.define('uploadWi', async ({ payload, context }) => {
  await ensureAdmin(context);
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  
  const wiCheck = checkFeatureAllowed('maxWiDocs', config);
  if (!wiCheck.allowed) return { success: false, error: wiCheck.reason };

  const limits = getLimits(config.tier);
  if (limits.maxWiDocs !== -1) {
    const existing = await listDocs();
    if (existing.length >= limits.maxWiDocs) {
      return {
        success: false,
        error: `Your plan allows up to ${limits.maxWiDocs} reference document(s). Remove one to upload another.`,
      };
    }
  }

  const buffer = Buffer.from(payload.fileBase64, 'base64');
  const result = await ingestPdf({
    filename: payload.filename,
    buffer,
    revision: payload.revision,
    targetProjects: payload.projectKey ? [payload.projectKey] : ['*'],
  });

  return { success: true, ...result };
});

resolver.define('listWiDocs', async ({ payload }) => {
  const docs = await listDocs(payload?.projectKey);
  return { success: true, docs };
});

// saveProjectConfig implementation below


resolver.define('saveProjectConfig', async ({ payload, context }) => {
  const { projectKey, arMapping, domainContext, goldSources } = payload;
  await ensureAdmin(context, projectKey);
  
  const current = await getConfig();
  
  // AR Mappings
  if (arMapping) {
    const idx = current.arMappings.findIndex(m => m.projectKey === projectKey);
    // Note: arMapping already contains issueLinkType if passed from the frontend
    if (idx >= 0) current.arMappings[idx] = arMapping;
    else current.arMappings.push(arMapping);
  }
  
  // Domain Contexts
  if (domainContext !== undefined) {
    const idx = current.domainContexts.findIndex(c => c.projectKey === projectKey);
    if (idx >= 0) current.domainContexts[idx] = { projectKey, context: domainContext };
    else current.domainContexts.push({ projectKey, context: domainContext });
  }
  
  // Gold Sources
  if (goldSources) {
    // Keep sources that don't target this project
    const otherSources = current.goldSources.filter(s => !s.targetProjects?.includes(projectKey));
    // Add the new ones, ensuring they target this project
    const projectSources = goldSources.map((s: any) => ({
      ...s,
      targetProjects: s.targetProjects?.includes(projectKey) ? s.targetProjects : [...(s.targetProjects || []), projectKey]
    }));
    current.goldSources = [...otherSources, ...projectSources];
  }
  
  const result = await saveConfig(current);
  return { success: result };
});

resolver.define('removeWiDoc', async ({ payload, context }) => {
  await ensureAdmin(context);
  await removeDoc(payload.docId);
  return { success: true };
});

// ─── Gold Standards Cache ─────────────────────────────────────────────────────

resolver.define('getCacheInfo', async () => {
  const info = await getCacheInfo();
  return { success: true, ...info };
});

resolver.define('refreshCache', async ({ context }) => {
  await ensureAdmin(context);
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  
  if (!config.goldSources.length) {
    return { success: false, error: 'No gold standard sources configured.' };
  }
  const cache = await refreshGoldCache(config.goldSources);
  return { success: true, itemCount: cache.itemCount, cachedAt: cache.cachedAt };
});

// ─── Conversation History ─────────────────────────────────────────────────────

resolver.define('getHistory', async ({ payload, context }) => {
  const limit = payload?.limit ?? 30;
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const index = await entityGet<Array<{ sessionId: string; title: string; updatedAt: string; turnCount: number }>>(
    KEYS.userConversationIndex(accountId),
  ) ?? [];
  return { success: true, conversations: index.slice(0, limit) };
});

resolver.define('getConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const conv = await entityGet(KEYS.userConversations(accountId, payload.sessionId));
  return { success: true, conversation: conv };
});

resolver.define('saveConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const key = KEYS.userConversations(accountId, payload.sessionId);
  const existing = await entityGet<Record<string, unknown>>(key);
  if (existing) {
    existing.saved = true;
    await entitySet(key, existing);
  }
  return { success: true };
});

resolver.define('deleteConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const indexKey = KEYS.userConversationIndex(accountId);
  const index = await entityGet<Array<{ sessionId: string }>>(indexKey) ?? [];
  await entitySet(indexKey, index.filter(e => e.sessionId !== payload.sessionId));
  return { success: true };
});

resolver.define('toggleBookmark', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const indexKey = KEYS.userConversationIndex(accountId);
  const index = await entityGet<Array<any>>(indexKey) ?? [];
  const entry = index.find(e => e.sessionId === payload.sessionId);
  if (entry) {
    entry.isPinned = payload.isPinned;
    await entitySet(indexKey, index);
  }
  return { success: true };
});

resolver.define('renameConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const key = KEYS.userConversations(accountId, payload.sessionId);
  const existing = await entityGet<Record<string, unknown>>(key);
  if (existing) {
    existing.title = payload.title;
    await entitySet(key, existing);
  }
  return { success: true };
});

resolver.define('updateConversationFeatures', async ({ payload, context }) => {
  try {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const key = KEYS.userConversations(accountId, payload.sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, any>> }>(key);
    if (existing?.turns) {
      const lastTurn = existing.turns[existing.turns.length - 1];
      if (lastTurn) {
        lastTurn.features = payload.features;
        await entitySet(key, existing);
      }
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

// ─── Session Persistence (cross-device, Forge Storage backed) ────────────────

resolver.define('getLastSession', async ({ context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = await entityGet<string>(KEYS.userLastSession(accountId));
  return { success: true, sessionId: sessionId ?? null };
});

resolver.define('setLastSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  await entitySet(KEYS.userLastSession(accountId), payload.sessionId);
  return { success: true };
});

resolver.define('getIssueSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = await entityGet<string>(KEYS.userIssueSession(accountId, payload.issueKey));
  return { success: true, sessionId: sessionId ?? null };
});

resolver.define('setIssueSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  await entitySet(KEYS.userIssueSession(accountId, payload.issueKey), payload.sessionId);
  return { success: true };
});

// ─── Usage ────────────────────────────────────────────────────────────────────

resolver.define('getUsage', async ({ context }) => {
  const config = await getConfig();
  const usage = await getUsage();
  const limits = getLimits(config.tier);
  const license = context?.license ?? { active: true, licenseType: 'COMMERCIAL' }; // Default to active for dev/staging
  return {
    success: true,
    usage: {
      currentMonth: usage.generations,
      month: usage.month,
    },
    limits,
    tier: config.tier,
    license,
  };
});

resolver.define('resetUsage', async ({ context }) => {
  await ensureAdmin(context);
  await entityDelete(KEYS.usageCurrentMonth);
  return { success: true };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function updateLatestTurnFeatures(
  sessionId: string,
  accountId: string,
  features: Feature[],
  turnType: 'refine',
  feedback: string,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, unknown>> }>(key);
    if (existing?.turns) {
      existing.turns.push({
        turnType,
        features,
        feedback,
        timestamp: new Date().toISOString(),
      });
      await entitySet(key, existing);
    }
  } catch {
    // ignore
  }
}

export const handler = resolver.getDefinitions();
