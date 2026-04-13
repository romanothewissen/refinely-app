import type { ClarifyAnswer, TenantConfig, WorkInstructionInsightArtifact } from '../types';
import { buildWorkInstructionInsightArtifact, getWorkInstructionInsightCount } from '../core/wi-insights';
import {
  buildCombinedDomainContext,
  getCombinedPersonaRoles,
  normalizeProjectKeys,
  resolvePrimaryProjectKey,
  retrieveScopedWiContext,
  summarizeReferencedWiSections,
  type RetrievedWiContext,
} from './project-selection';
import { deriveRetrievalQuery } from './retrieval-query';

export interface SharedPipelineContextSources {
  projectKey: string;
  projectKeys: string[];
  projectCount: number;
  pipelineMode: 'story_assistant_default' | 'legacy_llm_led';
  domainContextApplied: boolean;
  attachmentIncluded: boolean;
  wiDocsCount: number;
  linkedWiDocCount: number;
  retrievedWiDocCount: number;
  retrievedWiChunkCount: number;
  wiInsightCount: number;
  referencedWiDocs: Array<{ docId: string; filename: string; chunkCount: number }>;
  referencedWiSections: ReturnType<typeof summarizeReferencedWiSections>;
}

export interface SharedPipelineContext {
  projectKey: string;
  projectKeys: string[];
  projectCount: number;
  domainContext: string;
  domainRoles: string[];
  wiContext: RetrievedWiContext;
  wiInsights: WorkInstructionInsightArtifact;
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
  pipelineMode?: 'story_assistant_default' | 'legacy_llm_led';
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
  const wiContext = input.config.wiConfig.enabled
    ? await retrieveScopedWiContext(
        retrievalQuery,
        input.config.wiConfig.topKChunks,
        input.config.wiConfig.maxChars,
        selectedProjectKeys,
      )
    : { text: '', docs: [], chunks: [], linkedDocs: [] };
  const retrievalMs = Date.now() - retrievalStartedAt;
  const wiInsightStartedAt = Date.now();
  const wiInsights = buildWorkInstructionInsightArtifact(wiContext.chunks);
  const wiInsightExtractionMs = Date.now() - wiInsightStartedAt;
  const referencedWiSections = summarizeReferencedWiSections(wiContext.chunks.slice(0, 8));

  return {
    projectKey: primaryProjectKey,
    projectKeys: selectedProjectKeys,
    projectCount: selectedProjectKeys.length,
    domainContext,
    domainRoles,
    wiContext,
    wiInsights,
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
      referencedWiDocs: wiContext.docs.slice(0, 12).map((doc) => ({
        docId: doc.docId,
        filename: doc.filename,
        chunkCount: doc.chunkCount,
      })),
      referencedWiSections,
    },
  };
}
