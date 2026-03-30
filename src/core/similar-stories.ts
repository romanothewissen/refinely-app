/**
 * Similar story search — fully Forge-native using Jira JQL + Claude reranking.
 *
 * Replaces the Python cosine-similarity approach (impractical in Forge for 50K vectors).
 * Jira's own full-text search handles relevance; Claude reranks for business intent.
 */

import { asApp, assumeTrustedRoute } from '@forge/api';
import { callLlmJson } from './llm';
import { buildThemeExtractionPrompt, buildRerankPrompt } from './prompts';
import { GoldSource, SimilarStory, TenantConfig } from '../types';

export async function findSimilarStories(
  requirement: string,
  config: TenantConfig,
): Promise<SimilarStory[]> {
  if (!config.similarityConfig.useLlmRerank && !config.goldSources.length) {
    return [];
  }

  try {
    // Step 1: Extract searchable themes from the requirement (Haiku — cheap)
    const themes = await extractThemes(requirement, config.generatorConfig.themeModel);
    if (!themes.length) return [];

    // Step 2: JQL search across all configured gold sources
    const candidates = await searchJira(themes, config.goldSources);
    if (!candidates.length) return [];

    // Step 3: Claude reranking for business intent relevance
    if (config.similarityConfig.useLlmRerank && candidates.length > 5) {
      return await rerankWithClaude(requirement, candidates, config.generatorConfig.themeModel);
    }
    
    return candidates.slice(0, 15);
  } catch (err) {
    console.warn('[similar-stories] Search failed:', err);
    return [];
  }
}

// ─── Theme Extraction ─────────────────────────────────────────────────────────

async function extractThemes(requirement: string, model: string): Promise<string[]> {
  try {
    const themes = await callLlmJson<string[]>({
      model,
      systemPrompt: 'Extract searchable business themes from the requirement. Output a JSON array of short phrases only.',
      userMessage: buildThemeExtractionPrompt(requirement),
      maxTokens: 256,
    });
    return Array.isArray(themes) ? themes.filter(t => typeof t === 'string').slice(0, 5) : [];
  } catch {
    // Fallback: simple keyword extraction
    return extractKeywords(requirement);
  }
}

function extractKeywords(text: string): string[] {
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'are', 'was', 'be', 'been', 'with', 'that', 'this', 'from', 'by', 'as']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
  return words.filter(w => w.length > 3 && !stopWords.has(w)).slice(0, 5);
}

// ─── Jira JQL Search ──────────────────────────────────────────────────────────

async function searchJira(themes: string[], sources: GoldSource[]): Promise<SimilarStory[]> {
  if (!sources.length) return [];

  // 1. Gather all potential description and AR field IDs across all sources
  const allFieldIds = new Set<string>(['summary', 'status', 'updated', 'description']);
  for (const s of sources) {
    if (s.requirementsFieldId) allFieldIds.add(s.requirementsFieldId);
    if (s.arFieldIds) {
      for (const aid of s.arFieldIds) {
        if (aid) allFieldIds.add(aid);
      }
    }
  }

  // 2. Build JQL search
  const projectList = [...new Set(sources.map(s => s.project))].join(', ');
  const statusList = [...new Set(sources.map(s => `"${s.status}"`))] .join(', ');
  const searchText = themes.slice(0, 3).map(t => `"${t}"`).join(' ');

  const jql = `project in (${projectList}) AND status in (${statusList}) AND text ~ ${searchText} ORDER BY updated DESC`;

  try {
    const response = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/search'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        maxResults: 30, // Get a larger candidate pool for rerank
        fields: Array.from(allFieldIds),
      }),
    });

    const data = await response.json() as { issues?: Array<{ key: string; fields: Record<string, any> }> };
    const baseUrl = await getJiraBaseUrl();

    return (data.issues ?? []).map(issue => {
      // Find source to identify its specific AR fields
      const pId = issue.key.split('-')[0];
      const src = sources.find(s => s.project === pId) || sources[0];
      
      // Extraction (borrowing same ADF parsing logic as gold-standard.ts)
      const desc = extractText(issue.fields.description);
      const acParts = (src.arFieldIds || []).concat(src.requirementsFieldId || [])
        .filter(Boolean)
        .map(id => extractText(issue.fields[id]))
        .filter(Boolean);
        
      return {
        key: issue.key,
        summary: String(issue.fields.summary ?? ''),
        description: desc,
        acceptanceCriteria: acParts.join('\n\n'),
        url: `${baseUrl}/browse/${issue.key}`,
      };
    });
  } catch (err) {
    console.warn('[similar-stories] JQL search failed:', err);
    return [];
  }
}

function extractText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(extractText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const adf = value as { type?: string; content?: unknown[]; text?: string };
    if (adf.text) return adf.text;
    if (adf.content) return adf.content.map(extractText).join('\n');
  }
  return String(value);
}

// ─── Claude Reranking ─────────────────────────────────────────────────────────

async function rerankWithClaude(
  requirement: string,
  candidates: SimilarStory[],
  model: string,
): Promise<SimilarStory[]> {
  try {
    const summaries = candidates.map(c => `${c.key}: ${c.summary}`);
    const prompt = buildRerankPrompt(requirement, summaries);

    const ranked = await callLlmJson<number[]>({
      model,
      systemPrompt: 'Rank the Jira issues by relevance to the requirement. Output a JSON array of 1-based indices.',
      userMessage: prompt,
      maxTokens: 256,
    });

    if (!Array.isArray(ranked)) return candidates.slice(0, 15);

    return ranked
      .slice(0, 15)
      .map(idx => candidates[idx - 1])
      .filter((c): c is SimilarStory => !!c);
  } catch {
    return candidates.slice(0, 5);
  }
}

// ─── Jira base URL helper ─────────────────────────────────────────────────────

async function getJiraBaseUrl(): Promise<string> {
  try {
    const res = await asApp().requestJira(assumeTrustedRoute('/rest/api/3/serverInfo'));
    const data = await res.json() as { baseUrl?: string };
    return data.baseUrl ?? 'https://your-site.atlassian.net';
  } catch {
    return 'https://your-site.atlassian.net';
  }
}

export function formatSimilarStoriesText(items: SimilarStory[], maxItems = 15): string {
  if (!items.length) return '';
  return items
    .slice(0, maxItems)
    .map((item, i) => {
      return [
        `--- Backlog Item ${i + 1} (${item.key}) ---`,
        `Summary: ${item.summary}`,
        item.description ? `Description: ${item.description.slice(0, 1000)}` : '',
        item.acceptanceCriteria ? `Acceptance Criteria:\n${item.acceptanceCriteria.slice(0, 1500)}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n');
}
