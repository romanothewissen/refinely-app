import type { V2CrudRisk, V2TriageResult } from './types';

const CRUD_TERMS = /\b(create|edit|update|delete|remove|view|read|list)\b/gi;
const WORKFLOW_TERMS = /\b(workflow|approval|routing|handoff|exception|fallback|override|lifecycle|scheduling|coordination|entitlement|determine|dispatch|sequence|dependency|reopen|resume|cancel|billable)\b/gi;

export interface V2RawTriageScores {
  capability_breadth: number;
  ask_clarity: number;
  actor_clarity: number;
}

interface BudgetBand {
  mode: V2TriageResult['discoveryMode'];
  minLoad: number;
  maxLoad: number;
  minBudget: number;
  maxBudget: number;
}

const DISCOVERY_BANDS: BudgetBand[] = [
  { mode: 'light', minLoad: 3, maxLoad: 6, minBudget: 2, maxBudget: 4 },
  { mode: 'standard', minLoad: 7, maxLoad: 9, minBudget: 5, maxBudget: 8 },
  { mode: 'deep', minLoad: 10, maxLoad: 12, minBudget: 9, maxBudget: 12 },
  { mode: 'very_deep', minLoad: 13, maxLoad: 15, minBudget: 13, maxBudget: 15 },
];

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimateCrudRisk(text: string): V2CrudRisk {
  const crudCount = countMatches(text, CRUD_TERMS);
  const workflowCount = countMatches(text, WORKFLOW_TERMS);
  if (crudCount >= 3 && workflowCount <= 1) return 'high';
  if (crudCount >= 2 && workflowCount <= 2) return 'medium';
  return 'low';
}

function interpolateBudget(load: number, band: BudgetBand): number {
  if (band.minLoad === band.maxLoad) return band.minBudget;
  const ratio = (load - band.minLoad) / (band.maxLoad - band.minLoad);
  return Math.round(band.minBudget + ratio * (band.maxBudget - band.minBudget));
}

function mapShape(capabilityBreadth: number): V2TriageResult['likelyCapabilityShape'] {
  if (capabilityBreadth <= 2) return 'single_capability';
  if (capabilityBreadth <= 4) return 'small_workflow';
  return 'broad_workflow';
}

function mapCapabilityCount(capabilityBreadth: number): number {
  return clamp(capabilityBreadth, 1, 6);
}

export function assessV2TriageFromScores(
  scores: V2RawTriageScores,
  requirement: string,
  attachmentText = '',
): V2TriageResult {
  const capabilityBreadth = clamp(Math.round(scores.capability_breadth), 1, 5);
  const askClarity = clamp(Math.round(scores.ask_clarity), 1, 5);
  const actorClarity = clamp(Math.round(scores.actor_clarity), 1, 5);
  const discoveryLoad = clamp(
    capabilityBreadth + (6 - askClarity) + (6 - actorClarity),
    3,
    15,
  );

  const band = DISCOVERY_BANDS.find((candidate) => discoveryLoad >= candidate.minLoad && discoveryLoad <= candidate.maxLoad) ?? DISCOVERY_BANDS[DISCOVERY_BANDS.length - 1];
  const questionBudget = interpolateBudget(discoveryLoad, band);
  const merged = `${requirement} ${attachmentText}`.trim();
  const crudRisk = estimateCrudRisk(merged);
  const likelyCapabilityShape = mapShape(capabilityBreadth);
  const likelyCapabilityCount = mapCapabilityCount(capabilityBreadth);
  const reasons = [
    `Breadth ${capabilityBreadth}/5, ask clarity ${askClarity}/5, actor clarity ${actorClarity}/5.`,
    `Discovery load ${discoveryLoad} maps to ${band.mode} discovery with budget ${questionBudget}.`,
  ];
  if (crudRisk !== 'low') {
    reasons.push('CRUD-heavy wording was detected; keep scope-shaping checks explicit.');
  }

  return {
    discoveryMode: band.mode,
    questionBudget,
    capabilityBreadth,
    askClarity,
    actorClarity,
    discoveryLoad,
    crudRisk,
    likelyCapabilityCount,
    likelyCapabilityShape,
    shouldPauseForScopeConfirmation: true,
    reasons,
  };
}
