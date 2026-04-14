import test from 'node:test';
import assert from 'node:assert/strict';

import { getTierModel } from '../../services/billing';
import {
  DEFAULT_BUCKET_CLASSES,
  MODEL_STRATEGY_VERSION,
  buildStoryAssistantModelRoute,
  resolveEffectiveGeneratorConfig,
  resolveGeneratorStrategyState,
  resolveStoryAssistantPipelineProfile,
} from '../../services/model-strategy';

test('uses the saved explicit role models for simple mode', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'openai',
    modelStrategy: 'simple',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    decompositionModel: 'gpt-5.4',
    arModel: 'gpt-5.4',
    clarifyModel: 'gpt-4o',
    refineModel: 'gpt-4o-mini',
    evaluateModel: 'gpt-4o',
    triageModel: 'gpt-4o',
    themeModel: 'gpt-4o',
    maxTokens: 8192,
  });

  assert.equal(resolved.modelStrategy, 'simple');
  assert.equal(resolved.pipelineProfile, 'balanced');
  assert.equal(resolved.decompositionModel, 'gpt-4o');
  assert.equal(resolved.clarifyModel, 'gpt-4o');
  assert.equal(resolved.refineModel, 'gpt-4o-mini');
});

test('normalizes legacy strategy values into simple or advanced', () => {
  const simpleState = resolveGeneratorStrategyState({
    provider: 'anthropic',
    modelStrategy: 'stable',
    clarifyModel: 'claude-sonnet-4-6',
    decompositionModel: 'claude-opus-4-6',
    refineModel: 'claude-sonnet-4-6',
    maxTokens: 8192,
  });
  const advancedState = resolveGeneratorStrategyState({
    provider: 'anthropic',
    modelStrategy: 'custom',
    clarifyModel: 'claude-sonnet-4-6',
    decompositionModel: 'claude-opus-4-6',
    refineModel: 'claude-sonnet-4-6',
    maxTokens: 8192,
  });

  assert.equal(simpleState.modelStrategy, 'simple');
  assert.equal(simpleState.inferredFromLegacyModels, true);
  assert.equal(advancedState.modelStrategy, 'advanced');
  assert.equal(advancedState.inferredFromLegacyModels, true);
});

test('applies free-tier downgrades after explicit user model selection', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'openai',
    pipelineProfile: 'quality',
    modelStrategy: 'advanced',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    decompositionModel: 'gpt-5.4',
    arModel: 'gpt-5.4',
    clarifyModel: 'gpt-4o',
    refineModel: 'gpt-4o',
    evaluateModel: 'gpt-4o-mini',
    triageModel: 'gpt-4o-mini',
    themeModel: 'gpt-4o-mini',
    maxTokens: 8192,
  });

  assert.equal(getTierModel(resolved.decompositionModel, 'free'), 'gpt-4o-mini');
  assert.equal(getTierModel(resolved.refineModel, 'free'), 'gpt-4o-mini');
});

test('defaults story assistant pipeline profile to balanced and resolves a deterministic mixed route', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'anthropic',
    modelStrategy: 'simple',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    refineModel: 'claude-sonnet-4-6',
    themeModel: 'claude-haiku-4-5',
    maxTokens: 8192,
  });

  assert.equal(resolved.pipelineProfile, 'balanced');
  assert.equal(resolveStoryAssistantPipelineProfile(resolved), 'balanced');

  const route = buildStoryAssistantModelRoute(resolved);
  assert.equal(route.clarify, resolved.clarifyModel);
  assert.equal(route.decomposition, resolved.decompositionModel);
  assert.equal(route.ar, resolved.arModel);
  assert.notEqual(route.clarify, route.decomposition);
});

test('infers quality and fast profiles from saved story assistant model families', () => {
  const qualityState = resolveGeneratorStrategyState({
    provider: 'openai',
    clarifyModel: 'gpt-5.4',
    decompositionModel: 'gpt-5.4',
    arModel: 'gpt-5.4',
    refineModel: 'gpt-4o-mini',
    themeModel: 'gpt-4o-mini',
    maxTokens: 8192,
  });
  const fastState = resolveGeneratorStrategyState({
    provider: 'anthropic',
    clarifyModel: 'claude-sonnet-4-6',
    decompositionModel: 'claude-sonnet-4-6',
    arModel: 'claude-haiku-4-5',
    refineModel: 'claude-sonnet-4-6',
    themeModel: 'claude-haiku-4-5',
    maxTokens: 8192,
  });

  assert.equal(qualityState.pipelineProfile, 'quality');
  assert.equal(fastState.pipelineProfile, 'fast');
});
