import type { GenerationSizingAssessment } from './types';

export function getGenerationFeatureTargetLabel(): string {
  return 'Feature target';
}

export function formatGenerationFeatureTarget(featureTarget?: number): string {
  return typeof featureTarget === 'number' ? `About ${featureTarget}` : 'Assessing';
}

export function getDraftFeatureHeading(): string {
  return 'Features';
}

export function getDraftFeatureNote(): string | null {
  return null;
}

export function getSizingRunContextNote(
  sizingAssessment?: GenerationSizingAssessment | null,
): string | null {
  if (!sizingAssessment) return null;

  if (sizingAssessment.repairApplied && typeof sizingAssessment.preRepairFeatureCount === 'number') {
    return `Draft consolidated from ${sizingAssessment.preRepairFeatureCount} to ${sizingAssessment.final.featureCount} features before final output.`;
  }

  if (sizingAssessment.repairRejectedReason && typeof sizingAssessment.preRepairFeatureCount === 'number') {
    return `Draft kept at ${sizingAssessment.final.featureCount} features because consolidation would have dropped below the explicit workflow floor.`;
  }

  return null;
}
