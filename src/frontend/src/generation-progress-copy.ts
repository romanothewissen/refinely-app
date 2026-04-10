import type { ClarifyProgressPayload, CoverageReviewAdvice, GenerationSizingAssessment } from './types';

export function getGenerationFeatureTargetLabel(): string {
  return 'Triage estimate';
}

export function formatGenerationFeatureTarget(featureTarget?: number): string {
  return typeof featureTarget === 'number' ? `Forecast ${featureTarget}` : 'Assessing';
}

export function getDraftFeatureHeading(): string {
  return 'Draft features';
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

export function getApprovedDraftStructureNote(): string {
  return 'Using approved feature structure';
}

export function getCoverageReviewSummary(
  coverageReview?: CoverageReviewAdvice | null,
): { label: string; tone: 'success' | 'warning'; details: string[] } | null {
  if (!coverageReview) return null;
  if (coverageReview.sufficient) {
    return {
      label: 'Coverage check looks complete',
      tone: 'success',
      details: [],
    };
  }

  const details = (coverageReview.missingCoverage ?? []).map((item) => String(item ?? '').trim()).filter(Boolean);
  const count = details.length || 1;
  return {
    label: `Coverage check found ${count} area${count === 1 ? '' : 's'} to review`,
    tone: 'warning',
    details,
  };
}

export function getDiscoveryProfileHeadline(
  discoveryProfile?: ClarifyProgressPayload['discoveryProfile'] | null,
): string {
  if (!discoveryProfile) return 'Assessing scope and ambiguity';

  const scopeLabel: Record<string, string> = {
    narrow: 'Narrow scope',
    moderate: 'Moderate scope',
    broad: 'Broad scope',
    very_broad: 'Very broad scope',
  };
  const ambiguityLabel: Record<string, string> = {
    low: 'Low ambiguity',
    medium: 'Moderate ambiguity',
    high: 'High ambiguity',
  };

  const scope = scopeLabel[discoveryProfile.scope] ?? discoveryProfile.scope;
  const ambiguity = ambiguityLabel[discoveryProfile.ambiguity] ?? discoveryProfile.ambiguity;
  return `${scope} / ${ambiguity}`;
}

export function getSourceContextChips(input?: {
  projectCount?: number;
  domainContextApplied?: boolean;
  attachmentIncluded?: boolean;
  wiDocsCount?: number;
  similarStoriesCount?: number;
} | null): string[] {
  if (!input) return [];

  const chips: string[] = [];
  if (typeof input.projectCount === 'number' && input.projectCount > 0) {
    chips.push(input.projectCount === 1 ? '1 project' : `${input.projectCount} projects`);
  }
  if (input.domainContextApplied) chips.push('Guidance on');
  if (input.attachmentIncluded) chips.push('Attachment included');
  if (typeof input.wiDocsCount === 'number' && input.wiDocsCount > 0) {
    chips.push(input.wiDocsCount === 1 ? '1 work instruction' : `${input.wiDocsCount} work instructions`);
  }
  if (typeof input.similarStoriesCount === 'number' && input.similarStoriesCount > 0) {
    chips.push(input.similarStoriesCount === 1 ? '1 similar story' : `${input.similarStoriesCount} similar stories`);
  }
  return chips;
}
