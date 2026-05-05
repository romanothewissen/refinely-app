import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, extractJsonWithMetadata } from '../json';
import {
  buildLlmAuditMetadata,
  callLlm,
  getRequestedGeminiThinkingLevel,
  getRequestedThinkingBudget,
  isGeminiThreeFamilyModel,
  mapReasoningDepthToEffort,
  openAIRequiresMaxCompletionTokens,
  openAISupportsReasoning,
  resolveEffectiveMaxTokens,
} from '../llm';

test('extractJson parses markdown-fenced JSON objects', () => {
  const parsed = extractJson<{
    discoveryProfile: { scope: string; missingCategoryKeys: string[]; recommendedInitialCount: number; followupCap: number };
    questions: Array<{ categoryKey: string }>;
  }>(`\
\`\`\`json
{
  "discoveryProfile": {
    "scope": "moderate",
    "missingCategoryKeys": ["user_personas"],
    "recommendedInitialCount": 10,
    "followupCap": 4
  },
  "questions": [
    { "categoryKey": "context_trigger" }
  ]
}
\`\`\``);

  assert.equal(parsed.discoveryProfile.scope, 'moderate');
  assert.deepEqual(parsed.discoveryProfile.missingCategoryKeys, ['user_personas']);
  assert.equal(parsed.discoveryProfile.recommendedInitialCount, 10);
  assert.equal(parsed.discoveryProfile.followupCap, 4);
  assert.deepEqual(parsed.questions, [{ categoryKey: 'context_trigger' }]);
});

test('extractJson parses fenced JSON even when the language fence is inline', () => {
  const parsed = extractJson<{ questions: Array<{ categoryKey: string; question: string }> }>(
    '```json { "questions": [{ "categoryKey": "context_trigger", "question": "What exact event should start this workflow?" }] } ```',
  );

  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0]?.categoryKey, 'context_trigger');
});

test('extractJson extracts the first balanced JSON object from surrounding prose', () => {
  const parsed = extractJson<{ ok: boolean; note: string }>(
    'Here is the payload you asked for:\n\n{"ok":true,"note":"contains a brace like this: } inside a string"}\n\nThanks!',
  );

  assert.equal(parsed.ok, true);
  assert.equal(parsed.note, 'contains a brace like this: } inside a string');
});

test('extractJson repairs truncated fenced JSON when the model stops mid-string', () => {
  const parsed = extractJson<{
    features: Array<{ summary: string; description: string }>;
  }>(`\
\`\`\`json
{
  "features": [
    {
      "summary": "Work Order Criticality and Due Date Definition",
      "description": "As FSE Management, I need to define and maintain the business rules for determining a Work Order's criticality (based on priority field, associated SLA, and customer tier/contract
    }
  ]
}
\`\`\``);

  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0]?.summary, 'Work Order Criticality and Due Date Definition');
  assert.match(parsed.features[0]?.description ?? '', /customer tier\/contract$/);
});

test('extractJsonWithMetadata reports clean parses for complete JSON blocks', () => {
  const parsed = extractJsonWithMetadata<{ ok: boolean }>('{"ok":true}');

  assert.equal(parsed.parseMode, 'clean_parse');
  assert.equal(parsed.data.ok, true);
});

test('extractJsonWithMetadata reports repaired parses for truncated JSON blocks', () => {
  const parsed = extractJsonWithMetadata<{ items: Array<{ label: string }> }>(
    '{"items":[{"label":"partial value"}',
  );

  assert.equal(parsed.parseMode, 'repaired_parse');
  assert.equal(parsed.data.items[0]?.label, 'partial value');
});

test('mapReasoningDepthToEffort translates provider-neutral reasoning levels', () => {
  assert.equal(mapReasoningDepthToEffort('light'), 'low');
  assert.equal(mapReasoningDepthToEffort('standard'), 'medium');
  assert.equal(mapReasoningDepthToEffort('deep'), 'high');
});

test('getRequestedThinkingBudget returns provider-specific budgets only when supported', () => {
  assert.equal(getRequestedThinkingBudget('gemini', 'gemini-3-flash-preview', 'high'), undefined);
  assert.equal(getRequestedThinkingBudget('gemini', 'gemini-2.5-flash', 'high'), 16384);
  assert.equal(getRequestedThinkingBudget('gemini', 'gemini-1.5-flash', 'high'), undefined);
  assert.equal(getRequestedThinkingBudget('anthropic', 'claude-sonnet-4-0', 'medium'), 8192);
  assert.equal(getRequestedThinkingBudget('openai', 'gpt-4o', 'high'), undefined);
});

