import type { V3CapabilityPlan, V3ContextCard, V3ContextPack, V3RetrievedContextCard } from '../contracts';
import { estimateTokens, overlapScore } from '../text';

const KIND_BONUS: Record<V3ContextCard['kind'], number> = {
  business_rule: 0.28,
  exception: 0.24,
  decision: 0.24,
  constraint: 0.24,
  workflow_step: 0.18,
  definition: 0.2,
  status: 0.18,
  project_convention: 0.16,
  role: 0.14,
  business_object: 0.1,
  similar_story: 0.16,
  gherkin_example: 0.1,
};

export function retrieveContextPack(input: {
  requirement: string;
  cards: V3ContextCard[];
  maxCards?: number;
}): V3ContextPack {
  const maxCards = input.maxCards ?? 8;
  const scored = input.cards
    .map((card): V3RetrievedContextCard => ({
      ...card,
      score: overlapScore(input.requirement, `${card.title} ${card.text} ${card.keywords.join(' ')}`, card.weight)
        + KIND_BONUS[card.kind],
    }))
    .filter((card) => card.score > 0.08)
    .sort((left, right) => right.score - left.score);

  const selected = ensureSourceMix(scored, maxCards);
  const estimatedTokens = estimateTokens(selected.map((card) => `${card.kind}: ${card.text}`).join('\n'));

  return {
    cards: selected,
    estimatedTokens,
    sourceMix: {
      workInstructionCards: selected.filter((card) => card.sourceKind === 'work_instruction').length,
      backlogCards: selected.filter((card) => card.sourceKind === 'backlog_example').length,
      projectContextCards: selected.filter((card) => card.sourceKind === 'project_context').length,
      documentCards: selected.filter((card) => card.sourceKind === 'document').length,
    },
  };
}

export function retrieveContextPackForPlan(input: {
  requirement: string;
  capabilityPlan: V3CapabilityPlan;
  cards: V3ContextCard[];
  maxCards?: number;
}): V3ContextPack {
  const maxCards = input.maxCards ?? 12;
  const scoredByCapability = input.capabilityPlan.capabilities.flatMap((capability) => {
    const query = [
      input.requirement,
      capability.label,
      capability.businessOutcome,
      capability.neededEvidence.join(' '),
      capability.acceptanceFocus.join(' '),
    ].join(' ');
    return input.cards.map((card): V3RetrievedContextCard => ({
      ...card,
      score: overlapScore(query, `${card.title} ${card.text} ${card.keywords.join(' ')}`, card.weight)
        + KIND_BONUS[card.kind],
    }));
  });

  const merged = new Map<string, V3RetrievedContextCard>();
  for (const card of scoredByCapability) {
    if (card.score <= 0.08) continue;
    const existing = merged.get(card.id);
    if (!existing || card.score > existing.score) merged.set(card.id, card);
  }

  const ranked = Array.from(merged.values()).sort((left, right) => right.score - left.score);
  const selected = ensureSourceMix(ranked, maxCards);
  const estimatedTokens = estimateTokens(selected.map((card) => `${card.kind}: ${card.text}`).join('\n'));

  return {
    cards: selected,
    estimatedTokens,
    sourceMix: {
      workInstructionCards: selected.filter((card) => card.sourceKind === 'work_instruction').length,
      backlogCards: selected.filter((card) => card.sourceKind === 'backlog_example').length,
      projectContextCards: selected.filter((card) => card.sourceKind === 'project_context').length,
      documentCards: selected.filter((card) => card.sourceKind === 'document').length,
    },
  };
}

function ensureSourceMix(cards: V3RetrievedContextCard[], maxCards: number): V3RetrievedContextCard[] {
  const selected: V3RetrievedContextCard[] = [];
  const add = (card: V3RetrievedContextCard | undefined) => {
    if (!card || selected.some((existing) => existing.id === card.id) || selected.length >= maxCards) return;
    selected.push(card);
  };

  add(cards.find((card) => card.sourceKind === 'work_instruction' && card.kind === 'business_rule'));
  add(cards.find((card) => card.sourceKind === 'work_instruction' && card.kind === 'exception'));
  add(cards.find((card) => card.sourceKind === 'project_context' && (card.kind === 'definition' || card.kind === 'status' || card.kind === 'role')));
  add(cards.find((card) => card.sourceKind === 'document' && (card.kind === 'business_rule' || card.kind === 'constraint' || card.kind === 'decision' || card.kind === 'definition')));
  add(cards.find((card) => card.sourceKind === 'backlog_example' && card.kind === 'similar_story'));

  for (const card of cards) add(card);
  return selected.slice(0, maxCards);
}
