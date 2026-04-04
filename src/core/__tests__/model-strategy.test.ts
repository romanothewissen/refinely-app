import test from 'node:test';
import assert from 'node:assert/strict';

import { getTierModel } from '../../services/billing';
import {
  DEFAULT_BUCKET_CLASSES,
  MODEL_STRATEGY_VERSION,
  resolveEffectiveGeneratorConfig,
  resolveGeneratorStrategyState,
} from '../../services/model-strategy';

test('resolves curated Anthropic stable defaults into explicit role models', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'anthropic',
    modelStrategy: 'stable',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    decompositionModel: 'custom-decomp',
    arModel: 'custom-ar',
    clarifyModel: 'custom-clarify',
    refineModel: 'custom-refine',
    evaluateModel: 'custom-evaluate',
    triageModel: 'custom-triage',
    themeModel: 'custom-theme',
    maxTokens: 8192,
  });

  assert.equal(resolved.decompositionModel, 'claude-opus-4-1-20250805');
  assert.equal(resolved.arModel, 'claude-opus-4-1-20250805');
  assert.equal(resolved.clarifyModel, 'claude-3-5-sonnet-20241022');
  assert.equal(resolved.refineModel, 'claude-3-5-sonnet-20241022');
  assert.equal(resolved.evaluateModel, 'claude-3-5-sonnet-20241022');
});

test('supports per-bucket class overrides in latest mode', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'openai',
    modelStrategy: 'latest',
    bucketClasses: {
      discovery: 'lite',
      generation: 'pro',
      refinement: 'flash',
    },
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    decompositionModel: 'legacy-decomp',
    arModel: 'legacy-ar',
    clarifyModel: 'legacy-clarify',
    refineModel: 'legacy-refine',
    evaluateModel: 'legacy-evaluate',
    triageModel: 'legacy-triage',
    themeModel: 'legacy-theme',
    maxTokens: 8192,
  });

  assert.equal(resolved.decompositionModel, 'gpt-5.4');
  assert.equal(resolved.arModel, 'gpt-5.4');
  assert.equal(resolved.clarifyModel, 'gpt-5.4-mini');
  assert.equal(resolved.evaluateModel, 'gpt-5.4-mini');
  assert.equal(resolved.refineModel, 'gpt-4o');
});

test('falls back from unavailable latest Gemini models to stable mappings before saved explicit models', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'gemini',
    modelStrategy: 'latest',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    modelCatalogs: {
      gemini: {
        vendor: 'gemini',
        source: 'discovered',
        models: [
          { id: 'gemini-2.5-pro', family: 'pro' },
          { id: 'gemini-2.5-flash', family: 'flash' },
          { id: 'gemini-2.5-flash-lite', family: 'lite' },
        ],
      },
    },
    decompositionModel: 'saved-pro-model',
    arModel: 'saved-pro-model',
    clarifyModel: 'saved-flash-model',
    refineModel: 'saved-flash-model',
    evaluateModel: 'saved-flash-model',
    triageModel: 'saved-flash-model',
    themeModel: 'saved-flash-model',
    maxTokens: 8192,
  });

  assert.equal(resolved.decompositionModel, 'gemini-2.5-pro');
  assert.equal(resolved.clarifyModel, 'gemini-2.5-flash');
  assert.equal(resolved.refineModel, 'gemini-2.5-flash');
});

test('infers stable preset state from legacy explicit role assignments', () => {
  const state = resolveGeneratorStrategyState({
    provider: 'anthropic',
    decompositionModel: 'claude-opus-4-1-20250805',
    arModel: 'claude-opus-4-1-20250805',
    clarifyModel: 'claude-3-5-sonnet-20241022',
    refineModel: 'claude-3-5-sonnet-20241022',
    evaluateModel: 'claude-3-5-sonnet-20241022',
    triageModel: 'claude-3-5-sonnet-20241022',
    themeModel: 'claude-3-5-sonnet-20241022',
    maxTokens: 8192,
  });

  assert.equal(state.modelStrategy, 'stable');
  assert.deepEqual(state.bucketClasses, DEFAULT_BUCKET_CLASSES);
  assert.equal(state.matchedPreset, true);
  assert.equal(state.inferredFromLegacyModels, true);
});

test('applies free-tier downgrades after preset resolution', () => {
  const resolved = resolveEffectiveGeneratorConfig({
    provider: 'openai',
    modelStrategy: 'latest',
    bucketClasses: DEFAULT_BUCKET_CLASSES,
    modelStrategyVersion: MODEL_STRATEGY_VERSION,
    decompositionModel: 'legacy-decomp',
    arModel: 'legacy-ar',
    clarifyModel: 'legacy-clarify',
    refineModel: 'legacy-refine',
    evaluateModel: 'legacy-evaluate',
    triageModel: 'legacy-triage',
    themeModel: 'legacy-theme',
    maxTokens: 8192,
  });

  assert.equal(getTierModel(resolved.decompositionModel, 'free'), 'gpt-5.4-mini');
  assert.equal(getTierModel(resolved.refineModel, 'free'), 'gpt-4o-mini');
});
