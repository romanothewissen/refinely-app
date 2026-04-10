import type { GenerationSizingAssessment } from './types';

export function getGenerationFeatureTargetLabel(): string {
  return 'Triage estimate';
}

export function formatGenerationFeatureTarget(featureTarget?: number): string {
  return typeof featureTarget === 'number' ? `Forecast ${featureTarget}` : 'Assessing';
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
  void sizingAssessment;
  return null;
}
