/**
 * Thin wrapper around @forge/llm.
 * All LLM calls in the app go through this module.
 *
 * API reference: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
 */

import { chat } from '@forge/llm';
import type {
  ConcreteModelFamily,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmProvider,
  LlmVendorModelCatalog,
  LatestModelSelector,
  PiiMaskingStats,
} from '../types';
import { maskPiiText } from '../services/compliance';

export interface LlmResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  piiMasking?: PiiMaskingStats;
}

export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  provider?: LlmProvider;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  modelCatalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[];
  modelCatalogs?: LlmModelCatalogByVendor;
  /** When true, never fall back to Gemini/OpenAI — throw the Forge LLM error as-is. */
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmResponse> {
  const maskedSystem = maskPiiText(opts.systemPrompt, !!opts.piiMaskingEnabled);
  const maskedUser = maskPiiText(opts.userMessage, !!opts.piiMaskingEnabled);
  const piiMasking: PiiMaskingStats = {
    enabled: !!opts.piiMaskingEnabled,
    totalRedactions: maskedSystem.stats.totalRedactions + maskedUser.stats.totalRedactions,
    byType: Object.entries({ ...maskedSystem.stats.byType, ...maskedUser.stats.byType }).reduce((acc, [k]) => {
      acc[k] = (maskedSystem.stats.byType[k] ?? 0) + (maskedUser.stats.byType[k] ?? 0);
      return acc;
    }, {} as Record<string, number>),
  };

  const effectiveOpts: LlmCallOptions = {
    ...opts,
    systemPrompt: maskedSystem.text,
    userMessage: maskedUser.text,
  };
  const resolvedModel = resolveModelSelection(
    effectiveOpts.model,
    effectiveOpts.provider,
    effectiveOpts.modelCatalog ?? (effectiveOpts.provider ? effectiveOpts.modelCatalogs?.[effectiveOpts.provider] : undefined),
  );

  if (opts.provider === 'gemini') {
    const result = await callGemini({ ...effectiveOpts, model: resolvedModel });
    return { ...result, piiMasking };
  }
  if (opts.provider === 'openai') {
    const result = await callOpenAI({ ...effectiveOpts, model: resolvedModel });
    return { ...result, piiMasking };
  }
  if (opts.provider === 'azure_openai') {
    const result = await callAzureOpenAI({ ...effectiveOpts, model: resolvedModel });
    return { ...result, piiMasking };
  }

  try {
    const response = await chat({
      model: resolvedModel,
      messages: [
        { role: 'system', content: effectiveOpts.systemPrompt },
        { role: 'user', content: effectiveOpts.userMessage },
      ],
      max_completion_tokens: opts.maxTokens ?? 8192,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const text = typeof content === 'string' ? content : JSON.stringify(content);

    return {
      text: text.trim(),
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
      piiMasking,
    };
  } catch (err) {
    if (opts.noFallback || !shouldFallbackToGemini(err)) {
      throw err;
    }
    // Fallback to whichever external provider has an API key configured
    if (opts.openaiApiKey || process.env.OPENAI_API_KEY) {
      const result = await callOpenAI({ ...effectiveOpts, model: resolvedModel });
      return { ...result, piiMasking };
    }
    const result = await callGemini({ ...effectiveOpts, model: resolvedModel });
    return { ...result, piiMasking };
  }
}

function shouldFallbackToGemini(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  return msg.includes('llm endpoint not enabled') || msg.includes("'llm' module is not defined");
}

export function isLatestModelSelector(model: string): model is LatestModelSelector {
  const normalized = model.trim().toLowerCase();
  return normalized === 'latest' || normalized === 'latest-pro' || normalized === 'latest-flash' || normalized === 'latest-lite';
}

export function isConcreteModelFamily(value: string): value is ConcreteModelFamily {
  return value === 'pro' || value === 'flash' || value === 'lite';
}

export function inferModelFamily(model: string): ConcreteModelFamily | 'custom' {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes('flash')) return 'flash';
  if (normalized.includes('lite') || normalized.includes('mini')) return 'lite';
  if (normalized.includes('pro')) return 'pro';
  if (normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.startsWith('o4')) {
    return normalized.includes('mini') ? 'lite' : 'flash';
  }
  if (normalized.includes('sonnet')) return 'flash';
  if (normalized.includes('haiku')) return 'lite';
  if (normalized.includes('opus')) return 'pro';
  return 'custom';
}

export function latestSelectorForFamily(family?: ConcreteModelFamily): LatestModelSelector {
  if (!family) return 'latest';
  return `latest-${family}` as LatestModelSelector;
}

function normalizeCatalogEntries(catalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[]): LlmModelCatalogEntry[] {
  const entries = Array.isArray(catalog) ? catalog : catalog?.models ?? [];
  return entries
    .map((entry) => ({
      ...entry,
      family: entry.family ?? inferModelFamily(entry.id),
    }))
    .filter((entry) => !!entry.id);
}

function compareCatalogEntries(a: LlmModelCatalogEntry, b: LlmModelCatalogEntry): number {
  const latestDiff = Number(Boolean(b.isLatest)) - Number(Boolean(a.isLatest));
  if (latestDiff !== 0) return latestDiff;

  const aTime = a.releaseDate ? Date.parse(a.releaseDate) : Number.NEGATIVE_INFINITY;
  const bTime = b.releaseDate ? Date.parse(b.releaseDate) : Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return bTime - aTime;

  return (a.displayName ?? a.id).localeCompare(b.displayName ?? b.id);
}

export function resolveLatestModelSelector(
  selector: string,
  catalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[],
  preferredFamily?: ConcreteModelFamily,
): string {
  if (!isLatestModelSelector(selector)) return selector;

  const entries = normalizeCatalogEntries(catalog);
  if (!entries.length) return selector;

  const explicitFamily = selector === 'latest' ? preferredFamily : (selector.split('-')[1] as ConcreteModelFamily | undefined);
  const familyFiltered = explicitFamily ? entries.filter((entry) => (entry.family ?? inferModelFamily(entry.id)) === explicitFamily) : entries;
  const sorted = (familyFiltered.length ? familyFiltered : entries).slice().sort(compareCatalogEntries);

  return sorted[0]?.deploymentName ?? sorted[0]?.id ?? selector;
}

export function resolveModelSelection(
  model: string,
  provider?: LlmProvider,
  catalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[],
): string {
  const preferredFamily = provider ? inferModelFamily(model) : undefined;
  return resolveLatestModelSelector(model, catalog, preferredFamily === 'custom' ? undefined : preferredFamily);
}

function markLatestModels(entries: LlmModelCatalogEntry[]): LlmModelCatalogEntry[] {
  const familyBest = new Map<ConcreteModelFamily, string>();
  const sorted = entries.slice().sort(compareCatalogEntries);
  for (const entry of sorted) {
    const family = entry.family ?? inferModelFamily(entry.id);
    if (!isConcreteModelFamily(family)) continue;
    if (!familyBest.has(family)) {
      familyBest.set(family, entry.id);
    }
  }

  return sorted.map((entry) => {
    const family = entry.family ?? inferModelFamily(entry.id);
    return {
      ...entry,
      family: isConcreteModelFamily(family) ? family : undefined,
      isLatest: isConcreteModelFamily(family) ? familyBest.get(family) === entry.id : entry.isLatest,
    };
  });
}

function buildCatalog(
  vendor: LlmProvider,
  models: LlmModelCatalogEntry[],
  source: 'discovered' | 'manual' | 'fallback',
): LlmVendorModelCatalog {
  return {
    vendor,
    source,
    fetchedAt: new Date().toISOString(),
    models: markLatestModels(models),
  };
}

export function getFallbackModelCatalog(provider: LlmProvider): LlmVendorModelCatalog {
  if (provider === 'forge_llms') {
    return buildCatalog(provider, [
      { id: 'claude-opus-4-6', displayName: 'Claude Opus', family: 'pro' },
      { id: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet', family: 'flash' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku', family: 'lite' },
    ], 'fallback');
  }
  if (provider === 'gemini') {
    return buildCatalog(provider, [
      { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', family: 'pro' },
      { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', family: 'flash' },
      { id: 'gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', family: 'lite' },
    ], 'fallback');
  }
  if (provider === 'openai') {
    return buildCatalog(provider, [
      { id: 'gpt-5', displayName: 'GPT-5', family: 'pro' },
      { id: 'gpt-4.1', displayName: 'GPT-4.1', family: 'flash' },
      { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 Mini', family: 'lite' },
    ], 'fallback');
  }
  return buildCatalog(provider, [], 'fallback');
}

function isChatCapableOpenAiModel(id: string): boolean {
  const normalized = id.toLowerCase();
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
    return !normalized.includes('audio') && !normalized.includes('realtime') && !normalized.includes('transcribe');
  }
  return false;
}

function toDisplayName(modelId: string): string {
  return modelId
    .replace(/^models\//, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function discoverLlmModelCatalog(opts: {
  provider: LlmProvider;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
}): Promise<LlmVendorModelCatalog> {
  if (opts.provider === 'forge_llms') {
    return getFallbackModelCatalog('forge_llms');
  }

  if (opts.provider === 'gemini') {
    const apiKey = (opts.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('gemini');
    }
    const baseUrl = opts.geminiBaseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url);
    const payload = await res.json() as {
      models?: Array<{
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
        inputTokenLimit?: number;
        outputTokenLimit?: number;
      }>;
    };
    if (!res.ok) {
      throw new Error(`Gemini model discovery failed with status ${res.status}`);
    }
    const models = (payload.models ?? [])
      .filter((model) => (model.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((model) => ({
        id: String(model.name ?? '').replace(/^models\//, ''),
        displayName: model.displayName || toDisplayName(String(model.name ?? '')),
        family: inferModelFamily(String(model.name ?? '').replace(/^models\//, '')) === 'custom'
          ? undefined
          : inferModelFamily(String(model.name ?? '').replace(/^models\//, '')),
        contextWindowTokens: model.inputTokenLimit,
        maxOutputTokens: model.outputTokenLimit,
        source: 'discovered' as const,
      }))
      .filter((model) => model.id);
    return models.length ? buildCatalog('gemini', models, 'discovered') : getFallbackModelCatalog('gemini');
  }

  if (opts.provider === 'openai') {
    const apiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('openai');
    }
    const baseUrl = opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const payload = await res.json() as { data?: Array<{ id?: string; created?: number }> };
    if (!res.ok) {
      throw new Error(`OpenAI model discovery failed with status ${res.status}`);
    }
    const models = (payload.data ?? [])
      .filter((model) => model.id && isChatCapableOpenAiModel(model.id))
      .map((model) => ({
        id: String(model.id),
        displayName: toDisplayName(String(model.id)),
        family: inferModelFamily(String(model.id)) === 'custom' ? undefined : inferModelFamily(String(model.id)),
        releaseDate: model.created ? new Date(model.created * 1000).toISOString() : undefined,
        source: 'discovered' as const,
      }));
    return models.length ? buildCatalog('openai', models, 'discovered') : getFallbackModelCatalog('openai');
  }

  const apiKey = (opts.azureOpenAIApiKey ?? process.env.AZURE_OPENAI_API_KEY ?? '').trim();
  const endpoint = (opts.azureOpenAIBaseUrl ?? process.env.AZURE_OPENAI_BASE_URL ?? process.env.AZURE_OPENAI_ENDPOINT ?? '').trim();
  const apiVersion = (opts.azureOpenAIApiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-06-01').trim();
  if (!apiKey || !endpoint) {
    return getFallbackModelCatalog('azure_openai');
  }
  const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
  const res = await fetch(url, {
    headers: {
      'api-key': apiKey,
    },
  });
  const payload = await res.json() as {
    data?: Array<{ id?: string; model?: string; created_at?: number; status?: string }>;
    value?: Array<{ id?: string; model?: string; createdAt?: number; status?: string }>;
  };
  if (!res.ok) {
    throw new Error(`Azure OpenAI deployment discovery failed with status ${res.status}`);
  }
  type AzureDeployment = { id?: string; model?: string; created_at?: number; createdAt?: number; status?: string };
  const deployments: AzureDeployment[] = [...(payload.data ?? []), ...(payload.value ?? [])];
  const models = deployments
    .filter((deployment) => deployment.id)
    .map((deployment) => {
      const deploymentId = String(deployment.id);
      const backingModel = String((deployment as { model?: string }).model ?? deploymentId);
      const family = inferModelFamily(backingModel);
      return {
        id: deploymentId,
        deploymentName: deploymentId,
        displayName: `${deploymentId}${backingModel && backingModel !== deploymentId ? ` (${backingModel})` : ''}`,
        family: family === 'custom' ? undefined : family,
        releaseDate: (deployment as { created_at?: number; createdAt?: number }).created_at
          ? new Date(((deployment as { created_at?: number }).created_at ?? 0) * 1000).toISOString()
          : (deployment as { createdAt?: number }).createdAt
            ? new Date((deployment as { createdAt?: number }).createdAt ?? 0).toISOString()
            : undefined,
        source: 'discovered' as const,
      };
    });
  return models.length ? buildCatalog('azure_openai', models, 'discovered') : getFallbackModelCatalog('azure_openai');
}

function mapModelForGemini(model: string): string {
  if (model.startsWith('gemini-')) return model;
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  // Reasonable default for the Claude-first config in this app.
  return 'gemini-2.5-flash';
}

async function callGemini(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error(
      'Forge LLM endpoint is unavailable and GEMINI_API_KEY is not set. Set GEMINI_API_KEY (and optional GEMINI_MODEL) as Forge environment variables.',
    );
  }

  const model = mapModelForGemini(opts.model);
  const baseUrl = opts.geminiBaseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: opts.systemPrompt }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: opts.userMessage }],
        },
      ],
      generationConfig: {
        maxOutputTokens: opts.maxTokens ?? 8192,
        responseMimeType: 'application/json', // Native JSON mode for better reliability
      },
    }),
  });

  const rawBody = await res.text();
  let payload: {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  } = {};

  try {
    payload = JSON.parse(rawBody) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
  } catch {
    // Some Forge/network errors come back as plain text, not JSON.
  }

  if (!res.ok || payload.error) {
    const message = payload.error?.message || rawBody || `Gemini request failed with status ${res.status}`;
    throw new Error(`Gemini API error: ${message}`);
  }

  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  if (!text) {
    throw new Error('Gemini API returned an empty response.');
  }

  return {
    text,
    inputTokens: payload.usageMetadata?.promptTokenCount,
    outputTokens: payload.usageMetadata?.candidatesTokenCount,
  };
}

