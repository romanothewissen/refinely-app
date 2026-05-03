import type { V2CrudRisk, V2TriageResult } from './types';

const COMPLEXITY_TERMS = /\b(workflow|approval|routing|handoff|exception|fallback|override|lifecycle|scheduling|coordination|entitlement|determine|dispatch|sequence|dependency|reopen|resume|cancel|billable)\b/gi;
const CRUD_TERMS = /\b(create|edit|update|delete|remove|view|read|list)\b/gi;
const EXCEPTION_TERMS = /\b(exception|fallback|override|urgent|deviate|without|missing|unavailable|manual|cannot|must not|if no|unless)\b/gi;
const ROLE_TERMS = /\b(as a|as an|manager|specialist|coordinator|reviewer|approver|planner|operator|engineer|user)\b/gi;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function estimateCrudRisk(text: string, workflowScore: number): V2CrudRisk {
  const crudCount = countMatches(text, CRUD_TERMS);
  if (crudCount >= 3 && workflowScore <= 1) return 'high';
  if (crudCount >= 2 && workflowScore <= 2) return 'medium';
  return 'low';
}

export function assessV2Triage(requirement: string, attachmentText = ''): V2TriageResult {
  const merged = `${requirement} ${attachmentText}`.trim();
  const wordCount = countWords(merged);
  const workflowScore = countMatches(merged, COMPLEXITY_TERMS) + countMatches(merged, EXCEPTION_TERMS);
  const roleSignals = countMatches(merged, ROLE_TERMS);
  const ambiguityScore = Math.max(
    0,
    Math.round((workflowScore * 1.6) + (wordCount > 80 ? 1 : 0) + (roleSignals === 0 ? 2 : 0)),
  );
  const crudRisk = estimateCrudRisk(merged, workflowScore);
  const reasons: string[] = [];

  let discoveryMode: V2TriageResult['discoveryMode'] = 'none';
  let questionBudget = 0;
  let likelyCapabilityCount = 1;
  let likelyCapabilityShape: V2TriageResult['likelyCapabilityShape'] = 'single_capability';

  if (ambiguityScore >= 10 || workflowScore >= 8) {
    discoveryMode = 'very_deep';
    questionBudget = Math.min(15, Math.max(10, workflowScore));
    likelyCapabilityCount = Math.min(6, 3 + Math.floor(workflowScore / 3));
    likelyCapabilityShape = 'broad_workflow';
    reasons.push('High workflow and exception density suggest multiple capability boundaries.');
  } else if (ambiguityScore >= 7 || workflowScore >= 5) {
    discoveryMode = 'deep';
    questionBudget = Math.min(12, Math.max(8, workflowScore));
    likelyCapabilityCount = Math.min(5, 2 + Math.floor(workflowScore / 3));
    likelyCapabilityShape = 'broad_workflow';
    reasons.push('The requirement implies substantial branching, business rules, or multi-step workflow behavior.');
  } else if (ambiguityScore >= 4 || workflowScore >= 3) {
    discoveryMode = 'standard';
    questionBudget = Math.min(7, Math.max(4, workflowScore + 1));
    likelyCapabilityCount = Math.min(4, 2 + Math.floor(workflowScore / 2));
    likelyCapabilityShape = 'small_workflow';
    reasons.push('The requirement has enough ambiguity or branching to justify focused discovery.');
  } else if (ambiguityScore >= 2 || wordCount > 25) {
    discoveryMode = 'light';
    questionBudget = Math.min(3, Math.max(1, workflowScore));
    likelyCapabilityCount = 1 + (workflowScore > 1 ? 1 : 0);
    likelyCapabilityShape = likelyCapabilityCount > 1 ? 'small_workflow' : 'single_capability';
    reasons.push('A small amount of discovery can validate scope without slowing the flow.');
  } else {
    reasons.push('The requirement is focused enough to skip discovery by default.');
  }

  if (crudRisk !== 'low') {
    reasons.push('CRUD-style wording is present, so capability shaping should be explicitly checked.');
  }

  return {
    discoveryMode,
    questionBudget,
    ambiguityScore,
    workflowScore,
    crudRisk,
    likelyCapabilityCount,
    likelyCapabilityShape,
    shouldPauseForScopeConfirmation: discoveryMode !== 'none' || crudRisk !== 'low' || likelyCapabilityCount > 1,
    reasons,
  };
}
