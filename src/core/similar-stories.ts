/**
 * Project backlog retrieval with sharded project-level caching.
 *
 * Uses deployed Jira issues from the selected project as the main context pool.
 * Retrieval is cheap-first: adaptive theme shortlist -> shard load -> lexical
 * scoring -> optional LLM rerank on a small shortlist only.
 */

import { asApp, assumeTrustedRoute } from '@forge/api';
import { callLlmJson } from './llm';
import { buildRerankPrompt } from './prompts';
import { ClarifyAnswer, ProjectGoldExampleConfig, SimilarStory, TenantConfig } from '../types';
import { objectDelete, objectRead, objectWrite, KEYS } from '../services/cache';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import { ANCHOR_EXAMPLES, formatAnchorBundleText } from './ar-anchor-bundle';

interface BacklogDoc {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  updated: string;
  labels?: string[];
}

interface LegacyBacklogIndexCache {
  projectKey: string;
  builtAt: string;
  issueCount: number;
  docs: BacklogDoc[];
}

interface BacklogShard {
  projectKey: string;
  shardId: string;
  builtAt: string;
  issueCount: number;
  docs: BacklogDoc[];
}

interface BacklogShardMeta {
  shardId: string;
  cacheKey: string;
  issueCount: number;
  rawBytes: number;
  minUpdated?: string;
  maxUpdated?: string;
  firstIssueKey?: string;
  lastIssueKey?: string;
}

interface BacklogManifest {
  schemaVersion: 2;
  projectKey: string;
  builtAt: string;
  issueCount: number;
  shardCount: number;
  shards: BacklogShardMeta[];
  themeBuiltAt?: string;
  themeCount: number;
  themeBudget: number;
}

interface BacklogTheme {
  id: string;
  label: string;
  summary: string;
  keywords: string[];
  docCount: number;
  shardIds: string[];
  sampleIssueKeys: string[];
  updatedRange: {
    from?: string;
    to?: string;
  };
  signatureTerms: string[];
}

interface BacklogThemeIndex {
  schemaVersion: 1;
  projectKey: string;
  builtAt: string;
  issueCount: number;
  targetThemeCount: number;
  themes: BacklogTheme[];
}

interface BacklogIndexInfo {
  projectKey: string;
  builtAt?: string;
  issueCount: number;
  stale: boolean;
  shardCount: number;
  themeCount: number;
  themeBuiltAt?: string;
  legacyFallback: boolean;
}

export interface GoldStoryEntry {
  key: string;
  summary: string;
  score: number;
  arSample: string;
  labels?: string[];
}

export interface GoldStoryPool {
  projectKey: string;
  builtAt: string;
  entries: GoldStoryEntry[];
}

export interface DomainPatterns {
  roles: string[];
  coreTerminology: string[];
  arStyle: string;
}

interface LoadedBacklogIndex {
  manifest?: BacklogManifest;
  themeIndex?: BacklogThemeIndex | null;
  legacy?: LegacyBacklogIndexCache | null;
}

interface SearchJqlResponse {
  issues?: Array<{ key: string; fields: Record<string, unknown> }>;
  total?: number;
  nextPageToken?: string;
  isLast?: boolean;
}

interface ThemeCandidate {
  label: string;
  score: number;
  docCount: number;
  shardIds: Set<string>;
  sampleIssueKeys: string[];
  sampleSummaries: string[];
  updatedRange: { from?: string; to?: string };
  keywordScores: Map<string, number>;
}

interface SimilarStoryQuery {
  requirement: string;
  attachmentText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKey?: string;
  maxResults?: number;
}

export interface BacklogCacheDiagnostics {
  projectKey: string;
  configuredStatuses: string[];
  jqlUsed: string;
  totalProjectIssues: number;
  doneCategoryIssues: number;
  matchingScopeIssues: number;
  likelyReason: string;
}

export const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SUMMARY_CHARS = 180;
const MAX_DESCRIPTION_CHARS = 600;
const MAX_ACCEPTANCE_CRITERIA_CHARS = 600;
const MAX_SHARD_RAW_BYTES = 170 * 1024;
const MAX_THEME_COUNT = 120;
const MIN_THEME_COUNT = 24;
const MAX_QUERY_THEMES = 6;
const MAX_QUERY_SHARDS = 12;
const FALLBACK_SHARDS = 3;
const TOP_THEME_TERMS_PER_DOC = 8;
const MAX_THEME_KEYWORDS = 6;
const MAX_THEME_SIGNATURE_TERMS = 8;
const THEME_NORMALIZATION_BATCH_SIZE = 20;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'not', 'into', 'onto', 'from', 'with', 'without',
  'that', 'this', 'these', 'those', 'than', 'then', 'there', 'their', 'they', 'them',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'for', 'of', 'to', 'in', 'on', 'at',
  'as', 'by', 'it', 'its', 'if', 'when', 'while', 'after', 'before', 'during', 'through',
  'over', 'under', 'only', 'should', 'must', 'can', 'could', 'would', 'need', 'needs',
  'user', 'users', 'record', 'records', 'data', 'details', 'detail', 'field', 'fields',
  'screen', 'page', 'system', 'service', 'services', 'item', 'items', 'saved', 'save',
  'allow', 'allows', 'able', 'status', 'statuses',
]);

export async function findSimilarStories(
  requirementOrQuery: string | SimilarStoryQuery,
  maybeConfig?: TenantConfig,
  maybeProjectKey = '*',
): Promise<SimilarStory[]> {
  const query = typeof requirementOrQuery === 'string'
    ? {
        requirement: requirementOrQuery,
        config: maybeConfig as TenantConfig,
        projectKey: maybeProjectKey,
      }
    : requirementOrQuery;

  const requirement = query.requirement?.trim() ?? '';
  const config = query.config;
  const projectKey = query.projectKey ?? '*';
  const maxResults = query.maxResults ?? 12;

  if (!requirement || !config || !projectKey || projectKey === '*') {
    return [];
  }

  try {
    const index = await ensureBacklogIndex(projectKey);
    let docs: BacklogDoc[] = [];

    if (index.manifest) {
      const queryText = buildSimilarityQueryText({
        requirement,
        attachmentText: query.attachmentText,
        clarifyAnswers: query.clarifyAnswers,
      });

      const shortlistedShardIds = shortlistShardIds(queryText, index.themeIndex, index.manifest);
      docs = shortlistedShardIds.length
        ? await loadDocsForShards(projectKey, shortlistedShardIds)
        : await loadFallbackDocs(projectKey, index.manifest);

      if (docs.length < 30) {
        const fallbackDocs = await loadFallbackDocs(projectKey, index.manifest, FALLBACK_SHARDS + 2);
        const seenKeys = new Set(docs.map(doc => doc.key));
        for (const doc of fallbackDocs) {
          if (seenKeys.has(doc.key)) continue;
          docs.push(doc);
          seenKeys.add(doc.key);
        }
      }
    } else if (index.legacy?.docs?.length) {
      docs = index.legacy.docs;
    }

    if (!docs.length) return [];

    const queryText = buildSimilarityQueryText({
      requirement,
      attachmentText: query.attachmentText,
      clarifyAnswers: query.clarifyAnswers,
    });
    const candidates = lexicalRetrieve(queryText, docs).slice(0, 24);
    if (!candidates.length) return [];

    let ranked = candidates;
    const shouldSkipRerank =
      (candidates[0]?.relevanceScore ?? 0) >= 5
      && ((candidates[5]?.relevanceScore ?? 0) <= (candidates[0]?.relevanceScore ?? 0) * 0.55);
    if (config.similarityConfig.useLlmRerank && candidates.length > 5 && !shouldSkipRerank) {
      ranked = await rerankWithLlm(requirement, candidates, config.generatorConfig.themeModel);
    }

    const threshold = config.similarityConfig?.threshold ?? 0;
    const filtered = threshold > 0
      ? ranked.filter(item => (item.relevanceScore ?? 0) >= threshold)
      : ranked;

    const deduped = dedupeBacklogDocsBySimilarSummary(filtered);

    const baseUrl = await getJiraBaseUrl();
    return deduped.slice(0, maxResults).map(item => ({
      key: item.key,
      summary: item.summary,
      description: item.description,
      acceptanceCriteria: item.acceptanceCriteria,
      relevanceScore: item.relevanceScore,
      url: `${baseUrl}/browse/${item.key}`,
    }));
  } catch (err) {
    console.warn('[similar-stories] Backlog retrieval failed:', err);
    return [];
  }
}

