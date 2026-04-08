import type { GenerationSizingAssessment } from './types';

export function getGenerationFeatureTargetLabel(): string {
  return 'Draft target';
}

export function formatGenerationFeatureTarget(featureTarget?: number): string {
  return typeof featureTarget === 'number' ? `About ${featureTarget}` : 'Assessing';
}

export function getDraftFeatureHeading(isProvisional: boolean): string {
  return isProvisional ? 'Draft features' : 'Features';
}

export function getDraftFeatureNote(consolidationPending: boolean): string | null {
  return consolidationPending ? 'Draft may consolidate before final output.' : null;
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
