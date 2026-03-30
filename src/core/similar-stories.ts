/**
 * Project backlog retrieval with project-level cached indexing.
 *
 * Uses deployed Jira issues from the selected project as the main context pool.
 * Retrieval is cheap-first: cached lexical scoring, then optional LLM rerank on
 * a small shortlist only.
 */

import { asApp, assumeTrustedRoute } from '@forge/api';
import { callLlmJson } from './llm';
import { buildRerankPrompt } from './prompts';
import { SimilarStory, TenantConfig } from '../types';
import { objectRead, objectWrite, KEYS } from '../services/cache';

interface BacklogDoc {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  updated: string;
  combinedText: string;
  scoreHints: {
    summaryTerms: string[];
    arTerms: string[];
  };
}

interface BacklogIndexCache {
  projectKey: string;
  builtAt: string;
  issueCount: number;
  docs: BacklogDoc[];
}

export const INDEX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INDEX_ITEMS = 1000;

export async function findSimilarStories(
  requirement: string,
  config: TenantConfig,
  projectKey = '*',
): Promise<SimilarStory[]> {
  if (!projectKey || projectKey === '*') {
    return [];
  }

  try {
    const index = await ensureBacklogIndex(projectKey, config);
    if (!index.docs.length) return [];

    const candidates = lexicalRetrieve(requirement, index.docs).slice(0, 24);
    if (!candidates.length) return [];

    let ranked = candidates;
    if (config.similarityConfig.useLlmRerank && candidates.length > 5) {
      ranked = await rerankWithClaude(requirement, candidates, config.generatorConfig.themeModel);
    }

    const baseUrl = await getJiraBaseUrl();
    return ranked.slice(0, 12).map(item => ({
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

async function ensureBacklogIndex(projectKey: string, config: TenantConfig): Promise<BacklogIndexCache> {
  const cacheKey = KEYS.backlogIndex(projectKey);
  const cached = await objectRead<BacklogIndexCache>(cacheKey);
  if (cached?.builtAt && Date.now() - new Date(cached.builtAt).getTime() < INDEX_TTL_MS && cached.docs?.length) {
    return cached;
  }

  const refreshed = await buildBacklogIndex(projectKey, config);
  await objectWrite(cacheKey, refreshed);
  return refreshed;
}

export async function getBacklogCacheInfo(projectKey: string): Promise<{ projectKey: string; builtAt?: string; issueCount: number; stale: boolean }> {
  const cacheKey = KEYS.backlogIndex(projectKey);
  const cached = await objectRead<BacklogIndexCache>(cacheKey);
  if (!cached) {
    return { projectKey, issueCount: 0, stale: true };
  }

  return {
    projectKey,
    builtAt: cached.builtAt,
    issueCount: cached.issueCount ?? cached.docs?.length ?? 0,
    stale: !cached.builtAt || (Date.now() - new Date(cached.builtAt).getTime() >= INDEX_TTL_MS),
  };
}

export async function refreshBacklogCache(projectKey: string, config: TenantConfig): Promise<{ projectKey: string; builtAt: string; issueCount: number }> {
  const refreshed = await buildBacklogIndex(projectKey, config);
  await objectWrite(KEYS.backlogIndex(projectKey), refreshed);
  return {
    projectKey,
    builtAt: refreshed.builtAt,
    issueCount: refreshed.issueCount,
  };
}

export async function refreshBacklogCachesForProjects(projectKeys: string[], config: TenantConfig): Promise<Array<{ projectKey: string; builtAt: string; issueCount: number }>> {
  const uniqueProjectKeys = [...new Set(projectKeys.filter(key => key && key !== '*'))];
  const results: Array<{ projectKey: string; builtAt: string; issueCount: number }> = [];

  for (const projectKey of uniqueProjectKeys) {
    try {
      results.push(await refreshBacklogCache(projectKey, config));
    } catch (err) {
      console.warn(`[similar-stories] Failed to refresh backlog cache for ${projectKey}:`, err);
    }
  }

  return results;
}

async function buildBacklogIndex(projectKey: string, config: TenantConfig): Promise<BacklogIndexCache> {
  const fields = buildFieldList(config, projectKey);
  const statusClause = buildBacklogStatusClause(config, projectKey);
  const docs: BacklogDoc[] = [];
  let startAt = 0;
  const pageSize = 50;

  while (docs.length < MAX_INDEX_ITEMS) {
    const response = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: `project = ${projectKey} AND ${statusClause} AND issuetype not in subTaskIssueTypes() ORDER BY updated DESC`,
        maxResults: pageSize,
        startAt,
        fields,
      }),
    });

    const data = await response.json() as { issues?: Array<{ key: string; fields: Record<string, unknown> }>; total?: number };
    const issues = data.issues ?? [];
    if (!issues.length) break;

    for (const issue of issues) {
      const doc = issueToBacklogDoc(issue, config, projectKey);
      if (doc.summary || doc.description || doc.acceptanceCriteria) {
        docs.push(doc);
      }
      if (docs.length >= MAX_INDEX_ITEMS) break;
    }

    startAt += issues.length;
    if (startAt >= (data.total ?? 0)) break;
  }

  return {
    projectKey,
    builtAt: new Date().toISOString(),
    issueCount: docs.length,
    docs,
  };
}

function buildBacklogStatusClause(config: TenantConfig, projectKey: string): string {
  const scopedStatuses = config.backlogStatusScopes?.find(scope => scope.projectKey === projectKey)?.statuses ?? [];
  const uniqueStatuses = [...new Set(scopedStatuses.map(status => String(status).trim()).filter(Boolean))];
  if (!uniqueStatuses.length) {
    return 'statusCategory = Done';
  }

  const quotedStatuses = uniqueStatuses
    .map(status => `"${status.replace(/"/g, '\\"')}"`)
    .join(', ');

  return `status in (${quotedStatuses})`;
}

function buildFieldList(config: TenantConfig, projectKey: string): string[] {
  const mapping = config.arMappings?.find(m => m.projectKey === projectKey)
    || config.arMappings?.find(m => m.projectKey === '*');
  const fieldIds = new Set<string>(['summary', 'description', 'updated']);

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
  const description = extractText(issue.fields.description).trim();
  const acceptanceCriteria = extractAcceptanceCriteria(issue.fields, mapping).trim();
  const combinedText = [summary, description, acceptanceCriteria].filter(Boolean).join('\n\n');

  return {
    key: issue.key,
    summary,
    description,
    acceptanceCriteria,
    updated: String(issue.fields.updated ?? ''),
    combinedText,
    scoreHints: {
      summaryTerms: tokenize(summary),
      arTerms: tokenize(acceptanceCriteria),
    },
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

function lexicalRetrieve(requirement: string, docs: BacklogDoc[]): Array<BacklogDoc & { relevanceScore: number }> {
  const terms = buildQueryTerms(requirement);
  if (!terms.length) return [];

  const avgLen = docs.reduce((sum, doc) => sum + tokenize(doc.combinedText).length, 0) / Math.max(docs.length, 1);
  const scored = docs.map(doc => {
    const docTerms = tokenize(doc.combinedText);
    const freq = buildTermFreq(docTerms);
    const docLen = Math.max(docTerms.length, 1);
    let score = 0;

    for (const term of terms) {
      const tf = freq[term] ?? 0;
      if (!tf) continue;
      const docFreq = docs.filter(d => tokenize(d.combinedText).includes(term)).length || 1;
      const idf = Math.log((docs.length + 1) / docFreq);
      score += idf * ((tf * 2.5) / (tf + 1.5 * (1 - 0.75 + 0.75 * (docLen / Math.max(avgLen, 1)))));
    }

    const summaryBoost = terms.filter(term => doc.scoreHints.summaryTerms.includes(term)).length * 1.2;
    const arBoost = terms.filter(term => doc.scoreHints.arTerms.includes(term)).length * 0.9;
    return { ...doc, relevanceScore: score + summaryBoost + arBoost };
  });

  return scored
    .filter(doc => doc.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
}

function buildQueryTerms(requirement: string): string[] {
  const baseTerms = tokenize(requirement);
  const phrases = requirement
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  const bigrams: string[] = [];
  for (let i = 0; i < phrases.length - 1; i++) {
    const left = phrases[i];
    const right = phrases[i + 1];
    if (left.length > 2 && right.length > 2) {
      bigrams.push(`${left} ${right}`);
    }
  }

  return [...new Set([...baseTerms.slice(0, 10), ...bigrams.slice(0, 4)])];
}

function tokenize(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'was', 'be', 'been', 'with', 'that', 'this', 'from', 'by', 'as', 'it', 'its', 'into', 'then']);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

function buildTermFreq(terms: string[]): Record<string, number> {
  const freq: Record<string, number> = {};
  for (const term of terms) {
    freq[term] = (freq[term] ?? 0) + 1;
  }
  return freq;
}

async function rerankWithClaude(
  requirement: string,
  candidates: Array<BacklogDoc & { relevanceScore: number }>,
  model: string,
): Promise<Array<BacklogDoc & { relevanceScore: number }>> {
  try {
    const summaries = candidates.map(c => `${c.key}: ${c.summary}`);
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

async function getJiraBaseUrl(): Promise<string> {
  try {
    const res = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/serverInfo'));
    const data = await res.json() as { baseUrl?: string };
    return data.baseUrl ?? 'https://your-site.atlassian.net';
  } catch {
    return 'https://your-site.atlassian.net';
  }
}

export function formatSimilarStoriesText(items: SimilarStory[], maxItems = 12): string {
  if (!items.length) return '';
  return items
    .slice(0, maxItems)
    .map((item, index) => ([
      `--- Backlog Reference ${index + 1} (${item.key}) ---`,
      `Summary: ${item.summary}`,
      item.description ? `Description: ${item.description.slice(0, 900)}` : '',
      item.acceptanceCriteria ? `Acceptance Criteria:\n${item.acceptanceCriteria.slice(0, 1400)}` : '',
    ].filter(Boolean).join('\n')))
    .join('\n\n');
}
