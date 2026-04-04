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

export const MODEL_STRATEGY_VERSION = '2026-04-04';
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

const CLAUDE_MODELS = [
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6 · Latest flagship' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · Latest balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 · Latest fast' },
  { id: 'claude-opus-4-1-20250805', label: 'Claude Opus 4.1 · Proven deep reasoning' },
  { id: 'claude-opus-4-20250514', label: 'Claude Opus 4 · Prior flagship' },
  { id: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4 · Balanced' },
  { id: 'claude-3-7-sonnet-20250219', label: 'Claude Sonnet 3.7 · Prior balanced' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude Sonnet 3.5 · Proven balanced' },
  { id: 'claude-3-5-haiku-20241022', label: 'Claude Haiku 3.5 · Proven fast' },
  { id: 'claude-3-haiku-20240307', label: 'Claude Haiku 3 · Legacy fast' },
];

const GEMINI_MODELS = [
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro · Latest deep reasoning' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash · Latest balanced' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite · Latest fast' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro · Proven deep reasoning' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash · Proven balanced' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite · Proven fast' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash · Prior balanced' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite · Prior fast' },
];

const OPENAI_MODELS = [
  { id: 'gpt-5.4', label: 'GPT-5.4 · Latest deep reasoning' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini · Latest fast' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano · Latest nano' },
  { id: 'gpt-5', label: 'GPT-5 · Prior deep reasoning' },
  { id: 'gpt-5-mini', label: 'GPT-5 Mini · Prior fast' },
  { id: 'gpt-5-nano', label: 'GPT-5 Nano · Prior nano' },
  { id: 'gpt-4.1', label: 'GPT-4.1 · Strong general model' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini · Lightweight' },
  { id: 'gpt-4.1-nano', label: 'GPT-4.1 Nano · Smallest 4.1 model' },
  { id: 'gpt-4o', label: 'GPT-4o · Proven balanced' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini · Proven fast' },
  { id: 'o3', label: 'o3 · Heavy reasoning' },
  { id: 'o4-mini', label: 'o4-mini · Efficient reasoning' },
];

const PRESET_MODELS: Record<PresetProvider, Record<Exclude<GeneratorModelStrategy, 'custom'>, Record<GeneratorBucketClass, string[]>>> = {
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

const DEFAULT_MODELS: Record<GeneratorRoleModelField, string> = {
  decompositionModel: 'claude-opus-4-1-20250805',
  arModel: 'claude-opus-4-1-20250805',
  clarifyModel: 'claude-3-5-sonnet-20241022',
  refineModel: 'claude-3-5-sonnet-20241022',
  evaluateModel: 'claude-3-5-sonnet-20241022',
  triageModel: 'claude-3-5-sonnet-20241022',
  themeModel: 'claude-3-5-sonnet-20241022',
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
  const candidates = PRESET_MODELS[provider][strategy][family];
  const matched = findCatalogModel(entries, candidates, allowCatalogResolution);
  if (matched) return matched;

  if (strategy === 'latest') {
    const stableCandidates = PRESET_MODELS[provider].stable[family];
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
  if (provider === 'anthropic' || provider === 'forge_llms') {
    return CLAUDE_MODELS.map((model) => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  }
  if (provider === 'gemini') {
    return GEMINI_MODELS.map((model) => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  }
  if (provider === 'openai') {
    return OPENAI_MODELS.map((model) => ({ id: model.id, displayName: model.label, family: inferModelFamily(model.id), source: 'fallback' as const }));
  }
  return [];
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
