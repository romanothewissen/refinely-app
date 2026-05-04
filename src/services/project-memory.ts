import { Queue } from '@forge/events';
import { callLlmJson } from '../core/llm';
import { buildWorkInstructionInsightArtifact, getWorkInstructionInsightCount } from '../core/wi-insights';
import {
  type DomainPatterns,
  type GoldStoryPool,
  getBacklogCacheInfo,
  getGoldStoryPool,
} from '../core/similar-stories';
import type { JsonSchema } from '../core/json-schema';
import { objectRead, KEYS } from './cache';
import { listDocs } from '../core/wi-ingestion';
import { buildCombinedDomainContext, getCombinedPersonaRoles } from './project-selection';
import type { TenantConfig, WiChunk, WiDoc } from '../types';
import type {
  ProjectMemoryArtifactHeader,
  ProjectMemoryCompactExemplar,
  ProjectMemoryRefreshTrigger,
  ProjectMemorySelection,
  ProjectMemorySliceType,
  ProjectMemoryWiMemory,
  V2MemoryStatus,
} from '../v2/types';
import {
  getActiveProjectMemoryArtifact,
  getActiveProjectMemorySelection,
  getProjectMemoryRefreshState,
  listProjectMemoryRefreshStates,
  saveProjectMemoryArtifact,
  type StoredProjectMemoryArtifact,
  type StoredProjectMemoryRefreshState,
  upsertProjectMemoryRefreshState,
} from './v2-sql';
import { resolveEffectiveGeneratorConfig } from './model-strategy';

const PROJECT_MEMORY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_MEMORY_COMPILER_VERSION = 'v1';
const PROJECT_MEMORY_QUEUE_KEY = 'project-memory-refresh-queue';
const PROJECT_MEMORY_SLICE_TYPES: ProjectMemorySliceType[] = [
  'roles',
  'objects',
  'workflow_patterns',
  'lifecycle_states',
  'business_rules',
  'exception_patterns',
  'retrieval_hints',
  'compact_exemplars',
  'wi_memory',
];
const OBJECT_KEYWORDS = [
  'request',
  'plan',
  'order',
  'case',
  'shipment',
  'schedule',
  'template',
  'ticket',
  'invoice',
  'entitlement',
  'contract',
  'message',
  'asset',
  'document',
  'quote',
  'booking',
  'task',
  'record',
  'activity',
  'approval',
  'exception',
  'override',
  'workflow',
];

interface StoredWiChunkRecord {
  docId: string;
  chunkIndex: number;
  sectionLabel?: string;
  sectionKind?: 'heading' | 'step' | 'bullet' | 'table' | 'paragraph';
  text: string;
  tokenCount: number;
  facets?: WiChunk['facets'];
}

interface StoredBacklogThemeIndex {
  builtAt?: string;
  themeCount?: number;
  themes?: Array<{
    label?: string;
    summary?: string;
    keywords?: string[];
    signatureTerms?: string[];
  }>;
}

interface ProjectMemorySourceSnapshot {
  projectKey: string;
  domainContextHash: string;
  domainRoleCount: number;
  backlogBuiltAt?: string;
  backlogIssueCount: number;
  backlogThemeCount: number;
  goldBuiltAt?: string;
  goldStoryCount: number;
  goldTopKeys: string[];
  wiDocCount: number;
  wiDocRevisionHash: string;
  wiLatestUploadAt?: string;
}

interface ProjectMemoryQualitySignals {
  llmRefinement: 'applied' | 'fallback' | 'skipped';
  wiInsightCount: number;
  goldStoryCount: number;
  backlogThemeCount: number;
}

interface CompiledProjectMemoryArtifact {
  header: ProjectMemoryArtifactHeader;
  selection: ProjectMemorySelection;
  sourceSnapshot: ProjectMemorySourceSnapshot;
  sourceHash: string;
  qualitySignals: ProjectMemoryQualitySignals;
}

type MemoryRefiner = (input: {
  projectKey: string;
  config: TenantConfig;
  draftHeader: ProjectMemoryArtifactHeader;
  selection: ProjectMemorySelection;
}) => Promise<Partial<{
  roles: string[];
  businessObjects: string[];
  workflowCues: string[];
  arStyleHint: string;
  businessRules: string[];
  exceptionPatterns: string[];
  retrievalHints: string[];
}> | null>;

