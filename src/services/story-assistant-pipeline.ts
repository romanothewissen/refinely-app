import type {
  ClarifyAnswer,
  ClarifyContextMeta,
  ClarifyQuestion,
  DiscoverySessionState,
  DiscoveryProfile,
  Feature,
  GenerationStageDurationsMs,
  TenantConfig,
  TokenUsageSummary,
} from '../types';
import {
  continueAdaptiveDiscoverySession,
  initializeAdaptiveDiscoverySession,
} from '../core/adaptive-discovery';
import {
  evaluateStoryAssistantDefaultSufficiency,
  generateStoryAssistantDefaultClarifyingQuestions,
  generateStoryAssistantDefaultFeatures,
} from '../core/story-assistant-default';
import { formatSimilarStoriesText } from '../core/similar-stories';
import { loadSharedPipelineContext } from './shared-pipeline-context';

export async function runStoryAssistantClarifyStage(input: {
  requirement: string;
  attachmentText: string;
  priorAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
}) {
  const sharedContext = await loadSharedPipelineContext({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: input.priorAnswers ?? [],
    config: input.config,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    pipelineMode: 'story_assistant_default',
  });

  const result = await generateStoryAssistantDefaultClarifyingQuestions({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    wiContextText: sharedContext.wiContext.text,
    wiInsightsArtifact: sharedContext.wiInsights,
    similarStories: sharedContext.similarStories,
    config: {
      ...input.config,
      domainContext: sharedContext.domainContext,
      domainRoles: sharedContext.domainRoles,
    },
  });

  return { sharedContext, result };
}

export async function runAdaptiveDiscoveryInitializeStage(input: {
  sessionId: string;
  requirement: string;
  attachmentText: string;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
}) {
  const sharedContext = await loadSharedPipelineContext({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: [],
    config: input.config,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    pipelineMode: 'story_assistant_default',
  });

  const result = await initializeAdaptiveDiscoverySession({
    sessionId: input.sessionId,
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    wiEvidenceText: sharedContext.wiContext.text,
    similarStoriesText: sharedContext.similarStories.length ? formatSimilarStoriesText(sharedContext.similarStories, 3) : '',
    sourceMeta: {
      projectKey: sharedContext.projectKey,
      projectKeys: sharedContext.projectKeys,
      projectCount: sharedContext.projectCount,
      pipelineMode: 'story_assistant_default',
      domainRolesUsed: sharedContext.domainRoles,
      domainContextApplied: sharedContext.sources.domainContextApplied,
      attachmentIncluded: sharedContext.sources.attachmentIncluded,
      wiDocsCount: sharedContext.sources.wiDocsCount,
      linkedWiDocCount: sharedContext.sources.linkedWiDocCount,
      retrievedWiDocCount: sharedContext.sources.retrievedWiDocCount,
      retrievedWiChunkCount: sharedContext.sources.retrievedWiChunkCount,
      wiInsightCount: sharedContext.sources.wiInsightCount,
      referencedWiDocs: sharedContext.sources.referencedWiDocs,
      referencedWiSections: sharedContext.sources.referencedWiSections,
      wiInsights: sharedContext.wiInsights,
    },
    config: {
      ...input.config,
      domainContext: sharedContext.domainContext,
      domainRoles: sharedContext.domainRoles,
    },
  });

  return { sharedContext, result };
}

export async function runAdaptiveDiscoveryContinueStage(input: {
  requirement: string;
  attachmentText: string;
  state: DiscoverySessionState;
  latestAnswers: ClarifyAnswer[];
  config: TenantConfig;
}): Promise<{
  result: {
    state: DiscoverySessionState;
    nextQuestion: ClarifyQuestion | null;
    clarifyContext: ClarifyContextMeta;
    tokenUsage: TokenUsageSummary;
    decision: {
      isSufficient: boolean;
      shouldFallback?: boolean;
      fallbackReason?: string;
    };
  };
}> {
  const result = await continueAdaptiveDiscoverySession({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    state: input.state,
    latestAnswers: input.latestAnswers,
    config: input.config,
  });

  return { result };
}

export async function runStoryAssistantSufficiencyStage(input: {
  requirement: string;
  attachmentText?: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | { categoryKey?: string; intent?: string; question?: string }>;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
}) {
  const askedQuestions = input.askedQuestions?.map((item) => {
    if (typeof item === 'string') return item;
    return {
      categoryKey: item.categoryKey as ClarifyQuestion['categoryKey'],
      intent: item.intent ?? '',
      question: item.question ?? '',
    };
  });

  const sharedContext = await loadSharedPipelineContext({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: input.answers,
    config: input.config,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    pipelineMode: 'story_assistant_default',
  });

  const result = await evaluateStoryAssistantDefaultSufficiency({
    requirement: input.requirement,
    answers: input.answers,
    askedQuestions,
    attachmentText: input.attachmentText,
    wiContextText: sharedContext.wiContext.text,
    wiInsightsArtifact: sharedContext.wiInsights,
    similarStories: sharedContext.similarStories,
    config: {
      ...input.config,
      domainContext: sharedContext.domainContext,
      domainRoles: sharedContext.domainRoles,
    },
  });

  return { sharedContext, result };
}

export async function runStoryAssistantGenerationStage(input: {
  requirement: string;
  attachmentText: string;
  clarifyAnswers: ClarifyAnswer[];
  clarifyDiscoveryProfile?: DiscoveryProfile;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  precomputedDraftFeatures?: Feature[];
  priorStageDurationsMs?: GenerationStageDurationsMs;
  onPass1DraftFeatures?: (draftFeatures: Feature[]) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}) {
  const sharedContext = await loadSharedPipelineContext({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: input.clarifyAnswers,
    config: input.config,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    pipelineMode: 'story_assistant_default',
  });

  const result = await generateStoryAssistantDefaultFeatures({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    attachmentText: input.attachmentText,
    wiContextText: sharedContext.wiContext.text,
    wiInsightsArtifact: sharedContext.wiInsights,
    similarStories: sharedContext.similarStories,
    arPatternLibraryText: sharedContext.arPatternLibraryText,
    discoveryProfile: input.clarifyDiscoveryProfile,
    config: {
        ...input.config,
        domainContext: sharedContext.domainContext,
        domainRoles: sharedContext.domainRoles,
      },
      arPatternStoryKeys: sharedContext.sources.arPatternStoryKeys,
      precomputedDraftFeatures: input.precomputedDraftFeatures,
      priorStageDurationsMs: input.priorStageDurationsMs,
      onPass1DraftFeatures: input.onPass1DraftFeatures,
    shouldCancel: input.shouldCancel,
  });

  return { sharedContext, result };
}
