import type {
  GenerationModelOverrides,
  GenerationModelRoute,
  GenerationQualityMode,
  GeneratorBucketClasses,
  GeneratorConfig,
  LlmProvider,
  PipelineProfileConfig,
  PipelineProfile,
  StoryAssistantModelAssignment,
} from '../types';
import strategyCatalog from '../frontend/src/modelStrategyCatalog.json';

type StrategyCatalogProvider = keyof typeof strategyCatalog.providers;

export type GeneratorRoleModelField =
  | 'decompositionModel'
  | 'arModel'
  | 'clarifyModel'
  | 'refineModel'
  | 'evaluateModel'
  | 'triageModel'
  | 'themeModel';

export const MODEL_STRATEGY_VERSION = strategyCatalog.version;
export const DEFAULT_BUCKET_CLASSES: GeneratorBucketClasses = {
  discovery: 'flash',
  generation: 'pro',
  refinement: 'flash',
};

const STORY_ASSISTANT_PROFILE_CONFIGS: Record<PipelineProfile, PipelineProfileConfig> = {
  fast: {
    profile: 'fast',
    clarifyReasoning: 'low',
    decompositionReasoning: 'low',
    arReasoning: 'low',
    similarStoryMaxResults: 4,
    arPatternMaxStories: 2,
    wiDocSelectionCap: 2,
    generationOutputMaxTokens: 8192,
    enableCoverageProbe: false,
  },
  balanced: {
    profile: 'balanced',
    clarifyReasoning: 'medium',
    decompositionReasoning: 'low',
    arReasoning: 'medium',
    similarStoryMaxResults: 6,
    arPatternMaxStories: 4,
    wiDocSelectionCap: 3,
    generationOutputMaxTokens: 8192,
    enableCoverageProbe: false,
  },
  quality: {
    profile: 'quality',
    clarifyReasoning: 'high',
    decompositionReasoning: 'medium',
    arReasoning: 'high',
    similarStoryMaxResults: 12,
    arPatternMaxStories: 8,
    wiDocSelectionCap: 3,
    generationOutputMaxTokens: 16384,
    enableCoverageProbe: true,
  },
};

const DEFAULT_RESOLVED_MODELS: Pick<GeneratorConfig, GeneratorRoleModelField> = {
  // Pass 1 (decomposition) uses Flash: structurally simple outline task, ~3x faster than Pro.
  // Pass 2 (AR writing) keeps Pro: reasoning depth is where quality matters most.
  decompositionModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  arModel: strategyCatalog.providers.anthropic.presets.stable.pro[0],
  clarifyModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  refineModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  evaluateModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  triageModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  themeModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
};

function normalizePipelineProfile(value?: string): PipelineProfile {
  if (value === 'fast' || value === 'quality') return value;
  return 'balanced';
}

function inferPipelineProfileFromModels(
  models: Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'>,
): PipelineProfile {
  const families = [
    inferModelFamily(models.clarifyModel),
    inferModelFamily(models.decompositionModel),
    inferModelFamily(models.arModel),
  ];
  if (families.every((family) => family === 'pro')) return 'quality';
  if (families.every((family) => family === 'flash' || family === 'lite')) return 'fast';
  return 'balanced';
}

function pickPresetFamilyModel(
  provider: LlmProvider,
  family: 'pro' | 'flash' | 'lite',
  fallback?: string,
): string {
  const providerCatalog = strategyCatalog.providers[getPresetProvider(provider)];
  const preset = providerCatalog?.presets?.stable?.[family]?.[0];
  return preset || fallback || DEFAULT_RESOLVED_MODELS.decompositionModel;
}

function resolveStoryAssistantProfileModels(
  provider: LlmProvider,
  pipelineProfile: PipelineProfile,
  assignments: StoryAssistantModelAssignment,
  savedModels: Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'>,
): Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'> {
  const lightModel = assignments.lightModel || pickPresetFamilyModel(provider, 'flash', savedModels.clarifyModel);
  const heavyModel = assignments.heavyModel || pickPresetFamilyModel(provider, 'pro', savedModels.decompositionModel || savedModels.arModel);
  if (pipelineProfile === 'fast') {
    return {
      clarifyModel: lightModel,
      decompositionModel: lightModel,
      arModel: lightModel,
    };
  }
  if (pipelineProfile === 'quality') {
    return {
      clarifyModel: heavyModel,
      decompositionModel: heavyModel,
      arModel: heavyModel,
    };
  }
  return {
    clarifyModel: lightModel,
    decompositionModel: lightModel,
    arModel: lightModel,
  };
}

export interface ResolvedGeneratorStrategyState {
  provider: LlmProvider;
  modelStrategy: 'simple' | 'advanced';
  bucketClasses: GeneratorBucketClasses;
  resolvedModels: Pick<GeneratorConfig, GeneratorRoleModelField>;
  pipelineProfile: PipelineProfile;
  inferredFromLegacyModels: boolean;
  matchedPreset: boolean;
}

function normalizeProvider(provider?: LlmProvider): LlmProvider {
  if (!provider || provider === 'forge_llms') return 'anthropic';
  return provider;
}