const MEMORY_REFINEMENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    roles: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 2, maxLength: 80 } },
    businessObjects: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 80 } },
    workflowCues: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 4, maxLength: 140 } },
    arStyleHint: { type: 'string', maxLength: 220 },
    businessRules: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 4, maxLength: 180 } },
    exceptionPatterns: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 4, maxLength: 180 } },
    retrievalHints: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 2, maxLength: 80 } },
  },
};

function normalizeText(value: string, maxChars?: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!maxChars || normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trimEnd();
}

function uniqueStrings(values: Array<string | null | undefined>, maxItems?: number): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeText(String(value ?? ''));
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (maxItems && output.length >= maxItems) break;
  }
  return output;
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function nextDueAtFromBuiltAt(builtAt: string): string {
  return new Date(Date.parse(builtAt) + PROJECT_MEMORY_WEEK_MS).toISOString();
}

function isoNow(): string {
  return new Date().toISOString();
}

function resolveFreshness(state: StoredProjectMemoryRefreshState | null): V2MemoryStatus {
  if (!state?.activeArtifactVersion) return 'missing';
  if (!state.nextDueAt) return 'stale';
  return Date.parse(state.nextDueAt) > Date.now() ? 'fresh' : 'stale';
}

function buildHeaderFromArtifact(
  artifact: StoredProjectMemoryArtifact | null,
  state: StoredProjectMemoryRefreshState | null,
): ProjectMemoryArtifactHeader {
  const header = artifact?.header ?? {
    roles: [],
    businessObjects: [],
    workflowCues: [],
    arStyleHint: '',
    freshness: 'missing',
    builtAt: null,
  };
  return {
    roles: header.roles ?? [],
    businessObjects: header.businessObjects ?? [],
    workflowCues: header.workflowCues ?? [],
    arStyleHint: header.arStyleHint ?? '',
    freshness: resolveFreshness(state),
    builtAt: artifact?.builtAt ?? state?.lastBuiltAt ?? null,
  };
}

function mergeHeaders(headers: ProjectMemoryArtifactHeader[]): ProjectMemoryArtifactHeader {
  if (!headers.length) {
    return {
      roles: [],
      businessObjects: [],
      workflowCues: [],
      arStyleHint: '',
      freshness: 'missing',
      builtAt: null,
    };
  }
  const freshnessRank: Record<V2MemoryStatus, number> = { missing: 0, stale: 1, fresh: 2 };
  return {
    roles: uniqueStrings(headers.flatMap((header) => header.roles), 8),
    businessObjects: uniqueStrings(headers.flatMap((header) => header.businessObjects), 10),
    workflowCues: uniqueStrings(headers.flatMap((header) => header.workflowCues), 8),
    arStyleHint: headers.map((header) => header.arStyleHint).find(Boolean) ?? '',
    freshness: headers
      .slice()
      .sort((left, right) => freshnessRank[left.freshness] - freshnessRank[right.freshness])[0]?.freshness ?? 'missing',
    builtAt: headers.map((header) => header.builtAt).filter(Boolean).sort().at(-1) ?? null,
  };
}

function mergeSelections(selections: ProjectMemorySelection[]): ProjectMemorySelection | null {
  if (!selections.length) return null;
  const merged: ProjectMemorySelection = {
    artifactVersion: uniqueStrings(selections.map((selection) => selection.artifactVersion ?? '')).join('|') || undefined,
    roles: uniqueStrings(selections.flatMap((selection) => selection.roles ?? []), 12),
    objects: uniqueStrings(selections.flatMap((selection) => selection.objects ?? []), 12),
    workflow_patterns: uniqueStrings(selections.flatMap((selection) => selection.workflow_patterns ?? []), 12),
    lifecycle_states: uniqueStrings(selections.flatMap((selection) => selection.lifecycle_states ?? []), 10),
    business_rules: uniqueStrings(selections.flatMap((selection) => selection.business_rules ?? []), 12),
    exception_patterns: uniqueStrings(selections.flatMap((selection) => selection.exception_patterns ?? []), 12),
    retrieval_hints: uniqueStrings(selections.flatMap((selection) => selection.retrieval_hints ?? []), 12),
    compact_exemplars: uniqueCompactExemplars(selections.flatMap((selection) => selection.compact_exemplars ?? []), 4),
    wi_memory: mergeWiMemory(selections.map((selection) => selection.wi_memory ?? null)),
  };
  return merged;
}

