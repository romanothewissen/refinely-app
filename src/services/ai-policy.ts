import {
  AiExecutionPolicy,
  DEFAULT_CONFIG,
  GeneratorConfig,
  ReasoningMode,
  TenantConfig,
} from '../types';

function getProjectAiPolicy(config: TenantConfig, projectKey?: string) {
  if (!projectKey || projectKey === '*') return null;
  const projectPolicy = (config.projectAiPolicies || []).find((policy) => policy.projectKey === projectKey);
  if (!projectPolicy || projectPolicy.preset === 'inherit') {
    return null;
  }
  return projectPolicy;
}

export function resolveAiExecutionPolicy(
  config: TenantConfig,
  projectKey?: string,
): AiExecutionPolicy {
  const workspacePolicy: AiExecutionPolicy = {
    ...DEFAULT_CONFIG.aiExecutionPolicy,
    ...(config.aiExecutionPolicy || {}),
  };

  if (!projectKey || projectKey === '*') {
    return workspacePolicy;
  }

  const projectPolicy = getProjectAiPolicy(config, projectKey);
  if (!projectPolicy) {
    return workspacePolicy;
  }

  return {
    ...workspacePolicy,
    workspacePreset:
      projectPolicy.preset === 'inherit'
        ? workspacePolicy.workspacePreset
        : projectPolicy.preset,
    defaultReasoningMode: projectPolicy.defaultReasoningMode ?? workspacePolicy.defaultReasoningMode,
    defaultOutputMode: projectPolicy.defaultOutputMode ?? workspacePolicy.defaultOutputMode,
    allowReasoningModeOverride:
      projectPolicy.allowReasoningModeOverride ?? workspacePolicy.allowReasoningModeOverride,
    allowOutputModeOverride:
      projectPolicy.allowOutputModeOverride ?? workspacePolicy.allowOutputModeOverride,
    simpleAskMaxQuestions:
      projectPolicy.simpleAskMaxQuestions ?? workspacePolicy.simpleAskMaxQuestions,
    deepModeRoundTarget:
      projectPolicy.deepModeRoundTarget ?? workspacePolicy.deepModeRoundTarget,
    enterpriseMaxQuestionsPerRound:
      projectPolicy.enterpriseMaxQuestionsPerRound ?? workspacePolicy.enterpriseMaxQuestionsPerRound,
    maxDeepDiscoveryRounds:
      projectPolicy.maxDeepDiscoveryRounds ?? workspacePolicy.maxDeepDiscoveryRounds,
  };
}

export function resolveGeneratorConfig(
  config: TenantConfig,
  projectKey?: string,
  reasoningMode?: ReasoningMode,
): GeneratorConfig {
  const baseConfig: GeneratorConfig = {
    ...DEFAULT_CONFIG.generatorConfig,
    ...(config.generatorConfig || {}),
  };
  const effectivePolicy = resolveAiExecutionPolicy(config, projectKey);
  const effectiveReasoningMode = reasoningMode ?? effectivePolicy.defaultReasoningMode;
  const projectPolicy = getProjectAiPolicy(config, projectKey);

  const fastProfileProvider =
    projectPolicy?.fastProfileProvider ??
    baseConfig.fastProfileProvider ??
    baseConfig.provider;
  const fastProfileModel =
    projectPolicy?.fastProfileModel ??
    baseConfig.fastProfileModel ??
    baseConfig.clarifyModel;
  const deepProfileProvider =
    projectPolicy?.deepProfileProvider ??
    baseConfig.deepProfileProvider ??
    baseConfig.provider;
  const deepProfileModel =
    projectPolicy?.deepProfileModel ??
    baseConfig.deepProfileModel ??
    baseConfig.decompositionModel;
  const projectHasProfileRouteOverride = Boolean(
    projectPolicy?.fastProfileProvider ||
    projectPolicy?.fastProfileModel ||
    projectPolicy?.deepProfileProvider ||
    projectPolicy?.deepProfileModel,
  );
  const profileMode =
    projectPolicy?.profileMode ??
    (projectHasProfileRouteOverride ? 'simplified' : baseConfig.profileMode);

  const resolvedConfig: GeneratorConfig = {
    ...baseConfig,
    profileMode,
    fastProfileProvider,
    fastProfileModel,
    deepProfileProvider,
    deepProfileModel,
  };

  if (profileMode !== 'simplified') {
    return resolvedConfig;
  }

  const selectedProvider =
    effectiveReasoningMode === 'deep' ? deepProfileProvider : fastProfileProvider;
  const selectedModel =
    effectiveReasoningMode === 'deep' ? deepProfileModel : fastProfileModel;

  return {
    ...resolvedConfig,
    provider: selectedProvider,
    decompositionModel: selectedModel,
    arModel: selectedModel,
    clarifyModel: selectedModel,
    refineModel: selectedModel,
    // evaluateModel and themeModel are used for classification/lightweight tasks
    // (planner, rerank, theme extraction) — always keep them on the fast profile
    // so they don't inherit a heavy thinking model in deep mode.
    evaluateModel: fastProfileModel,
    themeModel: fastProfileModel,
  };
}
