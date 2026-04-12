import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkInstructionInsightArtifact,
  buildWorkInstructionRetrievalIntents,
  formatWorkInstructionInsightsForPrompt,
  getWorkInstructionInsightCount,
} from '../wi-insights';
import type { WiChunk } from '../../types';

function makeChunk(input: Partial<WiChunk> & Pick<WiChunk, 'text'>): WiChunk {
  return {
    docId: input.docId ?? 'wi-1',
    filename: input.filename ?? 'Service planning guide.pdf',
    revision: input.revision ?? '1',
    chunkIndex: input.chunkIndex ?? 0,
    sectionLabel: input.sectionLabel,
    sectionKind: input.sectionKind ?? 'paragraph',
    text: input.text,
    tokenCount: input.tokenCount ?? Math.ceil(input.text.length / 4),
    facets: input.facets ?? [],
  };
}

test('buildWorkInstructionInsightArtifact captures sequencing, split rules, and required inputs', () => {
  const artifact = buildWorkInstructionInsightArtifact([
    makeChunk({
      chunkIndex: 0,
      sectionLabel: 'Plan creation',
      sectionKind: 'step',
      text: 'Before a plan is created, the coordinator must confirm service type, location, and required materials.',
      facets: [
        { kind: 'input', value: 'service type' },
        { kind: 'input', value: 'location' },
        { kind: 'actor', value: 'coordinator' },
        { kind: 'rule', value: 'must confirm required inputs' },
      ],
    }),
    makeChunk({
      chunkIndex: 1,
      sectionLabel: 'Sequencing',
      text: 'Activities must be sequenced so prerequisite inspections finish before replacement work can start.',
      facets: [
        { kind: 'sequence', value: 'inspection before replacement' },
        { kind: 'rule', value: 'ordered workflow' },
      ],
    }),
    makeChunk({
      chunkIndex: 2,
      sectionLabel: 'Multiple plans',
      text: 'Use separate plans when dependencies, approvals, or locations differ. A single plan is allowed only when all activities share the same execution path.',
      facets: [
        { kind: 'split_decision', value: 'single vs multiple plans' },
        { kind: 'rule', value: 'separate plans for materially different paths' },
      ],
    }),
  ]);

  assert.ok(artifact.inputs.some((item) => /service type/i.test(item.text)));
  assert.ok(artifact.sequencingRules.some((item) => /sequenced/i.test(item.text)));
  assert.ok(artifact.splitVsSingleCaseRules.some((item) => /separate plans/i.test(item.text)));
  assert.ok(artifact.mustCoverBehaviors.some((item) => /plan is created/i.test(item.text) || /single plan/i.test(item.text)));
  assert.equal(getWorkInstructionInsightCount(artifact) > 0, true);
});

test('buildWorkInstructionRetrievalIntents creates focused operational retrieval queries', () => {
  const intents = buildWorkInstructionRetrievalIntents(
    'create a single plan for service',
    'The workflow is ambiguous because sequencing, approvals, and split-plan rules are missing.',
  );

  assert.equal(intents.length, 5);
  assert.ok(intents.some((intent) => /plan creation prerequisites/i.test(intent)));
  assert.ok(intents.some((intent) => /sequencing dependencies/i.test(intent)));
  assert.ok(intents.some((intent) => /single plan versus multiple/i.test(intent)));
});

test('formatWorkInstructionInsightsForPrompt emits normalized sections for prompt grounding', () => {
  const artifact = buildWorkInstructionInsightArtifact([
    makeChunk({
      chunkIndex: 3,
      sectionLabel: 'Approvals',
      text: 'The plan moves to approved only after the approver accepts the sequencing and confirms required inputs are complete.',
      facets: [
        { kind: 'transition', value: 'moves to approved' },
        { kind: 'actor', value: 'approver' },
        { kind: 'rule', value: 'approval requires complete inputs' },
      ],
    }),
  ]);

  const promptText = formatWorkInstructionInsightsForPrompt(artifact);

  assert.match(promptText, /MUST-COVER BEHAVIORS/i);
  assert.match(promptText, /BUSINESS RULES/i);
  assert.match(promptText, /STATE TRANSITIONS/i);
  assert.match(promptText, /approved/i);
});
