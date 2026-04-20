import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Database, BrainCircuit, Globe, X, RefreshCw, Save, CreditCard, ChevronLeft, BarChart3,
  FileText, ChevronRight, ChevronDown, Check, Trash, Layers, Zap, AlertCircle, Image,
  ShieldCheck, Filter
} from 'lucide-react';
import { motion } from 'framer-motion';
import { api } from './hooks/useForge';
import type {
  InferProjectPersonaRolesResult,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmVendorModelCatalog,
  LlmProvider,
  PipelineProfile,
  ProjectGoldExampleConfig,
  ProjectActivitySummaryRow,
  ProjectPersonaRoleSuggestion,
  StoryAssistantModelAssignment,
} from './types';
import { REDACTED } from './types';
import { SearchableSelect, type SearchableSelectOption } from './components/SearchableSelect';
import { MultiSearchSelect } from './components/MultiSearchSelect';
import { StepIndicator, type StepConfig } from './components/StepIndicator';
import {
  getCatalogEntriesForProvider,
  inferModelFamily,
  normalizePipelineProfile,
  resolveProfileModelAssignments,
  resolveStoryAssistantAssignments,
} from './modelStrategy';
interface JiraProject { key: string; name: string }
interface JiraStatus { name: string; statusCategory?: { name: string } }
interface JiraField { id: string; name: string }
interface ProjectBacklogStatusScope { projectKey: string; statuses: string[] }
interface ProjectFieldMapping {
  summaryFieldId: string;
  descriptionFieldId: string;
  arFieldIds: string[];
}
interface RoleGuidanceRow {
  role: string;
  activities: string;
}
interface ProjectArMapping {
  projectKey: string;
  issueType?: string;
  mode: 'consolidated' | 'iterative';
  consolidatedFieldId: string;
  iterativeFieldIds: string[];
  inputMappings: ProjectFieldMapping;
  outputMappings: ProjectFieldMapping;
  issueLinkType?: string;
}
interface ProjectDomainContextRow {
  projectKey: string;
  context: string;
  personaRoles?: RoleGuidanceRow[];
}
interface BacklogDiagnostics {
  projectKey: string;
  configuredStatuses: string[];
  jqlUsed: string;
  totalProjectIssues: number;
  doneCategoryIssues: number;
  matchingScopeIssues: number;
  likelyReason: string;
}

interface BacklogCacheInfoRow {
  projectKey: string;
  builtAt?: string;
  issueCount: number;
  stale: boolean;
  shardCount: number;
  themeCount: number;
  themeBuiltAt?: string;
  legacyFallback: boolean;
}

interface BacklogRefreshStatusRow {
  projectKey: string;
  status: 'queued' | 'running' | 'completed' | 'error';
  updatedAt?: string;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  issueCount?: number;
  shardCount?: number;
  themeCount?: number;
  builtAt?: string;
  themeBuiltAt?: string;
  error?: string;
}

interface WiDocRow {
  docId: string;
  filename: string;
  revision: string;
  chunkCount: number;
  uploadedAt: string;
}

interface ComplianceAuditEvent {
  eventId: string;
  timestamp: string;
  actorAccountId?: string;
  category: 'config' | 'security' | 'prompt' | 'runtime';
  action: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

interface TransparencyReportRow {
  reportId: string;
  createdAt: string;
  turnType: 'generate' | 'clarify' | 'refine' | 'ask';
  projectKey?: string;
  provider?: string;
  model?: string;
  requirementExcerpt?: string;
  decisionSummary: string[];
  contextUsage?: Record<string, unknown>;
  piiMasking: { enabled: boolean; totalRedactions: number; byType?: Record<string, number> };
  tokenUsage?: { input?: number; output?: number; total: number };
}

interface ComplianceSummary {
  totalByTurnType: Record<string, number>;
  totalTokens: number;
  piiRedactionsByType: Record<string, number>;
  modelUsage: Record<string, number>;
  projectBreakdown: Array<{ projectKey: string; count: number; tokenUsage: number; latestAt?: string }>;
}

interface PiiPreviewResult {
  text: string;
  totalRedactions: number;
  byType: Record<string, number>;
}
type UsageSnapshot = {
  currentMonth: number;
  credentialMode?: 'byok' | 'hosted_sampler';
  quotaScope?: 'tenant' | 'user';
  resetCadence?: 'calendar_month';
  remainingFastCredits?: number;
  remainingBalancedCredits?: number;
  remainingQualityCredits?: number;
} | null;
const WI_ACCEPT = '.pdf,.csv,.eml,.txt,.md';
const ROLE_GUIDANCE_MARKER = '\n\n[[role-guidance]]\n';
type UiProvider = Exclude<LlmProvider, 'forge_llms'>;

function getDisplayProvider(provider: LlmProvider): UiProvider {
  return provider === 'forge_llms' ? 'anthropic' : provider;
}

function getProviderLabel(provider: UiProvider) {
  if (provider === 'anthropic') return 'Anthropic';
  if (provider === 'fireworks') return 'Fireworks';
  if (provider === 'azure_openai') return 'Azure OpenAI';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function compactUiText(value: string) {
  return String(value ?? '')
    .replace(/\u2026/g, '...')
    .replace(/\u2318/g, 'Cmd')
    .replace(/\s+/g, ' ')
    .trim();
}

function maskPreviewText(text: string) {
  const raw = text ?? '';
  const counts: Record<string, number> = {};
  let masked = raw;
  masked = masked.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => {
    counts.email = (counts.email ?? 0) + 1;
    return '[REDACTED_EMAIL]';
  });
  masked = masked.replace(/\b(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)\d{3,4}[\s.-]?\d{3,4}\b/g, () => {
    counts.phone = (counts.phone ?? 0) + 1;
    return '[REDACTED_PHONE]';
  });
  masked = masked.replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, () => {
    counts.iban = (counts.iban ?? 0) + 1;
    return '[REDACTED_IBAN]';
  });
  masked = masked.replace(/\b(?:\d[ -]*?){13,19}\b/g, () => {
    counts.paymentCard = (counts.paymentCard ?? 0) + 1;
    return '[REDACTED_CARD]';
  });
  masked = masked.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => {
    counts.ssn = (counts.ssn ?? 0) + 1;
    return '[REDACTED_SSN]';
  });
  return {
    text: masked,
    totalRedactions: Object.values(counts).reduce((sum, next) => sum + next, 0),
    byType: counts,
  };
}

function getCatalogModelId(entry?: LlmModelCatalogEntry) {
  return entry?.deploymentName || entry?.id || '';
}

function getPreferredFamilyModel(entries: LlmModelCatalogEntry[], family: 'pro' | 'flash' | 'lite') {
  const preferred = entries.find(entry => entry.family === family && entry.isLatest)
    || entries.find(entry => entry.family === family);
  return getCatalogModelId(preferred);
}

function isProviderModel(provider: LlmProvider, modelId: string) {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return false;
  if (provider === 'gemini') return normalized.startsWith('gemini-');
  if (provider === 'openai') return normalized.startsWith('gpt-') || normalized.startsWith('o');
  if (provider === 'fireworks') return Boolean(normalized);
  if (provider === 'azure_openai') return true;
  return normalized.startsWith('claude-');
}

const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';

function parseFireworksManualModelIds(raw: string): string[] {
  return [...new Set(
    raw
      .split(/[\n,]+/)
      .map((value) => String(value ?? '').trim())
      .filter(Boolean),
  )];
}

function buildFireworksManualEntries(modelIds: string[]): LlmModelCatalogEntry[] {
  return modelIds.map((id) => {
    const family = inferModelFamily(id);
    return {
      id,
      displayName: id,
      family,
      source: 'manual' as const,
    };
  });
}

function mergeCatalogModelEntries(
  primary: LlmModelCatalogEntry[],
  secondary: LlmModelCatalogEntry[],
): LlmModelCatalogEntry[] {
  const merged = new Map<string, LlmModelCatalogEntry>();
  [...primary, ...secondary].forEach((entry) => {
    const id = String(entry?.deploymentName || entry?.id || '').trim();
    if (!id) return;
    merged.set(id, { ...entry, id });
  });
  return [...merged.values()];
}

function buildFireworksCatalog(
  current: LlmVendorModelCatalog | undefined,
  manualModelIds: string[],
  discovered?: LlmVendorModelCatalog,
): LlmVendorModelCatalog | undefined {
  const manualEntries = buildFireworksManualEntries(manualModelIds);
  const discoveredEntries = (discovered?.models ?? current?.models ?? []).filter((entry) => entry.source !== 'manual');
  const models = mergeCatalogModelEntries(discoveredEntries, manualEntries);
  if (!models.length) return undefined;
  return {
    vendor: 'fireworks',
    source: discoveredEntries.length ? (discovered?.source ?? current?.source ?? 'discovered') : 'manual',
    fetchedAt: discovered?.fetchedAt ?? current?.fetchedAt,
    models,
  };
}

function isModelPresentInEntries(entries: LlmModelCatalogEntry[], modelId?: string) {
  const normalized = String(modelId ?? '').trim();
  if (!normalized) return false;
  return entries.some((entry) => getCatalogModelId(entry) === normalized);
}

function coerceRoleGuidanceRows(
  rawRows: any[] = [],
  options: { trimFields?: boolean; includeBlankFallback?: boolean } = {},
): RoleGuidanceRow[] {
  const { trimFields = true, includeBlankFallback = false } = options;
  const rows = rawRows
    .map((row: any) => {
      if (!row) return null;
      const rawRole = typeof row === 'string'
        ? row
        : String(row.role ?? row.name ?? row.title ?? '');
      const rawActivities = typeof row === 'string'
        ? ''
        : String(row.activities ?? row.activity ?? row.description ?? row.context ?? '');
      const role = trimFields ? rawRole.trim() : rawRole;
      const activities = trimFields ? rawActivities.trim() : rawActivities;
      return { role, activities };
    })
    .filter((row: RoleGuidanceRow | null): row is RoleGuidanceRow => {
      if (!row) return false;
      const hasContent = trimFields
        ? Boolean(row.role || row.activities)
        : Boolean(row.role.length || row.activities.length);
      return hasContent;
    });
  return rows.length ? rows : (includeBlankFallback ? [{ role: '', activities: '' }] : []);
}

function normalizeRoleGuidanceRows(rawRows: any[] = []): RoleGuidanceRow[] {
  return coerceRoleGuidanceRows(rawRows, { trimFields: true, includeBlankFallback: true });
}

function mergeSuggestedPersonaRoles(
  existingRows: RoleGuidanceRow[],
  selectedSuggestions: ProjectPersonaRoleSuggestion[],
): RoleGuidanceRow[] {
  const normalizedExisting = coerceRoleGuidanceRows(existingRows, { trimFields: true, includeBlankFallback: false });
  const nextRows = normalizedExisting.length ? [...normalizedExisting] : [];
  const exactKeys = new Set(nextRows.map((row) => `${row.role.toLowerCase()}::${row.activities.toLowerCase()}`));

  selectedSuggestions.forEach((suggestion) => {
    const role = suggestion.role.trim();
    const activities = suggestion.activities.trim();
    if (!role || !activities) return;

    const exactKey = `${role.toLowerCase()}::${activities.toLowerCase()}`;
    if (exactKeys.has(exactKey)) return;

    const sameRoleIndex = nextRows.findIndex((row) => row.role.trim().toLowerCase() === role.toLowerCase());
    if (sameRoleIndex >= 0) {
      const current = nextRows[sameRoleIndex];
      if (!current.activities.trim()) {
        nextRows[sameRoleIndex] = { ...current, activities };
        exactKeys.add(exactKey);
      }
      return;
    }

    nextRows.push({ role, activities });
    exactKeys.add(exactKey);
  });

  return nextRows.length ? nextRows : [{ role: '', activities: '' }];
}

const DOMAIN_PLATFORMS_MARKER = 'PLATFORMS:';
const DOMAIN_OBJECTS_MARKER = 'BUSINESS OBJECTS:';
const DOMAIN_HANDOFFS_MARKER = 'HANDOFFS & INTEGRATIONS:';

interface DomainContextFields { platforms: string; businessObjects: string; handoffs: string; }

function parseDomainContextFields(raw = ''): DomainContextFields {
  const lines = raw.split('\n').map(l => l.trim());
  const get = (marker: string) => {
    const line = lines.find(l => l.startsWith(marker));
    return line ? line.slice(marker.length).trim() : '';
  };
  return { platforms: get(DOMAIN_PLATFORMS_MARKER), businessObjects: get(DOMAIN_OBJECTS_MARKER), handoffs: get(DOMAIN_HANDOFFS_MARKER) };
}

function formatDomainContextFields({ platforms, businessObjects, handoffs }: DomainContextFields): string {
  const parts: string[] = [];
  if (platforms.trim()) parts.push(`${DOMAIN_PLATFORMS_MARKER} ${platforms.trim()}`);
  if (businessObjects.trim()) parts.push(`${DOMAIN_OBJECTS_MARKER} ${businessObjects.trim()}`);
  if (handoffs.trim()) parts.push(`${DOMAIN_HANDOFFS_MARKER} ${handoffs.trim()}`);
  return parts.join('\n');
}

function isStructuredDomainContext(raw = ''): boolean {
  return raw.includes(DOMAIN_PLATFORMS_MARKER) || raw.includes(DOMAIN_OBJECTS_MARKER) || raw.includes(DOMAIN_HANDOFFS_MARKER);
}

function splitGuidanceContext(rawContext = '') {
  const markerIndex = rawContext.indexOf(ROLE_GUIDANCE_MARKER);
  if (markerIndex === -1) {
    return { context: rawContext.trim(), roleRows: [] as RoleGuidanceRow[] };
  }
  const context = rawContext.slice(0, markerIndex).trim();
  const payload = rawContext.slice(markerIndex + ROLE_GUIDANCE_MARKER.length).trim();
  if (!payload) {
    return { context, roleRows: [] as RoleGuidanceRow[] };
  }
  try {
    const parsed = JSON.parse(payload);
    return { context, roleRows: normalizeRoleGuidanceRows(Array.isArray(parsed) ? parsed : []) };
  } catch {
    return { context, roleRows: [] as RoleGuidanceRow[] };
  }
}

