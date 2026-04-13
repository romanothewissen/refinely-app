import type {
  GenerationModelOverrides,
  GenerationModelRoute,
  GenerationQualityMode,
  GeneratorBucketClasses,
  GeneratorConfig,
  LlmProvider,
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

const DEFAULT_RESOLVED_MODELS: Pick<GeneratorConfig, GeneratorRoleModelField> = {
  decompositionModel: strategyCatalog.providers.anthropic.presets.stable.pro[0],
  arModel: strategyCatalog.providers.anthropic.presets.stable.pro[0],
  clarifyModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  refineModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  evaluateModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  triageModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
  themeModel: strategyCatalog.providers.anthropic.presets.stable.flash[0],
};

export interface ResolvedGeneratorStrategyState {
  provider: LlmProvider;
  modelStrategy: 'simple' | 'advanced';
  bucketClasses: GeneratorBucketClasses;
  resolvedModels: Pick<GeneratorConfig, GeneratorRoleModelField>;
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

export function resolveGeneratorStrategyState(generatorConfig: Partial<GeneratorConfig> | undefined): ResolvedGeneratorStrategyState {
  const provider = normalizeProvider(generatorConfig?.provider);
  const bucketClasses = normalizeBucketClasses(generatorConfig?.bucketClasses);
  const resolvedModels = getSavedResolvedModels(generatorConfig ?? {});
  const incomingStrategy = generatorConfig?.modelStrategy;

  return {
    provider,
    modelStrategy: normalizeModelStrategy(incomingStrategy),
    bucketClasses,
    resolvedModels,
    inferredFromLegacyModels: Boolean(incomingStrategy && ['stable', 'latest', 'custom'].includes(String(incomingStrategy))),
    matchedPreset: false,
  };
}

export function resolveEffectiveGeneratorConfig(generatorConfig: Partial<GeneratorConfig> | undefined): GeneratorConfig {
  const state = resolveGeneratorStrategyState(generatorConfig);
  const savedModels = getSavedResolvedModels(generatorConfig ?? {});

  return {
    provider: state.provider,
    modelStrategy: state.modelStrategy,
    bucketClasses: state.bucketClasses,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
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
    modelCatalogs: generatorConfig?.modelCatalogs,
    decompositionModel: state.resolvedModels.decompositionModel || savedModels.decompositionModel,
    arModel: state.resolvedModels.arModel || savedModels.arModel,
    clarifyModel: state.resolvedModels.clarifyModel || savedModels.clarifyModel,
    refineModel: state.resolvedModels.refineModel || savedModels.refineModel,
    evaluateModel: state.resolvedModels.evaluateModel || savedModels.evaluateModel,
    triageModel: state.resolvedModels.triageModel || savedModels.triageModel,
    themeModel: state.resolvedModels.themeModel || savedModels.themeModel,
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
  if (!normalized) return undefined;
  if (normalized.includes('flash')) return 'flash';
  if (normalized.includes('lite') || normalized.includes('mini') || normalized.includes('nano') || normalized.includes('haiku')) return 'lite';
  if (normalized.includes('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.includes('sonnet')) return normalized.includes('mini') ? 'lite' : 'flash';
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
