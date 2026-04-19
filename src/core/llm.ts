/**
 * Central LLM wrapper for all provider-backed model calls in the app.
 */

import type {
  ConcreteModelFamily,
  LlmModelCatalogByVendor,
  LlmModelCatalogEntry,
  LlmProvider,
  LlmVendorModelCatalog,
  LatestModelSelector,
  PipelineAuditLlmCallRecord,
  PiiMaskingStats,
} from '../types';
import { maskPiiText } from '../services/compliance';
import { getPipelineAuditWriter } from '../services/pipeline-audit-context';
import { extractJsonWithMetadata } from './json';
import strategyCatalog from '../frontend/src/modelStrategyCatalog.json';

export interface LlmResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  piiMasking?: PiiMaskingStats;
}

export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  /** Controls model reasoning depth. Maps to vendor-specific thinking/reasoning APIs. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  provider?: LlmProvider;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
  groqApiKey?: string;
  groqBaseUrl?: string;
  modelCatalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[];
  modelCatalogs?: LlmModelCatalogByVendor;
  /** When true, never fall back to Gemini/OpenAI — throw the Forge LLM error as-is. */
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}

export type ProviderNeutralReasoningDepth = 'light' | 'standard' | 'deep';

export function mapReasoningDepthToEffort(
  depth: ProviderNeutralReasoningDepth | undefined,
): LlmCallOptions['reasoningEffort'] {
  switch (depth) {
    case 'light':
      return 'low';
    case 'standard':
      return 'medium';
    case 'deep':
      return 'high';
    default:
      return 'low';
  }
}

function geminiThinkingBudget(effort: LlmCallOptions['reasoningEffort']): number | undefined {
  switch (effort) {
    case 'none':
      return 0;
    case 'low':
      return 4096;
    case 'medium':
      return 8192;
    case 'high':
      return 16384;
    default:
      return undefined;
  }
}

export function getRequestedThinkingBudget(
  provider: LlmProvider | undefined,
  model: string,
  effort: LlmCallOptions['reasoningEffort'],
): number | undefined {
  if (!effort || effort === 'none') return undefined;
  if (provider === 'gemini') {
    return buildGeminiThinkingConfig(model, effort)?.thinkingBudget as number | undefined;
  }
  if (provider === 'anthropic' && anthropicSupportsThinking(model)) {
    return geminiThinkingBudget(effort);
  }
  return undefined;
}

export function buildLlmAuditMetadata(input: {
  requestedModel: string;
  resolvedModel: string;
  provider?: LlmProvider;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  thoughtTokens?: number;
}): Pick<
  PipelineAuditLlmCallRecord,
  'model' | 'requestedModel' | 'resolvedModel' | 'provider' | 'maxTokens' | 'reasoningEffort' | 'thinkingBudget' | 'thoughtTokens'
> {
  return {
    model: input.resolvedModel,
    requestedModel: input.requestedModel,
    resolvedModel: input.resolvedModel,
    provider: input.provider,
    maxTokens: input.maxTokens,
    reasoningEffort: input.reasoningEffort,
    thinkingBudget: getRequestedThinkingBudget(input.provider, input.resolvedModel, input.reasoningEffort),
    thoughtTokens: input.thoughtTokens,
  };
}

// ─── Model-Capability Helpers ─────────────────────────────────────────────────
// These detect thinking/reasoning support from model names so we only send the
// vendor-specific thinking params to models that actually support them.
// Update the patterns here when new model generations ship with changed APIs.

function buildGeminiThinkingConfig(
  model: string,
  effort: LlmCallOptions['reasoningEffort'],
): Record<string, unknown> | undefined {
  if (!effort || effort === 'none') return undefined;
  const budget = geminiThinkingBudget(effort);
  if (budget === undefined || budget === 0) return undefined;
  // Thinking-capable Gemini models: 2.x and 3.x series, explicit "thinking" in name, or "exp"
  // Non-thinking models (e.g. gemini-1.5-flash, gemini-1.0) do not accept thinkingConfig.
  const isThinkingCapable = /gemini-([23][._\-]|flash-[23]|pro-[23]|exp)/i.test(model)
    || model.toLowerCase().includes('thinking');
  if (!isThinkingCapable) return undefined;
  return { thinkingBudget: budget };
}

