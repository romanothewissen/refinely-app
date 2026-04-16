import type {
  ClarifyAnswer,
  ReferencedSimilarStory,
  SimilarStory,
  TenantConfig,
  WorkInstructionInsightArtifact,
} from '../types';
import { formatArPatternLibraryFromSimilarStories } from '../core/similar-stories';
import { buildWorkInstructionInsightArtifact, getWorkInstructionInsightCount } from '../core/wi-insights';
import { isPlausibleRoleLabel } from '../core/story-assistant-default';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
  retrieveScopedSimilarStories,
  retrieveScopedWiContext,
  summarizeReferencedSimilarStories,
  summarizeReferencedWiSections,
  type RetrievedWiContext,
} from './project-selection';
import { deriveRetrievalQuery } from './retrieval-query';

export interface SharedPipelineContextSources {
  projectKey: string;
  projectKeys: string[];
  projectCount: number;
  pipelineMode: 'story_assistant_default';
  domainContextApplied: boolean;
  attachmentIncluded: boolean;
  wiDocsCount: number;
  linkedWiDocCount: number;
  retrievedWiDocCount: number;
  retrievedWiChunkCount: number;
  wiInsightCount: number;
  similarStoriesCount: number;
  referencedWiDocs: Array<{ docId: string; filename: string; chunkCount: number }>;
  referencedWiSections: ReturnType<typeof summarizeReferencedWiSections>;
  referencedSimilarStories: ReferencedSimilarStory[];
  arPatternStoryKeys: string[];
  selectedWiDocIds?: string[];
}

export interface SharedPipelineContext {
  projectKey: string;
  projectKeys: string[];
  projectCount: number;
  domainContext: string;
  domainRoles: string[];
  wiContext: RetrievedWiContext;
  wiInsights: WorkInstructionInsightArtifact;
  similarStories: SimilarStory[];
  arPatternLibraryText: string;
  timings: {
    retrievalMs: number;
    wiInsightExtractionMs: number;
  };
  sources: SharedPipelineContextSources;
}

export interface SharedPipelineEvidenceBundle {
  signature: string;
  savedAt: number;
  context: {
    projectKey: string;
    projectKeys: string[];
    projectCount: number;
    domainContext: string;
    domainRoles: string[];
    wiContextText: string;
    wiInsights: WorkInstructionInsightArtifact;
    similarStories: SimilarStory[];
    arPatternLibraryText: string;
    timings: SharedPipelineContext['timings'];
    sources: SharedPipelineContextSources;
  };
}

function fingerprintClarifyAnswers(answers: ClarifyAnswer[]): string {
  if (!answers.length) return 'noans';
  const content = [...answers]
    .sort((a, b) => (a.categoryKey ?? '').localeCompare(b.categoryKey ?? ''))
    .map(a => `${a.categoryKey ?? ''}:${String(a.answer ?? '').trim().toLowerCase().slice(0, 60)}`)
    .join('|');
  // Simple djb2-style hash — no crypto dependency needed
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36).slice(0, 10);
}

export function buildSharedPipelineEvidenceSignature(input: {
  requirement: string;
  attachmentText?: string;
  projectKey?: string;
  projectKeys?: string[];
  pipelineMode?: 'story_assistant_default';
  includeSimilarStories?: boolean;
  clarifyAnswers?: ClarifyAnswer[];
  selectedWiDocIds?: string[];
}): string {
  const normalizedProjects = normalizeProjectKeys(input.projectKey, input.projectKeys).join('|');
  const retrievalQuery = deriveRetrievalQuery(input.requirement, input.attachmentText ?? '', input.clarifyAnswers ?? []);
  const answersHash = fingerprintClarifyAnswers(input.clarifyAnswers ?? []);
  return [
    input.pipelineMode ?? 'story_assistant_default',
    `projects:${normalizedProjects || '*'}`,
    `similar:${input.includeSimilarStories !== false ? '1' : '0'}`,
    `wiDocs:${(input.selectedWiDocIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean).sort().join(',') || '*'}`,
    retrievalQuery.toLowerCase(),
    `answers:${answersHash}`,
  ].join('||');
}

export function toSharedPipelineEvidenceBundle(
  context: SharedPipelineContext,
  signature: string,
): SharedPipelineEvidenceBundle {
  return {
    signature,
    savedAt: Date.now(),
    context: {
      projectKey: context.projectKey,
      projectKeys: context.projectKeys,
      projectCount: context.projectCount,
      domainContext: context.domainContext,
      domainRoles: context.domainRoles,
      wiContextText: context.wiContext.text,
      wiInsights: context.wiInsights,
      similarStories: context.similarStories,
      arPatternLibraryText: context.arPatternLibraryText,
      timings: context.timings,
      sources: context.sources,
    },
  };
}