function getPresetProvider(provider: LlmProvider) {
  return normalizeProvider(provider) as StrategyCatalogProvider;
}


function normalizeBucketClasses(value?: Partial<GeneratorBucketClasses>): GeneratorBucketClasses {
  return {
    discovery: value?.discovery ?? DEFAULT_BUCKET_CLASSES.discovery,
    generation: value?.generation ?? DEFAULT_BUCKET_CLASSES.generation,
    refinement: value?.refinement ?? DEFAULT_BUCKET_CLASSES.refinement,
  };
}

function normalizeModelStrategy(value?: string): 'simple' | 'advanced' {
  if (value === 'advanced' || value === 'custom') return 'advanced';
  return 'simple';
}

function getSavedResolvedModels(generatorConfig: Partial<GeneratorConfig>): Pick<GeneratorConfig, GeneratorRoleModelField> {
  return {
    decompositionModel: generatorConfig.decompositionModel || DEFAULT_RESOLVED_MODELS.decompositionModel,
    arModel: generatorConfig.arModel || DEFAULT_RESOLVED_MODELS.arModel,
    clarifyModel: generatorConfig.clarifyModel || DEFAULT_RESOLVED_MODELS.clarifyModel,
    refineModel: generatorConfig.refineModel || DEFAULT_RESOLVED_MODELS.refineModel,
    evaluateModel: generatorConfig.evaluateModel || DEFAULT_RESOLVED_MODELS.evaluateModel,
    triageModel: generatorConfig.triageModel || DEFAULT_RESOLVED_MODELS.triageModel,
    themeModel: generatorConfig.themeModel || DEFAULT_RESOLVED_MODELS.themeModel,
  };
}

function deriveStoryAssistantAssignments(
  provider: LlmProvider,
  savedModels: Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'>,
  existing?: StoryAssistantModelAssignment,
): StoryAssistantModelAssignment {
  const lightFallback = savedModels.clarifyModel || pickPresetFamilyModel(provider, 'flash');
  const heavyFallback = savedModels.decompositionModel || savedModels.arModel || pickPresetFamilyModel(provider, 'pro');
  return {
    lightModel: existing?.lightModel || lightFallback,
    heavyModel: existing?.heavyModel || heavyFallback,
  };
}

function normalizeStoryAssistantModelAssignments(
  generatorConfig: Partial<GeneratorConfig> | undefined,
  provider: LlmProvider,
  savedModels: Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'>,
): Partial<Record<LlmProvider, StoryAssistantModelAssignment>> {
  const rawAssignments = generatorConfig?.storyAssistantModelAssignments ?? {};
  const normalizedProvider = normalizeProvider(provider);
  const normalizedAssignments: Partial<Record<LlmProvider, StoryAssistantModelAssignment>> = { ...rawAssignments };
  const existing = normalizedAssignments[normalizedProvider];
  normalizedAssignments[normalizedProvider] = deriveStoryAssistantAssignments(normalizedProvider, savedModels, existing);
  return normalizedAssignments;
}

export function resolveGeneratorStrategyState(generatorConfig: Partial<GeneratorConfig> | undefined): ResolvedGeneratorStrategyState {
  const provider = normalizeProvider(generatorConfig?.provider);
  const bucketClasses = normalizeBucketClasses(generatorConfig?.bucketClasses);
  const resolvedModels = getSavedResolvedModels(generatorConfig ?? {});
  const incomingStrategy = generatorConfig?.modelStrategy;
  const pipelineProfile = normalizePipelineProfile(
    generatorConfig?.pipelineProfile
      ?? inferPipelineProfileFromModels({
        clarifyModel: resolvedModels.clarifyModel,
        decompositionModel: resolvedModels.decompositionModel,
        arModel: resolvedModels.arModel,
      }),
  );

  return {
    provider,
    modelStrategy: normalizeModelStrategy(incomingStrategy),
    bucketClasses,
    resolvedModels,
    pipelineProfile,
    inferredFromLegacyModels: Boolean(incomingStrategy && ['stable', 'latest', 'custom'].includes(String(incomingStrategy))),
    matchedPreset: false,
  };
}

