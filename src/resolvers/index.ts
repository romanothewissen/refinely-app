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
import { randomUUID } from 'crypto';
import { getConfig, saveConfig, patchConfig } from '../services/tenant-config';
import { resolveAiExecutionPolicy, resolveGeneratorConfig } from '../services/ai-policy';
import { getAiInsightsReport, upsertAiSessionInsight } from '../services/ai-insights';
import { checkGenerationAllowed, checkFeatureAllowed, getLimits, getUsage, getEffectiveTier } from '../services/billing';
import { entityGet, entitySet, objectWrite, KEYS } from '../services/cache';
import { REDACTED } from '../types';
import {
  appendComplianceAuditEvent,
  listComplianceAuditEvents,
  listTransparencyReports,
  fetchRecentJiraAuditRecords,
  maskPiiText,
  maskPiiInAnswers,
  saveTransparencyReport,
} from '../services/compliance';

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
import { findSimilarStories, getBacklogCacheInfo, refreshBacklogCache, diagnoseBacklogCache } from '../core/similar-stories';
import { buildAskSystemPrompt } from '../core/prompts';
import { callLlm } from '../core/llm';
import { ClarifyAnswer, ClarifyQuestion, Feature, GenerationEvent, ClarifyEvent } from '../types';

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

async function recordRuntimeVersionIfChanged(actorAccountId?: string, auditEnabled?: boolean) {
  if (!auditEnabled) return;
  const runtimeVersion =
    process.env.FORGE_DEPLOYMENT_ID ||
    process.env.FORGE_APP_VERSION ||
    process.env.FORGE_ENV ||
    'runtime-unknown';
  const previous = await entityGet<string>(KEYS.complianceRuntimeVersion);
  if (previous !== runtimeVersion) {
    await entitySet(KEYS.complianceRuntimeVersion, runtimeVersion);
    await appendComplianceAuditEvent({
      actorAccountId,
      category: 'runtime',
      action: 'APP_AUTO_UPDATE_DETECTED',
      details: { previousVersion: previous ?? null, currentVersion: runtimeVersion },
      enabled: true,
    });
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

resolver.define('getConfig', async ({ context, payload }) => {
  const config = await getConfig();
  const isAdmin = await checkAdmin(context);
  await recordRuntimeVersionIfChanged((context as { accountId?: string })?.accountId, Boolean(config.compliance?.auditTrailEnabled));
  
  if (config.generatorConfig) {
    const gc = config.generatorConfig;
    // Scrub keys for the frontend
    if (gc.geminiApiKey) gc.geminiApiKey = REDACTED;
    if (gc.openaiApiKey) gc.openaiApiKey = REDACTED;
    if (gc.azureOpenaiApiKey) gc.azureOpenaiApiKey = REDACTED;
  }
  
  return {
    ...config,
    isAdmin,
    effectiveAiPolicy: resolveAiExecutionPolicy(config, payload?.projectKey),
    effectiveGeneratorConfig: resolveGeneratorConfig(config, payload?.projectKey, payload?.reasoningMode),
  };
});

resolver.define('getAiInsights', async ({ context }) => {
  await ensureAdmin(context);
  return {
    success: true,
    insights: await getAiInsightsReport(),
  };
});

resolver.define('saveConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  
  // Key preservation logic
  const existingConfig = await getConfig();
  const egc = existingConfig.generatorConfig || {};
  const ngc = payload.generatorConfig || {};
  
  if (ngc.geminiApiKey === REDACTED) ngc.geminiApiKey = egc.geminiApiKey;
  if (ngc.openaiApiKey === REDACTED) ngc.openaiApiKey = egc.openaiApiKey;
  if (ngc.azureOpenaiApiKey === REDACTED) ngc.azureOpenaiApiKey = egc.azureOpenaiApiKey;
  
  await saveConfig(payload);

  const actorAccountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const modelFields = ['provider', 'profileMode', 'fastProfileProvider', 'fastProfileModel', 'deepProfileProvider', 'deepProfileModel', 'decompositionModel', 'arModel', 'clarifyModel', 'refineModel', 'evaluateModel', 'themeModel'];
  const changedModelFields = modelFields.filter((field) => {
    return ngc[field] !== undefined && ngc[field] !== egc[field];
  });
  const apiKeyRotated = Boolean(
    (ngc.geminiApiKey && ngc.geminiApiKey !== REDACTED && ngc.geminiApiKey !== egc.geminiApiKey) ||
    (ngc.openaiApiKey && ngc.openaiApiKey !== REDACTED && ngc.openaiApiKey !== egc.openaiApiKey) ||
    (ngc.azureOpenaiApiKey && ngc.azureOpenaiApiKey !== REDACTED && ngc.azureOpenaiApiKey !== egc.azureOpenaiApiKey),
  );
  const auditEnabled = Boolean(existingConfig.compliance?.auditTrailEnabled || payload?.compliance?.auditTrailEnabled);
  if (changedModelFields.length > 0) {
    await appendComplianceAuditEvent({
      actorAccountId,
      category: 'prompt',
      action: 'PROMPT_LOGIC_UPDATED',
      details: { changedModelFields },
      enabled: auditEnabled,
    });
  }
  if (apiKeyRotated) {
    await appendComplianceAuditEvent({
      actorAccountId,
      category: 'security',
      action: 'API_KEY_ROTATED',
      details: {
        providerKeysUpdated: [
          ngc.geminiApiKey && ngc.geminiApiKey !== REDACTED ? 'gemini' : null,
          ngc.openaiApiKey && ngc.openaiApiKey !== REDACTED ? 'openai' : null,
          ngc.azureOpenaiApiKey && ngc.azureOpenaiApiKey !== REDACTED ? 'azure_openai' : null,
        ].filter(Boolean),
      },
      enabled: auditEnabled,
    });
  }
  await appendComplianceAuditEvent({
    actorAccountId,
    category: 'config',
    action: 'CONFIG_UPDATED',
    details: { topLevelKeys: Object.keys(payload ?? {}) },
    enabled: auditEnabled,
  });
  return { success: true };
});

resolver.define('patchConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  const actorAccountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const current = await getConfig();
  const result = await patchConfig(payload);
  await appendComplianceAuditEvent({
    actorAccountId,
    category: 'config',
    action: 'CONFIG_PATCHED',
    details: { keys: Object.keys(payload ?? {}) },
    enabled: Boolean(current.compliance?.auditTrailEnabled || payload?.compliance?.auditTrailEnabled),
  });
  return result;
});