function uniqueCompactExemplars(entries: ProjectMemoryCompactExemplar[], maxItems: number): ProjectMemoryCompactExemplar[] {
  const seen = new Set<string>();
  const output: ProjectMemoryCompactExemplar[] = [];
  for (const entry of entries) {
    const key = normalizeText(entry.key || entry.summary).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push({
      key: normalizeText(entry.key, 64),
      summary: normalizeText(entry.summary, 160),
      pattern: normalizeText(entry.pattern, 240),
    });
    if (output.length >= maxItems) break;
  }
  return output;
}

function mergeWiMemory(entries: Array<ProjectMemoryWiMemory | null>): ProjectMemoryWiMemory | null {
  const present = entries.filter(Boolean) as ProjectMemoryWiMemory[];
  if (!present.length) return null;
  return {
    resolvedFacts: uniqueStrings(present.flatMap((entry) => entry.resolvedFacts), 10),
    workflowSteps: uniqueStrings(present.flatMap((entry) => entry.workflowSteps), 10),
    businessRules: uniqueStrings(present.flatMap((entry) => entry.businessRules), 10),
    exceptions: uniqueStrings(present.flatMap((entry) => entry.exceptions), 10),
    mustCoverBehaviors: uniqueStrings(present.flatMap((entry) => entry.mustCoverBehaviors), 10),
  };
}

function sliceTypesForStage(stage: 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair'): ProjectMemorySliceType[] {
  switch (stage) {
    case 'discover':
      return ['roles', 'workflow_patterns', 'business_rules', 'retrieval_hints'];
    case 'coverage_repair':
      return ['roles', 'workflow_patterns', 'business_rules', 'exception_patterns', 'compact_exemplars'];
    case 'final_generation':
      return ['roles', 'objects', 'workflow_patterns', 'lifecycle_states', 'business_rules', 'exception_patterns', 'compact_exemplars', 'wi_memory'];
    case 'discovery_synthesis':
    default:
      return PROJECT_MEMORY_SLICE_TYPES;
  }
}

function extractObjectPhrases(text: string): string[] {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const pattern = new RegExp(`\\b([a-z0-9]+(?:\\s+[a-z0-9]+){0,2}\\s+(?:${OBJECT_KEYWORDS.join('|')})s?)\\b`, 'gi');
  const matches: string[] = [];
  for (const match of normalized.matchAll(pattern)) {
    matches.push(normalizeText(match[1] ?? '', 80));
  }
  return uniqueStrings(matches, 12);
}

function formatDomainRoles(config: TenantConfig, projectKey: string): string[] {
  return uniqueStrings(
    getCombinedPersonaRoles(config, [projectKey]).map((row) => {
      const role = normalizeText(String(row.role ?? ''), 80);
      const activities = normalizeText(String(row.activities ?? ''), 120);
      return activities ? `${role}: ${activities}` : role;
    }),
    10,
  );
}

function hydrateStoredChunks(docs: WiDoc[], storedChunks: StoredWiChunkRecord[]): WiChunk[] {
  const docsById = new Map(docs.map((doc) => [doc.docId, doc]));
  return storedChunks.map((chunk) => {
    const doc = docsById.get(chunk.docId);
    return {
      docId: chunk.docId,
      filename: doc?.filename ?? 'Unknown document',
      revision: doc?.revision ?? '',
      chunkIndex: Number(chunk.chunkIndex ?? 0),
      sectionLabel: chunk.sectionLabel,
      sectionKind: chunk.sectionKind,
      text: normalizeText(chunk.text),
      tokenCount: Number(chunk.tokenCount ?? Math.ceil(String(chunk.text ?? '').length / 4)),
      facets: chunk.facets,
    };
  });
}

async function loadProjectWiInputs(projectKey: string): Promise<{ docs: WiDoc[]; chunks: WiChunk[] }> {
  const docs = await listDocs(projectKey);
  if (!docs.length) return { docs: [], chunks: [] };
  const chunkSets = await Promise.all(
    docs.map(async (doc) => {
      const stored = await objectRead<StoredWiChunkRecord[]>(KEYS.wiChunksForDoc(doc.docId));
      return Array.isArray(stored) ? stored : [];
    }),
  );
  return {
    docs,
    chunks: hydrateStoredChunks(docs, chunkSets.flat()),
  };
}

