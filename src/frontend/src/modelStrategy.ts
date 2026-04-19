import type {
  ConcreteModelFamily,
  GeneratorBucketClasses,
  GeneratorConfig,
  GeneratorModelStrategy,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmProvider,
  PipelineProfile,
  StoryAssistantModelAssignment,
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

export interface GeneratorRoleDescriptor {
  field: GeneratorRoleModelField;
  label: string;
  description: string;
  recommendationClass: string;
  rationale: string;
}

type StrategyCatalogData = typeof strategyCatalog;
type StrategyCatalogProvider = keyof StrategyCatalogData['providers'];

export type SimpleBucketModels = Record<GeneratorBucketKey, string>;

export const MODEL_STRATEGY_VERSION = strategyCatalog.version;
export const DEFAULT_BUCKET_CLASSES: GeneratorBucketClasses = {
  discovery: 'flash',
  generation: 'pro',
  refinement: 'flash',
};

export const SIMPLE_BUCKET_LABELS: Record<GeneratorBucketKey, string> = {
  discovery: 'Discovery',
  generation: 'Generation',
  refinement: 'Refinement',
};

export const SIMPLE_BUCKET_DESCRIPTIONS: Record<GeneratorBucketKey, string> = {
  discovery: 'Clarifying questions, sufficiency checks, triage, and themes',
  generation: 'Feature breakdown and acceptance requirements',
  refinement: 'Interactive edits on existing features',
};

export const GENERATOR_ROLE_ORDER: GeneratorRoleDescriptor[] = [
  {
    field: 'triageModel',
    label: 'Triage',
    description: 'Scope, complexity, and routing',
    recommendationClass: 'Fast classifier',
    rationale: 'Prefer the quickest reliable model for routing and ambiguity estimation.',
  },
  {
    field: 'clarifyModel',
    label: 'Clarifying Questions',
    description: 'Round 1 discovery and follow-ups',
    recommendationClass: 'Fast conversational reasoning',
    rationale: 'Optimise for quick, focused question generation rather than deep long-form output.',
  },
  {
    field: 'evaluateModel',
    label: 'Sufficiency Check',
    description: 'Gate before generation continues',
    recommendationClass: 'Fast classifier',
    rationale: 'This step should cheaply decide whether coverage is complete or follow-up is still needed.',
  },
  {
    field: 'decompositionModel',
    label: 'Feature Breakdown',
    description: 'Draft feature structure',
    recommendationClass: 'Deep structured reasoning',
    rationale: 'This model should be strong at preserving scope and separating materially different workflows.',
  },
  {
    field: 'arModel',
    label: 'Acceptance Requirements',
    description: 'Write Given / When / Then',
    recommendationClass: 'Strongest long-form generator',
    rationale: 'This is the most quality-sensitive generation step and benefits most from higher-capability models.',
  },
  {
    field: 'themeModel',
    label: 'Theme Analysis & Titles',
    description: 'Cluster themes and title features',
    recommendationClass: 'Fast classifier',
    rationale: 'Use a fast model for tagging, clustering, and title support work.',
  },
  {
    field: 'refineModel',
    label: 'Refinement',
    description: 'Interactive edits on a single feature',
    recommendationClass: 'Balanced editor',
    rationale: 'This model should stay responsive while still making precise local edits.',
  },
];

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
  modelStrategy: 'simple' | 'advanced';
  bucketClasses: GeneratorBucketClasses;
  pipelineProfile: PipelineProfile;
  resolvedModels: Record<GeneratorRoleModelField, string>;
  resolvedBucketModels: SimpleBucketModels;
  inferredFromLegacyModels: boolean;
  matchedPreset: boolean;
}

export interface ResolvedStoryAssistantAssignments {
  lightModel: string;
  heavyModel: string;
}

export function normalizePipelineProfile(value?: string): PipelineProfile {
  if (value === 'fast' || value === 'quality') return value;
  return 'balanced';
}

export function inferPipelineProfileFromModels(config?: Partial<GeneratorConfig>): PipelineProfile {
  const savedModels = getSavedModels(config);
  const families = [
    inferModelFamily(savedModels.clarifyModel),
    inferModelFamily(savedModels.decompositionModel),
    inferModelFamily(savedModels.arModel),
  ];
  if (families.every((family) => family === 'pro')) return 'quality';
  if (families.every((family) => family === 'flash' || family === 'lite')) return 'fast';
  return 'balanced';
}

export function resolveProfileModelAssignments(
  provider: LlmProvider,
  pipelineProfile: PipelineProfile,
  storyAssistantAssignments?: StoryAssistantModelAssignment,
  fallback?: Partial<Record<GeneratorRoleModelField, string>>,
): Pick<GeneratorConfig, 'clarifyModel' | 'decompositionModel' | 'arModel'> {
  const providerCatalog = getProviderCatalogData(provider);
  const pick = (family: 'pro' | 'flash', legacy?: string) =>
    providerCatalog?.presets?.stable?.[family]?.[0] || legacy || '';
  const lightModel = storyAssistantAssignments?.lightModel || pick('flash', fallback?.clarifyModel);
  const heavyModel = storyAssistantAssignments?.heavyModel || pick('pro', fallback?.decompositionModel || fallback?.arModel);

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
    arModel: heavyModel,
  };
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

