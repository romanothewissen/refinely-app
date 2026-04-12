import {
  WiChunk,
  WorkInstructionInsightArtifact,
  WorkInstructionInsightItem,
  WorkInstructionSourceSpan,
} from '../types';

function chunkSpan(chunk: WiChunk): WorkInstructionSourceSpan {
  return {
    docId: chunk.docId,
    filename: chunk.filename,
    chunkIndex: chunk.chunkIndex,
    ...(chunk.sectionLabel ? { sectionLabel: chunk.sectionLabel } : {}),
  };
}

function pushInsight(
  target: WorkInstructionInsightItem[],
  seen: Set<string>,
  text: string,
  spans: WorkInstructionSourceSpan[],
) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  target.push({ text: normalized, sourceSpans: spans });
}

function normalizeSentence(sentence: string): string {
  return sentence
    .replace(/\s+/g, ' ')
    .replace(/^[-*•]\s*/, '')
    .trim();
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map(normalizeSentence)
    .filter((sentence) => sentence.length >= 18);
}

function sectionOrSentence(chunk: WiChunk): string[] {
  const sentences = splitSentences(chunk.text);
  if (sentences.length) return sentences.slice(0, 4);
  return [normalizeSentence(chunk.text)].filter(Boolean);
}

function matches(text: string, pattern: RegExp): boolean {
  return pattern.test(text);
}

export function buildWorkInstructionInsightArtifact(chunks: WiChunk[]): WorkInstructionInsightArtifact {
  const artifact: WorkInstructionInsightArtifact = {
    resolvedFacts: [],
    workflowSteps: [],
    actors: [],
    inputs: [],
    outputs: [],
    businessRules: [],
    stateTransitions: [],
    exceptions: [],
    sequencingRules: [],
    splitVsSingleCaseRules: [],
    mustCoverBehaviors: [],
    sourceSpans: [],
  };
  const seenByBucket = new Map<keyof WorkInstructionInsightArtifact, Set<string>>();
  const buckets: Array<keyof WorkInstructionInsightArtifact> = [
    'resolvedFacts',
    'workflowSteps',
    'actors',
    'inputs',
    'outputs',
    'businessRules',
    'stateTransitions',
    'exceptions',
    'sequencingRules',
    'splitVsSingleCaseRules',
    'mustCoverBehaviors',
  ];
  buckets.forEach((bucket) => seenByBucket.set(bucket, new Set<string>()));

  const allSpans = new Map<string, WorkInstructionSourceSpan>();
  for (const chunk of chunks) {
    const span = chunkSpan(chunk);
    allSpans.set(`${span.docId}:${span.chunkIndex}`, span);
    const label = (chunk.sectionLabel ?? '').toLowerCase();
    const texts = sectionOrSentence(chunk);
    const facets = chunk.facets ?? [];

    if (chunk.sectionKind === 'step' || label.includes('step') || label.includes('process')) {
      texts.forEach((text) => pushInsight(artifact.workflowSteps, seenByBucket.get('workflowSteps')!, text, [span]));
    }

    texts.forEach((text) => {
      pushInsight(artifact.resolvedFacts, seenByBucket.get('resolvedFacts')!, text, [span]);

      if (facets.some((facet) => facet.kind === 'actor') || matches(text, /\bplanner|specialist|coordinator|technician|manager|approver|user\b/i)) {
        pushInsight(artifact.actors, seenByBucket.get('actors')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'input') || matches(text, /\brequired\b|\bmust include\b|\bcapture\b|\benter\b|\bselect\b|\binput\b/i)) {
        pushInsight(artifact.inputs, seenByBucket.get('inputs')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'output') || matches(text, /\bgenerate\b|\bcreate\b|\bresult\b|\boutput\b|\bquote\b|\border\b|\bshipment\b|\bwork order\b/i)) {
        pushInsight(artifact.outputs, seenByBucket.get('outputs')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'rule') || matches(text, /\bmust\b|\bonly\b|\bcannot\b|\bshould not\b|\brequired\b/i)) {
        pushInsight(artifact.businessRules, seenByBucket.get('businessRules')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'transition') || matches(text, /\bstatus\b|\bstate\b|\bmove to\b|\badvance\b|\bapproved\b|\bfinalized\b|\bcompleted\b/i)) {
        pushInsight(artifact.stateTransitions, seenByBucket.get('stateTransitions')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'exception') || matches(text, /\bexception\b|\bmissing\b|\berror\b|\bmanual review\b|\bfallback\b|\bambiguous\b/i)) {
        pushInsight(artifact.exceptions, seenByBucket.get('exceptions')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'sequence') || matches(text, /\bsequence\b|\border\b|\bdependency\b|\bbefore\b|\bafter\b|\bpredecessor\b|\bsuccessor\b/i)) {
        pushInsight(artifact.sequencingRules, seenByBucket.get('sequencingRules')!, text, [span]);
      }
      if (facets.some((facet) => facet.kind === 'split_decision') || matches(text, /\bmultiple plans\b|\bnew plan\b|\bseparate plan\b|\bsingle plan\b|\bsplit\b/i)) {
        pushInsight(artifact.splitVsSingleCaseRules, seenByBucket.get('splitVsSingleCaseRules')!, text, [span]);
      }

      if (
        matches(text, /\bcreate\b|\bplan\b|\bquote\b|\bsequence\b|\border\b|\bshipment\b|\bwork order\b|\bapprove\b|\bexception\b/i)
        || label.includes('plan')
        || label.includes('sequence')
      ) {
        pushInsight(artifact.mustCoverBehaviors, seenByBucket.get('mustCoverBehaviors')!, text, [span]);
      }
    });
  }

  artifact.sourceSpans = [...allSpans.values()];
  return artifact;
}

