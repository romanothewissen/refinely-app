import type {
  ConcreteModelFamily,
  GeneratorBucketClass,
  GeneratorBucketClasses,
  GeneratorConfig,
  GeneratorModelStrategy,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmProvider,
} from './types';
import strategyCatalog from './modelStrategyCatalog.json';

export type GeneratorBucketKey = keyof GeneratorBucketClasses;
export type GeneratorRoleModelField =
  | 'decompositionModel'
  | 'arModel'
  | 'clarifyModel'
  | 'refineModel'
  | 'evaluateModel'
  | 'triageModel'
  | 'themeModel';

type PresetProvider = 'anthropic' | 'gemini' | 'openai';

export const MODEL_STRATEGY_VERSION = strategyCatalog.version;
export const DEFAULT_BUCKET_CLASSES: GeneratorBucketClasses = {
  discovery: 'flash',
  generation: 'pro',
  refinement: 'flash',
};

export const BUCKET_CLASS_LABELS: Record<GeneratorBucketClass, string> = {
  pro: 'Deep reasoning',
  flash: 'Balanced',
  lite: 'Fast',
};

export const ROLE_TO_BUCKET: Record<GeneratorRoleModelField, GeneratorBucketKey> = {
  clarifyModel: 'discovery',
  evaluateModel: 'discovery',
  triageModel: 'discovery',
  themeModel: 'discovery',
  decompositionModel: 'generation',
  arModel: 'generation',
  refineModel: 'refinement',
};

type StrategyCatalogData = typeof strategyCatalog;
type StrategyCatalogProvider = keyof StrategyCatalogData['providers'];

function getPresetProvider(provider: LlmProvider): StrategyCatalogProvider {
  if (provider === 'forge_llms') return 'anthropic';
  return provider;
}

function getProviderCatalogData(provider: LlmProvider) {
  return strategyCatalog.providers[getPresetProvider(provider)];
}

const DEFAULT_MODELS: Record<GeneratorRoleModelField, string> = {
  decompositionModel: getProviderCatalogData('anthropic').presets.stable.pro[0],
  arModel: getProviderCatalogData('anthropic').presets.stable.pro[0],
  clarifyModel: getProviderCatalogData('anthropic').presets.stable.flash[0],
  refineModel: getProviderCatalogData('anthropic').presets.stable.flash[0],
  evaluateModel: getProviderCatalogData('anthropic').presets.stable.flash[0],
  triageModel: getProviderCatalogData('anthropic').presets.stable.flash[0],
  themeModel: getProviderCatalogData('anthropic').presets.stable.flash[0],
};

export interface UiGeneratorStrategyState {
  provider: LlmProvider;
  modelStrategy: GeneratorModelStrategy;
  bucketClasses: GeneratorBucketClasses;
  resolvedModels: Record<GeneratorRoleModelField, string>;
  resolvedBucketModels: Record<GeneratorBucketKey, string>;
  inferredFromLegacyModels: boolean;
  matchedPreset: boolean;
}

function normalizeProvider(provider?: LlmProvider): LlmProvider {
  if (!provider || provider === 'forge_llms') return 'anthropic';
  return provider;
}

function normalizeBucketClasses(value?: Partial<GeneratorBucketClasses>): GeneratorBucketClasses {
  return {
    discovery: value?.discovery ?? DEFAULT_BUCKET_CLASSES.discovery,
    generation: value?.generation ?? DEFAULT_BUCKET_CLASSES.generation,
    refinement: value?.refinement ?? DEFAULT_BUCKET_CLASSES.refinement,
  };
}

function normalizeStrategy(provider: LlmProvider, value?: string): GeneratorModelStrategy {
  if (provider === 'azure_openai') return 'custom';
  if (value === 'stable' || value === 'latest' || value === 'custom') return value;
  return 'custom';
}

function getSavedModels(config?: Partial<GeneratorConfig>): Record<GeneratorRoleModelField, string> {
  return {
    decompositionModel: config?.decompositionModel || DEFAULT_MODELS.decompositionModel,
    arModel: config?.arModel || DEFAULT_MODELS.arModel,
    clarifyModel: config?.clarifyModel || DEFAULT_MODELS.clarifyModel,
    refineModel: config?.refineModel || DEFAULT_MODELS.refineModel,
    evaluateModel: config?.evaluateModel || DEFAULT_MODELS.evaluateModel,
    triageModel: config?.triageModel || DEFAULT_MODELS.triageModel,
    themeModel: config?.themeModel || DEFAULT_MODELS.themeModel,
  };
}