async function buildProjectSourceSnapshot(
  projectKey: string,
  config: TenantConfig,
): Promise<ProjectMemorySourceSnapshot> {
  const [backlogInfo, goldPool, wiDocs] = await Promise.all([
    getBacklogCacheInfo(projectKey).catch(() => ({
      projectKey,
      builtAt: undefined,
      issueCount: 0,
      themeCount: 0,
    })),
    getGoldStoryPool(projectKey).catch(() => null),
    listDocs(projectKey).catch(() => []),
  ]);
  const domainContext = buildCombinedDomainContext(config, [projectKey]);
  const domainRoles = getCombinedPersonaRoles(config, [projectKey]);
  const wiFingerprint = wiDocs
    .map((doc) => `${doc.docId}:${doc.revision}:${doc.uploadedAt}`)
    .sort()
    .join('|');
  return {
    projectKey,
    domainContextHash: hashString(`${domainContext}||${JSON.stringify(domainRoles)}`),
    domainRoleCount: domainRoles.length,
    backlogBuiltAt: (backlogInfo as { builtAt?: string }).builtAt,
    backlogIssueCount: Number((backlogInfo as { issueCount?: number }).issueCount ?? 0),
    backlogThemeCount: Number((backlogInfo as { themeCount?: number }).themeCount ?? 0),
    goldBuiltAt: goldPool?.builtAt,
    goldStoryCount: goldPool?.entries?.length ?? 0,
    goldTopKeys: (goldPool?.entries ?? []).slice(0, 5).map((entry) => entry.key),
    wiDocCount: wiDocs.length,
    wiDocRevisionHash: hashString(wiFingerprint),
    wiLatestUploadAt: wiDocs.map((doc) => doc.uploadedAt).sort().at(-1),
  };
}

function isMaterialSourceChange(
  previous: ProjectMemorySourceSnapshot | null,
  current: ProjectMemorySourceSnapshot,
): boolean {
  if (!previous) return true;
  if (previous.domainContextHash !== current.domainContextHash) return true;
  if (previous.domainRoleCount !== current.domainRoleCount) return true;
  if (previous.backlogBuiltAt !== current.backlogBuiltAt) return true;
  if (previous.backlogIssueCount !== current.backlogIssueCount) return true;
  if (previous.backlogThemeCount !== current.backlogThemeCount) return true;
  if (previous.goldBuiltAt !== current.goldBuiltAt) return true;
  if (previous.goldStoryCount !== current.goldStoryCount) return true;
  if (previous.wiDocCount !== current.wiDocCount) return true;
  if (previous.wiDocRevisionHash !== current.wiDocRevisionHash) return true;
  return false;
}