export function mergeWorkInstructionInsightArtifacts(
  left: WorkInstructionInsightArtifact | null | undefined,
  right: WorkInstructionInsightArtifact | null | undefined,
): WorkInstructionInsightArtifact | null {
  if (!left && !right) return null;
  if (!left) return right ?? null;
  if (!right) return left;
  return buildWorkInstructionInsightArtifact([
    ...artifactToSyntheticChunks(left),
    ...artifactToSyntheticChunks(right),
  ]);
}

function artifactToSyntheticChunks(artifact: WorkInstructionInsightArtifact): WiChunk[] {
  const items = artifact.mustCoverBehaviors.length ? artifact.mustCoverBehaviors : artifact.resolvedFacts;
  return items.map((item, index) => ({
    docId: item.sourceSpans[0]?.docId ?? `artifact-${index}`,
    filename: item.sourceSpans[0]?.filename ?? 'Derived insight',
    revision: '',
    chunkIndex: item.sourceSpans[0]?.chunkIndex ?? index,
    sectionLabel: item.sourceSpans[0]?.sectionLabel,
    sectionKind: 'paragraph',
    text: item.text,
    tokenCount: Math.ceil(item.text.length / 4),
  }));
}

export function getWorkInstructionInsightCount(artifact: WorkInstructionInsightArtifact | null | undefined): number {
  if (!artifact) return 0;
  return artifact.mustCoverBehaviors.length
    + artifact.businessRules.length
    + artifact.sequencingRules.length
    + artifact.splitVsSingleCaseRules.length;
}

export function buildWorkInstructionRetrievalIntents(requirement: string, advisoryReasoning?: string): string[] {
  const base = requirement.replace(/\s+/g, ' ').trim();
  const intents = [
    `${base} plan creation prerequisites and required inputs`,
    `${base} activities managed through the plan and what belongs in scope`,
    `${base} sequencing dependencies and ordered workflow steps`,
    `${base} when to use a single plan versus multiple or separate plans`,
    `${base} approvals statuses revisions and downstream actions`,
  ];
  if (advisoryReasoning?.trim()) {
    intents.push(`${base} ${advisoryReasoning.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
  }
  return [...new Set(intents.map((intent) => intent.trim()).filter(Boolean))].slice(0, 5);
}

export function formatWorkInstructionInsightsForPrompt(
  artifact: WorkInstructionInsightArtifact | null | undefined,
  maxItemsPerSection = 4,
): string {
  if (!artifact) return '';
  const sections: Array<[string, WorkInstructionInsightItem[]]> = [
    ['MUST-COVER BEHAVIORS', artifact.mustCoverBehaviors],
    ['WORKFLOW STEPS', artifact.workflowSteps],
    ['BUSINESS RULES', artifact.businessRules],
    ['SEQUENCING RULES', artifact.sequencingRules],
    ['SINGLE VS MULTIPLE PLAN RULES', artifact.splitVsSingleCaseRules],
    ['STATE TRANSITIONS', artifact.stateTransitions],
    ['EXCEPTIONS', artifact.exceptions],
  ];
  return sections
    .filter(([, items]) => items.length > 0)
    .map(([title, items]) => `${title}:\n${items.slice(0, maxItemsPerSection).map((item, index) => `${index + 1}. ${item.text}`).join('\n')}`)
    .join('\n\n');
}
