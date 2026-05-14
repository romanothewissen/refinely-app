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
                      summary: 'Submit vendor access requests',
                      businessOutcome: 'Vendor access requests can be submitted with required policy checks.',
                      description: 'As a Program Coordinator, I need to submit vendor access requests so that access work follows policy consistently.',
                      acceptanceRequirements: [
                        {
                          id: 'ar_1',
                          given: 'a vendor access request includes policy details',
                          when: 'the Program Coordinator submits it for manager review',
                          then: 'the request follows the documented policy rule',
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
        title: 'Vendor Access Policy',
        text: 'The request must include vendor approval before manager review.',
        keywords: ['vendor', 'approval'],
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
        label: 'Submit vendor access requests',
        businessOutcome: 'Program coordinators can submit vendor access requests with required policy checks.',
        rationale: 'Directly derived from the requirement.',
        requirementEvidence: ['submit vendor access requests'],
        neededEvidence: ['access policy rules'],
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
      requirement: 'Allow program coordinators to submit vendor access requests.',
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
    assert.match(JSON.stringify(requestBody), /Submit vendor access requests/);
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
                      summary: 'Submit vendor access requests',
                      businessOutcome: 'Vendor access requests can be submitted with required policy checks.',
                      description: 'As a Program Coordinator, I need to submit vendor access requests so that access work follows policy consistently.',
                      acceptanceRequirements: [
                        {
                          id: 'ar_1',
                          given: 'a vendor access request includes policy details',
                          when: 'the Program Coordinator submits it for manager review',
                          then: 'the request follows the documented policy rule',
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
        title: 'Vendor Access Policy',
        text: 'The request must include vendor approval before manager review.',
        keywords: ['vendor', 'approval'],
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
        label: 'Submit vendor access requests',
        businessOutcome: 'Program coordinators can submit vendor access requests with required policy checks.',
        rationale: 'Directly derived from the requirement.',
        requirementEvidence: ['submit vendor access requests'],
        neededEvidence: ['access policy rules'],
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
      requirement: 'Allow program coordinators to submit vendor access requests.',
      capabilityPlan,
      contextPack,
    });

    assert.equal(calls, 3);
    assert.equal(draft.features[0]?.summary, 'Submit vendor access requests');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GeminiFlashPlanner returns a capability plan before grounding context is applied', async () => {
  const originalFetch = globalThis.fetch;
  const prompts: string[] = [];
  let calls = 0;

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls += 1;
    const requestBody = JSON.parse(String(init?.body ?? '{}')) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
    prompts.push(requestBody.contents?.[0]?.parts?.[0]?.text ?? '');
    const text = calls === 1
      ? JSON.stringify({
        clarity: 'mixed',
        complexity: 'complex',
        ambiguityLevel: 'medium',
        recommendedFeatureRange: { min: 3, max: 6 },
        decompositionStyle: 'workflow_slices',
        candidateCapabilities: [
          {
            label: 'Assess vendor reviews as a distinct capability',
            splitRationale: 'Vendor review work may have its own logistics and exceptions.',
            mergeRisk: 'Could merge if vendor review is only an optional activity type.',
            confidence: 'medium',
            requirementEvidence: ['vendor reviews'],
          },
        ],
        capabilitiesLikelyMissingIfOmitted: ['Assess vendor reviews as a distinct capability'],
        openQuestions: ['Is vendor review handling a distinct lifecycle?'],
        reasoningSummary: 'Complex but cohesive launch-plan ask with possible vendor review split.',
      })
      : JSON.stringify({
        capabilities: [
          {
            id: 'cap_1',
            label: 'Define a multi-activity coordinated plan',
            businessOutcome: 'Launch work can be planned in one place.',
            rationale: 'The requirement asks for a single plan across several launch activities.',
            requirementEvidence: ['single plan', 'launch activities', 'vendor reviews'],
            neededEvidence: ['workflow rules', 'output rules'],
            acceptanceFocus: ['activity composition', 'downstream actions'],
            provenance: 'requirement',
          },
          {
            id: 'cap_2',
            label: 'Assess vendor reviews as a distinct capability',
            businessOutcome: 'Vendor review needs can be represented without making vendor reviews mandatory.',
            rationale: 'Sizing identified vendor review as a possible split because it may have a lifecycle.',
            requirementEvidence: ['vendor reviews'],
            neededEvidence: ['vendor review lifecycle rules'],
            acceptanceFocus: ['vendor review optionality'],
            provenance: 'requirement',
          },
        ],
        openQuestions: [],
        assumptions: [],
        complexity: 'complex',
      });
    return new Response(JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text }],
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
      requirement: 'Create a single coordinated plan for research tasks, vendor reviews, estimates, and purchase orders.',
    });

    assert.equal(calls, 2);
    assert.equal(plan.complexity, 'complex');
    assert.deepEqual(plan.sizingAssessment?.recommendedFeatureRange, { min: 3, max: 6 });
    assert.match(plan.sizingAssessment?.candidateCapabilities[0]?.label ?? '', /vendor reviews/i);
    assert.equal(plan.capabilities[0]?.provenance, 'requirement');
    assert.match(plan.capabilities[0]?.label ?? '', /multi-activity coordinated plan/i);
    assert.match(plan.capabilities.map((capability) => capability.label).join('\n'), /vendor reviews/i);
    assert.match(prompts[0] ?? '', /lightweight sizing pass/i);
    assert.match(prompts[0] ?? '', /feature count range, not a target quota/i);
    assert.match(prompts[1] ?? '', /before seeing project context/i);
    assert.match(prompts[1] ?? '', /guidance, not a quota/i);
    assert.match(prompts[1] ?? '', /Assess vendor reviews as a distinct capability/i);
    assert.match(prompts[1] ?? '', /Business outcomes must be concrete/i);
    assert.match(prompts[1] ?? '', /reusable discovery lenses/i);
    assert.match(prompts[1] ?? '', /Use domain-native labels/i);
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
      requirement: 'Create a single coordinated plan for research tasks, vendor reviews, estimates, and purchase orders.',
    });

    assert.equal(calls, 6);
    assert.ok(plan.capabilities.length >= 3);
    assert.ok(plan.capabilities.some((capability) => /coordinated plan/i.test(capability.label)));
    assert.equal(plan.capabilities[0]?.provenance, 'requirement');
    assert.ok(plan.sizingAssessment?.candidateCapabilities.length);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
