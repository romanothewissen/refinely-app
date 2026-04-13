import type {
  ClarifyAnswer,
  ReferencedSimilarStory,
  SimilarStory,
  TenantConfig,
  WorkInstructionInsightArtifact,
} from '../types';
import { formatArPatternLibraryFromSimilarStories } from '../core/similar-stories';
import { buildWorkInstructionInsightArtifact, getWorkInstructionInsightCount } from '../core/wi-insights';
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

export async function loadSharedPipelineContext(input: {
  requirement: string;
  attachmentText?: string;
  clarifyAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  pipelineMode?: 'story_assistant_default';
}): Promise<SharedPipelineContext> {
  const retrievalStartedAt = Date.now();
  const selectedProjectKeys = normalizeProjectKeys(input.projectKey, input.projectKeys);
  const primaryProjectKey = resolvePrimaryProjectKey(input.projectKey, input.projectKeys);
  const domainContext = buildCombinedDomainContext(input.config, selectedProjectKeys);
  const domainRoles = getCombinedPersonaRoles(input.config, selectedProjectKeys)
    .map((row) => row.role)
    .filter(Boolean);
  const retrievalQuery = deriveRetrievalQuery(
    input.requirement,
    input.attachmentText ?? '',
    input.clarifyAnswers ?? [],
  );
  const [wiContext, similarStories] = await Promise.all([
    input.config.wiConfig.enabled
      ? retrieveScopedWiContext(
          retrievalQuery,
          input.config.wiConfig.topKChunks,
          input.config.wiConfig.maxChars,
          selectedProjectKeys,
        )
      : Promise.resolve({ text: '', docs: [], chunks: [], linkedDocs: [] }),
    retrieveScopedSimilarStories({
      requirement: retrievalQuery,
      attachmentText: input.attachmentText,
      clarifyAnswers: input.clarifyAnswers,
      config: input.config,
      projectKeys: selectedProjectKeys,
      maxResults: 5,
    }),
  ]);
  const retrievalMs = Date.now() - retrievalStartedAt;
  const wiInsightStartedAt = Date.now();
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  const wiInsightExtractionMs = Date.now() - wiInsightStartedAt;
  const referencedWiSections = summarizeReferencedWiSections(wiContext.chunks.slice(0, 8));
  const referencedSimilarStories = summarizeReferencedSimilarStories(similarStories.slice(0, 5));
  const arPatternLibrary = formatArPatternLibraryFromSimilarStories(similarStories, input.requirement, 3);

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
      arPatternStoryKeys: arPatternLibrary.storyKeys,
    },
  };
}