async function callOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenAI API key is not set.');
  }

  const baseUrl = opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage }
      ],
      max_tokens: opts.maxTokens ?? 8192,
      response_format: { type: 'json_schema' } // Native OpenAI JSON mode for bulletproof parsing
    })
  });

  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`OpenAI API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody);
  const text = payload.choices?.[0]?.message?.content ?? '';

  return {
    text,
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens
  };
}

async function callAzureOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.azureOpenAIApiKey ?? process.env.AZURE_OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Azure OpenAI API key is not set.');
  }

  const endpoint = (opts.azureOpenAIBaseUrl ?? process.env.AZURE_OPENAI_BASE_URL ?? process.env.AZURE_OPENAI_ENDPOINT ?? '').trim();
  if (!endpoint) {
    throw new Error('Azure OpenAI endpoint is not set.');
  }

  const apiVersion = (opts.azureOpenAIApiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-06-01').trim();
  const baseUrl = endpoint.replace(/\/+$/, '');
  const deployment = opts.model.trim();
  const url = `${baseUrl}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      max_tokens: opts.maxTokens ?? 8192,
    }),
  });

  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`Azure OpenAI API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = payload.choices?.[0]?.message?.content ?? '';
  const text = typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');

  return {
    text: text.trim(),
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
  };
}

/**
 * Parse JSON from LLM output, tolerating leading/trailing prose.
 * Tries: direct parse → extract first {...} or [...] block.
 */
export function extractJson<T = unknown>(text: string): T {
  // 1. Direct parse
  try {
    return JSON.parse(text) as T;
  } catch { /* continue */ }

  // 2. Find first { or [ and scan for balanced close
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);

  if (start !== -1) {
    const closer = text[start] === '{' ? '}' : ']';
    const end = text.lastIndexOf(closer);
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch { /* continue */ }
    }
  }

  throw new Error(`Could not parse JSON from LLM response. Raw text: ${text.slice(0, 300)}`);
}

/**
 * Call LLM and extract JSON, with one retry on JSON parse failure.
 */
export async function callLlmJson<T>(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  provider?: LlmProvider;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  modelCatalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[];
  modelCatalogs?: LlmModelCatalogByVendor;
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}): Promise<T> {
  const result = await callLlmJsonWithUsage<T>(opts);
  return result.data;
}

export async function callLlmJsonWithUsage<T>(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  provider?: LlmProvider;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  modelCatalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[];
  modelCatalogs?: LlmModelCatalogByVendor;
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}): Promise<{ data: T; usage: { input: number; output: number }; piiMasking?: PiiMaskingStats }> {
  let lastError: Error | null = null;
  let totalInput = 0;
  let totalOutput = 0;
  const piiMaskingTotals: PiiMaskingStats = { enabled: !!opts.piiMaskingEnabled, totalRedactions: 0, byType: {} };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callLlm(opts);
    totalInput += res.inputTokens ?? 0;
    totalOutput += res.outputTokens ?? 0;
    if (res.piiMasking?.enabled) {
      piiMaskingTotals.enabled = true;
      piiMaskingTotals.totalRedactions += res.piiMasking.totalRedactions;
      Object.entries(res.piiMasking.byType).forEach(([k, v]) => {
        piiMaskingTotals.byType[k] = (piiMaskingTotals.byType[k] ?? 0) + v;
      });
    }
    try {
      return {
        data: extractJson<T>(res.text),
        usage: { input: totalInput, output: totalOutput },
        piiMasking: piiMaskingTotals,
      };
    } catch (err) {
      lastError = err as Error;
      if (attempt === 0) {
        opts = {
          ...opts,
          userMessage: opts.userMessage + '\n\nIMPORTANT: Respond with valid JSON only. No prose before or after.',
        };
      }
    }
  }

  throw lastError ?? new Error('LLM JSON extraction failed');
}
