import type {
  V3BacklogExample,
  V3ContextCard,
  V3ContextCardKind,
  V3ProjectContext,
  V3ProjectDocument,
  V3WorkInstruction,
} from '../contracts';
import { compact, splitSentences, uniqueTokens } from '../text';

function classifyGroundingText(textValue: string): V3ContextCardKind {
  const text = textValue.toLowerCase();
  if (/\b(status|state|stage|workflow status|done|closed|open|in progress|blocked|waiting|pending)\b/.test(text)) {
    return 'status';
  }
  if (/\b(exception|except|fallback|override|fail|reject|not eligible|cannot|must not|missing|unavailable)\b/.test(text)) {
    return 'exception';
  }
  if (/\b(decision|decide|approval|approve|reject|review|sign[- ]?off|gate)\b/.test(text)) {
    return 'decision';
  }
  if (/\b(constraint|limit|threshold|policy|only if|unless|required|required by|must|shall)\b/.test(text)) {
    return 'constraint';
  }
  if (/\b(convention|standard|normally|typically|naming|label|category|classification)\b/.test(text)) {
    return 'project_convention';
  }
  if (/\b(is defined as|means|definition|refers to|known as|represents)\b/.test(text)) {
    return 'definition';
  }
  if (/\b(submit|review|route|notify|handoff|return|complete|close|triage|assign|escalate)\b/.test(text)) {
    return 'workflow_step';
  }
  if (/\b(planner|manager|analyst|approver|requester|coordinator|agent|specialist|admin|owner|lead)\b/.test(text)) {
    return 'role';
  }
  return 'business_object';
}

function classifyWorkInstructionSentence(sentence: string): V3ContextCardKind {
  const text = sentence.toLowerCase();
  if (/\b(exception|except|fallback|override|fail|reject|not eligible|cannot|must not|missing|unavailable)\b/.test(text)) {
    return 'exception';
  }
  if (/\b(must|shall|required|only if|eligib|threshold|rule|policy|approval|approve)\b/.test(text)) {
    return 'business_rule';
  }
  if (/\b(status|state|submit|review|route|notify|handoff|return|complete|close)\b/.test(text)) {
    return 'workflow_step';
  }
  if (/\b(planner|manager|analyst|approver|requester|coordinator|agent|specialist)\b/.test(text)) {
    return 'role';
  }
  return 'business_object';
}

function weightFor(kind: V3ContextCardKind, sourceKind: V3ContextCard['sourceKind']): number {
  if (kind === 'business_rule' || kind === 'exception' || kind === 'constraint' || kind === 'decision') return 1.35;
  if (sourceKind === 'project_context' && (kind === 'definition' || kind === 'status' || kind === 'role')) return 1.25;
  if (sourceKind === 'document') return 1.2;
  if (sourceKind === 'work_instruction') return 1.1;
  return 0.95;
}

function makeCard(input: {
  id: string;
  sourceId: string;
  sourceKind: V3ContextCard['sourceKind'];
  kind: V3ContextCardKind;
  title: string;
  text: string;
  weight: number;
}): V3ContextCard {
  return {
    ...input,
    text: compact(input.text, 420),
    keywords: uniqueTokens(`${input.title} ${input.text}`).slice(0, 18),
  };
}

export function compileWorkInstructions(workInstructions: V3WorkInstruction[]): V3ContextCard[] {
  const cards: V3ContextCard[] = [];
  for (const wi of workInstructions) {
    splitSentences(wi.text).slice(0, 24).forEach((sentence, index) => {
      const kind = classifyWorkInstructionSentence(sentence);
      cards.push(makeCard({
        id: `${wi.id}:wi:${index + 1}`,
        sourceId: wi.id,
        sourceKind: 'work_instruction',
        kind,
        title: wi.title,
        text: sentence,
        weight: kind === 'business_rule' || kind === 'exception' ? 1.35 : 1.1,
      }));
    });
  }
  return cards;
}

export function compileBacklogExamples(backlogExamples: V3BacklogExample[]): V3ContextCard[] {
  const cards: V3ContextCard[] = [];
  for (const example of backlogExamples) {
    cards.push(makeCard({
      id: `${example.key}:story`,
      sourceId: example.key,
      sourceKind: 'backlog_example',
      kind: 'similar_story',
      title: example.summary,
      text: `${example.summary}. ${example.description}`,
      weight: 0.95,
    }));

    example.acceptanceRequirements.slice(0, 8).forEach((ar, index) => {
      cards.push(makeCard({
        id: `${example.key}:ar:${index + 1}`,
        sourceId: example.key,
        sourceKind: 'backlog_example',
        kind: 'gherkin_example',
        title: `${example.key} acceptance pattern`,
        text: `GIVEN ${ar.given} WHEN ${ar.when} THEN ${ar.then}`,
        weight: 0.8,
      }));
    });
  }
  return cards;
}

export function compileProjectContext(projectContext: V3ProjectContext[] = []): V3ContextCard[] {
  return projectContext
    .filter((item) => item.text.trim())
    .map((item, index) => {
      const kind = item.kind ?? classifyGroundingText(`${item.title}. ${item.text}`);
      return makeCard({
        id: `${item.id || `project-context-${index + 1}`}:pc:1`,
        sourceId: item.projectKey ? `${item.projectKey}:${item.id}` : item.id,
        sourceKind: 'project_context',
        kind,
        title: item.projectKey ? `${item.projectKey} ${item.title}` : item.title,
        text: item.text,
        weight: weightFor(kind, 'project_context'),
      });
    });
}

export function compileDocuments(documents: V3ProjectDocument[] = []): V3ContextCard[] {
  return documents
    .filter((item) => item.text.trim())
    .map((item, index) => {
      const kind = item.kind ?? classifyGroundingText(`${item.title}. ${item.section ?? ''}. ${item.text}`);
      const sourceId = item.sourceId ?? item.id;
      return makeCard({
        id: `${item.id || `document-${index + 1}`}:doc:1`,
        sourceId,
        sourceKind: 'document',
        kind,
        title: item.section ? `${item.title} - ${item.section}` : item.title,
        text: item.text,
        weight: weightFor(kind, 'document'),
      });
    });
}

export function compileContext(input: {
  workInstructions: V3WorkInstruction[];
  backlogExamples: V3BacklogExample[];
  projectContext?: V3ProjectContext[];
  documents?: V3ProjectDocument[];
}): V3ContextCard[] {
  return [
    ...compileWorkInstructions(input.workInstructions),
    ...compileProjectContext(input.projectContext),
    ...compileDocuments(input.documents),
    ...compileBacklogExamples(input.backlogExamples),
  ];
}
