/**
 * Thin wrapper around @forge/llm.
 * All LLM calls in the app go through this module.
 *
 * API reference: https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/
 */

import { chat } from '@forge/llm';

export interface LlmResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmCallOptions {
  model: string;
  systemPrompt: string;
  userMessage: string;
  maxTokens?: number;
  provider?: 'forge_llms' | 'gemini' | 'openai';
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  /** When true, never fall back to Gemini/OpenAI — throw the Forge LLM error as-is. */
  noFallback?: boolean;
}

export async function callLlm(opts: LlmCallOptions): Promise<LlmResponse> {
  if (opts.provider === 'gemini') {
    return callGemini(opts);
  }
  if (opts.provider === 'openai') {
    return callOpenAI(opts);
  }

  try {
    const response = await chat({
      model: opts.model,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userMessage },
      ],
      max_completion_tokens: opts.maxTokens ?? 8192,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const text = typeof content === 'string' ? content : JSON.stringify(content);

    return {
      text: text.trim(),
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens,
    };
  } catch (err) {
    if (opts.noFallback || !shouldFallbackToGemini(err)) {
      throw err;
    }
    // Fallback to whichever external provider has an API key configured
    if (opts.openaiApiKey || process.env.OPENAI_API_KEY) {
      return callOpenAI(opts);
    }
    return callGemini(opts);
  }
}

function shouldFallbackToGemini(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
  return msg.includes('llm endpoint not enabled') || msg.includes("'llm' module is not defined");
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
  provider?: 'forge_llms' | 'gemini' | 'openai';
  geminiApiKey?: string;
  geminiBaseUrl?: string;
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  noFallback?: boolean;
}): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await callLlm(opts);
    try {
      return extractJson<T>(res.text);
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
