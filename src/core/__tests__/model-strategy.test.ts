import test from 'node:test';
import assert from 'node:assert/strict';

import { getTierModel } from '../../services/billing';
import {
  DEFAULT_BUCKET_CLASSES,
  MODEL_STRATEGY_VERSION,
  resolveEffectiveGeneratorConfig,
  resolveGeneratorStrategyState,
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
  assert.equal(resolved.decompositionModel, 'gpt-5.4');
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

  assert.equal(getTierModel(resolved.decompositionModel, 'free'), 'gpt-5.4-mini');
  assert.equal(getTierModel(resolved.refineModel, 'free'), 'gpt-4o-mini');
});