resolver.define('testLlmConnection', async ({ payload, context }) => {
  await ensureAdmin(context);
  try {
    const cfg = await getConfig();
    const gc = cfg.generatorConfig || {};
    
    const isGemini = payload.provider === 'gemini';
    const isOpenAI = payload.provider === 'openai';
    const isAzureOpenAI = payload.provider === 'azure_openai';

    const res = await callLlm({
      provider: payload.provider,
      model: payload.model || 'test',
      geminiApiKey: isGemini ? (payload.geminiApiKey === REDACTED ? gc.geminiApiKey : (payload.geminiApiKey?.trim() || gc.geminiApiKey)) : undefined,
      geminiBaseUrl: isGemini ? (payload.geminiBaseUrl?.trim() || gc.geminiBaseUrl) : undefined,
      openaiApiKey: isOpenAI ? (payload.openaiApiKey === REDACTED ? gc.openaiApiKey : (payload.openaiApiKey?.trim() || gc.openaiApiKey)) : undefined,
      openaiBaseUrl: isOpenAI ? (payload.openaiBaseUrl?.trim() || gc.openaiBaseUrl) : undefined,
      azureOpenaiApiKey: isAzureOpenAI ? (payload.azureOpenaiApiKey === REDACTED ? gc.azureOpenaiApiKey : (payload.azureOpenaiApiKey?.trim() || gc.azureOpenaiApiKey)) : undefined,
      azureOpenaiEndpoint: isAzureOpenAI ? (payload.azureOpenaiEndpoint?.trim() || gc.azureOpenaiEndpoint) : undefined,
      azureOpenaiDeployment: isAzureOpenAI ? (payload.azureOpenaiDeployment?.trim() || gc.azureOpenaiDeployment) : undefined,
      azureOpenaiApiVersion: isAzureOpenAI ? (payload.azureOpenaiApiVersion?.trim() || gc.azureOpenaiApiVersion) : undefined,
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

// ─── Dynamic model list ───────────────────────────────────────────────────────

const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

resolver.define('fetchAvailableModels', async ({ payload, context }) => {
  await ensureAdmin(context);
  const provider: string = payload.provider;

  // Return cached result if fresh
  const cacheKey = `model_list_${provider}`;
  try {
    const cached = await entityGet(cacheKey) as { models: { id: string; label: string }[]; fetchedAt: number } | null;
    if (cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL_MS) {
      return { success: true, models: cached.models, fromCache: true };
    }
  } catch { /* cache miss — continue */ }

  const cfg = await getConfig();
  const gc = cfg.generatorConfig || {};

  try {
    let models: { id: string; label: string }[] = [];

    if (provider === 'openai') {
      const apiKey = gc.openaiApiKey?.trim();
      if (!apiKey) return { success: false, error: 'OpenAI API key not configured yet.' };
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return { success: false, error: `OpenAI API returned ${res.status}` };
      const data = await res.json() as { data: { id: string; object: string }[] };
      models = (data.data || [])
        .filter((m) => m.object === 'model' && /^(gpt-|o[0-9]|chatgpt-)/.test(m.id))
        .sort((a, b) => a.id < b.id ? 1 : -1)
        .map((m) => ({ id: m.id, label: m.id }));

    } else if (provider === 'gemini') {
      const apiKey = gc.geminiApiKey?.trim();
      if (!apiKey) return { success: false, error: 'Gemini API key not configured yet.' };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=100`);
      if (!res.ok) return { success: false, error: `Gemini API returned ${res.status}` };
      const data = await res.json() as { models: { name: string; displayName: string; supportedGenerationMethods?: string[] }[] };
      models = (data.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && m.name.includes('gemini'))
        .map((m) => ({ id: m.name.replace('models/', ''), label: m.displayName || m.name.replace('models/', '') }))
        .sort((a, b) => a.id < b.id ? 1 : -1);

    } else {
      return { success: false, error: `Dynamic model list not available for provider: ${provider}` };
    }

    await entitySet(cacheKey, { models, fetchedAt: Date.now() });
    return { success: true, models, fromCache: false };
  } catch (err) {
    const message = String((err as { message?: unknown })?.message ?? err ?? 'Unknown error');
    return { success: false, error: message };
  }
});

// ─── Generation (queue dispatch) ─────────────────────────────────────────────

resolver.define('startGeneration', async ({ payload, context }) => {
  const config = await getConfig();
  const effectivePolicy = resolveAiExecutionPolicy(config, payload.projectKey || '*');
  const effectiveGeneratorConfig = resolveGeneratorConfig(
    config,
    payload.projectKey || '*',
    payload.reasoningMode,
  );
  const eventConfig = {
    ...config,
    aiExecutionPolicy: effectivePolicy,
    generatorConfig: effectiveGeneratorConfig,
  };

  const check = await checkGenerationAllowed(eventConfig, context);
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
    config: eventConfig,
    license: context?.license,
    goldExamples: '',   // fetched inside queue consumer
    wiContext: '',      // fetched inside queue consumer
    projectKey: payload.projectKey || '*',
    reasoningMode: payload.reasoningMode,
    outputMode: payload.outputMode,
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
    const eventConfig = {
      ...config,
      aiExecutionPolicy: resolveAiExecutionPolicy(config, payload.projectKey || '*'),
      generatorConfig: resolveGeneratorConfig(config, payload.projectKey || '*', payload.reasoningMode),
    };
    const clarifyQueue = new Queue({ key: 'clarify-queue' });
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const runId = randomUUID();
    const event: ClarifyEvent = {
      runId,
      sessionId: payload.sessionId,
      accountId,
      requirement: payload.requirement,
      attachmentText: payload.attachmentText ?? '',
      config: eventConfig,
      license: context?.license,
      projectKey: payload.projectKey || '*',
      reasoningMode: payload.reasoningMode,
      outputMode: payload.outputMode,
    };
    // Overwrite any stale result with a 'pending' marker so the polling hook waits
    await entitySet(KEYS.clarifyProgress(payload.sessionId), {
      type: 'pending',
      message: 'Preparing discovery workflow…',
      runId,
      phase: 'queued',
      updatedAt: Date.now(),
    });
    const pushResult = await clarifyQueue.push({
      body: event,
      concurrency: {
        key: `clarify-${payload.sessionId}`,
        limit: 1,
      },
    });
    await entitySet(KEYS.clarifyProgress(payload.sessionId), {
      type: 'pending',
      message: 'Preparing discovery workflow…',
      runId,
      jobId: pushResult.jobId,
      phase: 'queued',
      updatedAt: Date.now(),
    });
    return { success: true, runId, jobId: pushResult.jobId };
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
  const config = {
    ...eventConfig,
    aiExecutionPolicy: resolveAiExecutionPolicy(eventConfig, payload.projectKey || '*'),
    generatorConfig: resolveGeneratorConfig(eventConfig, payload.projectKey || '*', payload.reasoningMode),
    tier: getEffectiveTier(eventConfig, context),
  };
  const result = await evaluateSufficiency({
    requirement: payload.requirement,
    answers: payload.answers as ClarifyAnswer[],
    config,
    reasoningMode: payload.reasoningMode,
  });
  if (payload?.sessionId) {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await persistDiscoveryCoverage(payload.sessionId, accountId, result);
  }
  return result;
});

resolver.define('saveDiscoveryRound', async ({ payload, context }) => {
  try {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await persistDiscoveryRound(
      payload.sessionId,
      accountId,
      Number(payload.roundNumber) || 1,
      normaliseQuestions(payload.questions),
      normaliseAnswers(payload.answers),
      payload.coverage,
    );
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

// ─── Refine ───────────────────────────────────────────────────────────────────

resolver.define('refineFeatures', async ({ payload, context }) => {
  try {
    const eventConfig = await getConfig();
    const config = {
      ...eventConfig,
      generatorConfig: resolveGeneratorConfig(eventConfig, payload.projectKey || '*', 'fast'),
      tier: getEffectiveTier(eventConfig, context),
    };
    const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
    const maskedRequirement = maskPiiText(payload.requirement ?? '', piiEnabled);
    const maskedFeedback = maskPiiText(payload.feedback ?? '', piiEnabled);
    const result = await refineFeatures({
      requirement: maskedRequirement.text,
      features: payload.features as Feature[],
      feedback: maskedFeedback.text,
      config,
    });

    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await updateLatestTurnFeatures(payload.sessionId, accountId, result.features, 'refine', payload.feedback, result.tokenUsage);
    if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
      await saveTransparencyReport({
        sessionId: payload.sessionId,
        turnType: 'refine',
        actorAccountId: accountId,
        provider: config.generatorConfig.provider,
        model: config.generatorConfig.refineModel,
        projectKey: payload.projectKey || '*',
        requirementExcerpt: String(payload.requirement ?? '').slice(0, 240),
        decisionSummary: [
          'Refinement applied based on explicit user feedback.',
          'Feature content preserved where feedback did not request structural changes.',
        ],
        contextUsage: {
          featureCount: Array.isArray(payload.features) ? payload.features.length : 0,
          feedbackLength: String(payload.feedback ?? '').length,
        },
        tokenUsage: result.tokenUsage,
        piiMasking: {
          enabled: piiEnabled,
          totalRedactions: maskedRequirement.stats.totalRedactions + maskedFeedback.stats.totalRedactions,
          byType: {
            ...maskedRequirement.stats.byType,
            ...maskedFeedback.stats.byType,
          },
        },
      });
    }

    return { success: true, features: result.features, tokenUsage: result.tokenUsage };
  } catch (err: any) {
    console.error('refineFeatures failed:', err);
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

resolver.define('refineSingleFeature', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = {
    ...eventConfig,
    generatorConfig: resolveGeneratorConfig(eventConfig, payload.projectKey || '*', 'fast'),
    tier: getEffectiveTier(eventConfig, context),
  };
  const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
  const maskedFeedback = maskPiiText(payload.feedback ?? '', piiEnabled);
  const result = await refineSingleFeature({
    feature: payload.feature as Feature,
    feedback: maskedFeedback.text,
    config,
  });
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  if (sessionId) {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await updateLatestTurnFeatures(
      sessionId,
      accountId,
      [result.feature],
      'refine',
      payload.feedback,
      result.tokenUsage,
    );
    if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
      await saveTransparencyReport({
        sessionId,
        turnType: 'refine',
        actorAccountId: accountId,
        provider: config.generatorConfig.provider,
        model: config.generatorConfig.refineModel,
        projectKey: payload.projectKey || '*',
        requirementExcerpt: String(payload.feature?.summary ?? '').slice(0, 240),
        decisionSummary: [
          'Single-feature refinement generated from direct feedback.',
          'Summary/description/story points remain stable unless feedback explicitly targets them.',
        ],
        contextUsage: {
          featureId: payload.feature?.id,
          feedbackLength: String(payload.feedback ?? '').length,
        },
        tokenUsage: result.tokenUsage,
        piiMasking: maskedFeedback.stats,
      });
    }
  }
  return { success: true, feature: result.feature, tokenUsage: result.tokenUsage };
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
  const config = {
    ...eventConfig,
    generatorConfig: resolveGeneratorConfig(eventConfig, payload.projectKey || '*', 'fast'),
    tier: getEffectiveTier(eventConfig, context),
  };
  const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
  const maskedPrompt = maskPiiText(payload.message ?? '', piiEnabled);
  const maskedHistory = maskPiiInAnswers(
    (payload.history ?? []).map((item: any) => ({
      question: String(item?.role ?? ''),
      answer: String(item?.content ?? ''),
    })),
    piiEnabled,
  );

  const [wiContext, similarItems] = await Promise.all([
    config.wiConfig.enabled ? retrieveWiContext(maskedPrompt.text, 4, 20000, '*') : Promise.resolve({ text: '', docs: [] }),
    findSimilarStories(maskedPrompt.text, config, payload.projectKey || '*'),
  ]);

  const systemPrompt = buildAskSystemPrompt({
    domainContext: config.domainContext,
    wiContext: wiContext.text,
    similarItems: similarItems.map(s => `${s.key}: ${s.summary}`).join('\n'),
  });

  const reply = await askQuestion({
    message: maskedPrompt.text,
    history: (payload.history ?? []).map((h: any, idx: number) => ({
      role: h.role,
      content: maskedHistory.answers[idx]?.answer ?? h.content,
    })),
    systemPrompt,
    config,
  });

  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
    await saveTransparencyReport({
      sessionId: String(payload.sessionId ?? 'chat'),
      turnType: 'ask',
      actorAccountId: accountId,
      provider: config.generatorConfig.provider,
      model: config.generatorConfig.arModel,
      projectKey: payload.projectKey || '*',
      requirementExcerpt: String(payload.message ?? '').slice(0, 240),
      decisionSummary: [
        'Response grounded in domain context, work instructions, and retrieved backlog examples.',
      ],
      contextUsage: {
        similarItemsCount: similarItems.length,
        wiContextChars: wiContext.text.length,
      },
      piiMasking: {
        enabled: piiEnabled,
        totalRedactions: maskedPrompt.stats.totalRedactions + maskedHistory.stats.totalRedactions,
        byType: {
          ...maskedPrompt.stats.byType,
          ...maskedHistory.stats.byType,
        },
      },
    });
  }

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
  const { projectKey, arMapping, domainContext, goldSources, backlogStatuses } = payload;
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

  if (Array.isArray(backlogStatuses)) {
    const otherScopes = (current.backlogStatusScopes || []).filter(scope => scope.projectKey !== projectKey);
    current.backlogStatusScopes = [
      ...otherScopes,
      {
        projectKey,
        statuses: [...new Set(backlogStatuses.filter(Boolean))],
      },
    ];
  }
  
  const result = await saveConfig(current);
  await appendComplianceAuditEvent({
    actorAccountId: (context as { accountId?: string })?.accountId ?? 'unknown',
    category: 'config',
    action: 'PROJECT_CONFIG_UPDATED',
    details: {
      projectKey,
      updated: {
        arMapping: !!arMapping,
        domainContext: domainContext !== undefined,
        goldSources: !!goldSources,
        backlogStatuses: Array.isArray(backlogStatuses),
      },
    },
    enabled: Boolean(current.compliance?.auditTrailEnabled),
  });
  return { success: result };
});

resolver.define('listComplianceAuditEvents', async ({ payload, context }) => {
  await ensureAdmin(context);
  const events = await listComplianceAuditEvents(payload?.limit ?? 100);
  return { success: true, events };
});

resolver.define('listTransparencyReports', async ({ payload, context }) => {
  await ensureAdmin(context);
  const reports = await listTransparencyReports({
    sessionId: payload?.sessionId,
    turnType: payload?.turnType,
    limit: payload?.limit ?? 100,
  });
  return { success: true, reports };
});

resolver.define('getJiraAuditRecords', async ({ payload, context }) => {
  await ensureAdmin(context);
  const records = await fetchRecentJiraAuditRecords(payload?.limit ?? 50);
  return { success: true, records };
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

resolver.define('getBacklogCacheInfo', async ({ payload }) => {
  const projectKey = payload?.projectKey || '*';
  const info = await getBacklogCacheInfo(projectKey);
  return { success: true, ...info };
});

resolver.define('diagnoseBacklogCache', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  const projectKey = payload?.projectKey || '*';
  if (!projectKey || projectKey === '*') {
    return { success: false, error: 'Select a project before diagnosing the backlog cache.' };
  }
  const diagnostics = await diagnoseBacklogCache(projectKey, config);
  return { success: true, diagnostics };
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

resolver.define('refreshBacklogCache', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  const projectKey = payload?.projectKey || '*';
  if (!projectKey || projectKey === '*') {
    return { success: false, error: 'Select a project before refreshing the backlog cache.' };
  }
  const cache = await refreshBacklogCache(projectKey, config);
  const diagnostics = await diagnoseBacklogCache(projectKey, config);
  return { success: true, ...cache, diagnostics };
});

// ─── Conversation History ─────────────────────────────────────────────────────

resolver.define('getHistory', async ({ payload, context }) => {
  const limit = payload?.limit ?? 30;
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const index = await entityGet<Array<{ sessionId: string; title: string; updatedAt: string; turnCount: number }>>(
    KEYS.userConversationIndex(accountId),
  ) ?? [];
  const conversations = await Promise.all(
    index.slice(0, limit).map(async (entry) => {
      const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(
        KEYS.userConversations(accountId, entry.sessionId),
      );
      const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
      const lastTurn = turns[turns.length - 1];
      const latestClarifyWithCoverage = [...turns]
        .reverse()
        .find(turn => turn?.turnType === 'clarify' && turn?.clarifyContext?.discoveryCoverage);
      const latestTranscriptOwner = [...turns]
        .reverse()
        .find(turn => turn?.generationContext?.discoveryTranscript || turn?.clarifyContext?.discoveryTranscript);
      const discoveryTranscript = latestTranscriptOwner?.generationContext?.discoveryTranscript
        ?? latestTranscriptOwner?.clarifyContext?.discoveryTranscript
        ?? [];

      return {
        ...entry,
        lastTurnType: lastTurn?.turnType ?? null,
        lastFeatureCount: Array.isArray(lastTurn?.features) ? lastTurn.features.length : 0,
        lastScopeMode:
          lastTurn?.generationContext?.plannerDecision?.scopeMode ??
          lastTurn?.clarifyContext?.plannerDecision?.scopeMode ??
          null,
        lastDiscoveryScore: latestClarifyWithCoverage?.clarifyContext?.discoveryCoverage?.overallScore ?? null,
        lastDiscoverySummary: latestClarifyWithCoverage?.clarifyContext?.discoveryCoverage?.summary ?? null,
        lastMissingCriticalCount: latestClarifyWithCoverage?.clarifyContext?.discoveryCoverage?.missingCritical?.length ?? 0,
        lastDiscoveryRoundCount: Array.isArray(discoveryTranscript) ? discoveryTranscript.length : 0,
        discoveryTranscriptPreview: Array.isArray(discoveryTranscript)
          ? discoveryTranscript.slice(0, 4).map((round: Record<string, any>) => ({
              roundNumber: round?.roundNumber ?? 0,
              answerCount: Array.isArray(round?.answers) ? round.answers.length : 0,
              summary: round?.coverage?.summary ?? null,
              highlights: Array.isArray(round?.answers)
                ? round.answers
                    .slice(0, 2)
                    .map((answer: Record<string, any>) => ({
                      question: String(answer?.question ?? ''),
                      answer: String(answer?.answer ?? ''),
                    }))
                : [],
            }))
          : [],
      };
    }),
  );
  return { success: true, conversations };
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

resolver.define('getSidebarWidth', async ({ context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const width = await entityGet<number>(KEYS.userSidebarWidth(accountId));
  return { success: true, width: width ?? null };
});

resolver.define('setSidebarWidth', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  await entitySet(KEYS.userSidebarWidth(accountId), Number(payload.width));
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
  tokenUsage?: any,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, unknown>> }>(key);
    if (existing?.turns) {
      existing.turns.push({
        turnType,
        features,
        feedback,
        tokenUsage,
        timestamp: new Date().toISOString(),
      });
      await entitySet(key, existing);
    }
  } catch {
    // ignore
  }
}

function mergeTokenUsage(
  existing?: { input?: number; output?: number; total?: number; byStage?: Record<string, { input: number; output: number; total: number }> },
  next?: { input?: number; output?: number; total?: number; byStage?: Record<string, { input: number; output: number; total: number }> },
) {
  if (!existing && !next) return undefined;
  return {
    input: (existing?.input ?? 0) + (next?.input ?? 0),
    output: (existing?.output ?? 0) + (next?.output ?? 0),
    total: (existing?.total ?? 0) + (next?.total ?? 0),
    byStage: {
      ...(existing?.byStage ?? {}),
      ...(next?.byStage ?? {}),
    },
  };
}

function normaliseQuestions(raw: unknown): ClarifyQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({
      category: String(item.category ?? 'Functional Flow').trim() || 'Functional Flow',
      question: String(item.question ?? '').trim(),
      suggestions: Array.isArray(item.suggestions)
        ? item.suggestions.map(value => String(value ?? '').trim()).filter(Boolean).slice(0, 5)
        : [],
    }))
    .filter(item => item.question.length > 0);
}

function normaliseAnswers(raw: unknown): ClarifyAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(item => ({
      question: String(item.question ?? '').trim(),
      answer: String(item.answer ?? '').trim(),
    }))
    .filter(item => item.question.length > 0 || item.answer.length > 0);
}

async function persistDiscoveryRound(
  sessionId: string,
  accountId: string,
  roundNumber: number,
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
  coverage?: Record<string, any>,
) {
  const key = KEYS.userConversations(accountId, sessionId);
  const existing = await entityGet<{ turns: Array<Record<string, any>> }>(key);
  if (!existing?.turns?.length) return;

  const clarifyTurn = [...existing.turns]
    .reverse()
    .find(turn => turn?.turnType === 'clarify');

  if (!clarifyTurn) return;

  const existingTranscript = Array.isArray(clarifyTurn?.clarifyContext?.discoveryTranscript)
    ? [...clarifyTurn.clarifyContext.discoveryTranscript]
    : [];

  const nextRound = {
    roundNumber,
    questions,
    answers,
    coverage,
    submittedAt: new Date().toISOString(),
  };

  const roundIndex = existingTranscript.findIndex((round: Record<string, any>) => Number(round?.roundNumber) === roundNumber);
  if (roundIndex >= 0) {
    existingTranscript[roundIndex] = {
      ...existingTranscript[roundIndex],
      ...nextRound,
      questions: questions.length ? questions : existingTranscript[roundIndex].questions ?? [],
      answers: answers.length ? answers : existingTranscript[roundIndex].answers ?? [],
      coverage: coverage ?? existingTranscript[roundIndex].coverage,
    };
  } else {
    existingTranscript.push(nextRound);
    existingTranscript.sort((left: Record<string, any>, right: Record<string, any>) => Number(left.roundNumber) - Number(right.roundNumber));
  }

  const mergedTokenUsage = clarifyTurn?.clarifyContext?.tokenUsage;
  const totalDiscoveryQuestions = existingTranscript.reduce(
    (sum: number, round: Record<string, any>) => sum + (Array.isArray(round?.questions) ? round.questions.length : 0),
    0,
  );
  const totalDiscoveryAnswers = existingTranscript.reduce(
    (sum: number, round: Record<string, any>) => sum + (Array.isArray(round?.answers) ? round.answers.length : 0),
    0,
  );
  const latestCoverage = coverage ?? clarifyTurn?.clarifyContext?.discoveryCoverage;
  const plannerDecision = clarifyTurn?.clarifyContext?.plannerDecision;

  clarifyTurn.clarifyContext = {
    ...(clarifyTurn.clarifyContext ?? {}),
    discoveryTranscript: existingTranscript,
    discoveryCoverage: latestCoverage,
    tokenUsage: mergedTokenUsage,
  };
  clarifyTurn.tokenUsage = mergedTokenUsage;

  await entitySet(key, existing);

  await upsertAiSessionInsight({
    sessionId,
    projectKey: clarifyTurn?.clarifyContext?.projectKey ?? '*',
    reasoningMode: plannerDecision?.reasoningMode,
    outputMode: plannerDecision?.outputMode,
    scopeMode: plannerDecision?.scopeMode,
    clarificationMode: plannerDecision?.clarificationMode,
    plannedFeatureTarget: plannerDecision?.featurePlan?.target,
    plannedQuestionTarget: plannerDecision?.questionPlan?.target,
    initialClarifyQuestionCount:
      typeof clarifyTurn?.clarifyContext?.ambiguityAssessment?.generatedQuestions === 'number'
        ? clarifyTurn.clarifyContext.ambiguityAssessment.generatedQuestions
        : undefined,
    discoveryRounds: existingTranscript.length,
    totalDiscoveryQuestions,
    totalDiscoveryAnswers,
    latestCoverageScore: latestCoverage?.overallScore ?? null,
    latestMissingCriticalCount: latestCoverage?.missingCritical?.length ?? 0,
  });

  const progress = await entityGet<Record<string, any>>(KEYS.clarifyProgress(sessionId));
  if (progress?.contextMeta) {
    progress.contextMeta = {
      ...progress.contextMeta,
      discoveryTranscript: existingTranscript,
      discoveryCoverage: coverage ?? progress.contextMeta.discoveryCoverage,
      tokenUsage: progress.contextMeta.tokenUsage,
    };
    await entitySet(KEYS.clarifyProgress(sessionId), progress);
  }
}

async function persistDiscoveryCoverage(
  sessionId: string,
  accountId: string,
  coverage: Record<string, any>,
) {
  try {
    const key = KEYS.userConversations(accountId, sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, any>> }>(key);
    if (existing?.turns?.length) {
      const clarifyTurn = [...existing.turns]
        .reverse()
        .find(turn => turn?.turnType === 'clarify');

      if (clarifyTurn) {
        const mergedTokenUsage = mergeTokenUsage(clarifyTurn?.clarifyContext?.tokenUsage, coverage?.tokenUsage);
        clarifyTurn.clarifyContext = {
          ...(clarifyTurn.clarifyContext ?? {}),
          discoveryCoverage: coverage,
          tokenUsage: mergedTokenUsage,
        };
        clarifyTurn.tokenUsage = mergedTokenUsage;
        await entitySet(key, existing);
      }
    }

    const progress = await entityGet<Record<string, any>>(KEYS.clarifyProgress(sessionId));
    if (progress?.contextMeta) {
      progress.contextMeta = {
        ...progress.contextMeta,
        discoveryCoverage: coverage,
        tokenUsage: mergeTokenUsage(progress.contextMeta.tokenUsage, coverage?.tokenUsage),
      };
      await entitySet(KEYS.clarifyProgress(sessionId), progress);
    }
  } catch (err) {
    console.warn('[persistDiscoveryCoverage] Failed to persist discovery coverage:', err);
  }
}

export const handler = resolver.getDefinitions();