test('Gemini 3 models map reasoning effort to thinking levels', () => {
  assert.equal(isGeminiThreeFamilyModel('gemini-3-flash-preview'), true);
  assert.equal(isGeminiThreeFamilyModel('gemini-2.5-flash'), false);
  assert.equal(getRequestedGeminiThinkingLevel('gemini-3-flash-preview', 'none'), 'minimal');
  assert.equal(getRequestedGeminiThinkingLevel('gemini-3-flash-preview', 'low'), 'low');
  assert.equal(getRequestedGeminiThinkingLevel('gemini-3-flash-preview', 'medium'), 'medium');
  assert.equal(getRequestedGeminiThinkingLevel('gemini-3.1-pro-preview', 'none'), 'low');
});

test('OpenAI GPT-5 models use reasoning controls and max_completion_tokens', () => {
  assert.equal(openAISupportsReasoning('gpt-5.4'), true);
  assert.equal(openAISupportsReasoning('gpt-5.4-mini'), true);
  assert.equal(openAIRequiresMaxCompletionTokens('gpt-5.4'), true);
  assert.equal(openAIRequiresMaxCompletionTokens('gpt-5.4-mini'), true);
});

test('legacy OpenAI chat models still avoid reasoning controls and max_completion_tokens', () => {
  assert.equal(openAISupportsReasoning('gpt-4o'), false);
  assert.equal(openAISupportsReasoning('gpt-4.1'), false);
  assert.equal(openAIRequiresMaxCompletionTokens('gpt-4o'), false);
  assert.equal(openAIRequiresMaxCompletionTokens('gpt-4.1'), false);
});

test('buildLlmAuditMetadata captures requested/resolved models and reasoning telemetry', () => {
  const meta = buildLlmAuditMetadata({
    requestedModel: 'latest-pro',
    resolvedModel: 'gemini-3-flash-preview',
    provider: 'gemini',
    maxTokens: 16384,
    reasoningEffort: 'high',
    thoughtTokens: 1200,
  });

  assert.equal(meta.model, 'gemini-3-flash-preview');
  assert.equal(meta.requestedModel, 'latest-pro');
  assert.equal(meta.resolvedModel, 'gemini-3-flash-preview');
  assert.equal(meta.maxTokens, 16384);
  assert.equal(meta.reasoningEffort, 'high');
  assert.equal(meta.thinkingBudget, undefined);
  assert.equal(meta.thinkingLevel, 'high');
  assert.equal(meta.thoughtTokens, 1200);
});

test('Gemini 3 requests send documented thinkingLevel values instead of thinkingBudget', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7, thoughtsTokenCount: 3 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await callLlm({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Return JSON.',
      userMessage: 'Respond with {"ok":true}.',
      reasoningEffort: 'medium',
      geminiApiKey: 'test-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const generationConfig = requestBody?.generationConfig as Record<string, unknown> | undefined;
  const thinkingConfig = generationConfig?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, 'medium');
  assert.equal('thinkingBudget' in (thinkingConfig ?? {}), false);
  assert.equal('reasoningControlMode' in (thinkingConfig ?? {}), false);
});

test('Gemini 3 requests can force high thinking for strict generation stages', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 5, thoughtsTokenCount: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await callLlm({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Return JSON.',
      userMessage: 'Respond with {"ok":true}.',
      reasoningEffort: 'medium',
      geminiThinkingLevel: 'high',
      geminiApiKey: 'test-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const generationConfig = requestBody?.generationConfig as Record<string, unknown> | undefined;
  const thinkingConfig = generationConfig?.thinkingConfig as Record<string, unknown> | undefined;
  assert.equal(thinkingConfig?.thinkingLevel, 'high');
});

test('Gemini retries without provider-side schema enforcement when the schema is too complex', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: 'The specified schema produces a constraint that has too many states for serving.',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true,"items":["a","b"]}' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await callLlm({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Return JSON only.',
      userMessage: 'Respond with valid JSON.',
      geminiApiKey: 'test-key',
      jsonSchema: {
        type: 'object',
        required: ['ok', 'items'],
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          items: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: { type: 'string', minLength: 1, maxLength: 10 },
          },
        },
      },
    });

    assert.equal(response.text, '{"ok":true,"items":["a","b"]}');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 2);
  const firstGenerationConfig = requestBodies[0]?.generationConfig as Record<string, unknown> | undefined;
  const secondGenerationConfig = requestBodies[1]?.generationConfig as Record<string, unknown> | undefined;
  assert.equal(Boolean(firstGenerationConfig?.responseJsonSchema), true);
  assert.equal('responseJsonSchema' in (secondGenerationConfig ?? {}), false);
  const secondContents = requestBodies[1]?.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined;
  assert.match(secondContents?.[0]?.parts?.[0]?.text ?? '', /respond with valid json only/i);
});