async function defaultMemoryRefiner(input: {
  projectKey: string;
  config: TenantConfig;
  draftHeader: ProjectMemoryArtifactHeader;
  selection: ProjectMemorySelection;
}): Promise<Partial<{
  roles: string[];
  businessObjects: string[];
  workflowCues: string[];
  arStyleHint: string;
  businessRules: string[];
  exceptionPatterns: string[];
  retrievalHints: string[];
}> | null> {
  const effectiveConfig = {
    ...input.config,
    generatorConfig: resolveEffectiveGeneratorConfig(input.config.generatorConfig),
  };
  const compactPayload = JSON.stringify({
    header: {
      roles: input.draftHeader.roles,
      businessObjects: input.draftHeader.businessObjects,
      workflowCues: input.draftHeader.workflowCues,
      arStyleHint: input.draftHeader.arStyleHint,
    },
    slices: {
      business_rules: input.selection.business_rules ?? [],
      exception_patterns: input.selection.exception_patterns ?? [],
      retrieval_hints: input.selection.retrieval_hints ?? [],
      compact_exemplars: (input.selection.compact_exemplars ?? []).map((entry) => ({
        key: entry.key,
        summary: entry.summary,
      })),
    },
  });

  return await callLlmJson({
    provider: effectiveConfig.generatorConfig.provider,
    model: effectiveConfig.generatorConfig.themeModel,
    anthropicApiKey: effectiveConfig.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: effectiveConfig.generatorConfig.anthropicBaseUrl,
    geminiApiKey: effectiveConfig.generatorConfig.geminiApiKey,
    geminiBaseUrl: effectiveConfig.generatorConfig.geminiBaseUrl,
    openaiApiKey: effectiveConfig.generatorConfig.openaiApiKey,
    openaiBaseUrl: effectiveConfig.generatorConfig.openaiBaseUrl,
    fireworksApiKey: effectiveConfig.generatorConfig.fireworksApiKey,
    fireworksBaseUrl: effectiveConfig.generatorConfig.fireworksBaseUrl,
    azureOpenAIApiKey: effectiveConfig.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: effectiveConfig.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: effectiveConfig.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: effectiveConfig.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: effectiveConfig.generatorConfig.ollamaBaseUrl,
    groqApiKey: effectiveConfig.generatorConfig.groqApiKey,
    groqBaseUrl: effectiveConfig.generatorConfig.groqBaseUrl,
    modelCatalogs: effectiveConfig.generatorConfig.modelCatalogs,
    jsonSchema: MEMORY_REFINEMENT_SCHEMA,
    maxTokens: 700,
    reasoningEffort: 'none',
    systemPrompt: 'Normalize compiled project memory into a concise backlog-grounding artifact. Keep business wording concrete. Return JSON only.',
    userMessage: `Project key: ${input.projectKey}\n\nDraft compiled memory:\n${compactPayload}`,
  });
}

function buildCompactExemplars(pool: GoldStoryPool | null): ProjectMemoryCompactExemplar[] {
  if (!pool?.entries?.length) return [];
  return pool.entries.slice(0, 3).map((entry) => ({
    key: entry.key,
    summary: normalizeText(entry.summary, 160),
    pattern: normalizeText(entry.arSample, 220),
  }));
}

function buildWiMemory(chunks: WiChunk[]): { wiMemory: ProjectMemoryWiMemory | null; wiInsightCount: number } {
  if (!chunks.length) return { wiMemory: null, wiInsightCount: 0 };
  const artifact = buildWorkInstructionInsightArtifact(chunks);
  return {
    wiMemory: {
      resolvedFacts: uniqueStrings(artifact.resolvedFacts.map((item) => item.text), 10),
      workflowSteps: uniqueStrings(artifact.workflowSteps.map((item) => item.text), 10),
      businessRules: uniqueStrings(
        [
          ...artifact.businessRules.map((item) => item.text),
          ...artifact.sequencingRules.map((item) => item.text),
          ...artifact.splitVsSingleCaseRules.map((item) => item.text),
        ],
        10,
      ),
      exceptions: uniqueStrings(artifact.exceptions.map((item) => item.text), 10),
      mustCoverBehaviors: uniqueStrings(artifact.mustCoverBehaviors.map((item) => item.text), 10),
    },
    wiInsightCount: getWorkInstructionInsightCount(artifact),
  };
}

function selectionToHeader(selection: ProjectMemorySelection, arStyleHint: string, builtAt: string): ProjectMemoryArtifactHeader {
  return {
    roles: uniqueStrings(selection.roles ?? [], 8),
    businessObjects: uniqueStrings(selection.objects ?? [], 8),
    workflowCues: uniqueStrings(
      [
        ...(selection.workflow_patterns ?? []),
        ...(selection.business_rules ?? []).slice(0, 3),
      ],
      8,
    ),
    arStyleHint: normalizeText(arStyleHint, 200),
    freshness: 'fresh',
    builtAt,
  };
}

