import test from 'node:test';
import assert from 'node:assert/strict';

import { getGenerationCredentialMode, getUsageLimits } from '../../services/billing';
import { getStoryAssistantPipelineProfileConfig } from '../../services/model-strategy';
import { DEFAULT_CONFIG, type TenantConfig } from '../../types';

type ConfigOverrides = Partial<Omit<TenantConfig, 'generatorConfig'>> & {
  generatorConfig?: Partial<TenantConfig['generatorConfig']>;
};

function buildConfig(overrides: ConfigOverrides = {}): TenantConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    generatorConfig: {
      ...DEFAULT_CONFIG.generatorConfig,
      ...(overrides.generatorConfig ?? {}),
    },
  };
}

test('treats missing tenant credentials as hosted sampler mode', () => {
  const config = buildConfig({
    generatorConfig: {
      provider: 'gemini',
      geminiApiKey: '',
    },
  });

  assert.equal(getGenerationCredentialMode(config), 'hosted_sampler');
});

test('treats the active provider tenant key as byok mode', () => {
  const config = buildConfig({
    generatorConfig: {
      provider: 'gemini',
      geminiApiKey: 'tenant-gemini-key',
    },
  });

  assert.equal(getGenerationCredentialMode(config), 'byok');
});

test('uses the hosted sampler monthly quota only when relying on fallback credentials', () => {
  const hostedConfig = buildConfig({
    generatorConfig: {
      provider: 'openai',
      openaiApiKey: '',
    },
  });
  const byokConfig = buildConfig({
    generatorConfig: {
      provider: 'openai',
      openaiApiKey: 'tenant-openai-key',
    },
  });

  assert.equal(getUsageLimits(hostedConfig).generationsPerMonth, 6);
  assert.equal(getUsageLimits(byokConfig).generationsPerMonth, 150);
});

test('treats fireworks tenant credentials as byok mode', () => {
  const config = buildConfig({
    generatorConfig: {
      provider: 'fireworks',
      fireworksApiKey: 'tenant-fireworks-key',
      fireworksBaseUrl: 'https://api.fireworks.ai/inference/v1',
    },
  });

  assert.equal(getGenerationCredentialMode(config), 'byok');
});

test('exposes the per-profile preview caps through the pipeline profile config', () => {
  const fastProfile = getStoryAssistantPipelineProfileConfig({
    provider: 'gemini',
    pipelineProfile: 'fast',
  });
  const balancedProfile = getStoryAssistantPipelineProfileConfig({
    provider: 'gemini',
    pipelineProfile: 'balanced',
  });
  const qualityProfile = getStoryAssistantPipelineProfileConfig({
    provider: 'gemini',
    pipelineProfile: 'quality',
  });

  assert.equal(fastProfile.similarStoryMaxResults, 4);
  assert.equal(fastProfile.enableCoverageProbe, false);

  assert.equal(balancedProfile.arReasoning, 'medium');
  assert.equal(balancedProfile.enableCoverageProbe, false);

  assert.equal(qualityProfile.arPatternMaxStories, 8);
  assert.equal(qualityProfile.enableCoverageProbe, true);
});
