import type { TenantConfig } from '../types';

export function useStoryAssistantDefaultPipeline(config: TenantConfig): boolean {
  if (config.pipelineFlags?.legacyLlmLedPipeline) return false;
  return config.pipelineFlags?.storyAssistantDefaultPipeline !== false;
}

export function useAdvancedGrounding(config: TenantConfig): boolean {
  return Boolean(config.pipelineFlags?.advancedGroundingEnabled);
}