export async function compileProjectMemoryArtifact(
  input: {
    projectKey: string;
    config: TenantConfig;
    refiner?: MemoryRefiner;
  },
): Promise<CompiledProjectMemoryArtifact> {
  const builtAt = isoNow();
  const [sourceSnapshot, wiInputs, backlogThemeIndex, goldPool, domainPatterns] = await Promise.all([
    buildProjectSourceSnapshot(input.projectKey, input.config),
    loadProjectWiInputs(input.projectKey),
    objectRead<StoredBacklogThemeIndex>(KEYS.backlogThemes(input.projectKey)).catch(() => null),
    getGoldStoryPool(input.projectKey).catch(() => null),
    objectRead<DomainPatterns>(KEYS.domainPatterns(input.projectKey)).catch(() => null),
  ]);
  const domainContext = buildCombinedDomainContext(input.config, [input.projectKey]);
  const configuredRoles = formatDomainRoles(input.config, input.projectKey);
  const compactExemplars = buildCompactExemplars(goldPool);
  const { wiMemory, wiInsightCount } = buildWiMemory(wiInputs.chunks);
  const themeLabels = uniqueStrings((backlogThemeIndex?.themes ?? []).map((theme) => theme.label), 8);
  const themeSummaries = uniqueStrings((backlogThemeIndex?.themes ?? []).map((theme) => theme.summary), 8);
  const themeKeywords = uniqueStrings((backlogThemeIndex?.themes ?? []).flatMap((theme) => [...(theme.keywords ?? []), ...(theme.signatureTerms ?? [])]), 12);
  const selection: ProjectMemorySelection = {
    roles: uniqueStrings(
      [
        ...configuredRoles.map((row) => row.split(':')[0] ?? row),
        ...(domainPatterns?.roles ?? []),
      ],
      10,
    ),
    objects: uniqueStrings(
      [
        ...(domainPatterns?.coreTerminology ?? []),
        ...themeKeywords,
        ...extractObjectPhrases(domainContext),
        ...extractObjectPhrases((wiMemory?.resolvedFacts ?? []).join('\n')),
      ],
      12,
    ),
    workflow_patterns: uniqueStrings(
      [
        ...themeLabels,
        ...themeSummaries,
        ...(wiMemory?.workflowSteps ?? []),
      ],
      12,
    ),
    lifecycle_states: uniqueStrings(
      (wiMemory?.resolvedFacts ?? []).filter((item) => /\b(draft|approved|rejected|returned|cancelled|completed|pending|active)\b/i.test(item)),
      10,
    ),
    business_rules: uniqueStrings(wiMemory?.businessRules ?? [], 12),
    exception_patterns: uniqueStrings(wiMemory?.exceptions ?? [], 12),
    retrieval_hints: uniqueStrings(
      [
        ...themeKeywords,
        ...(domainPatterns?.coreTerminology ?? []),
        ...compactExemplars.flatMap((entry) => extractObjectPhrases(`${entry.summary} ${entry.pattern}`)),
      ],
      12,
    ),
    compact_exemplars: compactExemplars,
    wi_memory: wiMemory,
  };

  let arStyleHint = normalizeText(domainPatterns?.arStyle ?? '', 200);
  let llmRefinement: ProjectMemoryQualitySignals['llmRefinement'] = 'skipped';
  const draftHeader = selectionToHeader(selection, arStyleHint, builtAt);
  try {
    const refiner = input.refiner ?? defaultMemoryRefiner;
    const refined = await refiner({
      projectKey: input.projectKey,
      config: input.config,
      draftHeader,
      selection,
    });
    if (refined) {
      selection.roles = uniqueStrings([...(refined.roles ?? []), ...(selection.roles ?? [])], 10);
      selection.objects = uniqueStrings([...(refined.businessObjects ?? []), ...(selection.objects ?? [])], 12);
      selection.workflow_patterns = uniqueStrings([...(refined.workflowCues ?? []), ...(selection.workflow_patterns ?? [])], 12);
      selection.business_rules = uniqueStrings([...(refined.businessRules ?? []), ...(selection.business_rules ?? [])], 12);
      selection.exception_patterns = uniqueStrings([...(refined.exceptionPatterns ?? []), ...(selection.exception_patterns ?? [])], 12);
      selection.retrieval_hints = uniqueStrings([...(refined.retrievalHints ?? []), ...(selection.retrieval_hints ?? [])], 12);
      if (refined.arStyleHint) arStyleHint = normalizeText(refined.arStyleHint, 200);
      llmRefinement = 'applied';
    }
  } catch {
    llmRefinement = 'fallback';
  }

  const header = selectionToHeader(selection, arStyleHint, builtAt);
  const sourceHash = hashString(JSON.stringify(sourceSnapshot));
  return {
    header,
    selection,
    sourceSnapshot,
    sourceHash,
    qualitySignals: {
      llmRefinement,
      wiInsightCount,
      goldStoryCount: goldPool?.entries?.length ?? 0,
      backlogThemeCount: backlogThemeIndex?.themes?.length ?? 0,
    },
  };
}

