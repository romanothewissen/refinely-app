/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck — @forge/resolver types payload as `never`; runtime types verified manually
/**
 * Forge Resolver — handles all invoke() calls from the React Custom UI.
 *
 * Each function here is a handler for a specific action called from the frontend.
 * Auth is automatic via Forge's platform (cloudId + accountId in context).
 */
import Resolver from '@forge/resolver';
import { Queue } from '@forge/events';
import { asUser, route } from '@forge/api';
import { getConfig, saveConfig, patchConfig } from '../services/tenant-config';
import { checkGenerationAllowed, checkFeatureAllowed, getLimits, getUsage, getUsageLimits, getEffectiveTier, recordGeneration } from '../services/billing';
import { entityDelete, entityGet, entitySet, entitySetSmall, entitySetWithTtl, KEYS } from '../services/cache';
import { REDACTED } from '../types';
import { getUserPreferences, saveUserPreferences } from '../services/user-preferences';
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
  applyV2EconomicModelDefaults,
  resolveEffectiveGeneratorConfig,
} from '../services/model-strategy';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
} from '../services/project-selection';
import {
  getProjectMemoryRefreshState,
  getProjectMemoryRuntimeHealth,
  listProjectKeysForProjectMemoryCompiler,
  queueProjectMemoryRefresh,
  queueProjectMemoryRefreshForProjects,
} from '../services/project-memory';
import { loadProjectMemoryRuntimeContext } from '../services/project-memory-runtime';
import { runForgeV3Preview } from '../services/v3-preview';
import { runV2Pipeline } from '../v2/pipeline';
import { createSqlConversationStore, createV2EphemeralWorkflowStateStore } from '../v2/storage';
import { deleteV2Conversation, getV2Conversation, listV2Conversations } from '../services/v2-sql';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const resolver: any = new Resolver();
import {
  feedbackRequestsStructuralRefinement,
  refineSingleFeature,
  checkRefineFeedbackSufficiency,
  askQuestion,
} from '../core/refine-operations';
import { createFeatureIssue, createIssueLink, getIssueLinkTypes, searchUsers } from '../core/jira-creator';
import { discoverAll, discoverStatuses, discoverIssueTypes } from '../core/jira-discovery';
import { extractDocumentText } from '../core/document-parser';
import { ingestPdf, listDocs, removeDoc } from '../core/wi-ingestion';
import { getBacklogCacheInfo, diagnoseBacklogCache, getGoldStoryPool, searchGoldCandidatesInBacklog } from '../core/similar-stories';
import { inferProjectPersonaRolesFromBacklog } from '../core/persona-role-inference';
import { buildAskSystemPrompt } from '../core/prompts';
import { callLlm, discoverLlmModelCatalog } from '../core/llm';
import {
  applyQuickRefine,
  loadQuickRefineIssueContext,
  refineQuickRefineDraft,
  resolveQuickRefineProjectMapping,
  submitQuickRefineAnswers,
} from '../core/quick-refine';
import { buildSharedPipelineEvidenceSignature } from '../services/shared-pipeline-context';
import {
  CanvasEditIntent,
  CanvasEditScope,
  Feature,
  GenerationEvent,
  ClarifyEvent,
  QuickRefineDraft,
  QuickRefineSession,
  QuickRefineSurface,
  RefineEvent,
} from '../types';
import { handleInferProjectPersonaRoles } from './project-persona-role-inference';
import { buildPipelineAuditBenchmarkSuite } from '../services/pipeline-audit-benchmark';
import {
  deletePipelineAuditBundle,
  listPipelineAuditIndexEntries,
  loadPipelineAuditBundle,
  mergePipelineAuditBundle,
} from '../services/pipeline-audit-store';
import {
  getPipelineAuditWriter,
  isPipelineAuditRequested,
  runWithPipelineAuditContext,
} from '../services/pipeline-audit-context';
import { buildV2AuditBasePatch, buildV2AuditResultPatch } from '../services/v2-pipeline-audit';
import { buildV2ProgressEvent } from '../v2/progress';

function applyPreferredPipelineProfile(config: any, pipelineProfile?: string) {
  if (pipelineProfile !== 'fast' && pipelineProfile !== 'balanced' && pipelineProfile !== 'quality') {
    return config;
  }
  return {
    ...config,
    generatorConfig: {
      ...(config?.generatorConfig ?? {}),
      pipelineProfile,
    },
  };
}

// ─── Security Helpers ────────────────────────────────────────────────────────

