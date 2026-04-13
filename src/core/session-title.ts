import type { TenantConfig } from '../types';
import { callLlm } from './llm';

function buildLlmProviderOpts(config: TenantConfig) {
  return {
    provider: config.generatorConfig.provider,
    geminiApiKey: config.generatorConfig.geminiApiKey,
    geminiBaseUrl: config.generatorConfig.geminiBaseUrl,
    openaiApiKey: config.generatorConfig.openaiApiKey,
    openaiBaseUrl: config.generatorConfig.openaiBaseUrl,
    azureOpenAIApiKey: config.generatorConfig.azureOpenAIApiKey,
    azureOpenAIBaseUrl: config.generatorConfig.azureOpenAIBaseUrl,
    azureOpenAIApiVersion: config.generatorConfig.azureOpenAIApiVersion,
    modelCatalogs: config.generatorConfig.modelCatalogs,
    piiMaskingEnabled: Boolean(config.compliance?.enabled && config.compliance?.piiMaskingEnabled),
  } as const;
}

function formatSessionTitle(rawTitle: string, fallbackRequirement: string): string {
  const cleaned = String(rawTitle ?? '')
    .replace(/^["']|["']$/g, '')
    .replace(/^[#*\-\d.\s]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*[-–—:;,.]+\s*$/g, '')
    .trim();

  const trimmed = cleaned && cleaned.toLowerCase() !== 'untitled'
    ? cleaned
    : fallbackRequirement
      .replace(/\s+/g, ' ')
      .trim()
      .split(/(?<=[.?!])\s+/)[0]
      .split(/[,:;()[\]{}]/)[0]
      .trim();

  const words = trimmed
    .split(' ')
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter(Boolean)
    .filter((word) => !['feature', 'task', 'process', 'workflow', 'requirement', 'system', 'solution'].includes(word.toLowerCase()));

  const capped = words.slice(0, 4).join(' ');
  const normalized = capped || 'Untitled session';
  return normalized.length > 48 ? normalized.slice(0, 48).trimEnd() : normalized;
}

export async function generateSessionTitle(requirement: string, config: TenantConfig): Promise<string> {
  const response = await callLlm({
    model: config.generatorConfig.themeModel,
    systemPrompt: 'Generate a very short session title for this software requirement. Prefer 2 to 4 words. Make it specific, scannable, and outcome-focused. Avoid quotes, punctuation-heavy phrasing, and generic labels like feature, task, process, workflow, requirement, or system. Output title only.',
    userMessage: requirement,
    maxTokens: 20,
    reasoningEffort: 'none',
    ...buildLlmProviderOpts(config),
  });

  return formatSessionTitle(response.text, requirement);
}
