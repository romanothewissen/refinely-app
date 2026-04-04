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
import { entityDelete, entityGet, entitySet, objectWrite, KEYS } from '../services/cache';
import { REDACTED } from '../types';
import {
  appendComplianceAuditEvent,
  getComplianceSummary,
  listComplianceAuditEvents,
  listTransparencyReports,
  mergePiiMaskingStats,
  maskPiiText,
  maskPiiInAnswers,
  previewPiiMasking,
  saveTransparencyReport,
} from '../services/compliance';
import { getProjectActivitySummary, recordProjectActivity } from '../services/project-activity';
import {
  buildCombinedDomainContext,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
} from '../services/project-selection';

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
import { extractDocumentText } from '../core/document-parser';
import { ingestPdf, listDocs, removeDoc } from '../core/wi-ingestion';
import { retrieveWiContext } from '../core/wi-ingestion';
import { findSimilarStories, getBacklogCacheInfo, diagnoseBacklogCache } from '../core/similar-stories';
import { buildAskSystemPrompt } from '../core/prompts';
import { callLlm, discoverLlmModelCatalog } from '../core/llm';
import { ClarifyAnswer, Feature, GenerationEvent, ClarifyEvent, RefineEvent } from '../types';

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

function normalizeFieldIds(fieldIds: Array<string | null | undefined> = []) {
  return [...new Set(fieldIds.map(id => id?.trim()).filter((id): id is string => Boolean(id)))];
}

function normalizeProjectArMapping(arMapping: any, projectKey?: string) {
  const legacyOutputArFieldIds = normalizeFieldIds(
    arMapping?.mode === 'iterative'
      ? arMapping?.iterativeFieldIds
      : arMapping?.consolidatedFieldId
        ? [arMapping.consolidatedFieldId]
        : [],
  );
  const hasOutputArFieldIds = Boolean(arMapping?.outputMappings && Object.prototype.hasOwnProperty.call(arMapping.outputMappings, 'arFieldIds'));
  const hasInputArFieldIds = Boolean(arMapping?.inputMappings && Object.prototype.hasOwnProperty.call(arMapping.inputMappings, 'arFieldIds'));
  const outputArFieldIds = hasOutputArFieldIds
    ? normalizeFieldIds(arMapping?.outputMappings?.arFieldIds)
    : legacyOutputArFieldIds;
  const inputArFieldIds = hasInputArFieldIds
    ? normalizeFieldIds(arMapping?.inputMappings?.arFieldIds)
    : outputArFieldIds;

  const outputMappings = {
    summaryFieldId: arMapping?.outputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: arMapping?.outputMappings?.descriptionFieldId || 'description',
    arFieldIds: outputArFieldIds,
  };
  const inputMappings = {
    summaryFieldId: arMapping?.inputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: arMapping?.inputMappings?.descriptionFieldId || 'description',
    arFieldIds: inputArFieldIds,
  };

  return {
    projectKey: arMapping?.projectKey || projectKey || '*',
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (arMapping?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: arMapping?.issueLinkType,
  };
}

function countConfiguredProjects(config: { arMappings?: any[]; domainContexts?: any[]; backlogStatusScopes?: any[] }) {
  const keys = new Set<string>();

  (config.arMappings ?? []).forEach((mapping) => {
    const key = String(mapping?.projectKey ?? '').trim();
    if (key && key !== '*') keys.add(key);
  });

  (config.domainContexts ?? []).forEach((entry) => {
    const key = String(entry?.projectKey ?? '').trim();
    if (key && key !== '*') keys.add(key);
  });

  (config.backlogStatusScopes ?? []).forEach((scope) => {
    const key = String(scope?.projectKey ?? '').trim();
    if (key && key !== '*') keys.add(key);
  });

  return keys.size;
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
  await recordRuntimeVersionIfChanged((context as { accountId?: string })?.accountId, Boolean(config.compliance?.auditTrailEnabled));
  
  if (config.generatorConfig) {
    const gc = config.generatorConfig;
    // Scrub keys for the frontend
    if (gc.anthropicApiKey) gc.anthropicApiKey = REDACTED;
    if (gc.geminiApiKey) gc.geminiApiKey = REDACTED;
    if (gc.openaiApiKey) gc.openaiApiKey = REDACTED;
    if (gc.azureOpenAIApiKey) gc.azureOpenAIApiKey = REDACTED;
  }
  
  return { ...config, isAdmin };
});

