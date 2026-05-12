export interface GeminiJsonOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  thinkingBudget?: number;
}

export async function callGeminiJson<T>(options: GeminiJsonOptions & { prompt: string }): Promise<T> {
  const model = options.model ?? 'gemini-2.5-flash';
  const baseUrl = options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  let lastError: Error | undefined;
  let lastPreview = '';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const prompt = attempt === 0 ? options.prompt : appendJsonRetryInstruction(options.prompt, lastError);
    const response = await fetch(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: options.maxOutputTokens ?? 4096,
          temperature: 0,
          thinkingConfig: { thinkingBudget: options.thinkingBudget ?? 2048 },
        },
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Gemini request failed: ${body}`);
    }

    const payload = JSON.parse(body) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim() ?? '';
    if (!text) throw new Error('Gemini returned an empty response.');

    try {
      return parseJsonCandidate<T>(text);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      lastPreview = text.replace(/\s+/g, ' ').slice(0, 360);
      if (attempt === 0) continue;
    }
  }

  throw new Error(`Gemini returned invalid JSON after retry: ${lastError?.message ?? 'unknown parse error'}. Preview: ${lastPreview}`);
}

function appendJsonRetryInstruction(prompt: string, lastError: Error | undefined): string {
  return `${prompt}

RETRY INSTRUCTION:
Your previous response was not valid parseable JSON${lastError ? ` (${lastError.message})` : ''}.
Return one complete top-level JSON object only.
Do not use markdown fences.
Do not leave strings unterminated.
Keep wording concise if needed, but preserve the required schema.
Prefer fewer, shorter strings over a long response.`;
}

function parseJsonCandidate<T>(text: string): T {
  const trimmed = text.trim();
  const withoutFence = stripMarkdownCodeFence(trimmed);
  const extracted = extractJsonEnvelope(withoutFence);
  const candidates = [
    trimmed,
    withoutFence,
    extracted,
    removeTrailingCommas(extracted),
    escapeRawNewlinesInStrings(removeTrailingCommas(extracted)),
  ].filter(Boolean);

  let lastError: Error | undefined;
  for (const candidate of Array.from(new Set(candidates))) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error('No JSON candidate could be parsed.');
}

function stripMarkdownCodeFence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function extractJsonEnvelope(text: string): string {
  const objectStart = text.indexOf('{');
  const arrayStart = text.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  if (!starts.length) return text;
  const start = Math.min(...starts);
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  return end > start ? text.slice(start, end + 1) : text.slice(start);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function escapeRawNewlinesInStrings(text: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      output += char;
      continue;
    }
    if (inString && char === '\n') {
      output += '\\n';
      continue;
    }
    if (inString && char === '\r') {
      continue;
    }
    output += char;
  }

  return output;
}