function normalizeOptionalPositiveInt(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function areStringArraysEqual(left: string[] = [], right: string[] = []) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

type SettingsSurface = 'workspace' | 'project';
type WorkspaceSettingsTab = 'models' | 'domain' | 'stats' | 'billing' | 'compliance';

export function SettingsView({
  onClose,
  initialSurface = 'workspace',
  initialTab = 'models',
  initialProjectKey = '*',
}: {
  onClose: () => void;
  initialSurface?: SettingsSurface;
  initialTab?: 'models' | 'jira' | 'domain' | 'stats' | 'billing' | 'compliance';
  initialProjectKey?: string;
}) {
  const [activeSurface, setActiveSurface] = useState<SettingsSurface>(initialSurface);
  const [activeTab, setActiveTab] = useState<WorkspaceSettingsTab>(
    initialTab === 'billing' || initialTab === 'stats' || initialTab === 'compliance' || initialTab === 'domain'
      ? initialTab
      : 'models',
  );
  const [isSaving, setIsSaving] = useState(false);

  // Models State
  const [provider, setProvider] = useState<LlmProvider>('anthropic');
  const [pipelineProfile, setPipelineProfile] = useState<PipelineProfile>('balanced');
  const [decompositionModel, setDecompositionModel] = useState('');
  const [arModel, setArModel] = useState('');
  const [clarifyModel, setClarifyModel] = useState('');
  const [refineModel, setRefineModel] = useState('');
  const [themeModel, setThemeModel] = useState('');
  const [storyAssistantModelAssignments, setStoryAssistantModelAssignments] = useState<Partial<Record<LlmProvider, StoryAssistantModelAssignment>>>({});
  const roleModelValues = {
    themeModel,
    refineModel,
  };
  const roleModelSetters = {
    themeModel: setThemeModel,
    refineModel: setRefineModel,
  };

  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [geminiBaseUrl, setGeminiBaseUrl] = useState('');
  const [existingGeminiApiKey, setExistingGeminiApiKey] = useState('');

  const [anthropicApiKey, setAnthropicApiKey] = useState('');
  const [anthropicBaseUrl, setAnthropicBaseUrl] = useState('');
  const [existingAnthropicApiKey, setExistingAnthropicApiKey] = useState('');
  
  const [openaiApiKey, setOpenaiApiKey] = useState('');
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState('');
  const [existingOpenaiApiKey, setExistingOpenaiApiKey] = useState('');
  const [fireworksApiKey, setFireworksApiKey] = useState('');
  const [fireworksBaseUrl, setFireworksBaseUrl] = useState('');
  const [fireworksManualModels, setFireworksManualModels] = useState('');
  const [existingFireworksApiKey, setExistingFireworksApiKey] = useState('');

  const [azureOpenAIApiKey, setAzureOpenAIApiKey] = useState('');
  const [azureOpenAIBaseUrl, setAzureOpenAIBaseUrl] = useState('');
  const [azureOpenAIApiVersion, setAzureOpenAIApiVersion] = useState('2024-06-01');
  const [existingAzureOpenAIApiKey, setExistingAzureOpenAIApiKey] = useState('');

  const [ollamaApiKey, setOllamaApiKey] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('');
  const [existingOllamaApiKey, setExistingOllamaApiKey] = useState('');

  const [groqApiKey, setGroqApiKey] = useState('');
  const [groqBaseUrl, setGroqBaseUrl] = useState('');
  const [existingGroqApiKey, setExistingGroqApiKey] = useState('');
  const [modelCatalogs, setModelCatalogs] = useState<LlmModelCatalogByVendor>({});
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  
  const [isTestingLlm, setIsTestingLlm] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Jira State
  const [projects, setProjects] = useState<JiraProject[]>([]);
  const [backlogStatusOptions, setBacklogStatusOptions] = useState<JiraStatus[]>([]);
  const [customFields, setCustomFields] = useState<JiraField[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [arMappings, setArMappings] = useState<ProjectArMapping[]>([]);
  const [backlogStatusScopes, setBacklogStatusScopes] = useState<ProjectBacklogStatusScope[]>([]);
  const [activeArProj, setActiveArProj] = useState(initialProjectKey); // Global context selector
  const [backlogCacheInfo, setBacklogCacheInfo] = useState<BacklogCacheInfoRow | null>(null);
  const [backlogDiagnostics, setBacklogDiagnostics] = useState<BacklogDiagnostics | null>(null);
  const [backlogRefreshStatus, setBacklogRefreshStatus] = useState<BacklogRefreshStatusRow | null>(null);
  const [isRefreshingBacklogCache, setIsRefreshingBacklogCache] = useState(false);
  const [backlogThemeBudgetOverride, setBacklogThemeBudgetOverride] = useState('');
  const [goldExampleConfigs, setGoldExampleConfigs] = useState<ProjectGoldExampleConfig[]>([]);
  const [goldStoryPool, setGoldStoryPool] = useState<{ key: string; summary: string; score: number }[]>([]);

  // Personal + workspace state
  const [defaultProjectKey, setDefaultProjectKey] = useState('');
  const [tier, setTier] = useState<'free' | 'standard'>('standard');
  const [complianceEnabled, setComplianceEnabled] = useState(false);
  const [transparencyEnabled, setTransparencyEnabled] = useState(false);
  const [piiMaskingEnabled, setPiiMaskingEnabled] = useState(false);
  const [auditTrailEnabled, setAuditTrailEnabled] = useState(false);
  const [pipelineAuditEnabled, setPipelineAuditEnabled] = useState(false);
  const [complianceEvents, setComplianceEvents] = useState<ComplianceAuditEvent[]>([]);
  const [transparencyReports, setTransparencyReports] = useState<TransparencyReportRow[]>([]);
  const [complianceSummary, setComplianceSummary] = useState<ComplianceSummary | null>(null);
  const [projectActivityRows, setProjectActivityRows] = useState<ProjectActivitySummaryRow[]>([]);
  const [reportFilterTurnType, setReportFilterTurnType] = useState('');
  const [reportFilterProject, setReportFilterProject] = useState('');
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);
  const [showAllAuditEvents, setShowAllAuditEvents] = useState(false);
  const [setupBannerDismissed, setSetupBannerDismissed] = useState(() => {
    try { return localStorage.getItem('rf_setup_banner_dismissed') === '1'; } catch { return false; }
  });
  const [auditCategoryFilter, setAuditCategoryFilter] = useState<'all' | 'config' | 'security' | 'prompt' | 'runtime'>('runtime');
  const [piiPreviewInput, setPiiPreviewInput] = useState('Contact Jane Doe at jane.doe@example.com or +31 6 1234 5678 to review payment card 4111 1111 1111 1111.');
  const [piiPreviewResult, setPiiPreviewResult] = useState<PiiPreviewResult>({ text: '', totalRedactions: 0, byType: {} });
  const [brandingLogoUrl, setBrandingLogoUrl] = useState('');
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<UsageSnapshot>(null);
  const [limits, setLimits] = useState<{ generationsPerMonth: number } | null>(null);
  const [domainContexts, setDomainContexts] = useState<ProjectDomainContextRow[]>([]);
  const [activeProjAdmin, setActiveProjAdmin] = useState<boolean>(false);
  const isHostedSampler = usage?.credentialMode === 'hosted_sampler';
  const canManageProjectSettings = Boolean(isAdmin || activeProjAdmin);
  const projectCapabilities = {
    canManageProjectSettings,
    canManageWi: canManageProjectSettings,
    canManageGoldExamples: canManageProjectSettings,
    canManageMapping: canManageProjectSettings,
  } as const;
  
  // WIs State
  const [wiEnabled, setWiEnabled] = useState(true);
  const [wiDocs, setWiDocs] = useState<WiDocRow[]>([]);
  const [wiUploadState, setWiUploadState] = useState<{ filename: string; stage: 'reading' | 'uploading' | 'indexing' } | null>(null);
  const [wiUploadError, setWiUploadError] = useState<string | null>(null);
  const wiFileInputRef = useRef<HTMLInputElement>(null);
  const workspaceTokenUsage = useMemo(() => {
    return transparencyReports.reduce((sum, report) => sum + (report.tokenUsage?.total ?? 0), 0);
  }, [transparencyReports]);
  const configuredProjectCount = useMemo(() => {
    const keys = new Set<string>();
    arMappings.forEach((mapping) => {
      if (mapping?.projectKey && mapping.projectKey !== '*') keys.add(mapping.projectKey);
    });
    domainContexts.forEach((context) => {
      if (context?.projectKey && context.projectKey !== '*') keys.add(context.projectKey);
    });
    backlogStatusScopes.forEach((scope) => {
      if (scope?.projectKey && scope.projectKey !== '*') keys.add(scope.projectKey);
    });
    return keys.size;
  }, [arMappings, domainContexts, backlogStatusScopes]);

  const completionStatus = useMemo(() => {
    const hasApiKey = !!(existingAnthropicApiKey || existingGeminiApiKey || existingOpenaiApiKey || existingFireworksApiKey || existingAzureOpenAIApiKey || existingOllamaApiKey || existingGroqApiKey);
    return {
      models: provider === 'forge_llms' || hasApiKey ? 'complete' : hasApiKey === false && isAdmin !== null ? 'warning' : 'pending',
      jira: arMappings.length > 0 ? 'complete' : 'pending',
      domain: domainContexts.some(d => d.context?.trim()) ? 'complete' : 'pending',
    } as const;
  }, [provider, existingAnthropicApiKey, existingGeminiApiKey, existingOpenaiApiKey, existingFireworksApiKey, existingAzureOpenAIApiKey, existingOllamaApiKey, existingGroqApiKey, arMappings, domainContexts, isAdmin]);

  const projectUsageBreakdown = useMemo(() => {
    return projectActivityRows
      .map((row) => ({
        projectKey: row.projectKey,
        tokenUsage: row.tokenUsage,
        reportCount: row.count,
        latestAt: row.latestAt,
        actionCounts: row.actionCounts,
      }))
      .sort((a, b) => b.reportCount - a.reportCount || b.tokenUsage - a.tokenUsage);
  }, [projectActivityRows]);

  const projectOptions = useMemo<SearchableSelectOption[]>(
    () => projects.map((project) => ({
      value: project.key,
      label: `${project.key} · ${project.name}`,
      description: project.name,
    })),
    [projects],
  );

  const loadBacklogCacheInfo = useCallback(async (projectKey: string) => {
    try {
      const res = await api.getBacklogCacheInfo(projectKey) as any;
      if (res?.success) {
        const nextInfo = {
          projectKey: res.projectKey,
          builtAt: res.builtAt,
          issueCount: res.issueCount ?? 0,
          stale: !!res.stale,
          shardCount: res.shardCount ?? 0,
          themeCount: res.themeCount ?? 0,
          themeBuiltAt: res.themeBuiltAt,
          legacyFallback: !!res.legacyFallback,
        };
        setBacklogCacheInfo(nextInfo);
        // Also load gold story pool for this project
        try {
          const goldRes = await api.getGoldStoryPool(projectKey) as any;
          if (goldRes?.success) setGoldStoryPool(goldRes.entries ?? []);
        } catch { /* non-fatal */ }
        return nextInfo;
      }
    } catch (e) {
      console.error('Could not load backlog cache info', e);
    }
    return null;
  }, []);

  const loadBacklogDiagnostics = useCallback(async (projectKey: string) => {
    try {
      const res = await api.diagnoseBacklogCache(projectKey) as any;
      if (res?.success) {
        setBacklogDiagnostics(res.diagnostics ?? null);
        return res.diagnostics ?? null;
      } else {
        setBacklogDiagnostics(null);
      }
    } catch (e) {
      console.error('Could not load backlog diagnostics', e);
      setBacklogDiagnostics(null);
    }
    return null;
  }, []);

  const loadBacklogRefreshStatus = useCallback(async (projectKey: string) => {
    try {
      const res = await api.getBacklogRefreshStatus(projectKey) as any;
      if (res?.success) {
        setBacklogRefreshStatus(res.status ?? null);
        return res.status ?? null;
      }
    } catch (e) {
      console.error('Could not load backlog refresh status', e);
    }
    return null;
  }, []);

  useEffect(() => {
    loadInitialConfig();
    // Bootstraps settings state once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setActiveSurface(initialSurface);
    if (initialTab === 'billing' || initialTab === 'stats' || initialTab === 'compliance' || initialTab === 'domain') {
      setActiveTab(initialTab);
    } else {
      setActiveTab('models');
    }
  }, [initialSurface, initialTab]);

  useEffect(() => {
    if (initialProjectKey) setActiveArProj(initialProjectKey);
  }, [initialProjectKey]);

  function detectDefaultStatuses(statuses: JiraStatus[]): string[] {
    if (!statuses.length) return [];
    const byCategory = statuses
      .filter(s => (s.statusCategory?.name || '').toLowerCase() === 'done')
      .map(s => s.name);
    if (byCategory.length) {
      return [...new Set(byCategory)];
    }
    const doneKeywords = ['done', 'completed', 'deployed', 'released', 'closed', 'resolved'];
    const matches = statuses
      .map(s => s.name)
      .filter(name => doneKeywords.some(k => name.toLowerCase().includes(k)));
    return matches.length ? [...new Set(matches)] : [statuses[0].name];
  }

  async function loadInitialConfig() {
    api.discoverLinkTypes().then((res: any) => {
      // Logic for available link types was removed
    }).catch(() => {});

    try {
      const existingConfig = await api.getConfig() as any;
      if (existingConfig) {
        const gc = existingConfig.generatorConfig || {};
        const loadedProvider = gc.provider ? getDisplayProvider(gc.provider) : 'anthropic';
        setProvider(loadedProvider);
        setPipelineProfile(normalizePipelineProfile(gc.pipelineProfile));
        if (gc.decompositionModel) setDecompositionModel(gc.decompositionModel);
        if (gc.arModel) setArModel(gc.arModel);
        if (gc.clarifyModel) setClarifyModel(gc.clarifyModel);
        if (gc.refineModel) setRefineModel(gc.refineModel);
        if (gc.themeModel) setThemeModel(gc.themeModel);

        if (gc.geminiApiKey) setExistingGeminiApiKey(gc.geminiApiKey);
        if (gc.geminiBaseUrl) setGeminiBaseUrl(gc.geminiBaseUrl);
        if (gc.anthropicApiKey) setExistingAnthropicApiKey(gc.anthropicApiKey);
        if (gc.anthropicBaseUrl) setAnthropicBaseUrl(gc.anthropicBaseUrl);
        if (gc.openaiApiKey) setExistingOpenaiApiKey(gc.openaiApiKey);
        if (gc.openaiBaseUrl) setOpenaiBaseUrl(gc.openaiBaseUrl);
        if (gc.fireworksApiKey) setExistingFireworksApiKey(gc.fireworksApiKey);
        if (gc.fireworksBaseUrl) setFireworksBaseUrl(gc.fireworksBaseUrl);
        if (gc.azureOpenAIApiKey) setExistingAzureOpenAIApiKey(gc.azureOpenAIApiKey);
        if (gc.azureOpenAIBaseUrl) setAzureOpenAIBaseUrl(gc.azureOpenAIBaseUrl);
        if (gc.azureOpenAIApiVersion) setAzureOpenAIApiVersion(gc.azureOpenAIApiVersion);
        if (gc.ollamaApiKey) setExistingOllamaApiKey(gc.ollamaApiKey);
        if (gc.ollamaBaseUrl) setOllamaBaseUrl(gc.ollamaBaseUrl);
        if (gc.groqApiKey) setExistingGroqApiKey(gc.groqApiKey);
        if (gc.groqBaseUrl) setGroqBaseUrl(gc.groqBaseUrl);
        if (gc.modelCatalogs) {
          const nextCatalogs = { ...gc.modelCatalogs } as LlmModelCatalogByVendor;
          if (!nextCatalogs.anthropic && nextCatalogs.forge_llms) {
            nextCatalogs.anthropic = {
              ...nextCatalogs.forge_llms,
              vendor: 'anthropic',
            };
          }
          setModelCatalogs(nextCatalogs);
          const compatibleManualModels = (nextCatalogs.fireworks?.models ?? [])
            .filter((entry) => entry.source === 'manual')
            .map((entry) => getCatalogModelId(entry))
            .filter(Boolean);
          if (compatibleManualModels.length) {
            setFireworksManualModels(compatibleManualModels.join('\n'));
          }
        }
        if (gc.storyAssistantModelAssignments) {
          setStoryAssistantModelAssignments(gc.storyAssistantModelAssignments);
        }

        if (existingConfig.tier) setTier(existingConfig.tier);
        setComplianceEnabled(Boolean(existingConfig.compliance?.enabled));
        setTransparencyEnabled(Boolean(existingConfig.compliance?.transparencyReportsEnabled));
        setPiiMaskingEnabled(Boolean(existingConfig.compliance?.piiMaskingEnabled));
        setAuditTrailEnabled(Boolean(existingConfig.compliance?.auditTrailEnabled));
        setPipelineAuditEnabled(Boolean(existingConfig.developerTools?.pipelineAuditEnabled));
        if (existingConfig.wiConfig?.enabled !== undefined) setWiEnabled(existingConfig.wiConfig.enabled);
        if (existingConfig.defaultProjectKey) setDefaultProjectKey(existingConfig.defaultProjectKey);
        if (existingConfig.arMappings) setArMappings(existingConfig.arMappings.map((mapping: any) => normalizeProjectArMapping(mapping)));
        if (existingConfig.domainContexts) {
          setDomainContexts(existingConfig.domainContexts.map((entry: any) => normalizeProjectDomainContext(entry)));
        } else {
          const parsedContext = splitGuidanceContext(existingConfig.domainContext || '');
          setDomainContexts([{
            projectKey: '*',
            context: parsedContext.context,
            personaRoles: parsedContext.roleRows.length
              ? parsedContext.roleRows
              : normalizeRoleGuidanceRows(existingConfig.domainRoles as any[]).filter((row) => row.role || row.activities),
          }]);
        }
        if (existingConfig.backlogStatusScopes) setBacklogStatusScopes(existingConfig.backlogStatusScopes);
        setGoldExampleConfigs(existingConfig.goldExampleConfigs ?? []);
        if (existingConfig.backlogThemeBudgetOverride) {
          setBacklogThemeBudgetOverride(String(existingConfig.backlogThemeBudgetOverride));
        } else {
          setBacklogThemeBudgetOverride('');
        }
        if (existingConfig.branding?.logoUrl !== undefined) setBrandingLogoUrl(existingConfig.branding.logoUrl || '');
        if (existingConfig.isAdmin !== undefined) setIsAdmin(existingConfig.isAdmin);
      }
      const usageRes = await api.getUsage() as any;
      if (usageRes?.usage) setUsage(usageRes.usage);
      if (usageRes?.limits) setLimits(usageRes.limits);
      if (usageRes?.tier) setTier(usageRes.tier);
      const jiraRes = await api.discoverJira() as any;
      if (jiraRes?.success !== false) {
        setProjects(jiraRes.projects ?? []);
        setCustomFields(jiraRes.fields ?? []);
      }
      const [auditRes, reportRes, summaryRes, activityRes, piiPreviewRes] = await Promise.all([
        api.listComplianceAuditEvents(250) as Promise<any>,
        api.listTransparencyReports({ limit: 250 }) as Promise<any>,
        api.getComplianceSummary().catch(() => null) as Promise<any>,
        api.getProjectActivitySummary(1000).catch(() => null) as Promise<any>,
        api.previewPiiMasking({ text: piiPreviewInput, enabled: true }).catch(() => null) as Promise<any>,
      ]);
      setComplianceEvents(Array.isArray(auditRes?.events) ? auditRes.events : []);
      setTransparencyReports(Array.isArray(reportRes?.reports) ? reportRes.reports : []);
      if (summaryRes?.summary) setComplianceSummary(summaryRes.summary);
      setProjectActivityRows(Array.isArray(activityRes?.summary) ? activityRes.summary : []);
      if (piiPreviewRes?.success) {
        setPiiPreviewResult({
          text: piiPreviewRes.text,
          totalRedactions: piiPreviewRes.totalRedactions ?? 0,
          byType: piiPreviewRes.byType ?? {},
        });
      }
    } catch (e) { console.error('Error loading config', e); }
  }

  const checkProjectAdmin = useCallback(async () => {
    if (!activeArProj || activeArProj === '*') {
      setActiveProjAdmin(!!isAdmin);
      return;
    }
    try {
      const res = await api.checkIsAdmin({ projectKey: activeArProj }) as any;
      if (res?.success) setActiveProjAdmin(!!res.isProjectAdmin);
    } catch { setActiveProjAdmin(false); }
  }, [activeArProj, isAdmin]);

  const loadWiDocs = useCallback(async () => {
    try {
      const res = await api.listWiDocs(activeArProj) as any;
      if (res.success !== false) setWiDocs(res.docs ?? []);
    } catch (e: any) { console.error('Could not list documents', e); }
  }, [activeArProj]);

  useEffect(() => {
    checkProjectAdmin();
  }, [checkProjectAdmin]);

  useEffect(() => {
    if (activeSurface === 'project' && activeArProj && activeArProj !== '*') {
      void loadBacklogCacheInfo(activeArProj);
      void loadBacklogDiagnostics(activeArProj);
      void loadBacklogRefreshStatus(activeArProj);
    } else {
      setBacklogCacheInfo(null);
      setBacklogDiagnostics(null);
      setBacklogRefreshStatus(null);
    }
  }, [activeSurface, activeArProj, loadBacklogCacheInfo, loadBacklogDiagnostics, loadBacklogRefreshStatus]);

  useEffect(() => {
    if (activeSurface === 'project' && activeArProj && activeArProj !== '*') {
      loadBacklogStatuses(activeArProj);
    } else {
      setBacklogStatusOptions([]);
    }
  }, [activeSurface, activeArProj]);

  async function handleRefreshBacklogCache(projectKey = activeArProj) {
    if (!projectKey || projectKey === '*') return null;
    setIsRefreshingBacklogCache(true);
    try {
      const res = await api.refreshBacklogCache(projectKey) as any;
      if (res?.success) {
        setBacklogRefreshStatus({
          projectKey,
          status: 'queued',
          queuedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

        const startedAt = Date.now();
        let pollDelayMs = 2000;
        while (Date.now() - startedAt < 15 * 60 * 1000) {
          const hiddenMultiplier = (typeof document !== 'undefined' && document.visibilityState === 'hidden') ? 2 : 1;
          await new Promise(resolve => setTimeout(resolve, pollDelayMs * hiddenMultiplier));
          const status = await loadBacklogRefreshStatus(projectKey);
          if (!status) continue;
          if (status.status === 'queued' || status.status === 'running') {
            pollDelayMs = Math.min(pollDelayMs + 1000, 10000);
            continue;
          }
          if (status.status === 'error') {
            alert(status.error || 'Backlog cache refresh failed.');
            return null;
          }
          const [nextInfo, diagnostics] = await Promise.all([
            loadBacklogCacheInfo(projectKey),
            loadBacklogDiagnostics(projectKey),
          ]);
          if (nextInfo) {
            return {
              ...nextInfo,
              diagnostics,
            };
          }
          return null;
        }
        alert('Backlog cache rebuild is still running in the background. Please check back in a moment.');
      } else {
        alert(res?.error || 'Backlog cache refresh failed.');
      }
    } catch (e: any) {
      alert(e?.message || 'Backlog cache refresh failed.');
    } finally {
      setIsRefreshingBacklogCache(false);
    }
    return null;
  }

  async function loadBacklogStatuses(projectKey: string) {
    try {
      const res = await api.discoverStatuses(projectKey) as any;
      setBacklogStatusOptions(res?.statuses ?? []);
    } catch (e) {
      console.error('Could not load backlog statuses', e);
      setBacklogStatusOptions([]);
    }
  }

  useEffect(() => {
    if (activeSurface === 'project' && activeArProj && activeArProj !== '*') {
      void loadWiDocs();
    } else {
      setWiDocs([]);
    }
  }, [activeSurface, activeArProj, loadWiDocs]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await api.previewPiiMasking({ text: piiPreviewInput, enabled: piiMaskingEnabled }) as any;
        if (!cancelled && res?.success) {
          setPiiPreviewResult({
            text: res.text,
            totalRedactions: res.totalRedactions ?? 0,
            byType: res.byType ?? {},
          });
        }
      } catch {
        if (!cancelled) {
          const fallback = maskPreviewText(piiPreviewInput);
          setPiiPreviewResult({
            text: fallback.text,
            totalRedactions: fallback.totalRedactions,
            byType: fallback.byType,
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [piiPreviewInput, piiMaskingEnabled]);

  async function handleWiFileDrop(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!files.length) return;
    const invalid = files.find(file => !['.pdf', '.csv', '.txt', '.md', '.eml'].some(ext => file.name.toLowerCase().endsWith(ext)));
    if (invalid) {
      setWiUploadError('Supported formats are PDF, CSV, TXT, Markdown, and EML.');
      return;
    }
    setWiUploadError(null);
    try {
      for (let i = 0; i < files.length; i += 1) {
        const file = files[i];
        const label = files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : file.name;
        setWiUploadState({ filename: label, stage: 'reading' });
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result as string;
            resolve(dataUrl.split(',')[1] || dataUrl);
          };
          reader.onerror = () => reject(new Error('Read failed'));
          reader.readAsDataURL(file);
        });
        setWiUploadState({ filename: label, stage: 'uploading' });
        const res = await api.uploadWi(file.name, base64, undefined, activeArProj) as any;
        if (res.success === false) {
          throw new Error(res.error || 'Upload failed');
        }
        setWiUploadState({ filename: label, stage: 'indexing' });
      }
      await loadWiDocs();
    } catch (err: any) {
      console.error('Upload failed', err);
      setWiUploadError(err?.message || 'Upload failed.');
    } finally {
      setWiUploadState(null);
    }
  }

  async function handleRemoveWiDoc(docId: string) {
    try {
      await api.removeWiDoc(docId, activeArProj);
      await loadWiDocs();
    } catch (e: any) { console.error('Remove failed', e); }
  }

  const fireworksManualModelIds = useMemo(
    () => parseFireworksManualModelIds(fireworksManualModels),
    [fireworksManualModels],
  );

  const effectiveModelCatalogs = useMemo(() => {
    const nextCatalogs = { ...modelCatalogs };
    const fireworksCatalog = buildFireworksCatalog(nextCatalogs.fireworks, fireworksManualModelIds);
    if (fireworksCatalog) nextCatalogs.fireworks = fireworksCatalog;
    else delete nextCatalogs.fireworks;
    return nextCatalogs;
  }, [modelCatalogs, fireworksManualModelIds]);

  async function handleSave() {
    setIsSaving(true);
    try {
      if (activeTab === 'domain' && !isAdmin) {
        await api.saveUserPreferences({ defaultProjectKey: defaultProjectKey || undefined });
        alert('Personal settings saved successfully!');
        return;
      }
      const persistedModelCatalogs = effectiveModelCatalogs;
      await api.saveConfig({
        generatorConfig: {
          provider,
          pipelineProfile,
          decompositionModel: profileModels.decompositionModel,
          arModel: profileModels.arModel,
          clarifyModel: profileModels.clarifyModel,
          storyAssistantModelAssignments,
          refineModel,
          themeModel,
          maxTokens: 131072,
          anthropicApiKey: provider === 'anthropic' ? (anthropicApiKey.trim() || existingAnthropicApiKey || undefined) : undefined,
          anthropicBaseUrl: provider === 'anthropic' ? (anthropicBaseUrl.trim() || undefined) : undefined,
          geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || "",
          geminiBaseUrl: geminiBaseUrl.trim() || undefined,
          openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || "",
          openaiBaseUrl: openaiBaseUrl.trim() || undefined,
          fireworksApiKey: fireworksApiKey.trim() || existingFireworksApiKey || "",
          fireworksBaseUrl: fireworksBaseUrl.trim() || undefined,
          azureOpenAIApiKey: azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || "",
          azureOpenAIBaseUrl: azureOpenAIBaseUrl.trim() || undefined,
          azureOpenAIApiVersion: azureOpenAIApiVersion.trim() || undefined,
          ollamaApiKey: ollamaApiKey.trim() || existingOllamaApiKey || "",
          ollamaBaseUrl: ollamaBaseUrl.trim() || undefined,
          groqApiKey: groqApiKey.trim() || existingGroqApiKey || "",
          groqBaseUrl: groqBaseUrl.trim() || undefined,
          modelCatalogs: persistedModelCatalogs,
        },
        generationPreferences: {},
        domainContext: '',
        domainContexts,
        domainRoles: [],
        wiConfig: { enabled: wiEnabled, topKChunks: 8, maxChars: 100000 },
        compliance: {
          enabled: complianceEnabled,
          transparencyReportsEnabled: transparencyEnabled,
          piiMaskingEnabled,
          auditTrailEnabled,
        },
        developerTools: {
          pipelineAuditEnabled,
        },
        branding: {
          logoUrl: brandingLogoUrl.trim() || null,
        },
        arMappings,
        backlogStatusScopes,
        backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        tier: 'standard',
      });
      await api.saveUserPreferences({ defaultProjectKey: defaultProjectKey || undefined });
      if (geminiApiKey.trim()) setExistingGeminiApiKey(REDACTED);
      if (anthropicApiKey.trim()) setExistingAnthropicApiKey(REDACTED);
      if (openaiApiKey.trim()) setExistingOpenaiApiKey(REDACTED);
      if (fireworksApiKey.trim()) setExistingFireworksApiKey(REDACTED);
      if (azureOpenAIApiKey.trim()) setExistingAzureOpenAIApiKey(REDACTED);
      if (ollamaApiKey.trim()) setExistingOllamaApiKey(REDACTED);
      if (groqApiKey.trim()) setExistingGroqApiKey(REDACTED);
      setGeminiApiKey(''); setAnthropicApiKey(''); setOpenaiApiKey(''); setFireworksApiKey(''); setAzureOpenAIApiKey(''); setOllamaApiKey(''); setGroqApiKey('');
      alert('Settings saved successfully!');
    } catch(e: any) { alert(`Failed to save configuration: ${e.message || 'Unknown error'}`); }
    finally { setIsSaving(false); }
  }

  async function testLlmConnection() {
    setIsTestingLlm(true); setLlmTestResult(null);
    try {
      const resolvedTestModel = (profileModels.clarifyModel || clarifyModel).trim();
      const effectiveTestModel = provider === 'fireworks'
        ? (
          storyAssistantAssignments.lightModel
          || storyAssistantAssignments.heavyModel
          || availableModels[0]?.id
          || ''
        ).trim()
        : resolvedTestModel;
      if (!effectiveTestModel) {
        throw new Error(provider === 'azure_openai'
          ? 'No Azure OpenAI deployment is available yet. Refresh models and choose a concrete deployment first.'
          : provider === 'fireworks'
            ? 'Add at least one manual model ID or refresh models before testing the connection.'
          : 'Choose a concrete model before testing the connection.');
      }
      const res = await api.testLlmConnection({
        provider,
        model: effectiveTestModel,
        anthropicApiKey: provider === 'anthropic' ? (anthropicApiKey.trim() || existingAnthropicApiKey || undefined) : undefined,
        anthropicBaseUrl: provider === 'anthropic' ? (anthropicBaseUrl.trim() || undefined) : undefined,
        geminiApiKey: provider === 'gemini' ? (geminiApiKey.trim() || existingGeminiApiKey || undefined) : undefined,
        geminiBaseUrl: provider === 'gemini' ? (geminiBaseUrl.trim() || undefined) : undefined,
        openaiApiKey: provider === 'openai' ? (openaiApiKey.trim() || existingOpenaiApiKey || undefined) : undefined,
        openaiBaseUrl: provider === 'openai' ? (openaiBaseUrl.trim() || undefined) : undefined,
        fireworksApiKey: provider === 'fireworks' ? (fireworksApiKey.trim() || existingFireworksApiKey || undefined) : undefined,
        fireworksBaseUrl: provider === 'fireworks' ? (fireworksBaseUrl.trim() || undefined) : undefined,
        azureOpenAIApiKey: provider === 'azure_openai' ? (azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || undefined) : undefined,
        azureOpenAIBaseUrl: provider === 'azure_openai' ? (azureOpenAIBaseUrl.trim() || undefined) : undefined,
        azureOpenAIApiVersion: provider === 'azure_openai' ? (azureOpenAIApiVersion.trim() || undefined) : undefined,
        ollamaApiKey: provider === 'ollama' ? (ollamaApiKey.trim() || existingOllamaApiKey || undefined) : undefined,
        ollamaBaseUrl: provider === 'ollama' ? (ollamaBaseUrl.trim() || undefined) : undefined,
        groqApiKey: provider === 'groq' ? (groqApiKey.trim() || existingGroqApiKey || undefined) : undefined,
        groqBaseUrl: provider === 'groq' ? (groqBaseUrl.trim() || undefined) : undefined,
      }) as any;
      setLlmTestResult(res.success ? { ok: true, message: 'Connection successful.' } : { ok: false, message: res.error || 'Connection failed.' });
    } catch (err: any) { setLlmTestResult({ ok: false, message: err.message || 'Connection failed.' }); }
    finally { setIsTestingLlm(false); }
  }

  async function discoverJira() {
    setIsDiscovering(true);
    try {
      const res = await api.discoverJira() as any;
      if (res.success !== false) {
        setProjects(res.projects ?? []);
        setCustomFields(res.fields ?? []);
      }
    } catch(e: any) { console.error('Discovery failed', e); }
    finally { setIsDiscovering(false); }
  }

  const refreshModelCatalog = useCallback(async () => {
    setIsRefreshingModels(true);
    setModelCatalogError(null);
    try {
      const res = await api.discoverLlmModels({
        provider,
        anthropicApiKey: anthropicApiKey.trim() || existingAnthropicApiKey || undefined,
        anthropicBaseUrl: anthropicBaseUrl.trim() || undefined,
        geminiApiKey: geminiApiKey.trim() || existingGeminiApiKey || undefined,
        geminiBaseUrl: geminiBaseUrl.trim() || undefined,
        openaiApiKey: openaiApiKey.trim() || existingOpenaiApiKey || undefined,
        openaiBaseUrl: openaiBaseUrl.trim() || undefined,
        fireworksApiKey: fireworksApiKey.trim() || existingFireworksApiKey || undefined,
        fireworksBaseUrl: fireworksBaseUrl.trim() || undefined,
        azureOpenAIApiKey: azureOpenAIApiKey.trim() || existingAzureOpenAIApiKey || undefined,
        azureOpenAIBaseUrl: azureOpenAIBaseUrl.trim() || undefined,
        azureOpenAIApiVersion: azureOpenAIApiVersion.trim() || undefined,
        ollamaApiKey: ollamaApiKey.trim() || existingOllamaApiKey || undefined,
        ollamaBaseUrl: ollamaBaseUrl.trim() || undefined,
        groqApiKey: groqApiKey.trim() || existingGroqApiKey || undefined,
        groqBaseUrl: groqBaseUrl.trim() || undefined,
      }) as any;
      if (res?.success && res.catalog) {
        setModelCatalogs((prev) => {
          if (provider !== 'fireworks') {
            return { ...prev, [provider]: res.catalog };
          }
          const nextCatalog = buildFireworksCatalog(prev.fireworks, fireworksManualModelIds, res.catalog);
          if (!nextCatalog) return prev;
          return { ...prev, fireworks: nextCatalog };
        });
      } else if (res?.error) {
        setModelCatalogError(res.error);
      }
    } catch (err: any) {
      setModelCatalogError(err?.message || 'Could not refresh model list.');
    } finally {
      setIsRefreshingModels(false);
    }
  }, [
    provider,
    anthropicApiKey,
    existingAnthropicApiKey,
    anthropicBaseUrl,
    geminiApiKey,
    existingGeminiApiKey,
    geminiBaseUrl,
    openaiApiKey,
    existingOpenaiApiKey,
    openaiBaseUrl,
    fireworksApiKey,
    existingFireworksApiKey,
    fireworksBaseUrl,
    azureOpenAIApiKey,
    existingAzureOpenAIApiKey,
    azureOpenAIBaseUrl,
    azureOpenAIApiVersion,
    ollamaApiKey,
    existingOllamaApiKey,
    ollamaBaseUrl,
    groqApiKey,
    existingGroqApiKey,
    groqBaseUrl,
    fireworksManualModelIds,
  ]);

  useEffect(() => {
    const hasStoredCredential = provider === 'gemini'
      ? Boolean(existingGeminiApiKey)
        : provider === 'openai'
          ? Boolean(existingOpenaiApiKey)
        : provider === 'fireworks'
          ? Boolean(existingFireworksApiKey && fireworksBaseUrl.trim())
        : provider === 'azure_openai'
          ? Boolean(existingAzureOpenAIApiKey && azureOpenAIBaseUrl.trim())
          : provider === 'ollama'
            ? Boolean(existingOllamaApiKey)
            : provider === 'groq'
              ? Boolean(existingGroqApiKey)
              : true;
    if (hasStoredCredential && !effectiveModelCatalogs[provider]) {
      void refreshModelCatalog();
    }
  }, [provider, existingGeminiApiKey, existingOpenaiApiKey, existingFireworksApiKey, fireworksBaseUrl, existingAzureOpenAIApiKey, azureOpenAIBaseUrl, existingOllamaApiKey, existingGroqApiKey, effectiveModelCatalogs, refreshModelCatalog]);

  const { entries: catalogEntries } = useMemo(
    () => getCatalogEntriesForProvider(provider, effectiveModelCatalogs),
    [provider, effectiveModelCatalogs],
  );

  const currentCatalogEntries = useMemo(() => {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return [...catalogEntries].sort((a, b) => collator.compare(a.displayName || a.id, b.displayName || b.id));
  }, [catalogEntries]);

  const storyAssistantAssignments = useMemo(() => resolveStoryAssistantAssignments(provider, {
    clarifyModel,
    decompositionModel,
    arModel,
    storyAssistantModelAssignments,
  }), [provider, clarifyModel, decompositionModel, arModel, storyAssistantModelAssignments]);

  const profileModels = useMemo(() => resolveProfileModelAssignments(provider, pipelineProfile, storyAssistantAssignments, {
    clarifyModel,
    decompositionModel,
    arModel,
  }), [provider, pipelineProfile, storyAssistantAssignments, clarifyModel, decompositionModel, arModel]);

  useEffect(() => {
    if (profileModels.clarifyModel && profileModels.clarifyModel !== clarifyModel) {
      setClarifyModel(profileModels.clarifyModel);
    }
    if (profileModels.decompositionModel && profileModels.decompositionModel !== decompositionModel) {
      setDecompositionModel(profileModels.decompositionModel);
    }
    if (profileModels.arModel && profileModels.arModel !== arModel) {
      setArModel(profileModels.arModel);
    }
  }, [profileModels, clarifyModel, decompositionModel, arModel]);

  useEffect(() => {
    const flashModel = getPreferredFamilyModel(currentCatalogEntries, 'flash');
    const proModel = getPreferredFamilyModel(currentCatalogEntries, 'pro');
    const liteModel = getPreferredFamilyModel(currentCatalogEntries, 'lite');
    const liteOrFlashModel = liteModel || flashModel;
    const firstCatalogModel = getCatalogModelId(currentCatalogEntries[0]);
    const resolvedAssignments = resolveStoryAssistantAssignments(provider, {
      clarifyModel,
      decompositionModel,
      arModel,
      storyAssistantModelAssignments,
    });

    if (provider === 'azure_openai') {
      const shouldResetAzureModel = (modelId: string) =>
        !modelId.trim()
        || modelId.startsWith('gemini-')
        || modelId.startsWith('gpt-')
        || modelId.startsWith('o')
        || modelId.startsWith('claude-');
      if (shouldResetAzureModel(refineModel) && flashModel) setRefineModel(flashModel);
      if (shouldResetAzureModel(themeModel) && liteOrFlashModel) setThemeModel(liteOrFlashModel);
    } else if (provider === 'fireworks') {
      const compatibleLight = flashModel || liteOrFlashModel || firstCatalogModel;
      const compatibleHeavy = proModel || flashModel || firstCatalogModel;
      if (!isModelPresentInEntries(currentCatalogEntries, refineModel) && compatibleLight) setRefineModel(compatibleLight);
      if (!isModelPresentInEntries(currentCatalogEntries, themeModel) && (liteOrFlashModel || compatibleLight || compatibleHeavy)) {
        setThemeModel(liteOrFlashModel || compatibleLight || compatibleHeavy);
      }
    } else {
      if (!isProviderModel(provider, refineModel) && flashModel) setRefineModel(flashModel);
      if (!isProviderModel(provider, themeModel) && liteOrFlashModel) setThemeModel(liteOrFlashModel);
    }
    setStoryAssistantModelAssignments((prev) => {
      const current = prev[provider];
      const suggestedLight = flashModel || liteOrFlashModel || firstCatalogModel;
      const suggestedHeavy = proModel || flashModel || firstCatalogModel;
      const nextLight = isModelPresentInEntries(currentCatalogEntries, current?.lightModel)
        ? current?.lightModel
        : (isModelPresentInEntries(currentCatalogEntries, resolvedAssignments.lightModel) ? resolvedAssignments.lightModel : suggestedLight);
      const nextHeavy = isModelPresentInEntries(currentCatalogEntries, current?.heavyModel)
        ? current?.heavyModel
        : (isModelPresentInEntries(currentCatalogEntries, resolvedAssignments.heavyModel) ? resolvedAssignments.heavyModel : suggestedHeavy);
      if (!nextLight && !nextHeavy) return prev;
      if (current?.lightModel === nextLight && current?.heavyModel === nextHeavy) return prev;
      return {
        ...prev,
        [provider]: {
          lightModel: nextLight,
          heavyModel: nextHeavy,
        },
      };
    });
  }, [provider, currentCatalogEntries, refineModel, themeModel, clarifyModel, decompositionModel, arModel, storyAssistantModelAssignments]);

  const availableModels = useMemo(() => {
    const options: Array<{ id: string; label: string }> = [];
    currentCatalogEntries.forEach(entry => {
      const id = entry.deploymentName || entry.id;
      if (!options.some(option => option.id === id)) {
        options.push({
          id,
          label: entry.displayName || entry.id,
        });
      }
    });
    const fallbackModelIds = provider === 'fireworks' && currentCatalogEntries.length === 0
      ? []
      : [
        clarifyModel,
        decompositionModel,
        arModel,
        refineModel,
        themeModel,
        profileModels.clarifyModel,
        profileModels.decompositionModel,
        profileModels.arModel,
        storyAssistantAssignments.lightModel,
        storyAssistantAssignments.heavyModel,
      ];
    fallbackModelIds.forEach(modelId => {
      if (modelId && !options.some(option => option.id === modelId)) {
        options.push({ id: modelId, label: modelId });
      }
    });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return options.sort((left, right) => collator.compare(left.label, right.label));
  }, [provider, currentCatalogEntries, clarifyModel, decompositionModel, arModel, refineModel, themeModel, profileModels, storyAssistantAssignments]);

  const showComplianceTab = true;
  const workspaceNav = [
    { id: 'models', label: 'AI Setup', icon: BrainCircuit, sub: 'Provider and models' },
    { id: 'domain', label: 'Personal', icon: Globe, sub: 'Defaults and preferences' },
    { id: 'stats', label: 'Stats', icon: BarChart3, sub: 'Usage and audit visibility' },
    { id: 'billing', label: 'Billing', icon: CreditCard, sub: 'Plan and controls' },
    ...(showComplianceTab ? [{ id: 'compliance', label: 'Compliance', icon: ShieldCheck, sub: 'Coming Soon' }] : []),
  ] as const;

  const wiUploadCopy = wiUploadState
    ? wiUploadState.stage === 'reading'
      ? 'Preparing document'
      : wiUploadState.stage === 'uploading'
        ? 'Uploading document'
        : 'Indexing for retrieval'
    : null;
  return (
    <div className="flex-1 flex flex-col h-full bg-transparent relative overflow-hidden font-sans">
      <header className="shrink-0 h-14 border-b border-[rgba(43,89,74,0.08)] bg-[rgba(252,252,251,0.82)] backdrop-blur-xl flex items-center justify-between px-6 z-30 sticky top-0">
        <div className="flex items-center gap-4">
          <motion.button
            onClick={onClose}
            className="p-1.5 rounded-lg border border-[var(--rf-border)] bg-white text-[var(--rf-text-tertiary)] hover:bg-[var(--rf-surface-soft)] hover:text-[var(--rf-text)] transition-all shadow-sm"
            whileTap={{ scale: 0.95 }}
          >
            <ChevronLeft className="w-4 h-4" />
          </motion.button>
          <div className="flex items-center gap-3">
            <h2 className="rf-pane-header-title">Settings</h2>
            <div className="rounded-xl border border-[var(--rf-border)] bg-white/80 p-1 flex items-center gap-1 shadow-sm">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setActiveSurface('workspace')}
                  className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition ${activeSurface === 'workspace' ? 'bg-[var(--rf-brand)] text-white shadow-sm' : 'text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)]'}`}
                >
                  Workspace Setup
                </button>
              )}
              <button
                type="button"
                onClick={() => setActiveSurface('project')}
                className={`rounded-lg px-3 py-1.5 text-[12px] font-bold transition ${activeSurface === 'project' ? 'bg-[var(--rf-brand)] text-white shadow-sm' : 'text-[var(--rf-text-secondary)] hover:bg-[var(--rf-surface-soft)]'}`}
              >
                Project Setup
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`text-[13px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wider border ${canManageProjectSettings ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)] border-[var(--rf-success-subtle)]' : 'bg-[var(--rf-danger-subtle)] text-[var(--rf-danger)] border-[var(--rf-danger-subtle)]'}`}>
              {isAdmin ? 'Workspace Admin' : canManageProjectSettings ? 'Project Admin' : 'Read Only'}
            </span>
            <span className="text-[13px] text-[var(--rf-brand)] font-bold uppercase tracking-wider flex items-center gap-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded-md border border-[rgba(43,89,74,0.12)] capitalize">
              {tier}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {activeSurface === 'workspace' && isAdmin && activeTab !== 'compliance' && (
            <motion.button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-[var(--rf-brand)] hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 text-white text-[13px] font-bold px-4 py-1.5 rounded-lg shadow-sm shadow-[var(--rf-brand)]/20 transition-all flex items-center gap-2"
              whileTap={{ scale: 0.98 }}
            >
              {isSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </motion.button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex">
          <input type="file" ref={wiFileInputRef} onChange={handleWiFileDrop} accept={WI_ACCEPT} multiple className="hidden" />
          {activeSurface === 'workspace' && (
          <div className="w-48 shrink-0 border-r border-[rgba(43,89,74,0.10)] bg-[rgba(248,246,240,0.60)] backdrop-blur-xl px-3 py-3 flex flex-col gap-0.5 overflow-y-auto">
            {/* Group: Core Setup */}
            <div className="px-2.5 pb-1 pt-0.5">
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)] opacity-60">Workspace</span>
            </div>
            {workspaceNav.filter(t => ['models', 'domain'].includes(t.id)).map((tab) => {
              const status = completionStatus[tab.id as keyof typeof completionStatus];
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all ${
                    activeTab === tab.id
                      ? 'bg-white/90 text-[var(--rf-brand)] shadow-sm border border-[rgba(43,89,74,0.10)]'
                      : 'text-[var(--rf-text-tertiary)] border border-transparent hover:bg-white/50 hover:text-[var(--rf-text-secondary)]'
                  }`}
                >
                  <tab.icon className={`w-3.5 h-3.5 shrink-0 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                  <span className={`flex-1 text-[13px] font-semibold leading-tight text-left ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</span>
                  {status === 'complete' && (
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--rf-success)]" title="Configured" />
                  )}
                  {status === 'warning' && (
                    <span className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--rf-warning)]" title="Needs attention" />
                  )}
                </button>
              );
            })}

            {/* Group: Admin */}
            <div className="px-2.5 pb-1 pt-3">
              <span className="text-[10px] font-black uppercase tracking-[0.16em] text-[var(--rf-text-tertiary)] opacity-60">Admin</span>
            </div>
            {workspaceNav.filter(t => ['stats', 'billing', 'compliance'].includes(t.id)).map((tab) => (
              <button
                key={tab.id}
                disabled={tab.id === 'compliance'}
                onClick={() => setActiveTab(tab.id as any)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all ${
                  activeTab === tab.id
                    ? 'bg-white/90 text-[var(--rf-brand)] shadow-sm border border-[rgba(43,89,74,0.10)]'
                    : 'text-[var(--rf-text-tertiary)] border border-transparent hover:bg-white/50 hover:text-[var(--rf-text-secondary)]'
                } ${tab.id === 'compliance' ? 'opacity-50 cursor-not-allowed filter grayscale' : ''}`}
              >
                <tab.icon className={`w-3.5 h-3.5 shrink-0 ${activeTab === tab.id ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text-tertiary)]'}`} />
                <div className="flex flex-col text-left flex-1">
                  <span className={`text-[13px] font-semibold leading-tight ${activeTab === tab.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{tab.label}</span>
                  {tab.id === 'compliance' && <span className="text-[10px] font-bold text-[var(--rf-brand)] uppercase tracking-tighter mt-0.5">Coming Soon</span>}
                </div>
              </button>
            ))}

            <div className="mt-auto pt-3 border-t border-[rgba(43,89,74,0.08)]">
              <div className="px-2.5 py-2 space-y-0.5">
                <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                  {isHostedSampler ? 'hosted trial' : tier}
                </div>
                <div className="text-[12px] text-[var(--rf-text-tertiary)]">
                  {usage?.currentMonth ?? 0}<span className="text-[var(--rf-border-strong)]">/</span>{limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0} {isHostedSampler ? 'preview credits' : 'included'}
                </div>
              </div>
            </div>
          </div>
          )}

          <div className="flex-1 overflow-y-auto p-5 custom-scrollbar bg-transparent">
            {activeSurface === 'workspace' && activeTab === 'models' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                {/* Quick Setup banner — dismissable, shown until key steps are done */}
                {!setupBannerDismissed && (completionStatus.models !== 'complete' || completionStatus.jira !== 'complete' || completionStatus.domain !== 'complete') && isAdmin && (
                  <motion.div
                    className="relative rounded-2xl border border-[rgba(43,89,74,0.18)] bg-[rgba(43,89,74,0.05)] px-4 py-3.5"
                    initial={{ opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSetupBannerDismissed(true);
                        try { localStorage.setItem('rf_setup_banner_dismissed', '1'); } catch {}
                      }}
                      className="absolute top-3 right-3 p-1 rounded-lg text-[var(--rf-text-tertiary)] hover:bg-white/70 hover:text-[var(--rf-text)] transition-all"
                      title="Dismiss"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                    <div className="text-[11px] font-black uppercase tracking-[0.14em] text-[var(--rf-brand)] mb-2">Quick Setup</div>
                    <div className="text-[12px] text-[var(--rf-text-secondary)] mb-3 leading-relaxed">Complete these steps for the best results.</div>
                    <div className="space-y-1.5">
                      {[
                        { key: 'models' as const, label: 'Set your LLM provider and API key', tab: 'models' as const },
                        { key: 'jira' as const, label: 'Configure a project in Project Setup', tab: 'jira' as const },
                        { key: 'domain' as const, label: 'Add domain context and team guidance', tab: 'domain' as const },
                      ].map((step, idx) => {
                        const done = completionStatus[step.key] === 'complete';
                        return (
                          <button
                            key={step.key}
                            type="button"
                            onClick={() => {
                              if (step.tab === 'jira') {
                                setActiveSurface('project');
                                return;
                              }
                              setActiveTab(step.tab);
                            }}
                            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2 text-left transition-all ${done ? 'opacity-60' : 'hover:bg-white/70'}`}
                          >
                            <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black border ${done ? 'bg-[var(--rf-success)] border-[var(--rf-success)] text-white' : 'border-[rgba(43,89,74,0.25)] bg-white/70 text-[var(--rf-brand)]'}`}>
                              {done ? <Check className="h-3 w-3" /> : idx + 1}
                            </div>
                            <span className={`flex-1 text-[12px] font-medium leading-tight ${done ? 'line-through text-[var(--rf-text-tertiary)]' : 'text-[var(--rf-text-secondary)]'}`}>
                              {step.label}
                            </span>
                            {!done && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--rf-text-tertiary)]" />}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}

                {/* Provider + API key */}
                <div className="rf-card p-5 space-y-4">
                  <div className="space-y-2">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">LLM Provider</div>
                    <div className="flex p-0.5 bg-[var(--rf-surface-soft)] rounded-lg border border-[var(--rf-border)]">
                      {(['anthropic', 'openai', 'fireworks', 'azure_openai', 'gemini', 'ollama', 'groq'] as const).map(p => (
                        <button key={p} onClick={() => setProvider(p)} className={`flex-1 py-1.5 text-[12px] font-bold uppercase tracking-wide rounded-md transition-all ${provider === p ? 'bg-white text-[var(--rf-brand)] shadow-sm border border-[var(--rf-border)]/50' : 'text-[var(--rf-text-tertiary)] hover:text-[var(--rf-text-secondary)]'}`}>
                          {getProviderLabel(p)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {provider === 'anthropic' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Anthropic API Key</label>
                          {existingAnthropicApiKey && <button onClick={() => { setExistingAnthropicApiKey(''); setAnthropicApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={anthropicApiKey} onChange={e => setAnthropicApiKey(e.target.value)} placeholder={existingAnthropicApiKey ? '••••••••• (stored)' : 'sk-ant-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Custom Base URL</label>
                        <input type="text" value={anthropicBaseUrl} onChange={e => setAnthropicBaseUrl(e.target.value)} placeholder="https://api.anthropic.com/v1" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                    </motion.div>
                  )}

                  {provider === 'openai' && (
                    <motion.div className="space-y-1.5" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">OpenAI API Key</label>
                        {existingOpenaiApiKey && <button onClick={() => { setExistingOpenaiApiKey(''); setOpenaiApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                      </div>
                      <input type="password" value={openaiApiKey} onChange={e => setOpenaiApiKey(e.target.value)} placeholder={existingOpenaiApiKey ? '••••••••• (stored)' : 'sk-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}

                  {provider === 'fireworks' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[12px] text-[var(--rf-text-secondary)]">
                        Fireworks uses an OpenAI-style API, but it is configured here as a first-class vendor. Default base URL: <span className="font-semibold text-[var(--rf-text)]">{FIREWORKS_BASE_URL}</span>
                      </div>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">API Key</label>
                          {existingFireworksApiKey && <button onClick={() => { setExistingFireworksApiKey(''); setFireworksApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={fireworksApiKey} onChange={e => setFireworksApiKey(e.target.value)} placeholder={existingFireworksApiKey ? '••••••••• (stored)' : 'Paste Fireworks key'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Base URL</label>
                        <input type="text" value={fireworksBaseUrl} onChange={e => setFireworksBaseUrl(e.target.value)} placeholder={FIREWORKS_BASE_URL} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Manual Model IDs</label>
                        <textarea
                          value={fireworksManualModels}
                          onChange={e => setFireworksManualModels(e.target.value)}
                          placeholder={`accounts/fireworks/models/deepseek-v3p1\naccounts/fireworks/models/llama-v3p1-8b-instruct`}
                          disabled={!isAdmin}
                          rows={4}
                          className="w-full resize-y bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none"
                        />
                        <div className="text-[12px] text-[var(--rf-text-tertiary)]">
                          Enter one model per line. Manual IDs stay available even if provider discovery is incomplete.
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {provider === 'azure_openai' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Azure OpenAI API Key</label>
                          {existingAzureOpenAIApiKey && <button onClick={() => { setExistingAzureOpenAIApiKey(''); setAzureOpenAIApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={azureOpenAIApiKey} onChange={e => setAzureOpenAIApiKey(e.target.value)} placeholder={existingAzureOpenAIApiKey ? '••••••••• (stored)' : 'Azure key'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Endpoint</label>
                          <input type="text" value={azureOpenAIBaseUrl} onChange={e => setAzureOpenAIBaseUrl(e.target.value)} placeholder="https://…openai.azure.com" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">API Version</label>
                          <input type="text" value={azureOpenAIApiVersion} onChange={e => setAzureOpenAIApiVersion(e.target.value)} placeholder="2024-06-01" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                        </div>
                      </div>
                    </motion.div>
                  )}

                  {provider === 'gemini' && (
                    <motion.div className="space-y-1.5" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="flex justify-between items-center">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Gemini API Key</label>
                        {existingGeminiApiKey && <button onClick={() => { setExistingGeminiApiKey(''); setGeminiApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                      </div>
                      <input type="password" value={geminiApiKey} onChange={e => setGeminiApiKey(e.target.value)} placeholder={existingGeminiApiKey ? '••••••••• (stored)' : 'AIza…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                    </motion.div>
                  )}

                  {provider === 'ollama' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Ollama API Key</label>
                          {existingOllamaApiKey && <button onClick={() => { setExistingOllamaApiKey(''); setOllamaApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={ollamaApiKey} onChange={e => setOllamaApiKey(e.target.value)} placeholder={existingOllamaApiKey ? '••••••••• (stored)' : 'ollama-…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Base URL (optional)</label>
                        <input type="text" value={ollamaBaseUrl} onChange={e => setOllamaBaseUrl(e.target.value)} placeholder="https://ollama.com/v1" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                    </motion.div>
                  )}

                  {provider === 'groq' && (
                    <motion.div className="space-y-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}>
                      <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                          <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Groq API Key</label>
                          {existingGroqApiKey && <button onClick={() => { setExistingGroqApiKey(''); setGroqApiKey(''); }} className="text-[12px] font-bold text-[var(--rf-danger)]">Clear</button>}
                        </div>
                        <input type="password" value={groqApiKey} onChange={e => setGroqApiKey(e.target.value)} placeholder={existingGroqApiKey ? '••••••••• (stored)' : 'gsk_…'} disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Base URL (optional)</label>
                        <input type="text" value={groqBaseUrl} onChange={e => setGroqBaseUrl(e.target.value)} placeholder="https://api.groq.com/openai/v1" disabled={!isAdmin} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none" />
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Model assignments */}
                <div className="rf-card p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Model assignments</div>
                    <div className="flex items-center gap-3">
                      {modelCatalogError && <span className="text-[12px] font-semibold text-[var(--rf-danger)]">{modelCatalogError}</span>}
                      <span className="text-[12px] text-[var(--rf-text-tertiary)]">
                        {effectiveModelCatalogs[provider]?.models?.length ? `${effectiveModelCatalogs[provider]?.models?.length} models` : 'bundled catalog'}
                      </span>
                      <motion.button
                        onClick={refreshModelCatalog}
                        disabled={isRefreshingModels || !isAdmin}
                        className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-2.5 py-1 rounded-lg disabled:opacity-40 transition hover:bg-white"
                        whileTap={{ scale: 0.97 }}
                      >
                        <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} /> Refresh
                      </motion.button>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Story Assistant Models</div>
                    <p className="text-[12px] text-[var(--rf-text-tertiary)] leading-relaxed">
                      Fast uses the light model for all stages. Balanced uses light for Clarify, heavy for Decomposition + ARs. Quality uses heavy throughout.
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {[
                      {
                        key: 'lightModel' as const,
                        label: 'Light Model',
                        description: 'Fast (all stages) · Balanced Clarify',
                        value: storyAssistantAssignments.lightModel,
                      },
                      {
                        key: 'heavyModel' as const,
                        label: 'Heavy Model',
                        description: 'Balanced Decomp + ARs · Quality (all stages)',
                        value: storyAssistantAssignments.heavyModel,
                      },
                    ].map((item) => (
                      <div key={item.key} className="space-y-1.5">
                        <div>
                          <div className="text-[12px] font-semibold text-[var(--rf-text)]">{item.label}</div>
                          <div className="text-[11px] text-[var(--rf-text-tertiary)]">{item.description}</div>
                        </div>
                        <div className="relative">
                          <select
                            value={item.value}
                            disabled={availableModels.length === 0 || !isAdmin}
                            onChange={(event) => {
                              const nextValue = event.target.value;
                              setStoryAssistantModelAssignments((prev) => ({
                                ...prev,
                                [provider]: {
                                  ...(prev[provider] ?? {}),
                                  [item.key]: nextValue,
                                },
                              }));
                            }}
                            className="appearance-none pr-7 w-full bg-white border border-[var(--rf-border)] rounded-lg px-3 py-2 text-[13px] font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition disabled:opacity-60"
                          >
                            {availableModels.map((model) => (
                              <option key={`${item.key}-${model.id}`} value={model.id}>{model.label}</option>
                            ))}
                          </select>
                          <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--rf-sidebar-text-muted)] pointer-events-none" />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="pt-1 border-t border-[var(--rf-border-subtle)] space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Other Models</div>
                    {[
                      { field: 'refineModel' as const, label: 'Refinement', description: 'Interactive edits on existing features' },
                      { field: 'themeModel' as const, label: 'Theme Analysis', description: 'Tagging, titles, and support analysis' },
                    ].map((item) => (
                      <div key={item.field} className="flex items-center justify-between gap-4">
                        <div>
                          <div className="text-[13px] font-semibold text-[var(--rf-text)]">{item.label}</div>
                          <div className="text-[11px] text-[var(--rf-text-tertiary)]">{item.description}</div>
                        </div>
                        <div className="relative w-[200px] shrink-0">
                          <select
                            value={roleModelValues[item.field]}
                            disabled={availableModels.length === 0 || !isAdmin}
                            onChange={e => roleModelSetters[item.field](e.target.value)}
                            className="appearance-none pr-7 w-full bg-white border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-[13px] font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition disabled:opacity-60"
                          >
                            {availableModels.length === 0 ? <option>Select provider…</option> : availableModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                          </select>
                          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--rf-text-tertiary)] pointer-events-none" />
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="pt-2 border-t border-[var(--rf-border-subtle)] flex items-center gap-3">
                    <motion.button
                      onClick={testLlmConnection}
                      disabled={isTestingLlm}
                      className="flex items-center gap-1.5 text-[13px] font-bold text-[var(--rf-text-secondary)] bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-3 py-1.5 rounded-lg transition hover:bg-white disabled:opacity-50"
                      whileTap={{ scale: 0.97 }}
                    >
                      {isTestingLlm ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} Test connection
                    </motion.button>
                    {llmTestResult && (
                      <span className={`text-[13px] font-bold flex items-center gap-1.5 ${llmTestResult.ok ? 'text-[var(--rf-success)]' : 'text-[var(--rf-danger)]'}`}>
                        {llmTestResult.ok ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />} {llmTestResult.message}
                      </span>
                    )}
                  </div>
                </div>

                {isAdmin && (
                  <div className="rf-card p-5 space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Developer tools</div>
                    <p className="text-[12px] text-[var(--rf-text-tertiary)] leading-relaxed">
                      When enabled, users can optionally record a full prompt and LLM trace for one end-to-end run (discovery through generation) and export JSON for external review. Uses Forge storage; use only for prompt QA.
                    </p>
                    <label className="flex items-start gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pipelineAuditEnabled}
                        onChange={(e) => setPipelineAuditEnabled(e.target.checked)}
                        className="mt-0.5 rounded border-[var(--rf-border)]"
                      />
                      <span className="text-[13px] font-semibold text-[var(--rf-text)]">Allow pipeline audit recording</span>
                    </label>
                  </div>
                )}
              </motion.div>
            )}

            {activeSurface === 'project' && (
              <ProjectSetupSurface
                projects={projects}
                projectOptions={projectOptions}
                customFields={customFields}
                isDiscovering={isDiscovering}
                onDiscoverJira={discoverJira}
                activeArProj={activeArProj}
                setActiveArProj={setActiveArProj}
                arMappings={arMappings}
                setArMappings={setArMappings}
                domainContexts={domainContexts}
                setDomainContexts={setDomainContexts}
                backlogStatusScopes={backlogStatusScopes}
                setBacklogStatusScopes={setBacklogStatusScopes}
                backlogStatusOptions={backlogStatusOptions}
                detectDefaultStatuses={detectDefaultStatuses}
                backlogCacheInfo={backlogCacheInfo}
                backlogDiagnostics={backlogDiagnostics}
                backlogRefreshStatus={backlogRefreshStatus}
                isRefreshingBacklogCache={isRefreshingBacklogCache}
                onRefreshBacklogCache={handleRefreshBacklogCache}
                backlogThemeBudgetOverride={backlogThemeBudgetOverride}
                onBacklogThemeBudgetOverrideChange={setBacklogThemeBudgetOverride}
                goldExampleConfigs={goldExampleConfigs}
                setGoldExampleConfigs={setGoldExampleConfigs}
                goldStoryPool={goldStoryPool}
                wiDocs={wiDocs}
                wiUploadState={wiUploadState}
                wiUploadError={wiUploadError}
                wiUploadCopy={wiUploadCopy}
                onUploadWi={() => wiFileInputRef.current?.click()}
                onDismissWiUploadError={() => setWiUploadError(null)}
                onRemoveWiDoc={handleRemoveWiDoc}
                canManageProjectSettings={projectCapabilities.canManageProjectSettings}
                canManageWi={projectCapabilities.canManageWi}
                canManageGoldExamples={projectCapabilities.canManageGoldExamples}
                canManageMapping={projectCapabilities.canManageMapping}
                isAdmin={Boolean(isAdmin)}
                isProjectAdmin={activeProjAdmin}
              />
            )}

            {activeSurface === 'workspace' && activeTab === 'domain' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-5 space-y-5">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Default project</div>
                    <div className="text-[13px] text-[var(--rf-text-tertiary)] mt-1">Choose the project that should be preselected for you when opening the generator.</div>
                  </div>
                  <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-1">
                      <div className="text-sm font-bold text-[var(--rf-text)]">Personal default project</div>
                      <div className="text-[12px] text-[var(--rf-text-tertiary)]">Stored per user, so each teammate can keep their own starting project.</div>
                    </div>
                    <SearchableSelect
                      value={defaultProjectKey}
                      onChange={setDefaultProjectKey}
                      options={projectOptions}
                      placeholder="No default — choose each time"
                      searchPlaceholder="Search projects..."
                      allowClear
                      clearLabel="Clear default project"
                      className="w-full md:w-72"
                      buttonClassName="bg-white"
                    />
                  </div>
                </div>

              </motion.div>
            )}

            {activeSurface === 'workspace' && activeTab === 'stats' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Generations', value: usage?.currentMonth ?? 0, helper: isHostedSampler ? 'hosted trial this month' : 'this month' },
                    { label: 'Tokens', value: workspaceTokenUsage.toLocaleString(), helper: 'tracked' },
                    { label: 'Projects', value: projectUsageBreakdown.length, helper: 'with activity' },
                    { label: 'Records', value: complianceEvents.length + transparencyReports.length, helper: 'audit + reports' },
                  ].map((card) => (
                    <div key={card.label} className="rf-card px-3 py-2.5">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                      <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{card.value}</div>
                      <div className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{card.helper}</div>
                    </div>
                  ))}
                </div>

                <div className="rf-card p-4 space-y-3">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Project activity</div>
                  {projectUsageBreakdown.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-4 text-sm font-medium text-[var(--rf-text-tertiary)] text-center">
                      No tracked project activity yet.
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-[var(--rf-border)]">
                      <table className="w-full text-left">
                        <thead className="bg-[var(--rf-surface-soft)]">
                          <tr className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                            <th className="px-3 py-2">Project</th>
                            <th className="px-3 py-2">Reports</th>
                            <th className="px-3 py-2">Tokens</th>
                            <th className="px-3 py-2 hidden sm:table-cell">Latest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectUsageBreakdown.map((project) => (
                            <tr key={project.projectKey} className="border-t border-[var(--rf-border)]">
                              <td className="px-3 py-2 text-sm font-bold text-[var(--rf-text)]">{project.projectKey}</td>
                              <td className="px-3 py-2 text-sm font-medium text-[var(--rf-text-secondary)]">{project.reportCount}</td>
                              <td className="px-3 py-2 text-sm font-medium text-[var(--rf-text-secondary)]">{project.tokenUsage.toLocaleString()}</td>
                              <td className="px-3 py-2 text-[13px] font-medium text-[var(--rf-text-tertiary)] hidden sm:table-cell">{project.latestAt ? new Date(project.latestAt).toLocaleString() : 'n/a'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {showComplianceTab && (
                  <button
                    onClick={() => setActiveTab('compliance')}
                    className="w-full rf-card p-4 flex items-center justify-between gap-3 text-left hover:border-[var(--rf-brand)] transition group"
                  >
                    <div className="flex items-center gap-3">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)]" />
                      <div>
                        <div className="text-sm font-bold text-[var(--rf-text)]">Compliance reports & audit trail</div>
                        <div className="text-[12px] text-[var(--rf-text-tertiary)]">{transparencyReports.length} transparency reports · {complianceEvents.length} audit events</div>
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-[var(--rf-text-tertiary)] group-hover:text-[var(--rf-brand)] transition" />
                  </button>
                )}
              </motion.div>
            )}

            {activeSurface === 'workspace' && activeTab === 'billing' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-4 flex items-center justify-between gap-6">
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Launch plan</div>
                    <div className="text-xl font-black text-[var(--rf-brand)] capitalize mt-0.5">{isHostedSampler ? 'free preview' : tier}</div>
                    <div className="text-[12px] text-[var(--rf-text-tertiary)] mt-1">
                      {isHostedSampler
                        ? 'This workspace is using free preview access: 3 fast, 2 balanced, and 1 quality generation per user per calendar month. Add your own provider key to continue after the preview credits are used.'
                        : 'Refinely is launching with a single paid Standard tier and a 30-day Marketplace trial.'}
                    </div>
                  </div>
                  <div className="flex-1 max-w-xs space-y-1.5">
                    <div className="flex justify-between text-[13px] font-semibold text-[var(--rf-text-secondary)]">
                      <span>{isHostedSampler ? 'Preview generations this month' : 'Included generations this month'}</span>
                      <span>{usage?.currentMonth ?? 0}<span className="text-[var(--rf-text-tertiary)] font-medium"> / {limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0}</span></span>
                    </div>
                    {limits?.generationsPerMonth !== -1 && (
                      <div className="w-full h-1.5 bg-[var(--rf-surface-soft)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--rf-brand)] transition-all duration-500 rounded-full"
                          style={{ width: usage ? `${Math.min(100, (usage.currentMonth / (limits?.generationsPerMonth || 1)) * 100)}%` : '0%' }}
                        />
                      </div>
                    )}
                  </div>
                </div>

                <div className="rf-card p-4 flex items-start justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                      {isHostedSampler ? 'Hosted trial exhausted?' : 'Need more headroom?'}
                    </div>
                    <div className="text-sm font-semibold text-[var(--rf-text)]">
                      {isHostedSampler
                        ? 'Connect your own Gemini, OpenAI, Anthropic, Azure OpenAI, or Ollama key in AI setup to keep generating after the 3/2/1 monthly preview credits are used.'
                        : 'Larger teams can contact support for a higher soft threshold and early access to advanced packaging.'}
                    </div>
                    <div className="text-[12px] text-[var(--rf-text-tertiary)]">
                      {isHostedSampler
                        ? 'Free preview credits are user-scoped and reset each calendar month. BYOK usage is not capped by these platform-funded preview credits.'
                        : 'We are keeping the launch offer simple, then expanding into larger-organization controls based on customer demand.'}
                    </div>
                  </div>
                  {isHostedSampler ? (
                    <div className="shrink-0 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[12px] font-bold text-[var(--rf-text)]">
                      Add provider key in AI setup
                    </div>
                  ) : (
                    <a
                      href="mailto:support@smartif.ai?subject=Refinely%20Advanced%20Tier%20Inquiry"
                      className="shrink-0 inline-flex items-center justify-center rounded-lg border border-[var(--rf-text)] bg-[var(--rf-text)] px-3 py-2 text-[12px] font-bold text-white transition hover:bg-black"
                    >
                      Contact support
                    </a>
                  )}
                </div>

                <div className="rf-card p-4 space-y-4">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Usage</div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Generations', value: usage?.currentMonth ?? 0, sub: isHostedSampler ? 'preview 3 fast / 2 balanced / 1 quality per month' : `included ${limits?.generationsPerMonth === -1 ? '∞' : limits?.generationsPerMonth ?? 0} before warning` },
                      { label: 'Tokens', value: workspaceTokenUsage.toLocaleString(), sub: 'approx.' },
                      { label: 'Projects', value: configuredProjectCount, sub: 'configured' },
                      { label: 'Records', value: transparencyReports.length + complianceEvents.length, sub: 'audit + transparency' },
                    ].map(card => (
                      <div key={card.label} className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                        <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{card.value}</div>
                        <div className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{card.sub}</div>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] px-3 py-2 bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">Per-project usage</div>
                    {projectUsageBreakdown.length ? (
                      <div className="divide-y divide-[var(--rf-border)] bg-white">
                        <div className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)]">
                          <div>Project</div><div className="text-right">Reports</div><div className="text-right">Tokens</div><div>Latest</div>
                        </div>
                        {projectUsageBreakdown.map(project => (
                          <div key={project.projectKey} className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-2 items-center">
                            <div className="text-sm font-bold text-[var(--rf-text)] truncate">{project.projectKey}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{project.reportCount}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{project.tokenUsage.toLocaleString()}</div>
                            <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{project.latestAt ? new Date(project.latestAt).toLocaleString() : 'n/a'}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="bg-white px-4 py-4 text-sm font-medium text-[var(--rf-text-tertiary)]">
                        No transparency reports have been loaded yet, so project-level usage cannot be approximated.
                      </div>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[
                    { key: 'standard', name: 'Standard', price: 'Marketplace launch tier', highlights: ['Full core workflow', 'Shared workspace setup', 'Soft monthly usage guidance'], cta: 'Included in trial', href: 'https://marketplace.atlassian.com' },
                    { key: 'advanced', name: 'Advanced', price: 'Later / contact us', highlights: ['Higher limits', 'Larger-team controls', 'Priority roadmap input'], cta: 'Talk to support', href: 'mailto:support@smartif.ai?subject=Refinely%20Advanced%20Tier%20Inquiry' },
                  ].map(plan => {
                    const isCurrent = plan.key === 'standard' && tier === 'standard';
                    return (
                      <div key={plan.key} className={`rounded-xl border bg-white p-4 flex flex-col shadow-sm transition-all ${isCurrent ? 'border-[var(--rf-brand)] shadow-sm shadow-[var(--rf-brand)]/10' : 'border-[var(--rf-border)] hover:border-[var(--rf-border-strong)]'}`}>
                        <div className="mb-3">
                          <div className="flex items-center justify-between gap-1">
                            <div className={`text-sm font-black ${isCurrent ? 'text-[var(--rf-brand)]' : 'text-[var(--rf-text)]'}`}>{plan.name}</div>
                            {isCurrent && <span className="bg-[var(--rf-brand-muted)] text-[var(--rf-brand)] text-[11px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded border border-[rgba(43,89,74,0.12)]">Active</span>}
                          </div>
                          <div className="text-[12px] text-[var(--rf-text-tertiary)] mt-0.5">{plan.price}</div>
                        </div>
                        <ul className="space-y-1.5 mb-4 flex-1">
                          {plan.highlights.map(item => (
                            <li key={item} className="text-[12px] font-medium text-[var(--rf-text-secondary)] flex items-start gap-1.5">
                              <Check className="w-3 h-3 text-[var(--rf-success)] shrink-0 mt-0.5" />
                              {item}
                            </li>
                          ))}
                        </ul>
                        <a
                          href={plan.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`mt-auto inline-flex w-full items-center justify-center rounded-lg border px-2 py-1.5 text-[12px] font-bold transition ${
                            isCurrent
                              ? 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-secondary)]'
                              : 'border-[var(--rf-text)] bg-[var(--rf-text)] text-white hover:bg-black'
                          }`}
                        >
                          {isCurrent ? 'Manage' : plan.cta}
                        </a>
                      </div>
                    );
                  })}
                </div>

                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Company branding</div>
                    <span className="text-[12px] font-bold px-2 py-0.5 rounded border bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)] border-[var(--rf-border)]">
                      Advanced later
                    </span>
                  </div>
                  <div className="flex gap-3 items-start">
                    <div className="flex-1 space-y-1.5">
                      <label className="text-[11px] font-bold text-[var(--rf-text-tertiary)] uppercase tracking-widest">Logo URL</label>
                      <input
                        value={brandingLogoUrl}
                        onChange={e => setBrandingLogoUrl(e.target.value)}
                        placeholder="https://example.com/logo.svg"
                        disabled
                        className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-sm font-medium focus:bg-white focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition-all outline-none disabled:opacity-60"
                      />
                    </div>
                    <div className="w-20 h-14 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] flex items-center justify-center shrink-0">
                      {brandingLogoUrl.trim() ? (
                        <img src={brandingLogoUrl.trim()} alt="Logo preview" className="max-h-12 max-w-full object-contain" />
                      ) : (
                        <Image className="w-5 h-5 text-[var(--rf-text-tertiary)]" />
                      )}
                    </div>
                  </div>
                </div>

                <div className="rf-card p-4 space-y-3 relative overflow-hidden group">
                  <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance</div>
                   
                  {/* Gating Overlay */}
                  <div className="absolute inset-0 z-20 bg-[var(--rf-surface-soft)]/60 backdrop-blur-[1px] flex flex-col items-center justify-center p-6 text-center transition-all group-hover:bg-[var(--rf-surface-soft)]/80 cursor-not-allowed">
                    <div className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-lg mb-3 border border-[var(--rf-border)]">
                      <ShieldCheck className="w-5 h-5 text-[var(--rf-brand)]" />
                    </div>
                    <div className="text-sm font-bold text-[var(--rf-text)]">Compliance controls</div>
                    <div className="text-[11px] font-bold text-[var(--rf-brand)] uppercase tracking-wider mt-1 bg-[var(--rf-brand-muted)] px-2 py-0.5 rounded border border-[rgba(43,89,74,0.1)]">Available in Advanced Edition</div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 opacity-20 pointer-events-none filter blur-[1px]">
                    {[
                      { key: 'enabled', label: 'Compliance mode', value: complianceEnabled, set: setComplianceEnabled },
                      { key: 'transparency', label: 'Transparency reports', value: transparencyEnabled, set: setTransparencyEnabled },
                      { key: 'pii', label: 'PII masking', value: piiMaskingEnabled, set: setPiiMaskingEnabled },
                      { key: 'audit', label: 'Immutable audit trail', value: auditTrailEnabled, set: setAuditTrailEnabled },
                    ].map(item => (
                      <label key={item.key} className="flex items-center justify-between rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2.5">
                        <span className="text-sm font-medium text-[var(--rf-text-secondary)]">{item.label}</span>
                        <input
                          type="checkbox"
                          checked={item.value}
                          readOnly
                          className="h-4 w-4 rounded border-[var(--rf-border-strong)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </motion.div>
            )}

            {activeSurface === 'workspace' && activeTab === 'compliance' && (
              <motion.div
                className="max-w-3xl space-y-4"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Compliance workspace</div>
                      <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">Visibility into masking, reports, and audit activity</div>
                      <p className="mt-1 text-[13px] text-[var(--rf-text-tertiary)]">
                        This section stays visible even before compliance is fully enabled so admins can see what is configured, what evidence exists, and what will start populating after the next run.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: 'Compliance', value: complianceEnabled },
                        { label: 'Transparency', value: transparencyEnabled },
                        { label: 'PII masking', value: piiMaskingEnabled },
                        { label: 'Audit trail', value: auditTrailEnabled },
                      ].map((item) => (
                        <span key={item.label} className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-widest ${item.value ? 'border-[rgba(43,89,74,0.16)] bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]' : 'border-[var(--rf-border)] bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]'}`}>
                          {item.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Summary cards */}
                {complianceSummary && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      {
                        label: 'AI Operations',
                        value: Object.values(complianceSummary.totalByTurnType).reduce((s, v) => s + v, 0),
                        sub: Object.entries(complianceSummary.totalByTurnType).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none',
                      },
                      {
                        label: 'PII Redactions',
                        value: Object.values(complianceSummary.piiRedactionsByType).reduce((s, v) => s + v, 0),
                        sub: Object.entries(complianceSummary.piiRedactionsByType).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'none',
                      },
                      {
                        label: 'Tokens Used',
                        value: complianceSummary.totalTokens.toLocaleString(),
                        sub: 'approximate total',
                      },
                      {
                        label: 'Top Model',
                        value: Object.entries(complianceSummary.modelUsage).sort((a, b) => b[1] - a[1])[0]?.[0]?.split('/').pop()?.slice(0, 16) ?? 'n/a',
                        sub: `${Object.entries(complianceSummary.modelUsage).sort((a, b) => b[1] - a[1])[0]?.[1] ?? 0} calls`,
                      },
                    ].map((card) => (
                      <div key={card.label} className="rf-card px-3 py-2.5">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{card.label}</div>
                        <div className="mt-1 text-lg font-black text-[var(--rf-text)] truncate">{card.value}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--rf-text-tertiary)] truncate">{card.sub}</div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="rf-card p-4 space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">PII masking proof</div>
                      <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">Preview how Refinely masks supported PII categories</div>
                    </div>
                    <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                      {piiPreviewResult.totalRedactions} redaction{piiPreviewResult.totalRedactions === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Sample input</div>
                      <textarea
                        value={piiPreviewInput}
                        onChange={(e) => setPiiPreviewInput(e.target.value)}
                        className="min-h-[160px] w-full rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Masked output</div>
                      <div className="min-h-[160px] rounded-xl border border-[var(--rf-border)] bg-white px-3 py-3 text-sm text-[var(--rf-text-secondary)] whitespace-pre-wrap">
                        {compactUiText(piiPreviewResult.text || 'Masked output will appear here.')}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(piiPreviewResult.byType).length > 0 ? Object.entries(piiPreviewResult.byType).map(([key, value]) => (
                      <span key={key} className="rounded-full border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-secondary)]">
                        {key}: {value}
                      </span>
                    )) : (
                      <span className="text-[13px] text-[var(--rf-text-tertiary)]">No supported PII types detected in the current sample.</span>
                    )}
                  </div>
                  <p className="text-[12px] text-[var(--rf-text-tertiary)]">
                    Current masking coverage includes email, phone numbers, IBANs, payment cards, and SSNs. Use the transparency reports below for per-run evidence once new runs are executed.
                  </p>
                </div>

                {/* Transparency Reports */}
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Transparency reports ({transparencyReports.length})</div>
                    <div className="flex items-center gap-2">
                      <Filter className="w-3 h-3 text-[var(--rf-text-tertiary)]" />
                      <select value={reportFilterTurnType} onChange={e => setReportFilterTurnType(e.target.value)} className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        <option value="">All actions</option>
                        {(['generate', 'clarify', 'refine', 'ask'] as const).map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                      <select value={reportFilterProject} onChange={e => setReportFilterProject(e.target.value)} className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        <option value="">All projects</option>
                        {[...new Set(transparencyReports.map(r => r.projectKey || 'Workspace'))].map(pk => <option key={pk} value={pk}>{pk}</option>)}
                      </select>
                    </div>
                  </div>
                  {(() => {
                    const filtered = transparencyReports.filter(r => {
                      if (reportFilterTurnType && r.turnType !== reportFilterTurnType) return false;
                      if (reportFilterProject && (r.projectKey || 'Workspace') !== reportFilterProject) return false;
                      return true;
                    });
                    if (filtered.length === 0) return <div className="text-sm text-[var(--rf-text-tertiary)]">No reports match the current filters.</div>;
                    return (
                      <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                        <div className="grid grid-cols-[minmax(0,1fr)_70px_80px_60px_50px] gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">
                          <div>Date</div><div>Action</div><div>Project</div><div className="text-right">Tokens</div><div className="text-right">PII</div>
                        </div>
                        <div className="divide-y divide-[var(--rf-border)] bg-white max-h-80 overflow-y-auto">
                          {filtered.map(report => (
                            <div key={report.reportId}>
                              <button
                                className="w-full grid grid-cols-[minmax(0,1fr)_70px_80px_60px_50px] gap-2 px-3 py-2 text-left hover:bg-[var(--rf-surface-soft)] transition items-center"
                                onClick={() => setExpandedReportId(expandedReportId === report.reportId ? null : report.reportId)}
                              >
                                <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{new Date(report.createdAt).toLocaleString()}</div>
                                <div className="text-[12px] font-bold text-[var(--rf-text)] uppercase">{report.turnType}</div>
                                <div className="text-[12px] text-[var(--rf-text-secondary)] truncate">{report.projectKey || 'Workspace'}</div>
                                <div className="text-[12px] text-right text-[var(--rf-text-secondary)]">{(report.tokenUsage?.total ?? 0).toLocaleString()}</div>
                                <div className="text-[12px] text-right text-[var(--rf-text-secondary)]">{report.piiMasking?.totalRedactions ?? 0}</div>
                              </button>
                              {expandedReportId === report.reportId && (
                                <div className="px-4 pb-3 pt-1 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] space-y-2">
                                  {report.model && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Model: <span className="font-semibold text-[var(--rf-text)]">{report.model}</span>{report.provider ? ` (${report.provider})` : ''}</div>}
                                  {report.requirementExcerpt && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Requirement: <span className="italic">{report.requirementExcerpt}</span></div>}
                                  {report.decisionSummary?.length > 0 && (
                                    <div>
                                      <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] mb-1">Decisions</div>
                                      <ul className="space-y-0.5">
                                        {report.decisionSummary.map((d, i) => <li key={i} className="text-[12px] text-[var(--rf-text-secondary)] flex gap-1.5"><span className="text-[var(--rf-brand)] mt-0.5">·</span>{d}</li>)}
                                      </ul>
                                    </div>
                                  )}
                                  {report.piiMasking?.byType && Object.keys(report.piiMasking.byType).length > 0 && (
                                    <div className="text-[12px] text-[var(--rf-text-tertiary)]">PII by type: {Object.entries(report.piiMasking.byType).map(([k, v]) => `${k}: ${v}`).join(', ')}</div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>

                {/* Audit Trail */}
                <div className="rf-card p-4 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Audit trail ({complianceEvents.length})</div>
                    <div className="flex items-center gap-2">
                      <select value={auditCategoryFilter} onChange={e => setAuditCategoryFilter(e.target.value as any)} className="appearance-none rounded border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-1 text-[12px] font-medium text-[var(--rf-text)] outline-none">
                        {(['runtime', 'config', 'security', 'prompt', 'all'] as const).map(category => (
                          <option key={category} value={category}>{category === 'all' ? 'All categories' : category}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setShowAllAuditEvents(prev => !prev)}
                        className="rounded border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-2 py-1 text-[12px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-white"
                      >
                        {showAllAuditEvents ? 'Refinely only' : 'Show all events'}
                      </button>
                    </div>
                  </div>
                  {complianceEvents.length === 0 ? (
                    <div className="text-sm text-[var(--rf-text-tertiary)]">No audit events yet. Enable the immutable audit trail in the Billing tab.</div>
                  ) : (
                    <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                      <div className="grid grid-cols-[minmax(0,1.2fr)_70px_minmax(0,1fr)_40px] gap-2 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)] border-b border-[var(--rf-border)]">
                        <div>Timestamp</div><div>Category</div><div>Action</div><div className="text-center">Chain</div>
                      </div>
                      <div className="divide-y divide-[var(--rf-border)] bg-white max-h-80 overflow-y-auto">
                        {complianceEvents
                          .filter((event) => showAllAuditEvents || event.category === 'runtime')
                          .filter((event) => auditCategoryFilter === 'all' || event.category === auditCategoryFilter)
                          .map(event => (
                          <div key={event.eventId}>
                            <button
                              className="w-full grid grid-cols-[minmax(0,1.2fr)_70px_minmax(0,1fr)_40px] gap-2 px-3 py-2 text-left hover:bg-[var(--rf-surface-soft)] transition items-center"
                              onClick={() => setExpandedAuditId(expandedAuditId === event.eventId ? null : event.eventId)}
                            >
                              <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{new Date(event.timestamp).toLocaleString()}</div>
                              <div className="text-[12px] font-bold uppercase text-[var(--rf-text-secondary)]">{event.category}</div>
                              <div className="text-[12px] text-[var(--rf-text)] truncate">{event.action.replace(/_/g, ' ').toLowerCase()}</div>
                              <div className="text-center" title={event.hash ? 'Hash present' : 'No hash'}>
                                {event.hash ? <Check className="w-3.5 h-3.5 text-[var(--rf-success)] mx-auto" /> : <AlertCircle className="w-3.5 h-3.5 text-[var(--rf-text-tertiary)] mx-auto" />}
                              </div>
                            </button>
                            {expandedAuditId === event.eventId && (
                              <div className="px-4 pb-3 pt-1 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] space-y-1.5">
                                {event.actorAccountId && <div className="text-[12px] text-[var(--rf-text-tertiary)]">Actor: <span className="font-mono text-[var(--rf-text)]">{event.actorAccountId.slice(0, 8)}…</span></div>}
                                {Object.keys(event.details ?? {}).length > 0 && (
                                  <div className="text-[12px] text-[var(--rf-text-tertiary)]">Details: {Object.entries(event.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>
                                )}
                                <div className="text-[11px] font-mono text-[var(--rf-text-tertiary)] truncate">hash: {event.hash}</div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="px-3 py-1.5 bg-[var(--rf-surface-soft)] border-t border-[var(--rf-border)] text-[11px] text-[var(--rf-text-tertiary)]">
                        Use the category filter to review runtime, config, security, or prompt events. Toggle “Show all events” to include non-runtime records.
                      </div>
                    </div>
                  )}
                </div>

                {/* Project breakdown */}
                {complianceSummary && complianceSummary.projectBreakdown.length > 0 && (
                  <div className="rf-card p-4 space-y-3">
                    <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Project breakdown</div>
                    <div className="rounded-xl border border-[var(--rf-border)] overflow-hidden">
                      <div className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] bg-[var(--rf-surface-soft)]">
                        <div>Project</div><div className="text-right">Ops</div><div className="text-right">Tokens</div><div>Latest</div>
                      </div>
                      <div className="divide-y divide-[var(--rf-border)] bg-white">
                        {complianceSummary.projectBreakdown.map(p => (
                          <div key={p.projectKey} className="grid grid-cols-[1fr_60px_80px_minmax(0,1fr)] gap-3 px-3 py-2 items-center">
                            <div className="text-sm font-bold text-[var(--rf-text)] truncate">{p.projectKey}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{p.count}</div>
                            <div className="text-sm text-[var(--rf-text-secondary)] text-right">{p.tokenUsage.toLocaleString()}</div>
                            <div className="text-[12px] text-[var(--rf-text-tertiary)] truncate">{p.latestAt ? new Date(p.latestAt).toLocaleString() : 'n/a'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </div>
      </div>
    </div>
  );
}

type ProjectSetupStep = 'backlog' | 'wi' | 'gold' | 'guidance' | 'mapping' | 'review';
type ProjectSetupMode = 'guided' | 'overview' | 'edit';

function ProjectWorkInstructionsPanel({
  activeArProj,
  wiDocs,
  wiUploadState,
  wiUploadError,
  wiUploadCopy,
  onUploadWi,
  onDismissWiUploadError,
  onRemoveWiDoc,
  canManageWi,
}: {
  activeArProj: string;
  wiDocs: WiDocRow[];
  wiUploadState: { filename: string; stage: 'reading' | 'uploading' | 'indexing' } | null;
  wiUploadError: string | null;
  wiUploadCopy: string | null;
  onUploadWi: () => void;
  onDismissWiUploadError: () => void;
  onRemoveWiDoc: (docId: string) => void | Promise<void>;
  canManageWi: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-[var(--rf-border)] bg-[rgba(248,246,240,0.7)] p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1.5">
            <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-brand)]">Work Instructions</div>
            <h4 className="text-lg font-bold text-[var(--rf-text)]">Keep project guidance close to the setup flow.</h4>
            <p className="max-w-2xl text-sm font-medium text-[var(--rf-text-tertiary)]">
              Link operating procedures, SOPs, or team playbooks so the generator can ground features in the real workflow.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 md:items-end">
            <button
              type="button"
              onClick={onUploadWi}
              disabled={!canManageWi || activeArProj === '*' || Boolean(wiUploadState)}
              className="rounded-xl bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50"
            >
              {wiUploadState ? 'Uploading...' : 'Add work instructions'}
            </button>
            <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
              {canManageWi ? 'Project admins can manage docs for this project.' : 'Only project admins can add or remove docs.'}
            </div>
          </div>
        </div>
      </div>

      {activeArProj === '*' ? (
        <div className="rounded-2xl border-2 border-dashed border-[var(--rf-border)] bg-white px-6 py-10 text-center text-sm font-medium text-[var(--rf-text-tertiary)]">
          Select a project first to manage its work instructions.
        </div>
      ) : (
        <>
          {(wiUploadState || wiUploadError) && (
            <div className={`rounded-2xl border p-4 ${wiUploadError ? 'border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]/50' : 'border-[var(--rf-brand-subtle)] bg-[var(--rf-brand-muted)]'}`}>
              {wiUploadState && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Upload In Progress</div>
                      <div className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadState.filename}</div>
                    </div>
                    <div className="inline-flex items-center gap-2 text-[var(--rf-brand)] text-xs font-bold">
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      {wiUploadCopy}
                    </div>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-[rgba(43,89,74,0.12)]">
                    <div className="h-full w-1/2 rounded-full bg-[var(--rf-brand)] animate-pulse" />
                  </div>
                </div>
              )}
              {wiUploadError && (
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-danger)]">Upload Failed</div>
                    <p className="mt-1 text-sm font-bold text-[var(--rf-text)]">{wiUploadError}</p>
                  </div>
                  <button type="button" onClick={onDismissWiUploadError} className="rounded-lg bg-white px-3 py-1.5 text-xs font-bold text-[var(--rf-danger)] border border-[var(--rf-danger-subtle)]">Dismiss</button>
                </div>
              )}
            </div>
          )}

          <div className="overflow-hidden rounded-2xl border border-[var(--rf-border)] bg-white">
            {wiDocs.length === 0 ? (
              <div className="m-4 rounded-2xl border-2 border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-6 py-10 text-center">
                <FileText className="mx-auto mb-3 h-9 w-9 text-[var(--rf-border-strong)]" />
                <p className="text-base font-bold text-[var(--rf-text)]">No work instructions linked yet.</p>
                <p className="mt-2 text-sm font-medium text-[var(--rf-text-tertiary)]">
                  Add a few high-signal documents your team actually follows. You can revisit this any time from the project overview.
                </p>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-[minmax(0,1fr)_90px_140px_72px] gap-3 border-b border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                  <div>Document</div>
                  <div>Chunks</div>
                  <div>Uploaded</div>
                  <div className="text-right">Action</div>
                </div>
                {wiDocs.map((doc) => (
                  <div key={doc.docId} className="grid grid-cols-[minmax(0,1fr)_90px_140px_72px] gap-3 border-b border-[var(--rf-border-subtle)] px-4 py-3 last:border-b-0">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--rf-text)]">{doc.filename}</p>
                      <p className="mt-0.5 text-[12px] text-[var(--rf-text-tertiary)]">{doc.revision}</p>
                    </div>
                    <div className="text-sm font-medium text-[var(--rf-text-secondary)]">{doc.chunkCount}</div>
                    <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">{new Date(doc.uploadedAt).toLocaleDateString()}</div>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => onRemoveWiDoc(doc.docId)}
                        disabled={!canManageWi}
                        className="rounded-lg p-2 text-[var(--rf-text-tertiary)] transition-colors hover:bg-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)] disabled:opacity-40"
                        title={canManageWi ? 'Remove work instruction' : 'Project admin only'}
                      >
                        <Trash className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ProjectSetupSurface({
  projects,
  projectOptions,
  customFields,
  isDiscovering,
  onDiscoverJira,
  activeArProj,
  setActiveArProj,
  arMappings,
  setArMappings,
  domainContexts,
  setDomainContexts,
  backlogStatusScopes,
  setBacklogStatusScopes,
  backlogStatusOptions,
  detectDefaultStatuses,
  backlogCacheInfo,
  backlogDiagnostics,
  backlogRefreshStatus,
  isRefreshingBacklogCache,
  onRefreshBacklogCache,
  backlogThemeBudgetOverride,
  onBacklogThemeBudgetOverrideChange,
  goldExampleConfigs,
  setGoldExampleConfigs,
  goldStoryPool,
  wiDocs,
  wiUploadState,
  wiUploadError,
  wiUploadCopy,
  onUploadWi,
  onDismissWiUploadError,
  onRemoveWiDoc,
  canManageProjectSettings,
  canManageWi,
  canManageGoldExamples,
  canManageMapping,
  isAdmin,
  isProjectAdmin,
}: {
  projects: JiraProject[];
  projectOptions: SearchableSelectOption[];
  customFields: JiraField[];
  isDiscovering: boolean;
  onDiscoverJira: () => void;
  activeArProj: string;
  setActiveArProj: (value: string) => void;
  arMappings: ProjectArMapping[];
  setArMappings: (value: ProjectArMapping[]) => void;
  domainContexts: ProjectDomainContextRow[];
  setDomainContexts: (value: ProjectDomainContextRow[]) => void;
  backlogStatusScopes: ProjectBacklogStatusScope[];
  setBacklogStatusScopes: (value: ProjectBacklogStatusScope[]) => void;
  backlogStatusOptions: JiraStatus[];
  detectDefaultStatuses: (statuses: JiraStatus[]) => string[];
  backlogCacheInfo: BacklogCacheInfoRow | null;
  backlogDiagnostics: BacklogDiagnostics | null;
  backlogRefreshStatus: BacklogRefreshStatusRow | null;
  isRefreshingBacklogCache: boolean;
  onRefreshBacklogCache: (projectKey?: string) => Promise<any>;
  backlogThemeBudgetOverride: string;
  onBacklogThemeBudgetOverrideChange: (value: string) => void;
  goldExampleConfigs: ProjectGoldExampleConfig[];
  setGoldExampleConfigs: (value: ProjectGoldExampleConfig[]) => void;
  goldStoryPool: Array<{ key: string; summary: string; score: number }>;
  wiDocs: WiDocRow[];
  wiUploadState: { filename: string; stage: 'reading' | 'uploading' | 'indexing' } | null;
  wiUploadError: string | null;
  wiUploadCopy: string | null;
  onUploadWi: () => void;
  onDismissWiUploadError: () => void;
  onRemoveWiDoc: (docId: string) => void | Promise<void>;
  canManageProjectSettings: boolean;
  canManageWi: boolean;
  canManageGoldExamples: boolean;
  canManageMapping: boolean;
  isAdmin: boolean;
  isProjectAdmin: boolean;
}) {
  const [mode, setMode] = useState<ProjectSetupMode>('guided');
  const [activeStep, setActiveStep] = useState<ProjectSetupStep>('backlog');

  const mappingConfigured = useMemo(() => {
    return arMappings.some((mapping) => (
      mapping.projectKey === activeArProj
      && (
        Boolean(mapping.consolidatedFieldId)
        || (mapping.iterativeFieldIds?.length ?? 0) > 0
        || (mapping.outputMappings?.arFieldIds?.length ?? 0) > 0
      )
    ));
  }, [arMappings, activeArProj]);

  const backlogConfigured = useMemo(() => {
    const scope = backlogStatusScopes.find((entry) => entry.projectKey === activeArProj);
    return Boolean((scope?.statuses?.length ?? 0) > 0 || (backlogCacheInfo?.issueCount ?? 0) > 0);
  }, [backlogStatusScopes, activeArProj, backlogCacheInfo]);

  const goldConfigured = useMemo(() => {
    const config = goldExampleConfigs.find((entry) => entry.projectKey === activeArProj);
    return Boolean((config?.issueKeys?.length ?? 0) > 0 || config?.label?.trim());
  }, [goldExampleConfigs, activeArProj]);

  const guidanceConfigured = useMemo(() => {
    const context = domainContexts.find((entry) => entry.projectKey === activeArProj);
    return Boolean(
      context?.context?.trim()
      || (context?.personaRoles ?? []).some((row) => row.role?.trim() || row.activities?.trim()),
    );
  }, [domainContexts, activeArProj]);

  const projectSetupComplete = backlogConfigured && mappingConfigured;
  const projectSelected = Boolean(activeArProj && activeArProj !== '*');

  useEffect(() => {
    if (!projectSelected) {
      setMode('guided');
      setActiveStep('backlog');
      return;
    }
    setMode(projectSetupComplete ? 'overview' : 'guided');
    setActiveStep(projectSetupComplete ? 'review' : 'backlog');
  }, [activeArProj, projectSelected, projectSetupComplete]);

  const steps: StepConfig[] = [
    { id: 'backlog', label: 'Backlog', description: 'Scope and cache readiness', required: true },
    { id: 'wi', label: 'Work Instructions', description: 'Operational guidance and SOPs' },
    { id: 'gold', label: 'Gold Examples', description: 'Reference stories that shape quality' },
    { id: 'guidance', label: 'Guidance', description: 'Project-specific context and roles' },
    { id: 'mapping', label: 'Field Mapping', description: 'Where generated ARs should go', required: true },
    { id: 'review', label: 'Review', description: 'Finish setup and verify the project' },
  ];

  const completedSteps = new Set<ProjectSetupStep>([
    ...(backlogConfigured ? ['backlog' as const] : []),
    ...(wiDocs.length > 0 ? ['wi' as const] : []),
    ...(goldConfigured ? ['gold' as const] : []),
    ...(guidanceConfigured ? ['guidance' as const] : []),
    ...(mappingConfigured ? ['mapping' as const] : []),
    ...(projectSetupComplete ? ['review' as const] : []),
  ]);

  return (
    <motion.div
      className="max-w-5xl space-y-5"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
    >
      <div className="rounded-[28px] border border-[rgba(43,89,74,0.12)] bg-[linear-gradient(135deg,rgba(248,246,240,0.96),rgba(255,255,255,0.92))] p-6 shadow-[0_20px_60px_rgba(43,89,74,0.06)]">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-brand)]">Project Setup</div>
            <div>
              <h3 className="text-[28px] font-black leading-tight text-[var(--rf-text)]">Make project setup feel like a guided handoff, not a manual.</h3>
              <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-[var(--rf-text-tertiary)]">
                Start with the guided setup once, then come back to the project overview whenever you need to update work instructions, examples, or field behavior.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${isAdmin ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'bg-[var(--rf-brand-muted)] text-[var(--rf-brand)]'}`}>
                {isAdmin ? 'Workspace admin access' : isProjectAdmin ? 'Project admin access' : 'Read only'}
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-[var(--rf-text-secondary)] border border-[var(--rf-border)]">
                {projects.length} projects discovered
              </span>
              <span className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-[var(--rf-text-secondary)] border border-[var(--rf-border)]">
                {customFields.length} Jira fields available
              </span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] xl:min-w-[420px]">
            <SearchableSelect
              value={activeArProj}
              onChange={(value) => setActiveArProj(value || '*')}
              options={projectOptions}
              placeholder="Select a project..."
              searchPlaceholder="Search projects..."
              allowClear
              clearLabel="Clear project"
              className="w-full"
              buttonClassName="bg-white"
            />
            <button
              type="button"
              onClick={onDiscoverJira}
              disabled={isDiscovering}
              className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2.5 text-[13px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-[var(--rf-surface-soft)] disabled:opacity-50"
            >
              {isDiscovering ? 'Syncing...' : 'Sync Jira'}
            </button>
          </div>
        </div>
      </div>

      {!projectSelected ? (
        <div className="rounded-[28px] border-2 border-dashed border-[var(--rf-border)] bg-white px-8 py-16 text-center">
          <Database className="mx-auto mb-4 h-12 w-12 text-[var(--rf-border-strong)]" />
          <h4 className="text-xl font-bold text-[var(--rf-text)]">Select a project to start guided setup</h4>
          <p className="mx-auto mt-3 max-w-md text-sm font-medium text-[var(--rf-text-tertiary)]">
            Once you choose a project, we’ll walk through backlog scope, work instructions, examples, guidance, and field mapping in one focused flow.
          </p>
        </div>
      ) : mode === 'overview' ? (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded-2xl border border-[var(--rf-border)] bg-white p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-brand)]">Project Overview</div>
              <h4 className="mt-1 text-xl font-bold text-[var(--rf-text)]">{activeArProj} is ready for fast updates.</h4>
              <p className="mt-2 text-sm font-medium text-[var(--rf-text-tertiary)]">
                Use these hubs to update the parts of setup people revisit often, without stepping through the entire wizard again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setMode('guided');
                setActiveStep('backlog');
              }}
              className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2.5 text-[13px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-white"
            >
              Run setup again
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {[
              {
                id: 'backlog' as ProjectSetupStep,
                label: 'Backlog scope',
                ready: backlogConfigured,
                helper: backlogConfigured
                  ? `${backlogCacheInfo?.issueCount ?? backlogDiagnostics?.matchingScopeIssues ?? 0} indexed backlog items in scope`
                  : 'Choose statuses and build backlog context',
              },
              {
                id: 'wi' as ProjectSetupStep,
                label: 'Work Instructions',
                ready: wiDocs.length > 0,
                helper: wiDocs.length > 0 ? `${wiDocs.length} linked document${wiDocs.length === 1 ? '' : 's'}` : 'No linked docs yet',
              },
              {
                id: 'gold' as ProjectSetupStep,
                label: 'Gold Examples',
                ready: goldConfigured,
                helper: goldConfigured ? 'Reference examples configured' : 'Still using automatic fallback only',
              },
              {
                id: 'guidance' as ProjectSetupStep,
                label: 'Guidance',
                ready: guidanceConfigured,
                helper: guidanceConfigured ? 'Project context and roles added' : 'No extra guidance yet',
              },
              {
                id: 'mapping' as ProjectSetupStep,
                label: 'Field Mapping',
                ready: mappingConfigured,
                helper: mappingConfigured ? 'Acceptance requirements have a destination field' : 'AR destination not configured yet',
              },
            ].map((card) => (
              <button
                key={card.id}
                type="button"
                onClick={() => {
                  setMode('edit');
                  setActiveStep(card.id);
                }}
                className="rounded-2xl border border-[var(--rf-border)] bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-[var(--rf-border-strong)] hover:shadow-lg"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[15px] font-bold text-[var(--rf-text)]">{card.label}</div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.14em] ${card.ready ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)]' : 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]'}`}>
                    {card.ready ? 'Ready' : 'Needs attention'}
                  </span>
                </div>
                <p className="mt-3 text-sm font-medium leading-relaxed text-[var(--rf-text-tertiary)]">{card.helper}</p>
                <div className="mt-4 text-[12px] font-bold uppercase tracking-[0.14em] text-[var(--rf-brand)]">Open quick edit</div>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-4">
            <div className="mb-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--rf-brand)]">
                  {mode === 'guided' ? 'Guided setup' : 'Quick edit'}
                </div>
                <div className="mt-1 text-sm font-medium text-[var(--rf-text-tertiary)]">
                  {mode === 'guided'
                    ? 'Move through the setup in order. Each step has one clear job.'
                    : 'You are editing one part of project setup. You can jump to another step at any time.'}
                </div>
              </div>
              {mode === 'edit' && (
                <button
                  type="button"
                  onClick={() => setMode('overview')}
                  className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2 text-[12px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-white"
                >
                  Back to project overview
                </button>
              )}
            </div>
            <StepIndicator
              steps={steps}
              activeStep={activeStep}
              completedSteps={completedSteps}
              onStepClick={(stepId: string) => setActiveStep(stepId as ProjectSetupStep)}
            />
          </div>

          <ProjectConfigurationManager
            projects={projects}
            customFields={customFields}
            arMappings={arMappings}
            setArMappings={setArMappings}
            domainContexts={domainContexts}
            setDomainContexts={setDomainContexts}
            backlogStatusScopes={backlogStatusScopes}
            setBacklogStatusScopes={setBacklogStatusScopes}
            backlogStatusOptions={backlogStatusOptions}
            detectDefaultStatuses={detectDefaultStatuses}
            activeArProj={activeArProj}
            isAdmin={isAdmin}
            isProjectAdmin={isProjectAdmin}
            backlogCacheInfo={backlogCacheInfo}
            backlogDiagnostics={backlogDiagnostics}
            backlogRefreshStatus={backlogRefreshStatus}
            isRefreshingBacklogCache={isRefreshingBacklogCache}
            onRefreshBacklogCache={onRefreshBacklogCache}
            backlogThemeBudgetOverride={backlogThemeBudgetOverride}
            onBacklogThemeBudgetOverrideChange={onBacklogThemeBudgetOverrideChange}
            goldExampleConfigs={goldExampleConfigs}
            setGoldExampleConfigs={setGoldExampleConfigs}
            goldStoryPool={goldStoryPool}
            activeStep={activeStep}
            onActiveStepChange={setActiveStep}
            mode={mode}
            onEnterOverview={() => setMode('overview')}
            projectSetupComplete={projectSetupComplete}
            wiDocs={wiDocs}
            wiUploadState={wiUploadState}
            wiUploadError={wiUploadError}
            wiUploadCopy={wiUploadCopy}
            onUploadWi={onUploadWi}
            onDismissWiUploadError={onDismissWiUploadError}
            onRemoveWiDoc={onRemoveWiDoc}
            canManageWi={canManageWi}
            canManageProjectSettings={canManageProjectSettings}
            canManageGoldExamples={canManageGoldExamples}
            canManageMapping={canManageMapping}
          />
        </div>
      )}
    </motion.div>
  );
}

function ProjectConfigurationManager({
  projects, customFields, arMappings, setArMappings, domainContexts, setDomainContexts,
  backlogStatusScopes, setBacklogStatusScopes, backlogStatusOptions, detectDefaultStatuses,
  activeArProj, isAdmin, isProjectAdmin,
  backlogCacheInfo, backlogDiagnostics, backlogRefreshStatus, isRefreshingBacklogCache, onRefreshBacklogCache,
  backlogThemeBudgetOverride, onBacklogThemeBudgetOverrideChange,
  goldExampleConfigs, setGoldExampleConfigs,
  goldStoryPool = [],
  activeStep,
  onActiveStepChange,
  mode,
  onEnterOverview,
  projectSetupComplete,
  wiDocs = [],
  wiUploadState = null,
  wiUploadError = null,
  wiUploadCopy = null,
  onUploadWi,
  onDismissWiUploadError,
  onRemoveWiDoc,
  canManageWi = false,
  canManageProjectSettings = false,
  canManageGoldExamples = false,
  canManageMapping = false,
}: any) {
const [issueTypes, setIssueTypes] = useState<any[]>([]);
  const [activeIssueType, setActiveIssueType] = useState<string>('*');
  const [isLoadingIssueTypes, setIsLoadingIssueTypes] = useState(false);

  useEffect(() => {
    let active = true;
    if (!activeArProj || activeArProj === '*') {
      setIssueTypes([]);
      setActiveIssueType('*');
      return;
    }
    setIsLoadingIssueTypes(true);
    api.discoverIssueTypes(activeArProj)
       .then((res: any) => {
         if(active) {
           setIssueTypes(res.issueTypes || []);
         }
       })
       .finally(() => { if(active) setIsLoadingIssueTypes(false); });
    return () => { active = false; };
  }, [activeArProj]);

  const currentMapping = useMemo(() => {
    const existing = arMappings.find((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    if (existing) return normalizeProjectArMapping(existing);
    
    const fallback = arMappings.find((m: any) => m.projectKey === activeArProj && (!m.issueType || m.issueType === '*'));
    return normalizeProjectArMapping({ ...(fallback || {}), projectKey: activeArProj, issueType: activeIssueType });
  }, [arMappings, activeArProj, activeIssueType]);

  const updateMapping = (p: any) => {
    const idx = arMappings.findIndex((m: any) => m.projectKey === activeArProj && ((m.issueType || '*') === activeIssueType));
    const upd = normalizeProjectArMapping({ ...currentMapping, ...p, projectKey: activeArProj, issueType: activeIssueType });
    if (idx >= 0) { const l = [...arMappings]; l[idx] = upd; setArMappings(l); }
    else setArMappings([...arMappings, upd]);
  };

  const projectFields = useMemo(() => {
    if (activeIssueType === '*') {
      const seen = new Set<string>();
      const all: any[] = [];
      issueTypes.forEach(it => {
        Object.values(it.fields || {}).forEach((f: any) => {
          if (!seen.has(f.id)) { seen.add(f.id); all.push(f); }
        });
      });
      return all.length > 0 ? all : customFields;
    } else {
      const it = issueTypes.find(t => t.id === activeIssueType);
      if (!it || !it.fields) return customFields;
      return Object.entries(it.fields).map(([key, val]: any) => ({
        id: key,
        name: val.name,
        custom: val.custom
      }));
    }
  }, [issueTypes, activeIssueType, customFields]);
  const currentContext = domainContexts.find((c: any) => c.projectKey === activeArProj) || { projectKey: activeArProj, context: '', personaRoles: [] };
  const currentPersonaRoles: RoleGuidanceRow[] = currentContext.personaRoles?.length
    ? currentContext.personaRoles
    : [{ role: '', activities: '' }];
  const currentBacklogScope = backlogStatusScopes.find((scope: any) => scope.projectKey === activeArProj) || { projectKey: activeArProj, statuses: [] };
  const currentGoldConfig = (goldExampleConfigs as ProjectGoldExampleConfig[]).find((entry) => entry.projectKey === activeArProj)
    || { projectKey: activeArProj, issueKeys: [], label: undefined };
  const currentGoldIssueKeys = useMemo(() => currentGoldConfig.issueKeys ?? [], [currentGoldConfig.issueKeys]);
  const currentGoldIssueKeysSignature = currentGoldIssueKeys.join('|');
  const effectiveBacklogStatuses = currentBacklogScope.statuses.length
    ? currentBacklogScope.statuses
    : detectDefaultStatuses(backlogStatusOptions);
  const indexedCount = useMemo(() => {
    if (backlogCacheInfo?.issueCount && backlogCacheInfo.issueCount > 0) return backlogCacheInfo.issueCount;
    if (backlogDiagnostics?.matchingScopeIssues !== undefined && backlogDiagnostics.matchingScopeIssues > 0) return backlogDiagnostics.matchingScopeIssues;
    if (backlogDiagnostics?.totalProjectIssues !== undefined && backlogDiagnostics.totalProjectIssues > 0) return backlogDiagnostics.totalProjectIssues;
    if (backlogCacheInfo?.issueCount !== undefined) return backlogCacheInfo.issueCount;
    if (backlogDiagnostics?.matchingScopeIssues !== undefined) return backlogDiagnostics.matchingScopeIssues;
    if (backlogDiagnostics?.totalProjectIssues !== undefined) return backlogDiagnostics.totalProjectIssues;
    return 0;
  }, [backlogCacheInfo, backlogDiagnostics]);
  const updateContext = (patch: Partial<ProjectDomainContextRow>) => {
    const idx = domainContexts.findIndex((c: any) => c.projectKey === activeArProj);
    const nextRoles = coerceRoleGuidanceRows(
      Array.isArray(patch.personaRoles) ? patch.personaRoles : (currentContext.personaRoles ?? []),
      { trimFields: false, includeBlankFallback: false },
    );
    const upd: ProjectDomainContextRow = {
      projectKey: activeArProj,
      context: String(patch.context ?? currentContext.context ?? ''),
      personaRoles: nextRoles,
    };
    if (idx >= 0) { const l = [...domainContexts]; l[idx] = upd; setDomainContexts(l); }
    else setDomainContexts([...domainContexts, upd]);
  };
  const updateBacklogStatuses = (nextStatuses: string[]) => {
    const normalized = [...new Set(nextStatuses.filter(Boolean))];
    const idx = backlogStatusScopes.findIndex((scope: any) => scope.projectKey === activeArProj);
    const updated = { projectKey: activeArProj, statuses: normalized };
    if (idx >= 0) {
      const next = [...backlogStatusScopes];
      next[idx] = updated;
      setBacklogStatusScopes(next);
    } else {
      setBacklogStatusScopes([...backlogStatusScopes, updated]);
    }
  };

  const [isSavingProject, setIsSavingProject] = useState(false);
  const [projectNotice, setProjectNotice] = useState<string | null>(null);
  const [isInferringPersonaRoles, setIsInferringPersonaRoles] = useState(false);
  const [isSearchingGoldCandidates, setIsSearchingGoldCandidates] = useState(false);
  const [isSavingGoldConfig, setIsSavingGoldConfig] = useState(false);
  const [goldCandidateQuery, setGoldCandidateQuery] = useState('');
  const [goldCandidateResults, setGoldCandidateResults] = useState<Array<{ key: string; summary: string; score: number }>>([]);
  const [selectedGoldKeys, setSelectedGoldKeys] = useState<string[]>([]);
  const [goldLabelDraft, setGoldLabelDraft] = useState('');
  const [goldMode, setGoldMode] = useState<'auto' | 'label' | 'manual'>('auto');
  const [roleInferenceResult, setRoleInferenceResult] = useState<InferProjectPersonaRolesResult | null>(null);
  const [selectedRoleSuggestionKeys, setSelectedRoleSuggestionKeys] = useState<string[]>([]);
  const [showAdvancedMapping, setShowAdvancedMapping] = useState(false);

  // Track whether gold config has unsaved changes (for auto-save indicator)
  const hasUnsavedGoldChanges = useMemo(() => {
    const normalizedKeys = goldMode === 'manual' ? [...selectedGoldKeys].sort() : [];
    const normalizedLabel = goldMode === 'label' ? goldLabelDraft.trim() : '';
    const keysChanged = JSON.stringify(normalizedKeys) !== JSON.stringify([...(currentGoldIssueKeys ?? [])].sort());
    const labelChanged = normalizedLabel !== (currentGoldConfig.label ?? '').trim();
    return keysChanged || labelChanged;
  }, [selectedGoldKeys, currentGoldIssueKeys, goldLabelDraft, currentGoldConfig.label, goldMode]);

  useEffect(() => {
    setRoleInferenceResult(null);
    setSelectedRoleSuggestionKeys([]);
  }, [activeArProj]);

  // Reset gold config state when the active project changes.
  // NOTE: We intentionally do NOT depend on goldStoryPool here —
  // resetting selectedGoldKeys on every pool update would discard unsaved edits.
  // Pool changes are reflected in the candidate list via a separate effect below.
  useEffect(() => {
    setGoldCandidateQuery('');
    setSelectedGoldKeys(currentGoldIssueKeys);
    setGoldLabelDraft(currentGoldConfig.label ?? '');
    setGoldMode(
      currentGoldIssueKeys.length > 0
        ? 'manual'
        : currentGoldConfig.label?.trim()
          ? 'label'
          : 'auto',
    );
  }, [activeArProj, currentGoldIssueKeysSignature, currentGoldConfig.label, currentGoldIssueKeys]);

  // When the pool loads/refreshes, update the default candidate list
  // (but do NOT reset the user's manual key selections).
  useEffect(() => {
    setGoldCandidateResults(goldStoryPool.slice(0, 8));
  }, [goldStoryPool]);

  const inferButtonDisabled = !activeArProj || activeArProj === '*' || isInferringPersonaRoles || indexedCount <= 0;

  const updateGoldConfigLocal = (patch: Partial<ProjectGoldExampleConfig>) => {
    const nextIssueKeys = patch.issueKeys ?? currentGoldConfig.issueKeys ?? [];
    const nextLabel = patch.label ?? currentGoldConfig.label;
    const nextEntry: ProjectGoldExampleConfig = {
      projectKey: activeArProj,
      issueKeys: nextIssueKeys.length ? nextIssueKeys : undefined,
      label: nextLabel?.trim() ? nextLabel.trim() : undefined,
    };
    const existing = (goldExampleConfigs as ProjectGoldExampleConfig[]).filter((entry) => entry.projectKey !== activeArProj);
    const hasContent = Boolean(nextEntry.issueKeys?.length || nextEntry.label);
    setGoldExampleConfigs(hasContent ? [...existing, nextEntry] : existing);
  };

  const toggleGoldKey = (key: string) => {
    setSelectedGoldKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  };

  // Debounced gold candidate search — fires 300ms after the user stops typing
  const goldSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedSearchGoldCandidates = useCallback((query: string) => {
    if (goldSearchTimerRef.current) clearTimeout(goldSearchTimerRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setGoldCandidateResults(goldStoryPool.slice(0, 8));
      return;
    }
    goldSearchTimerRef.current = setTimeout(() => {
      void (async () => {
        setIsSearchingGoldCandidates(true);
        try {
          const response = await api.searchBacklogForGoldCandidates({ projectKey: activeArProj, query: trimmed }) as any;
          setGoldCandidateResults(response?.success ? (response.results ?? []) : []);
        } catch {
          setGoldCandidateResults([]);
        } finally {
          setIsSearchingGoldCandidates(false);
        }
      })();
    }, 300);
  }, [activeArProj, goldStoryPool]);

  const persistGoldConfig = async (options: { notice?: string } = {}) => {
    const normalizedKeys = goldMode === 'manual'
      ? [...new Set(selectedGoldKeys.map((key) => key.trim()).filter(Boolean))]
      : [];
    const normalizedLabel = goldMode === 'label' ? goldLabelDraft.trim() : '';
    const currentKeys = currentGoldIssueKeys;
    const currentLabel = currentGoldConfig.label ?? '';
    const keysChanged = !areStringArraysEqual(normalizedKeys, currentKeys);
    const labelChanged = normalizedLabel !== currentLabel;

    if (!keysChanged && !labelChanged) return false;

    setIsSavingGoldConfig(true);
    try {
      if (labelChanged) {
        await api.setGoldExampleLabel({ projectKey: activeArProj, label: normalizedLabel || undefined });
      }
      if (keysChanged) {
        await api.setGoldExampleKeys({ projectKey: activeArProj, issueKeys: normalizedKeys });
      }
      updateGoldConfigLocal({
        issueKeys: normalizedKeys,
        label: normalizedLabel || undefined,
      });
      setProjectNotice(options.notice ?? 'Gold exemplar settings saved.');
      return true;
    } catch (error: any) {
      throw new Error(error?.message || 'Gold exemplar settings could not be saved.');
    } finally {
      setIsSavingGoldConfig(false);
    }
  };

  const handleSuggestPersonaRoles = async () => {
    if (inferButtonDisabled) return;
    setIsInferringPersonaRoles(true);
    setProjectNotice(null);
    try {
      const response = await api.inferProjectPersonaRoles(activeArProj) as InferProjectPersonaRolesResult;
      setRoleInferenceResult(response);
      setSelectedRoleSuggestionKeys(
        (response.suggestions ?? []).map((suggestion) => suggestion.role.trim().toLowerCase()),
      );
    } catch (error: any) {
      setRoleInferenceResult({
        success: false,
        suggestions: [],
        sampledIssueCount: 0,
        sampledIssueKeys: [],
        usedCache: true,
        error: error?.message || 'Role suggestions could not be generated.',
      });
    } finally {
      setIsInferringPersonaRoles(false);
    }
  };

  const toggleRoleSuggestion = (role: string) => {
    const key = role.trim().toLowerCase();
    setSelectedRoleSuggestionKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  };

  const handleAddSelectedRoleSuggestions = () => {
    const selectedSuggestions = (roleInferenceResult?.suggestions ?? []).filter((suggestion) => (
      selectedRoleSuggestionKeys.includes(suggestion.role.trim().toLowerCase())
    ));
    if (!selectedSuggestions.length) return;
    updateContext({
      personaRoles: mergeSuggestedPersonaRoles(currentContext.personaRoles ?? [], selectedSuggestions),
    });
    setProjectNotice(`Added ${selectedSuggestions.length} inferred role${selectedSuggestions.length === 1 ? '' : 's'} to the editable table. Save the project to persist them.`);
    setRoleInferenceResult(null);
    setSelectedRoleSuggestionKeys([]);
  };

  const handleSave = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      await persistGoldConfig({ notice: 'Project configuration saved.' }).catch((error) => {
        throw error;
      });
      if (isAdmin) {
        await api.patchConfig({
          backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        });
      }
      const saveRes = await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext,
        backlogStatuses: effectiveBacklogStatuses,
      });
      if ((saveRes as any)?.success === false) {
        throw new Error((saveRes as any)?.error || 'Project configuration could not be saved.');
      }
      setProjectNotice('Project configuration saved.');
      onEnterOverview?.();
    } catch (e: any) { alert(e.message); }
    finally { setIsSavingProject(false); }
  };

  const handleSaveAndRefresh = async () => {
    setIsSavingProject(true);
    setProjectNotice(null);
    try {
      await persistGoldConfig({ notice: 'Backlog cache rebuild queued. This can take a little while on larger projects.' }).catch((error) => {
        throw error;
      });
      if (isAdmin) {
        await api.patchConfig({
          backlogThemeBudgetOverride: normalizeOptionalPositiveInt(backlogThemeBudgetOverride),
        });
      }
      const saveRes = await api.saveProjectConfig({
        projectKey: activeArProj,
        arMapping: currentMapping,
        domainContext: currentContext,
        backlogStatuses: effectiveBacklogStatuses,
      });
      if ((saveRes as any)?.success === false) {
        throw new Error((saveRes as any)?.error || 'Project configuration could not be saved.');
      }
      setProjectNotice('Backlog cache rebuild queued. This can take a little while on larger projects.');
      const refreshed = await onRefreshBacklogCache(activeArProj);
      if (refreshed) {
        if (refreshed.issueCount > 0) {
          setProjectNotice(`Backlog cache rebuilt with ${refreshed.issueCount} issues.`);
        } else if (refreshed.diagnostics?.likelyReason) {
          setProjectNotice(`Cache rebuilt: 0 items. ${refreshed.diagnostics.likelyReason}`);
        } else {
          setProjectNotice('Cache rebuilt: 0 matching issues found.');
        }
      }
      onEnterOverview?.();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setIsSavingProject(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in">
      <div style={{ display: 'none' }}>
        <button id="jira-save-target" onClick={handleSave} disabled={isSavingProject || isRefreshingBacklogCache} />
        <button id="jira-save-rebuild-target" onClick={handleSaveAndRefresh} disabled={isSavingProject || isRefreshingBacklogCache} />
      </div>

      {projectNotice && (
        <div className="text-xs font-bold text-[var(--rf-success)] bg-[var(--rf-success-subtle)] border border-[var(--rf-success-subtle)] rounded-xl px-4 py-3 flex items-center gap-2">
          <Check className="w-4 h-4" /> {projectNotice}
        </div>
      )}

      <div className="space-y-4">
         {activeStep === 'backlog' && (
         <div className="space-y-3">
           <button
             type="button"
             onClick={() => onActiveStepChange?.('backlog')}
             className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
           >
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)]"><Database className="w-4 h-4 text-[var(--rf-brand)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                   Backlog Context
                   <span className="rounded-md bg-[var(--rf-danger-subtle)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-danger)] border border-rose-100">Required</span>
                 </h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Define Jira statuses for AI context.</p>
               </div>
             </div>
             <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${activeStep === 'backlog' ? 'rotate-90' : ''}`} />
           </button>

           <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
             <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Indexed Items</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{indexedCount}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   {backlogCacheInfo?.issueCount !== undefined
                     ? 'Cache count from the latest rebuild.'
                     : 'Fallback from backlog diagnostics when cache metadata has not been refreshed yet.'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Shards</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{backlogCacheInfo?.shardCount ?? 0}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   Lean cache slices sized for Forge storage.
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Themes</div>
                 <div className="mt-1 text-xl font-black text-[var(--rf-text)]">{backlogCacheInfo?.themeCount ?? 0}</div>
                 <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   Adaptive shortlist index for retrieval.
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Last Built</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)]">
                   {backlogCacheInfo?.builtAt ? new Date(backlogCacheInfo.builtAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Theme Index</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)]">
                   {backlogCacheInfo?.themeBuiltAt ? new Date(backlogCacheInfo.themeBuiltAt).toLocaleString() : 'Not built yet'}
                 </div>
               </div>
               <div className="rf-card px-4 py-3 ">
               <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Status</div>
                 <div className="mt-1 text-sm font-bold text-[var(--rf-text-secondary)] flex items-center gap-1.5">
                   {isRefreshingBacklogCache || backlogRefreshStatus?.status === 'queued' || backlogRefreshStatus?.status === 'running'
                     ? <><RefreshCw className="w-4 h-4 animate-spin text-[var(--rf-brand)]"/> Rebuilding</>
                     : backlogCacheInfo?.stale
                       ? <><AlertCircle className="w-4 h-4 text-[var(--rf-warning)]"/> Needs refresh</>
                       : <><Check className="w-4 h-4 text-[var(--rf-success)]"/> Fresh</>}
                 </div>
                 {(backlogRefreshStatus?.status === 'queued' || backlogRefreshStatus?.status === 'running') && (
                   <div className="mt-2 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                     {backlogRefreshStatus.status === 'queued' ? 'Queued in the long-running refresh worker.' : 'Building shards and theme index in the background.'}
                   </div>
                 )}
                 {backlogRefreshStatus?.status === 'error' && (
                   <div className="mt-2 text-[13px] font-medium text-[var(--rf-danger)]">
                     {backlogRefreshStatus.error || 'Last rebuild attempt failed.'}
                   </div>
                 )}
                 {backlogCacheInfo?.legacyFallback && (
                   <div className="mt-2 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-warning)]">Legacy cache fallback</div>
                 )}
               </div>
             </div>

             <div className="rf-card px-4 py-4 ">
               <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                 <div className="space-y-1">
                   <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Adaptive Theme Budget</div>
                   <div className="text-sm font-bold text-[var(--rf-text)]">Optional override for large or unusual projects</div>
                   <div className="text-[13px] font-medium text-[var(--rf-text-tertiary)] max-w-xl">
                     Leave blank to use the adaptive default: <span className="font-bold text-[var(--rf-text-secondary)]">ceil(issueCount / 50)</span>, clamped between 24 and 120.
                   </div>
                 </div>
                 <div className="w-full md:w-56">
                   <input
                     type="number"
                     min={1}
                     max={120}
                     value={backlogThemeBudgetOverride}
                     onChange={(e) => onBacklogThemeBudgetOverrideChange(e.target.value)}
                     placeholder="Adaptive default"
                     disabled={!isAdmin}
                     className="w-full rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3 text-sm font-bold text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                   />
                   {!isAdmin && (
                     <div className="mt-2 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                       Workspace admin only
                     </div>
                   )}
                 </div>
               </div>
             </div>

             <div className="space-y-3 pt-2">
               <div className="flex items-center justify-between">
                 <div className="text-sm font-bold text-[var(--rf-text)]">
                   {effectiveBacklogStatuses.length} status{effectiveBacklogStatuses.length === 1 ? '' : 'es'} in scope
                 </div>
                 <div className="flex gap-2">
                   <button onClick={() => updateBacklogStatuses(detectDefaultStatuses(backlogStatusOptions))} className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] px-2 py-1 rounded">Default</button>
                   <button onClick={() => updateBacklogStatuses(backlogStatusOptions.map((status: any) => status.name))} className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] hover:text-[var(--rf-brand-hover)] bg-[var(--rf-brand-muted)] px-2 py-1 rounded">All</button>
                 </div>
               </div>
               <div className="flex flex-wrap gap-2">
                 {backlogStatusOptions.map((status: any) => {
                   const selected = effectiveBacklogStatuses.includes(status.name);
                   return (
                     <button
                       key={status.name}
                       onClick={() => updateBacklogStatuses(selected ? effectiveBacklogStatuses.filter((item: string) => item !== status.name) : [...effectiveBacklogStatuses, status.name])}
                       className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-colors ${selected ? 'bg-[var(--rf-brand)] text-white border-[var(--rf-brand)] shadow-md shadow-[var(--rf-brand)]/20' : 'bg-white text-[var(--rf-text-secondary)] border-[var(--rf-border)] hover:border-[var(--rf-brand-subtle)]'}`}
                     >
                       {status.name}
                     </button>
                   );
                 })}
               </div>
             </div>

           </div>
         </div>
         )}

         {activeStep === 'wi' && (
           <ProjectWorkInstructionsPanel
             activeArProj={activeArProj}
             wiDocs={wiDocs}
             wiUploadState={wiUploadState}
             wiUploadError={wiUploadError}
             wiUploadCopy={wiUploadCopy}
             onUploadWi={onUploadWi}
             onDismissWiUploadError={onDismissWiUploadError}
             onRemoveWiDoc={onRemoveWiDoc}
             canManageWi={canManageWi}
           />
         )}

         {activeStep === 'gold' && (
         <div className="space-y-3">
           <div className="rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm">
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)]"><Image className="w-4 h-4 text-[var(--rf-brand)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                   Gold Examples
                   <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Optional</span>
                 </h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Choose one clear source for reference stories.</p>
               </div>
             </div>
           </div>

           <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
             <div className="grid gap-3 md:grid-cols-3">
               {[
                 { id: 'auto', title: 'Auto-ranked backlog pool', helper: goldStoryPool.length > 0 ? `${Math.min(goldStoryPool.length, 8)} strong candidates ready` : 'Needs a backlog rebuild before candidates appear' },
                 { id: 'label', title: 'Use Jira label', helper: 'Use one label when your team already curates example stories in Jira' },
                 { id: 'manual', title: 'Pick specific stories', helper: 'Use exact issue keys when you want deterministic examples' },
               ].map((option) => (
                 <button
                   key={option.id}
                   type="button"
                   disabled={!canManageGoldExamples}
                   onClick={() => {
                     setGoldMode(option.id as 'auto' | 'label' | 'manual');
                     if (option.id === 'auto') {
                       setGoldLabelDraft('');
                       setSelectedGoldKeys([]);
                     }
                     if (option.id === 'label') {
                       setSelectedGoldKeys([]);
                     }
                     if (option.id === 'manual') {
                       setGoldLabelDraft('');
                     }
                   }}
                   className={`rounded-2xl border px-4 py-4 text-left transition ${goldMode === option.id ? 'border-[var(--rf-brand)] bg-white shadow-sm' : 'border-[var(--rf-border)] bg-white/80 hover:border-[var(--rf-border-strong)]'} disabled:opacity-50`}
                 >
                   <div className="flex items-center justify-between gap-3">
                     <div className="text-[14px] font-bold text-[var(--rf-text)]">{option.title}</div>
                     <span className={`h-3 w-3 rounded-full ${goldMode === option.id ? 'bg-[var(--rf-brand)]' : 'bg-[var(--rf-border-strong)]'}`} />
                   </div>
                   <p className="mt-2 text-[13px] font-medium leading-relaxed text-[var(--rf-text-tertiary)]">{option.helper}</p>
                 </button>
               ))}
             </div>

             {goldMode === 'auto' && (
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-4 space-y-3">
                 <div className="flex items-center justify-between gap-3">
                   <div>
                     <div className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Automatic mode</div>
                     <div className="mt-1 text-sm font-medium text-[var(--rf-text-secondary)]">
                       The generator will use the best-ranked backlog stories automatically.
                     </div>
                   </div>
                   <button
                     type="button"
                     disabled={!canManageGoldExamples || isSavingGoldConfig}
                     onClick={() => {
                       setGoldLabelDraft('');
                       setSelectedGoldKeys([]);
                       void persistGoldConfig({ notice: 'Gold examples set to automatic mode.' }).catch((error) => alert(error.message));
                     }}
                     className="rounded-xl bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50"
                   >
                     Use automatic mode
                   </button>
                 </div>
                 <div className="space-y-2">
                   {goldStoryPool.length > 0 ? goldStoryPool.slice(0, 6).map((entry: any) => (
                     <div key={entry.key} className="flex items-center gap-3 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2">
                       <span className="min-w-[36px] rounded px-1.5 py-0.5 text-center text-[11px] font-black text-[var(--rf-brand)] bg-[var(--rf-brand-muted)]">{entry.score}</span>
                       <span className="text-xs font-bold text-[var(--rf-text)]">{entry.key}</span>
                       <span className="flex-1 truncate text-xs font-medium text-[var(--rf-text-secondary)]">{entry.summary}</span>
                     </div>
                   )) : (
                     <div className="rounded-xl border border-dashed border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-5 text-center text-sm font-medium text-[var(--rf-text-tertiary)]">
                       Rebuild the backlog cache to populate automatic candidates.
                     </div>
                   )}
                 </div>
               </div>
             )}

             {goldMode === 'label' && (
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-4 space-y-3">
                 <div>
                   <div className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Label-driven selection</div>
                   <div className="mt-1 text-sm font-medium text-[var(--rf-text-secondary)]">Use a single Jira label when your examples are already curated inside the backlog.</div>
                 </div>
                 <div className="flex flex-col gap-3 md:flex-row md:items-center">
                   <input
                     type="text"
                     value={goldLabelDraft}
                     onChange={(event) => setGoldLabelDraft(event.target.value)}
                     placeholder="e.g. gold-example"
                     disabled={!canManageGoldExamples}
                     className="flex-1 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2.5 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                   />
                   <button
                     type="button"
                     disabled={!canManageGoldExamples || isSavingGoldConfig || !hasUnsavedGoldChanges}
                     onClick={() => {
                        setSelectedGoldKeys([]);
                        void persistGoldConfig({ notice: 'Gold label saved.' }).catch((error) => alert(error.message));
                      }}
                     className="rounded-xl bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50"
                   >
                     {isSavingGoldConfig ? 'Saving...' : 'Save label'}
                   </button>
                 </div>
               </div>
             )}

             {goldMode === 'manual' && (
               <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-4 space-y-3">
                 <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
                   <div>
                     <div className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Manual story selection</div>
                     <div className="mt-1 text-sm font-medium text-[var(--rf-text-secondary)]">Pick the exact stories you want the generator to learn from.</div>
                   </div>
                   <div className="text-[12px] font-semibold text-[var(--rf-text-tertiary)]">{selectedGoldKeys.length} selected</div>
                 </div>

                 <MultiSearchSelect
                   selectedValues={selectedGoldKeys}
                   onToggle={toggleGoldKey}
                   onRemove={(key) => toggleGoldKey(key)}
                   options={(goldCandidateResults.length > 0 ? goldCandidateResults : goldStoryPool.slice(0, 12)).map((entry: any) => ({
                     value: entry.key,
                     label: entry.key,
                     description: entry.summary,
                     score: entry.score,
                   }))}
                   onSearchChange={(query) => {
                     setGoldCandidateQuery(query);
                     debouncedSearchGoldCandidates(query);
                   }}
                   searchValue={goldCandidateQuery}
                   isSearching={isSearchingGoldCandidates}
                   placeholder="Search by key or summary..."
                   searchPlaceholder="Type to search ranked pool..."
                   emptyStateLabel={goldStoryPool.length === 0 ? 'Rebuild the backlog cache to populate candidates.' : 'No matches found.'}
                 />

                 {selectedGoldKeys.length > 0 && (
                   <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
                     <div className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Selected stories</div>
                     <div className="mt-2 flex flex-wrap gap-2">
                       {selectedGoldKeys.map((key) => (
                         <span key={key} className="rounded-full bg-white px-3 py-1 text-[12px] font-semibold text-[var(--rf-text-secondary)] border border-[var(--rf-border)]">{key}</span>
                       ))}
                     </div>
                   </div>
                 )}

                 <div className="flex flex-wrap items-center gap-2">
                   <button
                     type="button"
                     onClick={() => {
                       setGoldLabelDraft('');
                       void persistGoldConfig({ notice: 'Gold examples saved.' }).catch((error) => alert(error.message));
                     }}
                     disabled={!canManageGoldExamples || isSavingGoldConfig || !hasUnsavedGoldChanges}
                     className="rounded-xl bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50"
                   >
                     {isSavingGoldConfig ? 'Saving...' : 'Save selected stories'}
                   </button>
                   {selectedGoldKeys.length > 0 && (
                     <button
                       type="button"
                       onClick={() => setSelectedGoldKeys([])}
                       className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2.5 text-[13px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-[var(--rf-surface-soft)]"
                     >
                       Clear all
                     </button>
                   )}
                 </div>
               </div>
             )}
           </div>
         </div>
         )}

         {activeStep === 'guidance' && (
         <div className="space-y-3">
           <button
             type="button"
             onClick={() => { onActiveStepChange?.('guidance'); }}
             className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
           >
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-brand-muted)] flex items-center justify-center border border-[rgba(43,89,74,0.12)]"><Globe className="w-4 h-4 text-[var(--rf-brand)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                   Project Guidance
                   <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Recommended</span>
                 </h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Rules or context specific to this project.</p>
               </div>
             </div>
             <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${activeStep === 'guidance' ? 'rotate-90' : ''}`} />
           </button>

           <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
             <div className="rf-card p-4 space-y-4">
               <div>
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Domain context</div>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Answer these to give the AI platform awareness. All three are optional — fill in what you know.</p>
               </div>
               {(() => {
                 const raw = currentContext.context ?? '';
                 const fields = isStructuredDomainContext(raw)
                   ? parseDomainContextFields(raw)
                   : { platforms: '', businessObjects: '', handoffs: raw };
                 const update = (patch: Partial<DomainContextFields>) => {
                   updateContext({ context: formatDomainContextFields({ ...fields, ...patch }) });
                 };
                 return (
                   <div className="space-y-3">
                     <div>
                       <label className="text-xs font-bold text-[var(--rf-text-secondary)] mb-1 block">What platforms or systems does your work connect to?</label>
                       <input
                         type="text"
                         value={fields.platforms}
                         onChange={e => update({ platforms: e.target.value })}
                         placeholder='e.g. "Salesforce/ServiceMax and SAP"'
                         className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition"
                       />
                     </div>
                     <div>
                       <label className="text-xs font-bold text-[var(--rf-text-secondary)] mb-1 block">What are the main business objects in your domain?</label>
                       <input
                         type="text"
                         value={fields.businessObjects}
                         onChange={e => update({ businessObjects: e.target.value })}
                         placeholder='e.g. "service plans, work orders, entitlements, parts shipments"'
                         className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition"
                       />
                     </div>
                     <div>
                       <label className="text-xs font-bold text-[var(--rf-text-secondary)] mb-1 block">What are the key handoffs between teams or systems?</label>
                       <input
                         type="text"
                         value={fields.handoffs}
                         onChange={e => update({ handoffs: e.target.value })}
                         placeholder='e.g. "When a service plan is approved, work orders and parts shipments are created in back-office"'
                         className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-xl px-4 py-2.5 text-sm font-medium outline-none focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] transition"
                       />
                     </div>
                   </div>
                 );
               })()}
             </div>

             <div className="rf-card p-4 space-y-4">
               <div className="flex items-center justify-between gap-3">
                 <div>
                   <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Persona roles</div>
                   <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Define project-specific roles and the activities they commonly perform.</p>
                 </div>
                 <div className="flex items-center gap-2">
                   <button
                     type="button"
                     onClick={handleSuggestPersonaRoles}
                     disabled={inferButtonDisabled}
                     className="text-[12px] font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1 rounded-lg transition inline-flex items-center gap-1.5"
                   >
                     {isInferringPersonaRoles ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <BrainCircuit className="w-3.5 h-3.5" />}
                     Suggest from backlog
                   </button>
                   <button
                     type="button"
                     onClick={() => updateContext({ personaRoles: [...(currentContext.personaRoles ?? []), { role: '', activities: '' }] })}
                     className="text-[12px] font-bold text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] px-2.5 py-1 rounded-lg transition"
                   >
                     + Add row
                   </button>
                 </div>
               </div>
               {indexedCount <= 0 && (
                 <div className="rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                   Build backlog context first to infer roles from a broad cached backlog sample.
                 </div>
               )}
               {roleInferenceResult && (
                 <div className={`rounded-xl border px-4 py-4 space-y-3 ${roleInferenceResult.success ? 'border-[var(--rf-border)] bg-white' : 'border-[var(--rf-danger-subtle)] bg-[var(--rf-danger-subtle)]/35'}`}>
                   <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                     <div>
                       <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Backlog suggestions</div>
                       <div className="mt-1 text-sm font-semibold text-[var(--rf-text)]">
                         Reviewed suggestions from {roleInferenceResult.sampledIssueCount} sampled backlog item{roleInferenceResult.sampledIssueCount === 1 ? '' : 's'} across the cached project backlog.
                       </div>
                       {(roleInferenceResult.message || roleInferenceResult.error) && (
                         <div className={`mt-1 text-[13px] font-medium ${roleInferenceResult.error ? 'text-[var(--rf-danger)]' : 'text-[var(--rf-text-tertiary)]'}`}>
                           {roleInferenceResult.error || roleInferenceResult.message}
                         </div>
                       )}
                     </div>
                     <button
                       type="button"
                       onClick={() => {
                         setRoleInferenceResult(null);
                         setSelectedRoleSuggestionKeys([]);
                       }}
                       className="self-start rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-1.5 text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-border-strong)]"
                     >
                       Dismiss
                     </button>
                   </div>

                   {roleInferenceResult.suggestions.length > 0 && (
                     <>
                       <div className="space-y-2">
                         {roleInferenceResult.suggestions.map((suggestion) => {
                           const suggestionKey = suggestion.role.trim().toLowerCase();
                           const checked = selectedRoleSuggestionKeys.includes(suggestionKey);
                           const confidenceTone = suggestion.confidence === 'high'
                             ? 'bg-[var(--rf-success-subtle)] text-[var(--rf-success)]'
                             : suggestion.confidence === 'medium'
                               ? 'bg-[var(--rf-warning-subtle)] text-[var(--rf-warning)]'
                               : 'bg-[var(--rf-surface-soft)] text-[var(--rf-text-tertiary)]';
                           return (
                             <label key={suggestion.role} className="flex gap-3 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-3 cursor-pointer">
                               <input
                                 type="checkbox"
                                 checked={checked}
                                 onChange={() => toggleRoleSuggestion(suggestion.role)}
                                 className="mt-1 h-4 w-4 rounded border-[var(--rf-border)] text-[var(--rf-brand)] focus:ring-[var(--rf-brand)]/20"
                               />
                               <div className="min-w-0 flex-1 space-y-1.5">
                                 <div className="flex flex-wrap items-center gap-2">
                                   <div className="text-sm font-bold text-[var(--rf-text)]">{suggestion.role}</div>
                                   <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.16em] ${confidenceTone}`}>
                                     {suggestion.confidence}
                                   </span>
                                 </div>
                                 <div className="text-sm font-medium text-[var(--rf-text-secondary)]">{suggestion.activities}</div>
                                 {suggestion.evidenceIssueKeys.length > 0 && (
                                   <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                                     Evidence: {suggestion.evidenceIssueKeys.join(', ')}
                                   </div>
                                 )}
                               </div>
                             </label>
                           );
                         })}
                       </div>
                       <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                         <div className="text-[12px] font-medium text-[var(--rf-text-tertiary)]">
                           {selectedRoleSuggestionKeys.length} selected. Added suggestions stay editable until you save the project.
                         </div>
                         <button
                           type="button"
                           onClick={handleAddSelectedRoleSuggestions}
                           disabled={selectedRoleSuggestionKeys.length === 0}
                           className="rounded-lg bg-[var(--rf-brand)] text-white px-3 py-2 text-[12px] font-bold uppercase tracking-widest transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50 disabled:cursor-not-allowed"
                         >
                           Add selected
                         </button>
                       </div>
                     </>
                   )}
                 </div>
               )}
               <div className="rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-3 space-y-2.5">
                 <div className="space-y-3">
                   <div className="hidden md:grid md:grid-cols-[minmax(180px,220px)_1fr_auto] gap-3 px-1 text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">
                     <div>Role</div>
                     <div>Activities</div>
                     <div />
                   </div>
                   {currentPersonaRoles.map((row, index, allRows) => (
                     <div key={`project-role-${index}`} className="grid grid-cols-1 md:grid-cols-[minmax(160px,200px)_1fr_auto] gap-2.5 items-start rounded-xl border border-[var(--rf-border)] bg-white px-3 py-2.5">
                       <div className="space-y-1">
                         <div className="md:hidden text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Role</div>
                         <input
                           value={row.role}
                           onChange={e => updateContext({ personaRoles: allRows.map((item, idx) => idx === index ? { ...item, role: e.target.value } : item) })}
                           placeholder="Operations Coordinator"
                           className="w-full rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-sm font-semibold text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                         />
                       </div>
                       <div className="space-y-1">
                         <div className="md:hidden text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Activities</div>
                         <textarea
                           value={row.activities}
                           onChange={e => updateContext({ personaRoles: allRows.map((item, idx) => idx === index ? { ...item, activities: e.target.value } : item) })}
                           placeholder="Coordinates intake, checks timing windows, and confirms completion."
                           className="min-h-[64px] w-full resize-none rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-sm font-medium text-[var(--rf-text)] outline-none transition focus:border-[var(--rf-brand)] focus:ring-2 focus:ring-[var(--rf-brand)]/20"
                         />
                       </div>
                       <button
                         type="button"
                         onClick={() => updateContext({ personaRoles: allRows.length === 1 ? [] : allRows.filter((_, idx) => idx !== index) })}
                         className="md:mt-1 rounded-lg border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-3 py-2 text-[12px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] transition hover:border-[var(--rf-danger-subtle)] hover:text-[var(--rf-danger)]"
                       >
                         Remove
                       </button>
                     </div>
                   ))}
                 </div>
               </div>
             </div>

             <div className="rf-card p-4 flex items-center justify-between gap-4">
               <div>
                 <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Issue link type</div>
                 <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-1">Used when issues created from this project are linked back to the source issue.</div>
               </div>
               <div className="relative w-44">
                 <select
                   value={currentMapping.issueLinkType || 'Relates to'}
                   onChange={e => updateMapping({ issueLinkType: e.target.value })}
                   className="appearance-none pr-6 w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] px-3 py-1.5 rounded-lg text-sm font-semibold text-[var(--rf-text)] focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none transition"
                 >
                   {['Relates to', 'Blocks', 'Clones', 'Duplicates'].map(l => <option key={l} value={l}>{l}</option>)}
                 </select>
                 <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--rf-text-tertiary)] pointer-events-none" />
               </div>
             </div>
           </div>
         </div>
         )}

         {/* Mapping section */}
         {activeStep === 'mapping' && (
         <div className="space-y-3">
            <button
              type="button"
              onClick={() => onActiveStepChange?.('mapping')}
              className="w-full flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm hover:border-[var(--rf-border-strong)] transition"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[var(--rf-success-subtle)] flex items-center justify-center border border-emerald-100"><Layers className="w-4 h-4 text-[var(--rf-success)]" /></div>
                <div>
                  <h5 className="text-sm font-bold text-[var(--rf-text)] flex items-center gap-2">
                    AR Field Mapping
                    <span className="rounded-md bg-[var(--rf-surface-soft)] px-2 py-0.5 text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)] border border-[var(--rf-border)]">Advanced</span>
                  </h5>
                  <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Map where Acceptance Criteria go.</p>
                </div>
              </div>
              <ChevronRight className={`w-5 h-5 text-[var(--rf-text-tertiary)] transition-transform ${activeStep === 'mapping' ? 'rotate-90' : ''}`} />
            </button>
            <div className="bg-[var(--rf-surface-soft)] rounded-xl p-5 border border-[var(--rf-border)] space-y-5">
               <div className="rf-card p-4 ">
                 <div className="flex items-start justify-between gap-4">
                   <div>
                     <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Mapping</div>
                     <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">
                       Start with one simple question: where should Acceptance Criteria be written?
                     </p>
                   </div>
                 </div>

                 <div className="mt-4 space-y-4">
                   <div className="flex flex-wrap items-center gap-3">
                      <span className="text-[13px] font-bold text-[var(--rf-text)] pr-2">Issue Type:</span>
                      <div className="relative">
                        <select
                          value={activeIssueType}
                          onChange={e => setActiveIssueType(e.target.value)}
                          className="appearance-none bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg text-[13px] font-semibold pl-3 pr-8 py-1.5 focus:ring-2 focus:ring-[var(--rf-brand)]/20 focus:border-[var(--rf-brand)] outline-none"
                        >
                          <option value="*">General (All Types)</option>
                          {issueTypes.map((it: any) => (
                            <option key={it.id} value={it.id}>{it.name}</option>
                          ))}
                        </select>
                        <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--rf-text-tertiary)] pointer-events-none" />
                      </div>
                      {isLoadingIssueTypes && <span className="text-xs text-[var(--rf-text-tertiary)] ml-2">Loading types...</span>}
                    </div>

                    <div className="rounded-2xl border border-[var(--rf-border)] bg-white p-4 space-y-4">
                      <div>
                        <div className="text-[12px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">Primary AR destination</div>
                        <div className="mt-1 text-sm font-medium text-[var(--rf-text-secondary)]">
                          Choose the Jira field that should receive the generated acceptance requirements.
                        </div>
                      </div>
                      <FieldSelector
                        value={currentMapping.outputMappings.arFieldIds[0] || currentMapping.consolidatedFieldId || 'description'}
                        onChange={(nextFieldId: string) => {
                          const nextOutput = { ...currentMapping.outputMappings, arFieldIds: [nextFieldId] };
                          updateMapping({
                            consolidatedFieldId: nextFieldId,
                            iterativeFieldIds: [nextFieldId],
                            outputMappings: nextOutput,
                          });
                        }}
                        customFields={projectFields}
                      />

                      <label className="flex items-start gap-3 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
                        <input
                          type="checkbox"
                          checked={
                            currentMapping.inputMappings.descriptionFieldId === currentMapping.outputMappings.descriptionFieldId
                            && JSON.stringify(currentMapping.inputMappings.arFieldIds) === JSON.stringify(currentMapping.outputMappings.arFieldIds)
                          }
                          onChange={(event) => {
                            if (!event.target.checked) return;
                            updateMapping({
                              inputMappings: {
                                ...currentMapping.inputMappings,
                                descriptionFieldId: currentMapping.outputMappings.descriptionFieldId,
                                arFieldIds: [...currentMapping.outputMappings.arFieldIds],
                              },
                            });
                          }}
                          className="mt-0.5 rounded border-[var(--rf-border)]"
                        />
                        <div>
                          <div className="text-sm font-semibold text-[var(--rf-text)]">Use the same field when reading existing Jira content</div>
                          <div className="mt-1 text-[13px] font-medium text-[var(--rf-text-tertiary)]">
                            Keep read and write behavior aligned unless this project has a special case.
                          </div>
                        </div>
                      </label>

                      <button
                        type="button"
                        onClick={() => setShowAdvancedMapping((current) => !current)}
                        className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2.5 text-[13px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-[var(--rf-surface-soft)]"
                      >
                        {showAdvancedMapping ? 'Hide advanced mapping' : 'Edit advanced mapping'}
                      </button>
                    </div>

                    {showAdvancedMapping && (
                      <div className="grid grid-cols-1 gap-4">
                        <FieldMappingEditor
                          title="Output mapping"
                          description="Advanced control for where generated content is written."
                          mapping={currentMapping.outputMappings}
                          onChange={(next: ProjectFieldMapping) => updateMapping({ outputMappings: next })}
                          customFields={projectFields}
                        />
                        <FieldMappingEditor
                          title="Input mapping"
                          description="Advanced control for which fields are read when grounding existing issue content."
                          mapping={currentMapping.inputMappings}
                          onChange={(next: ProjectFieldMapping) => updateMapping({ inputMappings: next })}
                          customFields={projectFields}
                        />
                      </div>
                    )}
                  </div>
               </div>
            </div>
         </div>
         )}

         {activeStep === 'review' && (
         <div className="space-y-3">
           <div className="rounded-xl border border-[var(--rf-border)] bg-white px-5 py-4 text-left shadow-sm">
             <div className="flex items-center gap-3">
               <div className="w-8 h-8 rounded-lg bg-[var(--rf-success-subtle)] flex items-center justify-center border border-emerald-100"><Check className="w-4 h-4 text-[var(--rf-success)]" /></div>
               <div>
                 <h5 className="text-sm font-bold text-[var(--rf-text)]">Review And Finish</h5>
                 <p className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Confirm the setup shape, then save the project.</p>
               </div>
             </div>
           </div>
           <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-5 space-y-4">
             <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
               {[
                 { label: 'Backlog scope', value: effectiveBacklogStatuses.length ? `${effectiveBacklogStatuses.length} statuses selected` : 'No statuses selected yet' },
                 { label: 'Work instructions', value: wiDocs.length ? `${wiDocs.length} linked document${wiDocs.length === 1 ? '' : 's'}` : 'No linked docs yet' },
                 { label: 'Gold examples', value: goldMode === 'manual' ? `${selectedGoldKeys.length} selected stories` : goldMode === 'label' ? (goldLabelDraft.trim() || 'Label not set') : 'Automatic ranked pool' },
                 { label: 'Guidance', value: currentContext.context?.trim() ? 'Project context added' : 'No written context yet' },
                 { label: 'Role guidance', value: currentPersonaRoles.some((row) => row.role?.trim() || row.activities?.trim()) ? `${currentPersonaRoles.filter((row) => row.role?.trim() || row.activities?.trim()).length} role rows` : 'No role rows yet' },
                 { label: 'Field mapping', value: currentMapping.outputMappings.arFieldIds.length > 0 ? currentMapping.outputMappings.arFieldIds.join(', ') : currentMapping.consolidatedFieldId || 'Not configured' },
               ].map((item) => (
                 <div key={item.label} className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-3">
                   <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">{item.label}</div>
                   <div className="mt-2 text-sm font-semibold text-[var(--rf-text)]">{item.value}</div>
                 </div>
               ))}
             </div>
             <div className="flex flex-wrap items-center gap-2">
               <button
                 type="button"
                 onClick={handleSave}
                 disabled={isSavingProject || !canManageProjectSettings}
                 className="rounded-xl bg-[var(--rf-brand)] px-4 py-2.5 text-[13px] font-bold text-white transition hover:bg-[var(--rf-brand-hover)] disabled:opacity-50"
               >
                 {isSavingProject ? 'Saving...' : projectSetupComplete ? 'Save project updates' : 'Finish project setup'}
               </button>
               <button
                 type="button"
                 onClick={handleSaveAndRefresh}
                 disabled={isSavingProject || isRefreshingBacklogCache || !canManageProjectSettings}
                 className="rounded-xl border border-[var(--rf-border)] bg-white px-4 py-2.5 text-[13px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-[var(--rf-surface-soft)] disabled:opacity-50"
               >
                 {isRefreshingBacklogCache ? 'Rebuilding...' : 'Save and rebuild backlog'}
               </button>
             </div>
           </div>
         </div>
         )}

         <div className="flex flex-col gap-3 rounded-2xl border border-[var(--rf-border)] bg-white px-5 py-4 md:flex-row md:items-center md:justify-between">
           <div className="text-sm font-medium text-[var(--rf-text-tertiary)]">
             {mode === 'guided'
               ? 'Move in order if you are setting this project up for the first time.'
               : 'Jump between steps or return to the project overview when you are done.'}
           </div>
           <div className="flex flex-wrap items-center gap-2">
             <button
               type="button"
               onClick={() => {
                 const order: ProjectSetupStep[] = ['backlog', 'wi', 'gold', 'guidance', 'mapping', 'review'];
                 const index = order.indexOf(activeStep);
                 if (index <= 0) {
                   onEnterOverview?.();
                   return;
                 }
                 onActiveStepChange?.(order[index - 1]);
               }}
               className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-2 text-[12px] font-bold text-[var(--rf-text-secondary)] transition hover:bg-white"
             >
               Previous
             </button>
             <button
               type="button"
               onClick={() => {
                 const order: ProjectSetupStep[] = ['backlog', 'wi', 'gold', 'guidance', 'mapping', 'review'];
                 const index = order.indexOf(activeStep);
                 if (index >= order.length - 1) return;
                 onActiveStepChange?.(order[index + 1]);
               }}
               className="rounded-xl bg-[var(--rf-text)] px-4 py-2 text-[12px] font-bold text-white transition hover:bg-black"
             >
               {activeStep === 'mapping' ? 'Review setup' : 'Next step'}
             </button>
           </div>
         </div>
      </div>
    </div>
  );
}

function normalizeFieldIds(fieldIds: Array<string | null | undefined> = []) {
  return [...new Set(fieldIds.map(id => id?.trim()).filter((id): id is string => Boolean(id)))];
}

function normalizeProjectDomainContext(raw: any): ProjectDomainContextRow {
  return {
    projectKey: raw?.projectKey || '*',
    context: String(raw?.context ?? '').trim(),
    personaRoles: normalizeRoleGuidanceRows(raw?.personaRoles ?? []).filter((row) => row.role || row.activities),
  };
}

function normalizeProjectArMapping(raw: any): ProjectArMapping {
  const legacyArFieldIds = normalizeFieldIds(
    raw?.mode === 'iterative'
      ? raw?.iterativeFieldIds
      : raw?.consolidatedFieldId
        ? [raw.consolidatedFieldId]
        : [],
  );
  const hasOutputArFieldIds = Boolean(raw?.outputMappings && Object.prototype.hasOwnProperty.call(raw.outputMappings, 'arFieldIds'));
  const hasInputArFieldIds = Boolean(raw?.inputMappings && Object.prototype.hasOwnProperty.call(raw.inputMappings, 'arFieldIds'));
  const outputArFieldIds = hasOutputArFieldIds
    ? normalizeFieldIds(raw?.outputMappings?.arFieldIds)
    : legacyArFieldIds;
  const inputArFieldIds = hasInputArFieldIds
    ? normalizeFieldIds(raw?.inputMappings?.arFieldIds)
    : outputArFieldIds;
  const outputMappings: ProjectFieldMapping = {
    summaryFieldId: raw?.outputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: raw?.outputMappings?.descriptionFieldId || 'description',
    arFieldIds: outputArFieldIds,
  };
  const inputMappings: ProjectFieldMapping = {
    summaryFieldId: raw?.inputMappings?.summaryFieldId || 'summary',
    descriptionFieldId: raw?.inputMappings?.descriptionFieldId || 'description',
    arFieldIds: inputArFieldIds,
  };
  return {
    projectKey: raw?.projectKey || '*',
    issueType: raw?.issueType || '*',
    mode: outputMappings.arFieldIds.length > 1 ? 'iterative' : (raw?.mode || 'consolidated'),
    consolidatedFieldId: outputMappings.arFieldIds[0] || outputMappings.descriptionFieldId || 'description',
    iterativeFieldIds: outputMappings.arFieldIds,
    inputMappings,
    outputMappings,
    issueLinkType: raw?.issueLinkType || 'Relates to',
  };
}

function FieldMappingEditor({
  title,
  description,
  mapping,
  onChange,
  customFields,
}: {
  title: string;
  description: string;
  mapping: ProjectFieldMapping;
  onChange: (next: ProjectFieldMapping) => void;
  customFields: JiraField[];
}) {
  const selectableFieldIds = ['description', ...customFields.map(field => field.id)];

  const updateArField = (index: number, nextFieldId: string) => {
    const arFieldIds = [...mapping.arFieldIds];
    arFieldIds[index] = nextFieldId;
    onChange({ ...mapping, arFieldIds: normalizeFieldIds(arFieldIds) });
  };

  const addArField = () => {
    const nextFieldId = selectableFieldIds.find(fieldId => !mapping.arFieldIds.includes(fieldId));
    if (!nextFieldId) return;
    onChange({ ...mapping, arFieldIds: [...mapping.arFieldIds, nextFieldId] });
  };

  const removeArField = (index: number) => {
    onChange({ ...mapping, arFieldIds: mapping.arFieldIds.filter((_: string, idx: number) => idx !== index) });
  };

  return (
    <div className="rf-card p-5  space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)]">{title}</div>
          <p className="mt-1 text-xs font-medium text-[var(--rf-text-tertiary)]">{description}</p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Summary</div>
            <div className="text-sm font-bold text-[var(--rf-text-secondary)] mt-1">summary</div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] px-4 py-3">
          <div>
            <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Description</div>
            <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Select the Jira field that should hold the narrative body.</div>
          </div>
          <FieldSelector
            value={mapping.descriptionFieldId}
            onChange={(fid: string) => onChange({ ...mapping, descriptionFieldId: fid })}
            customFields={customFields}
          />
        </div>

        <div className="rounded-xl border border-[var(--rf-border)] bg-[var(--rf-surface-soft)] p-4 space-y-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-text-tertiary)]">Acceptance requirements</div>
              <div className="text-xs font-medium text-[var(--rf-text-tertiary)] mt-0.5">Add one or more Jira fields where ARs should appear.</div>
            </div>
            <button
              type="button"
              onClick={addArField}
              disabled={selectableFieldIds.every(fieldId => mapping.arFieldIds.includes(fieldId))}
              className="text-[13px] font-bold uppercase tracking-widest text-[var(--rf-brand)] bg-[var(--rf-brand-muted)] hover:bg-[var(--rf-brand-subtle)] px-3 py-1.5 rounded-lg transition"
            >
              + Add field
            </button>
          </div>
          <div className="space-y-2">
            {mapping.arFieldIds.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--rf-border)] bg-white px-4 py-3 text-xs font-medium text-[var(--rf-text-tertiary)]">
                No AR fields selected yet.
              </div>
            ) : (
              mapping.arFieldIds.map((fid: string, i: number) => (
                <div key={`${title}-${i}`} className="flex items-center gap-3 bg-white p-2 rounded-xl border border-[var(--rf-border)]">
                  <span className="text-[13px] font-black text-[var(--rf-text-tertiary)] min-w-[24px] text-center">#{i + 1}</span>
                  <div className="flex-1">
                    <FieldSelector value={fid} onChange={(nextFieldId: string) => updateArField(i, nextFieldId)} customFields={customFields} />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeArField(i)}
                    className="p-1.5 text-[var(--rf-text-tertiary)] hover:text-[var(--rf-danger)] hover:bg-[var(--rf-danger-subtle)] rounded-md transition"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldSelector({ value, onChange, customFields }: any) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = value === 'description' ? { id: 'description', name: 'Description (Standard)' } : customFields.find((f: any) => f.id === value);

  const filtered = useMemo(() => {
    const opts = [{ id: 'description', name: 'Description (Standard)' }, ...customFields];
    if (!search) return opts.slice(0, 100);
    const s = search.toLowerCase();
    return opts.filter(f => f.name.toLowerCase().includes(s) || f.id.toLowerCase().includes(s)).slice(0, 100);
  }, [search, customFields]);

  useEffect(() => {
    const click = (e: MouseEvent) => { if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setIsOpen(false); };
    document.addEventListener('mousedown', click);
    return () => document.removeEventListener('mousedown', click);
  }, []);

  return (
    <div className="relative w-full max-w-[240px]" ref={wrapperRef}>
      <button type="button" onClick={() => setIsOpen(!isOpen)} className="w-full bg-[var(--rf-surface-soft)] border border-[var(--rf-border)] rounded-lg px-3 py-2 text-xs font-bold text-left flex justify-between items-center hover:border-[var(--rf-brand-subtle)] transition-all shadow-sm">
        <span className="truncate text-[var(--rf-text-secondary)]">{selected ? selected.name : 'Select Field'}</span>
        <ChevronRight className={`w-3.5 h-3.5 text-[var(--rf-text-tertiary)] transition-transform ${isOpen ? 'rotate-90' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1.5 bg-white border border-[var(--rf-border)] rounded-xl shadow-xl overflow-hidden flex flex-col">
          <div className="p-2 border-b border-[var(--rf-border-subtle)] bg-[var(--rf-surface-soft)]">
            <input autoFocus value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter fields..." className="w-full bg-white border border-[var(--rf-border)] rounded-lg px-3 py-1.5 text-xs font-medium outline-none focus:border-[var(--rf-brand)]" />
          </div>
          <div className="max-h-[200px] overflow-y-auto custom-scrollbar py-1">
            {filtered.map((f: any) => (
              <button key={f.id} onClick={() => { onChange(f.id); setIsOpen(false); setSearch(''); }} className={`w-full text-left px-3 py-2 text-xs hover:bg-[var(--rf-surface-soft)] transition-colors flex items-center justify-between ${value === f.id ? 'bg-[var(--rf-brand-muted)]/50' : ''}`}>
                <span className={`font-bold truncate ${value === f.id ? 'text-[var(--rf-brand-hover)]' : 'text-[var(--rf-text-secondary)]'}`}>{f.name}</span>
                <span className="text-[13px] text-[var(--rf-text-tertiary)] font-mono shrink-0 ml-2">{f.id}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
