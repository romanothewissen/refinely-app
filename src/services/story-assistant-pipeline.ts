import type {
  ClarifyAnswer,
  ClarifyQuestion,
  DiscoveryProfile,
  Feature,
  GenerationStageDurationsMs,
  TenantConfig,
} from '../types';
import {
  evaluateStoryAssistantDefaultSufficiency,
  generateStoryAssistantDefaultClarifyingQuestions,
  generateStoryAssistantDefaultFeatures,
} from '../core/story-assistant-default';
import { loadSharedPipelineContext, type SharedPipelineContext } from './shared-pipeline-context';

export async function runStoryAssistantClarifyStage(input: {
  requirement: string;
  attachmentText: string;
  priorAnswers?: ClarifyAnswer[];
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  selectedWiDocIds?: string[];
}) {
  const sharedContext = await loadSharedPipelineContext({
    requirement: input.requirement,
    attachmentText: input.attachmentText,
    clarifyAnswers: input.priorAnswers ?? [],
    config: input.config,
    projectKey: input.projectKey,
    projectKeys: input.projectKeys,
    selectedWiDocIds: input.selectedWiDocIds,
    pipelineMode: 'story_assistant_default',
    includeSimilarStories: true,
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

export async function runStoryAssistantSufficiencyStage(input: {
  requirement: string;
  attachmentText?: string;
  answers: ClarifyAnswer[];
  askedQuestions?: Array<string | { categoryKey?: string; intent?: string; question?: string }>;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  selectedWiDocIds?: string[];
  /**
   * When true, loads WI + similar stories before evaluation (slower, sharper sufficiency).
   * Default false: judges Q&A + requirement only; full evidence loads once at generation.
   */
  loadEvidence?: boolean;
}) {
  const askedQuestions = input.askedQuestions?.map((item) => {
    if (typeof item === 'string') return item;
    return {
      categoryKey: item.categoryKey as ClarifyQuestion['categoryKey'],
      intent: item.intent ?? '',
      question: item.question ?? '',
    };
  });

  const loadEvidence = input.loadEvidence === true;

  if (loadEvidence) {
    const sharedContext = await loadSharedPipelineContext({
      requirement: input.requirement,
      attachmentText: input.attachmentText,
      clarifyAnswers: input.answers,
      config: input.config,
      projectKey: input.projectKey,
      projectKeys: input.projectKeys,
      selectedWiDocIds: input.selectedWiDocIds,
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

  const result = await evaluateStoryAssistantDefaultSufficiency({
    requirement: input.requirement,
    answers: input.answers,
    askedQuestions,
    attachmentText: input.attachmentText,
    wiContextText: '',
    wiInsightsArtifact: null,
    similarStories: [],
    config: input.config,
  });

  return { sharedContext: undefined, result };
}

export async function runStoryAssistantGenerationStage(input: {
  requirement: string;
  attachmentText: string;
  clarifyAnswers: ClarifyAnswer[];
  clarifyDiscoveryProfile?: DiscoveryProfile;
  config: TenantConfig;
  projectKey?: string;
  projectKeys?: string[];
  selectedWiDocIds?: string[];
  precomputedDraftFeatures?: Feature[];
  priorStageDurationsMs?: GenerationStageDurationsMs;
  preloadedSharedContext?: SharedPipelineContext;
  onPass1DraftFeatures?: (draftFeatures: Feature[], evidence: SharedPipelineContext) => Promise<void>;
  shouldCancel?: () => Promise<boolean> | boolean;
}) {
  const sharedContext =
    input.preloadedSharedContext ??
    (await loadSharedPipelineContext({
      requirement: input.requirement,
      attachmentText: input.attachmentText,
      clarifyAnswers: input.clarifyAnswers,
      config: input.config,
      projectKey: input.projectKey,
      projectKeys: input.projectKeys,
      selectedWiDocIds: input.selectedWiDocIds,
      pipelineMode: 'story_assistant_default',
    }));

  const result = await generateStoryAssistantDefaultFeatures({
    requirement: input.requirement,
    clarifyAnswers: input.clarifyAnswers,
    attachmentText: input.attachmentText,
    wiContextText: sharedContext.wiContext.text,
    wiInsightsArtifact: sharedContext.wiInsights,
    similarStories: sharedContext.similarStories,
    arPatternLibraryText: sharedContext.arPatternLibraryText,
    discoveryProfile: input.clarifyDiscoveryProfile,
    projectKey: sharedContext.projectKey,
    projectKeys: sharedContext.projectKeys,
    config: {
        ...input.config,
        domainContext: sharedContext.domainContext,
        domainRoles: sharedContext.domainRoles,
      },
      arPatternStoryKeys: sharedContext.sources.arPatternStoryKeys,
      precomputedDraftFeatures: input.precomputedDraftFeatures,
      priorStageDurationsMs: input.priorStageDurationsMs,
      onPass1DraftFeatures: input.onPass1DraftFeatures
        ? async (draftFeatures) => input.onPass1DraftFeatures!(draftFeatures, sharedContext)
        : undefined,
    shouldCancel: input.shouldCancel,
  });

  return { sharedContext, result };
}
