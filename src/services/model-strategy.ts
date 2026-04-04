import type {
  ConcreteModelFamily,
  GeneratorBucketClass,
  GeneratorBucketClasses,
  GeneratorConfig,
  GeneratorModelStrategy,
  LlmModelCatalogEntry,
  LlmProvider,
  LlmVendorModelCatalog,
} from '../types';

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
type StrategyPresetMap = Record<PresetProvider, Record<Exclude<GeneratorModelStrategy, 'custom'>, Record<GeneratorBucketClass, string[]>>>;

export const MODEL_STRATEGY_VERSION = '2026-04-04';
export const DEFAULT_BUCKET_CLASSES: GeneratorBucketClasses = {
  discovery: 'flash',
  generation: 'pro',
  refinement: 'flash',
};

export const GENERATOR_ROLE_FIELDS: GeneratorRoleModelField[] = [
  'decompositionModel',
  'arModel',
  'clarifyModel',
  'refineModel',
  'evaluateModel',
  'triageModel',
  'themeModel',
];

export const GENERATOR_ROLE_TO_BUCKET: Record<GeneratorRoleModelField, GeneratorBucketKey> = {
  clarifyModel: 'discovery',
  evaluateModel: 'discovery',
  triageModel: 'discovery',
  themeModel: 'discovery',
  decompositionModel: 'generation',
  arModel: 'generation',
  refineModel: 'refinement',
};

const PRESET_MODELS: StrategyPresetMap = {
  anthropic: {
    stable: {
      pro: ['claude-opus-4-1-20250805', 'claude-opus-4-20250514'],
      flash: ['claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219', 'claude-sonnet-4-20250514'],
      lite: ['claude-3-5-haiku-20241022', 'claude-3-haiku-20240307'],
    },
    latest: {
      pro: ['claude-opus-4-6', 'claude-opus-4-1-20250805'],
      flash: ['claude-sonnet-4-6', 'claude-sonnet-4-20250514'],
      lite: ['claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022'],
    },
  },
  gemini: {
    stable: {
      pro: ['gemini-2.5-pro'],
      flash: ['gemini-2.5-flash'],
      lite: ['gemini-2.5-flash-lite', 'gemini-2.0-flash-lite'],
    },
    latest: {
      pro: ['gemini-3.1-pro', 'gemini-3-pro'],
      flash: ['gemini-3-flash', 'gemini-3.0-flash'],
      lite: ['gemini-3.1-flash-lite', 'gemini-3-flash-lite'],
    },
  },
  openai: {
    stable: {
      pro: ['gpt-4o'],
      flash: ['gpt-4o', 'gpt-4.1'],
      lite: ['gpt-4o-mini', 'gpt-4.1-mini'],
    },
    latest: {
      pro: ['gpt-5.4', 'gpt-5'],
      flash: ['gpt-4o', 'gpt-4.1'],
      lite: ['gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4.1-mini'],
    },
  },
};

const DEFAULT_RESOLVED_MODELS: Pick<GeneratorConfig, GeneratorRoleModelField> = {
  decompositionModel: 'claude-opus-4-1-20250805',
  arModel: 'claude-opus-4-1-20250805',
  clarifyModel: 'claude-3-5-sonnet-20241022',
  refineModel: 'claude-3-5-sonnet-20241022',
  evaluateModel: 'claude-3-5-sonnet-20241022',
  triageModel: 'claude-3-5-sonnet-20241022',
  themeModel: 'claude-3-5-sonnet-20241022',
};

export interface ResolvedGeneratorStrategyState {
  provider: LlmProvider;
  modelStrategy: GeneratorModelStrategy;
  bucketClasses: GeneratorBucketClasses;
  resolvedModels: Pick<GeneratorConfig, GeneratorRoleModelField>;
  inferredFromLegacyModels: boolean;
  matchedPreset: boolean;
}