async function ensureBacklogIndex(projectKey: string): Promise<LoadedBacklogIndex> {
  const manifest = await objectRead<BacklogManifest>(KEYS.backlogManifest(projectKey));
  if (manifest && Array.isArray(manifest.shards)) {
    const themeIndex = await objectRead<BacklogThemeIndex>(KEYS.backlogThemes(projectKey));
    return { manifest, themeIndex };
  }

  const legacy = await objectRead<LegacyBacklogIndexCache>(KEYS.backlogIndex(projectKey));
  if (legacy?.docs?.length) {
    return { legacy };
  }
  return {};
}

export async function getBacklogCacheInfo(projectKey: string): Promise<BacklogIndexInfo> {
  const manifest = await objectRead<BacklogManifest>(KEYS.backlogManifest(projectKey));
  if (manifest && Array.isArray(manifest.shards)) {
    return {
      projectKey,
      builtAt: manifest.builtAt,
      issueCount: manifest.issueCount ?? 0,
      stale: !manifest.builtAt || Date.now() - new Date(manifest.builtAt).getTime() >= INDEX_TTL_MS,
      shardCount: manifest.shardCount ?? manifest.shards.length,
      themeCount: manifest.themeCount ?? 0,
      themeBuiltAt: manifest.themeBuiltAt,
      legacyFallback: false,
    };
  }

  const legacy = await objectRead<LegacyBacklogIndexCache>(KEYS.backlogIndex(projectKey));
  if (legacy?.docs?.length) {
    return {
      projectKey,
      builtAt: legacy.builtAt,
      issueCount: legacy.issueCount ?? legacy.docs.length,
      stale: !legacy.builtAt || Date.now() - new Date(legacy.builtAt).getTime() >= INDEX_TTL_MS,
      shardCount: 0,
      themeCount: 0,
      themeBuiltAt: undefined,
      legacyFallback: true,
    };
  }

  return {
    projectKey,
    issueCount: 0,
    stale: true,
    shardCount: 0,
    themeCount: 0,
    themeBuiltAt: undefined,
    legacyFallback: false,
  };
}

export async function refreshBacklogCache(projectKey: string, config: TenantConfig): Promise<BacklogIndexInfo> {
  const previousManifest = await objectRead<BacklogManifest>(KEYS.backlogManifest(projectKey));
  const builtAt = new Date().toISOString();
  const docs = await buildBacklogDocs(projectKey, config);
  const shards = buildBacklogShards(projectKey, docs, builtAt);
  const themeIndex = await buildBacklogThemeIndex(projectKey, docs, shards, config, builtAt);
  const manifest: BacklogManifest = {
    schemaVersion: 2,
    projectKey,
    builtAt,
    issueCount: docs.length,
    shardCount: shards.length,
    shards: shards.map(shard => ({
      shardId: shard.shardId,
      cacheKey: KEYS.backlogDocsShard(projectKey, shard.shardId),
      issueCount: shard.issueCount,
      rawBytes: Buffer.byteLength(JSON.stringify(shard.docs), 'utf8'),
      minUpdated: shard.docs[shard.docs.length - 1]?.updated,
      maxUpdated: shard.docs[0]?.updated,
      firstIssueKey: shard.docs[0]?.key,
      lastIssueKey: shard.docs[shard.docs.length - 1]?.key,
    })),
    themeBuiltAt: themeIndex.builtAt,
    themeCount: themeIndex.themes.length,
    themeBudget: themeIndex.targetThemeCount,
  };

  const writtenShardKeys: string[] = [];
  for (const shard of shards) {
    const cacheKey = KEYS.backlogDocsShard(projectKey, shard.shardId);
    const persisted = await objectWrite(cacheKey, shard);
    if (!persisted) {
      for (const key of writtenShardKeys) {
        await objectDelete(key);
      }
      throw new Error(`Backlog shard ${shard.shardId} for ${projectKey} is too large to store.`);
    }
    writtenShardKeys.push(cacheKey);
  }

  if (!(await objectWrite(KEYS.backlogThemes(projectKey), themeIndex))) {
    throw new Error(`Backlog theme index for ${projectKey} is too large to store.`);
  }

  if (!(await objectWrite(KEYS.backlogManifest(projectKey), manifest))) {
    throw new Error(`Backlog manifest for ${projectKey} is too large to store.`);
  }

  if (previousManifest?.shards?.length) {
    const nextShardIds = new Set(shards.map(shard => shard.shardId));
    for (const shard of previousManifest.shards) {
      if (!nextShardIds.has(shard.shardId)) {
        await objectDelete(KEYS.backlogDocsShard(projectKey, shard.shardId));
      }
    }
  }

  // Build and persist gold story pool (best-scored exemplars for AR generation)
  const configuredGold = findGoldConfigForProject(projectKey, config.goldExampleConfigs);
  const pool = selectGoldStories(projectKey, docs, builtAt, configuredGold?.label);
  await objectWrite(KEYS.goldStoryPool(projectKey), pool);

  return {
    projectKey,
    builtAt: manifest.builtAt,
    issueCount: manifest.issueCount,
    stale: false,
    shardCount: manifest.shardCount,
    themeCount: manifest.themeCount,
    themeBuiltAt: manifest.themeBuiltAt,
    legacyFallback: false,
  };
}

function rankGoldDocs(docs: BacklogDoc[]): GoldStoryEntry[] {
  const MAX_GOLD = 15;
  const scored = docs
    .map((doc) => {
      const ac = String(doc.acceptanceCriteria ?? '');
      const result = scoreExemplarQuality(ac);
      return { doc, score: result.score, hardGatePassed: result.hardGatePassed };
    })
    .filter((r) => r.hardGatePassed && r.score >= EXEMPLAR_QUALITY_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_GOLD);

  const entries: GoldStoryEntry[] = scored.map((r) => ({
    key: r.doc.key,
    summary: r.doc.summary,
    score: r.score,
    arSample: r.doc.acceptanceCriteria.slice(0, 1200),
    labels: r.doc.labels,
  }));

  return entries;
}

function selectGoldStories(
  projectKey: string,
  docs: BacklogDoc[],
  builtAt: string,
  preferredLabel?: string,
): GoldStoryPool {
  const normalizedLabel = String(preferredLabel ?? '').trim().toLowerCase();
  const labelledDocs = normalizedLabel
    ? docs.filter((doc) => (doc.labels ?? []).some((label) => label.toLowerCase() === normalizedLabel))
    : [];
  const entries = rankGoldDocs(labelledDocs.length ? labelledDocs : docs);

  return { projectKey, builtAt, entries };
}

export async function getGoldStoryPool(projectKey: string): Promise<GoldStoryPool | null> {
  return objectRead<GoldStoryPool>(KEYS.goldStoryPool(projectKey));
}

export function findGoldConfigForProject(
  projectKey: string,
  goldConfigs: ProjectGoldExampleConfig[] | undefined,
): ProjectGoldExampleConfig | null {
  if (!goldConfigs?.length) return null;
  return goldConfigs.find((c) => c.projectKey === projectKey)
    || goldConfigs.find((c) => c.projectKey === '*')
    || null;
}

/**
 * Resolve which gold-example keys to inject into the AR prompt.
 *
 * Cascade (priority order):
 *   1. Manual `issueKeys` from per-project config.
 *   2. Label filter — any gold-pool entry whose `labels` contain the configured label.
 *   3. `null` → caller falls back to the auto-selected top pool entries.
 */