async function checkAdmin(context: any) {
  const accountId = (context as { accountId?: string })?.accountId;
  if (!accountId) return false;
  try {
    const res = await asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER,ADMINISTER_PROJECTS`);
    if (!res.ok) return false;
    const data = await res.json();
    return (
      data.permissions?.ADMINISTER?.havePermission === true ||
      data.permissions?.ADMINISTER_PROJECTS?.havePermission === true
    );
  } catch (e) {
    return false;
  }
}

async function checkProjectPermission(
  context: any,
  projectKey: string | undefined,
  permissionKey: string,
) {
  const accountId = (context as { accountId?: string })?.accountId;
  if (!accountId || !projectKey || projectKey === '*') return false;
  try {
    const res = await asUser().requestJira(
      route`/rest/api/3/mypermissions?permissions=${permissionKey}&projectKey=${projectKey}`,
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.permissions?.[permissionKey]?.havePermission === true;
  } catch {
    return false;
  }
}

async function checkProjectAdmin(context: any, projectKey?: string) {
  const accountId = (context as { accountId?: string })?.accountId;
  if (!accountId) return false;
  // Global admin can always edit everything
  if (await checkAdmin(context)) return true;
  return checkProjectPermission(context, projectKey, 'ADMINISTER_PROJECTS');
}

async function checkProjectBrowse(context: any, projectKey?: string) {
  return checkProjectPermission(context, projectKey, 'BROWSE_PROJECTS');
}

async function ensureAdmin(context: any, projectKey?: string) {
  if (!(await checkProjectAdmin(context, projectKey))) {
    throw new Error('Unauthorized: You do not have permission to manage this configuration.');
  }
}

async function ensureProjectBrowse(context: any, projectKey?: string) {
  if (!projectKey || projectKey === '*') {
    throw new Error('Select a project before performing this action.');
  }
  if (!(await checkProjectBrowse(context, projectKey))) {
    throw new Error('Unauthorized: You do not have browse access to this project.');
  }
}

async function resolveAuthorizedProjectSelection(
  context: any,
  payload?: { projectKey?: string; projectKeys?: string[] },
) {
  const requestedProjectKeys = normalizeProjectKeys(payload?.projectKey, payload?.projectKeys);
  if (!requestedProjectKeys.length) {
    return {
      projectKeys: [] as string[],
      projectKey: '*',
    };
  }

  const permissionChecks = await Promise.all(
    requestedProjectKeys.map(async (projectKey) => ({
      projectKey,
      allowed: await checkProjectBrowse(context, projectKey),
    })),
  );
  const authorizedProjectKeys = permissionChecks
    .filter((entry) => entry.allowed)
    .map((entry) => entry.projectKey);

  return {
    projectKeys: authorizedProjectKeys,
    projectKey: authorizedProjectKeys[0] ?? '*',
  };
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
    issueType: arMapping?.issueType || '*',
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (arMapping?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: arMapping?.issueLinkType || 'Relates to',
  };
}

function normalizePersonaRoles(rawRows: unknown[]) {
  const seen = new Set<string>();
  return (Array.isArray(rawRows) ? rawRows : [])
    .map((row) => {
      if (!row) return null;
      if (typeof row === 'string') return { role: row.trim(), activities: '' };
      const role = String(row.role ?? row.name ?? row.title ?? '').trim();
      const activities = String(row.activities ?? row.activity ?? row.description ?? row.context ?? '').trim();
      return role || activities ? { role, activities } : null;
    })
    .filter(Boolean)
    .filter((row) => {
      const key = `${row.role.toLowerCase()}::${row.activities.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeProjectDomainContext(entry: any, projectKey?: string) {
  return {
    projectKey: String(entry?.projectKey ?? projectKey ?? '*').trim() || '*',
    context: String(entry?.context ?? '').trim(),
    personaRoles: normalizePersonaRoles(entry?.personaRoles),
  };
}

function resolveProjectArMapping(config: any, projectKey: string, issueType?: string) {
  const mappings = Array.isArray(config?.arMappings) ? config.arMappings : [];
  const normalizedIssueType = String(issueType ?? '*').trim() || '*';
  const exact = mappings.find((mapping) => mapping.projectKey === projectKey && String(mapping.issueType ?? '*') === normalizedIssueType);
  if (exact) return normalizeProjectArMapping(exact, projectKey);
  const projectFallback = mappings.find((mapping) => mapping.projectKey === projectKey && String(mapping.issueType ?? '*') === '*');
  if (projectFallback) return normalizeProjectArMapping(projectFallback, projectKey);
  const globalExact = mappings.find((mapping) => mapping.projectKey === '*' && String(mapping.issueType ?? '*') === normalizedIssueType);
  if (globalExact) return normalizeProjectArMapping(globalExact, projectKey);
  const globalFallback = mappings.find((mapping) => mapping.projectKey === '*' && String(mapping.issueType ?? '*') === '*');
  return normalizeProjectArMapping(globalFallback || { mode: 'consolidated', consolidatedFieldId: 'description', iterativeFieldIds: [] }, projectKey);
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

function formatV2SimilarStories(stories: Array<{ summary?: string; description?: string; acceptanceCriteria?: string }> = []) {
  return stories
    .slice(0, 3)
    .map((story) => {
      const summary = String(story?.summary ?? '').trim();
      const description = String(story?.description ?? '').replace(/\s+/g, ' ').trim();
      const acceptanceCriteria = String(story?.acceptanceCriteria ?? '').replace(/\s+/g, ' ').trim();
      if (!summary) return '';
      return [
        description ? `${summary}: ${description.slice(0, 220)}` : summary,
        acceptanceCriteria ? `AR style: ${acceptanceCriteria.slice(0, 420)}` : '',
      ].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n');
}

function formatV2DomainRoles(rows: Array<{ role?: string; activities?: string }> = []) {
  return rows
    .slice(0, 8)
    .map((row) => {
      const role = String(row?.role ?? '').trim();
      const activities = String(row?.activities ?? '').replace(/\s+/g, ' ').trim();
      if (!role) return '';
      return activities ? `${role}: ${activities.slice(0, 120)}` : role;
    })
    .filter(Boolean);
}

async function buildV2RequestContext(
  payload: any,
  context: any,
  options?: {
    memoryStage?: 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair';
    skipMemoryLoad?: boolean;
  },
) {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const baseConfig = applyPreferredPipelineProfile(await getConfig(), 'balanced');
  const config = {
    ...baseConfig,
    generatorConfig: applyV2EconomicModelDefaults(resolveEffectiveGeneratorConfig(baseConfig.generatorConfig)),
  };
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
  const selectedProjectKeys = authorizedProjects.projectKeys;
  const selectedWiDocIds = [...new Set((payload?.selectedWiDocIds ?? [])
    .map((id: unknown) => String(id ?? '').trim())
    .filter(Boolean))]
    .slice(0, 3);
  const domainContext = buildCombinedDomainContext(config, selectedProjectKeys);
  const domainRoles = formatV2DomainRoles(getCombinedPersonaRoles(config, selectedProjectKeys));
  const requirement = String(payload?.requirement ?? '').trim();
  const attachmentText = String(payload?.attachmentText ?? '').trim();
  const sessionId = String(payload?.sessionId ?? '').trim() || `v2_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const memoryContext = options?.skipMemoryLoad
    ? {
        memoryHeader: undefined,
        memoryStatus: undefined,
        memoryArtifactVersion: undefined,
        memorySelection: undefined,
      }
    : await loadProjectMemoryRuntimeContext({
        projectKeys: selectedProjectKeys,
        memoryStage: options?.memoryStage,
        requestedBy: accountId,
      });

  return {
    accountId,
    config,
    sessionId,
    projectKey: authorizedProjects.projectKey,
    projectKeys: selectedProjectKeys,
    requirement,
    attachmentText,
    domainContext,
    domainRoles,
    memoryHeader: memoryContext.memoryHeader,
    memoryStatus: memoryContext.memoryStatus,
    memoryArtifactVersion: memoryContext.memoryArtifactVersion,
    memorySelection: memoryContext.memorySelection,
  };
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
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const userPreferences = await getUserPreferences(accountId);
  const isAdmin = await checkAdmin(context);
  await recordRuntimeVersionIfChanged(accountId, Boolean(config.compliance?.auditTrailEnabled));
  
  if (config.generatorConfig) {
    const gc = config.generatorConfig;
    // Scrub keys for the frontend
    if (gc.anthropicApiKey) gc.anthropicApiKey = REDACTED;
    if (gc.geminiApiKey) gc.geminiApiKey = REDACTED;
    if (gc.openaiApiKey) gc.openaiApiKey = REDACTED;
    if (gc.fireworksApiKey) gc.fireworksApiKey = REDACTED;
    if (gc.azureOpenAIApiKey) gc.azureOpenAIApiKey = REDACTED;
    if (gc.ollamaApiKey) gc.ollamaApiKey = REDACTED;
    if (gc.groqApiKey) gc.groqApiKey = REDACTED;
  }
  
  return {
    ...config,
    isAdmin,
    defaultProjectKey: userPreferences.defaultProjectKey,
    pipelineProfile: userPreferences.pipelineProfile ?? config.generatorConfig?.pipelineProfile,
  };
});

resolver.define('saveConfig', async ({ payload, context }) => {
  await ensureAdmin(context);
  if (Object.prototype.hasOwnProperty.call(payload ?? {}, 'defaultProjectKey')) {
    delete payload.defaultProjectKey;
  }
  
  // Key preservation logic
  const existingConfig = await getConfig();
  const egc = existingConfig.generatorConfig || {};
  const ngc = payload.generatorConfig || {};
  
  if (ngc.anthropicApiKey === REDACTED) ngc.anthropicApiKey = egc.anthropicApiKey;
  if (ngc.geminiApiKey === REDACTED) ngc.geminiApiKey = egc.geminiApiKey;
  if (ngc.openaiApiKey === REDACTED) ngc.openaiApiKey = egc.openaiApiKey;
  if (ngc.fireworksApiKey === REDACTED) ngc.fireworksApiKey = egc.fireworksApiKey;
  if (ngc.azureOpenAIApiKey === REDACTED) ngc.azureOpenAIApiKey = egc.azureOpenAIApiKey;
  if (ngc.ollamaApiKey === REDACTED) ngc.ollamaApiKey = egc.ollamaApiKey;
  if (ngc.groqApiKey === REDACTED) ngc.groqApiKey = egc.groqApiKey;
  
  await saveConfig(payload);

  const actorAccountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const modelFields = ['modelStrategy', 'bucketClasses', 'modelStrategyVersion', 'decompositionModel', 'arModel', 'clarifyModel', 'refineModel', 'evaluateModel', 'triageModel', 'themeModel', 'storyAssistantModelAssignments'];
  const changedModelFields = modelFields.filter((field) => {
    return ngc[field] !== undefined && ngc[field] !== egc[field];
  });
  const apiKeyRotated = Boolean(
    (ngc.anthropicApiKey && ngc.anthropicApiKey !== REDACTED && ngc.anthropicApiKey !== egc.anthropicApiKey) ||
    (ngc.geminiApiKey && ngc.geminiApiKey !== REDACTED && ngc.geminiApiKey !== egc.geminiApiKey) ||
    (ngc.openaiApiKey && ngc.openaiApiKey !== REDACTED && ngc.openaiApiKey !== egc.openaiApiKey) ||
    (ngc.fireworksApiKey && ngc.fireworksApiKey !== REDACTED && ngc.fireworksApiKey !== egc.fireworksApiKey) ||
    (ngc.azureOpenAIApiKey && ngc.azureOpenAIApiKey !== REDACTED && ngc.azureOpenAIApiKey !== egc.azureOpenAIApiKey) ||
    (ngc.ollamaApiKey && ngc.ollamaApiKey !== REDACTED && ngc.ollamaApiKey !== egc.ollamaApiKey) ||
    (ngc.groqApiKey && ngc.groqApiKey !== REDACTED && ngc.groqApiKey !== egc.groqApiKey),
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
          ngc.fireworksApiKey && ngc.fireworksApiKey !== REDACTED ? 'fireworks' : null,
          ngc.azureOpenAIApiKey && ngc.azureOpenAIApiKey !== REDACTED ? 'azure_openai' : null,
          ngc.ollamaApiKey && ngc.ollamaApiKey !== REDACTED ? 'ollama' : null,
          ngc.groqApiKey && ngc.groqApiKey !== REDACTED ? 'groq' : null,
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

resolver.define('getUserPreferences', async ({ context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const preferences = await getUserPreferences(accountId);
  return { success: true, ...preferences };
});

resolver.define('saveUserPreferences', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const preferences = await saveUserPreferences(accountId, {
    defaultProjectKey: typeof payload?.defaultProjectKey === 'string' ? payload.defaultProjectKey : undefined,
    pipelineProfile: payload?.pipelineProfile === 'fast' || payload?.pipelineProfile === 'balanced' || payload?.pipelineProfile === 'quality'
      ? payload.pipelineProfile
      : undefined,
    quickRefineModelByProvider: payload?.quickRefineModelByProvider && typeof payload.quickRefineModelByProvider === 'object'
      ? payload.quickRefineModelByProvider
      : undefined,
  });
  return { success: true, ...preferences };
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
    const isFireworks = payload.provider === 'fireworks';
    const isAzureOpenAI = payload.provider === 'azure_openai';
    const isOllama = payload.provider === 'ollama';
    const isGroq = payload.provider === 'groq';

    const res = await callLlm({
      provider: payload.provider,
      model: payload.model || 'test',
      anthropicApiKey: isAnthropic ? (payload.anthropicApiKey === REDACTED ? gc.anthropicApiKey : (payload.anthropicApiKey?.trim() || gc.anthropicApiKey)) : undefined,
      anthropicBaseUrl: isAnthropic ? (payload.anthropicBaseUrl?.trim() || gc.anthropicBaseUrl) : undefined,
      geminiApiKey: isGemini ? (payload.geminiApiKey === REDACTED ? gc.geminiApiKey : (payload.geminiApiKey?.trim() || gc.geminiApiKey)) : undefined,
      geminiBaseUrl: isGemini ? (payload.geminiBaseUrl?.trim() || gc.geminiBaseUrl) : undefined,
      openaiApiKey: isOpenAI ? (payload.openaiApiKey === REDACTED ? gc.openaiApiKey : (payload.openaiApiKey?.trim() || gc.openaiApiKey)) : undefined,
      openaiBaseUrl: isOpenAI ? (payload.openaiBaseUrl?.trim() || gc.openaiBaseUrl) : undefined,
      fireworksApiKey: isFireworks ? (payload.fireworksApiKey === REDACTED ? gc.fireworksApiKey : (payload.fireworksApiKey?.trim() || gc.fireworksApiKey)) : undefined,
      fireworksBaseUrl: isFireworks ? (payload.fireworksBaseUrl?.trim() || gc.fireworksBaseUrl) : undefined,
      azureOpenAIApiKey: isAzureOpenAI ? (payload.azureOpenAIApiKey === REDACTED ? gc.azureOpenAIApiKey : (payload.azureOpenAIApiKey?.trim() || gc.azureOpenAIApiKey)) : undefined,
      azureOpenAIBaseUrl: isAzureOpenAI ? (payload.azureOpenAIBaseUrl?.trim() || gc.azureOpenAIBaseUrl) : undefined,
      azureOpenAIApiVersion: isAzureOpenAI ? (payload.azureOpenAIApiVersion?.trim() || gc.azureOpenAIApiVersion) : undefined,
      ollamaApiKey: isOllama ? (payload.ollamaApiKey === REDACTED ? gc.ollamaApiKey : (payload.ollamaApiKey?.trim() || gc.ollamaApiKey)) : undefined,
      ollamaBaseUrl: isOllama ? (payload.ollamaBaseUrl?.trim() || gc.ollamaBaseUrl) : undefined,
      groqApiKey: isGroq ? (payload.groqApiKey === REDACTED ? gc.groqApiKey : (payload.groqApiKey?.trim() || gc.groqApiKey)) : undefined,
      groqBaseUrl: isGroq ? (payload.groqBaseUrl?.trim() || gc.groqBaseUrl) : undefined,
      modelCatalog: payload.provider ? gc.modelCatalogs?.[payload.provider] : undefined,
      systemPrompt: 'Respond with OK',
      userMessage: 'Test connection',
      noFallback: true,
      maxTokens: 200,
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
      fireworksApiKey: payload?.fireworksApiKey === REDACTED ? gc.fireworksApiKey : (payload?.fireworksApiKey?.trim() || gc.fireworksApiKey),
      fireworksBaseUrl: payload?.fireworksBaseUrl?.trim() || gc.fireworksBaseUrl,
      azureOpenAIApiKey: payload?.azureOpenAIApiKey === REDACTED ? gc.azureOpenAIApiKey : (payload?.azureOpenAIApiKey?.trim() || gc.azureOpenAIApiKey),
      azureOpenAIBaseUrl: payload?.azureOpenAIBaseUrl?.trim() || gc.azureOpenAIBaseUrl,
      azureOpenAIApiVersion: payload?.azureOpenAIApiVersion?.trim() || gc.azureOpenAIApiVersion,
      ollamaApiKey: payload?.ollamaApiKey === REDACTED ? gc.ollamaApiKey : (payload?.ollamaApiKey?.trim() || gc.ollamaApiKey),
      ollamaBaseUrl: payload?.ollamaBaseUrl?.trim() || gc.ollamaBaseUrl,
      groqApiKey: payload?.groqApiKey === REDACTED ? gc.groqApiKey : (payload?.groqApiKey?.trim() || gc.groqApiKey),
      groqBaseUrl: payload?.groqBaseUrl?.trim() || gc.groqBaseUrl,
    });
    return { success: true, catalog };
  } catch (err) {
    const message = String((err as { message?: unknown })?.message ?? err ?? 'Unknown error');
    return { success: false, error: message };
  }
});

// ─── V2 Core Flow ─────────────────────────────────────────────────────────────

resolver.define('v2Preview', async ({ payload, context }) => {
  const requestContext = await buildV2RequestContext(payload, context, { skipMemoryLoad: true });
  if (!requestContext.requirement) {
    return { success: false, error: 'Requirement is required.' };
  }

  const check = await checkGenerationAllowed(requestContext.config, context, {
    sessionId: requestContext.sessionId,
    profile: requestContext.config.generatorConfig.pipelineProfile,
    reserveHostedPreview: false,
  });
  if (!check.allowed) {
    return { success: false, error: check.reason ?? 'Generation is not available for this workspace right now.' };
  }

  const auditMeta = isPipelineAuditRequested(requestContext.config, payload?.pipelineAudit, payload?.auditRunId)
    ? { sessionId: requestContext.sessionId, auditRunId: String(payload.auditRunId), accountId: requestContext.accountId }
    : null;

  try {
    const stateStore = createV2EphemeralWorkflowStateStore();
    await stateStore.setProgress(
      requestContext.sessionId,
      buildV2ProgressEvent(requestContext.sessionId, {
        stage: 'context',
        message: 'Queuing scope preview…',
      }),
    );

    const queue = new Queue({ key: 'v2-generation-queue' });
    await queue.push({
      body: {
        mode: 'preview',
        sessionId: requestContext.sessionId,
        accountId: requestContext.accountId,
        requirement: requestContext.requirement,
        attachmentText: requestContext.attachmentText,
        config: requestContext.config,
        projectKey: requestContext.projectKey,
        projectKeys: requestContext.projectKeys,
        domainContext: requestContext.domainContext,
        domainRoles: requestContext.domainRoles,
        memoryHeader: requestContext.memoryHeader,
        memoryStatus: requestContext.memoryStatus,
        pipelineAudit: Boolean(auditMeta),
        auditRunId: auditMeta?.auditRunId,
      },
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error ?? 'Could not queue V2 preview.'),
    };
  }

  return {
    success: true,
    queued: true,
    sessionId: requestContext.sessionId,
    memoryStatus: requestContext.memoryStatus,
    memoryArtifactVersion: requestContext.memoryArtifactVersion,
    warning: [check.reason].filter(Boolean).join(' ').trim() || undefined,
  };
});

resolver.define('v2Generate', async ({ payload, context }) => {
  const hasDiscoveryAnswers = Array.isArray(payload?.discoveryAnswers) && payload.discoveryAnswers.length > 0;
  const requestContext = await buildV2RequestContext(payload, context, {
    memoryStage: hasDiscoveryAnswers ? undefined : 'discover',
  });
  if (!requestContext.requirement) {
    return { success: false, error: 'Requirement is required.' };
  }
  const conversationStore = createSqlConversationStore();

  const check = await checkGenerationAllowed(requestContext.config, context, {
    sessionId: requestContext.sessionId,
    profile: requestContext.config.generatorConfig.pipelineProfile,
    reserveHostedPreview: true,
  });
  if (!check.allowed) {
    return { success: false, error: check.reason ?? 'Generation is not available for this workspace right now.' };
  }

  const auditMeta = isPipelineAuditRequested(requestContext.config, payload?.pipelineAudit, payload?.auditRunId)
    ? { sessionId: requestContext.sessionId, auditRunId: String(payload.auditRunId), accountId: requestContext.accountId }
    : null;

  if (hasDiscoveryAnswers) {
    const stateStore = createV2EphemeralWorkflowStateStore();
    await stateStore.setProgress(
      requestContext.sessionId,
      buildV2ProgressEvent(requestContext.sessionId, {
        stage: 'context',
        message: 'Queuing refinement…',
      }),
    );

    const queue = new Queue({ key: 'v2-generation-queue' });
    await queue.push({
      body: {
        sessionId: requestContext.sessionId,
        accountId: requestContext.accountId,
        requirement: requestContext.requirement,
        attachmentText: requestContext.attachmentText,
        config: requestContext.config,
        projectKey: requestContext.projectKey,
        projectKeys: requestContext.projectKeys,
        domainContext: requestContext.domainContext,
        domainRoles: requestContext.domainRoles,
        triageOverride: payload?.triageOverride,
        confirmedScopeHypothesis: payload?.confirmedScopeHypothesis,
        discoveryAnswers: payload?.discoveryAnswers,
        pipelineAudit: payload?.pipelineAudit,
        auditRunId: payload?.auditRunId,
      },
    });

    return {
      success: true,
      queued: true,
      sessionId: requestContext.sessionId,
      warning: [check.reason].filter(Boolean).join(' ').trim() || undefined,
    };
  }

  let result;
  const runGenerate = async () => {
    const nextResult = await runV2Pipeline({
      requirement: requestContext.requirement,
      attachmentText: requestContext.attachmentText,
      config: requestContext.config,
      domainContext: requestContext.domainContext,
      domainRoles: requestContext.domainRoles,
      memoryHeader: requestContext.memoryHeader,
      memorySelection: requestContext.memorySelection,
      memoryStatus: requestContext.memoryStatus,
      triageOverride: payload?.triageOverride,
      confirmedScopeHypothesis: payload?.confirmedScopeHypothesis,
      discoveryAnswers: payload?.discoveryAnswers,
    });
    const auditWriter = getPipelineAuditWriter();
    if (auditWriter) {
      await auditWriter.flushMerge({
        ...buildV2AuditBasePatch({
          accountId: requestContext.accountId,
          projectKey: requestContext.projectKey,
          projectKeys: requestContext.projectKeys,
          config: requestContext.config,
          requirement: requestContext.requirement,
          attachmentText: requestContext.attachmentText,
        }),
        ...buildV2AuditResultPatch({
          result: nextResult,
          discoveryAnswers: Array.isArray(payload?.discoveryAnswers) ? payload.discoveryAnswers as any : undefined,
        }),
      });
    }
    return nextResult;
  };
  try {
    result = auditMeta
      ? await runWithPipelineAuditContext(auditMeta, runGenerate)
      : await runGenerate();
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error ?? 'V2 generation failed.'),
    };
  }

  let persistenceWarning: string | null = null;
  try {
    await conversationStore.saveGeneration(requestContext.sessionId, requestContext.accountId, {
      sessionId: requestContext.sessionId,
      projectKey: requestContext.projectKey,
      projectKeys: requestContext.projectKeys,
      requirement: requestContext.requirement,
      status: result.status,
      turnType: result.status === 'complete' ? 'generation' : 'discovery',
      result,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'Unknown SQL execution error');
    console.warn('[v2Generate] Conversation persistence failed:', detail);
    persistenceWarning = `Output generated, but conversation history was not saved (${detail}).`;
  }

  const response: Record<string, unknown> = {
    success: true,
    sessionId: requestContext.sessionId,
    result,
    memoryStatus: requestContext.memoryStatus,
    memoryArtifactVersion: requestContext.memoryArtifactVersion,
    warning: [check.reason, persistenceWarning].filter(Boolean).join(' ').trim() || undefined,
  };

  if (result.status === 'complete') {
    try {
      response.usageTracking = await recordGeneration(
        requestContext.config,
        requestContext.accountId,
        payload?.sessionId,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error ?? 'Unknown usage tracking error');
      console.warn('[v2Generate] Usage tracking failed:', detail);
      const usageWarning = `Output generated, but usage tracking did not complete (${detail}).`;
      response.warning = [response.warning, usageWarning].filter(Boolean).join(' ').trim();
    }
  }

  return response;
});

resolver.define('v2GetProgress', async ({ payload }) => {
  const sessionId = String(payload?.sessionId ?? '').trim();
  if (!sessionId) return { success: false, error: 'sessionId is required.' };
  const stateStore = createV2EphemeralWorkflowStateStore();
  return {
    success: true,
    progress: await stateStore.getProgress(sessionId),
  };
});

resolver.define('v2ClearProgress', async ({ payload }) => {
  const sessionId = String(payload?.sessionId ?? '').trim();
  if (!sessionId) return { success: false, error: 'sessionId is required.' };
  const stateStore = createV2EphemeralWorkflowStateStore();
  await stateStore.clearProgress(sessionId);
  return { success: true };
});

resolver.define('v2GetHistory', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const limit = Number(payload?.limit ?? 30);
  try {
    const conversations = await listV2Conversations(accountId, Number.isFinite(limit) ? Math.max(1, Math.min(limit, 100)) : 30);
    return { success: true, conversations };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'Unknown SQL execution error');
    console.warn('[v2GetHistory] SQL read failed:', detail);
    return {
      success: true,
      conversations: [],
      warning: `History is temporarily unavailable (${detail}).`,
    };
  }
});

resolver.define('v2GetConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = String(payload?.sessionId ?? '').trim();
  if (!sessionId) return { success: false, error: 'sessionId is required.' };
  try {
    const conversation = await getV2Conversation(accountId, sessionId);
    return { success: true, conversation };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'Unknown SQL execution error');
    console.warn('[v2GetConversation] SQL read failed:', detail);
    return { success: false, error: `Conversation history is temporarily unavailable (${detail}).` };
  }
});

resolver.define('v2DeleteConversation', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = String(payload?.sessionId ?? '').trim();
  if (!sessionId) return { success: false, error: 'sessionId is required.' };
  try {
    await deleteV2Conversation(accountId, sessionId);
    await createV2EphemeralWorkflowStateStore().clearProgress(sessionId);
    return { success: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'Unknown SQL execution error');
    console.warn('[v2DeleteConversation] SQL delete failed:', detail);
    return { success: false, error: `Could not delete conversation history (${detail}).` };
  }
});

// ─── Generation (queue dispatch) ─────────────────────────────────────────────

resolver.define('startGeneration', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const userPreferences = await getUserPreferences(accountId);
  const eventConfig = applyPreferredPipelineProfile(await getConfig(), userPreferences.pipelineProfile);
  const check = await checkGenerationAllowed(eventConfig, context, {
    sessionId: payload.sessionId,
    reserveHostedPreview: true,
  });
  if (!check.allowed) {
    return { success: false, error: check.reason ?? 'Generation is not available for this workspace right now.' };
  }

  const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
  const selectedProjectKeys = authorizedProjects.projectKeys;
  const selectedWiDocIds = [...new Set((payload?.selectedWiDocIds ?? [])
    .map((id: unknown) => String(id ?? '').trim())
    .filter(Boolean))]
    .slice(0, 3);
  const finalSufficiency = payload?.clarifyFinalSufficiency;
  const scopeContract = payload?.clarifyScopeContract;
  const sharedEvidenceSignature = buildSharedPipelineEvidenceSignature({
    requirement: payload.requirement,
    attachmentText: payload.attachmentText ?? '',
    projectKey: authorizedProjects.projectKey,
    projectKeys: selectedProjectKeys,
    pipelineMode: 'story_assistant_default',
    includeSimilarStories: true,
    clarifyAnswers: payload.clarifyAnswers ?? [],
    selectedWiDocIds,
  });

  const event: GenerationEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: payload.requirement,
    clarifyAnswers: payload.clarifyAnswers ?? [],
    attachmentText: payload.attachmentText ?? '',
    config: eventConfig,
    license: context?.license,
    pauseForDraftReview: undefined,
    projectKey: authorizedProjects.projectKey,
    projectKeys: selectedProjectKeys,
    selectedWiDocIds,
    clarifyDiscoveryProfile: payload.clarifyDiscoveryProfile ?? undefined,
    clarifySizingContract: payload.clarifySizingContract ?? undefined,
    clarifyAdvisoryTriage: payload.clarifyAdvisoryTriage ?? undefined,
    clarifyFinalSufficiency: finalSufficiency ?? undefined,
    clarifyQuestionsAsked: payload.clarifyQuestionsAsked,
    clarifyScopeContract: scopeContract,
    sharedEvidenceSignature,
    pipelineAudit: payload.pipelineAudit,
    auditRunId: payload.auditRunId,
    enqueuedAt: Date.now(),
  };

  // Snapshot the user-provided inputs so a failed generation can be retried
  // without re-running discovery. Config/license/authorized projects are
  // re-derived on retry (they may have changed).
  await entitySet(KEYS.generationInputSnapshot(payload.sessionId), {
    sessionId: payload.sessionId,
    requirement: payload.requirement,
    clarifyAnswers: payload.clarifyAnswers ?? [],
    attachmentText: payload.attachmentText ?? '',
    projectKey: authorizedProjects.projectKey,
    projectKeys: selectedProjectKeys,
    selectedWiDocIds,
    clarifyDiscoveryProfile: payload.clarifyDiscoveryProfile,
    clarifySizingContract: payload.clarifySizingContract,
    clarifyAdvisoryTriage: payload.clarifyAdvisoryTriage,
    clarifyFinalSufficiency: payload.clarifyFinalSufficiency,
    clarifyQuestionsAsked: payload.clarifyQuestionsAsked,
    clarifyScopeContract: scopeContract,
    sharedEvidenceSignature,
    pipelineAudit: payload.pipelineAudit,
    auditRunId: payload.auditRunId,
    savedAt: Date.now(),
  });

  // Overwrite any stale 'complete' from a previous run with a fresh 'progress' marker
  await entitySetSmall(KEYS.generationProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    message: 'Queuing generation…',
    updatedAt: Date.now(),
  });

  const generationQueue = new Queue({ key: 'generation-queue' });
  await generationQueue.push({ body: event });
  const warning = [check.reason].filter(Boolean).join(' ').trim() || undefined;
  return { success: true, sessionId: payload.sessionId, warning };
});

/**
 * Re-enqueue generation for a session using the saved input snapshot.
 * Used when a prior generation failed (e.g. provider outage) — the user can
 * click "Retry" without re-running discovery or re-answering questions.
 * Config, license, and authorized projects are re-resolved fresh.
 */
resolver.define('retryGeneration', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = payload?.sessionId;
  if (!sessionId) {
    return { success: false, error: 'sessionId is required to retry generation.' };
  }

  const snapshot = await entityGet<Record<string, any>>(KEYS.generationInputSnapshot(sessionId));

  if (!snapshot || !snapshot.requirement) {
    return { success: false, error: 'No saved generation inputs were found for this session. Start a new generation from discovery.' };
  }

  const userPreferences = await getUserPreferences(accountId);
  const eventConfig = applyPreferredPipelineProfile(await getConfig(), userPreferences.pipelineProfile);
  const check = await checkGenerationAllowed(eventConfig, context, {
    sessionId,
    reserveHostedPreview: true,
  });
  if (!check.allowed) {
    return { success: false, error: check.reason ?? 'Generation is not available for this workspace right now.' };
  }
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, {
    projectKey: snapshot.projectKey,
    projectKeys: snapshot.projectKeys,
  });

  const event: GenerationEvent = {
    sessionId,
    accountId,
    requirement: snapshot.requirement,
    clarifyAnswers: snapshot.clarifyAnswers ?? [],
    attachmentText: snapshot.attachmentText ?? '',
    config: eventConfig,
    license: context?.license,
    pauseForDraftReview: undefined,
    projectKey: authorizedProjects.projectKey,
    projectKeys: authorizedProjects.projectKeys,
    selectedWiDocIds: Array.isArray(snapshot.selectedWiDocIds)
      ? [...new Set(snapshot.selectedWiDocIds.map((id: unknown) => String(id ?? '').trim()).filter(Boolean))].slice(0, 3)
      : [],
    clarifyDiscoveryProfile: snapshot.clarifyDiscoveryProfile,
    clarifySizingContract: snapshot.clarifySizingContract,
    clarifyAdvisoryTriage: snapshot.clarifyAdvisoryTriage,
    clarifyFinalSufficiency: snapshot.clarifyFinalSufficiency,
    clarifyQuestionsAsked: snapshot.clarifyQuestionsAsked,
    clarifyScopeContract: snapshot.clarifyScopeContract,
    sharedEvidenceSignature: snapshot.sharedEvidenceSignature,
    pipelineAudit: snapshot.pipelineAudit,
    auditRunId: snapshot.auditRunId,
    enqueuedAt: Date.now(),
  };

  await entitySetSmall(KEYS.generationProgress(sessionId), {
    type: 'progress',
    sessionId,
    message: 'Retrying generation…',
    updatedAt: Date.now(),
  });

  const generationQueue = new Queue({ key: 'generation-queue' });
  await generationQueue.push({ body: event });
  const warning = [check.reason].filter(Boolean).join(' ').trim() || undefined;
  return { success: true, sessionId, warning };
});

/** @deprecated Draft review pause has been removed — pipeline flows straight through. */
resolver.define('resumeGeneration', async () => {
  return { success: false, error: 'Draft review pause has been removed. The pipeline now flows straight through to completion.' };
});

resolver.define('retryFailedFeatureGeneration', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const convKey = KEYS.userConversations(accountId, payload.sessionId);
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(convKey);
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const latestGenerateTurn = [...turns].reverse().find((turn) => Array.isArray(turn?.features) && turn.features.length > 0);
  const retryContext = latestGenerateTurn?.retryContext;
  const retryBaseFeatures = Array.isArray(latestGenerateTurn?.features) ? latestGenerateTurn.features as Feature[] : [];
  const retryFeature = retryBaseFeatures.find((feature) => feature?.id === payload?.featureId);

  if (!latestGenerateTurn || !retryFeature) {
    return { success: false, error: 'No retryable generated feature was found for this session.' };
  }

  const userPreferences = await getUserPreferences(accountId);
  const config = applyPreferredPipelineProfile(await getConfig(), userPreferences.pipelineProfile);
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, {
    projectKey: retryContext?.projectKey ?? latestGenerateTurn?.generationContext?.projectKey,
    projectKeys: retryContext?.projectKeys ?? latestGenerateTurn?.generationContext?.projectKeys,
  });

  const event: GenerationEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: latestGenerateTurn.requirement ?? '',
    clarifyAnswers: retryContext?.clarifyAnswers ?? [],
    attachmentText: retryContext?.attachmentText ?? '',
    config,
    license: context?.license,
    projectKey: authorizedProjects.projectKey,
    projectKeys: authorizedProjects.projectKeys,
    selectedWiDocIds: retryContext?.selectedWiDocIds ?? [],
    clarifySizingContract: retryContext?.sizingContract,
    clarifyAdvisoryTriage: retryContext?.advisoryTriage,
    clarifyScopeContract: retryContext?.scopeContract,
    sharedEvidenceSignature: retryContext?.sharedEvidenceSignature,
    retryFeatureId: retryFeature.id,
    retryFeature,
    retryBaseFeatures,
    enqueuedAt: Date.now(),
  };

  await entitySetSmall(KEYS.generationProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    message: 'Retrying acceptance requirements for the selected feature…',
    updatedAt: Date.now(),
  });

  const generationQueue = new Queue({ key: 'generation-queue' });
  await generationQueue.push({ body: event });
  return { success: true, sessionId: payload.sessionId, warning: 'Retrying acceptance requirements without consuming an additional preview credit.' };
});

resolver.define('retryFailedFeatureGenerations', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const featureIds = [...new Set((Array.isArray(payload?.featureIds) ? payload.featureIds : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
  if (!featureIds.length) {
    return { success: false, error: 'No retryable generated features were selected.' };
  }

  const convKey = KEYS.userConversations(accountId, payload.sessionId);
  const conversation = await entityGet<{ turns?: Array<Record<string, any>> }>(convKey);
  const turns = Array.isArray(conversation?.turns) ? conversation.turns : [];
  const latestGenerateTurn = [...turns].reverse().find((turn) => Array.isArray(turn?.features) && turn.features.length > 0);
  const retryContext = latestGenerateTurn?.retryContext;
  const retryBaseFeatures = Array.isArray(latestGenerateTurn?.features) ? latestGenerateTurn.features as Feature[] : [];
  const retryFeatures = retryBaseFeatures.filter((feature) => featureIds.includes(String(feature?.id ?? '')));

  if (!latestGenerateTurn || !retryFeatures.length) {
    return { success: false, error: 'No retryable generated features were found for this session.' };
  }

  const userPreferences = await getUserPreferences(accountId);
  const config = applyPreferredPipelineProfile(await getConfig(), userPreferences.pipelineProfile);
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, {
    projectKey: retryContext?.projectKey ?? latestGenerateTurn?.generationContext?.projectKey,
    projectKeys: retryContext?.projectKeys ?? latestGenerateTurn?.generationContext?.projectKeys,
  });

  const event: GenerationEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: latestGenerateTurn.requirement ?? '',
    clarifyAnswers: retryContext?.clarifyAnswers ?? [],
    attachmentText: retryContext?.attachmentText ?? '',
    config,
    license: context?.license,
    projectKey: authorizedProjects.projectKey,
    projectKeys: authorizedProjects.projectKeys,
    selectedWiDocIds: retryContext?.selectedWiDocIds ?? [],
    clarifySizingContract: retryContext?.sizingContract,
    clarifyAdvisoryTriage: retryContext?.advisoryTriage,
    clarifyScopeContract: retryContext?.scopeContract,
    sharedEvidenceSignature: retryContext?.sharedEvidenceSignature,
    retryFeatureIds: retryFeatures.map((feature) => feature.id),
    retryFeatures,
    retryBaseFeatures,
    enqueuedAt: Date.now(),
  };

  await entitySetSmall(KEYS.generationProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    message: `Retrying acceptance requirements for ${retryFeatures.length} selected feature${retryFeatures.length === 1 ? '' : 's'}…`,
    updatedAt: Date.now(),
  });

  const generationQueue = new Queue({ key: 'generation-queue' });
  await generationQueue.push({ body: event });
  return { success: true, sessionId: payload.sessionId, warning: 'Retrying acceptance requirements without consuming an additional preview credit.' };
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
  await entitySetSmall(key, {
    type: 'cancelled',
    sessionId,
    message,
    ...(existing?.inputSignature ? { inputSignature: existing.inputSignature } : {}),
    updatedAt: Date.now(),
  });
  return { success: true };
}

async function enqueueClarifyWorkflow(
  payload: {
    sessionId: string;
    requirement: string;
    attachmentText?: string;
    projectKey?: string;
    projectKeys?: string[];
    selectedWiDocIds?: string[];
    inputSignature?: string;
    round?: 1 | 2;
    priorAnswers?: ClarifyAnswer[];
    pipelineAudit?: boolean;
    auditRunId?: string;
  },
  context: any,
) {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const userPreferences = await getUserPreferences(accountId);
  const config = applyPreferredPipelineProfile(await getConfig(), userPreferences.pipelineProfile);
  const clarifyQueue = new Queue({ key: 'clarify-queue' });
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
  const selectedProjectKeys = authorizedProjects.projectKeys;
  const selectedWiDocIds = [...new Set((payload.selectedWiDocIds ?? [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))]
    .slice(0, 3);
  const event: ClarifyEvent = {
    sessionId: payload.sessionId,
    accountId,
    requirement: payload.requirement,
    inputSignature: payload.inputSignature,
    attachmentText: payload.attachmentText ?? '',
    config,
    license: context?.license,
    projectKey: authorizedProjects.projectKey,
    projectKeys: selectedProjectKeys,
    selectedWiDocIds,
    round: payload.round ?? 1,
    priorAnswers: payload.priorAnswers ?? [],
    pipelineAudit: payload.pipelineAudit,
    auditRunId: payload.auditRunId,
    enqueuedAt: Date.now(),
  };

  await entitySetSmall(KEYS.clarifyProgress(payload.sessionId), {
    type: 'progress',
    sessionId: payload.sessionId,
    ...(payload.inputSignature ? { inputSignature: payload.inputSignature } : {}),
    message: 'Analyzing requirement and gathering project context…',
    payload: {
      stage: 'context',
      sources: {
        projectKey: authorizedProjects.projectKey,
        projectCount: selectedProjectKeys.length,
        attachmentIncluded: Boolean(payload.attachmentText?.trim()),
      },
    },
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

// The evaluateSufficiency resolver has been removed.
// Sufficiency is now evaluated asynchronously within the generation queue to prevent 25-second timeouts.

resolver.define('getPipelineAudit', async ({ payload, context }) => {
  const cfg = await getConfig();
  if (!cfg.developerTools?.pipelineAuditEnabled) {
    return { success: false, error: 'Pipeline audit is not enabled for this workspace.' };
  }
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = String(payload?.sessionId ?? '');
  const auditRunId = String(payload?.auditRunId ?? '');
  if (!sessionId || !auditRunId) {
    return { success: false, error: 'sessionId and auditRunId are required.' };
  }
  const bundle = await loadPipelineAuditBundle(sessionId, auditRunId);
  if (!bundle) {
    return { success: false, error: 'Audit bundle not found.' };
  }
  const isAdmin = await checkAdmin(context);
  if (bundle.accountId && bundle.accountId !== accountId && !isAdmin) {
    return { success: false, error: 'Unauthorized.' };
  }
  return { success: true, bundle };
});

resolver.define('listPipelineAudits', async ({ payload, context }) => {
  const cfg = await getConfig();
  if (!cfg.developerTools?.pipelineAuditEnabled) {
    return { success: false, error: 'Pipeline audit is not enabled for this workspace.' };
  }
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const isAdmin = await checkAdmin(context);
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
  const limitRaw = Number(payload?.limit ?? 25);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 25;
  const entries = await listPipelineAuditIndexEntries();
  const audits = entries
    .filter((entry) => (
      (!entry.accountId || entry.accountId === accountId || isAdmin)
      && (!sessionId || entry.sessionId === sessionId)
    ))
    .slice(0, limit);
  return { success: true, audits };
});

resolver.define('deletePipelineAudit', async ({ payload, context }) => {
  const cfg = await getConfig();
  if (!cfg.developerTools?.pipelineAuditEnabled) {
    return { success: false, error: 'Pipeline audit is not enabled for this workspace.' };
  }
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = String(payload?.sessionId ?? '');
  const auditRunId = String(payload?.auditRunId ?? '');
  if (!sessionId || !auditRunId) {
    return { success: false, error: 'sessionId and auditRunId are required.' };
  }
  const bundle = await loadPipelineAuditBundle(sessionId, auditRunId);
  if (!bundle) {
    return { success: false, error: 'Audit bundle not found.' };
  }
  const isAdmin = await checkAdmin(context);
  if (bundle.accountId && bundle.accountId !== accountId && !isAdmin) {
    return { success: false, error: 'Unauthorized.' };
  }
  await deletePipelineAuditBundle(sessionId, auditRunId);
  return { success: true };
});

resolver.define('buildPipelineAuditBenchmark', async ({ payload, context }) => {
  const cfg = await getConfig();
  if (!cfg.developerTools?.pipelineAuditEnabled) {
    return { success: false, error: 'Pipeline audit is not enabled for this workspace.' };
  }
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const isAdmin = await checkAdmin(context);
  const limitRaw = Number(payload?.limit ?? 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 20;
  const requestedRefs = Array.isArray(payload?.auditRefs)
    ? payload.auditRefs
        .map((item: any) => ({
          sessionId: String(item?.sessionId ?? '').trim(),
          auditRunId: String(item?.auditRunId ?? '').trim(),
        }))
        .filter((item: { sessionId: string; auditRunId: string }) => item.sessionId && item.auditRunId)
        .slice(0, limit)
    : [];

  let bundles = [];
  if (requestedRefs.length > 0) {
    const loaded = await Promise.all(
      requestedRefs.map((ref: { sessionId: string; auditRunId: string }) =>
        loadPipelineAuditBundle(ref.sessionId, ref.auditRunId)),
    );
    bundles = loaded.filter((bundle) => (
      bundle
      && (!bundle.accountId || bundle.accountId === accountId || isAdmin)
    ));
  } else {
    const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : '';
    const entries = (await listPipelineAuditIndexEntries())
      .filter((entry) => (
        (!entry.accountId || entry.accountId === accountId || isAdmin)
        && (!sessionId || entry.sessionId === sessionId)
      ))
      .slice(0, limit);
    const loaded = await Promise.all(entries.map((entry) => loadPipelineAuditBundle(entry.sessionId, entry.auditRunId)));
    bundles = loaded.filter(Boolean);
  }

  return {
    success: true,
    suite: buildPipelineAuditBenchmarkSuite(bundles),
  };
});

resolver.define('mergePipelineAuditClientPolling', async ({ payload }) => {
  const cfg = await getConfig();
  if (!cfg.developerTools?.pipelineAuditEnabled) {
    return { success: false, error: 'Pipeline audit is not enabled for this workspace.' };
  }
  const sessionId = String(payload?.sessionId ?? '');
  const auditRunId = String(payload?.auditRunId ?? '');
  if (!sessionId || !auditRunId) {
    return { success: false, error: 'sessionId and auditRunId are required.' };
  }
  const clarify = payload?.clarify;
  const generation = payload?.generation;
  if (!clarify && !generation) {
    return { success: false, error: 'At least one of clarify or generation is required.' };
  }
  await mergePipelineAuditBundle(sessionId, auditRunId, {
    clientPolling: {
      ...(clarify ? { clarify } : {}),
      ...(generation ? { generation } : {}),
    },
  });
  return { success: true };
});

// ─── Refine ───────────────────────────────────────────────────────────────────

resolver.define('refineFeatures', async ({ payload, context }) => {
  try {
    if (feedbackRequestsStructuralRefinement(String(payload.feedback ?? ''))) {
      return {
        success: true,
        blocked: true,
        code: 'structural_refine_unsupported',
        message: 'Bulk Refine can only make non-structural wording and quality changes. Use Restructure for merges, splits, or consolidation.',
      };
    }

    const config = await getConfig();
    const refineQueue = new Queue({ key: 'refine-queue' });
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
    const selectedProjectKeys = authorizedProjects.projectKeys;
    const event: RefineEvent = {
      sessionId: payload.sessionId,
      accountId,
      requirement: payload.requirement ?? '',
      feedback: payload.feedback ?? '',
      features: payload.features as Feature[],
      config,
      license: context?.license,
      projectKey: authorizedProjects.projectKey,
      projectKeys: selectedProjectKeys,
    };

    await entitySetSmall(KEYS.refineProgress(payload.sessionId), {
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

resolver.define('changeCanvas', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const refineQueue = new Queue({ key: 'refine-queue' });
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
    const selectedProjectKeys = authorizedProjects.projectKeys;
    const intent = (
      payload.intent === 'add_requirements'
      || payload.intent === 'add_feature'
      || payload.intent === 'reorganize'
      ? payload.intent
      : 'light_refine'
    ) as CanvasEditIntent;
    const scope = (
      payload.scope === 'current'
      || payload.scope === 'selected'
      ? payload.scope
      : 'all'
    ) as CanvasEditScope;
    const selectedFeatureIds = Array.isArray(payload.selectedFeatureIds)
      ? payload.selectedFeatureIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      : [];
    const event: RefineEvent = {
      sessionId: payload.sessionId,
      accountId,
      requirement: payload.requirement ?? '',
      feedback: payload.instruction ?? payload.feedback ?? '',
      features: payload.features as Feature[],
      config,
      license: context?.license,
      projectKey: authorizedProjects.projectKey,
      projectKeys: selectedProjectKeys,
      mode: intent === 'reorganize' ? 'restructure' : intent === 'add_feature' ? 'add_feature' : 'refine',
      intent,
      scope,
      restructureScope: scope === 'all' ? 'all' : 'selected',
      selectedFeatureIds: scope === 'all' ? [] : selectedFeatureIds,
    };

    await entitySetSmall(KEYS.refineProgress(payload.sessionId), {
      type: 'progress',
      sessionId: payload.sessionId,
      operationType: intent,
      intent,
      message: intent === 'reorganize'
        ? 'Queuing reorganization preview…'
        : intent === 'add_feature'
          ? 'Queuing missing feature coverage…'
          : intent === 'add_requirements'
            ? 'Queuing requirement coverage update…'
            : 'Queuing draft refinement…',
      updatedAt: Date.now(),
    });
    await refineQueue.push({ body: event });

    return { success: true, queued: true };
  } catch (err: any) {
    console.error('changeCanvas failed:', err);
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

resolver.define('restructureFeatures', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const refineQueue = new Queue({ key: 'refine-queue' });
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
    const selectedProjectKeys = authorizedProjects.projectKeys;
    const event: RefineEvent = {
      sessionId: payload.sessionId,
      accountId,
      requirement: payload.requirement ?? '',
      feedback: payload.feedback ?? '',
      features: payload.features as Feature[],
      config,
      license: context?.license,
      projectKey: authorizedProjects.projectKey,
      projectKeys: selectedProjectKeys,
      mode: 'restructure',
      restructureScope: payload.scope === 'selected' ? 'selected' : 'all',
      selectedFeatureIds: Array.isArray(payload.selectedFeatureIds) ? payload.selectedFeatureIds : [],
    };

    await entitySetSmall(KEYS.refineProgress(payload.sessionId), {
      type: 'progress',
      sessionId: payload.sessionId,
      operationType: 'restructure',
      message: 'Queuing restructure review…',
      updatedAt: Date.now(),
    });
    await refineQueue.push({ body: event });

    return { success: true, queued: true };
  } catch (err: any) {
    console.error('restructureFeatures failed:', err);
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

resolver.define('refineSingleFeature', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    tier: getEffectiveTier(eventConfig, context),
  };
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
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
  const selectedProjectKeys = authorizedProjects.projectKeys;
  if (sessionId) {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    await updateLatestTurnFeatures(
      sessionId,
      accountId,
      result.features,
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
        projectKey: authorizedProjects.projectKey,
        requirementExcerpt: maskedRequirement.text.slice(0, 240),
        decisionSummary: [
          result.features.length > 1
            ? `Single-feature refinement split into ${result.features.length} features based on feedback.`
            : 'Single-feature refinement generated from direct feedback.',
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
    projectKey: authorizedProjects.projectKey,
    sessionId,
    model: config.generatorConfig.refineModel,
    tokenUsage: result.tokenUsage ?? null,
    metadata: { featureId: payload.feature?.id },
  });
  return { success: true, features: result.features, tokenUsage: result.tokenUsage };
});

resolver.define('checkRefineFeedback', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
    tier: getEffectiveTier(eventConfig, context),
  };
  return checkRefineFeedbackSufficiency({
    feature: payload.feature as Feature,
    feedback: payload.feedback,
    config,
  });
});

// ─── Ask / Chat ───────────────────────────────────────────────────────────────

resolver.define('ask', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const authorizedProjects = await resolveAuthorizedProjectSelection(context, payload);
  const selectedProjectKeys = authorizedProjects.projectKeys;
  const config = {
    ...eventConfig,
    generatorConfig: resolveEffectiveGeneratorConfig(eventConfig.generatorConfig),
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
      projectKey: authorizedProjects.projectKey,
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
    projectKey: authorizedProjects.projectKey,
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
    const arMapping = resolveProjectArMapping(config, payload.projectKey as string, payload.issueType as string);

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
             const configuredLinkType = arMapping.issueLinkType || config.issueLinkType || 'Relates to';
             const alternative = configuredLinkType === 'Relates to' ? 'Relates' : 'Relates to';
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

// ─── Quick Refine ────────────────────────────────────────────────────────────

resolver.define('getQuickRefineIssueContext', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const surface = (payload?.surface === 'issue-panel' ? 'issue-panel' : 'issue-action') as QuickRefineSurface;
    const issueKey = String(payload?.issueKey ?? '').trim();
    if (!issueKey) {
      return { success: false, error: 'Missing issue key.' };
    }

    const projectKey = String(payload?.projectKey ?? issueKey.split('-')[0] ?? '*').trim() || '*';
    const authorizedProjects = await resolveAuthorizedProjectSelection(context, {
      projectKey,
      projectKeys: projectKey && projectKey !== '*' ? [projectKey] : [],
    });

    const issueContext = await loadQuickRefineIssueContext({
      issueKey,
      surface,
      config,
      projectKeys: authorizedProjects.projectKeys.length ? authorizedProjects.projectKeys : [projectKey],
    });

    const existing = await getQuickRefineStoredSession(accountId, issueKey);
    issueContext.existingSessionId = existing.sessionId;
    issueContext.sessionStatus = existing.session?.status ?? null;
    issueContext.updatedAt = existing.session?.updatedAt ?? null;

    return {
      success: true,
      context: issueContext,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

resolver.define('getQuickRefineSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const existing = await getQuickRefineStoredSession(accountId, payload?.issueKey, payload?.sessionId);
  return {
    success: true,
    sessionId: existing.sessionId,
    session: existing.session,
  };
});

resolver.define('startQuickRefine', async ({ payload, context }) => {
  try {
    const rawConfig = await getConfig();
    const config = {
      ...rawConfig,
      generatorConfig: resolveEffectiveGeneratorConfig(rawConfig.generatorConfig),
      tier: getEffectiveTier(rawConfig, context),
    };
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const surface = (payload?.surface === 'issue-panel' ? 'issue-panel' : 'issue-action') as QuickRefineSurface;
    const issueKey = String(payload?.issueKey ?? '').trim();
    const sessionId = String(payload?.sessionId ?? '').trim();
    const modelOverride = String(payload?.modelOverride ?? '').trim() || undefined;
    if (!issueKey || !sessionId) {
      return { success: false, error: 'Missing issue key or session id.' };
    }

    const projectKey = String(payload?.projectKey ?? issueKey.split('-')[0] ?? '*').trim() || '*';
    const authorizedProjects = await resolveAuthorizedProjectSelection(context, {
      projectKey,
      projectKeys: projectKey && projectKey !== '*' ? [projectKey] : [],
    });
    const issueContext = await loadQuickRefineIssueContext({
      issueKey,
      surface,
      config: rawConfig,
      projectKeys: authorizedProjects.projectKeys.length ? authorizedProjects.projectKeys : [projectKey],
    });

    const now = new Date().toISOString();
    const runningSession: QuickRefineSession = {
      sessionId,
      surface,
      issueKey,
      projectKey: issueContext.projectKey,
      issueType: issueContext.issueType,
      modelProvider: config.generatorConfig.provider,
      modelOverride,
      originalIssue: issueContext.originalIssue,
      context: issueContext,
      status: 'running',
      questions: undefined,
      draft: undefined,
      handoffReason: undefined,
      error: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await persistQuickRefineSession(accountId, runningSession);

    const result = await startQuickRefine({
      context: issueContext,
      config,
      modelOverride,
    });

    const nextSession: QuickRefineSession = {
      ...runningSession,
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
        projectKey: issueContext.projectKey,
        requirementExcerpt: issueContext.originalIssue.summary.slice(0, 240),
        decisionSummary: ['Quick refine generated a preview rewrite for the current Jira issue.'],
        contextUsage: {
          issueKey: issueContext.issueKey,
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
      projectKeys: [issueContext.projectKey],
      projectKey: issueContext.projectKey,
      sessionId,
      model: modelOverride || config.generatorConfig.refineModel,
      tokenUsage: result.route === 'rewrite' ? (result.draft?.tokenUsage ?? null) : (result.tokenUsage ?? null),
      metadata: {
        issueKey: issueContext.issueKey,
        quickRefine: true,
        route: result.route,
        async: false,
      },
    });

    return {
      success: true,
      sessionId,
      session: nextSession,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

resolver.define('submitQuickRefineAnswers', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const sessionId = String(payload?.sessionId ?? '').trim();
    if (!sessionId) {
      return { success: false, error: 'Missing session id.' };
    }
    const existing = await getQuickRefineStoredSession(accountId, payload?.issueKey, sessionId);
    if (!existing.session) {
      return { success: false, error: 'Quick refine session not found.' };
    }

    const answers = Array.isArray(payload?.answers) ? payload.answers : [];
    const modelOverride = String(payload?.modelOverride ?? existing.session.modelOverride ?? '').trim() || undefined;
    const draft = await submitQuickRefineAnswers({
      context: existing.session.context,
      answers,
      config: {
        ...config,
        generatorConfig: resolveEffectiveGeneratorConfig(config.generatorConfig),
        tier: getEffectiveTier(config, context),
      },
      modelOverride,
    });

    const nextSession: QuickRefineSession = {
      ...existing.session,
      modelOverride,
      context: {
        ...existing.session.context,
        contextMeta: draft.contextMeta ?? existing.session.context.contextMeta,
      },
      draft,
      questions: undefined,
      status: draft.handoffRecommended ? 'handoff' : 'draft',
      handoffReason: draft.handoffReason,
      updatedAt: new Date().toISOString(),
    };
    await persistQuickRefineSession(accountId, nextSession);

    if (config.compliance?.enabled && config.compliance?.transparencyReportsEnabled) {
      await saveTransparencyReport({
        sessionId,
        turnType: 'refine',
        actorAccountId: accountId,
        provider: config.generatorConfig.provider,
        model: modelOverride || config.generatorConfig.refineModel,
        projectKey: existing.session.projectKey,
        requirementExcerpt: existing.session.originalIssue.summary.slice(0, 240),
        decisionSummary: [
          'Quick refine generated a rewrite after inline clarification answers.',
        ],
        contextUsage: {
          issueKey: existing.session.issueKey,
          answerCount: answers.length,
        },
        tokenUsage: draft.tokenUsage,
        piiMasking: { enabled: false, totalRedactions: 0, byType: {} },
      });
    }

    await recordProjectActivity({
      action: 'refine',
      projectKeys: [existing.session.projectKey],
      projectKey: existing.session.projectKey,
      sessionId,
      model: modelOverride || config.generatorConfig.refineModel,
      tokenUsage: draft.tokenUsage ?? null,
      metadata: {
        issueKey: existing.session.issueKey,
        quickRefine: true,
        stage: 'answered',
      },
    });

    return {
      success: true,
      draft,
      session: nextSession,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

resolver.define('refineQuickRefineDraft', async ({ payload, context }) => {
  try {
    const config = await getConfig();
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const sessionId = String(payload?.sessionId ?? '').trim();
    const instructions = String(payload?.instructions ?? '').trim();
    if (!sessionId || !instructions) {
      return { success: false, error: 'Missing session id or refine instructions.' };
    }

    const existing = await getQuickRefineStoredSession(accountId, payload?.issueKey, sessionId);
    if (!existing.session?.draft) {
      return { success: false, error: 'Quick refine draft not found.' };
    }
    const modelOverride = String(payload?.modelOverride ?? existing.session.modelOverride ?? '').trim() || undefined;

    const nextDraft = await refineQuickRefineDraft({
      context: existing.session.context,
      draft: payload?.draft ?? existing.session.draft,
      instructions,
      config: {
        ...config,
        generatorConfig: resolveEffectiveGeneratorConfig(config.generatorConfig),
        tier: getEffectiveTier(config, context),
      },
      modelOverride,
    });

    const nextSession: QuickRefineSession = {
      ...existing.session,
      modelOverride,
      context: {
        ...existing.session.context,
        contextMeta: nextDraft.contextMeta ?? existing.session.context.contextMeta,
      },
      draft: nextDraft,
      status: nextDraft.handoffRecommended ? 'handoff' : 'draft',
      handoffReason: nextDraft.handoffReason,
      updatedAt: new Date().toISOString(),
    };
    await persistQuickRefineSession(accountId, nextSession);

    await recordProjectActivity({
      action: 'refine',
      projectKeys: [existing.session.projectKey],
      projectKey: existing.session.projectKey,
      sessionId,
      model: modelOverride || config.generatorConfig.refineModel,
      tokenUsage: nextDraft.tokenUsage ?? null,
      metadata: {
        issueKey: existing.session.issueKey,
        quickRefine: true,
        stage: 'manual_refine',
      },
    });

    return { success: true, draft: nextDraft, session: nextSession };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});

resolver.define('applyQuickRefine', async ({ payload, context }) => {
  try {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const sessionId = String(payload?.sessionId ?? '').trim();
    if (!sessionId) {
      return { success: false, error: 'Missing session id.' };
    }

    const existing = await getQuickRefineStoredSession(accountId, payload?.issueKey, sessionId);
    if (!existing.session) {
      return { success: false, error: 'Quick refine session not found.' };
    }

    const config = await getConfig();
    const draft = (payload?.draft as QuickRefineDraft | undefined) ?? existing.session.draft;
    if (!draft) {
      return { success: false, error: 'Quick refine draft not found.' };
    }
    const currentMapping = existing.session.context.fieldMapping;
    const createIssueMapping = resolveQuickRefineProjectMapping(config, existing.session.projectKey, existing.session.issueType);
    const result = await applyQuickRefine({
      issueKey: existing.session.issueKey,
      projectKey: existing.session.projectKey,
      draft,
      reporterAccountId: accountId,
      currentIssueMapping: currentMapping,
      createIssueMapping,
      linkType: existing.session.context.linkType,
    });

    const nextSession: QuickRefineSession = {
      ...existing.session,
      draft,
      status: 'applied',
      appliedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      applyResult: result,
    };
    await persistQuickRefineSession(accountId, nextSession);

    if (config.compliance?.enabled && config.compliance?.auditTrailEnabled) {
      await appendComplianceAuditEvent({
        actorAccountId: accountId,
        category: 'runtime',
        action: 'QUICK_REFINE_APPLIED',
        details: {
          issueKey: existing.session.issueKey,
          createdIssueCount: result.createdIssues.length,
        },
        enabled: true,
      });
    }

    await recordProjectActivity({
      action: 'issue',
      projectKeys: [existing.session.projectKey],
      projectKey: existing.session.projectKey,
      sessionId,
      metadata: {
        issueKey: existing.session.issueKey,
        quickRefine: true,
        createdIssues: result.createdIssues.length,
      },
    });

    return { success: true, result, session: nextSession };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

resolver.define('v3GeneratePreview', async ({ payload, context }) => {
  try {
    const requirement = String(payload?.requirement ?? '').trim();
    if (!requirement) {
      return { success: false, error: 'Requirement is required.' };
    }

    const selection = await resolveAuthorizedProjectSelection(context, payload);
    if (!selection.projectKeys.length || selection.projectKey === '*') {
      return { success: false, error: 'Select a Jira project before running V3 Preview.' };
    }
    await ensureProjectBrowse(context, selection.projectKey);

    const configBase = await getConfig();
    const config = { ...configBase, tier: getEffectiveTier(configBase, context) };
    const selectedDocIds = Array.isArray(payload?.selectedDocIds)
      ? payload.selectedDocIds.map((value: unknown) => String(value)).filter(Boolean)
      : undefined;
    const provider = payload?.provider === 'gemini' || payload?.provider === 'heuristic'
      ? payload.provider
      : undefined;
    const maxContextCards = Number.isFinite(Number(payload?.maxContextCards))
      ? Math.max(4, Math.min(24, Number(payload.maxContextCards)))
      : undefined;

    const preview = await runForgeV3Preview({
      requirement,
      config,
      projectKey: selection.projectKey,
      projectKeys: selection.projectKeys,
      accountId: (context as { accountId?: string })?.accountId,
      selectedDocIds,
      provider,
      maxContextCards,
      jsaText: typeof payload?.jsaText === 'string' ? payload.jsaText : undefined,
    });

    return { success: true, ...preview };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
});


// ─── Work Instructions ────────────────────────────────────────────────────────

resolver.define('uploadWi', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim();
  if (projectKey && projectKey !== '*') {
    await ensureAdmin(context, projectKey);
  } else {
    await ensureAdmin(context);
  }
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
    targetProjects: projectKey && projectKey !== '*' ? [projectKey] : ['*'],
  });

  const affectedProjects = projectKey && projectKey !== '*'
    ? [projectKey]
    : await listProjectKeysForProjectMemoryCompiler(config);
  await queueProjectMemoryRefreshForProjects(affectedProjects, 'threshold', {
    requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
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
    const normalizedMapping = normalizeProjectArMapping(arMapping, projectKey);
    const normalizedIssueType = String(normalizedMapping.issueType ?? '*');
    const idx = nextConfig.arMappings.findIndex(m => m.projectKey === projectKey && String(m.issueType ?? '*') === normalizedIssueType);
    // Note: the normalized mapping preserves both the new and legacy shapes.
    if (idx >= 0) nextConfig.arMappings[idx] = normalizedMapping;
    else nextConfig.arMappings.push(normalizedMapping);
  }
  
  // Domain Contexts
  if (domainContext !== undefined) {
    const normalizedContext = normalizeProjectDomainContext(domainContext, projectKey);
    const idx = nextConfig.domainContexts.findIndex(c => c.projectKey === projectKey);
    if (idx >= 0) nextConfig.domainContexts[idx] = normalizedContext;
    else nextConfig.domainContexts.push(normalizedContext);
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
  await queueProjectMemoryRefresh(projectKey, 'threshold', {
    requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
  });
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
  const projectKey = String(payload?.projectKey ?? '').trim();
  if (projectKey && projectKey !== '*') {
    await ensureAdmin(context, projectKey);
  } else {
    await ensureAdmin(context);
  }
  await removeDoc(payload.docId);
  const config = await getConfig();
  const affectedProjects = projectKey && projectKey !== '*'
    ? [projectKey]
    : await listProjectKeysForProjectMemoryCompiler(config);
  await queueProjectMemoryRefreshForProjects(affectedProjects, 'threshold', {
    requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
  });
  return { success: true };
});

resolver.define('getBacklogCacheInfo', async ({ payload, context }) => {
  const projectKey = payload?.projectKey || '*';
  await ensureProjectBrowse(context, projectKey);
  const info = await getBacklogCacheInfo(projectKey);
  return { success: true, ...info };
});

resolver.define('getGoldStoryPool', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = payload?.projectKey;
  if (!projectKey || projectKey === '*') return { success: false, entries: [] };
  const pool = await getGoldStoryPool(projectKey);
  return { success: true, entries: pool?.entries ?? [], builtAt: pool?.builtAt ?? null };
});

resolver.define('searchBacklogForGoldCandidates', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = String(payload?.projectKey ?? '').trim();
  const query = String(payload?.query ?? '').trim();
  if (!projectKey || projectKey === '*') return { success: false, results: [] };
  await ensureProjectBrowse(context, projectKey);
  const results = await searchGoldCandidatesInBacklog(projectKey, query);
  return { success: true, results };
});

resolver.define('setGoldExampleKeys', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = String(payload?.projectKey ?? '').trim();
  const keys = Array.isArray(payload?.issueKeys)
    ? payload.issueKeys.map((k: unknown) => String(k ?? '').trim()).filter(Boolean)
    : [];
  if (!projectKey || projectKey === '*') return { success: false };
  const config = await getConfig();
  const existing = config.goldExampleConfigs ?? [];
  const idx = existing.findIndex((c) => c.projectKey === projectKey);
  const updatedEntry = { projectKey, issueKeys: keys, label: idx >= 0 ? existing[idx].label : undefined };
  const nextConfigs = idx >= 0
    ? existing.map((c, i) => (i === idx ? updatedEntry : c))
    : [...existing, updatedEntry];
  await patchConfig({ goldExampleConfigs: nextConfigs });
  return { success: true };
});

resolver.define('setGoldExampleLabel', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = String(payload?.projectKey ?? '').trim();
  const label = String(payload?.label ?? '').trim();
  if (!projectKey || projectKey === '*') return { success: false };
  const config = await getConfig();
  const existing = config.goldExampleConfigs ?? [];
  const idx = existing.findIndex((c) => c.projectKey === projectKey);
  const updatedEntry = {
    projectKey,
    issueKeys: idx >= 0 ? existing[idx].issueKeys : undefined,
    label: label || undefined,
  };
  const nextConfigs = idx >= 0
    ? existing.map((c, i) => (i === idx ? updatedEntry : c))
    : [...existing, updatedEntry];
  await patchConfig({ goldExampleConfigs: nextConfigs });
  return { success: true };
});

resolver.define('diagnoseBacklogCache', async ({ payload, context }) => {
  const eventConfig = await getConfig();
  const config = { ...eventConfig, tier: getEffectiveTier(eventConfig, context) };
  const projectKey = payload?.projectKey || '*';
  await ensureProjectBrowse(context, projectKey);
  const diagnostics = await diagnoseBacklogCache(projectKey, config);
  return { success: true, diagnostics };
});

resolver.define('refreshBacklogCache', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = payload?.projectKey || '*';
  await ensureProjectBrowse(context, projectKey);
  await entitySetSmall(KEYS.backlogRefreshStatus(projectKey), {
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

resolver.define('refreshProjectMemory', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = String(payload?.projectKey ?? '').trim() || '*';
  if (projectKey === '*') {
    return { success: false, error: 'A concrete project key is required.' };
  }
  await ensureProjectBrowse(context, projectKey);
  const queued = await queueProjectMemoryRefresh(projectKey, 'manual', {
    requestedBy: (context as { accountId?: string })?.accountId ?? 'unknown',
    force: true,
  });
  return { success: true, queued, projectKey };
});

resolver.define('getProjectMemoryRefreshStatus', async ({ payload, context }) => {
  await ensureAdmin(context, payload?.projectKey);
  const projectKey = String(payload?.projectKey ?? '').trim() || '*';
  if (projectKey === '*') {
    return { success: false, error: 'A concrete project key is required.' };
  }
  await ensureProjectBrowse(context, projectKey);
  const status = await getProjectMemoryRefreshState(projectKey);
  if (!status) {
    return { success: true, status: null };
  }
  try {
    const health = await getProjectMemoryRuntimeHealth(projectKey);
    if (!health.ok) {
      return {
        success: true,
        status: {
          ...status,
          status: 'error',
          lastError: health.reason ?? 'Compiled project memory is not readable for runtime use.',
        },
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error ?? 'Unknown project memory error');
    return {
      success: true,
      status: {
        ...status,
        status: 'error',
        lastError: `Compiled project memory health check failed: ${detail}`,
      },
    };
  }
  return { success: true, status };
});

resolver.define('getBacklogRefreshStatus', async ({ payload, context }) => {
  const projectKey = payload?.projectKey || '*';
  await ensureProjectBrowse(context, projectKey);
  const status = await entityGet(KEYS.backlogRefreshStatus(projectKey));
  return { success: true, status: status ?? null };
});

resolver.define('inferProjectPersonaRoles', async ({ payload, context }) => {
  return handleInferProjectPersonaRoles(payload, context, {
    ensureAdmin,
    getConfig,
    inferProjectPersonaRolesFromBacklog,
  });
});

async function getQuickRefineStoredSession(accountId: string, issueKey?: string, sessionId?: string) {
  const resolvedSessionId = sessionId
    || (issueKey ? await entityGet<string>(KEYS.userIssueSession(accountId, issueKey)) : null);
  if (!resolvedSessionId) {
    return { sessionId: null, session: null };
  }

  const session = await entityGet<QuickRefineSession>(KEYS.quickRefineSession(resolvedSessionId));
  return {
    sessionId: resolvedSessionId,
    session: session ?? null,
  };
}

async function persistQuickRefineSession(accountId: string, session: QuickRefineSession) {
  await entitySet(KEYS.quickRefineSession(session.sessionId), session);
  await entitySetSmall(KEYS.userIssueSession(accountId, session.issueKey), session.sessionId);
}

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
    existing.titleEditedAt = String(existing.updatedAt);
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
    const existing = await entityGet<{ turns: Array<Record<string, any>>; lastAiChange?: Record<string, any>; updatedAt?: string }>(key);
    if (existing?.turns) {
      const lastTurn = existing.turns[existing.turns.length - 1];
      if (lastTurn) {
        lastTurn.features = payload.features;
        if (payload.lastAiChange) {
          existing.lastAiChange = payload.lastAiChange;
        } else if (payload.clearLastAiChange) {
          delete existing.lastAiChange;
        }
        existing.updatedAt = new Date().toISOString();
        await entitySet(key, existing);
      }
    }
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
});

resolver.define('undoLastAiChange', async ({ payload, context }) => {
  try {
    const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
    const key = KEYS.userConversations(accountId, payload.sessionId);
    const existing = await entityGet<{ turns: Array<Record<string, any>>; lastAiChange?: Record<string, any>; updatedAt?: string }>(key);
    const lastAiChange = existing?.lastAiChange;
    if (!existing?.turns?.length || !lastAiChange?.previousFeatures) {
      return { success: false, error: 'There is no AI change available to undo.' };
    }

    existing.turns.push({
      turnType: 'undo',
      features: lastAiChange.previousFeatures,
      undoneAction: lastAiChange,
      timestamp: new Date().toISOString(),
    });
    delete existing.lastAiChange;
    existing.updatedAt = new Date().toISOString();
    await entitySet(key, existing);
    await syncConversationIndexEntry(accountId, payload.sessionId, {
      updatedAt: existing.updatedAt,
      turnCount: existing.turns.length,
    });

    return { success: true, features: lastAiChange.previousFeatures };
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
  if (!payload?.sessionId) return { success: false, error: 'missing sessionId' };
  await entitySetSmall(KEYS.userLastSession(accountId), payload.sessionId);
  return { success: true };
});

resolver.define('getIssueSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  const sessionId = await entityGet<string>(KEYS.userIssueSession(accountId, payload.issueKey));
  return { success: true, sessionId: sessionId ?? null };
});

resolver.define('setIssueSession', async ({ payload, context }) => {
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  if (!payload?.issueKey || !payload?.sessionId) return { success: false, error: 'missing issueKey or sessionId' };
  await entitySetSmall(KEYS.userIssueSession(accountId, payload.issueKey), payload.sessionId);
  return { success: true };
});

// ─── Usage ────────────────────────────────────────────────────────────────────

resolver.define('getUsage', async ({ context }) => {
  const config = await getConfig();
  const effectiveTier = getEffectiveTier(config, context);
  const usage = await getUsage(config, context);
  const limits = getUsageLimits(config, context);
  const license = context?.license ?? { active: true, licenseType: 'COMMERCIAL' }; // Default to active for dev/staging
  return {
    success: true,
    usage: {
      currentMonth: usage.generations,
      month: usage.month,
      credentialMode: usage.credentialMode,
      quotaScope: usage.quotaScope,
      resetCadence: usage.resetCadence,
      remainingFastCredits: usage.remainingFastCredits,
      remainingBalancedCredits: usage.remainingBalancedCredits,
      remainingQualityCredits: usage.remainingQualityCredits,
      resetAt: usage.resetAt,
      hasUserApiKey: usage.hasUserApiKey,
      generationAccessState: usage.generationAccessState,
      warningState: usage.warningState,
    },
    limits,
    tier: effectiveTier,
    license,
  };
});

resolver.define('resetUsage', async ({ context }) => {
  await ensureAdmin(context);
  const accountId = (context as { accountId?: string })?.accountId ?? 'unknown';
  await entityDelete(KEYS.usageCurrentMonth);
  await entityDelete(KEYS.hostedSamplerUsageCurrentMonth);
  await entityDelete(KEYS.usageCurrentMonthForAccount(accountId));
  await entityDelete(KEYS.hostedSamplerUsageCurrentMonthForAccount(accountId));
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