function normalizeCatalogEntries(catalog?: LlmVendorModelCatalog): LlmModelCatalogEntry[] {
  const models = catalog?.models;
  return Array.isArray(models) ? models : [];
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

function normalizeModelStrategy(provider: LlmProvider, value?: string): GeneratorModelStrategy {
  if (provider === 'azure_openai') return 'custom';
  if (value === 'stable' || value === 'latest' || value === 'custom') return value;
  return 'custom';
}

function getCatalogForProvider(generatorConfig: Partial<GeneratorConfig>, provider: LlmProvider): LlmVendorModelCatalog | undefined {
  if (provider === 'anthropic') {
    return generatorConfig.modelCatalogs?.anthropic ?? generatorConfig.modelCatalogs?.forge_llms;
  }
  return generatorConfig.modelCatalogs?.[provider];
}

function findCatalogModel(
  entries: LlmModelCatalogEntry[],
  candidates: string[],
): string | undefined {
  const normalizedCandidates = candidates.map((candidate) => candidate.trim().toLowerCase());
  const match = entries.find((entry) => {
    const values = [
      entry.id,
      entry.deploymentName,
      ...(entry.aliases ?? []),
    ]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return values.some((value) => normalizedCandidates.includes(value));
  });
  return match?.deploymentName ?? match?.id;
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

function resolvePresetFamilyModel(
  provider: PresetProvider,
  strategy: Exclude<GeneratorModelStrategy, 'custom'>,
  family: GeneratorBucketClass,
  catalog: LlmVendorModelCatalog | undefined,
  savedFallback?: string,
): string {
  const catalogEntries = normalizeCatalogEntries(catalog);
  const allowCatalogFallback = catalog?.source === 'discovered' || catalog?.source === 'manual';
  const strategyCandidates = PRESET_MODELS[provider][strategy][family];
  const primaryCandidate = strategyCandidates[0];
  const matchedCurrent = findCatalogModel(catalogEntries, strategyCandidates);
  if (matchedCurrent) return matchedCurrent;

  if (strategy === 'latest') {
    if (!allowCatalogFallback) {
      return primaryCandidate || savedFallback?.trim() || PRESET_MODELS[provider].stable[family][0];
    }
    const stableCandidates = PRESET_MODELS[provider].stable[family];
    const matchedStable = findCatalogModel(catalogEntries, stableCandidates);
    if (matchedStable) return matchedStable;
    return stableCandidates[0] || savedFallback?.trim() || primaryCandidate;
  }

  return primaryCandidate;
}

function resolvePresetModels(
  provider: PresetProvider,
  strategy: Exclude<GeneratorModelStrategy, 'custom'>,
  bucketClasses: GeneratorBucketClasses,
  catalog: LlmVendorModelCatalog | undefined,
  savedModels: Pick<GeneratorConfig, GeneratorRoleModelField>,
): Pick<GeneratorConfig, GeneratorRoleModelField> {
  const discoveryModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.discovery, catalog, savedModels.clarifyModel);
  const generationModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.generation, catalog, savedModels.decompositionModel);
  const refinementModel = resolvePresetFamilyModel(provider, strategy, bucketClasses.refinement, catalog, savedModels.refineModel);

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

function buildBucketClassCombos(): GeneratorBucketClasses[] {
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
  savedModels: Pick<GeneratorConfig, GeneratorRoleModelField>,
  catalog: LlmVendorModelCatalog | undefined,
): { modelStrategy: Exclude<GeneratorModelStrategy, 'custom'>; bucketClasses: GeneratorBucketClasses } | null {
  const savedEntries = GENERATOR_ROLE_FIELDS.map((field) => savedModels[field]);
  const combos = buildBucketClassCombos();
  for (const modelStrategy of ['stable', 'latest'] as const) {
    for (const bucketClasses of combos) {
      const resolved = resolvePresetModels(provider, modelStrategy, bucketClasses, catalog, DEFAULT_RESOLVED_MODELS);
      if (GENERATOR_ROLE_FIELDS.every((field, index) => resolved[field] === savedEntries[index])) {
        return { modelStrategy, bucketClasses };
      }
    }
  }
  return null;
}

export function resolveGeneratorStrategyState(generatorConfig: Partial<GeneratorConfig> | undefined): ResolvedGeneratorStrategyState {
  const provider = normalizeProvider(generatorConfig?.provider);
  const bucketClasses = normalizeBucketClasses(generatorConfig?.bucketClasses);
  const savedModels = getSavedResolvedModels(generatorConfig ?? {});
  const catalog = getCatalogForProvider(generatorConfig ?? {}, provider);

  if (provider === 'azure_openai') {
    return {
      provider,
      modelStrategy: 'custom',
      bucketClasses,
      resolvedModels: savedModels,
      inferredFromLegacyModels: false,
      matchedPreset: false,
    };
  }

  const normalizedStrategy = normalizeModelStrategy(provider, generatorConfig?.modelStrategy);
  const presetProvider = provider as PresetProvider;

  if (generatorConfig?.modelStrategy) {
    return {
      provider,
      modelStrategy: normalizedStrategy,
      bucketClasses,
      resolvedModels: normalizedStrategy === 'custom'
        ? savedModels
        : resolvePresetModels(presetProvider, normalizedStrategy, bucketClasses, catalog, savedModels),
      inferredFromLegacyModels: false,
      matchedPreset: normalizedStrategy !== 'custom',
    };
  }

  const inferred = inferLegacyPresetState(presetProvider, savedModels, catalog);
  if (inferred) {
    return {
      provider,
      modelStrategy: inferred.modelStrategy,
      bucketClasses: inferred.bucketClasses,
      resolvedModels: resolvePresetModels(presetProvider, inferred.modelStrategy, inferred.bucketClasses, catalog, savedModels),
      inferredFromLegacyModels: true,
      matchedPreset: true,
    };
  }

  return {
    provider,
    modelStrategy: 'custom',
    bucketClasses,
    resolvedModels: savedModels,
    inferredFromLegacyModels: true,
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
