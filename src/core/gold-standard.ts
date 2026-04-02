/**
 * Gold standard fetching — Jira JQL via asApp().requestJira (queue consumer has no user session).
 * Replaces the hardcoded MAGSTC/GSMS2 client with N configurable sources.
 */

import { asApp, assumeTrustedRoute } from '@forge/api';
import { GoldSource } from '../types';
import { objectRead, objectWrite, entityGet, entitySet, KEYS } from '../services/cache';

export interface GoldItem {
  key: string;
  summary: string;
  description: string;
  acceptance_criteria: string;
  story_points?: number;
  source: string;
  deployed_date?: string;
}

interface GoldStandardsCache {
  items: GoldItem[];
  cachedAt: string;
  itemCount: number;
}

interface SearchJqlResponse {
  issues?: JiraIssue[];
  total?: number;
  nextPageToken?: string;
  isLast?: boolean;
}

// ─── Fetch few-shot examples for generation ───────────────────────────────────

export async function fetchGoldExamples(
  sources: GoldSource[],
  limitPerSource = 8,
): Promise<GoldItem[]> {
  const results: GoldItem[] = [];

  for (const source of sources) {
    try {
      const items = await fetchFromSource(source, limitPerSource);
      results.push(...items);
    } catch (err) {
      console.warn(`[gold-standard] Failed to fetch from source ${source.key}:`, err);
    }
  }

  return results;
}

/**
 * Format gold examples as a prompt block for injection into generation prompts.
 */
export function formatGoldExamplesText(items: GoldItem[], maxItems = 15, descMax = 1500, acMax = 1500): string {
  if (!items.length) return '';

  return items
    .slice(0, maxItems)
    .map((item, i) => {
      let desc = item.description || '(no description)';
      if (desc.length > descMax) desc = desc.slice(0, descMax) + '…';
      let ac = item.acceptance_criteria || '';
      if (ac.length > acMax) ac = ac.slice(0, acMax) + '…';

      return [
        `--- Example ${i + 1} (${item.source}) ---`,
        `Feature: ${item.summary}`,
        `Description: ${desc}`,
        ac ? `Acceptance Criteria:\n${ac}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

// ─── Cache management (for large deployed histories) ─────────────────────────

export async function loadGoldCache(): Promise<GoldStandardsCache | null> {
  return objectRead<GoldStandardsCache>(KEYS.goldStandards);
}

export async function refreshGoldCache(sources: GoldSource[], maxItemsPerSource = 500): Promise<GoldStandardsCache> {
  const allItems: GoldItem[] = [];

  for (const source of sources) {
    try {
      const items = await fetchFromSourcePaginated(source, maxItemsPerSource);
      allItems.push(...items);
    } catch (err) {
      console.warn(`[gold-standard] Cache refresh failed for source ${source.key}:`, err);
    }
  }

  const cache: GoldStandardsCache = {
    items: allItems,
    cachedAt: new Date().toISOString(),
    itemCount: allItems.length,
  };

  await objectWrite(KEYS.goldStandards, cache);
  await entitySet(KEYS.goldCacheInfo, { cachedAt: cache.cachedAt, itemCount: cache.itemCount });

  return cache;
}

export async function getCacheInfo(): Promise<{ cachedAt?: string; itemCount?: number }> {
  return (await entityGet(KEYS.goldCacheInfo)) ?? {};
}

// ─── Jira API helpers ─────────────────────────────────────────────────────────

async function fetchFromSource(source: GoldSource, limit: number): Promise<GoldItem[]> {
  const fields = buildFieldList(source);
  const labelFilter = source.labels?.length
    ? ` AND labels in (${source.labels.map(l => `"${l}"`).join(', ')})`
    : '';
  const statuses = getSourceStatuses(source);
  const statusFilter = statuses.length
    ? `status in (${statuses.map(s => `"${s}"`).join(', ')})`
    : 'statusCategory = Done';

  const jql = `project = ${source.project} AND issuetype = "${source.issuetype}" AND ${statusFilter}${labelFilter} ORDER BY updated DESC`;

  const data = await runSearchJql({
    jql,
    maxResults: limit,
    fields,
  });
  return (data.issues ?? []).map(issue => parseIssue(issue, source));
}

async function fetchFromSourcePaginated(source: GoldSource, maxItems: number): Promise<GoldItem[]> {
  const fields = buildFieldList(source);
  const labelFilter = source.labels?.length
    ? ` AND labels in (${source.labels.map(l => `"${l}"`).join(', ')})`
    : '';
  const statuses = getSourceStatuses(source);
  const statusFilter = statuses.length
    ? `status in (${statuses.map(s => `"${s}"`).join(', ')})`
    : 'statusCategory = Done';

  const jql = `project = ${source.project} AND issuetype = "${source.issuetype}" AND ${statusFilter}${labelFilter} ORDER BY updated DESC`;

  const results: GoldItem[] = [];
  let nextPageToken: string | undefined;
  const pageSize = 50;

  while (results.length < maxItems) {
    const data = await runSearchJql({
      jql,
      maxResults: pageSize,
      fields,
      nextPageToken,
    });
    const issues = data.issues ?? [];
    if (!issues.length) break;

    results.push(...issues.map(issue => parseIssue(issue, source)));
    if (data.isLast || !data.nextPageToken) break;
    nextPageToken = data.nextPageToken;
  }

  return results.slice(0, maxItems);
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

function buildFieldList(source: GoldSource): string[] {
  const fields = ['summary', 'description', 'story_points', 'created', 'updated'];
  const seen = new Set(fields);
  if (source.requirementsFieldId && !seen.has(source.requirementsFieldId)) {
    fields.push(source.requirementsFieldId);
    seen.add(source.requirementsFieldId);
  }
  for (const id of source.arFieldIds) {
    if (id && !seen.has(id)) {
      fields.push(id);
      seen.add(id);
    }
  }
  return fields;
}

function getSourceStatuses(source: GoldSource): string[] {
  if (Array.isArray(source.statuses) && source.statuses.length) {
    return source.statuses.filter(Boolean);
  }
  if (source.status) {
    return [source.status];
  }
  return [];
}

// ─── Jira response parsing ────────────────────────────────────────────────────

interface JiraIssue {
  key: string;
  fields: Record<string, unknown>;
}

function parseIssue(issue: JiraIssue, source: GoldSource): GoldItem {
  const f = issue.fields;

  // Extract description from ADF or plain text
  const description = extractText(f.description);

  // Combine all configured AC fields (legacy single + multi-field list), deduped by id
  const acIds: string[] = [];
  const seen = new Set<string>();
  if (source.requirementsFieldId) {
    acIds.push(source.requirementsFieldId);
    seen.add(source.requirementsFieldId);
  }
  for (const id of source.arFieldIds) {
    if (id && !seen.has(id)) {
      acIds.push(id);
      seen.add(id);
    }
  }
  const parts = acIds.map(id => extractText(f[id])).filter(Boolean);
  const ac = parts.join('\n\n');

  return {
    key: issue.key,
    summary: String(f.summary ?? ''),
    description,
    acceptance_criteria: ac,
    story_points: typeof f.story_points === 'number' ? f.story_points : undefined,
    source: source.key,
    deployed_date: String(f.updated ?? ''),
  };
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
  }

  // Atlassian Document Format (ADF)
  if (typeof value === 'object' && value !== null) {
    const adf = value as { type?: string; content?: unknown[]; text?: string };
    if (adf.text) return adf.text;
    if (adf.content) return adf.content.map(extractText).join('\n');
  }

  return String(value);
}
