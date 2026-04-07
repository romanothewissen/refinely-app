import { callLlmJson } from './llm';
import { objectRead, KEYS } from '../services/cache';
import { resolveEffectiveGeneratorConfig } from '../services/model-strategy';
import type {
  InferProjectPersonaRolesResult,
  ProjectPersonaRoleSuggestion,
  TenantConfig,
} from '../types';

interface BacklogDoc {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  updated: string;
}

interface BacklogShardMeta {
  shardId: string;
}

interface BacklogManifest {
  projectKey: string;
  issueCount: number;
  shards: BacklogShardMeta[];
}

interface BacklogTheme {
  label: string;
  docCount: number;
  shardIds: string[];
  sampleIssueKeys: string[];
  keywords: string[];
  signatureTerms: string[];
}

interface BacklogThemeIndex {
  themes: BacklogTheme[];
}

interface BacklogShard {
  docs: BacklogDoc[];
}

interface LegacyBacklogIndexCache {
  docs: BacklogDoc[];
}

interface LoadedInferenceCache {
  manifest: BacklogManifest | null;
  themeIndex: BacklogThemeIndex | null;
  legacy: LegacyBacklogIndexCache | null;
  shardDocs: Record<string, BacklogDoc[]>;
}

export interface RoleInferenceSample {
  docs: BacklogDoc[];
  corpus: string;
}

export const MAX_ROLE_INFERENCE_DOCS = 15;
export const MAX_ROLE_INFERENCE_SHARDS = 5;
export const MAX_ROLE_INFERENCE_THEMES = 6;
export const MAX_ROLE_INFERENCE_CORPUS_CHARS = 6000;

const MAX_DOC_SUMMARY_CHARS = 140;
const MAX_DOC_DESCRIPTION_CHARS = 220;
const MAX_DOC_AC_CHARS = 220;
const MAX_ACTIVITY_CHARS = 180;
const MAX_ROLE_CHARS = 72;
const MAX_ROLE_SUGGESTIONS = 6;
const GENERIC_ROLE_NAMES = new Set([
  'user',
  'users',
  'team',
  'system',
  'service',
  'application',
  'app',
  'admin',
  'administrator',
  'manager',
]);

function normalizeWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function trimText(value: string, maxChars: number): string {
  const compact = normalizeWhitespace(value);
  if (!compact || compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeRoleName(value: string): string {
  return normalizeWhitespace(value).replace(/[.:;-]+$/g, '');
}

function roleKey(value: string): string {
  return normalizeRoleName(value).toLowerCase();
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function confidenceRank(value: ProjectPersonaRoleSuggestion['confidence']): number {
  if (value === 'high') return 3;
  if (value === 'medium') return 2;
  return 1;
}

function normalizeConfidence(value: unknown): ProjectPersonaRoleSuggestion['confidence'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'high') return 'high';
  if (normalized === 'medium') return 'medium';
  return 'low';
}

function isGenericRole(role: string): boolean {
  const normalized = roleKey(role);
  return GENERIC_ROLE_NAMES.has(normalized);
}

function dedupeStrings(values: string[], maxItems?: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(normalized);
    if (maxItems && deduped.length >= maxItems) break;
  }
  return deduped;
}

function scoreDocAgainstTerms(doc: BacklogDoc, terms: string[]): number {
  if (!terms.length) return 0;
  const docTerms = new Set(tokenize([doc.summary, doc.description, doc.acceptanceCriteria].join(' ')));
  return terms.reduce((score, term) => score + (docTerms.has(term) ? 1 : 0), 0);
}

function compareUpdatedDescending(left: BacklogDoc, right: BacklogDoc): number {
  return String(right.updated ?? '').localeCompare(String(left.updated ?? ''));
}

function selectEvenlySpacedItems<T>(items: T[], limit: number): T[] {
  if (limit <= 0 || !items.length) return [];
  if (items.length <= limit) return [...items];

  const result: T[] = [];
  const lastIndex = items.length - 1;
  for (let i = 0; i < limit; i += 1) {
    const index = Math.round((i * lastIndex) / Math.max(1, limit - 1));
    result.push(items[index]);
  }
  return result;
}

export function selectRoleInferenceShardIds(input: {
  manifest?: BacklogManifest | null;
  themeIndex?: BacklogThemeIndex | null;
  maxShards?: number;
}): string[] {
  const manifestShardIds = (input.manifest?.shards ?? []).map((shard) => shard.shardId).filter(Boolean);
  if (!manifestShardIds.length) return [];

  const maxShards = input.maxShards ?? MAX_ROLE_INFERENCE_SHARDS;
  const manifestShardSet = new Set(manifestShardIds);
  const themes = (input.themeIndex?.themes ?? [])
    .slice()
    .sort((left, right) => right.docCount - left.docCount || left.label.localeCompare(right.label))
    .slice(0, MAX_ROLE_INFERENCE_THEMES);

  const selected: string[] = [];
  if (themes.length) {
    let round = 0;
    while (selected.length < maxShards) {
      let addedInRound = false;
      for (const theme of themes) {
        const shardId = theme.shardIds[round];
        if (!shardId || !manifestShardSet.has(shardId) || selected.includes(shardId)) continue;
        selected.push(shardId);
        addedInRound = true;
        if (selected.length >= maxShards) break;
      }
      if (!addedInRound) break;
      round += 1;
    }
  }

  if (selected.length >= Math.min(maxShards, manifestShardIds.length)) {
    return selected;
  }

  for (const shardId of selectEvenlySpacedItems(manifestShardIds, Math.min(maxShards, manifestShardIds.length))) {
    if (!selected.includes(shardId)) {
      selected.push(shardId);
    }
    if (selected.length >= maxShards) break;
  }

  return selected.slice(0, maxShards);
}

function buildDocEntry(doc: BacklogDoc) {
  return {
    key: normalizeWhitespace(doc.key),
    summary: trimText(doc.summary, MAX_DOC_SUMMARY_CHARS),
    description: trimText(doc.description, MAX_DOC_DESCRIPTION_CHARS),
    acceptanceCriteria: trimText(doc.acceptanceCriteria, MAX_DOC_AC_CHARS),
  };
}

function selectThemeDrivenDocs(input: {
  loadedDocs: BacklogDoc[];
  themeIndex: BacklogThemeIndex;
  maxDocs: number;
}): BacklogDoc[] {
  const themes = (input.themeIndex.themes ?? [])
    .slice()
    .sort((left, right) => right.docCount - left.docCount || left.label.localeCompare(right.label))
    .slice(0, MAX_ROLE_INFERENCE_THEMES);
  const docsByKey = new Map(input.loadedDocs.map((doc) => [doc.key, doc]));
  const selected: BacklogDoc[] = [];
  const seenKeys = new Set<string>();

  let round = 0;
  while (selected.length < input.maxDocs) {
    let addedInRound = false;
    for (const theme of themes) {
      const issueKey = theme.sampleIssueKeys[round];
      const doc = issueKey ? docsByKey.get(issueKey) : null;
      if (!doc || seenKeys.has(doc.key)) continue;
      selected.push(doc);
      seenKeys.add(doc.key);
      addedInRound = true;
      if (selected.length >= input.maxDocs) break;
    }
    if (!addedInRound) break;
    round += 1;
  }

  const themeTerms = dedupeStrings(
    themes.flatMap((theme) => [
      theme.label,
      ...(theme.keywords ?? []),
      ...(theme.signatureTerms ?? []),
    ]),
  ).flatMap(tokenize);

  const remaining = input.loadedDocs
    .filter((doc) => !seenKeys.has(doc.key))
    .sort((left, right) => {
      const scoreDiff = scoreDocAgainstTerms(right, themeTerms) - scoreDocAgainstTerms(left, themeTerms);
      if (scoreDiff !== 0) return scoreDiff;
      return compareUpdatedDescending(left, right);
    });

  for (const doc of remaining) {
    selected.push(doc);
    if (selected.length >= input.maxDocs) break;
  }

  return selected.slice(0, input.maxDocs);
}

function selectShardFallbackDocs(shardDocs: Record<string, BacklogDoc[]>, maxDocs: number): BacklogDoc[] {
  const shards = Object.values(shardDocs)
    .map((docs) => docs.slice().sort(compareUpdatedDescending))
    .filter((docs) => docs.length > 0);
  if (!shards.length) return [];

  const selected: BacklogDoc[] = [];
  let round = 0;
  while (selected.length < maxDocs) {
    let addedInRound = false;
    for (const docs of shards) {
      const doc = docs[round];
      if (!doc) continue;
      selected.push(doc);
      addedInRound = true;
      if (selected.length >= maxDocs) break;
    }
    if (!addedInRound) break;
    round += 1;
  }

  return selected.slice(0, maxDocs);
}

export function sampleBacklogDocsForRoleInference(
  cache: {
    themeIndex?: BacklogThemeIndex | null;
    shardDocs?: Record<string, BacklogDoc[]>;
    legacy?: LegacyBacklogIndexCache | null;
  },
  options?: {
    maxDocs?: number;
    maxChars?: number;
  },
): RoleInferenceSample {
  const maxDocs = options?.maxDocs ?? MAX_ROLE_INFERENCE_DOCS;
  const maxChars = options?.maxChars ?? MAX_ROLE_INFERENCE_CORPUS_CHARS;
  const shardDocs = cache.shardDocs ?? {};
  const loadedDocs = Object.values(shardDocs).flat();

  const candidates = cache.themeIndex?.themes?.length && loadedDocs.length
    ? selectThemeDrivenDocs({ loadedDocs, themeIndex: cache.themeIndex, maxDocs })
    : loadedDocs.length
      ? selectShardFallbackDocs(shardDocs, maxDocs)
      : selectEvenlySpacedItems((cache.legacy?.docs ?? []).slice().sort(compareUpdatedDescending), maxDocs);

  const entries: Array<ReturnType<typeof buildDocEntry>> = [];
  const docs: BacklogDoc[] = [];
  let currentChars = 0;

  for (const doc of candidates) {
    const entry = buildDocEntry(doc);
    const entryJson = JSON.stringify(entry);
    if (docs.length > 0 && currentChars + entryJson.length + 2 > maxChars) break;
    docs.push(doc);
    entries.push(entry);
    currentChars += entryJson.length + 2;
    if (docs.length >= maxDocs) break;
  }

  return {
    docs,
    corpus: JSON.stringify(entries),
  };
}

export function normalizeRoleInferenceSuggestions(
  rawSuggestions: unknown,
  sampledIssueKeys: string[],
): ProjectPersonaRoleSuggestion[] {
  const sampledSet = new Set(sampledIssueKeys.map((key) => normalizeWhitespace(key)));
  const byRole = new Map<string, ProjectPersonaRoleSuggestion>();

  for (const candidate of Array.isArray(rawSuggestions) ? rawSuggestions : []) {
    const role = normalizeRoleName(String((candidate as { role?: string })?.role ?? ''));
    const activities = trimText(String((candidate as { activities?: string })?.activities ?? ''), MAX_ACTIVITY_CHARS);
    if (!role || !activities || isGenericRole(role)) continue;

    const confidence = normalizeConfidence((candidate as { confidence?: unknown })?.confidence);
    const evidenceIssueKeys = dedupeStrings(
      Array.isArray((candidate as { evidenceIssueKeys?: unknown[] })?.evidenceIssueKeys)
        ? ((candidate as { evidenceIssueKeys?: unknown[] }).evidenceIssueKeys ?? []).map((value) => String(value ?? ''))
        : [],
      3,
    ).filter((issueKey) => sampledSet.has(issueKey));

    const normalized: ProjectPersonaRoleSuggestion = {
      role: trimText(role, MAX_ROLE_CHARS),
      activities,
      confidence,
      evidenceIssueKeys,
    };

    const key = roleKey(normalized.role);
    const existing = byRole.get(key);
    if (!existing) {
      byRole.set(key, normalized);
      continue;
    }

    const mergedConfidence = confidenceRank(normalized.confidence) > confidenceRank(existing.confidence)
      ? normalized.confidence
      : existing.confidence;
    const mergedActivities = normalized.activities.length > existing.activities.length
      ? normalized.activities
      : existing.activities;

    byRole.set(key, {
      role: existing.role.length >= normalized.role.length ? existing.role : normalized.role,
      activities: mergedActivities,
      confidence: mergedConfidence,
      evidenceIssueKeys: dedupeStrings([...existing.evidenceIssueKeys, ...normalized.evidenceIssueKeys], 3),
    });
  }

  return [...byRole.values()]
    .sort((left, right) => {
      const confidenceDiff = confidenceRank(right.confidence) - confidenceRank(left.confidence);
      if (confidenceDiff !== 0) return confidenceDiff;
      const evidenceDiff = right.evidenceIssueKeys.length - left.evidenceIssueKeys.length;
      if (evidenceDiff !== 0) return evidenceDiff;
      return left.role.localeCompare(right.role);
    })
    .slice(0, MAX_ROLE_SUGGESTIONS);
}

async function loadRoleInferenceCache(projectKey: string): Promise<LoadedInferenceCache> {
  const [manifest, themeIndex, legacy] = await Promise.all([
    objectRead<BacklogManifest>(KEYS.backlogManifest(projectKey)),
    objectRead<BacklogThemeIndex>(KEYS.backlogThemes(projectKey)),
    objectRead<LegacyBacklogIndexCache>(KEYS.backlogIndex(projectKey)),
  ]);

  const shardIds = selectRoleInferenceShardIds({ manifest, themeIndex });
  const shardEntries = await Promise.all(
    shardIds.map(async (shardId) => {
      const shard = await objectRead<BacklogShard>(KEYS.backlogDocsShard(projectKey, shardId));
      return [shardId, shard?.docs ?? []] as const;
    }),
  );

  return {
    manifest,
    themeIndex,
    legacy,
    shardDocs: Object.fromEntries(shardEntries),
  };
}

function buildProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  };
}

