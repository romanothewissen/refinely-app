import type { ClarifyAnswer, TenantConfig } from '../types';
import type { PipelineAuditMergePatch } from './pipeline-audit-store';
import type {
  V2ClassifiedAnswer,
  V2DiscoveryAnswer,
  V2PipelineCompleteResult,
  V2PipelineDiscoveryFailedResult,
  V2PipelineNeedsDiscoveryResult,
  V2PipelineResult,
} from '../v2/types';

function toClarifyAnswers(
  answers: Array<Partial<V2DiscoveryAnswer> & { question?: unknown; answer?: unknown; categoryKey?: unknown; selectedSuggestion?: unknown }>,
): ClarifyAnswer[] {
  return answers
    .map((answer) => ({
      question: String(answer.question ?? '').trim(),
      answer: String(answer.answer ?? '').trim(),
      selectedSuggestions: answer.selectedSuggestion ? [String(answer.selectedSuggestion)] : [],
      customAnswer: String(answer.answer ?? '').trim(),
      categoryKey: typeof answer.categoryKey === 'string' ? answer.categoryKey as ClarifyAnswer['categoryKey'] : undefined,
      intent: typeof answer.categoryKey === 'string' ? answer.categoryKey : undefined,
    }))
    .filter((answer) => answer.question && answer.answer);
}

function classifiedAnswersToClarifyAnswers(answers: V2ClassifiedAnswer[]): ClarifyAnswer[] {
  return answers.map((answer) => ({
    question: answer.question,
    answer: answer.answer,
    selectedSuggestions: answer.selectedSuggestion ? [answer.selectedSuggestion] : [],
    customAnswer: answer.answer,
    categoryKey: answer.categoryKey as ClarifyAnswer['categoryKey'],
    intent: answer.categoryKey,
  }));
}

export function buildV2AuditBasePatch(input: {
  accountId: string;
  projectKey: string;
  projectKeys: string[];
  config: TenantConfig;
  requirement: string;
  attachmentText?: string;
}): Pick<PipelineAuditMergePatch, 'accountId' | 'mergeHeader' | 'userInputs'> {
  const piiMaskingEnabled = Boolean(input.config.compliance?.enabled && input.config.compliance?.piiMaskingEnabled);
  return {
    accountId: input.accountId,
    mergeHeader: {
      primaryProjectKey: input.projectKey === '*' ? undefined : input.projectKey,
      projectKeys: input.projectKeys,
      piiMaskingEnabled,
      generatorModels: {
        pipelineProfile: input.config.generatorConfig.pipelineProfile,
        requestedPipelineProfile: input.config.generatorConfig.pipelineProfile,
        resolvedPipelineProfile: input.config.generatorConfig.pipelineProfile,
        triageModel: input.config.generatorConfig.triageModel,
        clarifyModel: input.config.generatorConfig.clarifyModel,
        decompositionModel: input.config.generatorConfig.decompositionModel,
        arModel: input.config.generatorConfig.arModel,
      },
    },
    userInputs: {
      requirement: input.requirement,
      attachmentText: input.attachmentText ?? '',
    },
  };
}

export function buildV2AuditResultPatch(input: {
  result: V2PipelineResult;
  discoveryAnswers?: V2DiscoveryAnswer[];
}): Partial<Pick<PipelineAuditMergePatch, 'clarify' | 'generation' | 'completePhase'>> {
  if (input.result.status === 'needs_discovery') {
    const discoveryResult = input.result as V2PipelineNeedsDiscoveryResult;
    return {
      clarify: {
        questions: discoveryResult.discoveryQuestions.map((question) => ({
          categoryKey: question.categoryKey as any,
          category: question.categoryKey,
          intent: question.categoryKey,
          question: question.question,
          details: question.rationale,
          suggestions: question.suggestions,
        })),
        completedAt: new Date().toISOString(),
      },
      completePhase: 'clarify',
    };
  }

  if (input.result.status === 'discovery_generation_failed') {
    const failureResult = input.result as V2PipelineDiscoveryFailedResult;
    return {
      clarify: {
        failure: {
          code: failureResult.failureCode,
          message: failureResult.message,
          retryable: failureResult.retryable,
          stage: failureResult.diagnostics?.stage ?? 'discover',
          failureType: failureResult.diagnostics?.failureType ?? 'json_shape',
          validationError: failureResult.diagnostics?.validationError,
          responseShape: failureResult.diagnostics?.responseShape,
          appearsTruncated: failureResult.diagnostics?.appearsTruncated,
          appearsWrongStageEnvelope: failureResult.diagnostics?.appearsWrongStageEnvelope,
        },
        completedAt: new Date().toISOString(),
      },
      completePhase: 'clarify',
    };
  }

  if (input.result.status === 'complete') {
    const completeResult = input.result as V2PipelineCompleteResult;
    const answers = input.discoveryAnswers?.length
      ? toClarifyAnswers(input.discoveryAnswers)
      : classifiedAnswersToClarifyAnswers(completeResult.classifiedAnswers ?? []);
    return {
      generation: {
        clarifyAnswers: answers,
        features: completeResult.features,
        completedAt: new Date().toISOString(),
      },
      completePhase: 'generation',
    };
  }

  return {};
}