function findCatalogModel(entries: LlmModelCatalogEntry[], candidates: string[], allowCatalogResolution: boolean): string | undefined {
  if (!allowCatalogResolution) return undefined;
  const normalizedCandidates = candidates.map((candidate) => candidate.trim().toLowerCase());
  const match = entries.find((entry) => {
    const values = [entry.id, entry.deploymentName, ...(entry.aliases ?? [])]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return values.some((value) => normalizedCandidates.includes(value));
  });
  return match?.deploymentName || match?.id;
}

function resolvePresetFamilyModel(
  provider: PresetProvider,
  strategy: Exclude<GeneratorModelStrategy, 'custom'>,
  family: GeneratorBucketClass,
  entries: LlmModelCatalogEntry[],
  allowCatalogResolution: boolean,
  savedFallback?: string,
): string {
  const candidates = getProviderCatalogData(provider).presets[strategy][family];
  const matched = findCatalogModel(entries, candidates, allowCatalogResolution);
  if (matched) return matched;

  if (strategy === 'latest') {
    if (!allowCatalogResolution) {
      return candidates[0] || savedFallback?.trim() || getProviderCatalogData(provider).presets.stable[family][0];
    }
    const stableCandidates = getProviderCatalogData(provider).presets.stable[family];
    const matchedStable = findCatalogModel(entries, stableCandidates, allowCatalogResolution);
    if (matchedStable) return matchedStable;
    return stableCandidates[0] || savedFallback?.trim() || candidates[0];
  }

  return candidates[0];
}

function resolvePresetModels(
  provider: PresetProvider,
  strategy: Exclude<GeneratorModelStrategy, 'custom'>,
  bucketClasses: GeneratorBucketClasses,
  entries: LlmModelCatalogEntry[],
  allowCatalogResolution: boolean,
  savedModels: Record<GeneratorRoleModelField, string>,
): Record<GeneratorRoleModelField, string> {
  const discoveryModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.discovery, entries, allowCatalogResolution, savedModels.clarifyModel);
  const generationModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.generation, entries, allowCatalogResolution, savedModels.decompositionModel);
  const refinementModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.refinement, entries, allowCatalogResolution, savedModels.refineModel);

  return {
    clarifyModel: discoveryModel,
    evaluateModel: discoveryModel,
    triageModel: discoveryModel,
    themeModel: discoveryModel,
    decompositionModel: generationModel,
    arModel: generationModel,
    refineModel: refinementModel,
  };
}

function buildBucketCombos(): GeneratorBucketClasses[] {
  const families: GeneratorBucketClass[] = ['pro', 'flash', 'lite'];
  const combos: GeneratorBucketClasses[] = [];
  for (const discovery of families) {
    for (const generation of families) {
      for (const refinement of families) {
        combos.push({ discovery, generation, refinement });
      }
    }
  }
  const defaultKey = JSON.stringify(DEFAULT_BUCKET_CLASSES);
  combos.sort((a, b) => {
    if (JSON.stringify(a) === defaultKey) return -1;
    if (JSON.stringify(b) === defaultKey) return 1;
    return 0;
  });
  return combos;
}

function inferLegacyPresetState(
  provider: PresetProvider,
  entries: LlmModelCatalogEntry[],
  allowCatalogResolution: boolean,
  savedModels: Record<GeneratorRoleModelField, string>,
): { modelStrategy: Exclude<GeneratorModelStrategy, 'custom'>; bucketClasses: GeneratorBucketClasses } | null {
  const combos = buildBucketCombos();
  for (const modelStrategy of ['stable', 'latest'] as const) {
    for (const bucketClasses of combos) {
      const resolved = resolvePresetModels(provider, modelStrategy, bucketClasses, entries, allowCatalogResolution, DEFAULT_MODELS);
      if ((Object.keys(savedModels) as GeneratorRoleModelField[]).every((field) => savedModels[field] === resolved[field])) {
        return { modelStrategy, bucketClasses };
      }
    }
  }
  return null;
}