export function resolveGoldKeys(
  projectKey: string,
  goldConfigs: ProjectGoldExampleConfig[] | undefined,
  pool: GoldStoryPool | null,
): string[] | null {
  const config = findGoldConfigForProject(projectKey, goldConfigs);
  if (!config) return null;

  const manualKeys = (config.issueKeys ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (manualKeys.length) return manualKeys;

  const labelFilter = String(config.label ?? '').trim().toLowerCase();
  if (labelFilter && pool?.entries?.length) {
    const matched = pool.entries
      .filter((entry) => (entry.labels ?? []).some((l) => l.toLowerCase() === labelFilter))
      .map((entry) => entry.key);
    if (matched.length) return matched;
  }

  return null;
}

async function loadAllBacklogDocs(projectKey: string): Promise<BacklogDoc[]> {
  const index = await ensureBacklogIndex(projectKey);
  if (index.manifest?.shards?.length) {
    return loadDocsForShards(projectKey, index.manifest.shards.map((shard) => shard.shardId));
  }
  return index.legacy?.docs ?? [];
}

export async function resolveGoldKeysFromBacklog(
  projectKey: string,
  goldConfigs: ProjectGoldExampleConfig[] | undefined,
): Promise<string[] | null> {
  const config = findGoldConfigForProject(projectKey, goldConfigs);
  if (!config) return null;

  const manualKeys = (config.issueKeys ?? []).map((k) => String(k).trim()).filter(Boolean);
  if (manualKeys.length) return manualKeys;

  const labelFilter = String(config.label ?? '').trim().toLowerCase();
  if (!labelFilter) return null;

  const docs = await loadAllBacklogDocs(projectKey);
  const matchedDocs = docs.filter((doc) => (doc.labels ?? []).some((label) => label.toLowerCase() === labelFilter));
  if (!matchedDocs.length) return null;

  const ranked = rankGoldDocs(matchedDocs);
  if (ranked.length) return ranked.map((entry) => entry.key);

  return matchedDocs
    .slice()
    .sort((left, right) => String(right.updated ?? '').localeCompare(String(left.updated ?? '')))
    .slice(0, 15)
    .map((doc) => doc.key);
}

export async function searchGoldCandidatesInBacklog(
  projectKey: string,
  query?: string,
): Promise<Array<{ key: string; summary: string; score: number }>> {
  const normalizedQuery = String(query ?? '').trim().toLowerCase();
  const docs = await loadAllBacklogDocs(projectKey);
  const filtered = normalizedQuery
    ? docs.filter((doc) => doc.key.toLowerCase().includes(normalizedQuery) || doc.summary.toLowerCase().includes(normalizedQuery))
    : docs;

  return filtered
    .map((doc) => ({
      key: doc.key,
      summary: doc.summary,
      score: scoreExemplarQuality(String(doc.acceptanceCriteria ?? '')).score,
    }))
    .sort((left, right) => right.score - left.score || left.key.localeCompare(right.key))
    .slice(0, 50);
}

export function formatGoldStoryExemplars(pool: GoldStoryPool, confirmedKeys?: string[]): string {
  let entries = pool.entries;
  if (confirmedKeys?.length) {
    const keySet = new Set(confirmedKeys);
    const confirmed = entries.filter((e) => keySet.has(e.key));
    entries = confirmed.length ? confirmed : entries;
  }
  if (!entries.length) return '';

  const lines: string[] = [
    'RELEVANT AR PATTERNS from similar deployed stories — study the specificity and level of detail and match this standard. Not more generic. Not more solution-specific.',
    '',
  ];
  for (const entry of entries.slice(0, 8)) {
    lines.push(`— ${entry.summary}`);
    lines.push(entry.arSample.trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export async function refreshBacklogCachesForProjects(
  projectKeys: string[],
  config: TenantConfig,
): Promise<BacklogIndexInfo[]> {
  const uniqueProjectKeys = [...new Set(projectKeys.filter(key => key && key !== '*'))];
  const results: BacklogIndexInfo[] = [];

  for (const projectKey of uniqueProjectKeys) {
    try {
      results.push(await refreshBacklogCache(projectKey, config));
    } catch (err) {
      console.warn(`[similar-stories] Failed to refresh backlog cache for ${projectKey}:`, err);
    }
  }

  return results;
}

async function buildBacklogDocs(projectKey: string, config: TenantConfig): Promise<BacklogDoc[]> {
  const fields = buildFieldList(config, projectKey);
  const statusClause = buildBacklogStatusClause(config, projectKey);
  const docs: BacklogDoc[] = [];
  let nextPageToken: string | undefined;
  const pageSize = 100;

  let hasMore = true;
  while (hasMore) {
    const data = await runSearchJql({
      jql: `project = ${projectKey} AND ${statusClause} AND issuetype not in subTaskIssueTypes() ORDER BY updated DESC`,
      maxResults: pageSize,
      fields,
      nextPageToken,
    });
    const issues = data.issues ?? [];
    if (!issues.length) break;

    for (const issue of issues) {
      const doc = issueToBacklogDoc(issue, config, projectKey);
      if (doc.summary || doc.description || doc.acceptanceCriteria) {
        docs.push(doc);
      }
    }

    hasMore = !(data.isLast || !data.nextPageToken);
    nextPageToken = hasMore ? data.nextPageToken : undefined;
  }

  return docs;
}

function buildBacklogShards(projectKey: string, docs: BacklogDoc[], builtAt: string): BacklogShard[] {
  if (!docs.length) {
    return [];
  }

  const shards: BacklogShard[] = [];
  let currentDocs: BacklogDoc[] = [];
  let currentBytes = 2;
  let shardIndex = 1;

  for (const doc of docs) {
    const docBytes = Buffer.byteLength(JSON.stringify(doc), 'utf8') + 2;
    const exceeds = currentDocs.length > 0 && currentBytes + docBytes > MAX_SHARD_RAW_BYTES;
    if (exceeds) {
      shards.push({
        projectKey,
        shardId: shardIndex.toString().padStart(4, '0'),
        builtAt,
        issueCount: currentDocs.length,
        docs: currentDocs,
      });
      shardIndex += 1;
      currentDocs = [];
      currentBytes = 2;
    }
    currentDocs.push(doc);
    currentBytes += docBytes;
  }

  if (currentDocs.length || !shards.length) {
    shards.push({
      projectKey,
      shardId: shardIndex.toString().padStart(4, '0'),
      builtAt,
      issueCount: currentDocs.length,
      docs: currentDocs,
    });
  }

  return shards;
}

async function buildBacklogThemeIndex(
  projectKey: string,
  docs: BacklogDoc[],
  shards: BacklogShard[],
  config: TenantConfig,
  builtAt: string,
): Promise<BacklogThemeIndex> {
  const shardIdByDocKey = new Map<string, string>();
  for (const shard of shards) {
    for (const doc of shard.docs) {
      shardIdByDocKey.set(doc.key, shard.shardId);
    }
  }

  const targetThemeCount = computeThemeBudget(docs.length, config.backlogThemeBudgetOverride);
  const candidateMap = new Map<string, ThemeCandidate>();

  for (const doc of docs) {
    const topTerms = selectTopTerms(extractDocThemeScores(doc), TOP_THEME_TERMS_PER_DOC);
    if (!topTerms.length) continue;
    const shardId = shardIdByDocKey.get(doc.key) ?? shards[0]?.shardId ?? '0001';
    const keywords = topTerms.map(([term]) => term);
    for (const [term, score] of topTerms) {
      const existing = candidateMap.get(term) ?? {
        label: term,
        score: 0,
        docCount: 0,
        shardIds: new Set<string>(),
        sampleIssueKeys: [],
        sampleSummaries: [],
        updatedRange: { from: doc.updated, to: doc.updated },
        keywordScores: new Map<string, number>(),
      };
      existing.score += score;
      existing.docCount += 1;
      existing.shardIds.add(shardId);
      if (existing.sampleIssueKeys.length < 6) {
        existing.sampleIssueKeys.push(doc.key);
      }
      if (existing.sampleSummaries.length < 4 && doc.summary) {
        existing.sampleSummaries.push(doc.summary);
      }
      existing.updatedRange.from = minIso(existing.updatedRange.from, doc.updated);
      existing.updatedRange.to = maxIso(existing.updatedRange.to, doc.updated);
      for (const keyword of keywords) {
        existing.keywordScores.set(keyword, (existing.keywordScores.get(keyword) ?? 0) + (keyword === term ? score : Math.max(score / 3, 1)));
      }
      candidateMap.set(term, existing);
    }
  }

  const candidates = [...candidateMap.values()];
  const selected = selectThemeCandidates(candidates, targetThemeCount);
  const normalized = await normalizeThemesWithLlm(
    selected.map((candidate, index) => ({
      id: `theme-${(index + 1).toString().padStart(3, '0')}`,
      label: titleCase(candidate.label),
      summary: `Backlog stories related to ${candidate.label}.`,
      keywords: selectThemeKeywords(candidate.keywordScores),
      docCount: candidate.docCount,
      shardIds: Array.from(candidate.shardIds).sort(),
      sampleIssueKeys: candidate.sampleIssueKeys.slice(0, 6),
      updatedRange: candidate.updatedRange,
      signatureTerms: selectThemeKeywords(candidate.keywordScores).slice(0, MAX_THEME_SIGNATURE_TERMS),
      sampleSummaries: candidate.sampleSummaries,
    })),
    config,
  );

  const themes: BacklogTheme[] = normalized.map((theme) => ({
    id: theme.id,
    label: theme.label,
    summary: theme.summary,
    keywords: theme.keywords,
    docCount: theme.docCount,
    shardIds: theme.shardIds,
    sampleIssueKeys: theme.sampleIssueKeys,
    updatedRange: theme.updatedRange,
    signatureTerms: theme.signatureTerms,
  }));

  return {
    schemaVersion: 1,
    projectKey,
    builtAt,
    issueCount: docs.length,
    targetThemeCount,
    themes,
  };
}

function selectThemeCandidates(candidates: ThemeCandidate[], targetThemeCount: number): ThemeCandidate[] {
  if (!candidates.length || targetThemeCount <= 0) return [];

  const ranked = candidates
    .slice()
    .sort((a, b) => {
      const phraseBoostA = a.label.includes(' ') ? 5 : 0;
      const phraseBoostB = b.label.includes(' ') ? 5 : 0;
      const scoreA = (a.docCount * 10) + a.score + phraseBoostA;
      const scoreB = (b.docCount * 10) + b.score + phraseBoostB;
      return scoreB - scoreA || b.docCount - a.docCount || a.label.localeCompare(b.label);
    });

  const selected: ThemeCandidate[] = [];

  const tryAddCandidates = (predicate: (candidate: ThemeCandidate) => boolean) => {
    for (const candidate of ranked) {
      if (!predicate(candidate)) continue;
      if (selected.length >= targetThemeCount) break;
      if (selected.some(existing => areThemeLabelsNearDuplicate(existing.label, candidate.label))) {
        continue;
      }
      selected.push(candidate);
    }
  };

  tryAddCandidates(candidate => candidate.docCount >= 2);
  if (selected.length < targetThemeCount) {
    tryAddCandidates(() => true);
  }

  return selected.slice(0, targetThemeCount);
}

async function normalizeThemesWithLlm(
  themes: Array<BacklogTheme & { sampleSummaries?: string[] }>,
  config: TenantConfig,
): Promise<Array<BacklogTheme & { sampleSummaries?: string[] }>> {
  if (!themes.length) return themes;

  const effectiveConfig = {
    ...config,
    generatorConfig: resolveEffectiveGeneratorConfig(config.generatorConfig),
  };
  const providerOpts = buildLlmProviderOpts(effectiveConfig);
  const normalizedById = new Map<string, { label?: string; summary?: string; keywords?: string[] }>();

  for (let i = 0; i < themes.length; i += THEME_NORMALIZATION_BATCH_SIZE) {
    const batch = themes.slice(i, i + THEME_NORMALIZATION_BATCH_SIZE);
    try {
      const prompt = JSON.stringify(batch.map(theme => ({
        id: theme.id,
        draftLabel: theme.label,
        keywords: theme.keywords,
        docCount: theme.docCount,
        sampleIssueKeys: theme.sampleIssueKeys,
        sampleSummaries: theme.sampleSummaries?.slice(0, 3) ?? [],
      })));

      const response = await callLlmJson<Array<{ id: string; label?: string; summary?: string; keywords?: string[] }>>({
        model: effectiveConfig.generatorConfig.themeModel,
        systemPrompt: [
          'You clean up Jira backlog theme clusters for retrieval.',
          'Rewrite each theme into a concise business-facing label and one-sentence summary.',
          'Preserve scope, avoid inventing new domains, and keep keywords short and searchable.',
          'Return valid JSON only.',
        ].join(' '),
        userMessage: [
          'Normalize these theme drafts.',
          'For each theme return: {"id":"...","label":"3-7 words","summary":"1 short sentence","keywords":["3-6 short phrases"]}.',
          'Do not mention that these are themes or clusters.',
          `Input JSON:\n${prompt}`,
        ].join('\n\n'),
        maxTokens: 4096,
        reasoningEffort: 'low',
        ...providerOpts,
      });

      if (!Array.isArray(response)) continue;
      for (const item of response) {
        if (!item?.id) continue;
        normalizedById.set(item.id, {
          label: trimText(item.label, 72),
          summary: trimText(item.summary, 180),
          keywords: Array.isArray(item.keywords)
            ? item.keywords.map(keyword => trimText(keyword, 40)).filter(Boolean).slice(0, MAX_THEME_KEYWORDS)
            : undefined,
        });
      }
    } catch (err) {
      console.warn('[similar-stories] Theme normalization failed, keeping deterministic labels:', err);
    }
  }

  return themes.map(theme => {
    const normalized = normalizedById.get(theme.id);
    if (!normalized) return theme;
    return {
      ...theme,
      label: normalized.label || theme.label,
      summary: normalized.summary || theme.summary,
      keywords: normalized.keywords?.length ? normalized.keywords : theme.keywords,
      signatureTerms: dedupeStrings([
        ...(normalized.keywords ?? []),
        ...theme.signatureTerms,
      ]).slice(0, MAX_THEME_SIGNATURE_TERMS),
    };
  });
}

function shortlistShardIds(
  queryText: string,
  themeIndex: BacklogThemeIndex | null | undefined,
  manifest: BacklogManifest,
): string[] {
  if (!themeIndex?.themes?.length || !themeIndex.builtAt || themeIndex.builtAt < manifest.builtAt) {
    return manifest.shards.slice(0, FALLBACK_SHARDS).map(shard => shard.shardId);
  }

  const queryScores = extractWeightedTerms(queryText, 1);
  const scored = themeIndex.themes
    .map(theme => ({
      theme,
      score: scoreThemeMatch(queryText, queryScores, theme),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.theme.docCount - a.theme.docCount || a.theme.label.localeCompare(b.theme.label));

  if (!scored.length) {
    return manifest.shards.slice(0, FALLBACK_SHARDS).map(shard => shard.shardId);
  }

  const selectedShardIds = new Set<string>();
  let selectedThemes = 0;
  for (const entry of scored) {
    if (selectedThemes >= MAX_QUERY_THEMES || selectedShardIds.size >= MAX_QUERY_SHARDS) break;
    entry.theme.shardIds.forEach(shardId => {
      if (selectedShardIds.size < MAX_QUERY_SHARDS) {
        selectedShardIds.add(shardId);
      }
    });
    selectedThemes += 1;
  }

  return selectedShardIds.size
    ? manifest.shards
        .filter(shard => selectedShardIds.has(shard.shardId))
        .map(shard => shard.shardId)
    : manifest.shards.slice(0, FALLBACK_SHARDS).map(shard => shard.shardId);
}

function scoreThemeMatch(
  queryText: string,
  queryScores: Map<string, number>,
  theme: BacklogTheme,
): number {
  const themeScores = extractWeightedTerms(
    [theme.label, theme.summary, ...theme.keywords, ...theme.signatureTerms].filter(Boolean).join(' '),
    1,
  );

  let score = weightedOverlap(queryScores, themeScores);
  const loweredQuery = queryText.toLowerCase();

  if (theme.label && loweredQuery.includes(theme.label.toLowerCase())) {
    score += 8;
  }
  for (const keyword of theme.keywords ?? []) {
    if (loweredQuery.includes(keyword.toLowerCase())) {
      score += keyword.includes(' ') ? 4 : 2;
    }
  }

  return score;
}

function weightedOverlap(left: Map<string, number>, right: Map<string, number>): number {
  let total = 0;
  for (const [term, leftScore] of left.entries()) {
    const rightScore = right.get(term);
    if (!rightScore) continue;
    total += Math.min(leftScore, rightScore);
  }
  return total;
}

async function loadDocsForShards(projectKey: string, shardIds: string[]): Promise<BacklogDoc[]> {
  const shards = await Promise.all(
    shardIds.map(shardId => objectRead<BacklogShard>(KEYS.backlogDocsShard(projectKey, shardId))),
  );
  return shards
    .filter((shard): shard is BacklogShard => Boolean(shard))
    .flatMap(shard => shard.docs ?? []);
}

async function loadFallbackDocs(projectKey: string, manifest: BacklogManifest, shardCount = FALLBACK_SHARDS): Promise<BacklogDoc[]> {
  return loadDocsForShards(projectKey, manifest.shards.slice(0, shardCount).map(shard => shard.shardId));
}

export async function diagnoseBacklogCache(projectKey: string, config: TenantConfig): Promise<BacklogCacheDiagnostics> {
  const configuredStatuses = getConfiguredBacklogStatuses(config, projectKey);
  const statusClause = buildBacklogStatusClause(config, projectKey);
  const baseJql = `project = ${projectKey} AND issuetype not in subTaskIssueTypes()`;
  const jqlUsed = `${baseJql} AND ${statusClause}`;

  const [totalProjectIssues, doneCategoryIssues, matchingScopeIssues] = await Promise.all([
    countIssues(baseJql),
    countIssues(`${baseJql} AND statusCategory = Done`),
    countIssues(jqlUsed),
  ]);

  let likelyReason = 'Backlog cache scope matches issues.';
  if (totalProjectIssues === 0) {
    likelyReason = 'No issues are visible to the app for this project, or the project has no issues.';
  } else if (doneCategoryIssues === 0) {
    likelyReason = 'This project has no issues in status category Done.';
  } else if (matchingScopeIssues === 0 && configuredStatuses.length > 0) {
    likelyReason = 'Selected backlog statuses do not match any issues in this project.';
  } else if (matchingScopeIssues === 0) {
    likelyReason = 'No issues match the active backlog scope filter.';
  }

  return {
    projectKey,
    configuredStatuses,
    jqlUsed,
    totalProjectIssues,
    doneCategoryIssues,
    matchingScopeIssues,
    likelyReason,
  };
}

function buildBacklogStatusClause(config: TenantConfig, projectKey: string): string {
  const uniqueStatuses = getConfiguredBacklogStatuses(config, projectKey);
  if (!uniqueStatuses.length) {
    return 'statusCategory = Done';
  }

  const quotedStatuses = uniqueStatuses
    .map(status => `"${status.replace(/"/g, '\\"')}"`)
    .join(', ');

  return `status in (${quotedStatuses})`;
}

function getConfiguredBacklogStatuses(config: TenantConfig, projectKey: string): string[] {
  const scopedStatuses = config.backlogStatusScopes?.find(scope => scope.projectKey === projectKey)?.statuses ?? [];
  return [...new Set(scopedStatuses.map(status => String(status).trim()).filter(Boolean))];
}

async function countIssues(jql: string): Promise<number> {
  const approximate = await getApproximateCount(jql);
  if (approximate !== null) return approximate;

  let nextPageToken: string | undefined;
  let count = 0;
  const maxCount = 2000;

  while (count < maxCount) {
    const data = await runSearchJql({
      jql,
      maxResults: 100,
      fields: ['key'],
      nextPageToken,
    });
    const issues = data.issues ?? [];
    if (!issues.length) break;
    count += issues.length;
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return count;
}

async function runSearchJql(payload: {
  jql: string;
  maxResults: number;
  fields: string[];
  nextPageToken?: string;
}): Promise<SearchJqlResponse> {
  const response = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/search/jql'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`Jira search failed (${response.status}): ${raw.slice(0, 280)}`);
  }

  try {
    return JSON.parse(raw) as SearchJqlResponse;
  } catch {
    throw new Error('Jira search returned non-JSON response.');
  }
}

async function getApproximateCount(jql: string): Promise<number | null> {
  const response = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/search/approximate-count'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  });
  if (!response.ok) return null;

  const raw = await response.text();
  try {
    const data = JSON.parse(raw) as { count?: number; approximateCount?: number };
    if (typeof data.count === 'number') return data.count;
    if (typeof data.approximateCount === 'number') return data.approximateCount;
  } catch {
    return null;
  }
  return null;
}

function buildFieldList(config: TenantConfig, projectKey: string): string[] {
  const mapping = config.arMappings?.find(m => m.projectKey === projectKey)
    || config.arMappings?.find(m => m.projectKey === '*');
  const fieldIds = new Set<string>(['summary', 'description', 'updated', 'labels']);

  if (mapping?.mode === 'consolidated' && mapping.consolidatedFieldId && mapping.consolidatedFieldId !== 'description') {
    fieldIds.add(mapping.consolidatedFieldId);
  }
  for (const fieldId of mapping?.iterativeFieldIds ?? []) {
    if (fieldId) fieldIds.add(fieldId);
  }

  return Array.from(fieldIds);
}

function issueToBacklogDoc(
  issue: { key: string; fields: Record<string, unknown> },
  config: TenantConfig,
  projectKey: string,
): BacklogDoc {
  const mapping = config.arMappings?.find(m => m.projectKey === projectKey)
    || config.arMappings?.find(m => m.projectKey === '*');

  const summary = String(issue.fields.summary ?? '').trim();
  const description = trimBacklogText(extractText(issue.fields.description), MAX_DESCRIPTION_CHARS);
  const acceptanceCriteria = trimBacklogText(extractAcceptanceCriteria(issue.fields, mapping), MAX_ACCEPTANCE_CRITERIA_CHARS);
  const rawLabels = issue.fields.labels;
  const labels = Array.isArray(rawLabels)
    ? rawLabels.map((l) => String(l ?? '').trim()).filter(Boolean)
    : undefined;

  return {
    key: issue.key,
    summary: trimBacklogText(summary, MAX_SUMMARY_CHARS),
    description,
    acceptanceCriteria,
    updated: String(issue.fields.updated ?? ''),
    labels,
  };
}

function extractAcceptanceCriteria(fields: Record<string, unknown>, mapping?: TenantConfig['arMappings'][number]): string {
  if (!mapping) return '';

  const parts: string[] = [];
  if (mapping.mode === 'consolidated') {
    const fieldId = mapping.consolidatedFieldId;
    if (fieldId && fieldId !== 'description') {
      const text = extractText(fields[fieldId]);
      if (text) parts.push(text);
    }
  } else {
    for (const fieldId of mapping.iterativeFieldIds ?? []) {
      const text = extractText(fields[fieldId]);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n\n');
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const obj = value as { text?: string; content?: unknown[] };
    if (obj.text) return obj.text;
    if (obj.content) return obj.content.map(extractText).filter(Boolean).join('\n');
  }
  return '';
}

function trimBacklogText(text: string, maxChars: number): string {
  const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!compact || compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function buildSimilarityQueryText(input: {
  requirement: string;
  attachmentText?: string;
  clarifyAnswers?: ClarifyAnswer[];
}): string {
  const parts = [input.requirement.trim()];
  if (input.attachmentText?.trim()) {
    parts.push(input.attachmentText.trim().slice(0, 6000));
  }
  if (input.clarifyAnswers?.length) {
    parts.push(
      input.clarifyAnswers
        .map((answer) => {
          const sug = (answer.selectedSuggestions ?? []).filter(Boolean).join('; ');
          const extra = answer.customAnswer?.trim() ? ` Additional: ${answer.customAnswer.trim()}` : '';
          return `${answer.question} ${answer.answer ?? ''}${extra}${sug ? ` Signals: ${sug}` : ''}`;
        })
        .join('\n'),
    );
  }
  return parts.filter(Boolean).join('\n\n');
}

function lexicalRetrieve(requirement: string, docs: BacklogDoc[]): Array<BacklogDoc & { relevanceScore: number }> {
  const terms = buildQueryTerms(requirement);
  if (!terms.length) return [];

  const preparedDocs = docs.map(doc => {
    const combinedText = buildBacklogSearchText(doc);
    const combinedTerms = tokenize(combinedText);
    return {
      doc,
      combinedTerms,
      combinedTermSet: new Set(combinedTerms),
      summaryTerms: new Set(tokenize(doc.summary)),
      arTerms: new Set(tokenize(doc.acceptanceCriteria)),
    };
  });

  const avgLen = preparedDocs.reduce((sum, entry) => sum + entry.combinedTerms.length, 0) / Math.max(preparedDocs.length, 1);
  const docFreqByTerm = new Map<string, number>();
  for (const term of terms) {
    let docFreq = 0;
    for (const entry of preparedDocs) {
      if (entry.combinedTermSet.has(term)) {
        docFreq += 1;
      }
    }
    docFreqByTerm.set(term, Math.max(docFreq, 1));
  }

  const scored = preparedDocs.map(entry => {
    const freq = buildTermFreq(entry.combinedTerms);
    const docLen = Math.max(entry.combinedTerms.length, 1);
    let score = 0;

    for (const term of terms) {
      const tf = freq[term] ?? 0;
      if (!tf) continue;
      const docFreq = docFreqByTerm.get(term) ?? 1;
      const idf = Math.log((docs.length + 1) / docFreq);
      score += idf * ((tf * 2.5) / (tf + 1.5 * (1 - 0.75 + 0.75 * (docLen / Math.max(avgLen, 1)))));
    }

    const summaryBoost = terms.filter(term => entry.summaryTerms.has(term)).length * 1.2;
    const arBoost = terms.filter(term => entry.arTerms.has(term)).length * 0.9;
    return { ...entry.doc, relevanceScore: score + summaryBoost + arBoost };
  });

  return scored
    .filter(doc => doc.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function buildBacklogSearchText(doc: BacklogDoc): string {
  return [doc.summary, doc.description, doc.acceptanceCriteria].filter(Boolean).join('\n\n');
}

function buildQueryTerms(requirement: string): string[] {
  const baseTerms = tokenize(requirement);
  const words = requirement
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const bigrams: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const left = normalizeToken(words[i]);
    const right = normalizeToken(words[i + 1]);
    if (left.length > 2 && right.length > 2 && !STOP_WORDS.has(left) && !STOP_WORDS.has(right)) {
      bigrams.push(`${left} ${right}`);
    }
  }

  return [...new Set([...baseTerms.slice(0, 14), ...bigrams.slice(0, 8)])];
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(normalizeToken)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function normalizeToken(word: string): string {
  let normalized = word.toLowerCase().trim();
  if (normalized.length <= 3) return normalized;
  if (normalized.endsWith('ies') && normalized.length > 4) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (normalized.endsWith('ing') && normalized.length > 5) {
    normalized = normalized.slice(0, -3);
  } else if (normalized.endsWith('ed') && normalized.length > 4) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith('es') && normalized.length > 4) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith('s') && normalized.length > 4) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function buildTermFreq(terms: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const term of terms) {
    freq[term] = (freq[term] ?? 0) + 1;
  }
  return freq;
}

function extractDocThemeScores(doc: BacklogDoc): Map<string, number> {
  const sections = [
    { text: doc.summary, weight: 2.4 },
    { text: doc.description, weight: 1.4 },
    { text: doc.acceptanceCriteria, weight: 1.2 },
  ];
  const scores = new Map<string, number>();
  for (const section of sections) {
    const sectionScores = extractWeightedTerms(section.text, section.weight);
    for (const [term, score] of sectionScores.entries()) {
      scores.set(term, (scores.get(term) ?? 0) + score);
    }
  }
  return scores;
}

function extractWeightedTerms(text: string, baseWeight: number): Map<string, number> {
  const scores = new Map<string, number>();
  const tokens = tokenize(text);
  for (const token of tokens) {
    scores.set(token, (scores.get(token) ?? 0) + baseWeight);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (!left || !right) continue;
    const bigram = `${left} ${right}`;
    scores.set(bigram, (scores.get(bigram) ?? 0) + (baseWeight * 2.2));
  }
  return scores;
}

function selectTopTerms(scores: Map<string, number>, limit: number): Array<[string, number]> {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || Number(b[0].includes(' ')) - Number(a[0].includes(' ')) || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function selectThemeKeywords(keywordScores: Map<string, number>): string[] {
  return [...keywordScores.entries()]
    .sort((a, b) => b[1] - a[1] || Number(b[0].includes(' ')) - Number(a[0].includes(' ')) || a[0].localeCompare(b[0]))
    .map(([term]) => titleCase(term))
    .slice(0, MAX_THEME_KEYWORDS);
}

function computeThemeBudget(issueCount: number, override?: number | null): number {
  if (issueCount <= 0) return 0;
  const normalizedOverride = typeof override === 'number' && Number.isFinite(override) && override > 0
    ? Math.round(override)
    : null;
  const adaptive = normalizedOverride ?? clamp(Math.ceil(issueCount / 50), MIN_THEME_COUNT, MAX_THEME_COUNT);
  return clamp(adaptive, 1, Math.min(MAX_THEME_COUNT, issueCount));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function areThemeLabelsNearDuplicate(left: string, right: string): boolean {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (!leftTokens.size || !rightTokens.size) return false;
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  if (!union) return false;
  const similarity = intersection / union;
  return similarity >= 0.75 || isSubset(leftTokens, rightTokens) || isSubset(rightTokens, leftTokens);
}

function isSubset(left: Set<string>, right: Set<string>): boolean {
  if (left.size > right.size) return false;
  for (const token of left) {
    if (!right.has(token)) return false;
  }
  return true;
}

function summaryJaccardTokens(left: string, right: string): number {
  const A = new Set(tokenize(left));
  const B = new Set(tokenize(right));
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

/** Drop near-duplicate summaries (wastes prompt budget); keep higher lexical score first. */
function dedupeBacklogDocsBySimilarSummary<T extends BacklogDoc & { relevanceScore: number }>(
  ordered: T[],
  jaccardThreshold = 0.82,
): T[] {
  const kept: T[] = [];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const item of ordered) {
    const ns = norm(item.summary);
    let dup = false;
    for (const k of kept) {
      if (summaryJaccardTokens(ns, norm(k.summary)) >= jaccardThreshold) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(item);
  }
  return kept;
}

async function rerankWithLlm(
  requirement: string,
  candidates: Array<BacklogDoc & { relevanceScore: number }>,
  model: string,
): Promise<Array<BacklogDoc & { relevanceScore: number }>> {
  try {
    const summaries = candidates.map((candidate) => {
      const desc = trimBacklogText(candidate.description, 220);
      const acHead = trimBacklogText(
        String(candidate.acceptanceCriteria ?? '').split('\n').find((ln) => ln.trim()) ?? '',
        180,
      );
      const bits = [`${candidate.key}: ${candidate.summary}`];
      if (desc) bits.push(`Desc: ${desc}`);
      if (acHead) bits.push(`AC: ${acHead}`);
      return bits.join(' | ');
    });
    const prompt = buildRerankPrompt(requirement, summaries);

    const ranked = await callLlmJson<number[]>({
      model,
      systemPrompt: 'Rank the Jira backlog items by relevance to the requirement. Output a JSON array of 1-based indices.',
      userMessage: prompt,
      maxTokens: 256,
    });

    if (!Array.isArray(ranked)) return candidates;
    return ranked
      .map(index => candidates[index - 1])
      .filter((candidate): candidate is BacklogDoc & { relevanceScore: number } => !!candidate);
  } catch {
    return candidates;
  }
}

function buildLlmProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    ollamaApiKey: config.generatorConfig.ollamaApiKey,
    ollamaBaseUrl: config.generatorConfig.ollamaBaseUrl,
    groqApiKey: config.generatorConfig.groqApiKey,
    groqBaseUrl: config.generatorConfig.groqBaseUrl,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  };
}

async function getJiraBaseUrl(): Promise<string> {
  try {
    const res = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/serverInfo'));
    const data = await res.json() as { baseUrl?: string };
    return data.baseUrl ?? 'https://your-site.atlassian.net';
  } catch {
    return 'https://your-site.atlassian.net';
  }
}

function minIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function maxIso(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function trimText(value: unknown, maxChars: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trimEnd()}...`;
}

function dedupeStrings(items: string[]): string[] {
  return [...new Set(items.map(item => item.trim()).filter(Boolean))];
}

const AR_PATTERN_STOP = new Set([
  'given', 'when', 'then', 'and', 'or', 'the', 'a', 'an', 'to', 'of', 'in', 'for', 'is', 'are', 'with', 'on', 'as', 'at', 'by', 'from', 'be', 'it', 'if',
]);

// ─── AR Exemplar Quality Scoring ─────────────────────────────────────────────

const CONCRETE_NOUNS_RE = /\b(plan|quote|contract|agreement|order|shipment|activity|record|request|case|approval|notification|invoice|estimate|schedule|assignment|entitlement|coverage|authorisation|authorization|allocation|delivery)\b/gi;
const ABSTRACT_VERBS_RE = /\b(ensure|verify|validate|confirm|process|handle|manage|perform|execute|check|update|complete|allow|prevent|enable|disable)\b/gi;
const UI_LEAK_RE = /\b(button|click|screen|dropdown|checkbox|popup|modal|tab|field|form|page|menu|sidebar|panel|widget|dialog|tooltip|toggle)\b/gi;
const FIRST_PERSON_RE = /\b(i |we |my |our )/gi;
const CONFIG_GIVEN_RE = /\b(is configured|configured for|trigger event|status equals|flag is set|setting is)\b/gi;
const PLACEHOLDER_RE = /\b(tbd|todo|placeholder|see description|n\/a|fill in|xxx)\b/i;
const FRAGMENT_TAIL_RE = /\s+(the|and|with|or|of|a|an|to|for|in|at|by)\.?\s*$/i;
const CLAUSE_SEPARATOR_RE = /\r?\n/;

/** Detect non-GWT scenario-shaped items: numbered lists, Gherkin, Scenario:, Precondition: patterns */
function countScenarioItems(ac: string): number {
  let count = 0;
  const lines = ac.split(CLAUSE_SEPARATOR_RE);
  for (const line of lines) {
    const stripped = stripLeadingClauseMarkers(line);
    if (!stripped) continue;
    if (/^(given|when|then|scenario|precondition|trigger|outcome|expected result|expected)[\s:]/i.test(stripped)) {
      count += 1;
    } else if (/^\d+[.)]\s+\w/.test(line.trim()) && stripped.split(/\s+/).length >= 6) {
      count += 1;
    }
  }
  return count;
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function avgTrippleClauseWordCount(triples: Array<{ given: string; when: string; then: string }>): number {
  if (!triples.length) return 0;
  let total = 0;
  for (const t of triples) {
    total += wordCount(t.given) + wordCount(t.when) + wordCount(t.then);
  }
  return total / (triples.length * 3);
}

function hasFragmentTail(text: string): boolean {
  return FRAGMENT_TAIL_RE.test(text);
}

function detectsDuplication(triples: Array<{ given: string; when: string; then: string }>): boolean {
  if (triples.length < 2) return false;
  const thens = triples.map((t) => t.then.toLowerCase().replace(/\s+/g, ' ').trim());
  const seen = new Set<string>();
  for (const t of thens) {
    if (t.length > 10 && seen.has(t)) return true;
    seen.add(t);
  }
  return false;
}

/**
 * Hard gate: minimum substance check, format-agnostic.
 * Returns null when the item passes, or a drop reason string when it fails.
 */
function hardGateDropReason(ac: string): string | null {
  if (!ac || ac.length < 60) return 'ac_too_short';
  if (PLACEHOLDER_RE.test(ac)) return 'placeholder_text';

  // Require at least 2 structured items (GWT triples OR scenario-shaped lines)
  // to ensure the AC has list-like substance, not just a single sentence.
  const triples = extractGwtSamples(ac, 8);
  const scenarioItems = countScenarioItems(ac);
  const substantiveItems = triples.length + Math.max(0, scenarioItems - triples.length);
  if (substantiveItems < 2) {
    // Last resort: count lines with ≥ 12 words
    const longLines = ac.split(CLAUSE_SEPARATOR_RE).filter((l) => wordCount(l) >= 12);
    if (longLines.length < 2) return 'insufficient_structured_items';
  }
  return null;
}

export interface ExemplarQualityResult {
  score: number;
  hardGatePassed: boolean;
  dropReason: string | null;
  detectedFormat: 'gwt' | 'gherkin' | 'numbered' | 'prose';
  gwtTripleCount: number;
}

/**
 * Score a single backlog doc's acceptance criteria for quality as an AR exemplar.
 *
 * Well-formed GWT triples earn the highest weight. Non-GWT scenario formats
 * (numbered lists, Gherkin, Scenario:/Precondition: patterns) are also
 * recognised and scored on their structural merits rather than excluded.
 *
 * Returns a score in [0, 100] for survivors, 0 for items that fail the hard gate.
 */
export function scoreExemplarQuality(ac: string): ExemplarQualityResult {
  const dropReason = hardGateDropReason(ac);
  if (dropReason) {
    return { score: 0, hardGatePassed: false, dropReason, detectedFormat: 'prose', gwtTripleCount: 0 };
  }

  const triples = extractGwtSamples(ac, 8);
  const gwtTripleCount = triples.length;

  // ── Detect format ──────────────────────────────────────────────────────────
  let detectedFormat: ExemplarQualityResult['detectedFormat'] = 'prose';
  if (gwtTripleCount >= 2) {
    detectedFormat = 'gwt';
  } else if (/\b(scenario|precondition|expected result|expected):?\s/i.test(ac)) {
    detectedFormat = 'gherkin';
  } else if (/^\s*\d+[.)]/m.test(ac)) {
    detectedFormat = 'numbered';
  }

  // ── Positive signals ───────────────────────────────────────────────────────
  let score = 0;

  // GWT completeness — highest weight (0–40 pts)
  // gwtTripleCount 0=0, 1=10, 2=22, 3=30, 4=36, 5+=40
  const gwtPts = Math.min(40, gwtTripleCount > 0 ? 10 + (gwtTripleCount - 1) * 7.5 : 0);
  score += gwtPts;

  // Clause substance: average words per clause should be in 5–40 (0–10 pts)
  const avgWords = avgTrippleClauseWordCount(triples);
  if (gwtTripleCount > 0) {
    if (avgWords >= 5 && avgWords <= 40) score += 10;
    else if (avgWords >= 3) score += 4;
  }

  // Non-GWT scenario items when few/no GWT found (0–8 pts)
  const scenarioItems = countScenarioItems(ac);
  if (gwtTripleCount < 2 && scenarioItems >= 2) {
    score += Math.min(8, scenarioItems * 2);
  }

  // AR count in band 2–8 (0–6 pts)
  const totalItems = Math.max(gwtTripleCount, scenarioItems);
  if (totalItems >= 2 && totalItems <= 8) score += 6;
  else if (totalItems === 1 || totalItems === 9) score += 2;

  // User-story description (0–4 pts)
  // (checked via presence in the full text, not just description field)
  if (/as an? .+, (i|we) need/i.test(ac)) score += 4;

  // Concrete noun density in THEN / outcome clauses (0–12 pts)
  const thenText = gwtTripleCount > 0
    ? triples.map((t) => t.then).join(' ')
    : ac;
  const concreteHits = countMatches(thenText, CONCRETE_NOUNS_RE);
  const abstractHits = countMatches(thenText, ABSTRACT_VERBS_RE);
  const density = concreteHits / Math.max(1, concreteHits + abstractHits);
  score += Math.round(density * 12);

  // ── Penalties ──────────────────────────────────────────────────────────────
  // UI leak (–8 per hit, max –16)
  const uiLeaks = countMatches(ac, UI_LEAK_RE);
  score -= Math.min(16, uiLeaks * 8);

  // First person in AC (–6)
  if (FIRST_PERSON_RE.test(ac)) score -= 6;

  // Config-language GIVENs (–6 per hit, max –12)
  const configHits = countMatches(ac, CONFIG_GIVEN_RE);
  score -= Math.min(12, configHits * 6);

  // Fragment tails in GIVEN/THEN clauses (–2 per hit, max –8)
  const allClauseText = gwtTripleCount > 0
    ? triples.flatMap((t) => [t.given, t.then])
    : ac.split(CLAUSE_SEPARATOR_RE);
  const fragmentPenalty = allClauseText.filter((c) => hasFragmentTail(c)).length;
  score -= Math.min(8, fragmentPenalty * 2);

  // Duplication across THEN clauses (–10)
  if (gwtTripleCount >= 2 && detectsDuplication(triples)) score -= 10;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    hardGatePassed: true,
    dropReason: null,
    detectedFormat,
    gwtTripleCount,
  };
}

/**
 * Minimum quality floor for tenant exemplars (vs shipped anchors).
 * Calibrated so an item with 2 well-formed GWT triples, reasonable clause length,
 * and some concrete nouns scores above this even with minor penalties.
 */
const EXEMPLAR_QUALITY_FLOOR = 38;

function requirementKeywordOverlap(requirement: string, corpus: string): number {
  const reqTokens = new Set(
    requirement
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !AR_PATTERN_STOP.has(t)),
  );
  if (!reqTokens.size) return 0;
  let hits = 0;
  for (const t of corpus.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/)) {
    if (t.length > 2 && reqTokens.has(t)) hits += 1;
  }
  return hits;
}

/**
 * Strip leading markdown bullets, numbered-list markers, quotes, and bold
 * emphasis so a clause like "- **GIVEN** x" is recognised as starting with
 * `GIVEN`.
 */
function stripLeadingClauseMarkers(line: string): string {
  return line
    .trim()
    .replace(/^[\s>]*/, '')
    .replace(/^(?:[-*•]+\s+|\d+[.)]\s+|\(\d+\)\s+|[a-z][.)]\s+)/i, '')
    .replace(/^\*+\s*/, '')
    .replace(/^["'`“”‘’]+/, '')
    .trim();
}

function clauseKind(line: string): 'given' | 'when' | 'then' | 'and' | null {
  const body = stripLeadingClauseMarkers(line)
    .replace(/^\*+\s*/, '')
    .replace(/^["'`“”‘’]+/, '');
  const match = body.match(/^\**\s*(GIVEN|WHEN|THEN|AND)\b/i);
  if (!match) return null;
  const kind = match[1].toLowerCase();
  return kind as 'given' | 'when' | 'then' | 'and';
}

function normalizeClauseText(line: string, max = 320): string {
  const cleaned = stripLeadingClauseMarkers(line)
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, max);
}

/**
 * Lenient G/W/T extractor.
 *
 * Accepts variations used across teams: case-insensitive keywords, markdown
 * bullets, numbered lists, multi-line clauses, bold emphasis. Returns up to
 * `maxTriples` complete GIVEN/WHEN/THEN triples from the text. If no triple
 * parses, returns the first two non-empty lines as a single raw fallback so the
 * caller still has something to emit to the prompt.
 */
function extractGwtSamples(
  acceptanceCriteria: string,
  maxTriples = 3,
): Array<{ given: string; when: string; then: string }> {
  const lines = acceptanceCriteria.split(/\r?\n/);
  const triples: Array<{ given: string; when: string; then: string }> = [];
  let current: { given: string; when: string; then: string } = { given: '', when: '', then: '' };
  let lastClause: 'given' | 'when' | 'then' | null = null;

  const commitIfComplete = () => {
    if (current.given && current.when && current.then) {
      triples.push({ ...current });
      current = { given: '', when: '', then: '' };
      lastClause = null;
    }
  };

  for (const raw of lines) {
    const kind = clauseKind(raw);
    const text = normalizeClauseText(raw);
    if (!text) continue;

    if (kind === 'given') {
      if (current.given || current.when || current.then) {
        current = { given: '', when: '', then: '' };
      }
      current.given = text;
      lastClause = 'given';
    } else if (kind === 'when') {
      current.when = text;
      lastClause = 'when';
    } else if (kind === 'then') {
      current.then = text;
      lastClause = 'then';
    } else if (kind === 'and' && lastClause) {
      const merged = `${current[lastClause]} ${text}`.slice(0, 320);
      current[lastClause] = merged;
    } else if (!kind && lastClause && current[lastClause]) {
      const merged = `${current[lastClause]} ${text}`.slice(0, 320);
      current[lastClause] = merged;
    }
    commitIfComplete();
    if (triples.length >= maxTriples) break;
  }

  return triples;
}

function extractGwtSampleLines(acceptanceCriteria: string): { given: string; when: string; then: string } | null {
  const [first] = extractGwtSamples(acceptanceCriteria, 1);
  return first ?? null;
}

function extractRawArFallbackLines(acceptanceCriteria: string, max = 2): string[] {
  const lines: string[] = [];
  for (const raw of acceptanceCriteria.split(/\r?\n/)) {
    const text = normalizeClauseText(raw, 220);
    if (!text) continue;
    lines.push(text);
    if (lines.length >= max) break;
  }
  return lines;
}

/**
 * Compact AR phrasing patterns from already-fetched similar stories (no extra Jira fetch).
 *
 * Applies a two-step quality filter before emitting examples to the prompt:
 *   1. Hard gate: substantive, non-placeholder AC with list-shaped structure.
 *   2. Quality scoring: structural + linguistic signals; GWT triples earn the
 *      highest weight, but other scenario formats (Gherkin, numbered) also score.
 *
 * If fewer than 2 stories survive the gate OR the top survivors' median score is
 * below EXEMPLAR_QUALITY_FLOOR, falls back to the shipped anchor bundle so the
 * model always receives at least one high-quality concrete GWT example.
 */
export function formatArPatternLibraryFromSimilarStories(
  stories: SimilarStory[],
  requirement: string,
  maxStories = 5,
): { text: string; storyKeys: string[]; usedAnchorFallback: boolean } {
  const req = requirement.trim();
  if (!stories.length || !req) {
    return { text: formatAnchorBundleText(), storyKeys: [], usedAnchorFallback: true };
  }

  type Row = {
    story: SimilarStory;
    keywordOverlap: number;
    quality: ExemplarQualityResult;
    triples: Array<{ given: string; when: string; then: string }>;
  };

  // ── Step 1: score all candidates ──────────────────────────────────────────
  const rows: Row[] = [];
  for (const story of stories) {
    const ac = String(story.acceptanceCriteria ?? '');
    const quality = scoreExemplarQuality(ac);
    if (!quality.hardGatePassed) continue; // dropped by hard gate

    const triples = extractGwtSamples(ac, 4);
    const blob = `${story.summary} ${story.description ?? ''} ${ac}`.slice(0, 4000);
    rows.push({ story, keywordOverlap: requirementKeywordOverlap(req, blob), quality, triples });
  }

  // ── Step 2: check if the pool is strong enough ────────────────────────────
  const useFallback = (): boolean => {
    if (rows.length < 2) return true;
    const sorted = [...rows].sort((a, b) => b.quality.score - a.quality.score);
    const topK = sorted.slice(0, Math.min(maxStories, sorted.length));
    const median = topK[Math.floor(topK.length / 2)].quality.score;
    return median < EXEMPLAR_QUALITY_FLOOR;
  };

  if (useFallback()) {
    return { text: formatAnchorBundleText(), storyKeys: [], usedAnchorFallback: true };
  }

  // ── Step 3: rank and select ───────────────────────────────────────────────
  // Primary sort: quality score; secondary: keyword overlap; tertiary: Jira relevance score
  rows.sort((a, b) => {
    if (b.quality.score !== a.quality.score) return b.quality.score - a.quality.score;
    if (b.keywordOverlap !== a.keywordOverlap) return b.keywordOverlap - a.keywordOverlap;
    return (b.story.relevanceScore ?? 0) - (a.story.relevanceScore ?? 0);
  });

  const topK = Math.min(maxStories, Math.ceil(rows.length * 0.4), rows.length);
  const picked = rows.slice(0, Math.max(2, topK));

  // ── Step 4: format output ─────────────────────────────────────────────────
  const lines: string[] = [
    'ACCEPTANCE REQUIREMENT EXAMPLES from this workspace (match their specificity and depth — do not copy their scope):',
    'Study the structure: compound preconditions in GIVEN, concrete business objects in THEN, distinct branch variants.',
    '',
  ];
  const storyKeys: string[] = [];
  for (const { story, triples } of picked) {
    storyKeys.push(story.key);
    lines.push(`— ${story.key}: ${story.summary}`);
    if (triples.length) {
      for (const gwt of triples) {
        lines.push(`  GIVEN ${gwt.given}`);
        lines.push(`  WHEN ${gwt.when}`);
        lines.push(`  THEN ${gwt.then}`);
      }
    } else {
      for (const raw of extractRawArFallbackLines(String(story.acceptanceCriteria ?? ''), 3)) {
        lines.push(`  ${raw}`);
      }
    }
    lines.push('');
  }
  return { text: lines.join('\n').trimEnd(), storyKeys, usedAnchorFallback: false };
}

export function formatSimilarStoriesText(items: SimilarStory[], maxItems = 12): string {
  if (!items.length) return '';
  return items
    .slice(0, maxItems)
    .map((item, index) => ([
      `--- Backlog Reference ${index + 1} ---`,
      `Summary: ${item.summary}`,
      item.description ? `Description: ${item.description.slice(0, 900)}` : '',
      item.acceptanceCriteria ? `Acceptance Criteria:\n${item.acceptanceCriteria.slice(0, 1400)}` : '',
    ].filter(Boolean).join('\n')))
    .join('\n\n');
}