function anthropicSupportsThinking(model: string): boolean {
  // Extended thinking requires Claude 3.7+ Sonnet or any Claude 4.x model.
  // Older models (3.5, 3.0, etc.) reject the thinking block with a 400 error.
  return /claude-(3[-_]7|sonnet-4|opus-4|haiku-4|4[-_])/i.test(model);
}

export function openAISupportsReasoning(model: string): boolean {
  // OpenAI reasoning controls are supported by o-series reasoning models and GPT-5 family models.
  // GPT-4o / GPT-4.1 style chat models should continue to omit the reasoning block.
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith('gpt-5') || /\bo\d/.test(normalized);
}

export function openAIRequiresMaxCompletionTokens(model: string): boolean {
  // GPT-5 and o-series models reject max_tokens and require max_completion_tokens instead.
  return openAISupportsReasoning(model);
}

export function groqSupportsReasoning(model: string): boolean {
  // Groq's reasoning_effort param is supported by DeepSeek R1 distill models only.
  return /deepseek-r1/i.test(model.trim());
}

const LLM_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;

function summarizeJsonParseInput(text: string): Record<string, string | number | boolean> {
  const trimmed = text.trim();
  const firstNonWhitespace = trimmed[0] ?? '';

  return {
    length: text.length,
    trimmedLength: trimmed.length,
    startsWithFence: /^```(?:json)?/i.test(trimmed),
    containsFence: /```/.test(trimmed),
    startsWithJsonToken: firstNonWhitespace === '{' || firstNonWhitespace === '[',
    startsWith: firstNonWhitespace || '(empty)',
    endsWithFence: /```$/.test(trimmed),
    containsDiscoveryProfile: trimmed.includes('"discoveryProfile"'),
    containsQuestionsKey: trimmed.includes('"questions"'),
  };
}

export class LlmJsonParseError extends Error {
  parseShape: string;

  constructor(message: string, parseShape: string) {
    super(message);
    this.name = 'LlmJsonParseError';
    this.parseShape = parseShape;
  }
}

function buildTimeoutError(label: string, timeoutMs: number): Error {
  return new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
}

async function fetchWithTimeout(url: string, init: RequestInit | undefined, label: string, timeoutMs = LLM_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw buildTimeoutError(label, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const LLM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const LLM_RETRYABLE_MSG = /\b(overloaded|unavailable|rate[ _-]?limit|quota|high demand|resource exhausted|temporarily|try again)\b/i;
const LLM_MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOllamaBaseUrl(rawBaseUrl: string | undefined, mode: 'native' | 'openai'): string {
  const fallback = mode === 'native' ? 'https://ollama.com' : 'https://ollama.com/v1';
  const candidate = (rawBaseUrl ?? '').trim();
  if (!candidate) return fallback;

  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    if (host === 'api.ollama.ai' || host === 'api.ollama.com') {
      parsed.hostname = 'ollama.com';
      // Preserve caller intent: native API should not keep /v1, OpenAI mode should include /v1.
      if (mode === 'native' && parsed.pathname.startsWith('/v1')) {
        parsed.pathname = parsed.pathname.replace(/^\/v1/, '') || '/';
      } else if (mode === 'openai' && !parsed.pathname.startsWith('/v1')) {
        const normalizedPath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
        parsed.pathname = `${normalizedPath}/v1`;
      }
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // Ignore invalid URL input and fall back to the provided value as-is.
  }

  return candidate.replace(/\/+$/, '');
}

async function fetchLlmWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = LLM_REQUEST_TIMEOUT_MS,
): Promise<{ res: Response; rawBody: string }> {
  for (let attempt = 0; attempt < LLM_MAX_ATTEMPTS; attempt++) {
    const res = await fetchWithTimeout(url, init, label, timeoutMs);
    const rawBody = await res.text();
    const isTransient = !res.ok && (LLM_RETRY_STATUSES.has(res.status) || LLM_RETRYABLE_MSG.test(rawBody));
    if (!isTransient || attempt === LLM_MAX_ATTEMPTS - 1) {
      return { res, rawBody };
    }
    const backoffMs = 1000 * Math.pow(2, attempt) + Math.round(Math.random() * 400);
    console.warn(`[llm] ${label} transient failure (status ${res.status}); retrying in ${backoffMs}ms (attempt ${attempt + 1}/${LLM_MAX_ATTEMPTS - 1})`);
    await sleep(backoffMs);
  }
  throw new Error(`${label} exhausted retries unexpectedly`);
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
  const requestedThinkingBudget = getRequestedThinkingBudget(opts.provider, resolvedModel, opts.reasoningEffort);

  const startedAt = Date.now();
  let result: LlmResponse;

  if (opts.provider === 'gemini') {
    result = await callGemini({ ...effectiveOpts, model: resolvedModel });
  } else if (opts.provider === 'anthropic') {
    result = await callAnthropic({ ...effectiveOpts, model: resolvedModel });
  } else if (opts.provider === 'openai') {
    result = await callOpenAI({ ...effectiveOpts, model: resolvedModel });
  } else if (opts.provider === 'azure_openai') {
    result = await callAzureOpenAI({ ...effectiveOpts, model: resolvedModel });
  } else if (opts.provider === 'ollama') {
    result = await callOllama({ ...effectiveOpts, model: resolvedModel });
  } else if (opts.provider === 'groq') {
    result = await callGroq({ ...effectiveOpts, model: resolvedModel });
  } else {
    throw new Error('LLM provider is required. Configure Gemini, OpenAI, Anthropic, Azure OpenAI, Ollama, or Groq before calling callLlm.');
  }

  const audit = getPipelineAuditWriter();
  if (audit) {
    const auditMeta = buildLlmAuditMetadata({
      requestedModel: opts.model,
      resolvedModel,
      provider: opts.provider,
      maxTokens: opts.maxTokens,
      reasoningEffort: opts.reasoningEffort,
      thoughtTokens: result.thoughtTokens,
    });
    audit.appendLlmCall({
      ...auditMeta,
      thinkingBudget: requestedThinkingBudget ?? auditMeta.thinkingBudget,
      systemPrompt: effectiveOpts.systemPrompt,
      userMessage: effectiveOpts.userMessage,
      responseText: result.text,
      durationMs: Date.now() - startedAt,
      usage: {
        input: result.inputTokens ?? 0,
        output: result.outputTokens ?? 0,
      },
      piiMasking: result.piiMasking ?? piiMasking,
    });
  }

  return { ...result, piiMasking };
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

function getStrategyCatalogEntries(provider: LlmProvider): LlmModelCatalogEntry[] {
  if (provider === 'forge_llms') return [];
  const providerCatalog = (strategyCatalog.providers as Record<string, { catalog: Array<{ id: string; displayName: string; family: string }> }>)[provider];
  if (!providerCatalog) return [];
  return providerCatalog.catalog.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    family: model.family as ConcreteModelFamily,
  }));
}

export function getFallbackModelCatalog(provider: LlmProvider): LlmVendorModelCatalog {
  if (provider === 'forge_llms') {
    return buildCatalog(provider, [], 'fallback');
  }
  return buildCatalog(provider, getStrategyCatalogEntries(provider), 'fallback');
}

function isChatCapableGroqModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return !normalized.includes('whisper')
    && !normalized.includes('-tts')
    && !normalized.includes('transcribe')
    && !normalized.includes('guard');
}

function isChatCapableOpenAiModel(id: string): boolean {
  const normalized = id.toLowerCase();
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
    return !normalized.includes('audio') && !normalized.includes('realtime') && !normalized.includes('transcribe');
  }
  return false;
}

function isTextCapableGeminiModel(id: string): boolean {
  const normalized = id.toLowerCase();
  return normalized.startsWith('gemini-')
    && !normalized.includes('image')
    && !normalized.includes('vision')
    && !normalized.includes('video')
    && !normalized.includes('veo')
    && !normalized.includes('tts')
    && !normalized.includes('speech')
    && !normalized.includes('audio')
    && !normalized.includes('embedding');
}

function toDisplayName(modelId: string): string {
  return modelId
    .replace(/^models\//, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function discoverLlmModelCatalog(opts: {
  provider: LlmProvider;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
  groqApiKey?: string;
  groqBaseUrl?: string;
}): Promise<LlmVendorModelCatalog> {
  if (opts.provider === 'forge_llms') {
    return getFallbackModelCatalog('forge_llms');
  }

  if (opts.provider === 'anthropic') {
    const apiKey = (opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('anthropic');
    }
    const baseUrl = opts.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetchWithTimeout(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, 'Anthropic model discovery');
    const payload = await res.json() as {
      data?: Array<{ id?: string; display_name?: string; created_at?: string; type?: string }>;
    };
    if (!res.ok) {
      throw new Error(`Anthropic model discovery failed with status ${res.status}`);
    }
    const models = (payload.data ?? [])
      .filter((model) => model.id)
      .map((model) => ({
        id: String(model.id),
        displayName: model.display_name || toDisplayName(String(model.id)),
        family: inferModelFamily(String(model.id)) === 'custom' ? undefined : inferModelFamily(String(model.id)),
        releaseDate: model.created_at,
        source: 'discovered' as const,
      }));
    return models.length ? buildCatalog('anthropic', models, 'discovered') : getFallbackModelCatalog('anthropic');
  }

  if (opts.provider === 'gemini') {
    const apiKey = (opts.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('gemini');
    }
    const baseUrl = opts.geminiBaseUrl ?? process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
    const url = `${baseUrl}/models?key=${encodeURIComponent(apiKey)}`;
    const res = await fetchWithTimeout(url, undefined, 'Gemini model discovery');
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
      .filter((model) => model.id && isTextCapableGeminiModel(model.id));
    return models.length ? buildCatalog('gemini', models, 'discovered') : getFallbackModelCatalog('gemini');
  }

  if (opts.provider === 'openai') {
    const apiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('openai');
    }
    const baseUrl = opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const url = `${baseUrl.replace(/\/+$/, '')}/models`;
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    }, 'OpenAI model discovery');
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

  if (opts.provider === 'ollama') {
    const ollamaApiKey = (opts.ollamaApiKey ?? '').trim();
    const baseUrl = normalizeOllamaBaseUrl(
      opts.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'https://ollama.com',
      'native',
    );
    if (!ollamaApiKey) {
      return getFallbackModelCatalog('ollama');
    }
    const url = `${baseUrl}/api/tags`;
    const res = await fetchWithTimeout(url, {
      headers: { 'Authorization': `Bearer ${ollamaApiKey}` },
    }, 'Ollama model discovery');
    const payload = await res.json() as { models?: Array<{ name?: string; modified_at?: string }> };
    if (!res.ok) {
      throw new Error(`Ollama model discovery failed with status ${res.status}`);
    }
    const models = (payload.models ?? [])
      .filter((m) => m.name)
      .map((m) => ({
        id: String(m.name),
        displayName: String(m.name),
        family: inferModelFamily(String(m.name)) === 'custom' ? 'flash' as ConcreteModelFamily : inferModelFamily(String(m.name)) as ConcreteModelFamily,
        source: 'discovered' as const,
      }));
    return models.length ? buildCatalog('ollama', models, 'discovered') : getFallbackModelCatalog('ollama');
  }

  if (opts.provider === 'groq') {
    const apiKey = (opts.groqApiKey ?? process.env.GROQ_API_KEY ?? '').trim();
    if (!apiKey) {
      return getFallbackModelCatalog('groq');
    }
    const baseUrl = (opts.groqBaseUrl ?? process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/models`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, 'Groq model discovery');
    const payload = await res.json() as { data?: Array<{ id?: string; created?: number }> };
    if (!res.ok) {
      throw new Error(`Groq model discovery failed with status ${res.status}`);
    }
    const models = (payload.data ?? [])
      .filter((model) => model.id && isChatCapableGroqModel(String(model.id)))
      .map((model) => ({
        id: String(model.id),
        displayName: toDisplayName(String(model.id)),
        family: inferModelFamily(String(model.id)) === 'custom' ? undefined : inferModelFamily(String(model.id)),
        releaseDate: model.created ? new Date(model.created * 1000).toISOString() : undefined,
        source: 'discovered' as const,
      }));
    return models.length ? buildCatalog('groq', models, 'discovered') : getFallbackModelCatalog('groq');
  }

  const apiKey = (opts.azureOpenAIApiKey ?? process.env.AZURE_OPENAI_API_KEY ?? '').trim();
  const endpoint = (opts.azureOpenAIBaseUrl ?? process.env.AZURE_OPENAI_BASE_URL ?? process.env.AZURE_OPENAI_ENDPOINT ?? '').trim();
  const apiVersion = (opts.azureOpenAIApiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-06-01').trim();
  if (!apiKey || !endpoint) {
    return getFallbackModelCatalog('azure_openai');
  }
  const url = `${endpoint.replace(/\/+$/, '')}/openai/deployments?api-version=${encodeURIComponent(apiVersion)}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      'api-key': apiKey,
    },
  }, 'Azure OpenAI deployment discovery');
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
  return strategyCatalog.providers.gemini.presets.stable.flash[0];
}

async function callGemini(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
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
  const thinkingConfig = buildGeminiThinkingConfig(model, opts.reasoningEffort);
  const useThinking = thinkingConfig !== undefined;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxTokens ?? 8192,
  };
  if (!useThinking) {
    generationConfig.responseMimeType = 'application/json';
  }
  if (thinkingConfig) {
    generationConfig.thinkingConfig = thinkingConfig;
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
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
      generationConfig,
    }),
  }, 'Gemini request');

  let payload: {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  } = {};

  try {
    payload = JSON.parse(rawBody) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
    };
  } catch {
    // Some Forge/network errors come back as plain text, not JSON.
  }

  if (!res.ok || payload.error) {
    const message = payload.error?.message || rawBody || `Gemini request failed with status ${res.status}`;
    throw new Error(`Gemini API error: ${message}`);
  }

  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .filter((p: { thought?: boolean }) => !p.thought)
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
    thoughtTokens: payload.usageMetadata?.thoughtsTokenCount,
  };
}

async function callAnthropic(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Anthropic API key is not set.');
  }

  const baseUrl = opts.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1';
  const url = `${baseUrl.replace(/\/+$/, '')}/messages`;
  const requestedMaxTokens = opts.maxTokens ?? 8192;
  const thinkingBudget = anthropicSupportsThinking(opts.model) && opts.reasoningEffort && opts.reasoningEffort !== 'none'
    ? geminiThinkingBudget(opts.reasoningEffort)
    : undefined;
  const maxTokens = thinkingBudget !== undefined && thinkingBudget >= requestedMaxTokens
    ? thinkingBudget + 256
    : requestedMaxTokens;

  const body: Record<string, unknown> = {
    model: opts.model,
    system: opts.systemPrompt,
    messages: [
      { role: 'user', content: opts.userMessage },
    ],
    max_tokens: maxTokens,
  };
  if (thinkingBudget !== undefined && thinkingBudget > 0) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, 'Anthropic request');

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (payload.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('')
    .trim();

  return {
    text,
    inputTokens: payload.usage?.input_tokens,
    outputTokens: payload.usage?.output_tokens,
  };
}

async function callOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenAI API key is not set.');
  }

  const baseUrl = opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
    response_format: { type: 'json_object' },
  };
  if (openAIRequiresMaxCompletionTokens(opts.model)) {
    body.max_completion_tokens = opts.maxTokens ?? 8192;
  } else {
    body.max_tokens = opts.maxTokens ?? 8192;
  }
  if (openAISupportsReasoning(opts.model) && opts.reasoningEffort && opts.reasoningEffort !== 'none') {
    body.reasoning = { effort: opts.reasoningEffort };
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(body),
  }, 'OpenAI request');

  if (!res.ok) {
    throw new Error(`OpenAI API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody);
  const text = payload.choices?.[0]?.message?.content ?? '';

  return {
    text,
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    thoughtTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
  };
}

