import { compileContext } from './context/compiler';
import { retrieveContextPackForPlan } from './context/retrieval';
import type { V3Generator, V3PipelineInput, V3PipelineResult, V3Planner } from './contracts';
import { HeuristicGenerator } from './generator';
import { HeuristicPlanner } from './planner';
import { validateDraft } from './validator';

export async function runV3Pipeline(
  input: V3PipelineInput,
  generator: V3Generator = new HeuristicGenerator(),
  planner: V3Planner = new HeuristicPlanner(),
): Promise<V3PipelineResult> {
  const cards = compileContext({
    workInstructions: input.workInstructions,
    backlogExamples: input.backlogExamples,
    projectContext: input.projectContext,
    documents: input.documents,
  });
  const capabilityPlan = await planner.plan({
    requirement: input.requirement,
  });
  const contextPack = retrieveContextPackForPlan({
    requirement: input.requirement,
    capabilityPlan,
    cards,
    maxCards: input.maxContextCards ?? 12,
  });
  const draft = await generator.generate({
    requirement: input.requirement,
    capabilityPlan,
    contextPack,
  });
  const issues = validateDraft({
    requirement: input.requirement,
    capabilityPlan,
    draft,
    contextPack,
  });

  return {
    requirement: input.requirement,
    capabilityPlan,
    draft,
    contextPack,
    validation: {
      passed: issues.length === 0,
      issues,
    },
    diagnostics: {
      compiledCards: cards.length,
      contextCardsUsed: contextPack.cards.length,
      estimatedContextTokens: contextPack.estimatedTokens,
      planner: planner.name,
      generator: generator.name,
    },
  };
}