resolver.define('saveConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  
  // Key preservation logic
  const existingConfig = await getConfig();
  const egc = existingConfig.generatorConfig || {};
  const ngc = payload.generatorConfig || {};
  
  if (ngc.anthropicApiKey === REDACTED) ngc.anthropicApiKey = egc.anthropicApiKey;
  if (ngc.geminiApiKey === REDACTED) ngc.geminiApiKey = egc.geminiApiKey;
  if (ngc.openaiApiKey === REDACTED) ngc.openaiApiKey = egc.openaiApiKey;
  if (ngc.azureOpenAIApiKey === REDACTED) ngc.azureOpenAIApiKey = egc.azureOpenAIApiKey;
  
  await saveConfig(payload);

  const actorAccountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const modelFields = ['decompositionModel', 'arModel', 'clarifyModel', 'refineModel', 'evaluateModel', 'triageModel', 'themeModel'];
  const changedModelFields = modelFields.filter((field) => {
    return ngc[field] !== undefined && ngc[field] !== egc[field];
  });
  const apiKeyRotated = Boolean(
    (ngc.anthropicApiKey && ngc.anthropicApiKey !== REDACTED && ngc.anthropicApiKey !== egc.anthropicApiKey) ||
    (ngc.geminiApiKey && ngc.geminiApiKey !== REDACTED && ngc.geminiApiKey !== egc.geminiApiKey) ||
    (ngc.openaiApiKey && ngc.openaiApiKey !== REDACTED && ngc.openaiApiKey !== egc.openaiApiKey) ||
    (ngc.azureOpenAIApiKey && ngc.azureOpenAIApiKey !== REDACTED && ngc.azureOpenAIApiKey !== egc.azureOpenAIApiKey),
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
          ngc.anthropicApiKey && ngc.anthropicApiKey !== REDACTED ? 'anthropic' : null,
          ngc.geminiApiKey && ngc.geminiApiKey !== REDACTED ? 'gemini' : null,
          ngc.openaiApiKey && ngc.openaiApiKey !== REDACTED ? 'openai' : null,
          ngc.azureOpenAIApiKey && ngc.azureOpenAIApiKey !== REDACTED ? 'azure_openai' : null,
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
    
    const isAnthropic = payload.provider === 'anthropic';
    const isGemini = payload.provider === 'gemini';
    const isOpenAI = payload.provider === 'openai';
    const isAzureOpenAI = payload.provider === 'azure_openai';
    
    const res = await callLlm({
      provider: payload.provider,
      model: payload.model || 'test',
      anthropicApiKey: isAnthropic ? (payload.anthropicApiKey === REDACTED ? gc.anthropicApiKey : (payload.anthropicApiKey?.trim() || gc.anthropicApiKey)) : undefined,
      anthropicBaseUrl: isAnthropic ? (payload.anthropicBaseUrl?.trim() || gc.anthropicBaseUrl) : undefined,
      geminiApiKey: isGemini ? (payload.geminiApiKey === REDACTED ? gc.geminiApiKey : (payload.geminiApiKey?.trim() || gc.geminiApiKey)) : undefined,
      geminiBaseUrl: isGemini ? (payload.geminiBaseUrl?.trim() || gc.geminiBaseUrl) : undefined,
      openaiApiKey: isOpenAI ? (payload.openaiApiKey === REDACTED ? gc.openaiApiKey : (payload.openaiApiKey?.trim() || gc.openaiApiKey)) : undefined,
      openaiBaseUrl: isOpenAI ? (payload.openaiBaseUrl?.trim() || gc.openaiBaseUrl) : undefined,
      azureOpenAIApiKey: isAzureOpenAI ? (payload.azureOpenAIApiKey === REDACTED ? gc.azureOpenAIApiKey : (payload.azureOpenAIApiKey?.trim() || gc.azureOpenAIApiKey)) : undefined,
      azureOpenAIBaseUrl: isAzureOpenAI ? (payload.azureOpenAIBaseUrl?.trim() || gc.azureOpenAIBaseUrl) : undefined,
      azureOpenAIApiVersion: isAzureOpenAI ? (payload.azureOpenAIApiVersion?.trim() || gc.azureOpenAIApiVersion) : undefined,
      modelCatalog: payload.provider ? gc.modelCatalogs?.[payload.provider] : undefined,
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

resolver.define('discoverLlmModels', async ({ payload, context }) => {
  await ensureAdmin(context);
  try {
    const cfg = await getConfig();
    const gc = cfg.generatorConfig || {};
    const provider = payload?.provider || gc.provider || 'forge_llms';
    const catalog = await discoverLlmModelCatalog({
      provider,
      anthropicApiKey: payload?.anthropicApiKey === REDACTED ? gc.anthropicApiKey : (payload?.anthropicApiKey?.trim() || gc.anthropicApiKey),
      anthropicBaseUrl: payload?.anthropicBaseUrl?.trim() || gc.anthropicBaseUrl,
      geminiApiKey: payload?.geminiApiKey === REDACTED ? gc.geminiApiKey : (payload?.geminiApiKey?.trim() || gc.geminiApiKey),
      geminiBaseUrl: payload?.geminiBaseUrl?.trim() || gc.geminiBaseUrl,
      openaiApiKey: payload?.openaiApiKey === REDACTED ? gc.openaiApiKey : (payload?.openaiApiKey?.trim() || gc.openaiApiKey),
      openaiBaseUrl: payload?.openaiBaseUrl?.trim() || gc.openaiBaseUrl,
      azureOpenAIApiKey: payload?.azureOpenAIApiKey === REDACTED ? gc.azureOpenAIApiKey : (payload?.azureOpenAIApiKey?.trim() || gc.azureOpenAIApiKey),
      azureOpenAIBaseUrl: payload?.azureOpenAIBaseUrl?.trim() || gc.azureOpenAIBaseUrl,
      azureOpenAIApiVersion: payload?.azureOpenAIApiVersion?.trim() || gc.azureOpenAIApiVersion,
    });
    return { success: true, catalog };
  } catch (err) {
    const message = String((err as { message?: unknown })?.message ?? err ?? 'Unknown error');
    return { success: false, error: message };
  }
});

// ─── Generation (queue dispatch) ─────────────────────────────────────────────

resolver.define('startGeneration', async ({ payload, context }) => {
  const config = await getConfig();

  const check = await checkGenerationAllowed(config, context);

  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const selectedProjectKeys = normalizeProjectKeys(payload.projectKey, payload.projectKeys);

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
    projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
    projectKeys: selectedProjectKeys,
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
  return { success: true, sessionId: payload.sessionId, warning: check.reason };
});

async function cancelWorkflowProgress(
  sessionId: string,
  type: 'generation' | 'clarify' | 'refine',
  message: string,
) {
  const key = type === 'generation'
    ? KEYS.generationProgress(sessionId)
    : type === 'clarify'
      ? KEYS.clarifyProgress(sessionId)
      : KEYS.refineProgress(sessionId);
  const existing = type === 'clarify'
    ? await entityGet<{ inputSignature?: string }>(key)
    : null;
  await entitySet(key, {
    type: 'cancelled',
    sessionId,
    message,
    ...(existing?.inputSignature ? { inputSignature: existing.inputSignature } : {}),
    updatedAt: Date.now(),
  });
  return { success: true };
}

async function enqueueClarifyWorkflow(
  payload: { sessionId: string; requirement: string; attachmentText?: string; projectKey?: string; projectKeys?: string[]; inputSignature?: string },
  context: any,
) {
  const config = await getConfig();
  const clarifyQueue = new Queue({ key: 'clarify-queue' });
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const selectedProjectKeys = normalizeProjectKeys(payload.projectKey, payload.projectKeys);
  const event: ClarifyEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: payload.requirement,
    inputSignature: payload.inputSignature,
    attachmentText: payload.attachmentText ?? '',
    config,
    license: context?.license,
    projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
    projectKeys: selectedProjectKeys,
    round: 1,
    priorAnswers: [],
  };

  await entitySet(KEYS.clarifyProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    ...(payload.inputSignature ? { inputSignature: payload.inputSignature } : {}),
    message: 'Analyzing requirement and gathering project context…',
    updatedAt: Date.now(),
  });
  await clarifyQueue.push({ body: event });
  return { success: true };
}

// ─── Generation progress (polling) ───────────────────────────────────────────

resolver.define('getProgress', async ({ payload }: { payload: { sessionId: string } }) => {
  const progress = await entityGet(KEYS.generationProgress(payload.sessionId));
  return { success: true, progress };
});

resolver.define('cancelGeneration', async ({ payload }: { payload: { sessionId: string } }) => {
  return cancelWorkflowProgress(payload.sessionId, 'generation', 'Generation cancelled.');
});

resolver.define('getBulkRefineResult', async ({ payload }: { payload: { sessionId: string } }) => {
  const progress = await entityGet(KEYS.refineProgress(payload.sessionId));
  return { success: true, progress };
});

resolver.define('cancelBulkRefine', async ({ payload }: { payload: { sessionId: string } }) => {
  return cancelWorkflowProgress(payload.sessionId, 'refine', 'Bulk refinement cancelled.');
});

// ─── Clarify ──────────────────────────────────────────────────────────────────

resolver.define('startClarify', async ({ payload, context }) => {
  try {
    return await enqueueClarifyWorkflow(payload, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

resolver.define('retryClarify', async ({ payload, context }) => {
  try {
    return await enqueueClarifyWorkflow(payload, context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

resolver.define('getClarifyResult', async ({ payload }) => {
  const result = await entityGet(KEYS.clarifyProgress(payload.sessionId));
  return { success: true, result };
});

resolver.define('cancelClarify', async ({ payload }: { payload: { sessionId: string } }) => {
  return cancelWorkflowProgress(payload.sessionId, 'clarify', 'Clarifying questions cancelled.');
});

resolver.define('evaluateSufficiency', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  return evaluateSufficiency({
    requirement: payload.requirement,
    answers: payload.answers as ClarifyAnswer[],
    askedQuestions: payload.askedQuestions as string[] | undefined,
    followupCap: payload.followupCap as number | undefined,
    initialQuestionCount: payload.initialQuestionCount as number | undefined,
    totalQuestionBudget: payload.totalQuestionBudget as number | undefined,
    config,
  });
});

// ─── Refine ───────────────────────────────────────────────────────────────────

resolver.define('refineFeatures', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const refineQueue = new Queue({ key: 'refine-queue' });
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const selectedProjectKeys = normalizeProjectKeys(payload.projectKey, payload.projectKeys);
    const event: RefineEvent = {
      sessionId: payload.sessionId,
      accountId,
      requirement: payload.requirement ?? '',
      feedback: payload.feedback ?? '',
      features: payload.features as Feature[],
      config,
      license: context?.license,
      projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
      projectKeys: selectedProjectKeys,
    };

    await entitySet(KEYS.refineProgress(payload.sessionId), {
      type: 'progress',
      sessionId: payload.sessionId,
      message: 'Queuing bulk refinement…',
      updatedAt: Date.now(),
    });
    await refineQueue.push({ body: event });

    return { success: true, queued: true };
  } catch (err: any) {
    console.error('refineFeatures failed:', err);
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

resolver.define('refineSingleFeature', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  const piiEnabled = Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled);
  const maskedFeedback = maskPiiText(payload.feedback ?? '', piiEnabled);
  const maskedRequirement = maskPiiText(payload.requirement ?? '', piiEnabled);
  const result = await refineSingleFeature({
    requirement: maskedRequirement.text,
    feature: payload.feature as Feature,
    feedback: maskedFeedback.text,
    config,
  });
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const selectedProjectKeys = normalizeProjectKeys(payload.projectKey, payload.projectKeys);
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
        projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
        requirementExcerpt: maskedRequirement.text.slice(0, 240),
        decisionSummary: [
          'Single-feature refinement generated from direct feedback.',
          'Summary/description/story points remain stable unless feedback explicitly targets them.',
        ],
        contextUsage: {
          featureId: payload.feature?.id,
          feedbackLength: String(payload.feedback ?? '').length,
        },
        tokenUsage: result.tokenUsage,
        piiMasking: mergePiiMaskingStats(maskedRequirement.stats, maskedFeedback.stats),
      });
    }
  }
  await recordProjectActivity({
    action: 'refine',
    projectKeys: selectedProjectKeys,
    projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
    sessionId,
    model: config.generatorConfig.refineModel,
    tokenUsage: result.tokenUsage ?? null,
    metadata: { featureId: payload.feature?.id },
  });
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
  const selectedProjectKeys = normalizeProjectKeys(payload.projectKey, payload.projectKeys);
  const config = {
    ...eventConfig,
    domainContext: buildCombinedDomainContext(eventConfig, selectedProjectKeys),
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
    config.wiConfig.enabled
      ? retrieveScopedWiContext(maskedPrompt.text, 4, 20000, selectedProjectKeys)
      : Promise.resolve({ text: '', docs: [], chunks: [] }),
    retrieveScopedSimilarStories({
      requirement: maskedPrompt.text,
      config,
      projectKeys: selectedProjectKeys,
      maxResults: 8,
    }),
  ]);

  const systemPrompt = buildAskSystemPrompt({
    domainContext: config.domainContext,
    wiContext: wiContext.text,
    similarItems: similarItems.map(s => `${s.summary}`).join('\n'),
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
      projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
      requirementExcerpt: maskedPrompt.text.slice(0, 240),
      decisionSummary: [
        'Response grounded in domain context, work instructions, and retrieved backlog examples.',
      ],
      contextUsage: {
        similarItemsCount: similarItems.length,
        wiContextChars: wiContext.text.length,
      },
      piiMasking: mergePiiMaskingStats(maskedPrompt.stats, maskedHistory.stats),
    });
  }

  await recordProjectActivity({
    action: 'ask',
    projectKeys: selectedProjectKeys,
    projectKey: resolvePrimaryProjectKey(payload.projectKey, payload.projectKeys),
    sessionId: String(payload.sessionId ?? 'chat'),
    model: config.generatorConfig.arModel,
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
    const arMapping = normalizeProjectArMapping(
      config.arMappings?.find(m => m.projectKey === payload.projectKey) 
        || config.arMappings?.find(m => m.projectKey === '*') 
        || { mode: 'consolidated', consolidatedFieldId: 'description', iterativeFieldIds: [] },
      payload.projectKey as string,
    );

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
        const linkType = arMapping.issueLinkType || config.issueLinkType || 'Relates to';
        
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

    await recordProjectActivity({
      action: 'issue',
      projectKeys: normalizeProjectKeys(payload.projectKey, payload.projectKeys),
      projectKey: String(payload.projectKey ?? '*'),
      sessionId: payload.sessionId as string | undefined,
      metadata: {
        issueKey: result.issueKey,
        issueType: payload.issueType,
      },
    });

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
    const existing = await listDocs(payload.projectKey || '*', { exactOnly: true });
    if (existing.length >= limits.maxWiDocs) {
      return {
        success: false,
        error: `Your Standard plan allows up to ${limits.maxWiDocs} reference documents per project. Contact support if you need higher limits.`,
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

resolver.define('parseRunAttachment', async ({ payload }) => {
  const filename = String(payload?.filename ?? '').trim();
  const fileBase64 = String(payload?.fileBase64 ?? '').trim();
  if (!filename || !fileBase64) {
    return { success: false, error: 'Filename and file payload are required.' };
  }

  try {
    const buffer = Buffer.from(fileBase64, 'base64');
    const text = await extractDocumentText(filename, buffer);
    return {
      success: true,
      filename,
      text,
      charCount: text.length,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Attachment parsing failed.',
    };
  }
});

resolver.define('listWiDocs', async ({ payload }) => {
  const docs = await listDocs(payload?.projectKey, { exactOnly: true });
  return { success: true, docs };
});

// saveProjectConfig implementation below


resolver.define('saveProjectConfig', async ({ payload, context }) => {
  const { projectKey, arMapping, domainContext, backlogStatuses } = payload;
  await ensureAdmin(context, projectKey);
  
  const current = await getConfig();
  const effectiveTier = getEffectiveTier(current, context);
  const limits = getLimits(effectiveTier);
  const nextConfig = {
    ...current,
    arMappings: [...(current.arMappings ?? [])],
    domainContexts: [...(current.domainContexts ?? [])],
    backlogStatusScopes: [...(current.backlogStatusScopes ?? [])],
  };
  
  // AR Mappings
  if (arMapping) {
    const idx = nextConfig.arMappings.findIndex(m => m.projectKey === projectKey);
    const normalizedMapping = normalizeProjectArMapping(arMapping, projectKey);
    // Note: the normalized mapping preserves both the new and legacy shapes.
    if (idx >= 0) nextConfig.arMappings[idx] = normalizedMapping;
    else nextConfig.arMappings.push(normalizedMapping);
  }
  
  // Domain Contexts
  if (domainContext !== undefined) {
    const idx = nextConfig.domainContexts.findIndex(c => c.projectKey === projectKey);
    if (idx >= 0) nextConfig.domainContexts[idx] = { projectKey, context: domainContext };
    else nextConfig.domainContexts.push({ projectKey, context: domainContext });
  }
  
  if (Array.isArray(backlogStatuses)) {
    const otherScopes = (nextConfig.backlogStatusScopes || []).filter(scope => scope.projectKey !== projectKey);
    nextConfig.backlogStatusScopes = [
      ...otherScopes,
      {
        projectKey,
        statuses: [...new Set(backlogStatuses.filter(Boolean))],
      },
    ];
  }

  if (limits.maxConfiguredProjects !== -1 && countConfiguredProjects(nextConfig) > limits.maxConfiguredProjects) {
    return {
      success: false,
      error: `Your Standard plan supports up to ${limits.maxConfiguredProjects} configured projects. Contact support if you need higher limits or want early access to Advanced.`,
    };
  }
  
  await saveConfig(nextConfig);
  await appendComplianceAuditEvent({
    actorAccountId: (context as { accountId?: string })?.accountId ?? 'unknown',
    category: 'config',
    action: 'PROJECT_CONFIG_UPDATED',
    details: {
      projectKey,
      updated: {
        arMapping: !!arMapping,
        domainContext: domainContext !== undefined,
        backlogStatuses: Array.isArray(backlogStatuses),
      },
    },
    enabled: Boolean(nextConfig.compliance?.auditTrailEnabled),
  });
  return { success: true };
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
    projectKey: payload?.projectKey,
    limit: payload?.limit ?? 250,
  });
  return { success: true, reports };
});

resolver.define('getComplianceSummary', async ({ context }) => {
  await ensureAdmin(context);
  const summary = await getComplianceSummary();
  return { success: true, summary };
});

resolver.define('previewPiiMasking', async ({ payload, context }) => {
  await ensureAdmin(context);
  const result = previewPiiMasking(String(payload?.text ?? ''), Boolean(payload?.enabled ?? true));
  return { success: true, ...result };
});

resolver.define('getProjectActivitySummary', async ({ payload, context }) => {
  await ensureAdmin(context);
  const summary = await getProjectActivitySummary(payload?.limit ?? 1000);
  return { success: true, summary };
});


resolver.define('removeWiDoc', async ({ payload, context }) => {
  await ensureAdmin(context);
  await removeDoc(payload.docId);
  return { success: true };
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

resolver.define('refreshBacklogCache', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = payload?.projectKey || '*';
  if (!projectKey || projectKey === '*') {
    return { success: false, error: 'Select a project before refreshing the backlog cache.' };
  }
  await entitySet(KEYS.backlogRefreshStatus(projectKey), {
    projectKey,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
    updatedAt: new Date().toISOString(),
  });
  const backlogRefreshQueue = new Queue({ key: 'backlog-cache-refresh-queue' });
  await backlogRefreshQueue.push({
    body: {
      projectKey,
      requestedAt: new Date().toISOString(),
      requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
      manual: true,
    },
  });
  return { success: true, queued: true, projectKey };
});

resolver.define('getBacklogRefreshStatus', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = payload?.projectKey || '*';
  if (!projectKey || projectKey === '*') {
    return { success: false, error: 'Select a project before checking refresh status.' };
  }
  const status = await entityGet(KEYS.backlogRefreshStatus(projectKey));
  return { success: true, status: status ?? null };
});

// ─── Conversation History ─────────────────────────────────────────────────────

async function syncConversationIndexEntry(accountId: string, sessionId: string, patch: {
  title?: string;
  updatedAt?: string;
  turnCount?: number;
  isPinned?: boolean;
}, remove = false) {
  const indexKey = KEYS.userConversationIndex(accountId);
  const index = await entityGet<Array<Record<string, any>>>(indexKey) ?? [];
  const existingIndex = index.findIndex((entry) => entry.sessionId === sessionId);

  if (remove) {
    await entitySet(indexKey, index.filter((entry) => entry.sessionId !== sessionId));
    return;
  }

  if (existingIndex >= 0) {
    index[existingIndex] = { ...index[existingIndex], ...patch };
  } else {
    index.unshift({
      sessionId,
      title: patch.title ?? 'Untitled session',
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      turnCount: patch.turnCount ?? 0,
      isPinned: patch.isPinned ?? false,
    });
  }

  await entitySet(indexKey, index.slice(0, 100));
}

resolver.define('getHistory', async ({ payload, context }) => {
  const limit = payload?.limit ?? 30;
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const index = await entityGet<Array<{ sessionId: string; title: string; updatedAt: string; turnCount: number }>>(
    KEYS.userConversationIndex(accountId),
  ) ?? [];
  const conversations = await Promise.all(index.slice(0, limit).map(async (entry) => {
    const conversation = await entityGet<any>(KEYS.userConversations(accountId, entry.sessionId));
    if (!conversation) return entry;
    return {
      ...entry,
      title: conversation.title || entry.title,
      updatedAt: conversation.updatedAt || entry.updatedAt,
      turnCount: Array.isArray(conversation.turns) ? conversation.turns.length : entry.turnCount,
      isPinned: Boolean(entry.isPinned),
    };
  }));
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
  await entityDelete(KEYS.userConversations(accountId, payload.sessionId));
  await syncConversationIndexEntry(accountId, payload.sessionId, {}, true);
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
    existing.updatedAt = new Date().toISOString();
    await entitySet(key, existing);
    await syncConversationIndexEntry(accountId, payload.sessionId, {
      title: payload.title,
      updatedAt: String(existing.updatedAt),
    });
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
  const effectiveTier = getEffectiveTier(config, context);
  const usage = await getUsage();
  const limits = getLimits(effectiveTier);
  const license = context?.license ?? { active: true, licenseType: 'COMMERCIAL' }; // Default to active for dev/staging
  return {
    success: true,
    usage: {
      currentMonth: usage.generations,
      month: usage.month,
    },
    limits,
    tier: effectiveTier,
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

export const handler = resolver.getDefinitions();