function normalizeStrategy(value?: string): 'simple' | 'advanced' {
  if (value === 'advanced' || value === 'custom') return 'advanced';
  return 'simple';
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

export function resolveStoryAssistantAssignments(
  provider: LlmProvider,
  config?: Partial<GeneratorConfig>,
  fallback?: StoryAssistantModelAssignment,
): ResolvedStoryAssistantAssignments {
  const normalizedProvider = normalizeProvider(provider);
  const savedModels = getSavedModels(config);
  const providerCatalog = getProviderCatalogData(normalizedProvider);
  const pick = (family: 'pro' | 'flash', legacy?: string) =>
    providerCatalog?.presets?.stable?.[family]?.[0] || legacy || '';
  const stored = config?.storyAssistantModelAssignments?.[normalizedProvider];
  return {
    lightModel: fallback?.lightModel || stored?.lightModel || savedModels.clarifyModel || pick('flash'),
    heavyModel: fallback?.heavyModel || stored?.heavyModel || savedModels.arModel || savedModels.decompositionModel || pick('pro'),
  };
}

function buildResolvedModelsFromBuckets(bucketModels: SimpleBucketModels): Record<GeneratorRoleModelField, string> {
  return {
    clarifyModel: bucketModels.discovery,
    evaluateModel: bucketModels.discovery,
    triageModel: bucketModels.discovery,
    themeModel: bucketModels.discovery,
    decompositionModel: bucketModels.generation,
    arModel: bucketModels.generation,
    refineModel: bucketModels.refinement,
  };
}

function getBucketModelsFromSavedModels(savedModels: Record<GeneratorRoleModelField, string>): SimpleBucketModels {
  return {
    discovery: savedModels.clarifyModel,
    generation: savedModels.decompositionModel,
    refinement: savedModels.refineModel,
  };
}

export function inferModelFamily(modelId: string): ConcreteModelFamily | undefined {
  const normalized = modelId.trim().toLowerCase();
  const hasToken = (token: string) => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`).test(normalized);
  if (normalized.includes('flash')) return 'flash';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.startsWith('o4') || normalized.includes('sonnet')) return hasToken('mini') ? 'lite' : 'flash';
  if (hasToken('lite') || hasToken('mini') || hasToken('nano') || normalized.includes('haiku')) return 'lite';
  if (hasToken('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  // Size-based inference for open-weight models (Llama, Mixtral, DeepSeek, Qwen, Gemma, etc.)
  if (/\b(70b|72b|65b|180b|405b|671b)\b/.test(normalized) || normalized.includes('large') || normalized.includes('versatile') || normalized.includes('ultra')) return 'pro';
  if (/\b(13b|14b|27b|30b|32b|34b|40b|47b)\b/.test(normalized)) return 'flash';
  if (/\b([1-9]b|10b|11b|12b)\b/.test(normalized) || normalized.includes('instant') || normalized.includes('small')) return 'lite';
  return undefined;
}

export function buildStaticCatalog(provider: LlmProvider): LlmModelCatalogEntry[] {
  return getProviderCatalogData(provider).catalog.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    family: model.family as ConcreteModelFamily | undefined,
    source: 'fallback' as const,
  }));
}

export function getCatalogModelId(entry?: LlmModelCatalogEntry) {
  return entry?.deploymentName || entry?.id || '';
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
  bucketModels?: Partial<SimpleBucketModels>;
}): UiGeneratorStrategyState {
  const provider = normalizeProvider(opts.provider ?? opts.config?.provider);
  const savedModels = getSavedModels(opts.config);
  const modelStrategy = normalizeStrategy(opts.modelStrategy ?? opts.config?.modelStrategy);
  const pipelineProfile = normalizePipelineProfile(
    opts.config?.pipelineProfile ?? inferPipelineProfileFromModels(opts.config),
  );
  const bucketClasses = normalizeBucketClasses(opts.config?.bucketClasses);
  const fallbackBuckets = getBucketModelsFromSavedModels(savedModels);
  const resolvedBucketModels: SimpleBucketModels = {
    discovery: opts.bucketModels?.discovery ?? fallbackBuckets.discovery,
    generation: opts.bucketModels?.generation ?? fallbackBuckets.generation,
    refinement: opts.bucketModels?.refinement ?? fallbackBuckets.refinement,
  };
  const storyAssistantAssignments = resolveStoryAssistantAssignments(provider, opts.config);
  const profileModels = resolveProfileModelAssignments(provider, pipelineProfile, storyAssistantAssignments, savedModels);

  return {
    provider,
    modelStrategy,
    pipelineProfile,
    bucketClasses,
    resolvedBucketModels,
    resolvedModels: {
      ...(modelStrategy === 'advanced' ? savedModels : buildResolvedModelsFromBuckets(resolvedBucketModels)),
      ...profileModels,
    },
    inferredFromLegacyModels: Boolean(opts.config?.modelStrategy && ['stable', 'latest', 'custom'].includes(String(opts.config.modelStrategy))),
    matchedPreset: false,
  };
}