export async function refreshProjectMemory(
  input: {
    projectKey: string;
    config: TenantConfig;
    trigger: ProjectMemoryRefreshTrigger;
    force?: boolean;
    refiner?: MemoryRefiner;
  },
): Promise<{ refreshed: boolean; reason: 'refreshed' | 'skipped_threshold'; artifactVersion?: string }> {
  const state = await getProjectMemoryRefreshState(input.projectKey);
  await upsertProjectMemoryRefreshState({
    projectKey: input.projectKey,
    status: 'running',
    lastError: null,
  });
  const compiled = await compileProjectMemoryArtifact({
    projectKey: input.projectKey,
    config: input.config,
    refiner: input.refiner,
  });
  const previousSnapshot = state?.activeArtifactVersion
    ? ((await getActiveProjectMemoryArtifact(input.projectKey))?.sourceSnapshot as ProjectMemorySourceSnapshot | null)
    : null;
  if (!input.force && input.trigger === 'threshold' && !isMaterialSourceChange(previousSnapshot, compiled.sourceSnapshot)) {
    await upsertProjectMemoryRefreshState({
      projectKey: input.projectKey,
      status: 'ready',
      lastError: null,
    });
    return { refreshed: false, reason: 'skipped_threshold', artifactVersion: state?.activeArtifactVersion ?? undefined };
  }

  const artifactVersion = `${compiled.sourceHash}_${Date.now().toString(36)}`;
  await saveProjectMemoryArtifact({
    projectKey: input.projectKey,
    artifactVersion,
    compilerVersion: PROJECT_MEMORY_COMPILER_VERSION,
    builtAt: compiled.header.builtAt ?? isoNow(),
    sourceSnapshot: compiled.sourceSnapshot as unknown as Record<string, unknown>,
    qualitySignals: compiled.qualitySignals as unknown as Record<string, unknown>,
    header: compiled.header,
    selection: {
      ...compiled.selection,
      artifactVersion,
    },
    sourceHash: compiled.sourceHash,
    trigger: input.trigger,
    nextDueAt: nextDueAtFromBuiltAt(compiled.header.builtAt ?? isoNow()),
  });
  return { refreshed: true, reason: 'refreshed', artifactVersion };
}

export async function markProjectMemoryRefreshError(projectKey: string, message: string): Promise<void> {
  await upsertProjectMemoryRefreshState({
    projectKey,
    status: 'error',
    lastError: normalizeText(message, 500),
  });
}

export { getProjectMemoryRefreshState } from './v2-sql';

export async function getProjectMemoryHeaderForProjects(projectKeys: string[]): Promise<{
  header: ProjectMemoryArtifactHeader;
  status: V2MemoryStatus;
  artifactVersion?: string;
  details: StoredProjectMemoryRefreshState[];
}> {
  const headers: ProjectMemoryArtifactHeader[] = [];
  const details: StoredProjectMemoryRefreshState[] = [];
  const versions: string[] = [];
  for (const projectKey of uniqueStrings(projectKeys)) {
    const [state, artifact] = await Promise.all([
      getProjectMemoryRefreshState(projectKey),
      getActiveProjectMemoryArtifact(projectKey),
    ]);
    if (state) details.push(state);
    if (artifact?.artifactVersion) versions.push(artifact.artifactVersion);
    headers.push(buildHeaderFromArtifact(artifact, state));
  }
  const merged = mergeHeaders(headers);
  return {
    header: merged,
    status: merged.freshness,
    artifactVersion: uniqueStrings(versions).join('|') || undefined,
    details,
  };
}

export async function getProjectMemorySelectionForStage(
  projectKeys: string[],
  stage: 'discover' | 'discovery_synthesis' | 'final_generation' | 'coverage_repair',
): Promise<ProjectMemorySelection | null> {
  const sliceTypes = sliceTypesForStage(stage);
  const selections: ProjectMemorySelection[] = [];
  for (const projectKey of uniqueStrings(projectKeys)) {
    const selection = await getActiveProjectMemorySelection(projectKey, sliceTypes);
    if (selection?.selection) selections.push(selection.selection);
  }
  return mergeSelections(selections);
}