export function inferModelFamily(modelId: string): ConcreteModelFamily | undefined {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.includes('flash')) return 'flash';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.startsWith('o4') || normalized.includes('sonnet')) return normalized.includes('mini') ? 'lite' : 'flash';
  if (normalized.includes('lite') || normalized.includes('mini') || normalized.includes('nano') || normalized.includes('haiku')) return 'lite';
  if (normalized.includes('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  return undefined;
}

export function buildStaticCatalog(provider: LlmProvider): LlmModelCatalogEntry[] {
  return getProviderCatalogData(provider).catalog.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    family: model.family as GeneratorBucketClass | undefined,
    source: 'fallback' as const,
  }));
}

export function getCatalogEntriesForProvider(
  provider: LlmProvider,
  modelCatalogs: LlmModelCatalogByVendor,
): { entries: LlmModelCatalogEntry[]; allowCatalogResolution: boolean } {
  const normalizedProvider = normalizeProvider(provider);
  const catalog = normalizedProvider === 'anthropic'
    ? modelCatalogs.anthropic ?? modelCatalogs.forge_llms
    : modelCatalogs[normalizedProvider];
  if (catalog?.models?.length) {
    return {
      entries: catalog.models,
      allowCatalogResolution: catalog.source === 'discovered' || catalog.source === 'manual',
    };
  }
  return { entries: buildStaticCatalog(normalizedProvider), allowCatalogResolution: false };
}

export function resolveUiGeneratorStrategyState(opts: {
  config?: Partial<GeneratorConfig>;
  provider?: LlmProvider;
  modelStrategy?: GeneratorModelStrategy;
  bucketClasses?: Partial<GeneratorBucketClasses>;
  catalogEntries?: LlmModelCatalogEntry[];
  allowCatalogResolution?: boolean;
  hasStoredStrategy?: boolean;
}): UiGeneratorStrategyState {
  const provider = normalizeProvider(opts.provider ?? opts.config?.provider);
  const savedModels = getSavedModels(opts.config);
  const bucketClasses = normalizeBucketClasses(opts.bucketClasses ?? opts.config?.bucketClasses);
  const entries = opts.catalogEntries ?? buildStaticCatalog(provider);
  const allowCatalogResolution = Boolean(opts.allowCatalogResolution);

  if (provider === 'azure_openai') {
    return {
      provider,
      modelStrategy: 'custom',
      bucketClasses,
      resolvedModels: savedModels,
      resolvedBucketModels: {
        discovery: savedModels.clarifyModel,
        generation: savedModels.decompositionModel,
        refinement: savedModels.refineModel,
      },
      inferredFromLegacyModels: false,
      matchedPreset: false,
    };
  }

  const storedStrategy = normalizeStrategy(provider, opts.modelStrategy ?? opts.config?.modelStrategy);
  const hasStoredStrategy = opts.hasStoredStrategy ?? Boolean(opts.config?.modelStrategy);
  const presetProvider = provider as PresetProvider;

  if (hasStoredStrategy) {
    const resolvedModels = storedStrategy === 'custom'
      ? savedModels
      : resolvePresetModels(presetProvider, storedStrategy, bucketClasses, entries, allowCatalogResolution, savedModels);

    return {
      provider,
      modelStrategy: storedStrategy,
      bucketClasses,
      resolvedModels,
      resolvedBucketModels: {
        discovery: resolvedModels.clarifyModel,
        generation: resolvedModels.decompositionModel,
        refinement: resolvedModels.refineModel,
      },
      inferredFromLegacyModels: false,
      matchedPreset: storedStrategy !== 'custom',
    };
  }

  const inferred = inferLegacyPresetState(presetProvider, entries, allowCatalogResolution, savedModels);
  if (inferred) {
    const resolvedModels = resolvePresetModels(presetProvider, inferred.modelStrategy, inferred.bucketClasses, entries, allowCatalogResolution, savedModels);
    return {
      provider,
      modelStrategy: inferred.modelStrategy,
      bucketClasses: inferred.bucketClasses,
      resolvedModels,
      resolvedBucketModels: {
        discovery: resolvedModels.clarifyModel,
        generation: resolvedModels.decompositionModel,
        refinement: resolvedModels.refineModel,
      },
      inferredFromLegacyModels: true,
      matchedPreset: true,
    };
  }

  return {
    provider,
    modelStrategy: 'custom',
    bucketClasses,
    resolvedModels: savedModels,
    resolvedBucketModels: {
      discovery: savedModels.clarifyModel,
      generation: savedModels.decompositionModel,
      refinement: savedModels.refineModel,
    },
    inferredFromLegacyModels: true,
    matchedPreset: false,
  };
}
