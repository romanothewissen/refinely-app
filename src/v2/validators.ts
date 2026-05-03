import type { AcceptanceRequirement, Feature } from '../types';
import type { V2QualityEvaluation } from './types';

const CRUD_PATTERNS = [
  /\bcreate\b/i,
  /\bedit\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bview\b/i,
  /\blist\b/i,
];

const WORKFLOW_TERMS = /\b(workflow|approval|route|entitlement|sequence|dispatch|fallback|override|exception|handoff|visibility|coordinate|determine)\b/i;

function normalize(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function countCrudSignals(text: string): number {
  return CRUD_PATTERNS.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function arText(ar: AcceptanceRequirement): string {
  return [ar.given, ar.when, ar.then].map(normalize).filter(Boolean).join(' ');
}

export function evaluateV2Quality(features: Feature[]): V2QualityEvaluation {
  const warnings: string[] = [];
  const actorIssues: string[] = [];
  let crudSignals = 0;
  let workflowSignals = 0;
  let arCount = 0;

  features.forEach((feature) => {
    const content = `${feature.summary} ${feature.description}`;
    crudSignals += countCrudSignals(content);
    if (WORKFLOW_TERMS.test(content)) workflowSignals += 1;
    if (/\bas\s+an?\s+(?:user|authorized user|team member|authorized team member)\b/i.test(feature.description)) {
      actorIssues.push(`Feature "${feature.summary}" uses a weak or generic actor label.`);
    }
    arCount += feature.acceptanceRequirements.length;
    if (feature.acceptanceRequirements.length < 2) {
      warnings.push(`Feature "${feature.summary}" has very light acceptance coverage.`);
    }
    feature.acceptanceRequirements.forEach((ar) => {
      const text = arText(ar);
      if (/\bmust not|cannot|manual|override|fallback|otherwise\b/i.test(text)) {
        workflowSignals += 0.25;
      }
    });
  });

  const crudLike = crudSignals >= Math.max(2, features.length) && workflowSignals < features.length;
  if (crudLike) {
    warnings.push('The feature set still looks CRUD-oriented rather than capability-oriented.');
  }
  if (arCount < features.length * 2) {
    warnings.push('Acceptance requirement density is lighter than the benchmark target.');
  }

  const capabilityDepthScore = Math.max(
    0,
    Number((Math.min(1, (workflowSignals + (arCount * 0.1)) / Math.max(features.length || 1, 1))).toFixed(2)),
  );

  return {
    crudLike,
    capabilityDepthScore,
    actorIssues,
    warnings,
  };
}
