/**
 * Thin wrapper around @forge/llm.
 * All LLM calls in the app go through this module.
 *
 * API reference: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
 */

import { chat } from '@forge/llm';
import { PiiMaskingStats } from '../types';
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
  timeoutMs?: number;
  geminiThinkingBudget?: number;
  provider?: 'forge_llms' | 'gemini' | 'openai' | 'azure_openai';
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  azureOpenaiApiKey?: string;
  azureOpenaiEndpoint?: string;
  azureOpenaiDeployment?: string;
  azureOpenaiApiVersion?: string;
  /** When true, never fall back to Gemini/OpenAI — throw the Forge LLM error as-is. */
  noFallback?: boolean;
  piiMaskingEnabled?: boolean;
}

interface JsonLlmCallOptions extends LlmCallOptions {
  retryOnParseFailure?: boolean;
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

  if (opts.provider === 'gemini') {
    const result = await callGemini(effectiveOpts);
    return { ...result, piiMasking };
  }
  if (opts.provider === 'openai') {
    const result = await callOpenAI(effectiveOpts);
    return { ...result, piiMasking };
  }
  if (opts.provider === 'azure_openai') {
    const result = await callAzureOpenAI(effectiveOpts);
    return { ...result, piiMasking };
  }

  try {
    const response = await withLocalTimeout(
      chat({
        model: opts.model,
        messages: [
          { role: 'system', content: effectiveOpts.systemPrompt },
          { role: 'user', content: effectiveOpts.userMessage },
        ],
        max_completion_tokens: opts.maxTokens ?? 8192,
      }),
      opts.timeoutMs,
      `Forge LLM call (${opts.model})`,
    );

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
      const result = await callOpenAI(effectiveOpts);
      return { ...result, piiMasking };
    }
    if (opts.azureOpenaiApiKey || process.env.AZURE_OPENAI_API_KEY) {
      const result = await callAzureOpenAI(effectiveOpts);
      return { ...result, piiMasking };
    }
    const result = await callGemini(effectiveOpts);
    return { ...result, piiMasking };
  }
}

async function withLocalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  label: string,
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return promise;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
  label: string,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, init);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      throw new Error(`${label} exceeded ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function shouldFallbackToGemini(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  return msg.includes('llm endpoint not enabled') || msg.includes("'llm' module is not defined");
}

function mapModelForGemini(model: string): string {
  if (model.startsWith('gemini-')) return model;
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const lower = model.toLowerCase();

  // Preserve "fast vs deep" intent when Forge/provider routing falls through to
  // Gemini. The previous implementation sent every non-Gemini model to Flash,
  // which made deep generation paths far weaker than intended.
  if (/(haiku|mini|flash)/i.test(lower)) return 'gemini-2.5-flash';
  if (/(opus|sonnet|pro|gpt-4\.5|gpt-4o(?!-mini)|o1|o3|deep)/i.test(lower)) return 'gemini-2.5-pro';

  return 'gemini-2.5-pro';
}

async function callGemini(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  timeoutMs?: number;
  geminiThinkingBudget?: number;
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

  const requestBody: Record<string, unknown> = {
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
  };

  if (typeof opts.geminiThinkingBudget === 'number') {
    (requestBody.generationConfig as Record<string, unknown>).thinkingConfig = {
      thinkingBudget: Math.max(0, Math.min(24576, Math.round(opts.geminiThinkingBudget))),
    };
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
    opts.timeoutMs,
    `Gemini API call (${model})`,
  );

  const rawBody = await res.text();
  let payload: {
    error?: { message?: string };
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  } = {};

  try {
    payload = JSON.parse(rawBody) as {
      error?: { message?: string };
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
      };
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
    outputTokens:
      (payload.usageMetadata?.candidatesTokenCount ?? 0) +
      (payload.usageMetadata?.thoughtsTokenCount ?? 0),
  };
}

async function callOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  timeoutMs?: number;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('OpenAI API key is not set.');
  }

  const baseUrl = opts.openaiBaseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const url = `${baseUrl}/chat/completions`;

  const res = await fetchWithTimeout(
    url,
    {
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
    },
    opts.timeoutMs,
    `OpenAI API call (${opts.model})`,
  );

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

function shouldRequestJsonObjectMode(systemPrompt: string, userMessage: string): boolean {
  const combined = `${systemPrompt}\n${userMessage}`.toLowerCase();
  return combined.includes('json');
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function callAzureOpenAI(opts: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  timeoutMs?: number;
  azureOpenaiApiKey?: string;
  azureOpenaiEndpoint?: string;
  azureOpenaiDeployment?: string;
  azureOpenaiApiVersion?: string;
}): Promise<LlmResponse> {
  const apiKey = (opts.azureOpenaiApiKey ?? process.env.AZURE_OPENAI_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('Azure OpenAI API key is not set.');
  }

  const endpoint = trimTrailingSlash(
    opts.azureOpenaiEndpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? '',
  );
  if (!endpoint) {
    throw new Error('Azure OpenAI endpoint is not set.');
  }

  const deployment = (
    opts.azureOpenaiDeployment ??
    process.env.AZURE_OPENAI_DEPLOYMENT ??
    opts.model
  ).trim();
  if (!deployment) {
    throw new Error('Azure OpenAI deployment name is not set.');
  }

  const apiVersion = (
    opts.azureOpenaiApiVersion ??
    process.env.AZURE_OPENAI_API_VERSION ??
    '2024-10-21'
  ).trim();
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: opts.systemPrompt },
      { role: 'user', content: opts.userMessage },
    ],
    max_tokens: opts.maxTokens ?? 8192,
  };

  if (shouldRequestJsonObjectMode(opts.systemPrompt, opts.userMessage)) {
    body.response_format = { type: 'json_object' };
  }

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify(body),
    },
    opts.timeoutMs,
    `Azure OpenAI API call (${deployment})`,
  );

  const rawBody = await res.text();
  if (!res.ok) {
    throw new Error(`Azure OpenAI API error: ${rawBody}`);
  }

  const payload = JSON.parse(rawBody);
  const text = payload.choices?.[0]?.message?.content ?? '';

  return {
    text,
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
 * Call LLM and extract JSON. Retries only when retryOnParseFailure is enabled.
 */
export async function callLlmJson<T>(opts: JsonLlmCallOptions): Promise<T> {
  const result = await callLlmJsonWithUsage<T>(opts);
  return result.data;
}

export async function callLlmJsonWithUsage<T>(opts: JsonLlmCallOptions): Promise<{ data: T; usage: { input: number; output: number }; piiMasking?: PiiMaskingStats }> {
  let lastError: Error | null = null;
  let totalInput = 0;
  let totalOutput = 0;
  const piiMaskingTotals: PiiMaskingStats = { enabled: !!opts.piiMaskingEnabled, totalRedactions: 0, byType: {} };
  const maxAttempts = opts.retryOnParseFailure ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      if (attempt === 0 && opts.retryOnParseFailure) {
        opts = {
          ...opts,
          userMessage: opts.userMessage + '\n\nIMPORTANT: Respond with valid JSON only. No prose before or after.',
        };
      }
    }
  }

  throw lastError ?? new Error('LLM JSON extraction failed');
}
