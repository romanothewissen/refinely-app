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
  candidateSummary: string;
}

export const MAX_ROLE_INFERENCE_DOCS = 36;
export const MAX_ROLE_INFERENCE_SHARDS = 12;
export const MAX_ROLE_INFERENCE_THEMES = 12;
export const MAX_ROLE_INFERENCE_CORPUS_CHARS = 11000;
const MAX_ROLE_CANDIDATE_SUMMARY_CHARS = 2200;
const FALLBACK_ROLE_INFERENCE_DOCS = 18;
const PRIMARY_ROLE_INFERENCE_TOKENS = 2200;
const FALLBACK_ROLE_INFERENCE_TOKENS = 2200;

const MAX_DOC_SUMMARY_CHARS = 140;
const MAX_DOC_DESCRIPTION_CHARS = 220;
const MAX_DOC_AC_CHARS = 220;
const MAX_ACTIVITY_CHARS = 180;
const MAX_ROLE_CHARS = 72;
const MAX_ROLE_SUGGESTIONS = 10;
const MAX_ROLE_CANDIDATES = 14;
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
const ROLE_SUFFIXES = [
  'admin',
  'administrator',
  'agent',
  'analyst',
  'approver',
  'assistant',
  'associate',
  'auditor',
  'clerk',
  'coach',
  'consultant',
  'coordinator',
  'customer',
  'dispatcher',
  'doctor',
  'editor',
  'employee',
  'engineer',
  'field',
  'finance',
  'lead',
  'manager',
  'operator',
  'owner',
  'partner',
  'planner',
  'reader',
  'representative',
  'requester',
  'reviewer',
  'scheduler',
  'seller',
  'specialist',
  'staff',
  'student',
  'supervisor',
  'support',
  'teacher',
  'technician',
  'user',
  'worker',
];
const ROLE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'to', 'for', 'of', 'in', 'on', 'by', 'with', 'from',
  'new', 'existing', 'current', 'all', 'any', 'each', 'every', 'selected', 'related',
  'other', 'another', 'their', 'our', 'your', 'this', 'that', 'these', 'those',
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

function titleCaseWords(value: string): string {
  return normalizeWhitespace(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

function singularizeRoleToken(value: string): string {
  if (value.endsWith('ies') && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith('s') && !value.endsWith('ss') && value.length > 3) return value.slice(0, -1);
  return value;
}

function normalizeRoleCandidate(value: string): string {
  const normalized = normalizeWhitespace(value)
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!normalized) return '';

  const parts = normalized
    .split(' ')
    .map((part) => singularizeRoleToken(part.toLowerCase()))
    .filter((part) => part && !ROLE_STOP_WORDS.has(part));
  if (!parts.length || parts.length > 5) return '';

  const last = parts[parts.length - 1];
  const looksLikeRole = ROLE_SUFFIXES.includes(last)
    || parts.some((part) => ROLE_SUFFIXES.includes(part));
  if (!looksLikeRole) return '';

  const joined = parts.join(' ');
  if (isGenericRole(joined)) return '';
  return titleCaseWords(joined);
}

function collectRolePatternMatches(text: string): string[] {
  const matches: string[] = [];
  const normalized = normalizeWhitespace(text);
  if (!normalized) return matches;

  const patterns = [
    /\bas\s+an?\s+([A-Za-z][A-Za-z\s/-]{1,60}?)(?=\s+(?:i|can|need|should|must|may|wants?|needs?|views?|creates?|updates?|reviews?|approves?|schedules?|dispatches?|tracks?)\b|[,.]|$)/gi,
    /\bfor\s+an?\s+([A-Za-z][A-Za-z\s/-]{1,60}?)(?=\s+(?:to|who|that)\b|[,.]|$)/gi,
    /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const candidate = normalizeRoleCandidate(match[1] ?? '');
      if (candidate) matches.push(candidate);
    }
  }

  return matches;
}