export function resolveEffectiveGeneratorConfig(generatorConfig: Partial<GeneratorConfig> | undefined): GeneratorConfig {
  const state = resolveGeneratorStrategyState(generatorConfig);
  const savedModels = getSavedResolvedModels(generatorConfig ?? {});
  const storyAssistantModelAssignments = normalizeStoryAssistantModelAssignments(
    generatorConfig,
    state.provider,
    {
      clarifyModel: savedModels.clarifyModel,
      decompositionModel: savedModels.decompositionModel,
      arModel: savedModels.arModel,
    },
  );
  const activeStoryAssistantAssignments = storyAssistantModelAssignments[state.provider] ?? deriveStoryAssistantAssignments(
    state.provider,
    {
      clarifyModel: savedModels.clarifyModel,
      decompositionModel: savedModels.decompositionModel,
      arModel: savedModels.arModel,
    },
  );
  const storyAssistantModels = resolveStoryAssistantProfileModels(state.provider, state.pipelineProfile, {
    lightModel: activeStoryAssistantAssignments.lightModel,
    heavyModel: activeStoryAssistantAssignments.heavyModel,
  }, {
    clarifyModel: savedModels.clarifyModel,
    decompositionModel: savedModels.decompositionModel,
    arModel: savedModels.arModel,
  });

  return {
    provider: state.provider,
    modelStrategy: state.modelStrategy,
    bucketClasses: state.bucketClasses,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    pipelineProfile: state.pipelineProfile,
    maxTokens: generatorConfig?.maxTokens ?? 8192,
    anthropicApiKey: generatorConfig?.anthropicApiKey,
    anthropicBaseUrl: generatorConfig?.anthropicBaseUrl,
    geminiApiKey: generatorConfig?.geminiApiKey,
    geminiBaseUrl: generatorConfig?.geminiBaseUrl,
    openaiApiKey: generatorConfig?.openaiApiKey,
    openaiBaseUrl: generatorConfig?.openaiBaseUrl,
    azureOpenAIApiKey: generatorConfig?.azureOpenAIApiKey,
    azureOpenAIBaseUrl: generatorConfig?.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: generatorConfig?.azureOpenAIApiVersion,
    ollamaApiKey: generatorConfig?.ollamaApiKey,
    ollamaBaseUrl: generatorConfig?.ollamaBaseUrl,
    modelCatalogs: generatorConfig?.modelCatalogs,
    storyAssistantModelAssignments,
    decompositionModel: storyAssistantModels.decompositionModel,
    arModel: storyAssistantModels.arModel,
    clarifyModel: storyAssistantModels.clarifyModel,
    refineModel: state.resolvedModels.refineModel || savedModels.refineModel,
    evaluateModel: state.resolvedModels.evaluateModel || savedModels.evaluateModel,
    triageModel: state.resolvedModels.triageModel || savedModels.triageModel,
    themeModel: state.resolvedModels.themeModel || savedModels.themeModel,
  };
}

export function resolveStoryAssistantPipelineProfile(
  generatorConfig: Partial<GeneratorConfig> | undefined,
): PipelineProfile {
  return resolveEffectiveGeneratorConfig(generatorConfig).pipelineProfile;
}

export function getStoryAssistantPipelineProfileConfig(
  generatorConfig: Partial<GeneratorConfig> | undefined,
): PipelineProfileConfig {
  const profile = resolveStoryAssistantPipelineProfile(generatorConfig);
  return STORY_ASSISTANT_PROFILE_CONFIGS[profile];
}

export function buildStoryAssistantModelRoute(
  generatorConfig: Partial<GeneratorConfig> | undefined,
): GenerationModelRoute {
  const effective = resolveEffectiveGeneratorConfig(generatorConfig);
  return {
    clarify: effective.clarifyModel,
    decomposition: effective.decompositionModel,
    ar: effective.arModel,
  };
}

export function resolveGeneratorModelForRole(
  generatorConfig: Partial<GeneratorConfig> | undefined,
  role: GeneratorRoleModelField,
): string {
  return resolveEffectiveGeneratorConfig(generatorConfig)[role];
}

function inferModelFamily(modelId?: string): 'pro' | 'flash' | 'lite' | undefined {
  const normalized = String(modelId ?? '').trim().toLowerCase();
  const hasToken = (token: string) => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(normalized);
  if (!normalized) return undefined;
  if (normalized.includes('flash')) return 'flash';
  if (hasToken('lite') || hasToken('mini') || hasToken('nano') || normalized.includes('haiku')) return 'lite';
  if (hasToken('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.includes('sonnet')) return hasToken('mini') ? 'lite' : 'flash';
  return undefined;
}

export function resolveQualityGenerationOverrides(
  generatorConfig: Partial<GeneratorConfig> | undefined,
  qualityMode?: GenerationQualityMode,
): GenerationModelOverrides | undefined {
  if (qualityMode !== 'quality') return undefined;
  const effective = resolveEffectiveGeneratorConfig(generatorConfig);
  const providerCatalog = strategyCatalog.providers[getPresetProvider(effective.provider)];
  const proModel = providerCatalog?.presets?.stable?.pro?.[0];
  if (!proModel) return undefined;

  const overrides: GenerationModelOverrides = {};
  if (inferModelFamily(effective.decompositionModel) !== 'pro') {
    overrides.decompositionModel = proModel;
  }
  if (inferModelFamily(effective.arModel) !== 'pro') {
    overrides.arModel = proModel;
  }
  return Object.keys(overrides).length ? overrides : undefined;
}

export function buildGenerationModelRoute(
  generatorConfig: Partial<GeneratorConfig> | undefined,
  overrides?: GenerationModelOverrides,
): GenerationModelRoute {
  const effective = resolveEffectiveGeneratorConfig(generatorConfig);
  return {
    clarify: effective.clarifyModel,
    evaluate: effective.evaluateModel,
    decomposition: overrides?.decompositionModel ?? effective.decompositionModel,
    ar: overrides?.arModel ?? effective.arModel,
  };
}
