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
  const projectPolicy = getProjectAiPolicy(config, projectKey);

  // Fast vs deep now controls workflow depth, not model routing. The selected
  // pipeline provider/model must stay consistent across the full LLM workflow.
  const pipelineProvider =
    projectPolicy?.fastProfileProvider ??
    projectPolicy?.deepProfileProvider ??
    baseConfig.fastProfileProvider ??
    baseConfig.deepProfileProvider ??
    baseConfig.provider;
  const pipelineModel =
    projectPolicy?.fastProfileModel ??
    projectPolicy?.deepProfileModel ??
    baseConfig.fastProfileModel ??
    baseConfig.deepProfileModel ??
    baseConfig.clarifyModel ??
    baseConfig.arModel;

  return {
    ...baseConfig,
    profileMode: 'simplified',
    provider: pipelineProvider,
    fastProfileProvider: pipelineProvider,
    deepProfileProvider: pipelineProvider,
    fastProfileModel: pipelineModel,
    deepProfileModel: pipelineModel,
    decompositionModel: pipelineModel,
    arModel: pipelineModel,
    clarifyModel: pipelineModel,
    refineModel: pipelineModel,
    evaluateModel: pipelineModel,
    themeModel: pipelineModel,
  };
}