function buildRoleCandidateSummary(input: {
  docs: BacklogDoc[];
  maxChars: number;
}): string {
  const candidateMap = new Map<string, { role: string; count: number; evidence: string[] }>();

  for (const doc of input.docs) {
    const text = [doc.summary, doc.description, doc.acceptanceCriteria].join(' \n ');
    const candidates = dedupeStrings(collectRolePatternMatches(text));
    for (const candidate of candidates) {
      const key = roleKey(candidate);
      const existing = candidateMap.get(key) ?? { role: candidate, count: 0, evidence: [] };
      existing.count += 1;
      if (existing.evidence.length < 3 && !existing.evidence.includes(doc.key)) {
        existing.evidence.push(doc.key);
      }
      if (candidate.length > existing.role.length) {
        existing.role = candidate;
      }
      candidateMap.set(key, existing);
    }
  }

  const lines = [...candidateMap.values()]
    .sort((left, right) => right.count - left.count || right.evidence.length - left.evidence.length || left.role.localeCompare(right.role))
    .slice(0, MAX_ROLE_CANDIDATES)
    .map((candidate) => `${candidate.role} | mentions=${candidate.count} | evidence=${candidate.evidence.join(',')}`);

  let summary = '';
  for (const line of lines) {
    const next = summary ? `${summary}\n${line}` : line;
    if (next.length > input.maxChars) break;
    summary = next;
  }

  return summary;
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
  const candidateSourceDocs = loadedDocs.length
    ? loadedDocs
    : (cache.legacy?.docs ?? []).slice();

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
    candidateSummary: buildRoleCandidateSummary({
      docs: candidateSourceDocs.slice().sort(compareUpdatedDescending).slice(0, 240),
      maxChars: MAX_ROLE_CANDIDATE_SUMMARY_CHARS,
    }),
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
    anthropicApiKey: config.generatorConfig.anthropicApiKey,
    anthropicBaseUrl: config.generatorConfig.anthropicBaseUrl,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    openaiCompatibleApiKey: config.generatorConfig.openaiCompatibleApiKey,
    openaiCompatibleBaseUrl: config.generatorConfig.openaiCompatibleBaseUrl,
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

async function requestRoleSuggestionsFromCorpus(input: {
  corpus: string;
  candidateSummary?: string;
  sampledIssueKeys: string[];
  config: TenantConfig;
  maxSuggestions: number;
  maxEvidenceIssueKeys: number;
  maxTokens: number;
}): Promise<ProjectPersonaRoleSuggestion[]> {
  const rawSuggestions = await callLlmJson<unknown[]>({
    model: input.config.generatorConfig.themeModel,
    systemPrompt: [
      'You infer human business roles from Jira backlog samples.',
      'Return valid JSON only.',
      'Infer only roles supported by repeated evidence in the provided backlog entries.',
      'Avoid generic placeholders like User, Users, Team, System, or Admin unless the backlog clearly uses them as the real role name.',
      'Keep activities short and concrete.',
      'Do not invent organization-specific role names that are not grounded in the sample.',
    ].join(' '),
    userMessage: [
      `Infer up to ${input.maxSuggestions} persona-role suggestions from this sampled backlog corpus.`,
      'Return a JSON array only. Do not use Markdown fences.',
      `Each item must be {"role":"...","activities":"one short sentence","confidence":"high|medium|low","evidenceIssueKeys":["ABC-1"]}.`,
      `Use at most ${input.maxEvidenceIssueKeys} evidence issue key${input.maxEvidenceIssueKeys === 1 ? '' : 's'} per item.`,
      'Keep each activities sentence brief and avoid long explanations.',
      'Use only evidence issue keys that appear in the sample.',
      input.candidateSummary?.trim()
        ? `Candidate role signals mined from a broader cached backlog pass:\n${input.candidateSummary}`
        : '',
      `Sampled backlog docs:\n${input.corpus}`,
    ].filter(Boolean).join('\n\n'),
    maxTokens: input.maxTokens,
    reasoningEffort: 'low',
    ...buildProviderOpts(input.config),
  });

  return normalizeRoleInferenceSuggestions(rawSuggestions, input.sampledIssueKeys);
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
    let suggestions: ProjectPersonaRoleSuggestion[];
    try {
      console.info('[persona-role-inference] primary sample prepared', {
        projectKey,
        sampledDocs: sample.docs.length,
        sampledChars: sample.corpus.length,
        candidateSummaryChars: sample.candidateSummary.length,
      });
      suggestions = await requestRoleSuggestionsFromCorpus({
        corpus: sample.corpus,
        candidateSummary: sample.candidateSummary,
        sampledIssueKeys: sample.docs.map((doc) => doc.key),
        config: effectiveConfig,
        maxSuggestions: MAX_ROLE_SUGGESTIONS,
        maxEvidenceIssueKeys: 2,
        maxTokens: PRIMARY_ROLE_INFERENCE_TOKENS,
      });
    } catch (primaryError) {
      const fallbackSample = sampleBacklogDocsForRoleInference(cache, {
        maxDocs: Math.min(FALLBACK_ROLE_INFERENCE_DOCS, sample.docs.length),
        maxChars: Math.min(5400, MAX_ROLE_INFERENCE_CORPUS_CHARS),
      });
      if (!fallbackSample.docs.length || !fallbackSample.corpus.trim()) {
        throw primaryError;
      }
      console.warn('[persona-role-inference] falling back to smaller sample', {
        projectKey,
        sampledDocs: fallbackSample.docs.length,
        sampledChars: fallbackSample.corpus.length,
      });
      suggestions = await requestRoleSuggestionsFromCorpus({
        corpus: fallbackSample.corpus,
        candidateSummary: fallbackSample.candidateSummary,
        sampledIssueKeys: fallbackSample.docs.map((doc) => doc.key),
        config: effectiveConfig,
        maxSuggestions: 4,
        maxEvidenceIssueKeys: 1,
        maxTokens: FALLBACK_ROLE_INFERENCE_TOKENS,
      });
    }

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
