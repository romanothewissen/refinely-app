import { asApp, assumeTrustedRoute } from '@forge/api';
import { GoldSource, TenantConfig } from '../types';

interface SearchJqlResponse {
  issues?: Array<{ key: string; fields: Record<string, unknown> }>;
}

export interface ReferenceExamplesResult {
  text: string;
  count: number;
  examples: Array<{ key: string; summary: string }>;
}

export async function fetchReferenceExamples(
  config: TenantConfig,
  projectKey: string,
  opts?: { perSourceLimit?: number; overallLimit?: number },
): Promise<ReferenceExamplesResult> {
  const activeSources = getActiveSources(config.goldSources ?? [], projectKey);
  if (!activeSources.length) {
    return { text: '', count: 0, examples: [] };
  }

  const perSourceLimit = Math.max(1, opts?.perSourceLimit ?? 4);
  const overallLimit = Math.max(1, opts?.overallLimit ?? 8);
  const collected: Array<{ key: string; summary: string; description: string; acceptanceCriteria: string }> = [];

  for (const source of activeSources) {
    if (collected.length >= overallLimit) break;
    try {
      const sourceExamples = await fetchSourceExamples(source, Math.min(perSourceLimit, overallLimit - collected.length));
      collected.push(...sourceExamples);
    } catch (error) {
      console.warn('[reference-examples] Failed to fetch configured source, continuing:', error);
    }
  }

  if (!collected.length) {
    return { text: '', count: 0, examples: [] };
  }

  const text = [
    'CONFIGURED REFERENCE EXAMPLES:',
    'Use these as examples of backlog scope, tone, and acceptance depth for this workspace. Match the business depth and structure, not any customer-specific terminology.',
    '',
    ...collected.map((example, index) => ([
      `--- Reference Example ${index + 1} (${example.key}) ---`,
      `Summary: ${example.summary}`,
      example.description ? `Description: ${example.description.slice(0, 700)}` : '',
      example.acceptanceCriteria ? `Acceptance Criteria:\n${example.acceptanceCriteria.slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n'))),
  ].join('\n');

  return {
    text,
    count: collected.length,
    examples: collected.map((example) => ({ key: example.key, summary: example.summary })),
  };
}

function getActiveSources(sources: GoldSource[], projectKey: string): GoldSource[] {
  return sources.filter((source) => {
    const targets = source.targetProjects?.length ? source.targetProjects : ['*'];
    return targets.includes('*') || targets.includes(projectKey);
  });
}

async function fetchSourceExamples(
  source: GoldSource,
  limit: number,
): Promise<Array<{ key: string; summary: string; description: string; acceptanceCriteria: string }>> {
  const fields = new Set<string>(['summary', 'description', 'updated']);
  if (source.requirementsFieldId && source.requirementsFieldId !== 'description') {
    fields.add(source.requirementsFieldId);
  }
  for (const fieldId of source.arFieldIds ?? []) {
    if (fieldId) fields.add(fieldId);
  }

  const jql = buildSourceJql(source);
  const data = await runSearchJql({
    jql,
    maxResults: Math.max(1, Math.min(limit, source.maxItems || limit)),
    fields: Array.from(fields),
  });

  return (data.issues ?? []).map((issue) => ({
    key: issue.key,
    summary: String(issue.fields.summary ?? '').trim(),
    description: extractText(issue.fields.description).trim(),
    acceptanceCriteria: extractAcceptanceCriteria(issue.fields, source).trim(),
  })).filter((item) => item.summary || item.description || item.acceptanceCriteria);
}

function buildSourceJql(source: GoldSource): string {
  const clauses = [
    `project = ${source.project}`,
    `issuetype = "${source.issuetype.replace(/"/g, '\\"')}"`,
  ];

  const statuses = (source.statuses?.length ? source.statuses : source.status ? [source.status] : [])
    .map((status) => String(status).trim())
    .filter(Boolean);
  if (statuses.length) {
    clauses.push(`status in (${statuses.map((status) => `"${status.replace(/"/g, '\\"')}"`).join(', ')})`);
  }

  const labels = (source.labels ?? []).map((label) => String(label).trim()).filter(Boolean);
  if (labels.length) {
    clauses.push(`labels in (${labels.map((label) => `"${label.replace(/"/g, '\\"')}"`).join(', ')})`);
  }

  return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

async function runSearchJql(payload: {
  jql: string;
  maxResults: number;
  fields: string[];
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

  return JSON.parse(raw) as SearchJqlResponse;
}

function extractAcceptanceCriteria(fields: Record<string, unknown>, source: GoldSource): string {
  const parts: string[] = [];

  for (const fieldId of source.arFieldIds ?? []) {
    const text = extractText(fields[fieldId]);
    if (text) parts.push(text);
  }

  if (!parts.length && source.requirementsFieldId && source.requirementsFieldId !== 'description') {
    const text = extractText(fields[source.requirementsFieldId]);
    if (text) parts.push(text);
  }

  if (!parts.length) {
    const description = extractText(fields.description);
    if (description) parts.push(description);
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
