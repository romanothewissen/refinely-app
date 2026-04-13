import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson } from '../json';
import { mapReasoningDepthToEffort } from '../llm';

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

test('mapReasoningDepthToEffort translates provider-neutral reasoning levels', () => {
  assert.equal(mapReasoningDepthToEffort('light'), 'low');
  assert.equal(mapReasoningDepthToEffort('standard'), 'medium');
  assert.equal(mapReasoningDepthToEffort('deep'), 'high');
});