export async function inferProjectPersonaRolesFromBacklog(
  projectKey: string,
  config: TenantConfig,
): Promise<InferProjectPersonaRolesResult> {
  const cache = await loadRoleInferenceCache(projectKey);
  if (!cache.manifest?.issueCount && !(cache.legacy?.docs?.length)) {
    return {
      success: false,
      suggestions: [],
      sampledIssueCount: 0,
      sampledIssueKeys: [],
      usedCache: true,
      error: 'Backlog context has not been built for this project yet.',
      message: 'Rebuild the backlog cache for this project first, then try suggesting roles again.',
    };
  }

  const sample = sampleBacklogDocsForRoleInference(cache);
  if (!sample.docs.length || !sample.corpus.trim()) {
    return {
      success: true,
      suggestions: [],
      sampledIssueCount: 0,
      sampledIssueKeys: [],
      usedCache: true,
      message: 'No backlog items in the current cache had enough usable detail to infer persona roles.',
    };
  }

  const effectiveConfig: TenantConfig = {
    ...config,
    generatorConfig: resolveEffectiveGeneratorConfig(config.generatorConfig),
  };

  try {
    const rawSuggestions = await callLlmJson<unknown[]>({
      model: effectiveConfig.generatorConfig.themeModel,
      systemPrompt: [
        'You infer human business roles from Jira backlog samples.',
        'Return valid JSON only.',
        'Infer only roles supported by repeated evidence in the provided backlog entries.',
        'Avoid generic placeholders like User, Users, Team, System, or Admin unless the backlog clearly uses them as the real role name.',
        'Each activities field must be one short sentence describing common activities.',
        'Do not invent organization-specific role names that are not grounded in the sample.',
      ].join(' '),
      userMessage: [
        `Infer up to ${MAX_ROLE_SUGGESTIONS} persona-role suggestions from this sampled backlog corpus.`,
        'Return a JSON array only.',
        'Each array item must be: {"role":"...","activities":"...","confidence":"high|medium|low","evidenceIssueKeys":["ABC-1","ABC-2"]}.',
        'Use only evidence issue keys that appear in the sample.',
        `Sampled backlog docs:\n${sample.corpus}`,
      ].join('\n\n'),
      maxTokens: 1200,
      reasoningEffort: 'low',
      ...buildProviderOpts(effectiveConfig),
    });

    const suggestions = normalizeRoleInferenceSuggestions(
      rawSuggestions,
      sample.docs.map((doc) => doc.key),
    );

    return {
      success: true,
      suggestions,
      sampledIssueCount: sample.docs.length,
      sampledIssueKeys: sample.docs.map((doc) => doc.key),
      usedCache: true,
      message: suggestions.length
        ? undefined
        : 'No repeated human roles stood out clearly enough in the sampled backlog items.',
    };
  } catch (error) {
    return {
      success: false,
      suggestions: [],
      sampledIssueCount: sample.docs.length,
      sampledIssueKeys: sample.docs.map((doc) => doc.key),
      usedCache: true,
      error: error instanceof Error ? error.message : 'Role inference failed.',
      message: 'Role suggestions could not be generated from the cached backlog sample.',
    };
  }
}