export function buildV2EvidenceBundleFromProjectMemory(input: {
  domainContext?: string;
  memoryHeader?: ProjectMemoryArtifactHeader;
  memorySelection?: ProjectMemorySelection | null;
}): {
  domainContext?: string;
  domainRoles?: string[];
  similarStoriesText?: string;
  wiContextText?: string;
} {
  const selection = input.memorySelection;
  const header = input.memoryHeader;
  const exemplarText = (selection?.compact_exemplars ?? [])
    .map((entry) => `${entry.summary}: ${entry.pattern}`)
    .join('\n');
  const wiMemory = selection?.wi_memory;
  const wiContextText = uniqueStrings([
    ...(selection?.workflow_patterns ?? []),
    ...(selection?.business_rules ?? []),
    ...(selection?.exception_patterns ?? []),
    ...(selection?.lifecycle_states ?? []),
    ...(wiMemory?.workflowSteps ?? []),
    ...(wiMemory?.businessRules ?? []),
    ...(wiMemory?.exceptions ?? []),
    ...(wiMemory?.mustCoverBehaviors ?? []),
  ], 18).join('\n');
  const similarStoriesText = uniqueStrings([
    ...(selection?.retrieval_hints ?? []),
    ...(selection?.objects ?? []),
    exemplarText,
  ], 18).join('\n');
  return {
    domainContext: uniqueStrings([
      input.domainContext ?? '',
      ...(header?.workflowCues ?? []),
      header?.arStyleHint ?? '',
    ]).join('\n'),
    domainRoles: uniqueStrings([
      ...(header?.roles ?? []),
      ...(selection?.roles ?? []),
    ], 12),
    similarStoriesText,
    wiContextText,
  };
}

export async function queueProjectMemoryRefresh(
  projectKey: string,
  trigger: ProjectMemoryRefreshTrigger,
  options?: { requestedBy?: string; force?: boolean },
): Promise<boolean> {
  const state = await getProjectMemoryRefreshState(projectKey);
  if (!options?.force && (state?.status === 'queued' || state?.status === 'running')) {
    return false;
  }
  await upsertProjectMemoryRefreshState({
    projectKey,
    status: 'queued',
    lastTrigger: trigger,
    lastError: null,
  });
  const queue = new Queue({ key: PROJECT_MEMORY_QUEUE_KEY });
  await queue.push({
    body: {
      projectKey,
      trigger,
      requestedAt: isoNow(),
      requestedBy: options?.requestedBy ?? 'system',
      force: Boolean(options?.force),
    },
  });
  return true;
}

export async function queueProjectMemoryRefreshForProjects(
  projectKeys: string[],
  trigger: ProjectMemoryRefreshTrigger,
  options?: { requestedBy?: string; force?: boolean },
): Promise<void> {
  for (const projectKey of uniqueStrings(projectKeys)) {
    await queueProjectMemoryRefresh(projectKey, trigger, options);
  }
}

export async function listProjectKeysForProjectMemoryCompiler(config: TenantConfig): Promise<string[]> {
  const configured = [
    ...(config.domainContexts ?? []).map((entry) => entry.projectKey),
    ...(config.backlogStatusScopes ?? []).map((entry) => entry.projectKey),
    ...(config.goldExampleConfigs ?? []).map((entry) => entry.projectKey),
  ];
  const docs = await objectRead<WiDoc[]>(KEYS.wiDocs).catch(() => null);
  const docProjects = (docs ?? []).flatMap((doc) => doc.targetProjects ?? ['*']);
  return uniqueStrings([...configured, ...docProjects]).filter((key) => key && key !== '*');
}

export async function queueDueProjectMemoryRefreshes(config: TenantConfig): Promise<string[]> {
  const allProjectKeys = await listProjectKeysForProjectMemoryCompiler(config);
  const refreshStates = await listProjectMemoryRefreshStates(Math.max(250, allProjectKeys.length + 20));
  const byProject = new Map(refreshStates.map((state) => [state.projectKey, state]));
  const queued: string[] = [];
  for (const projectKey of allProjectKeys) {
    const state = byProject.get(projectKey);
    const freshness = resolveFreshness(state ?? null);
    if (freshness === 'fresh' && state?.status === 'ready') continue;
    const didQueue = await queueProjectMemoryRefresh(projectKey, 'weekly');
    if (didQueue) queued.push(projectKey);
  }
  return queued;
}
