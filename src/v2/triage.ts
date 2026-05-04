import type { V2CrudRisk, V2TriageResult } from './types';

const CRUD_TERMS = /\b(create|edit|update|delete|remove|view|read|list)\b/gi;
const WORKFLOW_TERMS = /\b(workflow|approval|routing|handoff|exception|fallback|override|lifecycle|scheduling|coordination|entitlement|determine|dispatch|sequence|dependency|reopen|resume|cancel|billable)\b/gi;

export interface V2RawTriageScores {
  capability_breadth?: number;
  ask_clarity?: number;
  complexity?: number;
  ambiguity?: number;
  workflow_depth?: number;
  actor_clarity: number;
  must_cover_behaviors?: string[];
  unresolved_decision_themes?: string[];
  recommended_discovery_count?: number;
  ar_depth?: 'light' | 'standard' | 'deep';
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

function normalizeList(value: unknown, fallback: string[]): string[] {
  const items = Array.isArray(value)
    ? value.map((item) => String(item ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    : [];
  return (items.length ? items : fallback).slice(0, 12);
}

function fallbackBehaviors(requirement: string): string[] {
  const trimmed = requirement.replace(/\s+/g, ' ').trim();
  if (!trimmed) return ['Represent the requested business capability'];
  return [trimmed.length > 150 ? `${trimmed.slice(0, 147).trimEnd()}...` : trimmed];
}

function fallbackThemes(requirement: string, actorClarity: number, ambiguity: number): string[] {
  const themes: string[] = [];
  if (actorClarity <= 3) themes.push('Actor accountability and approval ownership');
  if (ambiguity >= 3) themes.push('Business rules, exception handling, and completion criteria');
  if (/\b(status|state|lifecycle|approval|routing|handoff|fallback|override)\b/i.test(requirement)) {
    themes.push('Workflow sequence and lifecycle transitions');
  }
  return themes.slice(0, 8);
}

export function assessV2TriageFromScores(
  scores: V2RawTriageScores,
  requirement: string,
  attachmentText = '',
): V2TriageResult {
  const complexity = clamp(Math.round(scores.complexity ?? scores.capability_breadth ?? 3), 1, 5);
  const ambiguity = clamp(Math.round(scores.ambiguity ?? (scores.ask_clarity ? 6 - scores.ask_clarity : 3)), 1, 5);
  const workflowDepth = clamp(Math.round(scores.workflow_depth ?? complexity), 1, 5);
  const capabilityBreadth = clamp(Math.round(scores.capability_breadth ?? Math.max(complexity, workflowDepth)), 1, 5);
  const askClarity = clamp(Math.round(scores.ask_clarity ?? (6 - ambiguity)), 1, 5);
  const actorClarity = clamp(Math.round(scores.actor_clarity), 1, 5);
  const discoveryLoad = clamp(
    Math.max(capabilityBreadth, workflowDepth) + ambiguity + (6 - actorClarity),
    3,
    15,
  );

  const band = DISCOVERY_BANDS.find((candidate) => discoveryLoad >= candidate.minLoad && discoveryLoad <= candidate.maxLoad) ?? DISCOVERY_BANDS[DISCOVERY_BANDS.length - 1];
  const recommendedCount = Number.isInteger(scores.recommended_discovery_count)
    ? clamp(Number(scores.recommended_discovery_count), 0, 15)
    : interpolateBudget(discoveryLoad, band);
  const questionBudget = recommendedCount || (band.mode === 'light' ? 2 : interpolateBudget(discoveryLoad, band));
  const merged = `${requirement} ${attachmentText}`.trim();
  const crudRisk = estimateCrudRisk(merged);
  const likelyCapabilityShape = mapShape(capabilityBreadth);
  const likelyCapabilityCount = mapCapabilityCount(capabilityBreadth);
  const arDepth = scores.ar_depth ?? (workflowDepth >= 4 || ambiguity >= 4 ? 'deep' : workflowDepth >= 3 ? 'standard' : 'light');
  const mustCoverBehaviors = normalizeList(scores.must_cover_behaviors, fallbackBehaviors(requirement));
  const unresolvedDecisionThemes = normalizeList(scores.unresolved_decision_themes, fallbackThemes(requirement, actorClarity, ambiguity));
  const reasons = [
    `Complexity ${complexity}/5, ambiguity ${ambiguity}/5, workflow depth ${workflowDepth}/5, actor clarity ${actorClarity}/5.`,
    `Discovery load ${discoveryLoad} maps to ${band.mode} discovery with budget ${questionBudget}.`,
  ];
  if (crudRisk !== 'low') {
    reasons.push('CRUD-heavy wording was detected; keep scope-shaping checks explicit.');
  }

  return {
    discoveryMode: band.mode,
    questionBudget,
    complexity,
    ambiguity,
    workflowDepth,
    capabilityBreadth,
    askClarity,
    actorClarity,
    discoveryLoad,
    crudRisk,
    likelyCapabilityCount,
    likelyCapabilityShape,
    mustCoverBehaviors,
    unresolvedDecisionThemes,
    arDepth,
    shouldPauseForScopeConfirmation: true,
    reasons,
  };
}
