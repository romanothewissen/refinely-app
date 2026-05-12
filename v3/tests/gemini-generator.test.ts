import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiJsonGenerator } from '../src/generator';
import { GeminiFlashPlanner } from '../src/planner';
import type { V3CapabilityPlan, V3ContextPack } from '../src/contracts';

test('GeminiJsonGenerator sends compact grounding context and parses structured JSON', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  features: [
                    {
                      id: 'feature_1',
                      summary: 'Submit urgent loaner requests',
                      businessOutcome: 'Urgent loaner requests can be submitted with eligibility checks.',
                      description: 'As a Service Planner, I need to submit urgent loaner requests so that customers receive temporary equipment consistently.',
                      acceptanceRequirements: [
                        {
                          id: 'ar_1',
                          given: 'a loaner request includes eligibility details',
                          when: 'the Service Planner submits it for manager review',
                          then: 'the request follows the documented eligibility rule',
                          provenance: 'work_instruction',
                          evidenceRefs: [{ cardId: 'WI-1:wi:1', sourceId: 'WI-1', reason: 'Work instruction rule' }],
                        },
                      ],
                      provenance: 'requirement',
                      evidenceRefs: [{ cardId: 'WI-1:wi:1', sourceId: 'WI-1', reason: 'Work instruction rule' }],
                      assumptions: [],
                      openQuestions: [],
                    },
                  ],
                  confidence: 'high',
                  blockingQuestions: [],
                }),
              },
            ],
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const contextPack: V3ContextPack = {
    cards: [
      {
        id: 'WI-1:wi:1',
        sourceId: 'WI-1',
        sourceKind: 'work_instruction',
        kind: 'business_rule',
        title: 'Loaner Request Handling',
        text: 'The request must include customer eligibility before manager review.',
        keywords: ['loaner', 'eligibility'],
        weight: 1,
        score: 1,
      },
    ],
    estimatedTokens: 20,
    sourceMix: { workInstructionCards: 1, backlogCards: 0 },
  };
  const capabilityPlan: V3CapabilityPlan = {
    capabilities: [
      {
        id: 'cap_1',
        label: 'Submit urgent loaner requests',
        businessOutcome: 'Service planners can submit urgent loaner requests with eligibility checks.',
        rationale: 'Directly derived from the requirement.',
        requirementEvidence: ['submit urgent loaner requests'],
        neededEvidence: ['loaner eligibility rules'],
        acceptanceFocus: ['primary submission', 'manager review'],
        provenance: 'requirement',
      },
    ],
    openQuestions: [],
    assumptions: [],
    complexity: 'simple',
  };

  try {
    const draft = await new GeminiJsonGenerator({ apiKey: 'test-key' }).generate({
      requirement: 'Allow service planners to submit urgent loaner requests.',
      capabilityPlan,
      contextPack,
    });

    assert.equal(draft.confidence, 'medium');
    assert.equal(draft.features[0]?.evidenceRefs[0]?.cardId, 'WI-1:wi:1');
    const generationConfig = requestBody?.generationConfig as Record<string, unknown>;
    assert.equal(generationConfig.responseMimeType, 'application/json');
    assert.equal(generationConfig.maxOutputTokens, 12288);
    assert.deepEqual(generationConfig.thinkingConfig, { thinkingBudget: 2048 });
    assert.match(JSON.stringify(requestBody), /WI-1:wi:1/);
    assert.match(JSON.stringify(requestBody), /Submit urgent loaner requests/);
    assert.match(JSON.stringify(requestBody), /Do not hide the required capability in WHEN/);
    assert.match(JSON.stringify(requestBody), /actor-neutral/);
    assert.match(JSON.stringify(requestBody), /Do not promote adjacent workflow details/);
    assert.match(JSON.stringify(requestBody), /REPAIR INSTRUCTION/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiJsonGenerator retries when Gemini returns malformed JSON', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    const prompt = requestBody.contents?.[0]?.parts?.[0]?.text ?? '';

    if (calls === 1) {
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"features":[{"id":"feature_1","summary":"Broken' }] } }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    assert.match(prompt, /RETRY INSTRUCTION/);
    return new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  features: [
                    {
                      id: 'feature_1',
                      summary: 'Submit urgent loaner requests',
                      businessOutcome: 'Urgent loaner requests can be submitted with eligibility checks.',
                      description: 'As a Service Planner, I need to submit urgent loaner requests so that customers receive temporary equipment consistently.',
                      acceptanceRequirements: [
                        {
                          id: 'ar_1',
                          given: 'a loaner request includes eligibility details',
                          when: 'the Service Planner submits it for manager review',
                          then: 'the request follows the documented eligibility rule',
                          provenance: 'work_instruction',
                          evidenceRefs: [{ cardId: 'WI-1:wi:1', sourceId: 'WI-1', reason: 'Work instruction rule' }],
                        },
                      ],
                      provenance: 'requirement',
                      evidenceRefs: [{ cardId: 'WI-1:wi:1', sourceId: 'WI-1', reason: 'Work instruction rule' }],
                      assumptions: [],
                      openQuestions: [],
                    },
                  ],
                  confidence: 'high',
                  blockingQuestions: [],
                }),
              },
            ],
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const contextPack: V3ContextPack = {
    cards: [
      {
        id: 'WI-1:wi:1',
        sourceId: 'WI-1',
        sourceKind: 'work_instruction',
        kind: 'business_rule',
        title: 'Loaner Request Handling',
        text: 'The request must include customer eligibility before manager review.',
        keywords: ['loaner', 'eligibility'],
        weight: 1,
        score: 1,
      },
    ],
    estimatedTokens: 20,
    sourceMix: { workInstructionCards: 1, backlogCards: 0 },
  };
  const capabilityPlan: V3CapabilityPlan = {
    capabilities: [
      {
        id: 'cap_1',
        label: 'Submit urgent loaner requests',
        businessOutcome: 'Service planners can submit urgent loaner requests with eligibility checks.',
        rationale: 'Directly derived from the requirement.',
        requirementEvidence: ['submit urgent loaner requests'],
        neededEvidence: ['loaner eligibility rules'],
        acceptanceFocus: ['primary submission', 'manager review'],
        provenance: 'requirement',
      },
    ],
    openQuestions: [],
    assumptions: [],
    complexity: 'simple',
  };

  try {
    const draft = await new GeminiJsonGenerator({ apiKey: 'test-key' }).generate({
      requirement: 'Allow service planners to submit urgent loaner requests.',
      capabilityPlan,
      contextPack,
    });

    assert.equal(calls, 3);
    assert.equal(draft.features[0]?.summary, 'Submit urgent loaner requests');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiFlashPlanner returns a capability plan before grounding context is applied', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  capabilities: [
                    {
                      id: 'cap_1',
                      label: 'Define a multi-activity service plan',
                      businessOutcome: 'Complex service work can be planned in one place.',
                      rationale: 'The requirement asks for a single plan across several service activities.',
                      requirementEvidence: ['single plan', 'field service activities', 'loaners'],
                      neededEvidence: ['workflow rules', 'quote rules'],
                      acceptanceFocus: ['activity composition', 'downstream actions'],
                      provenance: 'requirement',
                    },
                  ],
                  openQuestions: [],
                  assumptions: [],
                  complexity: 'complex',
                }),
              },
            ],
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const plan = await new GeminiFlashPlanner({ apiKey: 'test-key' }).plan({
      requirement: 'Create a single service plan for field service, loaners, quotes, and work orders.',
    });

    assert.equal(plan.complexity, 'complex');
    assert.equal(plan.capabilities[0]?.provenance, 'requirement');
    assert.match(plan.capabilities[0]?.label ?? '', /multi-activity service plan/i);
    assert.match(JSON.stringify(requestBody), /before seeing project context/i);
    assert.match(JSON.stringify(requestBody), /Business outcomes must be concrete/i);
    assert.match(JSON.stringify(requestBody), /reusable discovery lenses/i);
    assert.match(JSON.stringify(requestBody), /Use domain-native labels/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiFlashPlanner falls back locally when Flash planner JSON remains malformed', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async (): Promise<Response> => {
    calls += 1;
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"capabilities":[{"id":"cap_1","label":"Broken planner' }] } }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const plan = await new GeminiFlashPlanner({ apiKey: 'test-key' }).plan({
      requirement: 'Create a single service plan for field service, loaners, quotes, and work orders.',
    });

    assert.equal(calls, 3);
    assert.ok(plan.capabilities.length >= 3);
    assert.ok(plan.capabilities.some((capability) => /service plan/i.test(capability.label)));
    assert.equal(plan.capabilities[0]?.provenance, 'requirement');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