test('Gemini retries without provider-side schema enforcement after invalid argument', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length === 1) {
      return new Response(JSON.stringify({
        error: {
          message: 'Request contains an invalid argument.',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await callLlm({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Return JSON only.',
      userMessage: 'Respond with valid JSON.',
      geminiApiKey: 'test-key',
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
        },
      },
    });

    assert.equal(response.text, '{"ok":true}');
    assert.deepEqual(response.geminiFallbacks, ['removed_provider_schema_after_invalid_argument']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 2);
  const secondGenerationConfig = requestBodies[1]?.generationConfig as Record<string, unknown> | undefined;
  assert.equal('responseJsonSchema' in (secondGenerationConfig ?? {}), false);
});

test('Gemini retries without thinking config after repeated invalid argument', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requestBodies.push(body);

    if (requestBodies.length < 3) {
      return new Response(JSON.stringify({
        error: {
          message: 'Request contains an invalid argument.',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const response = await callLlm({
      provider: 'gemini',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Return JSON only.',
      userMessage: 'Respond with valid JSON.',
      geminiApiKey: 'test-key',
      reasoningEffort: 'medium',
      jsonSchema: {
        type: 'object',
        required: ['ok'],
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
        },
      },
    });

    assert.equal(response.text, '{"ok":true}');
    assert.deepEqual(response.geminiFallbacks, [
      'removed_provider_schema_after_invalid_argument',
      'removed_thinking_config_after_invalid_argument',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 3);
  const secondGenerationConfig = requestBodies[1]?.generationConfig as Record<string, unknown> | undefined;
  const thirdGenerationConfig = requestBodies[2]?.generationConfig as Record<string, unknown> | undefined;
  assert.equal(Boolean(secondGenerationConfig?.thinkingConfig), true);
  assert.equal(Boolean(thirdGenerationConfig?.thinkingConfig), false);
});

test('resolveEffectiveMaxTokens clamps Fireworks max_tokens requests to the non-streaming limit', () => {
  assert.equal(resolveEffectiveMaxTokens({
    provider: 'fireworks',
    model: 'accounts/fireworks/models/deepseek-v3p2',
    systemPrompt: 'Return JSON',
    userMessage: 'Test',
    maxTokens: 131072,
  }, {
    structuredOutputMode: 'json_schema',
    reasoningControlMode: 'reasoning_effort',
    reasoningVisibility: 'separate_field',
    tokenLimitParam: 'max_tokens',
    maxOutputTokens: 131072,
  }), 4096);
});

test('resolveEffectiveMaxTokens respects explicit Gemini stage caps', () => {
  assert.equal(resolveEffectiveMaxTokens({
    provider: 'gemini',
    model: 'gemini-3-flash-preview',
    systemPrompt: 'Return JSON',
    userMessage: 'Test',
    maxTokens: 1600,
  }, {
    structuredOutputMode: 'json_schema',
    reasoningControlMode: 'thinking_level',
    reasoningVisibility: 'hidden',
    tokenLimitParam: 'maxOutputTokens',
    maxOutputTokens: 65536,
  }), 1600);
});

test('Groq reasoning requests collapse internal effort levels to default', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await callLlm({
      provider: 'groq',
      model: 'deepseek-r1-distill-llama-70b',
      systemPrompt: 'You are helpful.',
      userMessage: 'Solve this carefully.',
      reasoningEffort: 'high',
      groqApiKey: 'test-key',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.reasoning_effort, 'default');
  assert.equal(requestBody?.reasoning_format, 'hidden');
});