async function callAzureOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
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
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
  };
  if (openAIRequiresMaxCompletionTokens(opts.model)) {
    body.max_completion_tokens = opts.maxTokens ?? 8192;
  } else {
    body.max_tokens = opts.maxTokens ?? 8192;
  }
  if (openAISupportsReasoning(opts.model) && opts.reasoningEffort && opts.reasoningEffort !== 'none') {
    body.reasoning = { effort: opts.reasoningEffort };
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  }, 'Azure OpenAI request');

  if (!res.ok) {
    throw new Error(`Azure OpenAI API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    };
  };

  const content = payload.choices?.[0]?.message?.content ?? '';
  const text = typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('');

  return {
    text: text.trim(),
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    thoughtTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
  };
}

async function callOllama(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.ollamaApiKey ?? process.env.OLLAMA_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Ollama API key is not set.');
  }

  const baseUrl = normalizeOllamaBaseUrl(
    opts.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/v1',
    'openai',
  );
  const url = `${baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
    max_tokens: opts.maxTokens ?? 8192,
    stream: false,
    response_format: { type: 'json_object' },
  };
  if (opts.reasoningEffort) {
    // Ollama's OpenAI-compatible chat/completions endpoint accepts reasoning_effort
    // for thinking-capable models and ignores it for others, which makes this a
    // safe best-effort toggle across the whole provider.
    body.reasoning_effort = opts.reasoningEffort;
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'Ollama request');

  if (!res.ok) {
    throw new Error(`Ollama API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  return {
    text: payload.choices?.[0]?.message?.content ?? '',
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
  };
}

async function callGroq(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  groqApiKey?: string;
  groqBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.groqApiKey ?? process.env.GROQ_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Groq API key is not set.');
  }

  const baseUrl = (opts.groqBaseUrl ?? process.env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
    max_tokens: opts.maxTokens ?? 8192,
    response_format: { type: 'json_object' },
  };
  if (groqSupportsReasoning(opts.model) && opts.reasoningEffort && opts.reasoningEffort !== 'none') {
    body.reasoning_effort = opts.reasoningEffort;
  }

  const { res, rawBody } = await fetchLlmWithRetry(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  }, 'Groq request');

  if (!res.ok) {
    throw new Error(`Groq API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
  };

  return {
    text: payload.choices?.[0]?.message?.content ?? '',
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    thoughtTokens: payload.usage?.completion_tokens_details?.reasoning_tokens,
  };
}

/**
 * Call LLM and extract JSON, with one retry on JSON parse failure.
 */
export async function callLlmJson<T>(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  provider?: LlmProvider;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
  groqApiKey?: string;
  groqBaseUrl?: string;
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
  reasoningEffort?: LlmCallOptions['reasoningEffort'];
  provider?: LlmProvider;
  anthropicApiKey?: string;
  anthropicBaseUrl?: string;
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenAIApiKey?: string;
  azureOpenAIBaseUrl?: string;
  azureOpenAIApiVersion?: string;
  ollamaApiKey?: string;
  ollamaBaseUrl?: string;
  groqApiKey?: string;
  groqBaseUrl?: string;
  modelCatalog?: LlmVendorModelCatalog | LlmModelCatalogEntry[];
  modelCatalogs?: LlmModelCatalogByVendor;
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}): Promise<{
  data: T;
  usage: { input: number; output: number };
  piiMasking?: PiiMaskingStats;
  parseOutcome: 'clean_parse' | 'repaired_parse';
}> {
  let lastError: Error | null = null;
  let lastParseShape = '';
  let totalInput = 0;
  let totalOutput = 0;
  const piiMaskingTotals: PiiMaskingStats = { enabled: !!opts.piiMaskingEnabled, totalRedactions: 0, byType: {} };
  const provider = opts.provider ?? 'unconfigured';
  const requestedModel = opts.model;

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
      const parsed = extractJsonWithMetadata<T>(res.text);
      getPipelineAuditWriter()?.annotateLastJsonParse(parsed.parseMode);
      return {
        data: parsed.data,
        usage: { input: totalInput, output: totalOutput },
        piiMasking: piiMaskingTotals,
        parseOutcome: parsed.parseMode,
      };
    } catch (err) {
      lastError = err as Error;
      const parseShape = summarizeJsonParseInput(res.text);
      lastParseShape = JSON.stringify(parseShape);
      const audit = getPipelineAuditWriter();
      if (audit) {
        audit.annotateLastJsonParse(attempt === 0 ? 'parse_failed' : 'parse_failed_after_retry');
      }
      if (attempt === 0) {
        console.warn('[llm-json] Failed to parse model response as JSON; retrying with stricter instruction.', {
          provider,
          model: requestedModel,
          attempt: attempt + 1,
          inputTokens: res.inputTokens ?? 0,
          outputTokens: res.outputTokens ?? 0,
          parseShape,
          error: lastError.message,
        });
      } else {
        console.error('[llm-json] Failed to parse model response as JSON after retry.', {
          provider,
          model: requestedModel,
          attempt: attempt + 1,
          inputTokens: res.inputTokens ?? 0,
          outputTokens: res.outputTokens ?? 0,
          parseShape,
          error: lastError.message,
        });
      }
      if (attempt === 0) {
        opts = {
          ...opts,
          userMessage: opts.userMessage + '\n\nIMPORTANT: Respond with valid JSON only. No prose before or after.',
        };
      }
    }
  }

  if (lastError) {
    throw new LlmJsonParseError(lastError.message || 'LLM JSON extraction failed', lastParseShape);
  }
  throw new LlmJsonParseError('LLM JSON extraction failed', lastParseShape);
}
