import { ClarifyAnswer, ProjectPersonaRole, ReferencedSimilarStory, ReferencedWiSection, SimilarStory, TenantConfig, WiDoc, WiChunk } from '../types';
import { findSimilarStories } from '../core/similar-stories';
import { retrieveWiContextMultiProject } from '../core/wi-ingestion';

export interface RetrievedWiContext {
  text: string;
  docs: WiDoc[];
  chunks: WiChunk[];
  linkedDocs: WiDoc[];
}

export function normalizeProjectKeys(projectKey?: string, projectKeys?: string[]): string[] {
  const normalized = [...(projectKeys ?? []), projectKey ?? '']
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '*');
  return [...new Set(normalized)].slice(0, 2);
}

export function resolvePrimaryProjectKey(projectKey?: string, projectKeys?: string[]): string {
  return normalizeProjectKeys(projectKey, projectKeys)[0] ?? '*';
}

export function buildCombinedDomainContext(config: TenantConfig, projectKeys: string[]): string {
  const contexts = projectKeys
    .map((key) => config.domainContexts?.find((entry) => entry.projectKey === key)?.context?.trim())
    .filter(Boolean) as string[];
  const globalContext = config.domainContexts?.find((entry) => entry.projectKey === '*')?.context?.trim();
  const fallback = config.domainContext?.trim();
  return [...new Set([...contexts, globalContext || fallback || ''].filter(Boolean))].join('\n\n');
}

export function getCombinedPersonaRoles(config: TenantConfig, projectKeys: string[]): ProjectPersonaRole[] {
  const scopedRoles = projectKeys.flatMap((key) => config.domainContexts?.find((entry) => entry.projectKey === key)?.personaRoles ?? []);
  const globalRoles = config.domainContexts?.find((entry) => entry.projectKey === '*')?.personaRoles ?? [];
  const legacyRoles = (config.domainRoles ?? []).map((role) => ({ role, activities: '' }));
  const combined = [...scopedRoles, ...globalRoles, ...legacyRoles];
  const seen = new Set<string>();

  return combined.filter((row) => {
    const role = String(row?.role ?? '').trim();
    const activities = String(row?.activities ?? '').trim();
    if (!role && !activities) return false;
    const key = `${role.toLowerCase()}::${activities.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function retrieveScopedWiContext(
  query: string,
  topK: number,
  maxChars: number,
  projectKeys: string[],
  selectedDocIds?: string[],
): Promise<RetrievedWiContext> {
  const result = await retrieveWiContextMultiProject(query, topK, maxChars, projectKeys, selectedDocIds);
  return {
    text: result.text,
    docs: result.docs,
    linkedDocs: result.linkedDocs,
    chunks: [...result.chunks].sort((left, right) => {
      if (left.filename !== right.filename) return left.filename.localeCompare(right.filename);
      return left.chunkIndex - right.chunkIndex;
    }),
  };
}

export async function retrieveScopedSimilarStories(input: {
  requirement: string;
  attachmentText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKeys: string[];
  maxResults?: number;
}): Promise<SimilarStory[]> {
  const keys = input.projectKeys.length ? input.projectKeys : [];
  if (!keys.length) return [];

  const perProjectMax = Math.max(4, Math.ceil((input.maxResults ?? 12) / keys.length));
  const results = await Promise.all(keys.map((projectKey) => findSimilarStories({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: input.clarifyAnswers,
    config: input.config,
    projectKey,
    maxResults: perProjectMax,
  })));

  const deduped = new Map<string, SimilarStory>();
  results.flat().forEach((story) => {
    const existing = deduped.get(story.key);
    if (!existing || (story.relevanceScore ?? 0) > (existing.relevanceScore ?? 0)) {
      deduped.set(story.key, story);
    }
  });

  return [...deduped.values()]
    .sort((left, right) => (right.relevanceScore ?? 0) - (left.relevanceScore ?? 0))
    .slice(0, input.maxResults ?? 12);
}

export function summarizeReferencedSimilarStories(stories: SimilarStory[]): ReferencedSimilarStory[] {
  return stories.map((story) => ({
    key: story.key,
    summary: story.summary,
    relevanceScore: story.relevanceScore,
    url: story.url,
    jiraIssueUrl: story.url,
  }));
}

export function summarizeReferencedWiSections(chunks: WiChunk[], maxChars = 180): ReferencedWiSection[] {
  return chunks.map((chunk) => ({
    docId: chunk.docId,
    filename: chunk.filename,
    chunkIndex: chunk.chunkIndex,
    ...(chunk.sectionLabel ? { sectionLabel: chunk.sectionLabel } : {}),
    excerpt: chunk.text.replace(/\s+/g, ' ').trim().slice(0, maxChars),
  }));
}