export function fromSharedPipelineEvidenceBundle(
  bundle: SharedPipelineEvidenceBundle,
): SharedPipelineContext {
  return {
    projectKey: bundle.context.projectKey,
    projectKeys: bundle.context.projectKeys,
    projectCount: bundle.context.projectCount,
    domainContext: bundle.context.domainContext,
    domainRoles: bundle.context.domainRoles,
    wiContext: {
      text: bundle.context.wiContextText,
      docs: [],
      chunks: [],
      linkedDocs: [],
    },
    wiInsights: bundle.context.wiInsights,
    similarStories: bundle.context.similarStories,
    arPatternLibraryText: bundle.context.arPatternLibraryText,
    timings: bundle.context.timings,
    sources: bundle.context.sources,
  };
}

export async function loadSharedPipelineContext(input: {
  requirement: string;
  attachmentText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  pipelineMode?: 'story_assistant_default';
  includeSimilarStories?: boolean;
  selectedWiDocIds?: string[];
}): Promise<SharedPipelineContext> {
  const retrievalStartedAt = Date.now();
  const selectedProjectKeys = normalizeProjectKeys(input.projectKey, input.projectKeys);
  const primaryProjectKey = resolvePrimaryProjectKey(input.projectKey, input.projectKeys);
  const domainContext = buildCombinedDomainContext(input.config, selectedProjectKeys);
  const domainRoles = getCombinedPersonaRoles(input.config, selectedProjectKeys)
    .map((row) => row.role)
    .filter(Boolean)
    .filter(isPlausibleRoleLabel);
  const retrievalQuery = deriveRetrievalQuery(
    input.requirement,
    input.attachmentText ?? '',
    input.clarifyAnswers ?? [],
  );
  const includeSimilarStories = input.includeSimilarStories !== false;
  const pipelineProfile = input.config.generatorConfig.pipelineProfile;
  const similarMaxResults = pipelineProfile === 'fast'
    ? 4
    : pipelineProfile === 'quality'
      ? 12
      : 12; // raised so the quality scorer has a large enough pool to filter from
  const arPatternMaxStories = pipelineProfile === 'fast'
    ? 2
    : pipelineProfile === 'quality'
      ? 5
      : 5;
  const selectedWiDocIds = [...new Set((input.selectedWiDocIds ?? [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean))]
    .slice(0, 3);
  const [wiContext, similarStories] = await Promise.all([
    input.config.wiConfig.enabled
      ? retrieveScopedWiContext(
          retrievalQuery,
          input.config.wiConfig.topKChunks,
          input.config.wiConfig.maxChars,
          selectedProjectKeys,
          selectedWiDocIds,
        )
      : Promise.resolve({ text: '', docs: [], chunks: [], linkedDocs: [] }),
    includeSimilarStories
      ? retrieveScopedSimilarStories({
          requirement: retrievalQuery,
          attachmentText: input.attachmentText,
          clarifyAnswers: input.clarifyAnswers,
          config: input.config,
          projectKeys: selectedProjectKeys,
          maxResults: similarMaxResults,
        })
      : Promise.resolve([]),
  ]);
  const retrievalMs = Date.now() - retrievalStartedAt;
  const wiInsightStartedAt = Date.now();
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  const wiInsightExtractionMs = Date.now() - wiInsightStartedAt;
  const referencedWiSections = summarizeReferencedWiSections(wiContext.chunks.slice(0, 8));
  const referencedSimilarStories = summarizeReferencedSimilarStories(similarStories.slice(0, similarMaxResults));
  const arPatternLibrary = formatArPatternLibraryFromSimilarStories(similarStories, input.requirement, arPatternMaxStories);
  const arPatternStoryKeys = arPatternLibrary.storyKeys.length
    ? arPatternLibrary.storyKeys
    : similarStories
      .slice(0, 3)
      .map((story) => String(story.key ?? '').trim())
      .filter(Boolean);

  return {
    projectKey: primaryProjectKey,
    projectKeys: selectedProjectKeys,
    projectCount: selectedProjectKeys.length,
    domainContext,
    domainRoles,
    wiContext,
    wiInsights,
    similarStories,
    arPatternLibraryText: arPatternLibrary.text,
    timings: {
      retrievalMs,
      wiInsightExtractionMs,
    },
    sources: {
      projectKey: primaryProjectKey,
      projectKeys: selectedProjectKeys,
      projectCount: selectedProjectKeys.length,
      pipelineMode: input.pipelineMode ?? 'story_assistant_default',
      domainContextApplied: Boolean(domainContext.trim()),
      attachmentIncluded: Boolean(input.attachmentText?.trim()),
      wiDocsCount: wiContext.docs.length,
      linkedWiDocCount: wiContext.linkedDocs.length,
      retrievedWiDocCount: wiContext.docs.length,
      retrievedWiChunkCount: wiContext.chunks.length,
      wiInsightCount: getWorkInstructionInsightCount(wiInsights),
      similarStoriesCount: similarStories.length,
      referencedWiDocs: wiContext.docs.slice(0, 12).map((doc) => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections,
      referencedSimilarStories,
      arPatternStoryKeys,
      ...(selectedWiDocIds.length ? { selectedWiDocIds } : {}),
    },
  };
}
